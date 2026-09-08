const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { describe, simulate } = require('./analyse_event_trend.cjs');

const dir = path.resolve(process.argv[2] || '');
const index = parse(fs.readFileSync(path.join(dir, 'index.csv'), 'utf8'), { columns: true, bom: true, skip_empty_lines: true }).filter(r => r.status === 'complete');
const rows = index.map(record => ({
  record,
  ...describe(parse(fs.readFileSync(path.join(dir, record.file), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
    .map(x => ({ second: +x.relative_seconds, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume_btc }))),
}));

const triggered = rows.filter(r => Math.abs(r.impulse) >= 0.25);
const summarise = list => {
  const trades = list.map(r => ({ time: r.record.event_time_utc, events: r.record.events_zh, ...simulate(r.after, 9, 0.5, 1.0, 1800) })).filter(t => t.side);
  if (!trades.length) return null;
  const pnl = trades.map(t => t.pnl);
  const total = pnl.reduce((a, b) => a + b, 0);
  return {
    trades: trades.length,
    winRate: +(pnl.filter(p => p > 0).length / pnl.length * 100).toFixed(1),
    total: +total.toFixed(2), average: +(total / pnl.length).toFixed(3),
    netAfter010: +(total - pnl.length * 0.1).toFixed(2),
    continuation5m: +(list.filter(r => r.at300.move > 0).length / list.length * 100).toFixed(1),
  };
};

const out = { overall: summarise(triggered), byYear: {}, byEvent: {} };
for (const year of ['2024', '2025', '2026']) out.byYear[year] = summarise(triggered.filter(r => r.record.event_time_utc.startsWith(year)));
const classify = name => name.includes('非农') ? '非农与失业率' : name.includes('通胀') ? 'CPI' : name.includes('利率决议') ? '利率决议' : name.includes('GDP') ? 'GDP' : '其他';
for (const r of triggered) (out.byEvent[classify(r.record.events_zh)] ??= []).push(r);
for (const key of Object.keys(out.byEvent)) out.byEvent[key] = summarise(out.byEvent[key]);

// Split the sample in half by time to check whether the edge survives out of sample.
const sorted = [...triggered].sort((a, b) => Number(a.record.event_timestamp_ms) - Number(b.record.event_timestamp_ms));
const half = Math.floor(sorted.length / 2);
out.firstHalf = summarise(sorted.slice(0, half));
out.secondHalf = summarise(sorted.slice(half));
out.splitDate = sorted[half].record.event_time_utc;

console.log(JSON.stringify(out, null, 2));
