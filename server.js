/**
 * Voodoo Miner — simple local static server (Windows-safe)
 * Usage: node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname);
const PORT = Number(process.env.PORT) || 8081;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

function resolveFile(urlPath) {
  let p = decodeURIComponent((urlPath || '/').split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  p = p.replace(/^\/+/, '').replace(/\\/g, '/');
  if (p.includes('..')) return null;

  const full = path.resolve(ROOT, p);
  const rootWithSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (full !== ROOT && !full.toLowerCase().startsWith(rootWithSep.toLowerCase())) {
    return null;
  }
  return full;
}

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('ERROR: index.html not found in', ROOT);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const file = resolveFile(req.url);
  if (!file) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + req.url + '\nRoot: ' + ROOT);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port', PORT, 'is busy. Close the other app or run:');
    console.error('  set PORT=8082 && node server.js');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`;
  console.log('');
  console.log('  ========================================');
  console.log('   Voodoo Miner is running');
  console.log('   Open this URL in your browser:');
  console.log('   ' + url);
  console.log('  ========================================');
  console.log('');
  console.log('  Folder:', ROOT);
  console.log('  Keep this window open. Press Ctrl+C to stop.');
  console.log('');

  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
  }
});
