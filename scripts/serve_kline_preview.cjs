const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../exports');
const port = Number(process.argv[2]) || 8787;
const types = { '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' };

http.createServer((request, response) => {
  if (request.method !== 'GET') return response.writeHead(405).end();
  const requested = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
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
