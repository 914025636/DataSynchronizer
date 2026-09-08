const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

// Eastern Time offset: DST runs from the second Sunday of March to the first Sunday of November.
function easternOffsetHours(year, month, day) {
  const nth = (weekday, n) => {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  };
  if (month > 3 && month < 11) return 4;
  if (month === 3) return day >= nth(0, 2) ? 4 : 5;
  if (month === 11) return day >= nth(0, 1) ? 5 : 4;
  return 5;
}

function easternToUtc(dateText, hour, minute) {
  const [year, month, day] = dateText.split('-').map(Number);
  const iso = new Date(Date.UTC(year, month - 1, day, hour + easternOffsetHours(year, month, day), minute));
  if (Number.isNaN(iso.getTime())) throw new Error('Invalid Eastern date: ' + dateText);
  return iso;
}

// BLS Employment Situation and CPI releases, from the official release calendars at bls.gov.
const BLS = {
  employment: ['2025-01-10', '2025-02-07', '2025-03-07', '2025-04-04', '2025-05-02', '2025-06-06', '2025-07-03', '2025-08-01', '2025-09-05', '2025-11-20', '2025-12-16',
    '2026-01-09', '2026-02-11', '2026-03-06', '2026-04-03', '2026-05-08', '2026-06-05', '2026-07-02', '2026-08-07', '2026-09-04'],
  cpi: ['2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10', '2025-05-13', '2025-06-11', '2025-07-15', '2025-08-12', '2025-09-11', '2025-10-24', '2025-12-18',
    '2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10', '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12'],
};

// FOMC statement days, from federalreserve.gov meeting calendars. Statements are released at 14:00 Eastern.
const FOMC = ['2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29', '2025-12-10',
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16'];

// BEA GDP third-estimate dates, taken from the published release titles rather than inferred,
// because the 2025 government shutdown pushed several releases outside their usual quarter.
const GDP_FINAL = [
  ['2025-03-27', '2024 Q4'], ['2025-06-26', '2025 Q1'], ['2025-09-25', '2025 Q2'],
  ['2026-01-22', '2025 Q3'], ['2026-04-09', '2025 Q4'], ['2026-06-25', '2026 Q1'], ['2026-09-30', '2026 Q2'],
];

function verifyGdpAgainstBea(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const published = new Set((data['Gross Domestic Product'] || {}).release_dates?.map(iso => new Date(iso).toISOString().slice(0, 10)) || []);
  if (!published.size) throw new Error('Unexpected BEA schedule structure');
  const missing = GDP_FINAL.map(([day]) => day).filter(day => !published.has(day));
  if (missing.length) throw new Error('GDP dates absent from the BEA schedule: ' + missing.join(', '));
}

function main() {
  const root = path.resolve(__dirname, '..');
  const rows = [];
  const add = (date, eventEn, eventZh, source, note = '') => rows.push({
    event_time_utc: date.toISOString(), event_timestamp_ms: date.getTime(),
    event_time_beijing: new Date(date.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 19),
    event_en: eventEn, event_zh: eventZh, region: 'United States', importance: '3', source, note,
  });

  for (const day of BLS.employment) {
    const date = easternToUtc(day, 8, 30);
    add(date, 'Non Farm Payrolls', '非农就业人数', 'BLS Employment Situation', '与失业率同场发布');
    add(date, 'Unemployment Rate', '失业率', 'BLS Employment Situation', '与非农同场发布');
  }
  for (const day of BLS.cpi) {
    const date = easternToUtc(day, 8, 30);
    add(date, 'Inflation Rate YoY', '通胀率同比', 'BLS Consumer Price Index', '与核心通胀同场发布');
    add(date, 'Core Inflation Rate YoY', '核心通胀率同比', 'BLS Consumer Price Index', '与通胀率同场发布');
  }
  for (const day of FOMC) add(easternToUtc(day, 14, 0), 'Fed Interest Rate Decision', '美联储利率决议', 'Federal Reserve FOMC calendar', '声明于美东 14:00 发布');

  const beaFile = path.join(root, 'exports', 'bea-release-dates.json');
  if (fs.existsSync(beaFile)) verifyGdpAgainstBea(beaFile);
  for (const [day, quarter] of GDP_FINAL) {
    add(easternToUtc(day, 8, 30), 'GDP Growth Rate QoQ Final', '国内生产总值（GDP）增长率季环比终值', 'BEA release schedule', quarter + ' 第三次估值');
  }

  const start = Date.parse('2025-01-01T00:00:00Z');
  const end = Date.parse('2026-09-30T00:00:00Z');
  const selected = rows.filter(row => row.event_timestamp_ms >= start && row.event_timestamp_ms <= end)
    .sort((a, b) => a.event_timestamp_ms - b.event_timestamp_ms || a.event_en.localeCompare(b.event_en));

  const seen = new Set();
  for (const row of selected) {
    const key = row.event_timestamp_ms + '|' + row.event_en;
    if (seen.has(key)) throw new Error('Duplicate schedule entry: ' + key);
    seen.add(key);
  }

  const fields = Object.keys(selected[0]);
  const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const output = path.join(root, 'exports', 'us-key-events-schedule-2025-01-to-2026-09.csv');
  fs.writeFileSync(output, '\ufeff' + [fields.join(','), ...selected.map(row => fields.map(f => cell(row[f])).join(','))].join('\r\n') + '\r\n');

  const counts = {};
  for (const row of selected) counts[row.event_zh] = (counts[row.event_zh] || 0) + 1;
  console.log(JSON.stringify({
    output: path.relative(root, output), total: selected.length, counts,
    earliest: selected[0].event_time_utc, latest: selected[selected.length - 1].event_time_utc,
  }, null, 2));
}

module.exports = { easternToUtc, easternOffsetHours, verifyGdpAgainstBea, GDP_FINAL };
if (require.main === module) main();
