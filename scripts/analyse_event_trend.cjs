const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

function readCandles(file) {
  return parse(fs.readFileSync(file, 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
    .map(row => ({ second: Number(row.relative_seconds), open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row.volume_btc }));
}

const at = (after, second) => after[Math.min(second, after.length - 1)];
const pct = (value, base) => (value / base - 1) * 100;

// Directional efficiency: how much of the travelled distance became net displacement.
function efficiency(rows) {
  let travelled = 0;
  for (let i = 1; i < rows.length; i++) travelled += Math.abs(rows[i].close - rows[i - 1].close);
  const net = Math.abs(rows[rows.length - 1].close - rows[0].open);
  return travelled > 0 ? net / travelled : 0;
}

function describe(candles) {
  const before = candles.filter(c => c.second < 0);
  const after = candles.filter(c => c.second >= 0);
  const base = after[0].open;
  const preRange = (Math.max(...before.map(c => c.high)) / Math.min(...before.map(c => c.low)) - 1) * 100;
  const first10 = after.slice(0, 10);
  const impulse = pct(at(after, 9).close, base);
  const direction = Math.sign(impulse);
  const move60 = pct(at(after, 59).close, base);
  const path = second => {
    const window = after.slice(0, second + 1);
    const favourable = direction > 0 ? pct(Math.max(...window.map(c => c.high)), base) : -pct(Math.min(...window.map(c => c.low)), base);
    const adverse = direction > 0 ? -pct(Math.min(...window.map(c => c.low)), base) : pct(Math.max(...window.map(c => c.high)), base);
    return { move: direction * pct(at(after, second).close, base), favourable, adverse };
  };
  return {
    base, preRange, impulse, direction, move60,
    impulseVolume: first10.reduce((sum, c) => sum + c.volume, 0),
    preVolumePerSecond: before.reduce((sum, c) => sum + c.volume, 0) / before.length,
    efficiency5m: efficiency(after.slice(0, 300)),
    at60: path(59), at300: path(299), at900: path(899), at3600: path(3599),
    after, base60: at(after, 59).close,
  };
}

// Enter at the close of the trigger second, in the direction of the impulse.
function simulate(after, entrySecond, stopPct, takePct, timeoutSecond) {
  const entry = after[entrySecond].close;
  const impulse = pct(entry, after[0].open);
  const side = Math.sign(impulse);
  if (!side) return null;
  for (let i = entrySecond + 1; i <= Math.min(timeoutSecond, after.length - 1); i++) {
    const adverse = side > 0 ? pct(after[i].low, entry) : -pct(after[i].high, entry);
    const favourable = side > 0 ? pct(after[i].high, entry) : -pct(after[i].low, entry);
    // Assume the stop fills first when a single second contains both levels.
    if (adverse <= -stopPct) return { result: 'stop', pnl: -stopPct, second: after[i].second, side };
    if (favourable >= takePct) return { result: 'target', pnl: takePct, second: after[i].second, side };
  }
  const last = after[Math.min(timeoutSecond, after.length - 1)];
  return { result: 'timeout', pnl: side * pct(last.close, entry), second: last.second, side };
}

const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, median, min: sorted[0], max: sorted[sorted.length - 1] };
};

function main() {
  const directory = path.resolve(process.argv[2] || '');
  const index = parse(fs.readFileSync(path.join(directory, 'index.csv'), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
    .filter(record => record.status === 'complete');
  const rows = index.map(record => ({ record, ...describe(readCandles(path.join(directory, record.file))) }));

  const threshold = 0.25;
  const triggered = rows.filter(row => Math.abs(row.impulse) >= threshold);
  const quiet = rows.filter(row => Math.abs(row.impulse) < threshold);
  const continued = triggered.filter(row => row.at300.move > 0);

  const grid = [];
  for (const entrySecond of [9, 29, 59]) {
    for (const stopPct of [0.2, 0.3, 0.5]) {
      for (const takePct of [0.4, 0.6, 1.0]) {
        const trades = triggered.map(row => simulate(row.after, entrySecond, stopPct, takePct, 1800)).filter(Boolean);
        const pnl = trades.map(t => t.pnl);
        const wins = trades.filter(t => t.pnl > 0).length;
        grid.push({
          entrySecond, stopPct, takePct, trades: trades.length,
          winRate: wins / trades.length * 100,
          total: pnl.reduce((a, b) => a + b, 0),
          average: pnl.reduce((a, b) => a + b, 0) / trades.length,
          worst: Math.min(...pnl), best: Math.max(...pnl),
          stops: trades.filter(t => t.result === 'stop').length,
          targets: trades.filter(t => t.result === 'target').length,
        });
      }
    }
  }
  grid.sort((a, b) => b.average - a.average);

  const report = {
    events: rows.length,
    triggered: triggered.length, quiet: quiet.length,
    continuationRate5m: continued.length / triggered.length * 100,
    impulse: stats(triggered.map(r => Math.abs(r.impulse))),
    efficiency5m: stats(triggered.map(r => r.efficiency5m)),
    favourable: { m1: stats(triggered.map(r => r.at60.favourable)), m5: stats(triggered.map(r => r.at300.favourable)), m15: stats(triggered.map(r => r.at900.favourable)) },
    adverse: { m1: stats(triggered.map(r => r.at60.adverse)), m5: stats(triggered.map(r => r.at300.adverse)), m15: stats(triggered.map(r => r.at900.adverse)) },
    move: { m5: stats(triggered.map(r => r.at300.move)), m15: stats(triggered.map(r => r.at900.move)), m60: stats(triggered.map(r => r.at3600.move)) },
    quietMove5m: quiet.length ? stats(quiet.map(r => Math.abs(r.at300.move))) : null,
    volumeSurge: stats(triggered.map(r => r.impulseVolume / 10 / r.preVolumePerSecond)),
    bestGrids: grid.slice(0, 6), worstGrid: grid[grid.length - 1],
    detail: triggered.map(r => ({
      time: r.record.event_time_utc, events: r.record.events_zh,
      impulse: +r.impulse.toFixed(3), move5m: +r.at300.move.toFixed(3), move60m: +r.at3600.move.toFixed(3),
      favourable5m: +r.at300.favourable.toFixed(3), adverse5m: +r.at300.adverse.toFixed(3),
      efficiency: +r.efficiency5m.toFixed(3), preRange: +r.preRange.toFixed(3),
    })).sort((a, b) => Math.abs(b.impulse) - Math.abs(a.impulse)),
  };
  const output = path.join(directory, 'trend-analysis.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  const { detail, ...summary } = report;
  console.log(JSON.stringify({ ...summary, output }, null, 2));
}

module.exports = { describe, simulate, efficiency };
if (require.main === module) main();
