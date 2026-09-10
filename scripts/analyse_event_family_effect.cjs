const fs = require('fs');
const path = require('path');
const { load, findShock, trade } = require('./analyse_event_shock_trend.cjs');

const CONFIG = { volumeMultiple: 5, sigmaMultiple: 3, trailMultiple: 1.5, stopFloor: 0.1, maxHoldSeconds: 3600 };
const pct = (value, base) => (value / base - 1) * 100;
const sum = values => values.reduce((a, b) => a + b, 0);
const median = values => (values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null);

function summarise(pnls) {
  if (!pnls.length) return { trades: 0 };
  const wins = pnls.filter(p => p > 0);
  const grossLoss = -sum(pnls.filter(p => p <= 0));
  return {
    trades: pnls.length,
    winRate: +(wins.length / pnls.length * 100).toFixed(1),
    average: +(sum(pnls) / pnls.length).toFixed(3),
    median: +median(pnls).toFixed(3),
    total: +sum(pnls).toFixed(2),
    profitFactor: grossLoss > 0 ? +(sum(wins) / grossLoss).toFixed(2) : null,
    best: +Math.max(...pnls).toFixed(2), worst: +Math.min(...pnls).toFixed(2),
    net010: +(sum(pnls) - pnls.length * 0.1).toFixed(2),
  };
}

// Bootstrap the mean so a family carried by one lucky trade shows a wide interval.
function bootstrapMean(pnls, iterations = 4000, seed = 12345) {
  if (pnls.length < 3) return null;
  let state = seed;
  const next = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (let j = 0; j < pnls.length; j++) total += pnls[Math.floor(next() * pnls.length)];
    means.push(total / pnls.length);
  }
  means.sort((a, b) => a - b);
  return {
    low: +means[Math.floor(iterations * 0.025)].toFixed(3),
    high: +means[Math.floor(iterations * 0.975)].toFixed(3),
    positiveShare: +(means.filter(m => m > 0).length / iterations * 100).toFixed(1),
  };
}

// How much of a family's profit rests on its single best trade.
function concentration(pnls) {
  const total = sum(pnls);
  if (!pnls.length || total === 0) return null;
  const sorted = [...pnls].sort((a, b) => b - a);
  return {
    topTradeShare: +(sorted[0] / total * 100).toFixed(1),
    top3Share: +(sum(sorted.slice(0, 3)) / total * 100).toFixed(1),
    totalExclTop: +(total - sorted[0]).toFixed(2),
    averageExclTop: pnls.length > 1 ? +((total - sorted[0]) / (pnls.length - 1)).toFixed(3) : null,
  };
}

function directionAgreement(items, horizon) {
  const valid = items.filter(item => item.index + horizon < item.row.after.length);
  if (!valid.length) return null;
  const same = valid.filter(item => Math.sign(pct(item.row.after[item.index + horizon].close, item.shock.entry)) === item.shock.side);
  return +(same.length / valid.length * 100).toFixed(1);
}

function main() {
  const dir = path.resolve(process.argv[2] || '');
  const minActive = Number(process.env.MIN_ACTIVE_RATIO ?? 0.05);
  const all = load(dir);
  const rows = all.filter(row => row.baseline.activeRatio >= minActive);

  const windows = rows.map(row => {
    const family = row.record.events_zh.split('；')[0];
    const shock = findShock(row, CONFIG.volumeMultiple, CONFIG.sigmaMultiple);
    const item = { row, family, shock, year: row.record.event_time_utc.slice(0, 4) };
    if (shock) {
      item.index = row.after.findIndex(c => c.second === shock.second);
      Object.assign(item, trade(row, shock, CONFIG));
    }
    return item;
  });

  const families = [...new Set(windows.map(w => w.family))];
  const out = { dataset: path.basename(dir), minActiveRatio: minActive, usableWindows: rows.length, allWindows: all.length, config: CONFIG, families: [] };

  for (const family of families) {
    const group = windows.filter(w => w.family === family);
    const traded = group.filter(w => w.shock);
    const pnls = traded.map(w => w.pnl);
    const entry = { family, windows: group.length, triggered: traded.length, triggerRate: +(traded.length / group.length * 100).toFixed(1) };
    Object.assign(entry, summarise(pnls));
    entry.confidence = bootstrapMean(pnls);
    entry.concentration = concentration(pnls);
    entry.shock = {
      medianRange: traded.length ? +median(traded.map(w => w.shock.shockRange)).toFixed(3) : null,
      medianSurge: traded.length ? +median(traded.map(w => w.shock.surge)).toFixed(1) : null,
      medianEntrySecond: traded.length ? median(traded.map(w => w.shock.second)) : null,
      earlyShare: traded.length ? +(traded.filter(w => w.shock.second <= 2).length / traded.length * 100).toFixed(1) : null,
      longShare: traded.length ? +(traded.filter(w => w.shock.side > 0).length / traded.length * 100).toFixed(1) : null,
    };
    entry.persistence = {
      same60s: directionAgreement(traded, 60), same300s: directionAgreement(traded, 300),
      same900s: directionAgreement(traded, 900), same3000s: directionAgreement(traded, 3000),
    };
    entry.baselineVolatility = {
      medianSigma: +median(group.map(w => w.row.baseline.sigma)).toFixed(4),
      medianActiveRatio: +median(group.map(w => w.row.baseline.activeRatio)).toFixed(3),
    };
    entry.exit = {
      trails: traded.filter(w => w.result === 'trail').length,
      timeouts: traded.filter(w => w.result === 'timeout').length,
      medianHoldSeconds: traded.length ? median(traded.map(w => w.exitSecond - w.shock.second)) : null,
    };
    entry.byEntryTiming = {
      early: summarise(traded.filter(w => w.shock.second <= 2).map(w => w.pnl)),
      late: summarise(traded.filter(w => w.shock.second > 2).map(w => w.pnl)),
    };
    entry.byYear = [...new Set(group.map(w => w.year))].sort().map(year => ({
      year, ...summarise(traded.filter(w => w.year === year).map(w => w.pnl)),
    }));
    out.families.push(entry);
  }
  out.families.sort((a, b) => b.average - a.average);

  // A family is only worth trading if it survives cost and is not one trade away from breaking even.
  out.ranking = out.families.map(f => ({
    family: f.family, trades: f.trades, average: f.average, net010: f.net010,
    ciLow: f.confidence ? f.confidence.low : null, ciHigh: f.confidence ? f.confidence.high : null,
    positiveShare: f.confidence ? f.confidence.positiveShare : null,
    averageExclTop: f.concentration ? f.concentration.averageExclTop : null,
    verdict: f.net010 > 0 && f.confidence && f.confidence.low > 0 ? 'keep'
      : f.net010 > 0 ? 'marginal' : 'drop',
  }));

  const target = process.argv[3];
  if (target) { fs.writeFileSync(path.resolve(target), JSON.stringify(out, null, 2)); console.log('Written ' + target); }
  else console.log(JSON.stringify(out, null, 2));
}

module.exports = { summarise, bootstrapMean, concentration, directionAgreement };
if (require.main === module) main();
