const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('csv-parse/sync');
const { groupEvents, validateCandles, candleCsv, fetchWindow, EXPECTED } = require('./fetch_event_binance_1s.cjs');
const time = Date.parse('2026-06-09T14:00:00Z');
const candles = Array.from({ length: EXPECTED }, (_, i) => [time - 1800000 + i * 1000, 100, 102, 99, 101, 0]);

test('Group by timestamp, preserving different simultaneous events and quoted CSV fields', () => {
  const groups = groupEvents('\ufeffdate,dateSpan,event\r\n' + time + ',0,"event, one"\r\n' + time + ',0,event two\r\n');
  assert.equal(groups.length, 1);
  assert.equal(groups[0][1].length, 2);
  assert.equal(groups[0][1][0].event, 'event, one');
  assert.throws(() => groupEvents('date,dateSpan\n' + time + ',1'));
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