import {
  MARKET_STREAM_SCHEMA_VERSION,
  ORDERBOOK_STREAM_SCHEMA_VERSION,
  OrderbookStreamEvent,
  parseMarketEvent,
  serializeMarketEvent,
  TradeStreamEvent,
} from '../redis/market_streams';

describe('market stream event contract', () => {
  it('round-trips a trade event', () => {
    const event: TradeStreamEvent = {
      schemaVersion: MARKET_STREAM_SCHEMA_VERSION,
      eventType: 'trade',
      exchange: 'binance',
      symbol: 'BTC/USDT',
      eventTime: 1000,
      ingestedAt: 1001,
      side: 'buy',
      price: '100',
      quantity: '2',
      tradeId: 'trade-1',
    };

    expect(parseMarketEvent(serializeMarketEvent(event))).toEqual(event);
  });

  it('round-trips an orderbook event', () => {
    const event: OrderbookStreamEvent = {
      schemaVersion: ORDERBOOK_STREAM_SCHEMA_VERSION,
      eventType: 'orderbook',
      exchange: 'okx',
      symbol: 'BTC/USDT:USDT',
      eventTime: 2000,
      ingestedAt: 2001,
      exactAsks: [[101, 3]],
      exactBids: [[99, 4]],
      aggregateAsks: [[110, 120, 8]],
      aggregateBids: [[80, 90, 7]],
      sequence: 12,
      updateType: 'second_delta',
      exactDepth: 100,
      tickSize: 0.1,
      referencePrice: 100,
      aggregationVersion: 1,
      sourceUpdateCount: 42,
    };

    expect(parseMarketEvent(serializeMarketEvent(event))).toEqual(event);
  });

  it('rejects malformed stream entries', () => {
    expect(() => parseMarketEvent(['other', '{}'])).toThrow('missing payload');
    expect(() => parseMarketEvent(['payload', '{"eventType":"trade"}'])).toThrow('invalid common fields');
  });
});