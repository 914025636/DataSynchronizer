export const MARKET_STREAM_SCHEMA_VERSION = 1;
export const ORDERBOOK_STREAM_SCHEMA_VERSION = 3;

export const MARKET_STREAMS = {
  trades: process.env.REDIS_TRADE_STREAM || 'market:trades:v1',
  orderbook: process.env.REDIS_ORDERBOOK_STREAM || 'market:orderbook:v3',
};

export type TradeStreamEvent = {
  schemaVersion: 1;
  eventType: 'trade';
  exchange: string;
  symbol: string;
  eventTime: number;
  ingestedAt: number;
  side: string;
  price: string;
  quantity: string;
  tradeId: string;
};

export type OrderbookStreamEvent = {
  schemaVersion: 3;
  eventType: 'orderbook';
  exchange: string;
  symbol: string;
  eventTime: number;
  ingestedAt: number;
  asks: [number, number][];
  bids: [number, number][];
  sequence?: number;
  updateType: 'snapshot' | 'delta';
  sourceUpdateCount: number;
};

export type MarketStreamEvent = TradeStreamEvent | OrderbookStreamEvent;

export type RedisStreamEntry = [string, string[]];

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPriceLevel(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isNumber(value[0]) && isNumber(value[1]);
}

function hasCommonFields(value: { [key: string]: unknown }): boolean {
  return (
    typeof value.exchange === 'string' &&
    typeof value.symbol === 'string' &&
    isNumber(value.eventTime) &&
    isNumber(value.ingestedAt)
  );
}

export function serializeMarketEvent(event: MarketStreamEvent): string[] {
  return ['payload', JSON.stringify(event)];
}

export function parseMarketEvent(fields: string[]): MarketStreamEvent {
  const payloadIndex = fields.indexOf('payload');
  if (payloadIndex < 0 || payloadIndex + 1 >= fields.length) {
    throw new Error('Redis stream entry is missing payload');
  }

  const value: unknown = JSON.parse(fields[payloadIndex + 1]);
  if (!value || typeof value !== 'object') throw new Error('Redis stream payload must be an object');

  const event = value as { [key: string]: unknown };
  if (!hasCommonFields(event)) throw new Error('Redis stream payload has invalid common fields');

  if (
    event.eventType === 'trade' &&
    event.schemaVersion === MARKET_STREAM_SCHEMA_VERSION &&
    typeof event.side === 'string' &&
    typeof event.price === 'string' &&
    typeof event.quantity === 'string' &&
    typeof event.tradeId === 'string'
  ) {
    return event as TradeStreamEvent;
  }

  if (
    event.eventType === 'orderbook' &&
    event.schemaVersion === ORDERBOOK_STREAM_SCHEMA_VERSION &&
    Array.isArray(event.asks) &&
    event.asks.every(isPriceLevel) &&
    Array.isArray(event.bids) &&
    event.bids.every(isPriceLevel) &&
    (event.sequence === undefined || isNumber(event.sequence)) &&
    (event.updateType === 'snapshot' || event.updateType === 'delta') &&
    isNumber(event.sourceUpdateCount)
  ) {
    return event as OrderbookStreamEvent;
  }

  throw new Error('Redis stream payload has invalid event fields');
}
