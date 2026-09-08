const test = require('node:test');
const assert = require('node:assert/strict');
const { build, EMPLOYMENT, CPI, PPI, FOMC } = require('./build_expanded_event_schedule.cjs');

const rows = build();

test('Every release date is unique within its own series', () => {
  for (const [name, days] of [['employment', EMPLOYMENT], ['cpi', CPI], ['ppi', PPI], ['fomc', FOMC]]) {
    assert.equal(new Set(days).size, days.length, name + ' contains a duplicate date');
  }
});

test('Dates are chronological and stay inside the requested span', () => {
  for (const days of [EMPLOYMENT, CPI, PPI, FOMC]) {
    assert.deepEqual(days, [...days].sort(), 'dates must be listed in order');
    assert.ok(days[0] >= '2023-01-01' && days[days.length - 1] <= '2026-09-30');
  }
});

test('Combined releases share one timestamp so they collapse into a single window', () => {
  const employmentRows = rows.filter(r => r.source === 'BLS Employment Situation');
  const times = new Set(employmentRows.map(r => r.event_timestamp_ms));
  assert.equal(employmentRows.length, EMPLOYMENT.length * 2);
  assert.equal(times.size, EMPLOYMENT.length);
});

test('Beijing time column matches the UTC timestamp', () => {
  for (const row of rows.slice(0, 40)) {
    const expected = new Date(row.event_timestamp_ms + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    assert.equal(row.event_time_beijing, expected);
  }
});

test('Known releases resolve to the timestamps already verified against OKX data', () => {
  const find = (iso, en) => rows.find(r => r.event_time_utc === iso && r.event_en === en);
  assert.ok(find('2026-09-04T12:30:00.000Z', 'Non Farm Payrolls'));
  assert.ok(find('2026-08-12T12:30:00.000Z', 'Inflation Rate YoY'));
  assert.ok(find('2026-07-29T18:00:00.000Z', 'Fed Interest Rate Decision'));
  assert.ok(find('2026-07-15T12:30:00.000Z', 'PPI MoM'));
});
