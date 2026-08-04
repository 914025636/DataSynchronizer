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

const marketStreamProducer = new MarketStreamProducer();
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const OrderBookExchangeCache: Map<string, OrderBookStore> = new Map();

interface OrderBookDepth {
  symbol: string;
  asks: Order[];
  bids: Order[];
  timestamp?: number;
  sequence?: number;
  updateType: 'snapshot' | 'delta';
}

interface PersistedOrderBookDepth {
  symbol: string;
  exactAsks: [number, number][];
  exactBids: [number, number][];
  aggregateAsks: [number, number, number][];
  aggregateBids: [number, number, number][];
  timestamp: number;
  sequence?: number;
  updateType: 'snapshot' | 'second_delta';
  exactDepth: number;
  tickSize: number;
  referencePrice: number;
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

        let exchangeOrderbooks = OrderBookExchangeCache.get(exchange);

        if (!exchangeOrderbooks) {
          exchangeOrderbooks = new OrderBookStore(memoryLimit);
          OrderBookExchangeCache.set(exchange, exchangeOrderbooks);
        }

        const { symbol, asks, bids } = depth;

        if (exchangeOrderbooks.hasOrderBook(symbol)) {
          try {
            exchangeOrderbooks.updateOrderBook(symbol, asks, bids);

            const orderBookData = exchangeOrderbooks.getOrderBook(symbol);

            if (orderBookData && orderBookData.asks[0]?.[0] && orderBookData.bids[0]?.[0]) {
              // Publish best Ask and Bid price
              await RedisPub.publish(
                'OrderBookUpdate',
                JSON.stringify({ exchange, symbol, ask: orderBookData.asks[0]?.[0], bid: orderBookData.bids[0]?.[0] }),
              );
            }
          } catch (e) {
            logger.error('Orderbook update error', e);
          }
        } else {
          // Load Orderbook from Redis
          try {
            const tableName = Utils.orderbookName(exchange, symbol);
            const orderbookSnapshot = await Redis.get(tableName);

            if (orderbookSnapshot !== null) {
              const parsedOrderbookSnapshot: OrderbookData = JSON.parse(orderbookSnapshot);

              if (parsedOrderbookSnapshot.asks && parsedOrderbookSnapshot.bids) {
                exchangeOrderbooks.updateOrderBook(symbol, parsedOrderbookSnapshot.asks, parsedOrderbookSnapshot.bids);
              }
            }
            exchangeOrderbooks.updateOrderBook(symbol, asks, bids);
          } catch (e) {
            logger.error('Orderbook loading error', e);
          }
        }

        // const exchanges = Object.keys(OrderBookExchangeCache);

        // for (const exchange of exchanges) {
        //   const symbols = OrderBookExchangeCache[exchange].getSymbolList();

        //   for (const symbol of symbols) {
        //     try {
        //       const orderbook: OrderbookData = { ...OrderBookExchangeCache[exchange].getOrderBook(symbol) };
        //       // Get CCXT standard symbol
        //       const ccxtSymbol = await TradepairQueries.idToSymbol(exchange, symbol);

        //       if (ccxtSymbol) {
        //         const tableName = Utils.orderbookName_frame(exchange, ccxtSymbol);

        //         if (!(await DBQueries.tableCheck(tableName))) {
        //           await DBQueries.createNewTableFromTemplate(TableTemplates.Orderbook, tableName);
        //         }
        //         if (orderbookStr != JSON.stringify(orderbook)) {
        //           orderbookStr = JSON.stringify(orderbook)
        //           await DBQueries.orderbookReplace(tableName, { time: Date.now(), orderbook });
        //         }

        //       }
        //     } catch (e) {
        //       logger.error('Orderbook snapshot error', e);
        //     }
        //   }
        // }
      },
    );

    Emitter.on(
      EMITTER_EVENTS.OrderBookPersist,
      (exchange: string, depth: PersistedOrderBookDepth): void => {
        TradepairQueries.idToSymbol(exchange.toLowerCase(), depth.symbol)
          .then((ccxtSymbol) => {
            if (!ccxtSymbol) return;
            return marketStreamProducer.append(MARKET_STREAMS.orderbook, {
              schemaVersion: 2,
              eventType: 'orderbook',
              exchange: exchange.toLowerCase(),
              symbol: ccxtSymbol,
              eventTime: depth.timestamp,
              ingestedAt: Date.now(),
              exactAsks: depth.exactAsks,
              exactBids: depth.exactBids,
              aggregateAsks: depth.aggregateAsks,
              aggregateBids: depth.aggregateBids,
              sequence: depth.sequence,
              updateType: depth.updateType,
              exactDepth: depth.exactDepth,
              tickSize: depth.tickSize,
              referencePrice: depth.referencePrice,
              aggregationVersion: 1,
              sourceUpdateCount: depth.sourceUpdateCount,
            });
          })
          .catch((error) => logStreamError(error));
      },
    );

    Emitter.on(
      EMITTER_EVENTS.OrderBookSnapshot,
      async (snapshotTime: number): Promise<void> => {
        for (const [exchange, exchangeOrderbooks] of OrderBookExchangeCache) {
          const symbols = exchangeOrderbooks.getSymbolList();

          for (const symbol of symbols) {
            try {
              const orderbook = exchangeOrderbooks.getOrderBook(symbol);

              if (!orderbook) {
                continue;
              }

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
