import { Order } from 'orderbook-synchronizer/lib/types';
import { OrderbookState } from './orderbook_delta';

export type AggregatedLevel = [number, number, number];

export type LayeredOrderbook = {
  exactAsks: Order[];
  exactBids: Order[];
  aggregateAsks: AggregatedLevel[];
  aggregateBids: AggregatedLevel[];
};

export type LayeredOrderbookDelta = LayeredOrderbook;

export type LayeredOrderbookConfig = {
  exactDepth: number;
  tickSize: number;
  referencePrice: number;
  aggregationTickSteps: number[];
};

const roundPrice = (value: number): number => Number(value.toPrecision(15));

const aggregateSide = (orders: Order[], config: LayeredOrderbookConfig): AggregatedLevel[] => {
  const buckets = new Map<string, AggregatedLevel>();
  const bandSpanTicks = Math.max(1, config.exactDepth);

  orders.slice(config.exactDepth).forEach(([rawPrice, rawQuantity]) => {
    const price = Number(rawPrice);
    const quantity = Number(rawQuantity);
    const distanceTicks = Math.abs(price - config.referencePrice) / config.tickSize;
    let remainingTicks = distanceTicks;
    let widthTicks = config.aggregationTickSteps[config.aggregationTickSteps.length - 1];

    for (const candidate of config.aggregationTickSteps) {
      widthTicks = candidate;
      const bandWidth = candidate * bandSpanTicks;
      if (remainingTicks <= bandWidth) break;
      remainingTicks -= bandWidth;
    }

    const bucketWidth = widthTicks * config.tickSize;
    const bucketStart = roundPrice(Math.floor(price / bucketWidth) * bucketWidth);
    const bucketEnd = roundPrice(bucketStart + bucketWidth);
    const key = `${bucketStart}:${bucketEnd}`;
    const existing = buckets.get(key);

    if (existing) existing[2] += quantity;
    else buckets.set(key, [bucketStart, bucketEnd, quantity]);
  });

  return Array.from(buckets.values())
    .map(([start, end, quantity]) => [start, end, Number(quantity.toPrecision(15))] as AggregatedLevel)
    .sort((left, right) => left[0] - right[0]);
};

export const createLayeredOrderbook = (
  orderbook: OrderbookState,
  config: LayeredOrderbookConfig,
): LayeredOrderbook => ({
  exactAsks: orderbook.asks.slice(0, config.exactDepth),
  exactBids: orderbook.bids.slice(0, config.exactDepth),
  aggregateAsks: aggregateSide(orderbook.asks, config),
  aggregateBids: aggregateSide(orderbook.bids, config),
});

const diffExact = (previous: Order[], current: Order[]): Order[] => {
  const previousMap = new Map(previous.map(([price, quantity]) => [Number(price), Number(quantity)]));
  const currentMap = new Map(current.map(([price, quantity]) => [Number(price), Number(quantity)]));
  const delta: Order[] = [];

  currentMap.forEach((quantity, price) => {
    if (previousMap.get(price) !== quantity) delta.push([price, quantity]);
  });
  previousMap.forEach((_, price) => {
    if (!currentMap.has(price)) delta.push([price, 0]);
  });
  return delta;
};

const diffAggregated = (previous: AggregatedLevel[], current: AggregatedLevel[]): AggregatedLevel[] => {
  const key = ([start, end]: AggregatedLevel): string => `${start}:${end}`;
  const previousMap = new Map(previous.map((level) => [key(level), level]));
  const currentMap = new Map(current.map((level) => [key(level), level]));
  const delta: AggregatedLevel[] = [];

  currentMap.forEach((level, bucket) => {
    if (previousMap.get(bucket)?.[2] !== level[2]) delta.push(level);
  });
  previousMap.forEach(([start, end], bucket) => {
    if (!currentMap.has(bucket)) delta.push([start, end, 0]);
  });
  return delta;
};

export const diffLayeredOrderbook = (
  previous: LayeredOrderbook | undefined,
  current: LayeredOrderbook,
): LayeredOrderbookDelta => {
  if (!previous) return current;
  return {
    exactAsks: diffExact(previous.exactAsks, current.exactAsks),
    exactBids: diffExact(previous.exactBids, current.exactBids),
    aggregateAsks: diffAggregated(previous.aggregateAsks, current.aggregateAsks),
    aggregateBids: diffAggregated(previous.aggregateBids, current.aggregateBids),
  };
};

export const hasLayeredChanges = (delta: LayeredOrderbookDelta): boolean =>
  delta.exactAsks.length > 0 ||
  delta.exactBids.length > 0 ||
  delta.aggregateAsks.length > 0 ||
  delta.aggregateBids.length > 0;