import { Sender } from '@questdb/nodejs-client';
import { logger } from '../logger';
import { questdbMarketTables, QuestDBMarketTables } from './table_names';

const DEFAULT_PORT_BY_PROTOCOL: Record<string, number> = {
  http: 9000,
  https: 9000,
  tcp: 9009,
  tcps: 9009,
};

const QUESTDB_PROTOCOL = (process.env.QUESTDB_PROTOCOL || 'tcp').toLowerCase();
const QUESTDB_HOST = process.env.QUESTDB_HOST || 'localhost';
const QUESTDB_PORT =
  process.env.QUESTDB_PORT === undefined
    ? DEFAULT_PORT_BY_PROTOCOL[QUESTDB_PROTOCOL] || DEFAULT_PORT_BY_PROTOCOL.tcp
    : parseInt(process.env.QUESTDB_PORT, 10);

const configStr = `${QUESTDB_PROTOCOL}::addr=${QUESTDB_HOST}:${QUESTDB_PORT};auto_flush=off;`;
const flushInterval = Number(process.env.QUESTDB_FLUSH_INTERVAL_MS || 500);
const flushTimeout = Number(process.env.QUESTDB_FLUSH_TIMEOUT_MS || 10000);

let sender: Sender | null = null;
let initPromise: Promise<Sender> | null = null;
let closing = false;
let lastFlushTime = Date.now();
let loggedFirstTradeWrite = false;
let loggedFirstOrderbookWrite = false;
let resetPromise: Promise<void> | null = null;
const registeredMarkets = new Set<string>();
const maxPendingWrites = Number(process.env.QUESTDB_MAX_PENDING_WRITES || 2000);
const writeBatchSize = Number(process.env.QUESTDB_WRITE_BATCH_SIZE || 50);

type WriteTask = {
  write: (activeSender: Sender) => void;
  resolve: () => void;
  reject: (error: unknown) => void;
};

const pendingWrites: WriteTask[] = [];
let drainPromise: Promise<void> | null = null;

const errorWindowMs = Number(process.env.QUESTDB_ERROR_WINDOW_MS || 30000);

type ErrorBucket = {
  windowStart: number;
  loggedInWindow: boolean;
  suppressed: number;
};

const errorBuckets = new Map<string, ErrorBucket>();

function isTransportDisconnected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TCP transport is not connected|transport is not connected|EPIPE|ECONNRESET|socket hang up|connection.*closed|QuestDB flush timed out/i.test(
    message,
  );
}

async function flushWithTimeout(activeSender: Sender): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;

  try {
    await Promise.race([
      activeSender.flush(),
      new Promise<never>((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`QuestDB flush timed out after ${flushTimeout}ms`)), flushTimeout);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function logRateLimitedError(key: string, message: string, error: unknown): void {
  const now = Date.now();
  const current = errorBuckets.get(key);

  if (!current || now - current.windowStart >= errorWindowMs) {
    if (current && current.suppressed > 0) {
      logger.error(`${message} (suppressed ${current.suppressed} similar errors in last ${errorWindowMs}ms)`);
    }

    logger.error(message, error);
    errorBuckets.set(key, {
      windowStart: now,
      loggedInWindow: true,
      suppressed: 0,
    });
    return;
  }

  if (!current.loggedInWindow) {
    logger.error(message, error);
    current.loggedInWindow = true;
    return;
  }

  current.suppressed += 1;
}

async function resetSender(reason: string): Promise<void> {
  if (resetPromise) {
    await resetPromise;
    return;
  }

  resetPromise = (async () => {
    const staleSender = sender;
    sender = null;
    initPromise = null;
    registeredMarkets.clear();

    if (staleSender) {
      try {
        await staleSender.close();
      } catch {
        // Ignore close errors on stale connection.
      }
    }

    logger.warn(`QuestDB sender reset: ${reason}`);
  })();

  try {
    await resetPromise;
  } finally {
    resetPromise = null;
  }
}

async function writeBatchWithReconnect(tasks: WriteTask[], flush: boolean): Promise<void> {
  let retried = false;

  while (!closing) {
    const activeSender = await getSender();

    try {
      tasks.forEach((task) => task.write(activeSender));
      if (flush) {
        await flushWithTimeout(activeSender);
        lastFlushTime = Date.now();
      }
      return;
    } catch (error) {
      if (!retried && isTransportDisconnected(error) && !closing) {
        retried = true;
        logRateLimitedError(
          'questdb-transport-disconnected',
          'QuestDB transport disconnected, resetting sender and retrying write',
          error,
        );
        await resetSender('transport disconnected');
        continue;
      }
      throw error;
    }
  }
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const wait = (delay: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delay));

async function drainWriteQueue(): Promise<void> {
  while (!closing) {
    if (pendingWrites.length === 0) {
      const remainingFlushDelay = Math.max(0, flushInterval - (Date.now() - lastFlushTime));
      if (remainingFlushDelay > 0) await wait(remainingFlushDelay);
      if (pendingWrites.length === 0) {
        await writeBatchWithReconnect([], true);
        return;
      }
    }

    const batch = pendingWrites.splice(0, writeBatchSize);
    const shouldFlush = Date.now() - lastFlushTime >= flushInterval;

    try {
      await writeBatchWithReconnect(batch, shouldFlush);
      batch.forEach((task) => task.resolve());
    } catch (error) {
      batch.forEach((task) => task.reject(error));
    }

    await yieldToEventLoop();
  }
}

function startWriteQueueDrain(): void {
  if (drainPromise) return;

  drainPromise = drainWriteQueue().finally(() => {
    drainPromise = null;
    if (!closing && pendingWrites.length > 0) startWriteQueueDrain();
  });
}

function enqueueWrite(write: (activeSender: Sender) => void): Promise<void> {
  if (closing) return Promise.resolve();

  if (pendingWrites.length >= maxPendingWrites) {
    const error = new Error(`QuestDB write queue full (${pendingWrites.length}/${maxPendingWrites})`);
    logRateLimitedError('questdb-write-queue-full', 'QuestDB write queue full; dropping newest write', error);
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    pendingWrites.push({ write, resolve, reject });
    startWriteQueueDrain();
  });
}

async function getSender(): Promise<Sender> {
  if (sender) return sender;
  if (!initPromise) {
    initPromise = Sender.fromConfig(configStr)
      .then(async (s) => {
        await s.connect();
        sender = s;
        logger.info(`QuestDB sender initialized: ${QUESTDB_PROTOCOL}://${QUESTDB_HOST}:${QUESTDB_PORT}`);
        return s;
      })
      .catch((error) => {
        initPromise = null;
        throw error;
      });
  }
  return initPromise;
}

function registerMarket(activeSender: Sender, exchange: string, symbol: string, tables: QuestDBMarketTables): void {
  activeSender
    .table('market_data_catalog')
    .symbol('exchange', exchange)
    .symbol('symbol', symbol)
    .stringColumn('trades_table', tables.tradesTable)
    .stringColumn('orderbook_delta_table', tables.orderbookExactDeltaTable)
    .stringColumn('orderbook_exact_delta_table', tables.orderbookExactDeltaTable)
    .stringColumn('orderbook_depth_delta_table', tables.orderbookDepthDeltaTable)
    .at(Date.now(), 'ms');
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
      const tables = questdbMarketTables(exchange, symbol);
      await enqueueWrite((activeSender) => {
        const shouldRegister = !registeredMarkets.has(tables.marketKey);
        if (shouldRegister) registerMarket(activeSender, exchange, symbol, tables);
        activeSender
          .table(tables.tradesTable)
          .symbol('exchange', exchange)
          .symbol('symbol', symbol)
          .symbol('side', side)
          .floatColumn('price', parseFloat(price))
          .floatColumn('quantity', parseFloat(quantity))
          .stringColumn('trade_id', tradeId)
          .at(timestamp, 'ms');
        if (shouldRegister) registeredMarkets.add(tables.marketKey);
        if (!loggedFirstTradeWrite) {
          loggedFirstTradeWrite = true;
          logger.info('QuestDB completed first trade write');
        }
      });
    } catch (e) {
      logRateLimitedError('questdb-write-trade', 'QuestDB writeTrade error', e);
      throw e;
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
      const tables = questdbMarketTables(exchange, symbol);
      await enqueueWrite((activeSender) => {
        const shouldRegister = !registeredMarkets.has(tables.marketKey);
        if (shouldRegister) registerMarket(activeSender, exchange, symbol, tables);
        for (const [price, qty] of asks) {
          activeSender
            .table(tables.orderbookDeltaTable)
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
          activeSender
            .table(tables.orderbookDeltaTable)
            .symbol('exchange', exchange)
            .symbol('symbol', symbol)
            .symbol('side', 'bid')
            .symbol('update_type', updateType)
            .floatColumn('price', price)
            .floatColumn('qty', qty)
            .floatColumn('sequence', sequence || 0)
            .at(timestamp, 'ms');
        }
        if (shouldRegister) registeredMarkets.add(tables.marketKey);
        if (!loggedFirstOrderbookWrite) {
          loggedFirstOrderbookWrite = true;
          logger.info('QuestDB completed first orderbook write');
        }
      });
    } catch (e) {
      logRateLimitedError('questdb-write-orderbook', 'QuestDB writeOrderbookDelta error', e);
      throw e;
    }
  },

  writeLayeredOrderbook: async (
    exchange: string,
    symbol: string,
    exactAsks: [number, number][],
    exactBids: [number, number][],
    aggregateAsks: [number, number, number][],
    aggregateBids: [number, number, number][],
    timestamp: number,
    sequence: number | undefined,
    updateType: 'snapshot' | 'second_delta',
    exactDepth: number,
    tickSize: number,
    referencePrice: number,
    aggregationVersion: number,
    sourceUpdateCount: number,
  ): Promise<void> => {
    try {
      const tables = questdbMarketTables(exchange, symbol);
      await enqueueWrite((activeSender) => {
        const shouldRegister = !registeredMarkets.has(tables.marketKey);
        if (shouldRegister) registerMarket(activeSender, exchange, symbol, tables);

        const writeExact = (side: string, price: number, quantity: number): void => {
          activeSender
            .table(tables.orderbookExactDeltaTable)
            .symbol('exchange', exchange)
            .symbol('symbol', symbol)
            .symbol('side', side)
            .symbol('update_type', updateType)
            .floatColumn('price', price)
            .floatColumn('qty', quantity)
            .floatColumn('sequence', sequence || 0)
            .floatColumn('exact_depth', exactDepth)
            .floatColumn('tick_size', tickSize)
            .floatColumn('reference_price', referencePrice)
            .floatColumn('aggregation_version', aggregationVersion)
            .floatColumn('source_update_count', sourceUpdateCount)
            .at(timestamp, 'ms');
        };
        const writeAggregate = (side: string, start: number, end: number, quantity: number): void => {
          activeSender
            .table(tables.orderbookDepthDeltaTable)
            .symbol('exchange', exchange)
            .symbol('symbol', symbol)
            .symbol('side', side)
            .symbol('update_type', updateType)
            .floatColumn('bucket_start', start)
            .floatColumn('bucket_end', end)
            .floatColumn('qty', quantity)
            .floatColumn('sequence', sequence || 0)
            .floatColumn('exact_depth', exactDepth)
            .floatColumn('tick_size', tickSize)
            .floatColumn('reference_price', referencePrice)
            .floatColumn('aggregation_version', aggregationVersion)
            .floatColumn('source_update_count', sourceUpdateCount)
            .at(timestamp, 'ms');
        };

        exactAsks.forEach(([price, quantity]) => writeExact('ask', price, quantity));
        exactBids.forEach(([price, quantity]) => writeExact('bid', price, quantity));
        aggregateAsks.forEach(([start, end, quantity]) => writeAggregate('ask', start, end, quantity));
        aggregateBids.forEach(([start, end, quantity]) => writeAggregate('bid', start, end, quantity));
        if (shouldRegister) registeredMarkets.add(tables.marketKey);
      });
    } catch (error) {
      logRateLimitedError('questdb-write-layered-orderbook', 'QuestDB writeLayeredOrderbook error', error);
      throw error;
    }
  },

  /**
   * 显式刷新缓冲区（进程退出前调用）
   */
  flush: async (): Promise<void> => {
    while (drainPromise || pendingWrites.length > 0) {
      if (drainPromise) await drainPromise;
      else startWriteQueueDrain();
    }
    if (sender) {
      try {
        await flushWithTimeout(sender);
        lastFlushTime = Date.now();
      } catch (e) {
        logRateLimitedError('questdb-flush', 'QuestDB flush error', e);
        throw e;
      }
    }
  },

  /**
   * 关闭连接
   */
  close: async (): Promise<void> => {
    if (sender) {
      try {
        while (drainPromise || pendingWrites.length > 0) {
          if (drainPromise) await drainPromise;
          else startWriteQueueDrain();
        }
        closing = true;
        const current = sender;
        await current.flush();
        await current.close();
        sender = null;
        initPromise = null;
        logger.info('QuestDB sender closed');
      } catch (e) {
        logRateLimitedError('questdb-close', 'QuestDB close error', e);
      }
    }
  },
};
