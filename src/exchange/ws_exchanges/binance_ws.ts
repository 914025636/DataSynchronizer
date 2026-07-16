/* eslint-disable @typescript-eslint/no-explicit-any */
import * as ccxt from 'ccxt';
import { EMITTER_EVENTS } from '../../constants';
import { Emitter } from '../../emitter/emitter';
import { logger } from '../../logger';

const exchangeName = 'binance';

const retryDelay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1000));

export const openSocket = (symbols: string[]) => {
  const client = new ccxt.pro.binance({ enableRateLimit: true, newUpdates: true });
  let closed = false;

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
          logger.error(`Binance trades websocket error for ${symbol}`, err);
          await retryDelay();
        }
      }
    }
  };

  const watchOrderBook = async (symbol: string): Promise<void> => {
    while (!closed) {
      try {
        const orderbook = await client.watchOrderBook(symbol);
        Emitter.emit(EMITTER_EVENTS.OrderBookUpdate, exchangeName, {
          symbol,
          asks: orderbook.asks.map((order) => [order[0], order[1]]),
          bids: orderbook.bids.map((order) => [order[0], order[1]]),
          snapshot: true,
        });
      } catch (err) {
        if (!closed) {
          logger.error(`Binance orderbook websocket error for ${symbol}`, err);
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
    client.close().catch((err: any) => logger.error('Binance websocket close error', err));
    return true;
  };
};
