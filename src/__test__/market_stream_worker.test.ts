const questDBWriter = {
  writeTrade: jest.fn(),
  writeOrderbookDelta: jest.fn(),
  writeLayeredOrderbook: jest.fn(),
  flush: jest.fn(),
  close: jest.fn(),
};

jest.mock('../questdb', () => ({ QuestDBWriter: questDBWriter }));
jest.mock('../logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { MarketStreamWorker } from '../workers/market_stream_worker';

const fields = [
  'payload',
  JSON.stringify({
    schemaVersion: 1,
    eventType: 'trade',
    exchange: 'binance',
    symbol: 'BTC/USDT',
    eventTime: 1000,
    ingestedAt: 1001,
    side: 'buy',
    price: '100',
    quantity: '1',
    tradeId: 'trade-1',
  }),
];

describe('MarketStreamWorker acknowledgements', () => {
  beforeEach(() => jest.clearAllMocks());

  it('acknowledges only after QuestDB flush succeeds', async () => {
    questDBWriter.writeTrade.mockResolvedValue(undefined);
    questDBWriter.flush.mockResolvedValue(undefined);
    const client = { acknowledge: jest.fn().mockResolvedValue(1) };
    const worker = new MarketStreamWorker({ client: client as never });
    const processEntries = (worker as unknown as {
      process: (results: { stream: string; entries: [string, string[]][] }[]) => Promise<void>;
    }).process.bind(worker);

    await processEntries([{ stream: 'market:trades:v1', entries: [['1001-0', fields]] }]);

    expect(questDBWriter.writeTrade).toHaveBeenCalled();
    expect(questDBWriter.flush).toHaveBeenCalled();
    expect(client.acknowledge).toHaveBeenCalledWith(
      'market:trades:v1',
      ['1001-0'],
      'questdb-writers-v1',
    );
    expect(questDBWriter.flush.mock.invocationCallOrder[0]).toBeLessThan(client.acknowledge.mock.invocationCallOrder[0]);
  });

  it('leaves an entry pending when QuestDB write fails', async () => {
    questDBWriter.writeTrade.mockRejectedValue(new Error('QuestDB unavailable'));
    const client = { acknowledge: jest.fn(), deadLetter: jest.fn() };
    const worker = new MarketStreamWorker({ client: client as never });
    const processEntries = (worker as unknown as {
      process: (results: { stream: string; entries: [string, string[]][] }[]) => Promise<void>;
    }).process.bind(worker);

    await expect(
      processEntries([{ stream: 'market:trades:v1', entries: [['1001-0', fields]] }]),
    ).rejects.toThrow('QuestDB unavailable');

    expect(questDBWriter.flush).not.toHaveBeenCalled();
    expect(client.acknowledge).not.toHaveBeenCalled();
  });
});