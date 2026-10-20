'use strict';
/**
 * FileShareStore — one-file public sharing through a loopback listener +
 * tunnelmole tunnel, verbatim from the reference:
 *
 *   • token → share map; the token IS the key, so a lookup cannot be tricked
 *     into naming a file — no path arithmetic anywhere in the read path.
 *   • decoy token: compared against on a miss purely so a miss does the same
 *     work as a hit (constant-time either way).
 *   • shares expire after TTL, get served with no-store/nosniff headers, and
 *     the loopback listener closes when the last share goes — the bound port
 *     is remembered so the next share reuses the same tunnel.
 *
 * Also carries the hero payload loader (the marketing header on the home
 * view) since it shares the same parse-and-cache shape as the model catalog.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { getText } = require('./skills-hub');

// ─── hero:payload ──────────────────────────────────────────────────────────

const HERO_MAX = { label: 24, blurb: 240, name: 48, notice: 160, url: 300 };
const DEFAULT_HERO = {
  plan: {
    label: 'Local',
    blurb: 'Every agent runs on your machine, in your folders, under your own keys. No seat limit, nothing metered.',
  },
  sponsor: null,
  notice: null,
};

function heroStr(v, cap) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t;
}
function httpsUrl(v) {
  const s = heroStr(v, HERO_MAX.url);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}
function parseHeroPayload(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_HERO;
  const planIn = raw.plan && typeof raw.plan === 'object' ? raw.plan : {};
  const plan = {
    label: heroStr(planIn.label, HERO_MAX.label) ?? DEFAULT_HERO.plan.label,
    blurb: heroStr(planIn.blurb, HERO_MAX.blurb) ?? DEFAULT_HERO.plan.blurb,
  };
  const upIn = planIn.upgrade && typeof planIn.upgrade === 'object' ? planIn.upgrade : null;
  if (upIn) {
    const label = heroStr(upIn.label, HERO_MAX.label);
    const url = httpsUrl(upIn.url);
    if (label && url) plan.upgrade = { label, url };
  }
  let sponsor = null;
  const spIn = raw.sponsor && typeof raw.sponsor === 'object' ? raw.sponsor : null;
  if (spIn) {
    const name = heroStr(spIn.name, HERO_MAX.name);
    const url = httpsUrl(spIn.url);
    if (name && url) sponsor = { name, blurb: heroStr(spIn.blurb, HERO_MAX.blurb) ?? '', url };
  }
  return { plan, sponsor, notice: heroStr(raw.notice, HERO_MAX.notice) };
}

const HERO_URL = 'https://raw.githubusercontent.com/chaitanyagiri/ozycomp/main/docs/hero.json';
const HERO_TTL_MS = 6 * 60 * 60 * 1e3;

async function loadHero(cachePath, opts = {}) {
  let cached = null;
  try {
    if (fs.existsSync(cachePath)) cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch { cached = null; }
  if (cached && !opts.force && Date.now() - cached.fetchedAt < HERO_TTL_MS)
    return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: false };
  try {
    const body = await getText(HERO_URL, { timeoutMs: 8000 });
    const hero = parseHeroPayload(JSON.parse(body));
    const payload = { hero, fetchedAt: Date.now() };
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(payload));
    } catch {}
    return { ...payload, stale: false };
  } catch {
    if (cached) return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true };
    return { hero: DEFAULT_HERO, fetchedAt: 0, stale: true };
  }
}

// ─── file shares ───────────────────────────────────────────────────────────

const SHARE_TTL_MS = 60 * 60 * 1e3;
const MAX_SHARE_BYTES = 100 * 1024 * 1024;
const SHARE_TOKEN_BYTES = 32;
const MAX_ACTIVE_SHARES = 20;
const TUNNEL_START_TIMEOUT_MS = 1e4;
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 6e4;
const SHARE_ROUTE_PREFIX = '/s/';
const SHARE_PATH_RE = /^\/s\/([0-9a-f]{64})$/;

const INERT_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', log: 'text/plain',
  csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  gz: 'application/gzip', tar: 'application/x-tar', mp3: 'audio/mpeg',
  wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac', mp4: 'video/mp4',
  mov: 'video/quicktime', webm: 'video/webm',
};

function sharePath(token) { return `${SHARE_ROUTE_PREFIX}${token}`; }
function shareUrl(base, token) { return `${base.replace(/\/+$/, '')}${sharePath(token)}`; }
function tokenFromPath(pathname) {
  const m = SHARE_PATH_RE.exec(pathname);
  return m ? m[1] : null;
}
function isExpired(share, now) { return now >= share.expiresAt; }
function remainingMs(share, now) { return Math.max(0, share.expiresAt - now); }
function shareCountdown(share, now) {
  const ms = remainingMs(share, now);
  if (ms <= 0) return { unit: 'expired', count: 0 };
  if (ms < 6e4) return { unit: 'seconds', count: Math.max(1, Math.floor(ms / 1e3)) };
  if (ms < 36e5) return { unit: 'minutes', count: Math.floor(ms / 6e4) };
  return { unit: 'hours', count: Math.floor(ms / 36e5) }
}
function expiresIn(share, now) {
  const { unit, count } = shareCountdown(share, now);
  if (unit === 'expired') return 'Expired';
  const noun = count === 1 ? unit.slice(0, -1) : unit;
  return `${count} ${noun} left`;
}
function safeFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[-]/g, '').replace(/["\\]/g, '').trim().slice(0, 120);
  if (!cleaned || /^\.+$/.test(cleaned)) return 'download';
  return cleaned;
}
function contentDisposition(name) {
  const safe = safeFileName(name);
  const ascii = safe.replace(/[^ -~]/g, '_').replace(/["\\;]/g, '') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
function contentTypeFor(name) {
  const ext = safeFileName(name).toLowerCase().split('.').pop() ?? '';
  return INERT_TYPES[ext] ?? 'application/octet-stream';
}
function toShareView(share, base) {
  return {
    id: share.id, name: share.name, size: share.size, contentType: share.contentType,
    createdAt: share.createdAt, expiresAt: share.expiresAt,
    url: base ? shareUrl(base, share.token) : '',
  };
}
function notFound(res) { res.writeHead(404); res.end(); }
function pathnameOf(url) {
  try { return new URL(url ?? '/', 'http://127.0.0.1').pathname; } catch { return ''; }
}
function constantTimeEqual(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
function withTimeout(work, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); });
  });
}
async function openTunnelViaTunnelmole(port) {
  const { tunnelmole } = await import('tunnelmole');
  return tunnelmole({ port });
}

class FileShareStore {
  /** token → share. The token is the key, so a lookup cannot be tricked into
   *  naming a file: there is no path arithmetic anywhere in the read path. */
  shares = new Map();
  /** id → token, so revoke and the renderer can speak in ids only. */
  byId = new Map();
  timers = new Map();
  server = null;
  /** Remembered across a quiet stretch so the next share re-binds the SAME
   *  port and reuses the tunnel already pointed at it (see `closeServer`). */
  boundPort = 0;
  tunnelUrl = null;
  tunnelPending = null;
  serverPending = null;
  window = null;
  /** Compared against on a miss purely so a miss does the same work as a hit.
   *  Random per process, never exported, so it cannot match by accident. */
  decoyToken = crypto.randomBytes(SHARE_TOKEN_BYTES).toString('hex');

  constructor(opts = {}) {
    this.openTunnel = opts.openTunnel ?? openTunnelViaTunnelmole;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? SHARE_TTL_MS;
    this.maxBytes = opts.maxBytes ?? MAX_SHARE_BYTES;
    this.maxShares = opts.maxShares ?? MAX_ACTIVE_SHARES;
  }

  /* ---- public API -------------------------------------------------------- */
  /**
   * Publish one file. Everything is re-validated HERE: the renderer's path is
   * a request, not a fact, and main is the only thing that decides what a
   * public URL points at.
   *
   * Fails with a CODE, never a sentence, and never one that quotes the path.
   */
  async create(input) {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw || !path.isAbsolute(raw)) return { ok: false, error: 'notAbsolute' };
    this.sweep();
    if (this.shares.size >= this.maxShares) return { ok: false, error: 'tooMany' };
    let resolved, size;
    try {
      resolved = fs.realpathSync(raw);
      const st = fs.statSync(resolved);
      if (!st.isFile()) return { ok: false, error: 'notAFile' };
      size = st.size;
    } catch { return { ok: false, error: 'unreadable' }; }
    if (size > this.maxBytes) return { ok: false, error: 'tooBig' };
    if (!await this.ensureServer()) return { ok: false, error: 'noServer' };
    const base = await this.ensureTunnel();
    if (!base) {
      this.closeServerIfIdle();
      return { ok: false, error: 'noTunnel' };
    }
    const now = this.now();
    const share = {
      id: `fs-${crypto.randomBytes(8).toString('hex')}`,
      path: resolved,
      name: safeFileName(path.basename(resolved)),
      size,
      contentType: contentTypeFor(path.basename(resolved)),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      token: crypto.randomBytes(SHARE_TOKEN_BYTES).toString('hex'),
    };
    this.shares.set(share.token, share);
    this.byId.set(share.id, share.token);
    this.arm(share);
    return { ok: true, share: toShareView(share, base) };
  }

  /** Live shares, newest first. Sweeps first, so an expired one is never
   *  listed even if its timer has not fired yet. */
  list() {
    this.sweep();
    const base = this.server ? this.tunnelUrl : null;
    return [...this.shares.values()].sort((a, b) => b.createdAt - a.createdAt).map(s => toShareView(s, base));
  }

  /** Revoke by id. Removes the token from the Map and touches NOTHING on disk. */
  revoke(input) {
    const id = typeof input === 'string' ? input : '';
    const token = this.byId.get(id);
    if (!token) return { ok: false };
    this.drop(token);
    this.closeServerIfIdle();
    return { ok: true };
  }

  /** Revoke everything and close the listener. For app shutdown. */
  stop() {
    for (const token of [...this.shares.keys()]) this.drop(token);
    this.closeServer();
  }

  /** The tunnel root while shares are being served, else null. */
  publicUrl() { return this.server ? this.tunnelUrl : null; }
  /** The loopback port the listener is bound to, or 0. For tests. */
  localPort() { return this.server ? this.boundPort : 0; }
  /** How many shares are live right now (after a sweep). */
  activeCount() { this.sweep(); return this.shares.size; }

  /* ---- the served surface ------------------------------------------------ */
  /**
   * The whole public surface. Public so a test can drive it directly, but the
   * tests bind a real server and speak real HTTP to it, because the value here
   * IS the transport behaviour.
   */
  handleRequest(req, res) {
    this.sweep();
    if (!this.allowRequest()) { res.writeHead(429); res.end(); return; }
    if ((req.method ?? '') !== 'GET') { notFound(res); return; }
    const token = tokenFromPath(pathnameOf(req.url));
    if (!token) { notFound(res); return; }
    const share = this.shares.get(token) ?? null;
    const stored = share ? share.token : this.decoyToken;
    if (!constantTimeEqual(stored, token) || !share) { notFound(res); return; }
    let size;
    try {
      const st = fs.statSync(share.path);
      if (!st.isFile()) { this.drop(token); notFound(res); return; }
      size = st.size;
    } catch { this.drop(token); notFound(res); return; }
    res.writeHead(200, {
      'Content-Type': share.contentType,
      'Content-Length': String(size),
      'Content-Disposition': contentDisposition(share.name),
      // A share is a moving target: it stops existing in an hour, so nothing
      // downstream may keep a copy of it or of this response.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'none',
      'Referrer-Policy': 'no-referrer',
    });
    const stream = fs.createReadStream(share.path);
    stream.on('error', () => { res.destroy(); });
    res.on('close', () => { stream.destroy(); });
    stream.pipe(res);
  }

  /* ---- expiry ------------------------------------------------------------ */
  /** Drop every share whose hour has run out. Returns how many went. */
  sweep() {
    const now = this.now();
    let dropped = 0;
    for (const [token, share] of [...this.shares]) {
      if (isExpired(share, now)) { this.drop(token); dropped++; }
    }
    if (dropped > 0) this.closeServerIfIdle();
    return dropped;
  }
  /** Arm the per share revoker. Unref'd: an expiry timer must never be the
   *  reason the app refuses to quit. */
  arm(share) {
    const delay = Math.max(0, share.expiresAt - this.now());
    const timer = setTimeout(() => { this.drop(share.token); this.closeServerIfIdle(); }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(share.token, timer);
  }
  /** Forget one share. Nothing on disk is touched, ever. */
  drop(token) {
    const timer = this.timers.get(token);
    if (timer) { clearTimeout(timer); this.timers.delete(token); }
    const share = this.shares.get(token);
    if (share) this.byId.delete(share.id);
    this.shares.delete(token);
  }

  /* ---- transport --------------------------------------------------------- */
  allowRequest() {
    const now = this.now();
    if (!this.window || now - this.window.start > RATE_WINDOW_MS) {
      this.window = { start: now, count: 1 };
      return true;
    }
    this.window.count += 1;
    return this.window.count <= RATE_LIMIT;
  }
  /** One startup at a time. Concurrent creates share one attempt, the way
   *  ensureTunnel already does. */
  ensureServer() {
    if (this.server) return Promise.resolve(true);
    this.serverPending ??= this.startServer().finally(() => { this.serverPending = null; });
    return this.serverPending;
  }
  async startServer() {
    if (this.server) return true;
    try {
      await this.listen(this.boundPort);
      return true;
    } catch {
      if (!this.boundPort) return false;
      this.boundPort = 0;
      this.tunnelUrl = null;
      try {
        await this.listen(0);
        return true;
      } catch { return false; }
    }
  }
  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      const onError = e => reject(e);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        const addr = server.address();
        if (addr && typeof addr === 'object') this.boundPort = addr.port;
        this.server = server;
        resolve();
      });
    });
  }
  /** Open the tunnel once and reuse it. Concurrent creates share one attempt. */
  async ensureTunnel() {
    if (this.tunnelUrl) return this.tunnelUrl;
    if (!this.tunnelPending) {
      const port = this.boundPort;
      this.tunnelPending = withTimeout(this.openTunnel(port), TUNNEL_START_TIMEOUT_MS).then(url => {
        const base = typeof url === 'string' ? url.trim() : '';
        this.tunnelUrl = base ? base.replace(/\/+$/, '') : null;
        return this.tunnelUrl;
      }).catch(() => null).finally(() => { this.tunnelPending = null; });
    }
    return this.tunnelPending;
  }
  closeServerIfIdle() { if (this.shares.size === 0) this.closeServer(); }
  /**
   * Close the loopback listener.
   *
   * Closing this listener is what stops the bytes — that is what revocation is
   * here. tunnelmole exposes no close handle, so its client keeps running
   * inside this process with nothing behind it and the public URL answers with
   * a gateway error instead of a file. The bound port is REMEMBERED so the
   * next share re-binds it and reuses the tunnel already pointed at it.
   */
  closeServer() {
    const server = this.server;
    this.server = null;
    try { server?.close(); } catch {}
  }
}

module.exports = {
  FileShareStore, loadHero, parseHeroPayload, DEFAULT_HERO, HERO_URL,
  SHARE_TTL_MS, MAX_SHARE_BYTES, MAX_ACTIVE_SHARES, SHARE_TOKEN_BYTES,
  sharePath, shareUrl, tokenFromPath, expiresIn, safeFileName, contentTypeFor,
};
