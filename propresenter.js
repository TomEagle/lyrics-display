'use strict';

/*
 * Reads ProPresenter song files and returns the slides as plain text.
 *   .pro   ProPresenter 7 (binary protobuf)
 *   .pro6  ProPresenter 6 (XML)
 * Slides come out in the order of the song's selected arrangement,
 * or in group order when no arrangement is selected. Slide notes are ignored.
 *
 * Field numbers follow the community schema at github.com/greyshirtguy/ProPresenter7-Proto
 */

const fs = require('fs');

// ------------------------------------------------------------------ RTF to plain text
const SKIP_GROUPS = new Set([
  'fonttbl', 'colortbl', 'expandedcolortbl', 'stylesheet', 'info', 'pict', 'listtable',
  'listoverridetable', 'header', 'footer', 'themedata', 'colorschememapping', 'latentstyles', 'datastore',
]);
const SYMBOLS = {
  emdash: '\u2014', endash: '\u2013', lquote: '\u2018', rquote: '\u2019',
  ldblquote: '\u201C', rdblquote: '\u201D', bullet: '\u2022',
};
const cp1252 = new TextDecoder('windows-1252');

function rtfToText(rtf) {
  let out = '';
  let bytes = [];        // pending \'hh bytes, decoded together
  let ignoring = false;  // inside a group we don't display (font table etc.)
  let uc = 1;            // characters to skip after a \u escape
  let skip = 0;
  const stack = [];
  const flush = () => { if (bytes.length) { out += cp1252.decode(Uint8Array.from(bytes)); bytes = []; } };
  const text = s => { if (ignoring) return; if (skip > 0) { skip--; return; } flush(); out += s; };
  const byte = b => { if (ignoring) return; if (skip > 0) { skip--; return; } bytes.push(b); };
  const word = /([a-zA-Z]+)(-?\d+)? ?/y;

  let i = 0;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === '{') { stack.push({ ignoring, uc }); i++; continue; }
    if (c === '}') { flush(); ({ ignoring, uc } = stack.pop() || { ignoring: false, uc: 1 }); skip = 0; i++; continue; }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (c !== '\\') { text(c); i++; continue; }

    const n = rtf[i + 1];
    if (n === undefined) break;
    if (n === '\\' || n === '{' || n === '}') { text(n); i += 2; continue; }
    if (n === '\n' || n === '\r') { skip = 0; text('\n'); i += 2; continue; }
    if (n === "'") { byte(parseInt(rtf.substr(i + 2, 2), 16)); i += 4; continue; }
    if (n === '*') { ignoring = true; i += 2; continue; }
    if (n === '~') { text('\u00A0'); i += 2; continue; }

    word.lastIndex = i + 1;
    const m = word.exec(rtf);
    if (!m) { i += 2; continue; }
    i = word.lastIndex;
    const name = m[1];
    const arg = m[2] !== undefined ? parseInt(m[2], 10) : null;

    if (SKIP_GROUPS.has(name)) ignoring = true;
    else if (name === 'par' || name === 'line') { skip = 0; text('\n'); }
    else if (name === 'tab') text(' ');
    else if (name === 'uc') uc = arg ?? 1;
    else if (name === 'u') { skip = 0; text(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); skip = uc; }
    else if (SYMBOLS[name]) text(SYMBOLS[name]);
  }
  flush();
  return out;
}

function cleanText(s) {
  return String(s)
    .replace(/\r\n?|[\u2028\u2029\u000B]/g, '\n')
    .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
    .join('\n');
}

// ------------------------------------------------------------------ ProPresenter 7 (.pro)
function pbFields(buf) {
  const fields = [];
  let i = 0;
  const varint = () => {
    let result = 0, scale = 1, b;
    do {
      if (i >= buf.length) throw new Error('Truncated file');
      b = buf[i++];
      result += (b & 0x7f) * scale;
      scale *= 128;
    } while (b & 0x80);
    return result;
  };
  while (i < buf.length) {
    const key = varint();
    const field = Math.floor(key / 8), type = key % 8;
    if (type === 0) varint();
    else if (type === 1) i += 8;
    else if (type === 5) i += 4;
    else if (type === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error('Truncated file');
      fields.push({ field, value: buf.subarray(i, i + len) });
      i += len;
    } else throw new Error('Not a ProPresenter 7 file');
  }
  return fields;
}
const all = (buf, n) => (buf ? pbFields(buf) : []).filter(f => f.field === n).map(f => f.value);
const one = (buf, n) => all(buf, n)[0];
const uuid = buf => { const s = one(buf, 1); return s ? s.toString('utf8').toUpperCase() : ''; };

function parsePro7(buf) {
  // Presentation: 3 name, 10 selected arrangement, 11 arrangements, 12 cue groups, 13 cues
  const cues = new Map();
  const cueOrder = [];
  for (const cue of all(buf, 13)) {
    const id = uuid(one(cue, 1));
    let isSlide = false;
    const texts = [];
    for (const action of all(cue, 10)) {
      // Action.slide(23) -> presentation slide(2) -> base slide(1) -> elements(1) -> element(1) -> text(13)
      const presSlide = one(one(action, 23), 2);
      if (!presSlide) continue;
      isSlide = true;
      for (const el of all(one(presSlide, 1), 1)) {
        const textMsg = one(one(el, 1), 13);
        if (!textMsg) continue;
        for (const f of pbFields(textMsg)) {
          if (f.value.subarray(0, 5).toString('latin1') === '{\\rtf') texts.push(cleanText(rtfToText(f.value.toString('utf8'))));
        }
      }
    }
    if (isSlide) { cues.set(id, texts.filter(Boolean).join('\n')); cueOrder.push(id); }
  }

  const groups = new Map();
  const groupOrder = [];
  for (const cg of all(buf, 12)) {
    const group = one(cg, 1);
    const id = uuid(one(group, 1));
    const name = (one(group, 2) || Buffer.alloc(0)).toString('utf8');
    groups.set(id, { name, cueIds: all(cg, 2).map(uuid) });
    groupOrder.push(id);
  }

  let order = groupOrder;
  const selected = uuid(one(buf, 10));
  if (selected) {
    for (const arr of all(buf, 11)) {
      if (uuid(one(arr, 1)) !== selected) continue;
      const ids = all(arr, 3).map(uuid);
      if (ids.length) order = ids;
    }
  }

  const slides = [];
  if (groups.size) {
    for (const gid of order) {
      const g = groups.get(gid);
      if (!g) continue;
      for (const cid of g.cueIds) if (cues.has(cid)) slides.push({ text: cues.get(cid), group: g.name });
    }
  } else {
    for (const cid of cueOrder) slides.push({ text: cues.get(cid), group: '' });
  }
  const title = (one(buf, 3) || Buffer.alloc(0)).toString('utf8');
  return { title, slides };
}

// ------------------------------------------------------------------ ProPresenter 6 (.pro6, XML)
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()];
  });
}
const attr = (attrs, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs || '');
  return m ? decodeEntities(m[1]) : '';
};
const b64 = s => Buffer.from(s.trim(), 'base64').toString('utf8');
const ivar = (body, name) => {
  const m = new RegExp(`<NSString[^>]*rvXMLIvarName="${name}"[^>]*>([^<]*)</NSString>`).exec(body);
  return m ? m[1].trim() : '';
};

function pro6SlideText(body) {
  const texts = [];
  const re = /<RVTextElement\b([^>]*?)(?:\/>|>([\s\S]*?)<\/RVTextElement>)/g;
  let m;
  while ((m = re.exec(body))) {
    const inner = m[2] || '';
    const plain = ivar(inner, 'PlainText');
    const rtf = ivar(inner, 'RTFData') || attr(m[1], 'RTFData');
    if (plain) texts.push(cleanText(b64(plain)));
    else if (rtf) texts.push(cleanText(rtfToText(b64(rtf))));
  }
  return texts.filter(Boolean).join('\n');
}

function parsePro6(xml) {
  const root = /<RVPresentationDocument\b([^>]*)>/.exec(xml);
  if (!root) throw new Error('Not a ProPresenter 6 file');

  const groups = new Map();
  const groupOrder = [];
  const gre = /<RVSlideGrouping\b([^>]*)>([\s\S]*?)<\/RVSlideGrouping>/g;
  let g;
  while ((g = gre.exec(xml))) {
    const slides = [];
    const sre = /<RVDisplaySlide\b([^>]*?)(?:\/>|>([\s\S]*?)<\/RVDisplaySlide>)/g;
    let s;
    while ((s = sre.exec(g[2]))) {
      if (attr(s[1], 'enabled') === 'false') continue;
      slides.push(pro6SlideText(s[2] || ''));
    }
    const id = attr(g[1], 'uuid').toUpperCase() || `group${groupOrder.length}`;
    groups.set(id, { name: attr(g[1], 'name'), slides });
    groupOrder.push(id);
  }

  let order = groupOrder;
  const selected = attr(root[1], 'selectedArrangementID').toUpperCase();
  if (selected) {
    const are = /<RVSongArrangement\b([^>]*)>([\s\S]*?)<\/RVSongArrangement>/g;
    let a;
    while ((a = are.exec(xml))) {
      if (attr(a[1], 'uuid').toUpperCase() !== selected) continue;
      const ids = [...a[2].matchAll(/<NSString[^>]*>([^<]+)<\/NSString>/g)].map(x => x[1].trim().toUpperCase());
      if (ids.length) order = ids;
    }
  }

  const slides = [];
  for (const id of order) {
    const grp = groups.get(id);
    if (grp) for (const text of grp.slides) slides.push({ text, group: grp.name });
  }
  return { title: attr(root[1], 'CCLISongTitle'), slides };
}

// ------------------------------------------------------------------ entry point
function readProPresenter(filePath) {
  const buf = fs.readFileSync(filePath);
  const head = buf.subarray(0, 200).toString('utf8').trimStart();
  if (head.startsWith('<?xml') || head.startsWith('<RVPresentationDocument')) return parsePro6(buf.toString('utf8'));
  return parsePro7(buf);
}

module.exports = { readProPresenter, rtfToText };
