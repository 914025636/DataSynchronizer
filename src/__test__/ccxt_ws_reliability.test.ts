const mockWatchTrades = jest.fn();
const mockWatchOrderBook = jest.fn();
const mockRecover = jest.fn().mockResolvedValue([]);
const mockCheckpointSave = jest.fn();
jest.mock('ccxt', () => ({ pro: { binance: jest.fn(() => ({
  has: { watchTrades: true, watchOrderBook: true },
  loadMarkets: jest.fn().mockResolvedValue(undefined),
  watchTrades: mockWatchTrades,
  watchOrderBook: mockWatchOrderBook,
  close: jest.fn().mockResolvedValue(undefined),
})) } }));
jest.mock('../exchange/trade_recovery', () => ({
  recoverBinanceTrades: mockRecover,
  TradeCheckpoint: jest.fn(() => ({ load: () => undefined, save: mockCheckpointSave })),
}));
jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
import { openSocket } from '../exchange/ws_exchanges/ccxt_ws';
import { Emitter } from '../emitter/emitter';
import { EMITTER_EVENTS } from '../constants';

const settle = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };

describe('active CCXT websocket reliability', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockWatchTrades.mockReset().mockImplementation(() => new Promise(() => undefined));
    mockWatchOrderBook.mockReset().mockImplementation(() => new Promise(() => undefined));
    mockCheckpointSave.mockClear();
    Emitter.removeAllListeners();
  });
  afterEach(() => { Emitter.removeAllListeners(); jest.clearAllTimers(); jest.useRealTimers(); });

  it('retains the snapshot baseline when durable enqueue fails', async () => {
    mockWatchOrderBook.mockResolvedValueOnce({ asks: [[101, 1]], bids: [[99, 1]], nonce: 1 });
    const persist = jest.fn((_exchange, _depth, acknowledge) => acknowledge(new Error('disk unavailable')));
    Emitter.on(EMITTER_EVENTS.OrderBookPersist, persist);
    const close = openSocket('binance', ['BTC/USDT']);
    try {
      await settle();
      jest.advanceTimersByTime(1000);
      await settle();
      jest.advanceTimersByTime(1000);
      await settle();
      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist.mock.calls[0][1].updateType).toBe('snapshot');
      expect(persist.mock.calls[1][1].updateType).toBe('snapshot');
    } finally { close(); }
  });

  it('emits full books in real time and persists one delta per interval only when updated', async () => {
    let release: (book: unknown) => void = () => undefined;
    mockWatchOrderBook
      .mockResolvedValueOnce({ asks: [[101, 1], [102, 1]], bids: [[99, 1]], nonce: 1 })
      .mockResolvedValueOnce({ asks: [[101, 2], [102, 1]], bids: [[99, 1]], nonce: 2 })
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const updates = jest.fn();
    const persist = jest.fn((_exchange, _depth, acknowledge) => acknowledge());
    Emitter.on(EMITTER_EVENTS.OrderBookUpdate, updates);
    Emitter.on(EMITTER_EVENTS.OrderBookPersist, persist);
    const close = openSocket('binance', ['BTC/USDT']);
    try {
      await settle();
      expect(updates).toHaveBeenCalledTimes(2);
      expect(updates.mock.calls[1][1]).toMatchObject({ asks: [[101, 2], [102, 1]], bids: [[99, 1]], updateType: 'snapshot' });

      jest.advanceTimersByTime(1000);
      await settle();
      expect(persist).toHaveBeenCalledTimes(1);
      expect(persist.mock.calls[0][1]).toMatchObject({ updateType: 'snapshot', sourceUpdateCount: 2 });

      jest.advanceTimersByTime(1000);
      await settle();
      expect(persist).toHaveBeenCalledTimes(1);

      release({ asks: [[101, 3]], bids: [[99, 1]], nonce: 3 });
      await settle();
      jest.advanceTimersByTime(1000);
      await settle();
      expect(persist).toHaveBeenCalledTimes(2);
      expect(persist.mock.calls[1][1]).toMatchObject({
        updateType: 'delta',
        asks: [[101, 3], [102, 0]],
        bids: [],
        sourceUpdateCount: 1,
      });
    } finally { close(); }
  });

  it('persists recovered trades before the next live trade and checkpoints each accepted batch once', async () => {
    const first = { id: '1', timestamp: 1, symbol: 'BTC/USDT', side: 'buy', price: 100, amount: 1 };
    const missed = { ...first, id: '2', timestamp: 2 };
    const next = { ...first, id: '3', timestamp: 3 };
    mockWatchTrades.mockResolvedValueOnce([first]).mockResolvedValueOnce([next]);
    mockRecover.mockResolvedValueOnce([missed]);
    const ids: string[] = [];
    Emitter.on('Trades', (_exchange, trade, acknowledge) => { ids.push(trade.tradeId); acknowledge(); });
    const close = openSocket('binance', ['BTC/USDT']);
    try {
      await settle();
      expect(ids).toEqual(['1', '2', '3']);
      expect(mockCheckpointSave.mock.calls.map(([saved]) => saved.id)).toEqual(['1', '3']);
    } finally { close(); }
  });

  it('does not checkpoint a batch until every trade is accepted', async () => {
    const first = { id: '1', timestamp: 1, symbol: 'BTC/USDT', side: 'buy', price: 100, amount: 1 };
    const second = { ...first, id: '2', timestamp: 2 };
    mockWatchTrades.mockResolvedValueOnce([first, second]);
    const acknowledgements: ((error?: unknown) => void)[] = [];
    Emitter.on('Trades', (_exchange, _trade, acknowledge) => acknowledgements.push(acknowledge));
    const close = openSocket('binance', ['BTC/USDT']);
    try {
      await settle();
      expect(acknowledgements).toHaveLength(2);
      acknowledgements[1]();
      await settle();
      expect(mockCheckpointSave).not.toHaveBeenCalled();
      acknowledgements[0]();
      await settle();
      expect(mockCheckpointSave).toHaveBeenCalledTimes(1);
      expect(mockCheckpointSave.mock.calls[0][0].id).toBe('2');
    } finally { close(); }
  });
});