import { OrderBookStore } from 'orderbook-synchronizer';
import { Order, OrderbookData } from 'orderbook-synchronizer/lib/types';
import { EMITTER_EVENTS } from '../../constants';
import { logger } from '../../logger';
import { Utils } from '../../utils';
import { Emitter } from '../emitter';

import { TradepairQueries } from '../../tradepairs/tradepairs';
import { DBQueries } from '../../database/queries';
import { Redis, RedisPub } from '../../redis/redis';
import { TableTemplates } from '../../database/queries/enums';
import { MarketStreamProducer } from '../../redis/market_stream_client';
import { MARKET_STREAMS } from '../../redis/market_streams';

const marketStreamProducer = new MarketStreamProducer(undefined, 'orderbook');
let lastStreamErrorAt = 0;
let suppressedStreamErrors = 0;

function logStreamError(error: unknown): void {
  const now = Date.now();
  if (now - lastStreamErrorAt < 30000) {
    suppressedStreamErrors += 1;
    return;
  }
  const suffix = suppressedStreamErrors > 0 ? ` (suppressed ${suppressedStreamErrors} similar errors)` : '';
  logger.error(`Redis orderbook stream write error${suffix}`, error);
  lastStreamErrorAt = now;
  suppressedStreamErrors = 0;
}

const memoryLimit =
  process.env.ORDERBOOK_SIZE_LIMIT === undefined ? 1024 : parseInt(process.env.ORDERBOOK_SIZE_LIMIT, 10);
// Only delta-only feeds need incremental rebuilding; full-book updates replace state directly.
const deltaOrderbookStores: Map<string, OrderBookStore> = new Map();
const latestOrderbooks: Map<string, Map<string, OrderbookData>> = new Map();
const lastBestPrices: Map<string, string> = new Map();

interface OrderBookDepth {
  symbol: string;
  asks: Order[];
  bids: Order[];
  timestamp?: number;
  sequence?: number;
  updateType?: 'snapshot' | 'delta';
}

const limitLevels = (levels: Order[]): Order[] =>
  memoryLimit > 0 && levels.length > memoryLimit ? levels.slice(0, memoryLimit) : levels;

async function applyOrderbookDelta(exchange: string, depth: OrderBookDepth): Promise<OrderbookData | undefined> {
  let store = deltaOrderbookStores.get(exchange);
  if (!store) {
    store = new OrderBookStore(memoryLimit);
    deltaOrderbookStores.set(exchange, store);
  }

  if (!store.hasOrderBook(depth.symbol)) {
    const orderbookSnapshot = await Redis.get(Utils.orderbookName(exchange, depth.symbol));
    if (orderbookSnapshot !== null) {
      const parsedOrderbookSnapshot: OrderbookData = JSON.parse(orderbookSnapshot);
      if (parsedOrderbookSnapshot.asks && parsedOrderbookSnapshot.bids) {
        store.updateOrderBook(depth.symbol, parsedOrderbookSnapshot.asks, parsedOrderbookSnapshot.bids);
      }
    }
  }
  store.updateOrderBook(depth.symbol, depth.asks, depth.bids);
  return store.getOrderBook(depth.symbol);
}

interface PersistedOrderBookDepth {
  symbol: string;
  asks: [number, number][];
  bids: [number, number][];
  timestamp: number;
  sequence?: number;
  updateType: 'snapshot' | 'delta';
  sourceUpdateCount: number;
}

class OrderbookEmitter {
  constructor() {
    // Event listeners
    logger.verbose('Orderbook Emitter started!');

    Emitter.on(
      EMITTER_EVENTS.OrderBookUpdate,
      async (exchange: string, depth: OrderBookDepth): Promise<void> => {
        // eslint-disable-next-line no-param-reassign
        exchange = exchange.toLowerCase();
        const { symbol } = depth;

        try {
          const orderbook =
            depth.updateType === 'snapshot'
              ? { asks: limitLevels(depth.asks), bids: limitLevels(depth.bids) }
              : await applyOrderbookDelta(exchange, depth);
          if (!orderbook) return;

          let exchangeOrderbooks = latestOrderbooks.get(exchange);
          if (!exchangeOrderbooks) {
            exchangeOrderbooks = new Map();
            latestOrderbooks.set(exchange, exchangeOrderbooks);
          }
          exchangeOrderbooks.set(symbol, orderbook);

          const ask = orderbook.asks[0]?.[0];
          const bid = orderbook.bids[0]?.[0];
          const bestKey = `${exchange}\0${symbol}`;
          const best = `${ask}|${bid}`;
          if (ask && bid && lastBestPrices.get(bestKey) !== best) {
            lastBestPrices.set(bestKey, best);
            await RedisPub.publish('OrderBookUpdate', JSON.stringify({ exchange, symbol, ask, bid }));
          }
        } catch (e) {
          logger.error('Orderbook update error', e);
        }
      },
    );

    Emitter.on(
      EMITTER_EVENTS.OrderBookPersist,
      (exchange: string, depth: PersistedOrderBookDepth, acknowledge?: (error?: unknown) => void): void => {
        TradepairQueries.idToSymbol(exchange.toLowerCase(), depth.symbol)
          .then((ccxtSymbol) => {
            if (!ccxtSymbol) throw new Error('Orderbook symbol lookup failed');
            return marketStreamProducer.append(MARKET_STREAMS.orderbook, {
              schemaVersion: 3,
              eventType: 'orderbook',
              exchange: exchange.toLowerCase(),
              symbol: ccxtSymbol,
              eventTime: depth.timestamp,
              ingestedAt: Date.now(),
              asks: depth.asks,
              bids: depth.bids,
              sequence: depth.sequence,
              updateType: depth.updateType,
              sourceUpdateCount: depth.sourceUpdateCount,
            });
          })
          .then(() => acknowledge?.())
          .catch((error) => {
            logStreamError(error);
            acknowledge?.(error);
          });
      },
    );

    Emitter.on(
      EMITTER_EVENTS.OrderBookSnapshot,
      async (snapshotTime: number): Promise<void> => {
        for (const [exchange, exchangeOrderbooks] of latestOrderbooks) {
          for (const [symbol, orderbook] of exchangeOrderbooks) {
            try {
              // Get CCXT standard symbol
              const ccxtSymbol = await TradepairQueries.idToSymbol(exchange, symbol);

              if (ccxtSymbol) {
                const tableName = Utils.orderbookName(exchange, ccxtSymbol);

                if (!(await DBQueries.tableCheck(tableName))) {
                  await DBQueries.createNewTableFromTemplate(TableTemplates.Orderbook, tableName);
                }

                await DBQueries.orderbookReplace(tableName, { time: snapshotTime, orderbook });

                // Store snapshot in redis for 600 sec
                Redis.set(tableName, JSON.stringify(orderbook), 'EX', 600);
              }
            } catch (e) {
              logger.error('Orderbook snapshot error', e);
            }
          }
        }
      },
    );
  }
}

module.exports = new OrderbookEmitter();
