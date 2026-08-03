jest.mock('../questdb', () => ({
  QuestDBWriter: {
    writeTrade: jest.fn(),
    writeOrderbookDelta: jest.fn(),
    flush: jest.fn(),
    close: jest.fn(),
  },
}));

jest.mock('../logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { MarketStreamWorker } from '../workers/market_stream_worker';

describe('MarketStreamWorker backlog alerts', () => {
  const logger = require('../logger').logger as { warn: jest.Mock; error: jest.Mock; info: jest.Mock };

  beforeEach(() => jest.clearAllMocks());

  it('logs warning, critical and recovered transitions', async () => {
    const client = {
      ensureGroup: jest.fn().mockResolvedValue(undefined),
      groupHealth: jest
        .fn()
        .mockResolvedValueOnce({ lag: 12000, pending: 1, oldestPendingId: `${Date.now() - 40000}-0` })
        .mockResolvedValueOnce({ lag: 60000, pending: 2, oldestPendingId: `${Date.now() - 130000}-0` })
        .mockResolvedValueOnce({ lag: 0, pending: 0 }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const worker = new MarketStreamWorker({ client: client as never, streams: ['market:test:v1'] });
    const check = (worker as unknown as { checkBacklog: () => Promise<void> }).checkBacklog.bind(worker);

    await check();
    await check();
    await check();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('lag=12000'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('lag=60000'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('recovered'));
  });
});