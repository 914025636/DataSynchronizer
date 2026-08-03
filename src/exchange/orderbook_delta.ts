import { Order } from 'orderbook-synchronizer/lib/types';

export interface OrderbookState {
  asks: Order[];
  bids: Order[];
}

export interface IndexedOrderbookState {
  asks: Map<number, number>;
  bids: Map<number, number>;
}

const indexSide = (orders: Order[]): Map<number, number> =>
  new Map(orders.map((level) => [Number(level[0]), Number(level[1])]));

const diffSide = (previousLevels: Map<number, number>, current: Order[]): [Order[], Map<number, number>] => {
  const currentLevels = new Map(current.map((level) => [Number(level[0]), Number(level[1])]));
  const delta: Order[] = [];

  currentLevels.forEach((quantity, price) => {
    if (previousLevels.get(price) !== quantity) {
      delta.push([price, quantity]);
    }
  });

  previousLevels.forEach((_, price) => {
    if (!currentLevels.has(price)) {
      delta.push([price, 0]);
    }
  });

  return [delta, currentLevels];
};

export const indexOrderbook = (orderbook: OrderbookState): IndexedOrderbookState => ({
  asks: indexSide(orderbook.asks),
  bids: indexSide(orderbook.bids),
});

export const calculateIndexedOrderbookDelta = (
  previous: IndexedOrderbookState | undefined,
  current: OrderbookState,
): { delta: OrderbookState; indexed: IndexedOrderbookState } => {
  if (!previous) {
    return { delta: current, indexed: indexOrderbook(current) };
  }

  const [asks, indexedAsks] = diffSide(previous.asks, current.asks);
  const [bids, indexedBids] = diffSide(previous.bids, current.bids);

  return {
    delta: { asks, bids },
    indexed: { asks: indexedAsks, bids: indexedBids },
  };
};

export const calculateOrderbookDelta = (
  previous: OrderbookState | undefined,
  current: OrderbookState,
): OrderbookState => {
  return calculateIndexedOrderbookDelta(previous ? indexOrderbook(previous) : undefined, current).delta;
};