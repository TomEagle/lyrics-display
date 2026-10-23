#!/usr/bin/env node
'use strict';

/*
 * Lyrics Display Server
 * ---------------------
 * Your multitrack/DAW sends MIDI (or OSC) to this program.
 * Phones on the same network open http://<this-computer-ip>:8080 in a browser
 * and see the current lyric line. No dependencies required except optional MIDI.
 */

const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------- settings
const CONFIG = {
  httpPort: Number(process.env.HTTP_PORT) || 8080,   // phones connect here
  oscPort: Number(process.env.OSC_PORT) || 9000,     // UDP port for OSC
  midiPort: process.env.MIDI_PORT || '',             // part of a MIDI port name; empty = create virtual port (Mac/Linux)
  midiChannel: Number(process.env.MIDI_CHANNEL) || 0, // 1-16, or 0 = listen on all channels
  songsDir: process.env.SONGS_DIR || path.join(__dirname, 'songs'),
  cc: { next: 20, prev: 21, clear: 22, welcome: 23 }, // MIDI CC numbers for step commands
  welcomeFile: process.env.WELCOME_FILE || path.join(__dirname, 'welcome.txt'),
  useBanks: /^(1|yes|on|true)$/i.test(process.env.MIDI_BANKS || ''), // CC 0 selects a bank of 128 songs

  // Join page (/join): QR codes for the projector or bulletin
  publicUrl: process.env.PUBLIC_URL || '',           // address people should open; default = this computer
  wifiSsid: process.env.WIFI_SSID || '',             // shows a "join Wi-Fi" QR code when set
  wifiPassword: process.env.WIFI_PASSWORD || '',
  wifiSecurity: process.env.WIFI_SECURITY || 'WPA',  // WPA, WEP or nopass

  // Optional internet relay (relay.js running on a cloud host)
  relayUrl: process.env.RELAY_URL || '',             // e.g. https://lyrics.example.org
  relayToken: process.env.RELAY_TOKEN || '',         // same secret as on the relay
};

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// ---------------------------------------------------------------- songs
// Files in /songs named like "01 Song Title.txt", "02 Song.pro" (ProPresenter 7)
// or "03 Song.pro6" (ProPresenter 6). Text files: one lyric line per text line,
// blank lines and lines starting with # are skipped. ProPresenter files: one slide per step.
const { readProPresenter } = require('./propresenter');
const SONG_FILE = /\.(txt|pro|pro6)$/i;
const cache = new Map(); // file -> { mtimeMs, lines, groups, title }

function readSongFile(full) {
  const mtimeMs = fs.statSync(full).mtimeMs;
  const hit = cache.get(full);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  let data;
  if (/\.txt$/i.test(full)) {
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/)
      .map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    data = { lines, groups: lines.map(() => ''), title: '' };
  } else {
    try {
      const pp = readProPresenter(full);
      data = { lines: pp.slides.map(s => s.text), groups: pp.slides.map(s => s.group), title: pp.title };
    } catch (e) {
      log(`Could not read ${path.basename(full)}: ${e.message}`);
      data = { lines: [], groups: [], title: '' };
    }
  }
  data.mtimeMs = mtimeMs;
  cache.set(full, data);
  return data;
}

function loadSongs() {
  let files;
  try {
    files = fs.readdirSync(CONFIG.songsDir)
      .filter(f => SONG_FILE.test(f) && !f.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (e) {
    log(`Cannot read songs folder ${CONFIG.songsDir}: ${e.message}`);
    return [];
  }
  return files.map((file, i) => {
    const m = file.match(/^(\d+)[\s._-]*(.*)\.\w+$/);
    const number = m ? parseInt(m[1], 10) : i + 1;
    const data = readSongFile(path.join(CONFIG.songsDir, file));
    const title = ((m ? m[2] : file.replace(/\.\w+$/, '')) || data.title || '').trim() || `Song ${number}`;
    return { number, title, file, lines: data.lines, groups: data.groups };
  });
}

let songs = loadSongs();
const state = { song: songs[0] || null, lineNo: 0, override: null, welcome: true };

// Welcome page text: first line = heading, the rest = message. Lines starting with # are ignored.
function readWelcome() {
  let lines = [];
  try {
    lines = fs.readFileSync(CONFIG.welcomeFile, 'utf8').replace(/^\uFEFF/, '')
      .split(/\r?\n/).map(l => l.trim()).filter(l => !l.startsWith('#'));
  } catch {}
  while (lines.length && !lines[0]) lines.shift();
  if (!lines.length) {
    return { title: 'Welcome', message: 'The song lyrics will appear here when the music starts.\nKeep this page open. The words change by themselves.' };
  }
  return { title: lines[0], message: lines.slice(1).join('\n').replace(/\n{3,}/g, '\n\n').trim() };
}

function snapshot() {
  const s = state.song;
  const base = { title: s ? s.title : '', songNumber: s ? s.number : null, total: s ? s.lines.length : 0 };
  if (state.welcome) return { ...base, welcome: readWelcome(), line: '', next: '', group: '', lineNo: state.lineNo };
  if (state.override !== null) return { ...base, line: state.override, next: '', group: '', lineNo: 0 };
  return {
    ...base,
    lineNo: state.lineNo,
    line: s && state.lineNo > 0 ? s.lines[state.lineNo - 1] || '' : '',
    group: s && state.lineNo > 0 ? s.groups[state.lineNo - 1] || '' : '',
    next: s ? s.lines[state.lineNo] || '' : '',
  };
}

// ---------------------------------------------------------------- commands
// Every input (MIDI, OSC, control page) ends up here.
function command(cmd, value) {
  const s = state.song;
  switch (cmd) {
    case 'song': {
      songs = loadSongs(); // pick up edits without restarting
      const n = Math.round(Number(value));
      const found = songs.find(x => x.number === n);
      if (!found) { log(`Song ${n} not found in ${CONFIG.songsDir}`); return false; }
      Object.assign(state, { song: found, lineNo: 0, override: null });
      log(`Song ${found.number}: ${found.title}`);
      break;
    }
    case 'line': {
      const n = Math.max(0, Math.round(Number(value) || 0));
      if (!s) return false;
      if (n > s.lines.length) { log(`Line ${n} does not exist (song has ${s.lines.length})`); return false; }
      Object.assign(state, { lineNo: n, override: null });
      if (n > 0) state.welcome = false;
      break;
    }
    case 'next':
      if (!s || state.lineNo >= s.lines.length) return false;
      state.lineNo++; state.override = null; state.welcome = false; break;
    case 'prev':
      if (state.lineNo <= 0) return false;
      state.lineNo--; state.override = null; break;
    case 'clear':
      state.lineNo = 0; state.override = null; break;
    case 'text':
      state.override = String(value ?? ''); state.welcome = false; break;
    case 'welcome':
      state.welcome = true; state.override = null; break;
    case 'reload':
      songs = loadSongs();
      state.song = (s && songs.find(x => x.file === s.file)) || songs[0] || null;
      state.lineNo = Math.min(state.lineNo, state.song ? state.song.lines.length : 0);
      break;
    default:
      return false;
  }
  broadcast();
  return true;
}

// ---------------------------------------------------------------- phones (Server-Sent Events)
const clients = new Set();

function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(msg);
  relayPush();
}

// ---------------------------------------------------------------- internet relay (optional)
// Sends each change once to relay.js on a cloud server; phones on mobile data connect there.
let relayBusy = false, relayPending = false, relayFailing = false;

async function relayPush() {
  if (!CONFIG.relayUrl) return;
  if (relayBusy) { relayPending = true; return; }
  relayBusy = true;
  try {
    do {
      relayPending = false;
      const res = await fetch(CONFIG.relayUrl.replace(/\/+$/, '') + '/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.relayToken}` },
        body: JSON.stringify(snapshot()),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(res.status === 401 ? 'wrong RELAY_TOKEN' : `HTTP ${res.status}`);
      if (relayFailing) log('Relay: connected again');
      relayFailing = false;
    } while (relayPending);
  } catch (e) {
    if (!relayFailing) log(`Relay: cannot reach ${CONFIG.relayUrl} (${e.message}). Phones on local Wi-Fi still work.`);
    relayFailing = true;
  } finally {
    relayBusy = false;
  }
}
setInterval(relayPush, 30000); // resend now and then so a restarted relay catches up

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

// ---------------------------------------------------------------- web server
const PUBLIC = path.join(__dirname, 'public');
const sendJson = (res, obj, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    log(`Screen connected (${clients.size} total)`);
    req.on('close', () => { clients.delete(res); log(`Screen disconnected (${clients.size} total)`); });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/songs') {
    songs = loadSongs();
    return sendJson(res, { songs, current: snapshot(), useBanks: CONFIG.useBanks });
  }

  if (req.method === 'POST' && pathname === '/api/cmd') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { cmd, value } = JSON.parse(body || '{}');
        sendJson(res, { ok: command(cmd, value), state: snapshot() });
      } catch { sendJson(res, { ok: false, error: 'Invalid JSON' }, 400); }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/join') {
    joinPage().then(html => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
    });
    return;
  }

  const pages = { '/': 'index.html', '/control': 'control.html', '/overlay': 'overlay.html' };
  if (req.method === 'GET' && pages[pathname]) {
    fs.readFile(path.join(PUBLIC, pages[pathname]), (err, data) => {
      if (err) { res.writeHead(500); return res.end('Page missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------------------------------------------------------------- join page with QR codes
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const wifiEsc = t => String(t).replace(/([\\;,:"])/g, '\\$1');

function lyricsUrl() {
  if (CONFIG.publicUrl) return CONFIG.publicUrl;
  const ip = lanAddresses()[0] || 'localhost';
  return `http://${ip}${CONFIG.httpPort === 80 ? '' : ':' + CONFIG.httpPort}`;
}

async function joinPage() {
  let QR = null;
  try { QR = require('qrcode'); } catch {}
  const qr = async text => QR
    ? QR.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
    : '<p class="missing">Run “npm install” to show QR codes.</p>';

  const url = lyricsUrl();
  const blocks = [];
  if (CONFIG.wifiSsid) {
    const sec = CONFIG.wifiSecurity.toUpperCase() === 'NOPASS' ? 'nopass' : CONFIG.wifiSecurity;
    const wifi = `WIFI:T:${sec};S:${wifiEsc(CONFIG.wifiSsid)};${sec === 'nopass' ? '' : `P:${wifiEsc(CONFIG.wifiPassword)};`};`;
    blocks.push(`<figure>${await qr(wifi)}<figcaption><strong>1. Join the Wi‑Fi</strong>
      <span>${esc(CONFIG.wifiSsid)}</span>${CONFIG.wifiPassword && sec !== 'nopass' ? `<span>Password: ${esc(CONFIG.wifiPassword)}</span>` : ''}</figcaption></figure>`);
  }
  blocks.push(`<figure>${await qr(url)}<figcaption><strong>${CONFIG.wifiSsid ? '2. ' : ''}Open the lyrics</strong>
    <span>${esc(url.replace(/^https?:\/\//, ''))}</span></figcaption></figure>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Follow the lyrics on your phone</title>
<style>
  html, body { margin: 0; min-height: 100%; background: #fff; color: #111; font-family: "Helvetica Neue", Arial, system-ui, sans-serif; }
  body { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 3vh 4vw; box-sizing: border-box; }
  h1 { font-size: clamp(28px, 5vw, 64px); margin: 0 0 4vh; text-align: center; font-weight: 700; }
  .codes { display: flex; flex-wrap: wrap; gap: 6vw; justify-content: center; }
  figure { margin: 0; text-align: center; }
  figure svg { width: min(38vw, 60vh); height: auto; display: block; }
  figcaption { font-size: clamp(18px, 2.6vw, 36px); margin-top: 1vh; display: flex; flex-direction: column; gap: .2em; }
  figcaption span { overflow-wrap: anywhere; }
  .missing { width: min(38vw, 60vh); padding: 2em; border: 2px dashed #999; box-sizing: border-box; }
</style></head><body>
<h1>Follow the lyrics on your phone</h1>
<div class="codes">${blocks.join('')}</div>
</body></html>`;
}

// ---------------------------------------------------------------- OSC (UDP)
function readOscString(buf, off) {
  const end = buf.indexOf(0, off);
  if (end < 0) throw new Error('Bad OSC string');
  return [buf.toString('utf8', off, end), (end + 4) & ~3];
}

function parseOsc(buf, out = []) {
  if (buf.length >= 16 && buf.toString('ascii', 0, 8) === '#bundle\0') {
    let off = 16;
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off); off += 4;
      parseOsc(buf.subarray(off, off + size), out); off += size;
    }
    return out;
  }
  let [address, off] = readOscString(buf, 0);
  let types = ',';
  if (off < buf.length) [types, off] = readOscString(buf, off);
  const args = [];
  for (const t of types.slice(1)) {
    if (t === 'i') { args.push(buf.readInt32BE(off)); off += 4; }
    else if (t === 'f') { args.push(buf.readFloatBE(off)); off += 4; }
    else if (t === 'd') { args.push(buf.readDoubleBE(off)); off += 8; }
    else if (t === 'h') { args.push(Number(buf.readBigInt64BE(off))); off += 8; }
    else if (t === 's' || t === 'S') { let s; [s, off] = readOscString(buf, off); args.push(s); }
    else if (t === 'T') args.push(1);
    else if (t === 'F') args.push(0);
    else break;
  }
  out.push({ address, args });
  return out;
}

const osc = dgram.createSocket('udp4');
osc.on('message', buf => {
  let msgs;
  try { msgs = parseOsc(buf); } catch { return; }
  for (const { address, args } of msgs) {
    const m = address.toLowerCase().match(/^\/lyrics\/(\w+)$/);
    if (!m) continue;
    const cmd = m[1];
    // Buttons on OSC controllers send 1 on press and 0 on release: ignore the release.
    if (['next', 'prev', 'clear', 'welcome'].includes(cmd) && args.length && Number(args[0]) === 0) continue;
    command(cmd, args[0]);
  }
});
osc.on('error', e => log(`OSC error: ${e.message}`));

// ---------------------------------------------------------------- MIDI (optional)
let midiInput = null; // keep a reference so it stays open
const midiBank = new Array(17).fill(0); // current bank per MIDI channel (only used with MIDI_BANKS)

function handleMidi([status, d1, d2]) {
  const type = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  if (CONFIG.midiChannel && channel !== CONFIG.midiChannel) return;

  if (type === 0x90 && d2 > 0) command('line', d1);       // Note On: note number = line number (0 = blank)
  else if (type === 0xc0) {                                // Program Change: program 1 (value 0) = song 1
    // With banks: song = bank x 128 + program, so bank 1 + program 1 = song 129.
    const bank = CONFIG.useBanks ? midiBank[channel] : 0;
    command('song', bank * 128 + d1 + 1);
  }
  else if (type === 0xb0 && d1 === 0) {                    // CC 0 = Bank Select; stays until changed
    if (CONFIG.useBanks) midiBank[channel] = d2;
  }
  else if (type === 0xb0 && d2 > 0) {                      // Control Change: step commands
    if (d1 === CONFIG.cc.next) command('next');
    else if (d1 === CONFIG.cc.prev) command('prev');
    else if (d1 === CONFIG.cc.clear) command('clear');
    else if (d1 === CONFIG.cc.welcome) command('welcome');
  }
}

function startMidi() {
  let midi;
  try { midi = require('@julusian/midi'); }
  catch { log('MIDI: module not installed. Run "npm install" to enable MIDI. OSC and the control page still work.'); return; }

  midiInput = new midi.Input();
  const names = [];
  for (let i = 0; i < midiInput.getPortCount(); i++) names.push(midiInput.getPortName(i));
  const list = names.length ? names.map(n => `"${n}"`).join(', ') : '(none)';

  if (CONFIG.midiPort) {
    const idx = names.findIndex(n => n.toLowerCase().includes(CONFIG.midiPort.toLowerCase()));
    if (idx < 0) { log(`MIDI: no port matching "${CONFIG.midiPort}". Available: ${list}`); return; }
    midiInput.openPort(idx);
    log(`MIDI: listening on "${names[idx]}"`);
  } else if (process.platform === 'win32') {
    log(`MIDI: Windows needs a loopback port (e.g. loopMIDI). Start with MIDI_PORT set to its name. Available: ${list}`);
    return;
  } else {
    midiInput.openVirtualPort('Lyrics Display');
    log('MIDI: created virtual port "Lyrics Display". Choose it as a MIDI output in your DAW.');
  }
  midiInput.ignoreTypes(true, true, true); // ignore sysex, clock, active sensing
  midiInput.on('message', (_dt, msg) => handleMidi(msg));
}

// ---------------------------------------------------------------- start
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter(a => a && (a.family === 'IPv4' || a.family === 4) && !a.internal)
    .map(a => a.address);
}

server.listen(CONFIG.httpPort, '0.0.0.0', () => {
  console.log('\n  Lyrics Display is running\n');
  for (const ip of lanAddresses()) {
    console.log(`  Phones:        http://${ip}:${CONFIG.httpPort}`);
    console.log(`  Control page:  http://${ip}:${CONFIG.httpPort}/control`);
    console.log(`  Join QR page:  http://${ip}:${CONFIG.httpPort}/join`);
    console.log(`  vMix overlay:  http://${ip}:${CONFIG.httpPort}/overlay`);
  }
  if (CONFIG.relayUrl) console.log(`  Relay:         ${CONFIG.relayUrl}`);
  console.log(`  OSC (UDP):     port ${CONFIG.oscPort}, addresses /lyrics/...`);
  console.log(`  MIDI banks:    ${CONFIG.useBanks ? 'on (CC 0 = bank, songs 1-16384)' : 'off (Program Change 1-128 = songs 1-128)'}`);
  console.log(`  Songs folder:  ${CONFIG.songsDir} (${songs.length} songs)\n`);
});
osc.bind(CONFIG.oscPort);
startMidi();
relayPush();
