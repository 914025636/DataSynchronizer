const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const pct = (value, base) => (value / base - 1) * 100;
const dir = path.resolve(process.argv[2] || '');
const index = parse(fs.readFileSync(path.join(dir, 'index.csv'), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
  .filter(r => r.status === 'complete');

const rows = index.map(record => {
  const candles = parse(fs.readFileSync(path.join(dir, record.file), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
    .map(x => ({ second: +x.relative_seconds, open: +x.open, high: +x.high, low: +x.low, close: +x.close }));
  const after = candles.filter(c => c.second >= 0);
  const base = after[0].open;
  return {
    time: record.event_time_utc,
    events: record.events_zh,
    signal2s: Math.abs(pct(after[1].close, base)),
    move10s: Math.abs(pct(after[9].close, base)),
  };
});

// Split combined releases so each event name is credited individually.
const perName = new Map();
for (const row of rows) {
  for (const name of row.events.split('；')) {
    if (!perName.has(name)) perName.set(name, []);
    perName.get(name).push(row);
  }
}

const summary = [...perName.entries()]
  .map(([name, list]) => ({
    name, windows: list.length,
    medianSignal2s: +[...list.map(r => r.signal2s)].sort((a, b) => a - b)[Math.floor(list.length / 2)].toFixed(3),
    maxSignal2s: +Math.max(...list.map(r => r.signal2s)).toFixed(3),
    hits02: list.filter(r => r.signal2s >= 0.2).length,
    rate02: +(list.filter(r => r.signal2s >= 0.2).length / list.length * 100).toFixed(1),
  }))
  .filter(x => x.windows >= 2)
  .sort((a, b) => b.rate02 - a.rate02 || b.medianSignal2s - a.medianSignal2s);

console.log(JSON.stringify({
  eventNames: perName.size,
  ranked: summary,
  strongestWindows: rows.sort((a, b) => b.signal2s - a.signal2s).slice(0, 15)
    .map(r => ({ time: r.time.slice(0, 16), signal2s: +r.signal2s.toFixed(3), events: r.events.slice(0, 60) })),
}, null, 2));
