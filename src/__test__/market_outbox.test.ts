import { mkdtempSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MarketOutbox } from '../redis/market_outbox';
import { TradeStreamEvent } from '../redis/market_streams';

jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const event: TradeStreamEvent = { schemaVersion: 1, eventType: 'trade', exchange: 'binance', symbol: 'BTC/USDT', eventTime: 1, ingestedAt: 2, side: 'buy', price: '100', quantity: '1', tradeId: '1' };
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'market-outbox-'));
});

afterEach(() => {
  readdirSync(directory).forEach((name) => unlinkSync(join(directory, name)));
  rmdirSync(directory);
});

it('retains a failed batch and replays it after reopening the outbox', async () => {
  const send = jest.fn().mockRejectedValue(new Error('offline'));
  const first = new MarketOutbox(directory, send);
  await first.append('trades', event);
  await expect(first.drain()).rejects.toThrow('offline');
  await first.close();
  expect(readdirSync(directory)).toHaveLength(1);

  send.mockReset().mockResolvedValue(undefined);
  const reopened = new MarketOutbox(directory, send);
  await reopened.drain();
  await reopened.close();
  expect(send).toHaveBeenCalledWith([{ stream: 'trades', event }]);
  expect(readdirSync(directory)).toHaveLength(0);
});

it('commits concurrent appends as one batch file', async () => {
  const send = jest.fn().mockResolvedValue(undefined);
  const outbox = new MarketOutbox(directory, send);
  const second = { ...event, tradeId: '2' };
  const ids = await Promise.all([outbox.append('trades', event), outbox.append('trades', second)]);
  await outbox.drain();
  await outbox.close();
  expect(ids[0]).toBe(ids[1]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith([{ stream: 'trades', event }, { stream: 'trades', event: second }]);
  expect(readdirSync(directory)).toHaveLength(0);
});

it('commits buffered messages on close', async () => {
  const outbox = new MarketOutbox(directory, jest.fn().mockRejectedValue(new Error('offline')));
  const pending = outbox.append('trades', event);
  await outbox.close();
  await expect(pending).resolves.toMatch(/\.json$/);
  expect(readdirSync(directory)).toHaveLength(1);
});

it('quarantines an incomplete batch and replays legacy single-message files', async () => {
  writeFileSync(join(directory, '1-0000000000-a.tmp'), '[{"stream"');
  writeFileSync(join(directory, '1-0000000001-b.json'), JSON.stringify({ stream: 'trades', event }));
  const send = jest.fn().mockResolvedValue(undefined);
  const outbox = new MarketOutbox(directory, send);
  await outbox.drain();
  await outbox.close();
  expect(send).toHaveBeenCalledWith([{ stream: 'trades', event }]);
  expect(readdirSync(directory)).toEqual(['1-0000000000-a.corrupt']);
});