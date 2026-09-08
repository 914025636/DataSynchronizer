const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { simulate } = require('./analyse_event_trend.cjs');

const pct = (value, base) => (value / base - 1) * 100;

function load(dir) {
  const index = parse(fs.readFileSync(path.join(dir, 'index.csv'), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
    .filter(record => record.status === 'complete');
  return index.map(record => {
    const candles = parse(fs.readFileSync(path.join(dir, record.file), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
      .map(x => ({ second: +x.relative_seconds, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume_btc }));
    const before = candles.filter(c => c.second < 0);
    const after = candles.filter(c => c.second >= 0);
    return { record, after, before, base: after[0].open };
  });
}

// The signal is the event second itself: its own open-to-close move.
function firstSecond(row) {
  const bar = row.after[0];
  const move = pct(bar.close, bar.open);
  const direction = Math.sign(move);
  const forward = (second, kind) => {
    const window = row.after.slice(1, second + 1);
    if (!window.length) return 0;
    if (kind === 'close') return direction * pct(window[window.length - 1].close, bar.close);
    if (kind === 'favourable') return direction > 0 ? pct(Math.max(...window.map(c => c.high)), bar.close) : -pct(Math.min(...window.map(c => c.low)), bar.close);
    return direction > 0 ? -pct(Math.min(...window.map(c => c.low)), bar.close) : pct(Math.max(...window.map(c => c.high)), bar.close);
  };
  return {
    move, direction,
    barRange: (bar.high / bar.low - 1) * 100,
    volume: bar.volume,
    preVolumePerSecond: row.before.reduce((sum, c) => sum + c.volume, 0) / row.before.length,
    // Slippage proxy: entering one second late instead of at the signal close.
    lateEntryCost: direction * pct(row.after[1].close, bar.close) * -1,
    continuation: { s10: forward(10, 'close'), s30: forward(30, 'close'), m1: forward(60, 'close'), m5: forward(300, 'close'), m15: forward(900, 'close'), m60: forward(3599, 'close') },
    favourable: { m1: forward(60, 'favourable'), m5: forward(300, 'favourable'), m15: forward(900, 'favourable') },
    adverse: { m1: forward(60, 'adverse'), m5: forward(300, 'adverse'), m15: forward(900, 'adverse') },
  };
}

const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    min: +sorted[0].toFixed(3), max: +sorted[sorted.length - 1].toFixed(3),
  };
};
const rate = (rows, test) => +(rows.filter(test).length / rows.length * 100).toFixed(1);

function main() {
  const dir = path.resolve(process.argv[2] || '');
  const rows = load(dir).map(row => ({ row, signal: firstSecond(row) }));
  const out = { events: rows.length, thresholds: [], grid: [], comparison: [] };

  for (const threshold of [0.05, 0.1, 0.15, 0.2, 0.3]) {
    const hits = rows.filter(r => Math.abs(r.signal.move) >= threshold);
    if (!hits.length) { out.thresholds.push({ threshold, triggered: 0 }); continue; }
    out.thresholds.push({
      threshold, triggered: hits.length,
      continuation10s: rate(hits, r => r.signal.continuation.s10 > 0),
      continuation1m: rate(hits, r => r.signal.continuation.m1 > 0),
      continuation5m: rate(hits, r => r.signal.continuation.m5 > 0),
      continuation60m: rate(hits, r => r.signal.continuation.m60 > 0),
      signalSize: stats(hits.map(r => Math.abs(r.signal.move))),
      favourable5m: stats(hits.map(r => r.signal.favourable.m5)),
      adverse5m: stats(hits.map(r => r.signal.adverse.m5)),
      move5m: stats(hits.map(r => r.signal.continuation.m5)),
      lateEntryCost: stats(hits.map(r => r.signal.lateEntryCost)),
      volumeSurge: stats(hits.map(r => r.signal.volume / r.signal.preVolumePerSecond)),
    });
  }

  for (const threshold of [0.05, 0.1, 0.15, 0.2]) {
    const hits = rows.filter(r => Math.abs(r.signal.move) >= threshold);
    if (!hits.length) continue;
    for (const stop of [0.3, 0.5, 0.8]) {
      for (const take of [0.6, 1.0, 1.5]) {
        const trades = hits.map(r => simulate(r.row.after, 0, stop, take, 1800)).filter(Boolean);
        if (!trades.length) continue;
        const pnl = trades.map(t => t.pnl);
        const total = pnl.reduce((a, b) => a + b, 0);
        out.grid.push({
          threshold, stop, take, trades: trades.length,
          winRate: +(pnl.filter(p => p > 0).length / pnl.length * 100).toFixed(1),
          total: +total.toFixed(2), average: +(total / pnl.length).toFixed(3),
          stops: trades.filter(t => t.result === 'stop').length,
          targets: trades.filter(t => t.result === 'target').length,
          netAfter004: +(total - pnl.length * 0.04).toFixed(2),
        });
      }
    }
  }
  out.grid.sort((a, b) => b.average - a.average);

  // Same exit rules, comparing the one-second signal against the ten-second signal.
  for (const [label, entrySecond, threshold, pick] of [
    ['1 秒信号', 0, 0.1, r => Math.abs(r.signal.move) >= 0.1],
    ['1 秒信号（阈值 0.2%）', 0, 0.2, r => Math.abs(r.signal.move) >= 0.2],
    ['10 秒信号', 9, 0.25, r => Math.abs(pct(r.row.after[9].close, r.row.base)) >= 0.25],
  ]) {
    const hits = rows.filter(pick);
    const trades = hits.map(r => simulate(r.row.after, entrySecond, 0.5, 1.0, 1800)).filter(Boolean);
    const pnl = trades.map(t => t.pnl);
    const total = pnl.reduce((a, b) => a + b, 0);
    out.comparison.push({
      label, entrySecond, threshold, trades: trades.length,
      winRate: +(pnl.filter(p => p > 0).length / pnl.length * 100).toFixed(1),
      total: +total.toFixed(2), average: +(total / pnl.length).toFixed(3),
      worst: +Math.min(...pnl).toFixed(2),
      netAfter004: +(total - pnl.length * 0.04).toFixed(2),
    });
  }

  out.signalDetail = rows
    .filter(r => Math.abs(r.signal.move) >= 0.1)
    .sort((a, b) => Math.abs(b.signal.move) - Math.abs(a.signal.move))
    .map(r => ({
      time: r.row.record.event_time_utc, events: r.row.record.events_zh,
      signal: +r.signal.move.toFixed(3), barRange: +r.signal.barRange.toFixed(3),
      s10: +r.signal.continuation.s10.toFixed(3), m1: +r.signal.continuation.m1.toFixed(3),
      m5: +r.signal.continuation.m5.toFixed(3), m60: +r.signal.continuation.m60.toFixed(3),
      favourable5m: +r.signal.favourable.m5.toFixed(3), adverse5m: +r.signal.adverse.m5.toFixed(3),
      volumeSurge: +(r.signal.volume / r.signal.preVolumePerSecond).toFixed(1),
    }));
  out.allSignalSizes = stats(rows.map(r => Math.abs(r.signal.move)));
  console.log(JSON.stringify(out, null, 2));
}

module.exports = { firstSecond, load };
if (require.main === module) main();
