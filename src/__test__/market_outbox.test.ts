import { mkdtempSync, readdirSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MarketOutbox } from '../redis/market_outbox';
import { TradeStreamEvent } from '../redis/market_streams';

it('retains a failed message and replays it after reopening the outbox', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'market-outbox-'));
  const event: TradeStreamEvent = { schemaVersion: 1, eventType: 'trade', exchange: 'binance', symbol: 'BTC/USDT', eventTime: 1, ingestedAt: 2, side: 'buy', price: '100', quantity: '1', tradeId: '1' };
  const send = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('1-0');
  const first = new MarketOutbox(directory, send);
  first.append('trades', event);
  await expect(first.drain()).rejects.toThrow('offline');
  expect(readdirSync(directory)).toHaveLength(1);
  first.stop();
  const reopened = new MarketOutbox(directory, send);
  try {
    await reopened.drain();
    expect(send).toHaveBeenLastCalledWith('trades', event);
    expect(readdirSync(directory)).toHaveLength(0);
  } finally {
    reopened.stop();
    rmdirSync(directory);
  }
});