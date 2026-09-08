const path = require('path');
const { load } = require('./analyse_first_second_trend.cjs');
const { simulate } = require('./analyse_event_trend.cjs');

const pct = (value, base) => (value / base - 1) * 100;
const stats = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2), median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] };
};

const dir = path.resolve(process.argv[2] || '');
const rows = load(dir);
const big = rows.filter(row => Math.abs(pct(row.after[9].close, row.base)) >= 0.25);

const out = {};
// When did price first travel 0.25% from the event price?
out.latencySeconds = stats(big.map(row => {
  const hit = row.after.findIndex(c => Math.abs(pct(c.close, row.base)) >= 0.25);
  return hit < 0 ? row.after.length : row.after[hit].second;
}).filter(Number.isFinite));

out.firstSecondMove = stats(rows.map(row => +Math.abs(pct(row.after[0].close, row.after[0].open)).toFixed(3)));
out.firstSecondVolumeShare = stats(big.map(row => {
  const ten = row.after.slice(0, 10).reduce((sum, c) => sum + c.volume, 0);
  return +(row.after[0].volume / ten * 100).toFixed(1);
}));

// Entry timing sweep using the ten-second confirmation, same exits.
out.entrySweep = [1, 2, 3, 5, 10, 15, 20, 30, 60].map(entrySecond => {
  const trades = big.map(row => simulate(row.after, entrySecond - 1, 0.5, 1.0, 1800)).filter(Boolean);
  const pnl = trades.map(t => t.pnl);
  const total = pnl.reduce((a, b) => a + b, 0);
  return { entrySecond, trades: trades.length, winRate: +(pnl.filter(p => p > 0).length / pnl.length * 100).toFixed(1), total: +total.toFixed(2), average: +(total / pnl.length).toFixed(3), worst: +Math.min(...pnl).toFixed(2) };
});

// Directional signal available at each early second, judged by the 5-minute outcome.
out.earlySignalQuality = [1, 2, 3, 5, 10].map(second => {
  const usable = rows.filter(row => Math.abs(pct(row.after[second - 1].close, row.base)) >= 0.05);
  const correct = usable.filter(row => {
    const early = Math.sign(pct(row.after[second - 1].close, row.base));
    const later = Math.sign(pct(row.after[299].close, row.base));
    return early === later;
  });
  return { second, signalsAboveHalfBp: usable.length, matched5m: correct.length, accuracy: usable.length ? +(correct.length / usable.length * 100).toFixed(1) : null };
});

out.detail = big.map(row => {
  const hit = row.after.find(c => Math.abs(pct(c.close, row.base)) >= 0.25);
  return {
    time: row.record.event_time_utc, events: row.record.events_zh.slice(0, 30),
    firstSecond: +pct(row.after[0].close, row.after[0].open).toFixed(3),
    second2: +pct(row.after[1].close, row.base).toFixed(3),
    second3: +pct(row.after[2].close, row.base).toFixed(3),
    second5: +pct(row.after[4].close, row.base).toFixed(3),
    second10: +pct(row.after[9].close, row.base).toFixed(3),
    latency: hit ? hit.second : null,
  };
}).sort((a, b) => a.latency - b.latency);

console.log(JSON.stringify(out, null, 2));
