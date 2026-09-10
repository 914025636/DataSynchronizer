const fs = require('fs');
const path = require('path');
const { load, findShock, trade } = require('./analyse_event_shock_trend.cjs');

const CONFIG = { volumeMultiple: 5, sigmaMultiple: 3, trailMultiple: 1.5, stopFloor: 0.1, maxHoldSeconds: 3600 };

const sum = values => values.reduce((a, b) => a + b, 0);

function describe(name, pnls) {
  if (!pnls.length) return { group: name, trades: 0 };
  const sorted = [...pnls].sort((a, b) => a - b);
  const wins = pnls.filter(p => p > 0);
  const grossWin = sum(wins);
  const grossLoss = -sum(pnls.filter(p => p <= 0));
  return {
    group: name, trades: pnls.length,
    winRate: +(wins.length / pnls.length * 100).toFixed(1),
    average: +(sum(pnls) / pnls.length).toFixed(3),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(3),
    total: +sum(pnls).toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    net010: +(sum(pnls) - pnls.length * 0.1).toFixed(2),
  };
}

function group(trades, key) {
  const map = new Map();
  for (const item of trades) {
    const value = key(item);
    if (!map.has(value)) map.set(value, []);
    map.get(value).push(item);
  }
  return map;
}

// Two-sample t statistic on unequal variances; with tens of trades this is only a rough guide.
function welch(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const mean = values => sum(values) / values.length;
  const variance = values => sum(values.map(v => (v - mean(values)) ** 2)) / (values.length - 1);
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  return se > 0 ? +((mean(a) - mean(b)) / se).toFixed(2) : null;
}

function main() {
  const dir = path.resolve(process.argv[2] || '');
  const minActive = Number(process.env.MIN_ACTIVE_RATIO ?? 0.05);
  const rows = load(dir).filter(row => row.baseline.activeRatio >= minActive);

  const trades = [];
  for (const row of rows) {
    const shock = findShock(row, CONFIG.volumeMultiple, CONFIG.sigmaMultiple);
    if (!shock) continue;
    const result = trade(row, shock, CONFIG);
    const names = row.record.events_zh.split('；');
    trades.push({
      event: row.record.event_time_utc, names, eventCount: names.length, family: names[0],
      entrySecond: shock.second, side: shock.side, surge: shock.surge, shockRange: shock.shockRange,
      pnl: result.pnl, result: result.result, exitSecond: result.exitSecond,
      activeRatio: row.baseline.activeRatio, sigma: row.baseline.sigma,
    });
  }

  const windows = rows.map(row => {
    const names = row.record.events_zh.split('；');
    const shock = findShock(row, CONFIG.volumeMultiple, CONFIG.sigmaMultiple);
    return { eventCount: names.length, family: names[0], triggered: Boolean(shock), entrySecond: shock ? shock.second : null, shockRange: shock ? shock.shockRange : null };
  });

  const out = { dataset: path.basename(dir), minActiveRatio: minActive, usableWindows: rows.length, trades: trades.length, config: CONFIG };

  out.triggerRateByCount = [...group(windows, w => w.eventCount).entries()].sort().map(([count, list]) => ({
    eventCount: count, windows: list.length,
    triggered: list.filter(w => w.triggered).length,
    triggerRate: +(list.filter(w => w.triggered).length / list.length * 100).toFixed(1),
  }));

  out.performanceByCount = [...group(trades, t => t.eventCount).entries()].sort()
    .map(([count, list]) => describe('同时发布 ' + count + ' 项', list.map(t => t.pnl)));

  const one = trades.filter(t => t.eventCount === 1).map(t => t.pnl);
  const two = trades.filter(t => t.eventCount === 2).map(t => t.pnl);
  out.welchTwoVsOne = welch(two, one);

  const magnitude = (name, list) => ({
    group: name, trades: list.length,
    medianShockRange: list.length ? +[...list.map(t => t.shockRange)].sort((a, b) => a - b)[Math.floor(list.length / 2)].toFixed(3) : null,
    medianEntrySecond: list.length ? [...list.map(t => t.entrySecond)].sort((a, b) => a - b)[Math.floor(list.length / 2)] : null,
    medianSurge: list.length ? +[...list.map(t => t.surge)].sort((a, b) => a - b)[Math.floor(list.length / 2)].toFixed(1) : null,
  });
  out.shockSizeByCount = [...group(trades, t => t.eventCount).entries()].sort()
    .map(([count, list]) => magnitude('同时发布 ' + count + ' 项', list));

  // Event count is fully determined by the release: NFP and CPI always publish two indicators, PPI and the Fed one.
  out.familyByCount = [...group(trades, t => t.family).entries()]
    .map(([family, list]) => ({ family, eventCount: list[0].eventCount, ...describe(family, list.map(t => t.pnl)) }))
    .sort((a, b) => b.average - a.average);

  // Within the single-event group, comparing PPI against the Fed separates count from release identity.
  const singles = [...group(trades.filter(t => t.eventCount === 1), t => t.family).entries()]
    .map(([family, list]) => describe(family, list.map(t => t.pnl)));
  out.withinSingleEvent = singles;
  const doubles = [...group(trades.filter(t => t.eventCount === 2), t => t.family).entries()]
    .map(([family, list]) => describe(family, list.map(t => t.pnl)));
  out.withinDoubleEvent = doubles;

  // If count mattered on its own, the best single would not beat the worst double.
  const bestSingle = singles.reduce((a, b) => (b.average > a.average ? b : a), singles[0]);
  const worstDouble = doubles.reduce((a, b) => (b.average < a.average ? b : a), doubles[0]);
  out.confounding = {
    note: 'eventCount is fully determined by release identity in this calendar',
    bestSingle, worstDouble,
    singleBeatsDouble: bestSingle && worstDouble ? bestSingle.average > worstDouble.average : null,
  };

  out.earlyEntryByCount = [...group(trades, t => t.eventCount).entries()].sort().map(([count, list]) => ({
    eventCount: count,
    early: describe('0-2 秒', list.filter(t => t.entrySecond <= 2).map(t => t.pnl)),
    late: describe('3 秒以后', list.filter(t => t.entrySecond > 2).map(t => t.pnl)),
  }));

  const target = process.argv[3];
  if (target) { fs.writeFileSync(path.resolve(target), JSON.stringify(out, null, 2)); console.log('Written ' + target); }
  else console.log(JSON.stringify(out, null, 2));
}

module.exports = { describe, welch, group };
if (require.main === module) main();
