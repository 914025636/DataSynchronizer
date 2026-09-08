const test = require('node:test');
const assert = require('node:assert/strict');
const { analyse } = require('./report_event_volatility.cjs');

const flat = (second, price) => ({ second, open: price, high: price, low: price, close: price, volume: 1 });
function window(after) {
  const before = Array.from({ length: 1800 }, (_, i) => flat(i - 1800, 100));
  return [...before, ...after];
}

test('Amplitude and ratio compare the post-event window against the calm pre-event window', () => {
  const after = Array.from({ length: 3600 }, (_, i) => flat(i, i === 5 ? 110 : 100));
  const result = analyse(window(after));
  assert.equal(result.eventPrice, 100);
  assert.equal(result.afterRange.toFixed(2), '10.00');
  assert.equal(result.beforeRange.toFixed(2), '0.00');
  assert.equal(result.rangeRatio, null, 'A flat pre-event window must not produce a divide-by-zero ratio');
});

test('Maximum impact keeps the larger absolute move and its direction', () => {
  const after = Array.from({ length: 3600 }, (_, i) => {
    if (i === 10) return { second: i, open: 100, high: 103, low: 100, close: 103, volume: 2 };
    if (i === 20) return { second: i, open: 100, high: 100, low: 94, close: 94, volume: 3 };
    return flat(i, 100);
  });
  const result = analyse(window(after));
  assert.equal(result.maxUp.toFixed(2), '3.00');
  assert.equal(result.maxDown.toFixed(2), '-6.00');
  assert.equal(result.maxMove.toFixed(2), '-6.00');
  assert.equal(result.maxDownSecond, 20);
});

test('Horizon changes read the final second of each interval', () => {
  const after = Array.from({ length: 3600 }, (_, i) => flat(i, 100 + i / 100));
  const result = analyse(window(after));
  assert.equal(result.changes[10].toFixed(4), (((100 + 9 / 100) / 100 - 1) * 100).toFixed(4));
  assert.equal(result.changes[3600].toFixed(4), (((100 + 3599 / 100) / 100 - 1) * 100).toFixed(4));
});

test('Volume is split at the event second, not shared between windows', () => {
  const after = Array.from({ length: 3600 }, (_, i) => ({ ...flat(i, 100), volume: 2 }));
  const result = analyse(window(after));
  assert.equal(result.beforeVolume, 1800);
  assert.equal(result.afterVolume, 7200);
});

test('Reject a window without post-event candles instead of reporting zero volatility', () => {
  assert.throws(() => analyse(window([])));
});
