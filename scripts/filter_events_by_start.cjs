const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const BEFORE = 1800000;
const AFTER = 3600000;

function cell(value) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

function main() {
  const [input, output, earliestIso] = process.argv.slice(2);
  if (!input || !output || !earliestIso) throw new Error('Expected input CSV, output CSV and earliest available ISO timestamp');
  const earliest = Date.parse(earliestIso);
  if (!Number.isFinite(earliest)) throw new Error('Invalid earliest timestamp');
  const rows = parse(fs.readFileSync(path.resolve(input), 'utf8'), { columns: true, bom: true, skip_empty_lines: true });
  const kept = rows.filter(row => Number(row.event_timestamp_ms) - BEFORE >= earliest && Number(row.event_timestamp_ms) + AFTER <= Date.now() - 1000);
  if (!kept.length) throw new Error('No event window starts after the earliest available candle');
  const columns = Object.keys(rows[0]);
  const text = '\ufeff' + [columns.map(cell).join(','), ...kept.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(path.resolve(output), text);
  console.log(JSON.stringify({ output, dropped: rows.length - kept.length, kept: kept.length, first: kept[0].event_time_utc, last: kept[kept.length - 1].event_time_utc }));
}

main();
