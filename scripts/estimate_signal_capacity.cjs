const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const pct = (value, base) => (value / base - 1) * 100;
const dir = path.resolve(process.argv[2] || '');
const index = parse(fs.readFileSync(path.join(dir, 'index.csv'), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
  .filter(r => r.status === 'complete');

const rows = index.map(record => {
  const candles = parse(fs.readFileSync(path.join(dir, record.file), 'utf8'), { columns: true, bom: true, skip_empty_lines: true })
    .map(x => ({ second: +x.relative_seconds, open: +x.open, high: +x.high, low: +x.low, close: +x.close, volume: +x.volume_btc }));
  const after = candles.filter(c => c.second >= 0);
  const before = candles.filter(c => c.second < 0);
  const base = after[0].open;
  return {
    record, after, before, base,
    signal2s: pct(after[1].close, base),
    preVolumePerSecond: before.reduce((s, c) => s + c.volume, 0) / before.length,
    volume2s: (after[0].volume + after[1].volume) / 2,
  };
});

const classify = name => name.includes('非农') || name.includes('失业率') ? '非农与失业率'
  : name.includes('通胀') ? 'CPI'
  : name.includes('利率决议') || name.includes('FOMC') ? '利率决议'
  : name.includes('GDP') || name.includes('国内生产总值') ? 'GDP' : '其他';

const out = {
  windows: rows.length,
  perYear: rows.reduce((a, r) => { a[r.record.event_time_utc.slice(0, 4)] = (a[r.record.event_time_utc.slice(0, 4)] || 0) + 1; return a; }, {}),
  byThreshold: [0.15, 0.2, 0.25, 0.3].map(t => {
    const hits = rows.filter(r => Math.abs(r.signal2s) >= t);
    const perYear = hits.reduce((a, r) => { a[r.record.event_time_utc.slice(0, 4)] = (a[r.record.event_time_utc.slice(0, 4)] || 0) + 1; return a; }, {});
    const byType = hits.reduce((a, r) => { const k = classify(r.record.events_zh); a[k] = (a[k] || 0) + 1; return a; }, {});
    return { threshold: t, signals: hits.length, signalsPerYear: +(hits.length / 2.67).toFixed(1), perYear, byType };
  }),
  // How many windows would qualify if the volume surge were used instead of price alone.
  volumeGate: [10, 20, 40].map(multiple => ({
    multiple,
    windows: rows.filter(r => r.volume2s >= r.preVolumePerSecond * multiple).length,
    withPrice015: rows.filter(r => r.volume2s >= r.preVolumePerSecond * multiple && Math.abs(r.signal2s) >= 0.15).length,
  })),
  triggerRateByType: Object.entries(rows.reduce((a, r) => {
    const k = classify(r.record.events_zh);
    (a[k] ??= { windows: 0, hits02: 0 });
    a[k].windows++;
    if (Math.abs(r.signal2s) >= 0.2) a[k].hits02++;
    return a;
  }, {})).map(([type, v]) => ({ type, ...v, rate: +(v.hits02 / v.windows * 100).toFixed(1) })).sort((a, b) => b.rate - a.rate),
};

console.log(JSON.stringify(out, null, 2));
