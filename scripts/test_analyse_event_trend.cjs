const test = require('node:test');
const assert = require('node:assert/strict');
const { simulate, efficiency } = require('./analyse_event_trend.cjs');

const bar = (second, price, high = price, low = price) => ({ second, open: price, high, low, close: price, volume: 1 });

test('Efficiency is one for a straight move and low for a round trip', () => {
  assert.equal(efficiency([bar(0, 100), bar(1, 101), bar(2, 102)]).toFixed(3), '1.000');
  assert.equal(efficiency([bar(0, 100), bar(1, 105), bar(2, 100)]).toFixed(3), '0.000');
});

test('Take profit is booked when the favourable extreme is reached', () => {
  const after = [bar(0, 100), ...Array.from({ length: 20 }, (_, i) => bar(i + 1, 100.5, i === 10 ? 101.2 : 100.6, 100.4))];
  const trade = simulate(after, 1, 0.3, 0.5, 30);
  assert.equal(trade.side, 1);
  assert.equal(trade.result, 'target');
  assert.equal(trade.pnl, 0.5);
});

test('A second containing both levels is booked as a stop, never as a win', () => {
  const after = [bar(0, 100), bar(1, 100.5), { second: 2, open: 100.5, high: 102, low: 99, close: 101, volume: 1 }];
  const trade = simulate(after, 1, 0.3, 0.5, 30);
  assert.equal(trade.result, 'stop');
  assert.equal(trade.pnl, -0.3);
});

test('Short trades follow a downward impulse and stop on a rally', () => {
  const after = [bar(0, 100), bar(1, 99.4), { second: 2, open: 99.4, high: 99.9, low: 99.3, close: 99.8, volume: 1 }];
  const trade = simulate(after, 1, 0.3, 0.5, 30);
  assert.equal(trade.side, -1);
  assert.equal(trade.result, 'stop');
});

test('An unresolved trade exits at the timeout close, not at the best price seen', () => {
  const after = [bar(0, 100), bar(1, 100.4), bar(2, 100.45), bar(3, 100.42)];
  const trade = simulate(after, 1, 1, 2, 3);
  assert.equal(trade.result, 'timeout');
  assert.equal(trade.pnl.toFixed(4), (((100.42 / 100.4) - 1) * 100).toFixed(4));
});
