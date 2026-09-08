const test = require('node:test');
const assert = require('node:assert/strict');
const { firstSecond } = require('./analyse_first_second_trend.cjs');

const bar = (second, open, close, high = Math.max(open, close), low = Math.min(open, close), volume = 1) => ({ second, open, high, low, close, volume });
const build = after => ({ after, before: Array.from({ length: 1800 }, (_, i) => bar(i - 1800, 100, 100, 100, 100, 1)), base: after[0].open });

test('Signal uses the event second open-to-close move, not the whole window', () => {
  const signal = firstSecond(build([bar(0, 100, 100.4), ...Array.from({ length: 3599 }, (_, i) => bar(i + 1, 100.4, 100.4))]));
  assert.equal(signal.move.toFixed(3), '0.400');
  assert.equal(signal.direction, 1);
});

test('Continuation is measured from the signal close, excluding the signal bar itself', () => {
  const after = [bar(0, 100, 101), ...Array.from({ length: 3599 }, (_, i) => bar(i + 1, 101, 102))];
  const signal = firstSecond(build(after));
  assert.equal(signal.continuation.m5.toFixed(4), (((102 / 101) - 1) * 100).toFixed(4));
});

test('A downward signal treats further falls as favourable', () => {
  const after = [bar(0, 100, 99.5), ...Array.from({ length: 3599 }, (_, i) => bar(i + 1, 99.5, 99, 99.6, 98.9))];
  const signal = firstSecond(build(after));
  assert.equal(signal.direction, -1);
  assert.ok(signal.favourable.m5 > 0, 'A deeper low must count as favourable for a short');
  assert.ok(signal.adverse.m5 > 0, 'A higher high must count as adverse for a short');
});

test('Late entry cost is positive when price runs away during the next second', () => {
  const after = [bar(0, 100, 100.5), bar(1, 100.5, 100.8), ...Array.from({ length: 3598 }, (_, i) => bar(i + 2, 100.8, 100.8))];
  const signal = firstSecond(build(after));
  assert.ok(signal.lateEntryCost < 0, 'Chasing a rising market costs money, so the recorded value must be negative');
});
