import * as ccxt from 'ccxt';
import { existsSync, mkdirSync, promises as fsp, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';
import { renameWithRetry } from '../utils/fs_retry';

export class TradeCheckpoint {
  private readonly filename: string;

  constructor(exchange: string, symbol: string, directory = resolve(process.env.MARKET_OUTBOX_DIRECTORY || '.market-outbox', 'checkpoints')) {
    mkdirSync(directory, { recursive: true });
    this.filename = join(directory, `${createHash('sha256').update(`${exchange}:${symbol}`).digest('hex')}.json`);
  }

  load(): ccxt.Trade | undefined {
    if (!existsSync(this.filename)) return undefined;
    return JSON.parse(readFileSync(this.filename, 'utf8'));
  }

  async save(trade: ccxt.Trade): Promise<void> {
    const temporary = `${this.filename}.tmp`;
    const handle = await fsp.open(temporary, 'w');
    try {
      await handle.writeFile(JSON.stringify({ id: trade.id, timestamp: trade.timestamp, symbol: trade.symbol }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, this.filename);
  }
}

export type TradeGap = {
  fromId: number;
  toId: number;
  // Last trade before and first trade after the missing range
  fromTimestamp?: number;
  toTimestamp?: number;
  reason: string;
};

// Durable record of trade ranges recovery could not fill, so missing data is never silent
export class TradeGapLog {
  private readonly filename: string;

  constructor(directory = resolve(process.env.MARKET_OUTBOX_DIRECTORY || '.market-outbox', 'gaps')) {
    mkdirSync(directory, { recursive: true });
    this.filename = join(directory, 'trade_gaps.jsonl');
  }

  async record(exchange: string, symbol: string, gap: TradeGap): Promise<void> {
    const handle = await fsp.open(this.filename, 'a');
    try {
      await handle.writeFile(`${JSON.stringify({ exchange, symbol, ...gap, recordedAt: Date.now() })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export type RecoverySink = {
  trades: (trades: ccxt.Trade[]) => Promise<void>;
  gap: (gap: TradeGap) => Promise<void>;
};

// A page holds every market trade with an ID from lowerBound to upperBound
type TradePage = { trades: ccxt.Trade[]; lowerBound: number; upperBound: number };

const toPage = (trades: ccxt.Trade[], lowerBound?: number): TradePage => {
  const sorted = [...trades].sort((left, right) => Number(left.id) - Number(right.id));
  return {
    trades: sorted,
    lowerBound: lowerBound ?? (sorted.length ? Number(sorted[0].id) : Infinity),
    upperBound: sorted.length ? Number(sorted[sorted.length - 1].id) : -Infinity,
  };
};

const covers = (page: TradePage, id: number): boolean => page.lowerBound <= id && id <= page.upperBound;

// Retrying cannot fix missing credentials, unsupported endpoints or rejected parameters
const isPermanentError = (error: unknown): boolean =>
  error instanceof ccxt.AuthenticationError
  || error instanceof ccxt.NotSupported
  || error instanceof ccxt.BadRequest
  || error instanceof ccxt.OperationRejected;

async function fetchHistoricalTrades(client: ccxt.Exchange, symbol: string, prefix: string, fromId: number): Promise<ccxt.Trade[]> {
  if (prefix === 'public' && !client.apiKey) {
    // Binance serves spot historicalTrades without a key, but CCXT refuses to send it unsigned
    const market = client.market(symbol);
    await client.throttle(client.api.public.get.historicalTrades);
    const query = client.urlencode({ symbol: market.id, fromId, limit: 1000 });
    const { public: baseUrl } = client.urls.api as Record<string, string>;
    return client.parseTrades(await client.fetch(`${baseUrl}/historicalTrades?${query}`), market);
  }
  return client.fetchTrades(symbol, undefined, 1000, { fetchTradesMethod: `${prefix}GetHistoricalTrades`, fromId: String(fromId) });
}

// Delivers the trades between previous and next page by page; ranges that cannot be fetched are reported as gaps
export async function recoverBinanceTrades(
  client: ccxt.Exchange, symbol: string, previous: ccxt.Trade, next: ccxt.Trade, sink: RecoverySink,
): Promise<void> {
  const previousId = Number(previous.id);
  const nextId = Number(next.id);
  if (!Number.isSafeInteger(previousId) || !Number.isSafeInteger(nextId)) throw new Error('Unsafe Binance trade ID');
  if (nextId <= previousId + 1) return;
  // Contract streams carry non-market IDs that REST never returns, so contract pages may skip IDs
  const contract = symbol.includes(':');
  const prefix = contract ? 'fapiPublic' : 'public';
  const unresolved = (id: number): Error => new Error(`Binance trade gap unresolved: ${symbol} fromId=${id}`);
  const latest = toPage(await client.fetchTrades(symbol, undefined, 1000, { fetchTradesMethod: `${prefix}GetTrades` }));
  let cursor = previousId + 1;
  let lastTimestamp = previous.timestamp;
  let page = latest;
  while (cursor < nextId) {
    if (!covers(page, cursor)) {
      // The stream can run ahead of REST; a later retry sees the missing trades
      if (cursor > latest.upperBound) throw unresolved(cursor);
      if (covers(latest, cursor)) {
        page = latest;
      } else {
        try {
          page = toPage(await fetchHistoricalTrades(client, symbol, prefix, cursor), cursor);
        } catch (error) {
          if (!isPermanentError(error)) throw error;
          // Keep what the recent window still covers and record the rest as a gap
          const resume = Math.min(latest.lowerBound, nextId);
          await sink.gap({
            fromId: cursor,
            toId: resume - 1,
            fromTimestamp: lastTimestamp,
            toTimestamp: resume === nextId ? next.timestamp : latest.trades[0].timestamp,
            reason: (error as Error).message,
          });
          cursor = resume;
          page = latest;
          continue;
        }
        if (page.upperBound < cursor) throw unresolved(cursor);
      }
    }
    const recovered: ccxt.Trade[] = [];
    for (const trade of page.trades) {
      const id = Number(trade.id);
      if (id < cursor) continue;
      if (id >= nextId) break;
      if (!contract && id !== cursor) throw unresolved(cursor);
      recovered.push(trade);
      cursor = id + 1;
    }
    // A covering contract page proves the IDs it lacks are non-market trades
    if (contract) cursor = Math.min(page.upperBound + 1, nextId);
    else if (cursor < nextId && cursor <= page.upperBound) throw unresolved(cursor);
    if (recovered.length) {
      await sink.trades(recovered);
      lastTimestamp = recovered[recovered.length - 1].timestamp;
    }
  }
}