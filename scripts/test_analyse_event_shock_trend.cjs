const test = require('node:test');
const assert = require('node:assert/strict');
const { baseline, findShock, trade } = require('./analyse_event_shock_trend.cjs');

const quiet = (count, price = 100, volume = 1) => Array.from({ length: count }, (_, i) => ({
  second: i - count, open: price, high: price, low: price, close: price, volume,
}));

// A pre-event stretch with tiny alternating ticks gives a small but non-zero sigma.
function noisyBefore(count = 1800) {
  return Array.from({ length: count }, (_, i) => {
    const price = 100 + (i % 2 ? 0.01 : 0);
    return { second: i - count, open: price, high: price, low: price, close: price, volume: 1 };
  });
}

const after = candles => candles.map((c, i) => ({ second: i, ...c }));

test('Baseline measures per-second volume, tick sigma and how often the book trades', () => {
  const stats = baseline([
    { close: 100, volume: 0 }, { close: 101, volume: 2 }, { close: 100, volume: 0 }, { close: 101, volume: 6 },
  ]);
  assert.equal(stats.volumePerSecond, 2);
  assert.equal(stats.activeRatio, 0.5);
  assert(stats.sigma > 0);
});

test('No shock is reported when volume surges but price does not move', () => {
  const row = { before: noisyBefore(), after: after(Array.from({ length: 300 }, () => ({ open: 100, high: 100, low: 100, close: 100, volume: 50 }))) };
  row.baseline = baseline(row.before);
  assert.equal(findShock(row, 5, 3), null);
});

test('No shock is reported when price moves but volume stays normal', () => {
  const row = { before: noisyBefore(), after: after(Array.from({ length: 300 }, (_, i) => { const p = 100 + i * 0.05; return { open: p, high: p, low: p, close: p, volume: 1 }; })) };
  row.baseline = baseline(row.before);
  assert.equal(findShock(row, 5, 3), null);
});

test('Shock fires on the first second that clears both bars, and records the side', () => {
  const candles = Array.from({ length: 300 }, () => ({ open: 100, high: 100, low: 100, close: 100, volume: 1 }));
  candles[3] = { open: 100, high: 101, low: 100, close: 101, volume: 500 };
  const row = { before: noisyBefore(), after: after(candles) };
  row.baseline = baseline(row.before);
  const shock = findShock(row, 5, 3);
  assert.equal(shock.second, 3);
  assert.equal(shock.side, 1);
  assert.equal(shock.entry, 101);
  assert(shock.shockRange > 0);
});

test('A downward shock is detected with a short side', () => {
  const candles = Array.from({ length: 300 }, () => ({ open: 100, high: 100, low: 100, close: 100, volume: 1 }));
  candles[2] = { open: 100, high: 100, low: 98, close: 98, volume: 500 };
  const row = { before: noisyBefore(), after: after(candles) };
  row.baseline = baseline(row.before);
  assert.equal(findShock(row, 5, 3).side, -1);
});

// A drift that never clears the sqrt(elapsed) barrier must not be mistaken for a shock.
test('Slow drift on heavy volume never triggers because the barrier widens with time', () => {
  const row = { before: noisyBefore(), after: after(Array.from({ length: 300 }, (_, i) => { const p = 100 + i * 0.002; return { open: p, high: p, low: p, close: p, volume: 50 }; })) };
  row.baseline = baseline(row.before);
  const shock = findShock(row, 5, 30);
  assert.equal(shock, null);
});

test('The trailing stop exits at the ratcheted level, not at the entry stop', () => {
  const shock = { second: 0, entry: 100, side: 1, shockRange: 1 };
  const candles = [
    { second: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { second: 1, open: 100, high: 110, low: 100, close: 110, volume: 1 },
    { second: 2, open: 110, high: 110, low: 100, close: 100, volume: 1 },
  ];
  const result = trade({ after: candles }, shock, { trailMultiple: 1, stopFloor: 0.1, maxHoldSeconds: 10 });
  assert.equal(result.result, 'trail');
  assert.equal(result.exitSecond, 2);
  assert(result.pnl > 8, 'Profit is locked in above entry, got ' + result.pnl);
});

test('A short exits on the trailing stop above the running low', () => {
  const shock = { second: 0, entry: 100, side: -1, shockRange: 1 };
  const candles = [
    { second: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { second: 1, open: 100, high: 100, low: 90, close: 90, volume: 1 },
    { second: 2, open: 90, high: 100, low: 90, close: 100, volume: 1 },
  ];
  const result = trade({ after: candles }, shock, { trailMultiple: 1, stopFloor: 0.1, maxHoldSeconds: 10 });
  assert.equal(result.result, 'trail');
  assert(result.pnl > 8, 'Short profit is locked in, got ' + result.pnl);
});

test('Holding to the cap exits at the last close', () => {
  const shock = { second: 0, entry: 100, side: 1, shockRange: 1 };
  const candles = Array.from({ length: 20 }, (_, i) => ({ second: i, open: 100 + i, high: 100 + i, low: 100 + i, close: 100 + i, volume: 1 }));
  const result = trade({ after: candles }, shock, { trailMultiple: 5, stopFloor: 0.1, maxHoldSeconds: 5 });
  assert.equal(result.result, 'timeout');
  assert.equal(result.exitSecond, 5);
});

test('The stop floor applies when the shock range is negligible', () => {
  const shock = { second: 0, entry: 100, side: 1, shockRange: 0 };
  const candles = [
    { second: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { second: 1, open: 100, high: 100, low: 99.8, close: 99.8, volume: 1 },
  ];
  const result = trade({ after: candles }, shock, { trailMultiple: 1, stopFloor: 0.1, maxHoldSeconds: 10 });
  assert.equal(result.distance, 0.1);
  assert.equal(result.result, 'trail');
});
