import { calculateOrderbookDelta, OrderbookState } from '../exchange/orderbook_delta';

describe('Orderbook delta', () => {
  test('uses the first orderbook as a snapshot', () => {
    const current: OrderbookState = { asks: [[101, 2]], bids: [[100, 3]] };

    expect(calculateOrderbookDelta(undefined, current)).toEqual(current);
  });

  test('returns only changed, added, and removed levels', () => {
    const previous: OrderbookState = {
      asks: [
        [101, 2],
        [102, 5],
      ],
      bids: [[100, 3]],
    };
    const current: OrderbookState = {
      asks: [
        [101, 4],
        [103, 6],
      ],
      bids: [
        [100, 3],
        [99, 7],
      ],
    };

    expect(calculateOrderbookDelta(previous, current)).toEqual({
      asks: [
        [101, 4],
        [103, 6],
        [102, 0],
      ],
      bids: [[99, 7]],
    });
  });
});