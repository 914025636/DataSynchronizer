const connection = {
  beginTransaction: jest.fn(async () => undefined),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: jest.fn(async (..._args: any[]): Promise<any> => [[]]),
  commit: jest.fn(async () => undefined),
  rollback: jest.fn(async () => undefined),
  release: jest.fn(),
};

jest.mock('../database', () => ({ BaseDB: { getConnection: jest.fn(async () => connection), query: jest.fn() } }));
jest.mock('../exchange/ccxt_controller', () => ({ CCXT_API: {} }));
jest.mock('../logger', () => ({ logger: { verbose: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import { MarketDataAPI } from '../marketdata';

const market = (index: number) => ({
  exchange: 'binance',
  limits: {},
  precision: {},
  id: `ID${index}`,
  symbol: `S${index}/USDT`,
  baseId: `S${index}`,
  quoteId: 'USDT',
  base: `S${index}`,
  quote: 'USDT',
  active: true,
  info: {},
});

describe('MarketData replace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('replaces markets in chunks inside one transaction', async () => {
    const markets = Array.from({ length: 450 }, (_, index) => market(index));

    await MarketDataAPI.marketDataReplace('binance', markets);

    const replaceCalls = connection.query.mock.calls.filter(([sql]) => String(sql).startsWith('REPLACE'));

    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.query.mock.calls[0][0]).toContain('DELETE');
    expect(replaceCalls.map(([, params]) => params[0].length)).toEqual([200, 200, 50]);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
  });

  test('rolls back so existing markets survive a failed insert', async () => {
    connection.query.mockResolvedValueOnce([[]]).mockRejectedValueOnce(new Error('write ECONNABORTED'));

    await MarketDataAPI.marketDataReplace('binance', [market(1)]);

    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledTimes(1);
    expect(connection.release).toHaveBeenCalledTimes(1);
  });
});
