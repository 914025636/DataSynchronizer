const tableCalls: string[] = [];

type MockSender = {
  connect: jest.Mock;
  close: jest.Mock;
  flush: jest.Mock;
  table: jest.Mock;
  symbol: jest.Mock;
  floatColumn: jest.Mock;
  stringColumn: jest.Mock;
  at: jest.Mock;
};

const sender: MockSender = {
  connect: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
  flush: jest.fn().mockResolvedValue(undefined),
  table: jest.fn((tableName: string) => {
    tableCalls.push(tableName);
    return sender;
  }),
  symbol: jest.fn(() => sender),
  floatColumn: jest.fn(() => sender),
  stringColumn: jest.fn(() => sender),
  at: jest.fn().mockResolvedValue(undefined),
};

jest.mock('@questdb/nodejs-client', () => ({
  Sender: {
    fromConfig: jest.fn().mockResolvedValue(sender),
  },
}));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

process.env.QUESTDB_FLUSH_INTERVAL_MS = '0';
process.env.QUESTDB_FLUSH_TIMEOUT_MS = '20';

import { QuestDBWriter } from '../questdb';

describe('QuestDBWriter market routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    tableCalls.length = 0;
  });

  afterAll(async () => {
    await QuestDBWriter.close();
  });

  it('registers a market before routing trades to its table', async () => {
    await QuestDBWriter.writeTrade('binance', 'BTC/USDT', 'buy', '100', '1', 'trade-1', 1000);

    expect(tableCalls).toEqual(['market_data_catalog', 'binance_btc_usdt_spot_trades']);
  });

  it('reuses the catalog registration and routes orderbook rows by market', async () => {
    await QuestDBWriter.writeOrderbookDelta('binance', 'BTC/USDT', [[101, 2]], [[99, 3]], 1100, 10);
    await QuestDBWriter.writeTrade('okx', 'BTC/USDT:USDT', 'sell', '100', '1', 'trade-2', 1200);

    expect(tableCalls.slice(0, 2)).toEqual([
      'binance_btc_usdt_spot_orderbook_delta',
      'binance_btc_usdt_spot_orderbook_delta',
    ]);
    expect(tableCalls[2]).toBe('market_data_catalog');
    expect(tableCalls[3]).toBe('okx_btc_usdt_swap_trades');
  });

  it('resets the sender and retries when a TCP flush stalls', async () => {
    sender.flush.mockImplementationOnce(() => new Promise(() => undefined));

    await QuestDBWriter.writeTrade('bybit', 'ETH/USDT', 'buy', '2000', '1', 'trade-3', 1300);

    expect(sender.close).toHaveBeenCalled();
    expect(sender.connect).toHaveBeenCalledTimes(1);
    expect(sender.flush).toHaveBeenCalledTimes(2);
  });

  it('propagates an explicit flush failure to prevent acknowledgement', async () => {
    sender.flush.mockRejectedValueOnce(new Error('flush failed'));

    await expect(QuestDBWriter.flush()).rejects.toThrow('flush failed');
  });
});
