const fs = require('fs');
const path = require('path');
const { easternToUtc } = require('./build_us_key_event_schedule.cjs');

// Release dates from the official BLS calendars, Federal Reserve FOMC calendars and BEA archive.
const EMPLOYMENT = [
  '2023-01-06', '2023-02-03', '2023-03-10', '2023-04-07', '2023-05-05', '2023-06-02', '2023-07-07', '2023-08-04', '2023-09-01', '2023-10-06', '2023-11-03', '2023-12-08',
  '2024-01-05', '2024-02-02', '2024-03-08', '2024-04-05', '2024-05-03', '2024-06-07', '2024-07-05', '2024-08-02', '2024-09-06', '2024-10-04', '2024-11-01', '2024-12-06',
  '2025-01-10', '2025-02-07', '2025-03-07', '2025-04-04', '2025-05-02', '2025-06-06', '2025-07-03', '2025-08-01', '2025-09-05', '2025-11-20', '2025-12-16',
  '2026-01-09', '2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05', '2026-07-02', '2026-08-07', '2026-09-04',
];

const CPI = [
  '2023-01-12', '2023-02-14', '2023-03-14', '2023-04-12', '2023-05-10', '2023-06-13', '2023-07-12', '2023-08-10', '2023-09-13', '2023-10-12', '2023-11-14', '2023-12-12',
  '2024-01-11', '2024-02-13', '2024-03-12', '2024-04-10', '2024-05-15', '2024-06-12', '2024-07-11', '2024-08-14', '2024-09-11', '2024-10-10', '2024-11-13', '2024-12-11',
  '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10', '2025-05-13', '2025-06-11', '2025-07-15', '2025-08-12', '2025-09-11', '2025-10-24', '2025-12-18',
  '2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12',
];

const PPI = [
  '2023-01-18', '2023-02-16', '2023-03-15', '2023-04-13', '2023-05-11', '2023-06-14', '2023-07-13', '2023-08-11', '2023-09-14', '2023-10-11', '2023-11-15', '2023-12-13',
  '2024-01-12', '2024-02-16', '2024-03-14', '2024-04-11', '2024-05-14', '2024-06-13', '2024-07-12', '2024-08-13', '2024-09-12', '2024-10-11', '2024-11-14', '2024-12-12',
  '2025-01-14', '2025-02-13', '2025-03-13', '2025-04-11', '2025-05-15', '2025-06-12', '2025-07-16', '2025-08-14', '2025-09-10', '2025-11-25',
  '2026-01-14', '2026-01-30', '2026-02-27', '2026-03-18', '2026-04-14', '2026-05-13', '2026-06-11', '2026-07-15', '2026-08-13',
];

const FOMC = [
  '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01', '2023-12-13',
  '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07', '2024-12-18',
  '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16',
];

const GROUPS = [
  { days: EMPLOYMENT, hour: 8, minute: 30, items: [['Non Farm Payrolls', '非农就业人数'], ['Unemployment Rate', '失业率']], source: 'BLS Employment Situation' },
  { days: CPI, hour: 8, minute: 30, items: [['Inflation Rate YoY', '通胀率同比'], ['Core Inflation Rate YoY', '核心通胀率同比']], source: 'BLS Consumer Price Index' },
  { days: PPI, hour: 8, minute: 30, items: [['PPI MoM', '生产者价格指数环比']], source: 'BLS Producer Price Index' },
  { days: FOMC, hour: 14, minute: 0, items: [['Fed Interest Rate Decision', '美联储利率决议']], source: 'Federal Reserve FOMC calendar' },
];

function build() {
  const rows = [];
  for (const group of GROUPS) {
    for (const day of group.days) {
      const date = easternToUtc(day, group.hour, group.minute);
      for (const [en, zh] of group.items) {
        rows.push({
          event_time_utc: date.toISOString(), event_timestamp_ms: date.getTime(),
          event_time_beijing: new Date(date.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
          event_en: en, event_zh: zh, region: 'United States', importance: '3', source: group.source, note: '',
        });
      }
    }
  }
  rows.sort((a, b) => a.event_timestamp_ms - b.event_timestamp_ms || a.event_en.localeCompare(b.event_en));
  const seen = new Set();
  for (const row of rows) {
    const key = row.event_timestamp_ms + '|' + row.event_en;
    if (seen.has(key)) throw new Error('Duplicate entry: ' + key);
    seen.add(key);
  }
  return rows;
}

if (require.main === module) {
  const rows = build();
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'exports', 'us-high-impact-events-2023-01-to-2026-09.csv');
  const fields = Object.keys(rows[0]);
  const cell = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  fs.writeFileSync(output, '\ufeff' + [fields.join(','), ...rows.map(r => fields.map(f => cell(r[f])).join(','))].join('\r\n') + '\r\n');
  const counts = {};
  for (const row of rows) counts[row.event_zh] = (counts[row.event_zh] || 0) + 1;
  const times = [...new Set(rows.map(r => r.event_timestamp_ms))];
  console.log(JSON.stringify({
    output: path.relative(root, output), rows: rows.length, uniqueReleaseTimes: times.length, counts,
    earliest: rows[0].event_time_utc, latest: rows[rows.length - 1].event_time_utc,
    perYear: rows.reduce((a, r) => { a[r.event_time_utc.slice(0, 4)] = (a[r.event_time_utc.slice(0, 4)] || 0) + 1; return a; }, {}),
  }, null, 2));
}

module.exports = { build, EMPLOYMENT, CPI, PPI, FOMC };
