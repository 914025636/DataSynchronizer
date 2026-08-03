import 'dotenv/config';
import { logger } from './logger';
import { QuestDBWriter } from './questdb';
import { MarketStreamWorker } from './workers/market_stream_worker';
import { MARKET_STREAMS } from './redis/market_streams';

const workerMode = (process.env.MARKET_STREAM_WORKER_MODE || 'all').toLowerCase();
const streams =
  workerMode === 'trades'
    ? [MARKET_STREAMS.trades]
    : workerMode === 'orderbook'
    ? [MARKET_STREAMS.orderbook]
    : [MARKET_STREAMS.trades, MARKET_STREAMS.orderbook];
const worker = new MarketStreamWorker({ streams });
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, stopping QuestDB market stream worker`);
  await worker.stop();
  await QuestDBWriter.close();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

worker.start().catch((error: unknown) => {
  logger.error('QuestDB market stream worker startup failed', error);
  process.exit(1);
});
