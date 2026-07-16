import { Order } from 'orderbook-synchronizer/lib/types';

export interface OrderbookState {
  asks: Order[];
  bids: Order[];
}

const diffSide = (previous: Order[], current: Order[]): Order[] => {
  const previousLevels = new Map(previous.map((level) => [Number(level[0]), Number(level[1])]));
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

  return delta;
};

export const calculateOrderbookDelta = (
  previous: OrderbookState | undefined,
  current: OrderbookState,
): OrderbookState => {
  if (!previous) {
    return current;
  }

  return {
    asks: diffSide(previous.asks, current.asks),
    bids: diffSide(previous.bids, current.bids),
  };
};