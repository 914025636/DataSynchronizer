const test = require('node:test');
const assert = require('node:assert/strict');
const { easternToUtc, easternOffsetHours } = require('./build_us_key_event_schedule.cjs');

test('Winter releases at 08:30 Eastern map to 13:30 UTC', () => {
  assert.equal(easternToUtc('2025-01-10', 8, 30).toISOString(), '2025-01-10T13:30:00.000Z');
  assert.equal(easternToUtc('2025-12-16', 8, 30).toISOString(), '2025-12-16T13:30:00.000Z');
});

test('Summer releases at 08:30 Eastern map to 12:30 UTC', () => {
  assert.equal(easternToUtc('2025-07-03', 8, 30).toISOString(), '2025-07-03T12:30:00.000Z');
  assert.equal(easternToUtc('2026-09-04', 8, 30).toISOString(), '2026-09-04T12:30:00.000Z');
});

test('Daylight saving starts on the second Sunday of March and ends on the first Sunday of November', () => {
  assert.equal(easternOffsetHours(2025, 3, 8), 5);
  assert.equal(easternOffsetHours(2025, 3, 9), 4);
  assert.equal(easternOffsetHours(2025, 11, 1), 4);
  assert.equal(easternOffsetHours(2025, 11, 2), 5);
  assert.equal(easternOffsetHours(2026, 3, 7), 5);
  assert.equal(easternOffsetHours(2026, 3, 8), 4);
});

test('FOMC statements at 14:00 Eastern land at 18:00 UTC in summer and 19:00 UTC in winter', () => {
  assert.equal(easternToUtc('2025-07-30', 14, 0).toISOString(), '2025-07-30T18:00:00.000Z');
  assert.equal(easternToUtc('2025-12-10', 14, 0).toISOString(), '2025-12-10T19:00:00.000Z');
});

test('Generated times match the real OKX calendar records already collected', () => {
  assert.equal(easternToUtc('2026-09-04', 8, 30).getTime(), 1788525000000);
  assert.equal(easternToUtc('2026-08-12', 8, 30).getTime(), 1786537800000);
  assert.equal(easternToUtc('2026-07-29', 14, 0).getTime(), 1785348000000);
});

test('2024 dates resolve with the correct seasonal offset', () => {
  assert.equal(easternToUtc('2024-01-05', 8, 30).toISOString(), '2024-01-05T13:30:00.000Z');
  assert.equal(easternToUtc('2024-06-07', 8, 30).toISOString(), '2024-06-07T12:30:00.000Z');
  assert.equal(easternToUtc('2024-03-20', 14, 0).toISOString(), '2024-03-20T18:00:00.000Z');
  assert.equal(easternToUtc('2024-12-18', 14, 0).toISOString(), '2024-12-18T19:00:00.000Z');
});
