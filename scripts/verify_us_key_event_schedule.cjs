const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const root = path.resolve(__dirname, '..');
const read = file => parse(fs.readFileSync(path.join(root, file), 'utf8'), { columns: true, bom: true, skip_empty_lines: true });

const schedule = read('exports/us-key-events-schedule-2025-01-to-2026-09.csv');
const okx = read('exports/okx-economic-calendar-from-2023-09-07-united_states-importance-3-2026-09-07T09-56-03-470Z.csv');

const tracked = {
  'Non Farm Payrolls': 'Non Farm Payrolls',
  'Unemployment Rate': 'Unemployment Rate',
  'Inflation Rate YoY': 'Inflation Rate YoY',
  'Core Inflation Rate YoY': 'Core Inflation Rate YoY',
  'Fed Interest Rate Decision': 'Fed Interest Rate Decision',
  'GDP Growth Rate QoQ Final': 'GDP Growth Rate QoQ Final',
};

const okxKeys = new Set(okx.filter(r => tracked[r.event]).map(r => r.date + '|' + r.event));
const okxTimes = okx.filter(r => tracked[r.event]).map(r => Number(r.date));
const overlapStart = Math.min(...okxTimes);
const overlapEnd = Math.max(...okxTimes);

const inOverlap = schedule.filter(r => Number(r.event_timestamp_ms) >= overlapStart && Number(r.event_timestamp_ms) <= overlapEnd);
const matched = inOverlap.filter(r => okxKeys.has(r.event_timestamp_ms + '|' + r.event_en));
const missingFromOkx = inOverlap.filter(r => !okxKeys.has(r.event_timestamp_ms + '|' + r.event_en));
const extraInOkx = [...okxKeys].filter(key => !inOverlap.some(r => r.event_timestamp_ms + '|' + r.event_en === key));

const timesOfDay = {};
for (const row of schedule) {
  const time = row.event_time_beijing.slice(11, 16);
  (timesOfDay[row.event_zh] ??= {})[time] = (timesOfDay[row.event_zh][time] || 0) + 1;
}

console.log(JSON.stringify({
  scheduleRows: schedule.length,
  overlapWindow: [new Date(overlapStart).toISOString(), new Date(overlapEnd).toISOString()],
  overlapRows: inOverlap.length, matched: matched.length,
  missingFromOkx: missingFromOkx.map(r => r.event_time_utc + ' ' + r.event_en),
  extraInOkx: extraInOkx.map(key => new Date(Number(key.split('|')[0])).toISOString() + ' ' + key.split('|')[1]),
  beijingTimesByEvent: timesOfDay,
  perYear: schedule.reduce((acc, r) => { acc[r.event_time_utc.slice(0, 4)] = (acc[r.event_time_utc.slice(0, 4)] || 0) + 1; return acc; }, {}),
}, null, 2));
