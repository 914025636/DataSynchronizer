const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const ccxt = require('ccxt');
const { parse } = require('csv-parse/sync');

const BEFORE = 1800000;
const AFTER = 3600000;
const EXPECTED = (BEFORE + AFTER) / 1000;
const FIELDS = ['event_time_utc', 'event_timestamp_ms', 'timestamp_ms', 'time_utc', 'relative_seconds', 'open', 'high', 'low', 'close', 'volume_btc'];

function groupEvents(text) {
  const records = parse(text, { columns: true, bom: true, skip_empty_lines: true });
  const groups = new Map();
  for (const record of records) {
    const time = Number(record.date);
    if (!record.date || !Number.isSafeInteger(time) || time % 1000 !== 0 || !Number.isFinite(new Date(time).getTime())) throw new Error('Invalid event timestamp');
    if (record.dateSpan !== '0') throw new Error('Event time is not precise: ' + record.calendarId);
    if (record.dateUTC && Date.parse(record.dateUTC) !== time) throw new Error('Event date columns disagree');
    if (!groups.has(time)) groups.set(time, []);
    groups.get(time).push(record);
  }
  if (!groups.size) throw new Error('No events in input');
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

function validateCandles(candles, eventTime) {
  assert.equal(candles.length, EXPECTED, 'Incomplete one-second window');
  for (let i = 0; i < candles.length; i++) {
    const [time, open, high, low, close, volume] = candles[i];
    assert.equal(time, eventTime - BEFORE + i * 1000, 'Missing, duplicate or unordered timestamp');
    assert([open, high, low, close, volume].every(Number.isFinite), 'Non-finite OHLCV');
    assert(low > 0 && high >= low && low <= open && open <= high && low <= close && close <= high && volume >= 0, 'Invalid OHLCV values');
  }
}

function csv(columns, records) {
  const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  return '\ufeff' + [columns.map(cell).join(','), ...records.map(record => columns.map(key => cell(record[key])).join(','))].join('\r\n') + '\r\n';
}

function candleCsv(candles, eventTime) {
  return csv(FIELDS, candles.map(([time, open, high, low, close, volume]) => ({
    event_time_utc: new Date(eventTime).toISOString(), event_timestamp_ms: eventTime,
    timestamp_ms: time, time_utc: new Date(time).toISOString(), relative_seconds: (time - eventTime) / 1000,
    open, high, low, close, volume_btc: volume,
  })));
}

function readExisting(file, eventTime) {
  const records = parse(fs.readFileSync(file, 'utf8'), { columns: true, bom: true, skip_empty_lines: true });
  assert.deepEqual(Object.keys(records[0] || {}), FIELDS, 'Unexpected CSV columns');
  const candles = records.map(row => {
    assert.equal(Number(row.event_timestamp_ms), eventTime);
    assert.equal(row.event_time_utc, new Date(eventTime).toISOString());
    assert.equal(row.time_utc, new Date(Number(row.timestamp_ms)).toISOString());
    assert.equal(Number(row.relative_seconds), (Number(row.timestamp_ms) - eventTime) / 1000);
    return [row.timestamp_ms, row.open, row.high, row.low, row.close, row.volume_btc].map(Number);
  });
  validateCandles(candles, eventTime);
  return candles;
}

async function fetchWindow(exchange, eventTime) {
  const start = eventTime - BEFORE;
  const end = eventTime + AFTER;
  if (end > Date.now() - 1000) throw new Error('Window includes unfinished candles');
  const byTime = new Map();
  let cursor = start;
  while (cursor < end) {
    let batch;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        batch = await exchange.fetchOHLCV('BTC/USDT', '1s', cursor, 1000, { endTime: end - 1 });
        break;
      } catch (error) {
        if (!(error instanceof ccxt.NetworkError) || attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.max(error instanceof ccxt.RateLimitExceeded ? 60000 : 1000, 1000 * 2 ** attempt)));
      }
    }
    if (!batch.length) throw new Error('Empty historical page at ' + new Date(cursor).toISOString());
    let latest = cursor - 1;
    for (const candle of batch) {
      if (candle[0] >= cursor && candle[0] < end) {
        byTime.set(candle[0], candle);
        latest = Math.max(latest, candle[0]);
      }
    }
    if (latest < cursor) throw new Error('Pagination made no progress');
    cursor = latest + 1000;
  }
  const candles = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  validateCandles(candles, eventTime);
  return candles;
}

async function main() {
  if (!process.argv[2]) throw new Error('Expected input calendar CSV path');
  const input = path.resolve(process.argv[2]);
  const output = process.argv[3] ? path.resolve(process.argv[3]) : path.join(path.dirname(input), path.basename(input, '.csv') + '-binance-btcusdt-1s');
  const groups = groupEvents(fs.readFileSync(input, 'utf8'));
  fs.mkdirSync(output, { recursive: true });
  const env = { ...require('dotenv').parse(fs.readFileSync(path.resolve(__dirname, '../.env'))), ...process.env };
  const exchange = new ccxt.binance({ enableRateLimit: true, rateLimit: 200, timeout: 30000, options: { defaultType: 'spot', fetchMarkets: { types: ['spot'] } } });
  // Match the project's node-fetch transport because native fetch is incompatible with the SOCKS agent.
  exchange.fetchImplementation = require('node-fetch');
  const socks = env.CCXT_SOCKS_PROXY_BINANCE || env.CCXT_SOCKS_PROXY;
  const https = env.CCXT_HTTPS_PROXY_BINANCE || env.CCXT_HTTPS_PROXY;
  if (socks) exchange.socksProxy = socks;
  else if (https) exchange.httpsProxy = https;
  const manifest = {
    source: path.relative(path.resolve(__dirname, '..'), input), exchange: 'binance', marketType: 'spot', symbol: 'BTC/USDT', timeframe: '1s', ccxtVersion: ccxt.version,
    window: '[event - 30 minutes, event + 60 minutes)', expectedRowsPerTable: EXPECTED,
    eventRecords: groups.reduce((n, [, events]) => n + events.length, 0), uniqueEventTimes: groups.length,
    startedAt: new Date().toISOString(), complete: false, tables: [],
  };
  const saveManifest = () => fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  try {
    await exchange.loadMarkets();
    assert(exchange.market('BTC/USDT').spot && exchange.timeframes['1s']);
    for (const [eventTime, events] of groups) {
      const name = 'BTCUSDT-spot-1s-event-' + new Date(eventTime).toISOString().replace(/[:.]/g, '-') + '.csv';
      const file = path.join(output, name);
      const item = { eventTimeUTC: new Date(eventTime).toISOString(), eventTimestampMs: eventTime, windowStartUTC: new Date(eventTime - BEFORE).toISOString(), windowEndExclusiveUTC: new Date(eventTime + AFTER).toISOString(), file: name, events };
      try {
        const existing = fs.existsSync(file);
        const candles = existing ? readExisting(file, eventTime) : await fetchWindow(exchange, eventTime);
        if (!existing) fs.writeFileSync(file, candleCsv(candles, eventTime), { flag: 'wx' });
        readExisting(file, eventTime);
        Object.assign(item, { status: 'complete', rows: candles.length, beforeRows: 1800, fromEventRows: 3600 });
        console.log(JSON.stringify({ table: manifest.tables.length + 1, total: groups.length, event: item.eventTimeUTC, rows: candles.length, reused: existing }));
      } catch (error) {
        Object.assign(item, { status: 'failed', errorType: error.constructor.name });
        console.error(JSON.stringify({ event: item.eventTimeUTC, errorType: item.errorType }));
      }
      manifest.tables.push(item);
      saveManifest();
    }
  } finally {
    await exchange.close();
  }
  manifest.complete = manifest.tables.length === groups.length && manifest.tables.every(item => item.status === 'complete');
  manifest.finishedAt = new Date().toISOString();
  saveManifest();
  const index = manifest.tables.map(item => ({ event_time_utc: item.eventTimeUTC, event_timestamp_ms: item.eventTimestampMs,
    calendar_ids: item.events.map(event => event.calendarId).join(';'), events_zh: item.events.map(event => event.event_zh || event.event).join('；'),
    window_start_utc: item.windowStartUTC, window_end_exclusive_utc: item.windowEndExclusiveUTC, rows: item.rows || 0, status: item.status, file: item.file }));
  fs.writeFileSync(path.join(output, 'index.csv'), csv(Object.keys(index[0]), index));
  console.log('SUMMARY ' + JSON.stringify({ output, complete: manifest.complete, tables: manifest.tables.length, rows: manifest.tables.reduce((n, item) => n + (item.rows || 0), 0) }));
  if (!manifest.complete) process.exitCode = 1;
}

module.exports = { groupEvents, validateCandles, candleCsv, readExisting, fetchWindow, EXPECTED };
if (require.main === module) main().catch(error => { console.error('Collector failed: ' + error.constructor.name); process.exitCode = 1; });