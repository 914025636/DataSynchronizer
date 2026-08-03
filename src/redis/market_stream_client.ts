import IORedis, { RedisOptions } from 'ioredis';
import { logger } from '../logger';
import { MarketStreamEvent, RedisStreamEntry, serializeMarketEvent } from './market_streams';

export const MARKET_STREAM_GROUP = process.env.REDIS_MARKET_STREAM_GROUP || 'questdb-writers-v1';
export const MARKET_STREAM_MAX_LENGTH = Number(process.env.REDIS_MARKET_STREAM_MAX_LENGTH || 10000000);
export const MARKET_STREAM_READ_COUNT = Number(process.env.REDIS_MARKET_STREAM_READ_COUNT || 2000);
export const MARKET_STREAM_BLOCK_MS = Number(process.env.REDIS_MARKET_STREAM_BLOCK_MS || 2000);

const redisConfig: RedisOptions = {
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT === undefined ? 6379 : parseInt(process.env.REDIS_PORT, 10),
  family: 4,
  password: process.env.REDIS_AUTH,
  db: process.env.REDIS_DB_ID === undefined ? 0 : parseInt(process.env.REDIS_DB_ID, 10),
  retryStrategy: (times: number) => Math.min(times * 250, 10000),
};

type StreamRedis = InstanceType<typeof IORedis>;

const producerClients = new Set<StreamRedis>();
const streamCapabilityChecks = new WeakMap<StreamRedis, Promise<void>>();

function parseRedisMajorVersion(info: string): number | null {
  const match = info.match(/(?:^|\r?\n)redis_version:([^\r\n]+)/);
  if (!match) return null;
  const major = Number(match[1].split('.')[0]);
  return Number.isFinite(major) ? major : null;
}

async function ensureStreamsSupported(client: StreamRedis): Promise<void> {
  let check = streamCapabilityChecks.get(client);
  if (!check) {
    check = client.info('server').then((info: string) => {
      const major = parseRedisMajorVersion(info);
      if (major !== null && major < 5) {
        throw new Error(`Redis Streams require Redis 5 or newer; connected Redis version is ${major}.x`);
      }
    });
    streamCapabilityChecks.set(client, check);
  }
  return check;
}

export function createMarketStreamRedis(name: string): StreamRedis {
  const client = new IORedis(redisConfig);
  let unavailable = false;

  client.on('error', (error: Error) => {
    if (!unavailable) {
      logger.error(`${name} unavailable`, error);
      unavailable = true;
    }
  });
  client.on('ready', () => {
    if (unavailable) logger.info(`${name} connection restored`);
    unavailable = false;
  });

  return client;
}

export class MarketStreamProducer {
  private readonly client: StreamRedis;

  constructor(client?: StreamRedis) {
    this.client = client || createMarketStreamRedis('Redis market stream producer');
    if (!client) producerClients.add(this.client);
  }

  async append(stream: string, event: MarketStreamEvent): Promise<string> {
    await ensureStreamsSupported(this.client);
    return this.client.xadd(
      stream,
      'MAXLEN',
      '~',
      MARKET_STREAM_MAX_LENGTH,
      '*',
      ...serializeMarketEvent(event),
    );
  }

  async close(): Promise<void> {
    await this.client.quit();
    producerClients.delete(this.client);
  }
}

export async function closeMarketStreamProducers(): Promise<void> {
  const clients = Array.from(producerClients);
  producerClients.clear();
  await Promise.all(clients.map((client) => client.quit()));
}

export type StreamReadResult = {
  stream: string;
  entries: RedisStreamEntry[];
};

export type StreamGroupHealth = {
  pending: number;
  lag: number;
  oldestPendingId?: string;
  oldestUndeliveredId?: string;
};

export class MarketStreamConsumer {
  constructor(private readonly client: StreamRedis = createMarketStreamRedis('Redis market stream consumer')) {}

  async ensureGroup(stream: string, group: string = MARKET_STREAM_GROUP): Promise<void> {
    await ensureStreamsSupported(this.client);
    try {
      await this.client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  async read(
    streams: string[],
    consumer: string,
    group: string = MARKET_STREAM_GROUP,
  ): Promise<StreamReadResult[]> {
    const response = (await this.client.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      MARKET_STREAM_READ_COUNT,
      'BLOCK',
      MARKET_STREAM_BLOCK_MS,
      'STREAMS',
      ...streams,
      ...streams.map(() => '>'),
    )) as Array<[string, RedisStreamEntry[]]> | null;

    if (!response) return [];
    return response.map(([stream, entries]) => ({ stream, entries }));
  }

  async claimPending(
    stream: string,
    consumer: string,
    minIdleMs: number,
    group: string = MARKET_STREAM_GROUP,
  ): Promise<RedisStreamEntry[]> {
    const pending = (await this.client.xpending(
      stream,
      group,
      'IDLE',
      minIdleMs,
      '-',
      '+',
      MARKET_STREAM_READ_COUNT,
    )) as unknown[];
    const ids = pending
      .filter((item) => Array.isArray(item) && item.length > 0)
      .map((item) => String((item as unknown[])[0]));
    if (ids.length === 0) return [];
    return (await this.client.xclaim(stream, group, consumer, minIdleMs, ...ids)) as RedisStreamEntry[];
  }

  async acknowledge(stream: string, ids: string[], group: string = MARKET_STREAM_GROUP): Promise<number> {
    if (ids.length === 0) return 0;
    return this.client.xack(stream, group, ...ids);
  }

  async deadLetter(stream: string, entry: RedisStreamEntry, reason: string): Promise<string> {
    return this.client.xadd(
      `${stream}:dead-letter`,
      'MAXLEN',
      '~',
      MARKET_STREAM_MAX_LENGTH,
      '*',
      'sourceStream',
      stream,
      'sourceId',
      entry[0],
      'reason',
      reason,
      'fields',
      JSON.stringify(entry[1]),
    );
  }

  async groupHealth(stream: string, group: string = MARKET_STREAM_GROUP): Promise<StreamGroupHealth> {
    const groups = (await this.client.xinfo('GROUPS', stream)) as unknown[];
    const groupEntry = groups.find((item) => {
      if (!Array.isArray(item)) return false;
      const fields = item as unknown[];
      return fields[0] === 'name' && fields[1] === group;
    });
    if (!Array.isArray(groupEntry)) return { pending: 0, lag: 0 };

    let pending = 0;
    let lag = 0;
    let lastDeliveredId = '0-0';
    for (let index = 0; index + 1 < groupEntry.length; index += 2) {
      const key = String(groupEntry[index]);
      const value = Number(groupEntry[index + 1]);
      if (key === 'pending') pending = Number.isFinite(value) ? value : 0;
      if (key === 'lag') lag = Number.isFinite(value) ? value : 0;
      if (key === 'last-delivered-id') lastDeliveredId = String(groupEntry[index + 1]);
    }

    let oldestPendingId: string | undefined;
    if (pending > 0) {
      const pendingEntries = (await this.client.xpending(stream, group, '-', '+', 1)) as unknown[];
      if (Array.isArray(pendingEntries) && Array.isArray(pendingEntries[0])) {
        oldestPendingId = String(pendingEntries[0][0]);
      }
    }
    let oldestUndeliveredId: string | undefined;
    if (lag > 0) {
      const undelivered = (await this.client.xrange(stream, `(${lastDeliveredId}`, '+', 'COUNT', 1)) as RedisStreamEntry[];
      if (Array.isArray(undelivered) && Array.isArray(undelivered[0])) oldestUndeliveredId = String(undelivered[0][0]);
    }
    return { pending, lag, oldestPendingId, oldestUndeliveredId };
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
