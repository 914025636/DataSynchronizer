const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('csv-parse/sync');
const { groupEvents, validateCandles, candleCsv, fetchWindow, indexRecords, EXPECTED } = require('./fetch_event_binance_1s.cjs');
const time = Date.parse('2026-06-09T14:00:00Z');
const candles = Array.from({ length: EXPECTED }, (_, i) => [time - 1800000 + i * 1000, 100, 102, 99, 101, 0]);

test('Group by timestamp, preserving different simultaneous events and quoted CSV fields', () => {
  const groups = groupEvents('\ufeffdate,dateSpan,event\r\n' + time + ',0,"event, one"\r\n' + time + ',0,event two\r\n');
  assert.equal(groups.length, 1);
  assert.equal(groups[0][1].length, 2);
  assert.equal(groups[0][1][0].event, 'event, one');
  assert.throws(() => groupEvents('date,dateSpan\n' + time + ',1'));
});

test('Read the official schedule columns and merge events sharing one release time', () => {
  const header = 'event_time_utc,event_timestamp_ms,event_en,event_zh,region,importance,source,note\r\n';
  const row = (name, zh) => new Date(time).toISOString() + ',' + time + ',' + name + ',' + zh + ',United States,3,BLS,note\r\n';
  const groups = groupEvents('\ufeff' + header + row('Non Farm Payrolls', '非农就业人数') + row('Unemployment Rate', '失业率'));
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0], time);
  assert.equal(groups[0][1].length, 2);
  assert.equal(groups[0][1][1].event_zh, '失业率');
  assert.equal(groups[0][1][0].actual, '', 'The schedule carries no published values');
  assert.throws(() => groupEvents(header + '2026-01-01T00:00:00.000Z,' + time + ',E,中,United States,3,BLS,n'), /disagree/);
});

test('Require every second and valid OHLCV, allowing zero-volume candles', () => {
  validateCandles(candles, time);
  assert.throws(() => validateCandles(candles.slice(1), time));
  const gap = candles.map(row => [...row]); gap[5][0] += 1000;
  assert.throws(() => validateCandles(gap, time));
  const invalid = candles.map(row => [...row]); invalid[5][2] = 90;
  assert.throws(() => validateCandles(invalid, time));
});

test('CSV contains exactly 1800 pre-event and 3600 event/post-event seconds', () => {
  const rows = parse(candleCsv(candles, time), { bom: true, columns: true });
  assert.equal(rows.length, 5400);
  assert.equal(rows[0].relative_seconds, '-1800');
  assert.equal(rows[1800].relative_seconds, '0');
  assert.equal(rows[5399].relative_seconds, '3599');
});

test('Fetch six pages with explicit endTime and native one-second spot symbol', async () => {
  let calls = 0;
  const exchange = { fetchOHLCV: async (symbol, interval, since, limit, params) => {
    calls++;
    assert.equal(symbol, 'BTC/USDT'); assert.equal(interval, '1s');
    assert.equal(params.endTime, time + 3600000 - 1);
    return candles.filter(row => row[0] >= since).slice(0, limit);
  } };
  assert.deepEqual(await fetchWindow(exchange, time), candles);
  assert.equal(calls, 6);
});

test('Never fill a missing historical candle with an invented price', async () => {
  const exchange = { fetchOHLCV: async (_symbol, _interval, since, limit) => candles.filter(row => row[0] >= since && row[0] !== time).slice(0, limit) };
  await assert.rejects(fetchWindow(exchange, time));
});

test('Index keeps each event value aligned and preserves empty fields', () => {
  const [record] = indexRecords([{ eventTimeUTC: 'iso', eventTimestampMs: time, windowStartUTC: 'a', windowEndExclusiveUTC: 'b', rows: 5400, status: 'complete', file: 'f.csv',
    events: [
      { calendarId: '1', event: 'Non Farm Payrolls', event_zh: '非农就业人数', actual: '162K', forecast: '56K', previous: '21K', prevInitial: '-23K', unit: 'K', ccy: '', importance: '3', region: 'United States' },
      { calendarId: '2', event: 'Fed Speech', event_zh: '美联储讲话', actual: '', forecast: '', previous: '', prevInitial: '', unit: '', ccy: '', importance: '3', region: 'United States' },
    ] }]);
  assert.equal(record.actual, '162K;');
  assert.equal(record.forecast, '56K;');
  assert.equal(record.prev_initial, '-23K;');
  assert.equal(record.events_zh, '非农就业人数；美联储讲话');
  assert.equal(record.actual.split(';').length, record.calendar_ids.split(';').length);
});