/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import { EMITTER_EVENTS } from '../../constants';
import { Emitter } from '../../emitter/emitter';
import { logger } from '../../logger';
import { calculateOrderbookDelta, OrderbookState } from '../orderbook_delta';

type ProExchange = ccxt.Exchange & {
  watchTrades: (symbol: string) => Promise<ccxt.Trade[]>;
  watchOrderBook: (symbol: string) => Promise<ccxt.OrderBook>;
  close: () => Promise<void>;
};

type ProExchangeConstructor = new (config?: Record<string, unknown>) => ProExchange;

const retryDelay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1000));

export const openSocket = (exchange: string, symbols: string[]) => {
  const exchangeName = exchange.toLowerCase();
  const ExchangeClass = ccxt.pro[exchangeName as keyof typeof ccxt.pro] as ProExchangeConstructor | undefined;

  if (typeof ExchangeClass !== 'function') {
    throw new Error(`${exchangeName} does not support CCXT Pro websocket`);
  }

  const client = new ExchangeClass({ enableRateLimit: true, newUpdates: true });

  if (!client.has.watchTrades || !client.has.watchOrderBook) {
    throw new Error(`${exchangeName} must support CCXT Pro watchTrades and watchOrderBook`);
  }

  let closed = false;
  const orderbooks = new Map<string, OrderbookState>();

  const watchTrades = async (symbol: string): Promise<void> => {
    while (!closed) {
      try {
        const trades = await client.watchTrades(symbol);

        trades.forEach((trade) => {
          Emitter.emit('Trades', exchangeName, {
            time: trade.timestamp || Date.now(),
            symbol: trade.symbol,
            side: trade.side,
            quantity: trade.amount,
            price: trade.price,
            tradeId: trade.id,
          });
        });
      } catch (err) {
        if (!closed) {
          logger.error(`${exchangeName} trades websocket error for ${symbol}`, err);
          await retryDelay();
        }
      }
    }
  };

  const watchOrderBook = async (symbol: string): Promise<void> => {
    while (!closed) {
      try {
        const orderbook = await client.watchOrderBook(symbol);
        const current = {
          asks: orderbook.asks.map((order) => [Number(order[0]), Number(order[1])]),
          bids: orderbook.bids.map((order) => [Number(order[0]), Number(order[1])]),
        } as OrderbookState;
        const previous = orderbooks.get(symbol);
        const delta = calculateOrderbookDelta(previous, current);

        orderbooks.set(symbol, current);

        if (delta.asks.length === 0 && delta.bids.length === 0) {
          continue;
        }

        Emitter.emit(EMITTER_EVENTS.OrderBookUpdate, exchangeName, {
          symbol,
          asks: delta.asks,
          bids: delta.bids,
          timestamp: orderbook.timestamp || Date.now(),
          sequence: orderbook.nonce,
          updateType: previous ? 'delta' : 'snapshot',
        });
      } catch (err) {
        if (!closed) {
          logger.error(`${exchangeName} orderbook websocket error for ${symbol}`, err);
          await retryDelay();
        }
      }
    }
  };

  symbols.forEach((symbol) => {
    watchTrades(symbol);
    watchOrderBook(symbol);
  });

  return (): boolean => {
    closed = true;
    client.close().catch((err: any) => logger.error(`${exchangeName} websocket close error`, err));
    return true;
  };
};