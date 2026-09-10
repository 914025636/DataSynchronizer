const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const SCAN_SECONDS = 300;
const pct = (value, base) => (value / base - 1) * 100;

function readCandles(file) {
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, bom: true, skip_empty_lines: true });
  const volumeKey = Object.keys(rows[0] || {}).find(key => key.startsWith('volume'));
  if (!volumeKey) throw new Error('No volume column in ' + path.basename(file));
  return rows.map(row => ({
    second: +row.relative_seconds, open: +row.open, high: +row.high, low: +row.low, close: +row.close, volume: +row[volumeKey],
  }));
}

function load(dir) {
  const index = parse(fs.readFileSync(path.join(dir, 'index.csv'), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
    .filter(record => record.status === 'complete');
  return index.map(record => {
    const candles = readCandles(path.join(dir, record.file));
    const before = candles.filter(c => c.second < 0);
    const after = candles.filter(c => c.second >= 0);
    if (before.length < 1800 || after.length < 3600) throw new Error('Incomplete window: ' + record.file);
    return { record, before, after, baseline: baseline(before) };
  });
}

// Pre-event seconds set the scale that "abnormal" is measured against; nothing after the release is used.
function baseline(before) {
  const volumes = before.map(c => c.volume);
  const returns = [];
  for (let i = 1; i < before.length; i++) if (before[i - 1].close > 0) returns.push(pct(before[i].close, before[i - 1].close));
  const mean = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length || 1);
  return {
    volumePerSecond: volumes.reduce((a, b) => a + b, 0) / (volumes.length || 1),
    sigma: Math.sqrt(variance),
    activeRatio: volumes.filter(v => v > 0).length / (volumes.length || 1),
  };
}

// Scan forward and stop at the first second that is abnormal in BOTH volume and displacement.
// The displacement bar rises with sqrt(elapsed) so a slow drift never qualifies, only a genuine shock.
function findShock(row, volumeMultiple, sigmaMultiple, scanSeconds = SCAN_SECONDS) {
  const { volumePerSecond, sigma } = row.baseline;
  if (!(sigma > 0)) return null;
  const base = row.after[0].open;
  let cumulativeVolume = 0;
  const limit = Math.min(scanSeconds, row.after.length - 1);
  for (let i = 0; i <= limit; i++) {
    const candle = row.after[i];
    cumulativeVolume += candle.volume;
    const elapsed = i + 1;
    const surge = volumePerSecond > 0 ? cumulativeVolume / elapsed / volumePerSecond : Infinity;
    const move = pct(candle.close, base);
    const barrier = sigmaMultiple * sigma * Math.sqrt(elapsed);
    if (surge >= volumeMultiple && Math.abs(move) >= barrier && Math.sign(move) !== 0) {
      const window = row.after.slice(0, i + 1);
      return {
        second: candle.second, entry: candle.close, side: Math.sign(move), move, surge, barrier,
        shockRange: pct(Math.max(...window.map(c => c.high)), Math.min(...window.map(c => c.low))),
      };
    }
  }
  return null;
}

// Stop distance comes from the shock's own range, so volatile releases get room and quiet ones do not.
function trade(row, shock, options) {
  const { trailMultiple, stopFloor, maxHoldSeconds } = options;
  const distance = Math.max(stopFloor, trailMultiple * shock.shockRange);
  const startIndex = row.after.findIndex(c => c.second === shock.second) + 1;
  const lastIndex = Math.min(startIndex + maxHoldSeconds - 1, row.after.length - 1);
  let best = shock.entry;
  for (let i = startIndex; i <= lastIndex; i++) {
    const candle = row.after[i];
    const stopPrice = shock.side > 0 ? best * (1 - distance / 100) : best * (1 + distance / 100);
    const breached = shock.side > 0 ? candle.low <= stopPrice : candle.high >= stopPrice;
    if (breached) return { result: 'trail', exitSecond: candle.second, pnl: shock.side * pct(stopPrice, shock.entry), distance };
    best = shock.side > 0 ? Math.max(best, candle.high) : Math.min(best, candle.low);
  }
  const last = row.after[lastIndex];
  return { result: 'timeout', exitSecond: last.second, pnl: shock.side * pct(last.close, shock.entry), distance };
}

const stats = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return {
    count: values.length, mean: +mean.toFixed(3), median: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    p25: +sorted[Math.floor(sorted.length * 0.25)].toFixed(3), p75: +sorted[Math.floor(sorted.length * 0.75)].toFixed(3),
    min: +sorted[0].toFixed(3), max: +sorted[sorted.length - 1].toFixed(3),
  };
};

function summarise(trades) {
  if (!trades.length) return null;
  const pnl = trades.map(t => t.pnl);
  const total = pnl.reduce((a, b) => a + b, 0);
  const wins = pnl.filter(p => p > 0);
  const losses = pnl.filter(p => p <= 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  let equity = 0, peak = 0, drawdown = 0;
  for (const value of pnl) { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
  return {
    trades: trades.length,
    winRate: +(wins.length / pnl.length * 100).toFixed(1),
    total: +total.toFixed(2), average: +(total / pnl.length).toFixed(3),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    best: +Math.max(...pnl).toFixed(2), worst: +Math.min(...pnl).toFixed(2),
    maxDrawdown: +drawdown.toFixed(2),
    trails: trades.filter(t => t.result === 'trail').length,
    timeouts: trades.filter(t => t.result === 'timeout').length,
    medianEntrySecond: stats(trades.map(t => t.shock.second)).median,
    medianHoldSeconds: stats(trades.map(t => t.exitSecond - t.shock.second)).median,
    netAfter002: +(total - pnl.length * 0.02).toFixed(2),
    netAfter005: +(total - pnl.length * 0.05).toFixed(2),
    netAfter010: +(total - pnl.length * 0.10).toFixed(2),
    netAfter020: +(total - pnl.length * 0.20).toFixed(2),
  };
}

function run(rows, config) {
  const trades = [];
  let noShock = 0;
  for (const row of rows) {
    const shock = findShock(row, config.volumeMultiple, config.sigmaMultiple);
    if (!shock) { noShock++; continue; }
    trades.push({ row, shock, ...trade(row, shock, config) });
  }
  return { trades, noShock };
}

function main() {
  const dir = path.resolve(process.argv[2] || '');
  const all = load(dir);
  const minActive = Number(process.env.MIN_ACTIVE_RATIO ?? 0.2);
  const rows = all.filter(row => row.baseline.activeRatio >= minActive);
  const out = {
    dataset: path.basename(dir), events: all.length, minActiveRatio: minActive, usableEvents: rows.length,
    skippedIlliquid: all.length - rows.length,
    baseline: {
      sigmaPct: stats(rows.map(r => r.baseline.sigma)),
      activeRatio: stats(all.map(r => r.baseline.activeRatio)),
    },
  };

  const grid = [];
  for (const volumeMultiple of [3, 5, 8, 12]) {
    for (const sigmaMultiple of [2, 3, 4, 5]) {
      for (const trailMultiple of [0.5, 1.0, 1.5]) {
        for (const maxHoldSeconds of [900, 3600]) {
          const config = { volumeMultiple, sigmaMultiple, trailMultiple, stopFloor: 0.1, maxHoldSeconds };
          const { trades, noShock } = run(rows, config);
          const summary = summarise(trades);
          if (summary) grid.push({ volumeMultiple, sigmaMultiple, trailMultiple, maxHoldMinutes: maxHoldSeconds / 60, triggered: trades.length, noShock, ...summary });
        }
      }
    }
  }
  grid.sort((a, b) => b.netAfter005 - a.netAfter005);
  out.gridTotal = grid.length;
  out.gridPositiveAfter005 = grid.filter(g => g.netAfter005 > 0).length;
  out.gridPositiveAfter010 = grid.filter(g => g.netAfter010 > 0).length;
  out.bestGrids = grid.slice(0, 10);
  out.worstGrid = grid[grid.length - 1];
  out.medianAverage = stats(grid.map(g => g.average)).median;

  // Trigger frequency is a property of the detector alone, independent of how the trade is managed.
  out.triggerRates = [];
  for (const volumeMultiple of [3, 5, 8, 12]) {
    for (const sigmaMultiple of [2, 3, 4, 5]) {
      const hits = rows.map(row => findShock(row, volumeMultiple, sigmaMultiple)).filter(Boolean);
      out.triggerRates.push({
        volumeMultiple, sigmaMultiple, triggered: hits.length,
        rate: +(hits.length / rows.length * 100).toFixed(1),
        entrySecond: stats(hits.map(h => h.second)),
        shockRange: stats(hits.map(h => h.shockRange)),
      });
    }
  }

  // Does the shock direction persist? Judged after the fact, never used to pick trades.
  // Liquidity and yearly breakdown decide whether the edge is real or an artefact of a thin early book.
  const config = { volumeMultiple: 5, sigmaMultiple: 3, trailMultiple: 1.5, stopFloor: 0.1, maxHoldSeconds: 3600 };
  const reference = run(rows, config).trades;
  out.reference = { config, ...summarise(reference) };
  out.referenceTrades = reference.map(t => ({
    event: t.row.record.event_time_utc, name: t.row.record.events_zh,
    entrySecond: t.shock.second, side: t.shock.side, surge: +t.shock.surge.toFixed(1),
    shockRange: +t.shock.shockRange.toFixed(3), stopDistance: +t.distance.toFixed(3),
    result: t.result, exitSecond: t.exitSecond, pnl: +t.pnl.toFixed(3),
    activeRatio: +t.row.baseline.activeRatio.toFixed(3),
    tradedSecondsInHold: t.row.after.filter(c => c.second > t.shock.second && c.second <= t.exitSecond && c.volume > 0).length,
    holdSeconds: t.exitSecond - t.shock.second,
  }));
  const byYear = new Map();
  for (const t of out.referenceTrades) {
    const year = t.event.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(t.pnl);
  }
  out.byYear = [...byYear.entries()].sort().map(([year, pnl]) => ({
    year, trades: pnl.length, winRate: +(pnl.filter(p => p > 0).length / pnl.length * 100).toFixed(1),
    total: +pnl.reduce((a, b) => a + b, 0).toFixed(2), average: +(pnl.reduce((a, b) => a + b, 0) / pnl.length).toFixed(3),
  }));
  // A held second with no trades cannot be exited at the modelled price, so this measures execution realism.
  out.executionRealism = stats(out.referenceTrades.map(t => t.holdSeconds > 0 ? t.tradedSecondsInHold / t.holdSeconds * 100 : 100));
  out.usableEventsByYear = [...rows.reduce((map, row) => {
    const year = row.record.event_time_utc.slice(0, 4);
    map.set(year, (map.get(year) || 0) + 1);
    return map;
  }, new Map()).entries()].sort().map(([year, count]) => ({ year, usable: count }));

  out.persistence = [];
  for (const sigmaMultiple of [2, 3, 4, 5]) {
    const hits = rows.map(row => ({ row, shock: findShock(row, 5, sigmaMultiple) })).filter(h => h.shock);
    if (!hits.length) continue;
    const agree = horizon => {
      const valid = hits.filter(h => h.row.after.findIndex(c => c.second === h.shock.second) + horizon < h.row.after.length);
      if (!valid.length) return null;
      const same = valid.filter(h => {
        const index = h.row.after.findIndex(c => c.second === h.shock.second);
        return Math.sign(pct(h.row.after[index + horizon].close, h.shock.entry)) === h.shock.side;
      });
      return +(same.length / valid.length * 100).toFixed(1);
    };
    out.persistence.push({ sigmaMultiple, triggered: hits.length, same60s: agree(60), same300s: agree(300), same900s: agree(900), same3000s: agree(3000) });
  }

  const target = process.argv[3];
  if (target) { fs.writeFileSync(path.resolve(target), JSON.stringify(out, null, 2)); console.log('Written ' + target); }
  else console.log(JSON.stringify(out, null, 2));
}

module.exports = { baseline, findShock, trade, summarise, run, load };
if (require.main === module) main();
