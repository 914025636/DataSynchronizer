const test = require('node:test');
const assert = require('node:assert/strict');
const { summarise, bootstrapMean, concentration, directionAgreement } = require('./analyse_event_family_effect.cjs');

test('An empty family reports zero trades without inventing statistics', () => {
  assert.deepEqual(summarise([]), { trades: 0 });
});

test('Summary reflects the actual pnl list', () => {
  const result = summarise([1, -1, 2, -0.5]);
  assert.equal(result.winRate, 50);
  assert.equal(result.total, 1.5);
  assert.equal(result.profitFactor, 2);
  assert.equal(result.worst, -1);
});

test('Bootstrap needs at least three trades', () => {
  assert.equal(bootstrapMean([1, 2]), null);
});

test('A consistently positive family has a confidence interval entirely above zero', () => {
  const result = bootstrapMean(Array.from({ length: 30 }, () => 0.5));
  assert.equal(result.low, 0.5);
  assert.equal(result.positiveShare, 100);
});

test('A family carried by one outlier has an interval spanning zero', () => {
  const result = bootstrapMean([10, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1]);
  assert(result.low < 0, 'Lower bound should admit a losing mean, got ' + result.low);
  assert(result.high > 0);
});

test('Bootstrap is deterministic for the same input', () => {
  const pnls = [1, -0.5, 0.3, 2, -1];
  assert.deepEqual(bootstrapMean(pnls), bootstrapMean(pnls));
});

test('Concentration exposes reliance on the single best trade', () => {
  const result = concentration([10, 0, 0, 0]);
  assert.equal(result.topTradeShare, 100);
  assert.equal(result.averageExclTop, 0);
});

test('Concentration is null when the family nets exactly zero', () => {
  assert.equal(concentration([1, -1]), null);
});

test('Direction agreement counts only trades with enough remaining candles', () => {
  const after = Array.from({ length: 100 }, (_, i) => ({ second: i, close: 100 + i }));
  const items = [
    { row: { after }, index: 0, shock: { entry: 100, side: 1 } },
    { row: { after }, index: 95, shock: { entry: 100, side: 1 } },
  ];
  assert.equal(directionAgreement(items, 60), 100);
  assert.equal(directionAgreement(items, 200), null);
});

test('A reversed move counts against the shock side', () => {
  const after = Array.from({ length: 100 }, (_, i) => ({ second: i, close: 100 - i }));
  const items = [{ row: { after }, index: 0, shock: { entry: 100, side: 1 } }];
  assert.equal(directionAgreement(items, 60), 0);
});
