import { logger } from '../logger';
import { QuestDBWriter } from '../questdb';
import {
  MARKET_STREAM_BLOCK_MS,
  MARKET_STREAM_GROUP,
  MarketStreamConsumer,
  MARKET_STREAM_READ_COUNT,
  StreamGroupHealth,
} from '../redis/market_stream_client';
import { MARKET_STREAMS, parseMarketEvent, RedisStreamEntry } from '../redis/market_streams';

const warningLag = Number(process.env.REDIS_STREAM_WARNING_LAG || 10000);
const errorLag = Number(process.env.REDIS_STREAM_ERROR_LAG || 50000);
const warningAgeMs = Number(process.env.REDIS_STREAM_WARNING_AGE_MS || 30000);
const errorAgeMs = Number(process.env.REDIS_STREAM_ERROR_AGE_MS || 120000);
const monitorIntervalMs = Number(process.env.REDIS_STREAM_MONITOR_INTERVAL_MS || 10000);
const alertCooldownMs = Number(process.env.REDIS_STREAM_ALERT_COOLDOWN_MS || 60000);
const pendingIdleMs = Number(process.env.REDIS_STREAM_PENDING_IDLE_MS || 30000);

type AlertState = 'healthy' | 'warning' | 'error';

type StreamHealth = {
  stream: string;
  lag: number;
  pending: number;
  oldestPendingAgeMs: number;
};

type StreamWorkerOptions = {
  consumer?: string;
  group?: string;
  streams?: string[];
  client?: MarketStreamConsumer;
};

type ParsedEntry = {
  stream: string;
  id: string;
  event: ReturnType<typeof parseMarketEvent>;
};

function streamIdTime(id: string): number {
  const timestamp = Number(id.split('-')[0]);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

export class MarketStreamWorker {
  private readonly consumer: string;

  private readonly group: string;

  private readonly streams: string[];

  private readonly client: MarketStreamConsumer;

  private running = false;

  private monitorTimer: NodeJS.Timeout | null = null;

  private alertStates = new Map<string, AlertState>();

  private lastAlertTimes = new Map<string, number>();

  constructor(options: StreamWorkerOptions = {}) {
    this.consumer = options.consumer || process.env.REDIS_MARKET_STREAM_CONSUMER || `worker-${process.pid}`;
    this.group = options.group || MARKET_STREAM_GROUP;
    this.streams = options.streams || [MARKET_STREAMS.trades, MARKET_STREAMS.orderbook];
    this.client = options.client || new MarketStreamConsumer();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await Promise.all(this.streams.map((stream) => this.client.ensureGroup(stream, this.group)));
    this.monitorTimer = setInterval(() => {
      this.checkBacklog().catch((error: unknown) => logger.error('Redis stream backlog check failed', error));
    }, monitorIntervalMs);
    logger.info(`QuestDB market stream worker started: consumer=${this.consumer}`);

    while (this.running) {
      try {
        for (const stream of this.streams) {
          const pending = await this.client.claimPending(stream, this.consumer, pendingIdleMs, this.group);
          if (pending.length > 0) await this.process([{ stream, entries: pending }]);
        }
        const results = await this.client.read(this.streams, this.consumer, this.group);
        await this.process(results);
      } catch (error) {
        logger.error('QuestDB market stream worker loop failed', error);
        if (this.running) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = null;
    await this.client.close();
    logger.info('QuestDB market stream worker stopped');
  }

  private async process(results: { stream: string; entries: RedisStreamEntry[] }[]): Promise<void> {
    const acknowledged = new Map<string, string[]>();
    const parsed: ParsedEntry[] = [];

    for (const result of results) {
      for (const entry of result.entries) {
        try {
          const event = parseMarketEvent(entry[1]);
          parsed.push({ stream: result.stream, id: entry[0], event });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          logger.error(`QuestDB market event failed; leaving pending: stream=${result.stream} id=${entry[0]}`, error);
          if (reason.includes('invalid') || reason.includes('missing payload')) {
            try {
              await this.client.deadLetter(result.stream, entry, reason);
              await this.client.acknowledge(result.stream, [entry[0]], this.group);
            } catch (deadLetterError) {
              logger.error(`Redis market event dead-letter failed: stream=${result.stream} id=${entry[0]}`, deadLetterError);
            }
          }
        }
      }
    }

    if (parsed.length === 0) return;
    parsed.sort((left, right) => left.event.eventTime - right.event.eventTime);

    await Promise.all(
      parsed.map(({ event }) => {
        if (event.eventType === 'trade') {
          return QuestDBWriter.writeTrade(
            event.exchange,
            event.symbol,
            event.side,
            event.price,
            event.quantity,
            event.tradeId,
            event.eventTime,
          );
        }
        return QuestDBWriter.writeOrderbookDelta(
          event.exchange,
          event.symbol,
          event.asks,
          event.bids,
          event.eventTime,
          event.sequence,
          event.updateType,
        );
      }),
    );
    await QuestDBWriter.flush();
    parsed.forEach(({ stream, id }) => {
      const ids = acknowledged.get(stream) || [];
      ids.push(id);
      acknowledged.set(stream, ids);
    });
    for (const [stream, ids] of acknowledged) await this.client.acknowledge(stream, ids, this.group);
  }

  private async checkBacklog(): Promise<void> {
    const health = await Promise.all(this.streams.map((stream) => this.readHealth(stream)));
    health.forEach((item) => this.logHealth(item));
  }

  private async readHealth(stream: string): Promise<StreamHealth> {
    const groupHealth: StreamGroupHealth = await this.client.groupHealth(stream, this.group);
    const oldestIds = [groupHealth.oldestPendingId, groupHealth.oldestUndeliveredId].filter(
      (value): value is string => Boolean(value),
    );
    const oldestAgeMs = oldestIds.reduce((age, id) => Math.max(age, Date.now() - streamIdTime(id)), 0);

    return {
      stream,
      lag: groupHealth.lag,
      pending: groupHealth.pending,
      oldestPendingAgeMs: oldestAgeMs,
    };
  }

  private logHealth(health: StreamHealth): void {
    const error = health.lag >= errorLag || health.oldestPendingAgeMs >= errorAgeMs;
    const warning = health.lag >= warningLag || health.oldestPendingAgeMs >= warningAgeMs;
    const state: AlertState = error ? 'error' : warning ? 'warning' : 'healthy';
    const previous = this.alertStates.get(health.stream) || 'healthy';
    this.alertStates.set(health.stream, state);
    const now = Date.now();
    const lastAlertTime = this.lastAlertTimes.get(health.stream) || 0;
    const message = `QuestDB stream backlog: stream=${health.stream} lag=${health.lag} pending=${health.pending} oldestPendingAgeMs=${health.oldestPendingAgeMs}`;

    if (state !== previous || (state !== 'healthy' && now - lastAlertTime >= alertCooldownMs)) {
      this.lastAlertTimes.set(health.stream, now);
      if (state === 'error') logger.error(message);
      else if (state === 'warning') logger.warn(message);
      else if (previous !== 'healthy') logger.info(`${message} recovered`);
    }
  }
}

export const marketStreamWorkerConfig = {
  blockMs: MARKET_STREAM_BLOCK_MS,
  readCount: MARKET_STREAM_READ_COUNT,
  pendingIdleMs,
};
