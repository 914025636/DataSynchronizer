const test = require('node:test');
const assert = require('node:assert/strict');
const { signal, trade } = require('./analyse_second2_entry.cjs');

const bar = (second, open, close, high = Math.max(open, close), low = Math.min(open, close), volume = 1) => ({ second, open, high, low, close, volume });
const build = after => ({ after, before: Array.from({ length: 1800 }, (_, i) => bar(i - 1800, 100, 100, 100, 100, 1)) });

test('Signal reads the move from the event open to the second-2 close only', () => {
  const s = signal(build([bar(0, 100, 100.1), bar(1, 100.1, 100.4), bar(2, 100.4, 105)]));
  assert.equal(s.base, 100);
  assert.equal(s.entry, 100.4);
  assert.equal(s.move.toFixed(3), '0.400');
  assert.equal(s.side, 1, 'Later bars must not influence the signal');
});

test('Entry price is the second-2 close, and profit is measured from there', () => {
  const after = [bar(0, 100, 100.2), bar(1, 100.2, 100.5), ...Array.from({ length: 3598 }, (_, i) => bar(i + 2, 100.5, 100.5, 101.6, 100.4))];
  const t = trade(build(after), 0.5, 1.0, 1800);
  assert.equal(t.result, 'target');
  assert.equal(t.exitSecond, 2, 'The first eligible second after entry must close the trade');
});

test('A second holding both levels is booked as a stop, never as a win', () => {
  const after = [bar(0, 100, 100.3), bar(1, 100.3, 100.6), { second: 2, open: 100.6, high: 102, low: 99, close: 101, volume: 1 }];
  assert.equal(trade(build(after), 0.5, 1.0, 1800).result, 'stop');
});

test('A downward second-2 move opens a short and stops out on a rally', () => {
  const after = [bar(0, 100, 99.8), bar(1, 99.8, 99.4), { second: 2, open: 99.4, high: 100, low: 99.3, close: 99.9, volume: 1 }];
  const t = trade(build(after), 0.5, 1.0, 1800);
  assert.equal(t.side, -1);
  assert.equal(t.result, 'stop');
});

test('Second 2 itself is never used as an exit before entry is established', () => {
  const after = [bar(0, 100, 100.4), { second: 1, open: 100.4, high: 108, low: 92, close: 100.4, volume: 1 }, bar(2, 100.4, 100.4)];
  const t = trade(build(after), 0.5, 1.0, 1800);
  assert.equal(t.result, 'timeout', 'The wild second-1 bar precedes entry and must be ignored');
});

test('An unresolved trade exits at the timeout close, not the best price seen', () => {
  const after = [bar(0, 100, 100.3), bar(1, 100.3, 100.6), bar(2, 100.6, 100.7), bar(3, 100.7, 100.65)];
  const t = trade(build(after), 2, 3, 3);
  assert.equal(t.result, 'timeout');
  assert.equal(t.pnl.toFixed(4), (((100.65 / 100.6) - 1) * 100).toFixed(4));
});
