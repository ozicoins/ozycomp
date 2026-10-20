'use strict';
/**
 * kg-core — Knowledge Graph core: ingest, index and keyword-search a local,
 * file-backed knowledge store. Pure JS (node:fs/path/crypto only) so the same
 * file loads in the Electron main process AND from an agent's shell through
 * bin/kg.cjs.
 *
 * Store layout (KG_ROOT):
 *   index.jsonl        one JSON line per chunk {docId, i, text, terms}
 *   docs/<docId>/
 *     meta.json        {id, title, source, modality, mime, bytes, createdAt, chunks}
 *     original.<ext>   raw artifact copied verbatim
 *     text.md          normalized searchable text
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
const MAX_LIMIT = 50;
const STOP = new Set('the a an and or of to in on for is are was were be by with as at it this that from'.split(' '));

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.js', '.cjs', '.mjs', '.ts', '.tsx', '.py', '.rb', '.go', '.rs',
  '.java', '.c', '.h', '.cpp', '.css', '.html', '.yml', '.yaml', '.toml', '.csv', '.sql', '.sh', '.xml']);
const MIME = { '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.pdf': 'application/pdf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.html': 'text/html', '.csv': 'text/csv' };

const ensureDir = d => fs.mkdirSync(d, { recursive: true });
const extOf = f => path.extname(f).toLowerCase();
const nowIso = () => new Date().toISOString();
const genId = () => crypto.randomBytes(6).toString('hex');

function tokenize(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9ğüşıöç_]+/i).filter(t => t.length > 1 && !STOP.has(t));
}

function detectModality(ext) {
  if (TEXT_EXT.has(ext)) return 'text';
  if (ext === '.pdf') return 'pdf';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  return 'binary';
}

function tryPdfToText(file) {
  const r = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8', timeout: 20000 });
  return r.status === 0 ? r.stdout : '';
}

function extractText(file, modality) {
  if (modality === 'text') return fs.readFileSync(file, 'utf8');
  if (modality === 'pdf') return tryPdfToText(file);
  return ''; // images/binaries: title + filename are still indexed
}

/** Split on paragraph boundaries into ~CHUNK_SIZE chunks with overlap. */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const out = [];
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  if (!clean) return out;
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(clean.length, i + size);
    if (end < clean.length) {
      const para = clean.lastIndexOf('\n\n', end);
      const sent = clean.lastIndexOf('. ', end);
      const cut = para > i + size / 2 ? para : sent > i + size / 2 ? sent + 1 : end;
      end = cut;
    }
    out.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return out.filter(Boolean);
}

function deriveTitle(text, file) {
  const h = /^#\s+(.+)$/m.exec(text);
  return (h?.[1] ?? path.basename(file)).trim().slice(0, 160);
}

/** Ingest one file (or raw {text,title}) → doc meta. */
function ingest(root, input, opts = {}) {
  ensureDir(path.join(root, 'docs'));
  const id = genId();
  const dir = path.join(root, 'docs', id);
  ensureDir(dir);
  let text, title, modality, mime, bytes, source;
  if (typeof input === 'string') {
    const ext = extOf(input);
    modality = detectModality(ext);
    mime = MIME[ext] ?? 'application/octet-stream';
    bytes = fs.statSync(input).size;
    fs.copyFileSync(input, path.join(dir, `original${ext || '.bin'}`));
    text = extractText(input, modality);
    title = opts.title ?? deriveTitle(text, input);
    source = path.resolve(input);
  } else {
    text = String(input.text ?? '');
    modality = 'text'; mime = 'text/markdown'; bytes = Buffer.byteLength(text);
    title = input.title ?? deriveTitle(text, 'note');
    source = input.source ?? 'inline';
  }
  fs.writeFileSync(path.join(dir, 'text.md'), text, 'utf8');
  const chunks = chunkText(`${title}\n\n${text}`);
  if (!chunks.length) chunks.push(title);
  const lines = chunks.map((c, i) => JSON.stringify({ docId: id, i, text: c, terms: [...new Set(tokenize(c))] }));
  fs.appendFileSync(path.join(root, 'index.jsonl'), lines.join('\n') + '\n', 'utf8');
  const meta = { id, title, source, modality, mime, bytes, createdAt: nowIso(), chunks: chunks.length, tags: opts.tags ?? [] };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function readIndex(root) {
  const f = path.join(root, 'index.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** TF-style score with a phrase bonus. */
function scoreChunk(chunk, qTerms, phrase) {
  const set = new Set(chunk.terms);
  let hits = 0;
  for (const t of qTerms) if (set.has(t)) hits++;
  if (!hits) return 0;
  let s = hits / qTerms.length;
  if (phrase && chunk.text.toLowerCase().includes(phrase)) s += 1;
  return s;
}

function makeSnippet(text, qTerms, width = 220) {
  const low = text.toLowerCase();
  let at = -1;
  for (const t of qTerms) { at = low.indexOf(t); if (at >= 0) break; }
  const start = Math.max(0, at - width / 3);
  return (start > 0 ? '…' : '') + text.slice(start, start + width).replace(/\s+/g, ' ').trim() + '…';
}

const clampLimit = n => Math.max(1, Math.min(MAX_LIMIT, Number(n) || 8));

function search(root, query, limit = 8) {
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return [];
  const phrase = qTerms.length > 1 ? String(query).toLowerCase().trim() : null;
  const best = new Map(); // docId → best hit
  for (const c of readIndex(root)) {
    const s = scoreChunk(c, qTerms, phrase);
    if (s > (best.get(c.docId)?.score ?? 0)) best.set(c.docId, { docId: c.docId, chunk: c.i, score: s, snippet: makeSnippet(c.text, qTerms) });
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, clampLimit(limit))
    .map(h => ({ ...h, title: getDoc(root, h.docId)?.title ?? h.docId }));
}

function getDoc(root, id) {
  if (!/^[a-f0-9]{12}$/.test(id)) return null;
  const f = path.join(root, 'docs', id, 'meta.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function list(root) {
  const d = path.join(root, 'docs');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).map(id => getDoc(root, id)).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function removeDoc(root, id) {
  if (!getDoc(root, id)) return false;
  fs.rmSync(path.join(root, 'docs', id), { recursive: true, force: true });
  const kept = readIndex(root).filter(c => c.docId !== id).map(c => JSON.stringify(c));
  fs.writeFileSync(path.join(root, 'index.jsonl'), kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  return true;
}

function stats(root) {
  const docs = list(root);
  const byModality = {};
  for (const d of docs) byModality[d.modality] = (byModality[d.modality] ?? 0) + 1;
  return { docCount: docs.length, chunkCount: readIndex(root).length, byModality };
}

module.exports = { ingest, search, getDoc, list, removeDoc, stats, chunkText, tokenize, CHUNK_SIZE, CHUNK_OVERLAP };
