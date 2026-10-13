const mockPublish = jest.fn().mockResolvedValue(1);
const mockRedisGet = jest.fn().mockResolvedValue(JSON.stringify({ asks: [[200, 9]], bids: [[1, 9]] }));
const mockOrderbookReplace = jest.fn().mockResolvedValue(undefined);

jest.mock('../redis/redis', () => ({ Redis: { get: mockRedisGet, set: jest.fn() }, RedisPub: { publish: mockPublish } }));
jest.mock('../redis/market_stream_client', () => ({ MarketStreamProducer: jest.fn(() => ({ append: jest.fn() })) }));
jest.mock('../database/queries', () => ({
  DBQueries: { tableCheck: jest.fn().mockResolvedValue(true), orderbookReplace: mockOrderbookReplace, createNewTableFromTemplate: jest.fn() },
}));
jest.mock('../tradepairs/tradepairs', () => ({ TradepairQueries: { idToSymbol: jest.fn(async (_exchange, symbol) => symbol) } }));
jest.mock('../logger', () => ({ logger: { verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { Emitter } from '../emitter/emitter';
import { EMITTER_EVENTS } from '../constants';
import '../emitter/events/orderbook_emitter';

const settle = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };

describe('OrderbookEmitter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('replaces state on full-book updates and publishes only changed best prices', async () => {
    const update = (asks: number[][], bids: number[][]) =>
      Emitter.emit(EMITTER_EVENTS.OrderBookUpdate, 'Binance', { symbol: 'BTC/USDT', asks, bids, updateType: 'snapshot' });

    update([[101, 1]], [[99, 1]]);
    await settle();
    update([[101, 2]], [[99, 1]]);
    await settle();
    update([[102, 1]], [[99, 1]]);
    await settle();

    expect(mockPublish).toHaveBeenCalledTimes(2);
    expect(mockRedisGet).not.toHaveBeenCalled();

    Emitter.emit(EMITTER_EVENTS.OrderBookSnapshot, 60000);
    await settle();
    expect(mockOrderbookReplace).toHaveBeenCalledWith(expect.stringContaining('binance'), {
      time: 60000,
      orderbook: { asks: [[102, 1]], bids: [[99, 1]] },
    });
  });

  it('seeds delta-only feeds from the cached Redis snapshot', async () => {
    Emitter.emit(EMITTER_EVENTS.OrderBookUpdate, 'kucoin', { symbol: 'ETH-USDT', asks: [[201, 1]], bids: [[2, 1]] });
    await settle();

    expect(mockRedisGet).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith('OrderBookUpdate', JSON.stringify({ exchange: 'kucoin', symbol: 'ETH-USDT', ask: 200, bid: 2 }));
  });
});
