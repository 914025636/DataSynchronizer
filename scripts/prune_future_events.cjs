const fs = require('fs');
const path = require('path');
const { indexRecords } = require('./fetch_event_binance_1s.cjs');

const directory = path.resolve(process.argv[2] || '');
const manifestPath = path.join(directory, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const removed = manifest.tables.filter(item => item.status !== 'complete' && Date.parse(item.windowEndExclusiveUTC) > Date.now());
const unresolved = manifest.tables.filter(item => item.status !== 'complete' && Date.parse(item.windowEndExclusiveUTC) <= Date.now());
if (unresolved.length) throw new Error('Past events failed to download: ' + unresolved.map(i => i.eventTimeUTC).join(', '));

manifest.tables = manifest.tables.filter(item => item.status === 'complete').sort((a, b) => a.eventTimestampMs - b.eventTimestampMs);
manifest.complete = true;
manifest.pendingFutureEvents = removed.map(item => ({ eventTimeUTC: item.eventTimeUTC, events: item.events.map(e => e.event_zh || e.event) }));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const records = indexRecords(manifest.tables);
const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
const fields = Object.keys(records[0]);
fs.writeFileSync(path.join(directory, 'index.csv'), '\ufeff' + [fields.join(','), ...records.map(r => fields.map(f => cell(r[f])).join(','))].join('\r\n') + '\r\n');

console.log(JSON.stringify({ tables: manifest.tables.length, removedFutureEvents: manifest.pendingFutureEvents, rows: manifest.tables.reduce((n, i) => n + i.rows, 0) }, null, 2));
