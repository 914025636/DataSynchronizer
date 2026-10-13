import * as ccxt from 'ccxt';
import { existsSync, mkdirSync, promises as fsp, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, resolve } from 'path';

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
    await fsp.rename(temporary, this.filename);
  }
}

export async function recoverBinanceTrades(client: ccxt.Exchange, symbol: string, previous: ccxt.Trade, next: ccxt.Trade): Promise<ccxt.Trade[]> {
  const previousId = Number(previous.id);
  const nextId = Number(next.id);
  if (!Number.isSafeInteger(previousId) || !Number.isSafeInteger(nextId)) throw new Error('Unsafe Binance trade ID');
  if (nextId <= previousId + 1) return [];
  const prefix = symbol.includes(':') ? 'fapi' : 'public';
  const recovered: ccxt.Trade[] = [];
  let cursor = previousId + 1;
  let recent = await client.fetchTrades(symbol, undefined, 1000, { fetchTradesMethod: `${prefix}GetTrades` });
  while (cursor < nextId) {
    if (!recent.some((trade) => Number(trade.id) === cursor)) {
      recent = await client.fetchTrades(symbol, undefined, 1000, {
        fetchTradesMethod: `${prefix}GetHistoricalTrades`, fromId: String(cursor),
      });
    }
    const page = recent.filter((trade) => Number(trade.id) >= cursor && Number(trade.id) < nextId)
      .sort((left, right) => Number(left.id) - Number(right.id));
    if (!page.length) throw new Error(`Binance trade gap unresolved: ${symbol} fromId=${cursor}`);
    for (const trade of page) {
      if (Number(trade.id) !== cursor) throw new Error(`Binance trade gap unresolved: ${symbol} fromId=${cursor}`);
      recovered.push(trade);
      cursor += 1;
    }
    recent = [];
  }
  return recovered;
}