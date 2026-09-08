const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const pct = (value, base) => (value / base - 1) * 100;

function load(dir) {
  const index = parse(fs.readFileSync(path.join(dir, 'index.csv'), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
    .filter(record => record.status === 'complete');
  return index.map(record => {
    const candles = parse(fs.readFileSync(path.join(dir, record.file), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
      .map(x => ({ second: +x.relative_seconds, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume_btc }));
    const after = candles.filter(c => c.second >= 0);
    const before = candles.filter(c => c.second < 0);
    if (after.length < 3600 || before.length < 1800) throw new Error('Incomplete window: ' + record.file);
    return { record, after, before };
  });
}

// The signal uses only the first two seconds, so it is decidable in real time.
function signal(row) {
  const base = row.after[0].open;
  const entry = row.after[1].close;
  const move = pct(entry, base);
  const volume = row.after[0].volume + row.after[1].volume;
  const preVolumePerSecond = row.before.reduce((sum, c) => sum + c.volume, 0) / row.before.length;
  return { base, entry, move, side: Math.sign(move), volumeSurge: preVolumePerSecond > 0 ? volume / 2 / preVolumePerSecond : Infinity };
}

// Enter at the close of second 2; stop is checked before target within the same second.
function trade(row, stopPct, takePct, timeoutSecond) {
  const { entry, side } = signal(row);
  if (!side) return null;
  for (let i = 2; i <= Math.min(timeoutSecond, row.after.length - 1); i++) {
    const adverse = side > 0 ? pct(row.after[i].low, entry) : -pct(row.after[i].high, entry);
    const favourable = side > 0 ? pct(row.after[i].high, entry) : -pct(row.after[i].low, entry);
    if (adverse <= -stopPct) return { result: 'stop', pnl: -stopPct, exitSecond: row.after[i].second, side };
    if (favourable >= takePct) return { result: 'target', pnl: takePct, exitSecond: row.after[i].second, side };
  }
  const last = row.after[Math.min(timeoutSecond, row.after.length - 1)];
  return { result: 'timeout', pnl: side * pct(last.close, entry), exitSecond: last.second, side };
}

const stats = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: values.length,
    mean: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(3),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    min: +sorted[0].toFixed(3), max: +sorted[sorted.length - 1].toFixed(3),
  };
};

function summarise(rows, stopPct, takePct, timeoutSecond) {
  const trades = rows.map(row => ({ row, ...trade(row, stopPct, takePct, timeoutSecond) })).filter(t => t.side);
  if (!trades.length) return null;
  const pnl = trades.map(t => t.pnl);
  const total = pnl.reduce((a, b) => a + b, 0);
  const cost = c => +(total - pnl.length * c).toFixed(2);
  return {
    trades: trades.length,
    winRate: +(pnl.filter(p => p > 0).length / pnl.length * 100).toFixed(1),
    total: +total.toFixed(2), average: +(total / pnl.length).toFixed(3),
    worst: +Math.min(...pnl).toFixed(2), best: +Math.max(...pnl).toFixed(2),
    stops: trades.filter(t => t.result === 'stop').length,
    targets: trades.filter(t => t.result === 'target').length,
    timeouts: trades.filter(t => t.result === 'timeout').length,
    netAfter002: cost(0.02), netAfter005: cost(0.05), netAfter010: cost(0.1),
    tradeList: trades,
  };
}

function main() {
  const dir = path.resolve(process.argv[2] || '');
  const rows = load(dir);
  const withSignal = rows.map(row => ({ ...row, signal: signal(row) }));
  const out = { events: rows.length, signalSize: stats(withSignal.map(r => Math.abs(r.signal.move))) };

  // Directional accuracy judged only against later prices, never used for selection.
  out.accuracy = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3].map(threshold => {
    const hits = withSignal.filter(r => Math.abs(r.signal.move) >= threshold);
    if (!hits.length) return { threshold, triggered: 0 };
    const agree = second => hits.filter(r => Math.sign(pct(r.after[second].close, r.signal.entry)) === r.signal.side).length;
    return {
      threshold, triggered: hits.length,
      same10s: +(agree(9) / hits.length * 100).toFixed(1),
      same1m: +(agree(59) / hits.length * 100).toFixed(1),
      same5m: +(agree(299) / hits.length * 100).toFixed(1),
      same60m: +(agree(3599) / hits.length * 100).toFixed(1),
      favourable5m: stats(hits.map(r => r.signal.side > 0
        ? pct(Math.max(...r.after.slice(2, 300).map(c => c.high)), r.signal.entry)
        : -pct(Math.min(...r.after.slice(2, 300).map(c => c.low)), r.signal.entry))),
      adverse5m: stats(hits.map(r => r.signal.side > 0
        ? -pct(Math.min(...r.after.slice(2, 300).map(c => c.low)), r.signal.entry)
        : pct(Math.max(...r.after.slice(2, 300).map(c => c.high)), r.signal.entry))),
    };
  });

  const grid = [];
  for (const threshold of [0.1, 0.15, 0.2, 0.25, 0.3]) {
    const hits = withSignal.filter(r => Math.abs(r.signal.move) >= threshold);
    if (!hits.length) continue;
    for (const stopPct of [0.3, 0.5, 0.8]) {
      for (const takePct of [0.6, 1.0, 1.5]) {
        for (const timeoutSecond of [900, 1800]) {
          const result = summarise(hits, stopPct, takePct, timeoutSecond);
          if (result) { const { tradeList, ...rest } = result; grid.push({ threshold, stopPct, takePct, timeoutMinutes: timeoutSecond / 60, ...rest }); }
        }
      }
    }
  }
  grid.sort((a, b) => b.average - a.average);
  out.bestGrids = grid.slice(0, 8);
  out.worstGrid = grid[grid.length - 1];
  out.gridPositiveAfter010 = grid.filter(g => g.netAfter010 > 0).length;
  out.gridTotal = grid.length;

  const baseline = withSignal.filter(r => Math.abs(r.signal.move) >= 0.2);
  const main2 = summarise(baseline, 0.5, 1.0, 1800);
  const { tradeList, ...headline } = main2;
  out.headline = { threshold: 0.2, stopPct: 0.5, takePct: 1.0, timeoutMinutes: 30, ...headline };

  const classify = name => name.includes('非农') ? '非农与失业率' : name.includes('通胀') ? 'CPI' : name.includes('利率决议') ? '利率决议' : name.includes('GDP') ? 'GDP' : '其他';
  out.byEvent = {};
  for (const group of new Set(baseline.map(r => classify(r.record.events_zh)))) {
    const result = summarise(baseline.filter(r => classify(r.record.events_zh) === group), 0.5, 1.0, 1800);
    const { tradeList: _, ...rest } = result;
    out.byEvent[group] = rest;
  }

  out.byYear = {};
  for (const year of ['2024', '2025', '2026']) {
    const result = summarise(baseline.filter(r => r.record.event_time_utc.startsWith(year)), 0.5, 1.0, 1800);
    if (result) { const { tradeList: _, ...rest } = result; out.byYear[year] = rest; }
  }

  const sorted = [...baseline].sort((a, b) => Number(a.record.event_timestamp_ms) - Number(b.record.event_timestamp_ms));
  const half = Math.floor(sorted.length / 2);
  for (const [label, slice] of [['firstHalf', sorted.slice(0, half)], ['secondHalf', sorted.slice(half)]]) {
    const result = summarise(slice, 0.5, 1.0, 1800);
    const { tradeList: _, ...rest } = result;
    out[label] = rest;
  }
  out.splitDate = sorted[half].record.event_time_utc;

  // Compare against entering ten seconds in, using the same real-time-decidable filter.
  out.entryComparison = [1, 2, 3, 5, 10, 30].map(second => {
    const trades = baseline.map(row => {
      const entry = row.after[second - 1].close;
      const side = row.signal.side;
      for (let i = second; i <= 1800; i++) {
        const adverse = side > 0 ? pct(row.after[i].low, entry) : -pct(row.after[i].high, entry);
        const favourable = side > 0 ? pct(row.after[i].high, entry) : -pct(row.after[i].low, entry);
        if (adverse <= -0.5) return -0.5;
        if (favourable >= 1) return 1;
      }
      return side * pct(row.after[1800].close, entry);
    });
    const total = trades.reduce((a, b) => a + b, 0);
    return {
      entrySecond: second, trades: trades.length,
      winRate: +(trades.filter(p => p > 0).length / trades.length * 100).toFixed(1),
      total: +total.toFixed(2), average: +(total / trades.length).toFixed(3),
      netAfter010: +(total - trades.length * 0.1).toFixed(2),
    };
  });

  out.trades = tradeList.map(t => ({
    time: t.row.record.event_time_utc, events: t.row.record.events_zh.slice(0, 40),
    signal: +t.row.signal.move.toFixed(3), side: t.side, result: t.result,
    pnl: +t.pnl.toFixed(3), exitSecond: t.exitSecond, volumeSurge: +t.row.signal.volumeSurge.toFixed(1),
  })).sort((a, b) => a.time.localeCompare(b.time));

  const output = path.join(dir, 'second2-entry-analysis.json');
  fs.writeFileSync(output, JSON.stringify(out, null, 2));
  const { trades, bestGrids, accuracy, ...brief } = out;
  console.log(JSON.stringify({ ...brief, accuracy, topGrids: bestGrids.slice(0, 5), output }, null, 2));
}

module.exports = { signal, trade, summarise, load };
if (require.main === module) main();
