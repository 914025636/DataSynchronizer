import { Sender } from '@questdb/nodejs-client';
import { logger } from '../logger';

const QUESTDB_HOST = process.env.QUESTDB_HOST || 'localhost';
const QUESTDB_PORT = process.env.QUESTDB_PORT === undefined ? 9000 : parseInt(process.env.QUESTDB_PORT, 10);

// 使用 ILP over HTTP，auto_flush_rows=500 或每 500ms 自动刷新一次
const configStr = `http::addr=${QUESTDB_HOST}:${QUESTDB_PORT};auto_flush_rows=500;auto_flush_interval=500;`;

let sender: Sender | null = null;
let initPromise: Promise<Sender> | null = null;

async function getSender(): Promise<Sender> {
  if (sender) return sender;
  if (!initPromise) {
    initPromise = Sender.fromConfig(configStr)
      .then((s) => {
        sender = s;
        logger.info(`QuestDB sender initialized: ${QUESTDB_HOST}:${QUESTDB_PORT}`);
        return s;
      })
      .catch((error) => {
        initPromise = null;
        throw error;
      });
  }
  return initPromise;
}

export const QuestDBWriter = {
  /**
   * 写入逐笔成交数据
   * 表结构（自动创建）：
   *   trades(ts TIMESTAMP, exchange SYMBOL, symbol SYMBOL, side SYMBOL,
   *          price DOUBLE, quantity DOUBLE, trade_id STRING)
   */
  writeTrade: async (
    exchange: string,
    symbol: string,
    side: string,
    price: string,
    quantity: string,
    tradeId: string,
    timestamp: number,
  ): Promise<void> => {
    try {
      (await getSender())
        .table('trades')
        .symbol('exchange', exchange)
        .symbol('symbol', symbol)
        .symbol('side', side)
        .floatColumn('price', parseFloat(price))
        .floatColumn('quantity', parseFloat(quantity))
        .stringColumn('trade_id', tradeId)
        .at(timestamp, 'ms');
    } catch (e) {
      logger.error('QuestDB writeTrade error', e);
    }
  },

  /**
   * 写入订单簿增量数据（每个价格档位一行）
   * qty = 0 表示该档位被删除
   * 表结构（自动创建）：
   *   orderbook_delta(ts TIMESTAMP, exchange SYMBOL, symbol SYMBOL, side SYMBOL,
  *                   update_type SYMBOL, price DOUBLE, qty DOUBLE, sequence DOUBLE)
   */
  writeOrderbookDelta: async (
    exchange: string,
    symbol: string,
    asks: [number, number][],
    bids: [number, number][],
    timestamp: number,
    sequence?: number,
    updateType: 'snapshot' | 'delta' = 'delta',
  ): Promise<void> => {
    try {
      const s = await getSender();
      for (const [price, qty] of asks) {
        s.table('orderbook_delta')
          .symbol('exchange', exchange)
          .symbol('symbol', symbol)
          .symbol('side', 'ask')
          .symbol('update_type', updateType)
          .floatColumn('price', price)
          .floatColumn('qty', qty)
          .floatColumn('sequence', sequence || 0)
          .at(timestamp, 'ms');
      }
      for (const [price, qty] of bids) {
        s.table('orderbook_delta')
          .symbol('exchange', exchange)
          .symbol('symbol', symbol)
          .symbol('side', 'bid')
          .symbol('update_type', updateType)
          .floatColumn('price', price)
          .floatColumn('qty', qty)
          .floatColumn('sequence', sequence || 0)
          .at(timestamp, 'ms');
      }
    } catch (e) {
      logger.error('QuestDB writeOrderbookDelta error', e);
    }
  },

  /**
   * 显式刷新缓冲区（进程退出前调用）
   */
  flush: async (): Promise<void> => {
    if (sender) {
      try {
        await sender.flush();
      } catch (e) {
        logger.error('QuestDB flush error', e);
      }
    }
  },

  /**
   * 关闭连接
   */
  close: async (): Promise<void> => {
    if (sender) {
      try {
        await sender.flush();
        await sender.close();
        sender = null;
        initPromise = null;
        logger.info('QuestDB sender closed');
      } catch (e) {
        logger.error('QuestDB close error', e);
      }
    }
  },
};
