const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const HORIZONS = [10, 60, 300, 900, 3600];

function readCandles(file) {
  const rows = parse(fs.readFileSync(file, 'utf8'), { columns: true, bom: true, skip_empty_lines: true });
  return rows.map(row => ({
    second: Number(row.relative_seconds),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
    volume: Number(row.volume_btc),
  }));
}

function analyse(candles) {
  const before = candles.filter(c => c.second < 0);
  const after = candles.filter(c => c.second >= 0);
  if (!before.length || !after.length) throw new Error('Window is missing pre-event or post-event candles');
  const base = after[0].open;
  if (!(base > 0)) throw new Error('Invalid event price');

  const range = rows => (Math.max(...rows.map(c => c.high)) / Math.min(...rows.map(c => c.low)) - 1) * 100;
  // Realised volatility from per-second log returns, scaled to a percentage of the window.
  const realised = rows => {
    let sum = 0;
    for (let i = 1; i < rows.length; i++) sum += Math.log(rows[i].close / rows[i - 1].close) ** 2;
    return Math.sqrt(sum) * 100;
  };

  const afterRange = range(after);
  const beforeRange = range(before);
  const afterRealised = realised(after);
  const beforeRealised = realised(before);
  const changes = {};
  for (const horizon of HORIZONS) {
    const candle = after.find(c => c.second === horizon - 1) || after[after.length - 1];
    changes[horizon] = (candle.close / base - 1) * 100;
  }
  const highest = after.reduce((best, c) => c.high > best.high ? c : best, after[0]);
  const lowest = after.reduce((best, c) => c.low < best.low ? c : best, after[0]);
  const up = (highest.high / base - 1) * 100;
  const down = (lowest.low / base - 1) * 100;

  return {
    eventPrice: base,
    afterRange, beforeRange,
    rangeRatio: beforeRange > 0 ? afterRange / beforeRange : null,
    afterRealised, beforeRealised,
    realisedRatio: beforeRealised > 0 ? afterRealised / beforeRealised : null,
    maxUp: up, maxDown: down,
    maxMove: Math.abs(up) >= Math.abs(down) ? up : down,
    maxUpSecond: highest.second, maxDownSecond: lowest.second,
    changes,
    afterVolume: after.reduce((sum, c) => sum + c.volume, 0),
    beforeVolume: before.reduce((sum, c) => sum + c.volume, 0),
  };
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (value, digits = 2) => value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const signed = (value, digits = 2) => !Number.isFinite(value) ? '—' : (value > 0 ? '+' : '') + value.toFixed(digits) + '%';
const cls = value => !Number.isFinite(value) ? '' : value > 0 ? 'up' : value < 0 ? 'down' : '';
const beijing = iso => new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function eventDetails(record) {
  const names = String(record.events_zh || '').split('；');
  const split = key => String(record[key] || '').split(';');
  const actual = split('actual'), forecast = split('forecast'), previous = split('previous');
  return names.map((name, i) => ({ name, actual: actual[i] || '', forecast: forecast[i] || '', previous: previous[i] || '' }));
}

function buildHtml(rows, meta) {
  const bars = rows.map(row => row.afterRange);
  const maxBar = Math.max(...bars);
  const body = rows.map((row, rank) => {
    const details = eventDetails(row.record).map(d => {
      const values = [d.actual && '公布 ' + d.actual, d.forecast && '预期 ' + d.forecast, d.previous && '前值 ' + d.previous].filter(Boolean).join(' · ');
      return '<div class="ev"><b>' + escapeHtml(d.name) + '</b>' + (values ? '<span>' + escapeHtml(values) + '</span>' : '<span class="muted">无数值事件</span>') + '</div>';
    }).join('');
    const horizons = HORIZONS.map(h => '<td class="' + cls(row.changes[h]) + '">' + signed(row.changes[h]) + '</td>').join('');
    return '<tr>' +
      '<td class="rank">' + (rank + 1) + '</td>' +
      '<td><div class="time">' + escapeHtml(beijing(row.record.event_time_utc)) + '</div>' + details + '</td>' +
      '<td class="strong">' + num(row.afterRange) + '%<div class="bar"><i style="width:' + (row.afterRange / maxBar * 100).toFixed(1) + '%"></i></div></td>' +
      '<td>' + num(row.beforeRange) + '%</td>' +
      '<td class="strong">' + num(row.rangeRatio) + '×</td>' +
      '<td class="' + cls(row.maxMove) + '">' + signed(row.maxMove) + '</td>' +
      '<td class="up">' + signed(row.maxUp) + '</td>' +
      '<td class="down">' + signed(row.maxDown) + '</td>' +
      horizons +
      '<td>' + num(row.afterVolume, 1) + '</td>' +
      '<td>' + num(row.beforeVolume, 1) + '</td>' +
      '</tr>';
  }).join('\n');

  const summary = [
    ['事件窗口数', rows.length + ' 个'],
    ['波动最大', beijing(rows[0].record.event_time_utc) + '，公布后振幅 ' + num(rows[0].afterRange) + '%'],
    ['波动最小', beijing(rows[rows.length - 1].record.event_time_utc) + '，公布后振幅 ' + num(rows[rows.length - 1].afterRange) + '%'],
    ['振幅中位数', num(rows.map(r => r.afterRange).sort((a, b) => a - b)[Math.floor(rows.length / 2)]) + '%'],
    ['放大倍数中位数', num([...rows.map(r => r.rangeRatio)].filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(rows.length / 2)]) + '×'],
  ].map(([label, value]) => '<div class="card"><span>' + escapeHtml(label) + '</span><b>' + escapeHtml(value) + '</b></div>').join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>美国重要经济事件公布后波动率排序</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: #131722; color: #d1d4dc; font: 13px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .meta { color: #868993; font-size: 12px; margin-bottom: 14px; }
  .cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
  .card { background: #1a1e2a; border: 1px solid #2a2e39; border-radius: 5px; padding: 8px 12px; }
  .card span { display: block; color: #868993; font-size: 12px; }
  .card b { font-size: 14px; }
  table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
  th, td { border-bottom: 1px solid #232733; padding: 8px 9px; text-align: right; vertical-align: top; white-space: nowrap; }
  th { position: sticky; top: 0; background: #1a1e2a; color: #868993; font-weight: 600; font-size: 12px; text-align: right; }
  th:nth-child(2), td:nth-child(2) { text-align: left; white-space: normal; min-width: 300px; }
  tbody tr:hover { background: #1a1e2a; }
  .rank { color: #868993; }
  .strong { font-weight: 600; }
  .time { color: #d1d4dc; font-weight: 600; margin-bottom: 2px; }
  .ev { font-size: 12px; color: #868993; }
  .ev b { color: #b7bac2; font-weight: 600; margin-right: 6px; }
  .muted { color: #5c6070; }
  .up { color: #26a69a; }
  .down { color: #ef5350; }
  .bar { height: 3px; background: #232733; border-radius: 2px; margin-top: 4px; }
  .bar i { display: block; height: 3px; background: #f5c542; border-radius: 2px; }
  .note { color: #868993; font-size: 12px; margin-top: 14px; }
</style>
</head>
<body>
<h1>美国重要经济事件公布后波动率排序</h1>
<div class="meta">币安 BTC/USDT 现货 · 1 秒 K 线 · 公布后 60 分钟 vs 公布前 30 分钟 · 数据源 ${escapeHtml(meta.source)} · 生成于 ${escapeHtml(beijing(meta.generatedAt))}（北京时间）</div>
<div class="cards">${summary}</div>
<table>
<thead><tr>
<th>#</th><th>公布时间（北京时间）与事件</th><th>公布后振幅</th><th>公布前振幅</th><th>放大倍数</th>
<th>最大冲击</th><th>最大上冲</th><th>最大下挫</th>
${HORIZONS.map(h => '<th>' + (h < 60 ? h + ' 秒' : h / 60 + ' 分钟') + '</th>').join('')}
<th>后成交量</th><th>前成交量</th>
</tr></thead>
<tbody>
${body}
</tbody>
</table>
<div class="note">
振幅＝区间内最高价与最低价之比减一。放大倍数＝公布后振幅 ÷ 公布前振幅，衡量事件带来的波动放大程度。<br>
最大冲击、各时间点涨跌幅均以公布当秒的开盘价为基准；最大上冲取窗口最高价，最大下挫取窗口最低价。成交量单位为 BTC。<br>
同一时刻的多个事件共用一个行情窗口，无法据此区分各自的影响。价格波动还受同期其他消息与市场环境影响，本表不构成因果结论。
</div>
</body>
</html>
`;
}

function main() {
  const directory = path.resolve(process.argv[2] || '');
  const index = parse(fs.readFileSync(path.join(directory, 'index.csv'), 'utf8'), { columns: true, bom: true, skip_empty_lines: true });
  const rows = index.filter(record => record.status === 'complete').map(record => {
    const candles = readCandles(path.join(directory, record.file));
    if (candles.length !== Number(record.rows)) throw new Error('Row count mismatch in ' + record.file);
    return { record, ...analyse(candles) };
  });
  if (!rows.length) throw new Error('No complete windows found');
  rows.sort((a, b) => b.afterRange - a.afterRange);
  const output = path.join(directory, 'volatility-report.html');
  fs.writeFileSync(output, buildHtml(rows, { source: path.basename(directory), generatedAt: new Date().toISOString() }));
  console.log(JSON.stringify({
    output, events: rows.length,
    top: rows.slice(0, 5).map(r => ({ time: r.record.event_time_utc, events: r.record.events_zh, afterRange: +r.afterRange.toFixed(2), ratio: +r.rangeRatio.toFixed(2), maxMove: +r.maxMove.toFixed(2) })),
    bottom: rows.slice(-3).map(r => ({ time: r.record.event_time_utc, events: r.record.events_zh, afterRange: +r.afterRange.toFixed(2) })),
  }, null, 2));
}

module.exports = { analyse, HORIZONS };
if (require.main === module) main();
