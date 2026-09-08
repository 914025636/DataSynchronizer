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

const out = { thresholds: [], costs: [], byCategory: {} };
for (const threshold of [0.15, 0.2, 0.25, 0.3, 0.4]) {
  const trades = rows.filter(r => Math.abs(r.impulse) >= threshold).map(r => simulate(r.after, 9, 0.5, 1.0, 1800));
  const pnl = trades.map(t => t.pnl);
  out.thresholds.push({ threshold, trades: trades.length, winRate: +(pnl.filter(p => p > 0).length / pnl.length * 100).toFixed(1), average: +(pnl.reduce((a, b) => a + b, 0) / pnl.length).toFixed(3), total: +pnl.reduce((a, b) => a + b, 0).toFixed(2) });
}

const selected = rows.filter(r => Math.abs(r.impulse) >= 0.25);
const trades = selected.map(r => ({ time: r.record.event_time_utc, events: r.record.events_zh, ...simulate(r.after, 9, 0.5, 1.0, 1800) }));
for (const cost of [0, 0.02, 0.05, 0.1]) {
  const pnl = trades.map(t => t.pnl - cost * 2);
  out.costs.push({ roundTripCostPct: +(cost * 2).toFixed(2), average: +(pnl.reduce((a, b) => a + b, 0) / pnl.length).toFixed(3), total: +pnl.reduce((a, b) => a + b, 0).toFixed(2), winners: pnl.filter(p => p > 0).length });
}

const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
const total = trades.reduce((sum, t) => sum + t.pnl, 0);
out.concentration = {
  total: +total.toFixed(2),
  bestTrade: { time: sorted[0].time, pnl: +sorted[0].pnl.toFixed(2) },
  totalWithoutBest: +(total - sorted[0].pnl).toFixed(2),
  averageWithoutBest: +((total - sorted[0].pnl) / (trades.length - 1)).toFixed(3),
};

for (const row of selected) {
  const name = row.record.events_zh;
  const key = name.includes('非农') ? '非农' : name.includes('通胀') ? 'CPI' : name.includes('利率决议') ? '利率决议' : name.includes('生产者') ? 'PPI' : '其他';
  (out.byCategory[key] ??= []).push({ time: row.record.event_time_utc, impulse: +row.impulse.toFixed(3), move60m: +row.at3600.move.toFixed(3) });
}

out.trades = trades.map(t => ({ time: t.time, side: t.side, result: t.result, pnl: +t.pnl.toFixed(3), exitSecond: t.second }));
out.quietFalseSignals = rows.filter(r => Math.abs(r.impulse) < 0.25 && Math.abs(r.at300.move) > 0.4).length;
console.log(JSON.stringify(out, null, 2));
