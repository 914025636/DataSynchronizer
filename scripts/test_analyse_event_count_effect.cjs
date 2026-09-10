const test = require('node:test');
const assert = require('node:assert/strict');
const { describe, welch, group } = require('./analyse_event_count_effect.cjs');

test('An empty group reports zero trades without inventing statistics', () => {
  assert.deepEqual(describe('none', []), { group: 'none', trades: 0 });
});

test('Win rate, median and profit factor come from the actual pnl list', () => {
  const result = describe('mixed', [1, -1, 2, -0.5]);
  assert.equal(result.trades, 4);
  assert.equal(result.winRate, 50);
  assert.equal(result.total, 1.5);
  assert.equal(result.profitFactor, 2);
});

test('Profit factor is null when nothing lost, rather than infinite', () => {
  assert.equal(describe('all wins', [1, 2]).profitFactor, null);
});

test('Cost of 0.1 per trade is subtracted from the total', () => {
  assert.equal(describe('costed', [1, 1]).net010, 1.8);
});

test('Grouping keeps every item under its key', () => {
  const map = group([{ n: 1 }, { n: 2 }, { n: 1 }], item => item.n);
  assert.equal(map.get(1).length, 2);
  assert.equal(map.get(2).length, 1);
});

test('Welch needs at least two observations per side', () => {
  assert.equal(welch([1], [2, 3]), null);
});

test('Identical samples give a t statistic of zero', () => {
  assert.equal(welch([1, 2, 3], [1, 2, 3]), 0);
});

test('A clearly higher sample gives a positive t statistic', () => {
  assert(welch([5, 6, 7], [1, 2, 3]) > 2);
});
