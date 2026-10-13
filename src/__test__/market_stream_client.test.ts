import { MarketStreamConsumer, MarketStreamProducer } from '../redis/market_stream_client';
import { TradeStreamEvent } from '../redis/market_streams';

jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const trade: TradeStreamEvent = {
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
};

describe('MarketStreamProducer', () => {
  it('does not trim unacknowledged stream entries', async () => {
    const client = {
      info: jest.fn().mockResolvedValue('redis_version:7.2.0\r\n'),
      xadd: jest.fn().mockResolvedValue('1001-0'),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const producer = new MarketStreamProducer(client as never);

    await expect(producer.append('market:trades:v1', trade)).resolves.toBe('1001-0');
    expect(client.xadd).toHaveBeenCalledWith(
      'market:trades:v1',
      '*',
      'payload',
      JSON.stringify(trade),
    );
  });

  it('pipelines an outbox batch and fails it when any XADD fails', async () => {
    const pipeline = { xadd: jest.fn(), exec: jest.fn() };
    pipeline.xadd.mockReturnValue(pipeline);
    const client = {
      info: jest.fn().mockResolvedValue('redis_version:7.2.0\r\n'),
      pipeline: jest.fn(() => pipeline),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const producer = new MarketStreamProducer(client as never);
    const sendBatch = (producer as unknown as {
      sendBatch: (messages: { stream: string; event: TradeStreamEvent }[]) => Promise<void>;
    }).sendBatch.bind(producer);
    const messages = [{ stream: 'market:trades:v1', event: trade }, { stream: 'market:trades:v1', event: { ...trade, tradeId: 'trade-2' } }];

    pipeline.exec.mockResolvedValueOnce([[null, '1-0'], [null, '1-1']]);
    await expect(sendBatch(messages)).resolves.toBeUndefined();
    expect(client.pipeline).toHaveBeenCalledTimes(1);
    expect(pipeline.xadd).toHaveBeenCalledTimes(2);

    pipeline.exec.mockResolvedValueOnce([[null, '2-0'], [new Error('OOM'), null]]);
    await expect(sendBatch(messages)).rejects.toThrow('OOM');
  });
});

describe('MarketStreamConsumer', () => {
  it('ignores an existing consumer group and parses reads', async () => {
    const client = {
      info: jest.fn().mockResolvedValue('redis_version:7.2.0\r\n'),
      xgroup: jest.fn().mockRejectedValue(new Error('BUSYGROUP Consumer Group name already exists')),
      xreadgroup: jest.fn().mockResolvedValue([['market:trades:v1', [['1001-0', ['payload', '{}']]]]]),
      xack: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const consumer = new MarketStreamConsumer(client as never);

    await expect(consumer.ensureGroup('market:trades:v1')).resolves.toBeUndefined();
    await expect(consumer.read(['market:trades:v1'], 'worker-1')).resolves.toEqual([
      { stream: 'market:trades:v1', entries: [['1001-0', ['payload', '{}']]] },
    ]);
    await expect(consumer.acknowledge('market:trades:v1', ['1001-0'])).resolves.toBe(1);
  });

  it('rejects Redis versions without Streams support', async () => {
    const client = {
      info: jest.fn().mockResolvedValue('redis_version:3.0.504\r\n'),
      xadd: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const producer = new MarketStreamProducer(client as never);

    await expect(producer.append('market:trades:v1', trade)).rejects.toThrow('Redis Streams require Redis 5');
    expect(client.xadd).not.toHaveBeenCalled();
  });

  it('trims below the oldest unacknowledged entry across all groups', async () => {
    const client = {
      info: jest.fn().mockResolvedValue('redis_version:7.2.4\r\n'),
      xinfo: jest.fn().mockResolvedValue([
        ['name', 'questdb-writers-v1', 'consumers', 1, 'pending', 0, 'last-delivered-id', '3000-5'],
        ['name', 'audit', 'consumers', 1, 'pending', 2, 'last-delivered-id', '4000-0'],
      ]),
      xpending: jest.fn().mockResolvedValue([2, '2000-1', '4000-0', [['audit-1', '2']]]),
      xtrim: jest.fn().mockResolvedValue(100),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const consumer = new MarketStreamConsumer(client as never);

    await expect(consumer.trimAcknowledged('market:trades:v1')).resolves.toBe(100);
    expect(client.xpending).toHaveBeenCalledWith('market:trades:v1', 'audit');
    expect(client.xtrim).toHaveBeenCalledWith('market:trades:v1', 'MINID', '~', '2000-1');
  });

  it('skips trimming on Redis versions without MINID support', async () => {
    const client = {
      info: jest.fn().mockResolvedValue('redis_version:6.0.16\r\n'),
      xinfo: jest.fn(),
      xtrim: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const consumer = new MarketStreamConsumer(client as never);

    await expect(consumer.trimAcknowledged('market:trades:v1')).resolves.toBe(0);
    expect(client.xtrim).not.toHaveBeenCalled();
  });

  it('claims idle pending entries and reports group health', async () => {
    const client = {
      xpending: jest
        .fn()
        .mockResolvedValueOnce([['1000-0', 'worker-old', 40000, 1]])
        .mockResolvedValueOnce([['1000-0', 'worker-old', 40000, 1]]),
      xclaim: jest.fn().mockResolvedValue([['1000-0', ['payload', '{}']]]),
      xinfo: jest
        .fn()
        .mockResolvedValue([['name', 'questdb-writers-v1', 'consumers', 1, 'pending', 1, 'last-delivered-id', '1000-0', 'lag', 2]]),
      xrange: jest.fn().mockResolvedValue([['1001-0', ['payload', '{}']]]),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    const consumer = new MarketStreamConsumer(client as never);

    await expect(consumer.claimPending('market:trades:v1', 'worker-1', 30000)).resolves.toEqual([
      ['1000-0', ['payload', '{}']],
    ]);
    await expect(consumer.groupHealth('market:trades:v1')).resolves.toEqual({
      pending: 1,
      lag: 2,
      oldestPendingId: '1000-0',
      oldestUndeliveredId: '1001-0',
    });
  });
});