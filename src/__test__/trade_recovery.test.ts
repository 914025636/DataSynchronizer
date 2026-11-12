import * as ccxt from 'ccxt';
import { mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recoverBinanceTrades, TradeCheckpoint, TradeGap, TradeGapLog } from '../exchange/trade_recovery';

const trade = (id: number) => ({ id: String(id), timestamp: id, symbol: 'BTC/USDT' } as never);
const trades = (...ids: number[]) => ids.map(trade);

const recover = async (client: unknown, symbol: string, previous: number, next: number) => {
  const recovered: number[] = [];
  const gaps: TradeGap[] = [];
  await recoverBinanceTrades(client as never, symbol, trade(previous), trade(next), {
    trades: async (page) => { recovered.push(...page.map((item) => Number(item.id))); },
    gap: async (gap) => { gaps.push(gap); },
  });
  return { recovered, gaps };
};

const withDirectory = async (run: (directory: string) => Promise<void>) => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-recovery-'));
  try {
    await run(directory);
  } finally {
    readdirSync(directory).forEach((name) => unlinkSync(join(directory, name)));
    rmdirSync(directory);
  }
};

it('restores the latest checkpoint after restart and isolates markets', () => withDirectory(async (directory) => {
  const checkpoint = new TradeCheckpoint('binance', 'BTC/USDT', directory);
  expect(checkpoint.load()).toBeUndefined();
  await checkpoint.save(trade(10));
  await checkpoint.save(trade(11));
  expect(new TradeCheckpoint('binance', 'BTC/USDT', directory).load()).toEqual(trade(11));
  expect(new TradeCheckpoint('binance', 'BTC/USDT:USDT', directory).load()).toBeUndefined();
}));

it('appends every unrecoverable gap to a durable log', () => withDirectory(async (directory) => {
  const log = new TradeGapLog(directory);
  await log.record('binance', 'BTC/USDT:USDT', { fromId: 11, toId: 14, reason: 'no key' });
  await log.record('binance', 'BTC/USDT', { fromId: 30, toId: 31, reason: 'no history' });
  const lines = readFileSync(join(directory, 'trade_gaps.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(lines).toMatchObject([
    { exchange: 'binance', symbol: 'BTC/USDT:USDT', fromId: 11, toId: 14, reason: 'no key' },
    { exchange: 'binance', symbol: 'BTC/USDT', fromId: 30, toId: 31, reason: 'no history' },
  ]);
}));

it('fills a raw trade gap from recent trades without mixing aggregate IDs', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValue(trades(11, 12, 13)) };
  expect(await recover(client, 'BTC/USDT', 10, 13)).toEqual({ recovered: [11, 12], gaps: [] });
  expect(client.fetchTrades).toHaveBeenCalledWith('BTC/USDT', undefined, 1000, { fetchTradesMethod: 'publicGetTrades' });
});

it('paginates historical raw futures trades when the recent window is insufficient', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValueOnce(trades(20)).mockResolvedValueOnce(trades(11)).mockResolvedValueOnce(trades(12)) };
  expect((await recover(client, 'BTC/USDT:USDT', 10, 13)).recovered).toEqual([11, 12]);
  expect(client.fetchTrades).toHaveBeenLastCalledWith('BTC/USDT:USDT', undefined, 1000, { fetchTradesMethod: 'fapiPublicGetHistoricalTrades', fromId: '12' });
});

it('accepts contract IDs that REST omits as non-market trades', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValue(trades(11, 13, 14, 16)) };
  expect(await recover(client, 'BTC/USDT:USDT', 10, 16)).toEqual({ recovered: [11, 13, 14], gaps: [] });
  expect(client.fetchTrades).toHaveBeenCalledTimes(1);
});

it('rejects a noncontiguous spot response instead of claiming recovery', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValue(trades(11, 13)) };
  await expect(recover(client, 'BTC/USDT', 10, 14)).rejects.toThrow('gap unresolved');
});

it('retries later when REST has not caught up with the stream', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValue(trades(9, 10)) };
  await expect(recover(client, 'BTC/USDT', 10, 12)).rejects.toThrow('gap unresolved');
});

it('records a gap and keeps the recent window when history is unavailable', async () => {
  const client = {
    fetchTrades: jest.fn()
      .mockResolvedValueOnce(trades(15, 16, 17, 18, 19))
      .mockRejectedValueOnce(new ccxt.AuthenticationError('historicalTrades requires apiKey')),
  };
  expect(await recover(client, 'BTC/USDT:USDT', 10, 20)).toEqual({
    recovered: [15, 16, 17, 18, 19],
    gaps: [{ fromId: 11, toId: 14, fromTimestamp: 10, toTimestamp: 15, reason: 'historicalTrades requires apiKey' }],
  });
});

it('keeps retrying transient history failures', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValueOnce(trades(20)).mockRejectedValueOnce(new ccxt.NetworkError('timeout')) };
  await expect(recover(client, 'BTC/USDT:USDT', 10, 13)).rejects.toThrow('timeout');
});

it('requests spot history unsigned when no API key is configured', async () => {
  const client = {
    fetchTrades: jest.fn().mockResolvedValue(trades(20)),
    market: () => ({ id: 'BTCUSDT' }),
    api: { public: { get: { historicalTrades: 2 } } },
    urls: { api: { public: 'https://api.binance.com/api/v3' } },
    throttle: jest.fn().mockResolvedValue(undefined),
    urlencode: (params: Record<string, string>) => new URLSearchParams(params).toString(),
    fetch: jest.fn().mockResolvedValue([{ raw: true }]),
    parseTrades: jest.fn(() => trades(11, 12)),
  };
  expect((await recover(client, 'BTC/USDT', 10, 13)).recovered).toEqual([11, 12]);
  expect(client.fetch).toHaveBeenCalledWith('https://api.binance.com/api/v3/historicalTrades?symbol=BTCUSDT&fromId=11&limit=1000');
  expect(client.throttle).toHaveBeenCalledWith(2);
});