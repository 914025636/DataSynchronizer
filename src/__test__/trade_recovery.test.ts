import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recoverBinanceTrades, TradeCheckpoint } from '../exchange/trade_recovery';

const trade = (id: number) => ({ id: String(id), timestamp: id, symbol: 'BTC/USDT' } as never);

it('restores the latest checkpoint after restart and isolates markets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trade-checkpoint-'));
  try {
    const checkpoint = new TradeCheckpoint('binance', 'BTC/USDT', directory);
    expect(checkpoint.load()).toBeUndefined();
    checkpoint.save(trade(10));
    checkpoint.save(trade(11));
    expect(new TradeCheckpoint('binance', 'BTC/USDT', directory).load()).toEqual(trade(11));
    expect(new TradeCheckpoint('binance', 'BTC/USDT:USDT', directory).load()).toBeUndefined();
  } finally {
    readdirSync(directory).forEach((name) => unlinkSync(join(directory, name)));
    rmdirSync(directory);
  }
});

it('fills a raw trade gap from recent trades without mixing aggregate IDs', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValue([trade(11), trade(12), trade(13)]) };
  expect(await recoverBinanceTrades(client as never, 'BTC/USDT', trade(10), trade(13))).toEqual([trade(11), trade(12)]);
  expect(client.fetchTrades).toHaveBeenCalledWith('BTC/USDT', undefined, 1000, { fetchTradesMethod: 'publicGetTrades' });
});

it('paginates historical raw futures trades when the recent window is insufficient', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValueOnce([trade(20)]).mockResolvedValueOnce([trade(11)]).mockResolvedValueOnce([trade(12)]) };
  expect(await recoverBinanceTrades(client as never, 'BTC/USDT:USDT', trade(10), trade(13))).toHaveLength(2);
  expect(client.fetchTrades).toHaveBeenLastCalledWith('BTC/USDT:USDT', undefined, 1000, { fetchTradesMethod: 'fapiGetHistoricalTrades', fromId: '12' });
});

it('rejects a noncontiguous response instead of claiming recovery', async () => {
  const client = { fetchTrades: jest.fn().mockResolvedValue([trade(11), trade(13)]) };
  await expect(recoverBinanceTrades(client as never, 'BTC/USDT', trade(10), trade(14))).rejects.toThrow('gap unresolved');
});