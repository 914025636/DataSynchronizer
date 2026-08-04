import {
  createLayeredOrderbook,
  diffLayeredOrderbook,
  LayeredOrderbookConfig,
} from '../exchange/layered_orderbook';

const config: LayeredOrderbookConfig = {
  exactDepth: 2,
  tickSize: 1,
  referencePrice: 100,
  aggregationTickSteps: [10, 20, 40, 80],
};

describe('layered orderbook persistence', () => {
  it('keeps the near book exact and aggregates remote levels into stable price buckets', () => {
    const result = createLayeredOrderbook(
      {
        asks: [
          [101, 1],
          [102, 2],
          [111, 3],
          [119, 4],
          [145, 5],
        ],
        bids: [
          [99, 1],
          [98, 2],
          [91, 3],
          [89, 4],
        ],
      },
      config,
    );

    expect(result.exactAsks).toEqual([
      [101, 1],
      [102, 2],
    ]);
    expect(result.aggregateAsks).toEqual([
      [110, 120, 7],
      [140, 160, 5],
    ]);
    expect(result.aggregateBids).toEqual([
      [80, 90, 4],
      [90, 100, 3],
    ]);
  });

  it('emits only net changes and zeroes removed exact levels and buckets', () => {
    const previous = createLayeredOrderbook(
      { asks: [[101, 1], [102, 2], [111, 3]], bids: [[99, 1], [98, 2], [91, 3]] },
      config,
    );
    const current = createLayeredOrderbook(
      { asks: [[101, 5], [103, 2], [121, 4]], bids: [[99, 1], [98, 2]] },
      config,
    );

    expect(diffLayeredOrderbook(previous, current)).toEqual({
      exactAsks: [[101, 5], [103, 2], [102, 0]],
      exactBids: [],
      aggregateAsks: [[120, 140, 4], [110, 120, 0]],
      aggregateBids: [[90, 100, 0]],
    });
  });
});