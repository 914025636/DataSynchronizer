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
import { QuestDBWriter } from '../../questdb';

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

        // 写入 QuestDB 增量数据（每条 WebSocket 推送的价格档位变化）
        TradepairQueries.idToSymbol(exchange, symbol)
          .then((ccxtSymbol) => {
            if (ccxtSymbol) {
              return QuestDBWriter.writeOrderbookDelta(
                exchange,
                ccxtSymbol,
                asks as [number, number][],
                bids as [number, number][],
                depth.timestamp || Date.now(),
                depth.sequence,
                depth.updateType,
              );
            }
          })
          .catch((e) => logger.error('QuestDB orderbook delta write error', e));

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
