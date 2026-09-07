const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const eventTranslations = require('./okx_calendar_event_zh.json');

function writeCalendarCsv(data, csvPath) {
  const fields = ['calendarId', 'dateUTC', 'date', 'region', 'category', 'event', 'event_zh', 'importance', 'actual', 'forecast', 'previous', 'prevInitial', 'refDate', 'dateSpan', 'uTime', 'ccy', 'unit'];
  const untranslated = new Set();
  const csvCell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  const records = data.map(row => {
    const translated = Object.prototype.hasOwnProperty.call(eventTranslations, row.event) ? eventTranslations[row.event] : '';
    if (!translated) untranslated.add(row.event);
    const values = { ...row, dateUTC: new Date(Number(row.date)).toISOString(), event_zh: translated || '待翻译：' + row.event };
    return fields.map(field => csvCell(values[field])).join(',');
  });
  fs.writeFileSync(csvPath, '\ufeff' + [fields.join(','), ...records].join('\r\n'));
  if (untranslated.size) console.warn('Untranslated events: ' + JSON.stringify([...untranslated]));
  return { rows: data.length, untranslated: untranslated.size };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  if (process.argv[2] === '--from-json') {
    const source = process.argv[3];
    if (!source || !source.toLowerCase().endsWith('.json')) throw new Error('Expected a calendar JSON file after --from-json');
    const jsonPath = path.resolve(source);
    const body = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!Array.isArray(body.data)) throw new Error('Expected a data array in calendar JSON');
    const csvPath = jsonPath.replace(/\.json$/i, '.csv');
    console.log(JSON.stringify({ csvPath, ...writeCalendarCsv(body.data, csvPath) }));
    return;
  }
  const options = {};
  const allowed = new Set(['--start', '--end', '--importance', '--region']);
  for (let i = 2; i < process.argv.length; i += 2) {
    const option = process.argv[i];
    const value = process.argv[i + 1];
    if (!allowed.has(option) || !value || value.startsWith('--')) throw new Error('Invalid calendar query arguments');
    options[option.slice(2)] = value;
  }
  if (options.importance && !['1', '2', '3'].includes(options.importance)) throw new Error('Importance must be 1, 2, or 3');
  if (options.region && !/^[a-z_]+$/.test(options.region)) throw new Error('Invalid region');
  const end = options.end ? new Date(options.end) : new Date();
  const start = new Date(end);
  const day = start.getUTCDate();
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 1);
  const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  start.setUTCDate(Math.min(day, lastDay));
  if (options.start) start.setTime(Date.parse(options.start));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error('Invalid date range');
  const raw = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const env = { ...process.env, ...require('dotenv').parse(raw) };
  for (const name of ['okx_apiKey', 'okx_secretKey', 'okx_passphrase']) {
    if (!env[name]) {
      const match = raw.match(new RegExp('^' + name + '[ \\t]*=[ \\t]*\\r?\\n([^\\r\\n]+)', 'm'));
      if (match && !match[1].trim().startsWith('#')) env[name] = match[1].trim();
    }
  }
  const key = env.OKX_API_KEY || env.okx_apiKey;
  const secret = env.OKX_API_SECRET || env.okx_secretKey;
  const passphrase = env.OKX_API_PASSPHRASE || env.okx_passphrase;
  if (!key || !secret || !passphrase) throw new Error('Missing OKX credentials');
  const { SocksProxyAgent } = await import('socks-proxy-agent');
  const agent = env.CCXT_SOCKS_PROXY_OKX ? new SocksProxyAgent(env.CCXT_SOCKS_PROXY_OKX) : undefined;
  const rows = new Map();
  let requests = 0;
  let lastRequest = 0;
  const redact = value => [key, secret, passphrase].reduce((text, item) => text.split(item).join('[REDACTED]'), String(value));

  async function request(lower, upper) {
    const delay = Math.max(0, lastRequest + 5200 - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (++requests > 250) throw new Error('Request safety limit reached; export incomplete');
    const query = new URLSearchParams({ before: String(lower), after: String(upper), limit: '100' });
    if (options.importance) query.set('importance', options.importance);
    if (options.region) query.set('region', options.region);
    const requestPath = '/api/v5/public/economic-calendar?' + query;
    const timestamp = new Date().toISOString();
    const signature = crypto.createHmac('sha256', secret).update(timestamp + 'GET' + requestPath).digest('base64');
    lastRequest = Date.now();
    const response = await fetch('https://www.okx.com' + requestPath, {
      agent, timeout: 25000,
      headers: { 'OK-ACCESS-KEY': key, 'OK-ACCESS-SIGN': signature, 'OK-ACCESS-TIMESTAMP': timestamp, 'OK-ACCESS-PASSPHRASE': passphrase },
    });
    let body;
    try { body = await response.json(); } catch { throw new Error('Non-JSON response, HTTP ' + response.status); }
    if (!response.ok || body.code !== '0') throw new Error('HTTP ' + response.status + ', OKX ' + body.code + ': ' + redact(body.msg));
    if (!Array.isArray(body.data)) throw new Error('Unexpected response data');
    for (const row of body.data) {
      const date = Number(row.date);
      if (!Number.isFinite(date) || !row.calendarId) throw new Error('Invalid calendar record');
      if (date >= start.getTime() && date <= end.getTime()) rows.set(row.calendarId, row);
    }
    console.log(JSON.stringify({ request: requests, received: body.data.length, unique: rows.size, oldestUTC: body.data.length ? new Date(Math.min(...body.data.map(row => Number(row.date)))).toISOString() : null }));
    return body.data;
  }

  let upper = end.getTime() + 1;
  while (true) {
    const page = await request(start.getTime() - 1, upper);
    if (page.length < 100) break;
    const oldest = Math.min(...page.map(row => Number(row.date)));
    // Overlap the boundary millisecond so simultaneous events are not silently skipped.
    const next = oldest + 1;
    if (next >= upper) throw new Error('A timestamp exceeds pagination capacity; export incomplete');
    upper = next;
  }

  const data = [...rows.values()].sort((a, b) => Number(b.date) - Number(a.date) || a.calendarId.localeCompare(b.calendarId));
  const importance = {};
  const regions = {};
  for (const row of data) {
    importance[row.importance] = (importance[row.importance] || 0) + 1;
    regions[row.region] = (regions[row.region] || 0) + 1;
  }
  const metadata = {
    fetchedAt: new Date().toISOString(), startUTC: start.toISOString(), endUTC: end.toISOString(),
    filters: { importance: options.importance || 'all', region: options.region || 'all' },
    coverageNote: 'Pagination exhausted for this account; empty history does not prove full historical coverage.',
    count: data.length, requests, importance, regionCount: Object.keys(regions).length,
    oldestUTC: data.length ? new Date(Number(data[data.length - 1].date)).toISOString() : null,
    newestUTC: data.length ? new Date(Number(data[0].date)).toISOString() : null,
    topRegions: Object.entries(regions).sort((a, b) => b[1] - a[1]).slice(0, 10),
  };
  const directory = path.join(root, 'exports');
  fs.mkdirSync(directory, { recursive: true });
  const label = options.start || options.importance || options.region
    ? 'from-' + start.toISOString().slice(0, 10) + '-' + (options.region || 'all') + '-importance-' + (options.importance || 'all') + '-'
    : '';
  const base = 'okx-economic-calendar-' + label + end.toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(directory, base + '.json');
  const csvPath = path.join(directory, base + '.csv');
  fs.writeFileSync(jsonPath, JSON.stringify({ metadata, code: '0', data, msg: '' }, null, 2));
  writeCalendarCsv(data, csvPath);
  console.log('SUMMARY ' + JSON.stringify(metadata));
  console.log('FILES ' + JSON.stringify({ json: path.relative(root, jsonPath), csv: path.relative(root, csvPath) }));
  console.log('SAMPLE ' + JSON.stringify(data.filter(row => row.importance === '3' && row.region === 'United States').slice(0, 8), null, 2));
}

main().catch(error => {
  console.error(error.type || error.code ? 'Request failed: ' + (error.code || error.type) : error.message);
  process.exitCode = 1;
});