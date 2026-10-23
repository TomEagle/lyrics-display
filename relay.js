#!/usr/bin/env node
'use strict';

/*
 * Lyrics relay (optional)
 * -----------------------
 * Runs on a cloud host. The computer at church sends each lyric change here once;
 * phones anywhere (Wi-Fi or mobile data) open this server's address.
 * No dependencies. Needs RELAY_TOKEN set to the same secret as on the church computer.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8080;
const TOKEN = process.env.RELAY_TOKEN || '';
if (TOKEN.length < 12) {
  console.error('Set RELAY_TOKEN to a secret of at least 12 characters (the same one the church computer uses).');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);
const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const clients = new Set();
let latest = JSON.stringify({ title: '', line: '', next: '', group: '', lineNo: 0 });

function authorized(req) {
  const given = Buffer.from(req.headers.authorization || '');
  const wanted = Buffer.from(`Bearer ${TOKEN}`);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function broadcast() {
  const msg = `data: ${latest}\n\n`;
  for (const res of clients) res.write(msg);
}

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(page);
  }

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\ndata: ${latest}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && pathname === '/publish') {
    if (!authorized(req)) { res.writeHead(401); return res.end(); }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        const next = JSON.stringify(JSON.parse(body));
        if (next !== latest) { latest = next; broadcast(); }
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`ok, ${clients.size} phones connected\n`);
  }

  res.writeHead(404); res.end();
});

let lastCount = -1;
setInterval(() => { if (clients.size !== lastCount) { lastCount = clients.size; log(`${clients.size} phones connected`); } }, 60000);

server.listen(PORT, () => log(`Lyrics relay listening on port ${PORT}`));
