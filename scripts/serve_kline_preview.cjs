const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../exports');
const port = Number(process.argv[2]) || 8787;
const types = { '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' };

// Every immediate subfolder holding a manifest.json is one collected dataset.
function datasets() {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const file = path.join(root, entry.name, 'manifest.json');
      if (!fs.existsSync(file)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!manifest.symbol) return null;
        return { dir: entry.name, symbol: manifest.symbol, exchange: manifest.exchange, marketType: manifest.marketType, timeframe: manifest.timeframe, tables: (manifest.tables || []).filter(item => item.status === 'complete').length };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.dir.localeCompare(b.dir));
}

http.createServer((request, response) => {
  if (request.method !== 'GET') return response.writeHead(405).end();
  const requested = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (requested === '/datasets.json') {
    const body = Buffer.from(JSON.stringify(datasets()));
    return response.writeHead(200, { 'Content-Type': types['.json'], 'Content-Length': body.length, 'Cache-Control': 'no-store' }).end(body);
  }
  const file = path.join(root, requested === '/' ? 'kline-preview.html' : requested);
  const relative = path.relative(root, file);
  const extension = path.extname(file).toLowerCase();
  // Read-only and confined to the exports folder.
  if (relative.startsWith('..') || path.isAbsolute(relative) || !types[extension]) return response.writeHead(403).end();
  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': types[extension], 'Content-Length': stats.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
}).listen(port, '127.0.0.1', () => console.log('Preview ready: http://127.0.0.1:' + port + '/kline-preview.html'));
