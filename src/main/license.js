'use strict';
/**
 * Licensing — Pro entitlement, verbatim port of the reference layer
 * (index.js ~27195-27470). MDS-prefixed 3×5 Crockford-ish keys with a
 * weighted-mod-32 checksum, a per-device ed25519 public key the server
 * binds to, and an adaptive 15 min / 60 min recheck loop that keeps Pro
 * live for up to 14 days offline.
 *
 *   • Key shape:    MDS-XXXXX-XXXXX-XXXXX  (body = 15 symbols, last = checksum)
 *   • File:         <sharedDataDir>/teams/license.json   (mode 0600)
 *   • Device key:   <sharedDataDir>/teams/solo-device.json (ed25519 pub, b64)
 *   • Server:       OZYC_LICENCE_ORIGIN ?? https://harnessmd.com
 *       POST /api/licence/redeem  {key, device:{name,os,appVersion,publicKey}}
 *       POST /api/licence/check   {key, publicKey}
 *   • States:       'trialing' | 'healthy'   (licenceIsLive)
 *                   admits while checkedAt ≤ 14 d stale
 *   • Dev override: OZYC_DEV_PRO=1 (unpacked run) → forced 'healthy'
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const FOLD = { O: '0', I: '1', L: '1' };
const LICENSE_PREFIX = 'MDS';
const LICENSE_GROUPS = 3;
const LICENSE_GROUP_LEN = 5;
const LICENSE_BODY_LEN = LICENSE_GROUPS * LICENSE_GROUP_LEN;
const INVITE_RE = /^MD-[0-9A-Z]{4}-[0-9A-Z]{4}$/i;

function bare(input) {
  return (input ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}
function symbolValue(ch) {
  const folded = FOLD[ch] ?? ch;
  return ALPHABET.indexOf(folded);
}
function checksumOf(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const v = symbolValue(body[i]);
    if (v < 0) return '';
    sum = (sum + v * (i + 2)) % 32;
  }
  return ALPHABET[sum];
}
function formatLicense(body) {
  const groups = [];
  for (let i = 0; i < body.length; i += LICENSE_GROUP_LEN) groups.push(body.slice(i, i + LICENSE_GROUP_LEN));
  return [LICENSE_PREFIX, ...groups].join('-');
}
function checkLicense(input) {
  const raw = (input ?? '').trim();
  if (raw === '') return { key: null, problem: 'empty' };
  if (INVITE_RE.test(raw)) return { key: null, problem: 'looks-like-invite' };
  const all = bare(raw);
  if (!all.startsWith(LICENSE_PREFIX)) return { key: null, problem: 'wrong-prefix' };
  const body = all.slice(LICENSE_PREFIX.length);
  if (body.length !== LICENSE_BODY_LEN) return { key: null, problem: 'wrong-length' };
  const canonical = [];
  for (const ch of body) {
    const v = symbolValue(ch);
    if (v < 0) return { key: null, problem: 'bad-character' };
    canonical.push(ALPHABET[v]);
  }
  const fixed = canonical.join('');
  if (checksumOf(fixed.slice(0, -1)) !== fixed[fixed.length - 1]) {
    return { key: null, problem: 'bad-checksum' };
  }
  return { key: formatLicense(fixed), problem: null };
}
function licenseFrom(body14) {
  const up = bare(body14);
  if (up.length !== LICENSE_BODY_LEN - 1) throw new Error(`license body must be ${LICENSE_BODY_LEN - 1} symbols`);
  for (const ch of up) if (symbolValue(ch) < 0) throw new Error('license body has a symbol outside the alphabet');
  return formatLicense(up + checksumOf(up));
}
function licenceIsLive(view) {
  return view.state === 'trialing' || view.state === 'healthy';
}
const LICENSE_STALE_MAX_MS = 14 * 24 * 60 * 6e4;
function licenceAdmits(view, now = Date.now()) {
  if (!licenceIsLive(view)) return false;
  const t = Date.parse(view.checkedAt);
  return Number.isFinite(t) && now - t <= LICENSE_STALE_MAX_MS;
}
const LICENSE_POLL_MS = 15 * 6e4;
const LICENSE_LAPSED_POLL_MS = 60 * 6e4;
const LICENSE_ROUTES = {
  redeem: '/api/licence/redeem',
  check: '/api/licence/check',
};

// ── device identity + storage ────────────────────────────────────────────

function sharedDataDir(home) {
  return home ?? require('electron').app.getPath('userData');
}
function filePath(home) {
  return path.join(sharedDataDir(home), 'teams', 'license.json');
}
function deviceKeyPath(home) {
  return path.join(sharedDataDir(home), 'teams', 'solo-device.json');
}

function fingerprintFor(publicKeyB64) {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest();
  return (digest.subarray(0, 12).toString('hex').toUpperCase().match(/.{4}/g) ?? []).join(' ');
}
const b64ToB64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Stable per-machine id for the secrets-cipher fallback key (verbatim the
 * clone's own scheme — the reference derives its cipher from safeStorage and
 * never needs a device uuid; ours does when safeStorage is unavailable).
 * Persisted at <home>/.device-id so the AES-GCM key survives restarts.
 */
function deviceId(home) {
  const f = path.join(home ?? sharedDataDir(), '.device-id');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, id, { mode: 0o600 });
  } catch {}
  return id;
}

function soloDeviceKey(home) {
  const p = deviceKeyPath(home);
  if (fs.existsSync(p)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      const pk = parsed?.publicKey;
      if (typeof pk === 'string' && Buffer.from(pk, 'base64').length === 32) return pk;
    } catch {}
  }
  const der = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  const pk = der.subarray(der.length - 32).toString('base64');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ publicKey: pk, createdAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return pk;
}

// OzyComp is a local-only build: there is no licence server to call, so the
// entitlement is permanently "healthy" on every machine — packaged or dev.
// The DEV_PRO flag stays exported for tests, but nothing gates on it anymore.
const DEV_PRO = true;
const DEV_PRO_KEY = licenseFrom('0'.repeat(14));
function devProLicense() {
  return { key: DEV_PRO_KEY, state: 'healthy', renewsAt: null, deviceLabel: 'OzyComp local build', checkedAt: new Date().toISOString() };
}

function keyTail(key) { return key.slice(-4); }
function isView(v) {
  if (!v || typeof v !== 'object') return false;
  const r = v;
  return typeof r.key === 'string' && typeof r.state === 'string'
    && (r.renewsAt === null || typeof r.renewsAt === 'string')
    && (r.deviceLabel === null || typeof r.deviceLabel === 'string')
    && typeof r.checkedAt === 'string';
}
function readLicense(_home) {
  // Local build: always entitled. No licence.json is read and none is needed —
  // the renderer gate (proGateAdmits / licenceIsLive) sees a healthy view and
  // the app goes straight past onboarding/paywall to the hive picker.
  return devProLicense();
}
function writeLicense(view, home) {
  const p = filePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(view, null, 2), { encoding: 'utf8', mode: 0o600 });
}
function clearLicense(home) {
  try { fs.rmSync(filePath(home), { force: true }); } catch {}
}

// ── subscribers ──────────────────────────────────────────────────────────

const subscribers = new Set();
function onLicenseChange(cb) {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
function notify(home) {
  const v = readLicense(home);
  subscribers.forEach((fn) => { try { fn(v); } catch {} });
}
function forgetLicense(home) {
  clearLicense(home);
  notify(home);
}

// ── network ──────────────────────────────────────────────────────────────

const LICENSE_ORIGIN = process.env.OZYC_LICENCE_ORIGIN ?? 'https://harnessmd.com';

function refusalOf(status, body) {
  const detail = typeof body?.detail === 'string' && body.detail.trim() !== '' ? body.detail : null;
  const named = typeof body?.error === 'string' ? body.error : '';
  if (named === 'invalid' || named === 'used' || named === 'expired') return { error: named, detail };
  if (status === 400 || status === 404) return { error: 'invalid', detail };
  if (status === 409) return { error: 'used', detail };
  if (status === 410) return { error: 'expired', detail };
  return { error: 'refused', detail };
}

async function redeemLicense(key, _home) {
  // Local build: no licence server exists, so a key is never required. Accept
  // any input and keep the always-healthy view so the UI never blocks.
  const record = devProLicense();
  return { ok: true, license: record };
}

/* eslint-disable no-unused-vars */
async function _redeemLicenseAgainstServer(key, home) {
  const publicKey = soloDeviceKey(home);
  const device = {
    name: os.hostname().slice(0, 80),
    os: `${process.platform} ${os.release()}`.slice(0, 40),
    appVersion: (() => { try { return require('electron').app.getVersion().slice(0, 20); } catch { return '0.0.0'; } })(),
    publicKey: b64ToB64url(publicKey),
  };
  let res;
  try {
    res = await fetch(`${LICENSE_ORIGIN}${LICENSE_ROUTES.redeem}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, device }),
      signal: AbortSignal.timeout(15e3),
    });
  } catch { return { ok: false, error: 'offline', detail: null }; }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const r = refusalOf(res.status, body ?? {});
    console.log(`[solo] redeem refused: ${r.error} (key …${keyTail(key)})`);
    return { ok: false, ...r };
  }
  const view = body;
  if (view.fingerprint !== fingerprintFor(publicKey)) {
    return { ok: false, error: 'refused', detail: 'The server answered for a different machine, so nothing was saved. Try again.' };
  }
  const record = {
    key: typeof view.key === 'string' ? view.key : key,
    state: view.state,
    renewsAt: typeof view.renewsAt === 'string' ? view.renewsAt : null,
    deviceLabel: typeof view.boundTo === 'string' ? view.boundTo : null,
    checkedAt: typeof view.checkedAt === 'string' ? view.checkedAt : new Date().toISOString(),
  };
  if (!isView(record)) {
    return { ok: false, error: 'refused', detail: 'The server answer was not readable, so nothing was saved. Try again.' };
  }
  writeLicense(record, home);
  notify(home);
  console.log(`[solo] licence redeemed (key …${keyTail(record.key)}, state ${record.state})`);
  return { ok: true, license: record };
}

async function recheckLicense(_home, _signal) {
  // Local build: nothing to recheck against — the licence never lapses.
  return 'confirmed';
}

/* eslint-disable no-unused-vars */
async function _recheckLicenseAgainstServer(home, signal) {
  if (DEV_PRO) return 'confirmed';
  const rec = readLicense(home);
  if (!rec) return 'none';
  const deactivate = (why) => {
    clearLicense(home);
    notify(home);
    console.log(`[solo] licence check: key …${keyTail(rec.key)} ${why}; this machine is out of Pro`);
  };
  const offline = () => {
    if (!licenceAdmits(rec)) notify(home);
    return 'offline';
  };
  let res;
  try {
    res = await fetch(`${LICENSE_ORIGIN}${LICENSE_ROUTES.check}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: rec.key, publicKey: b64ToB64url(soloDeviceKey(home)) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15e3)]) : AbortSignal.timeout(15e3),
    });
  } catch { return offline(); }
  if (res.status === 404 || res.status === 400) {
    const refusal = await res.json().catch(() => null);
    if (typeof refusal?.detail === 'string' && refusal.detail.trim() !== '') {
      deactivate('no longer exists (revoked or replaced)');
      return 'deactivated';
    }
    return offline();
  }
  if (!res.ok) return offline();
  const body = await res.json().catch(() => null);
  const v = body;
  if (!v || typeof v.key !== 'string' || typeof v.state !== 'string') return offline();
  if (v.bound !== true) {
    deactivate('is on another machine now');
    return 'deactivated';
  }
  const record = {
    key: v.key,
    state: v.state,
    renewsAt: typeof v.renewsAt === 'string' ? v.renewsAt : null,
    deviceLabel: typeof v.boundTo === 'string' ? v.boundTo : rec.deviceLabel,
    checkedAt: typeof v.checkedAt === 'string' ? v.checkedAt : new Date().toISOString(),
  };
  if (!isView(record)) return offline();
  writeLicense(record, home);
  notify(home);
  return licenceIsLive(record) ? 'confirmed' : 'lapsed';
}

function startLicenseRecheckLoop(home) {
  let timer = null;
  let stopped = false;
  const controller = new AbortController();
  const tick = async () => {
    const outcome = await recheckLicense(home, controller.signal).catch(() => 'offline');
    if (stopped) return;
    const delay = outcome === 'lapsed' ? LICENSE_LAPSED_POLL_MS : LICENSE_POLL_MS;
    timer = setTimeout(() => { void tick(); }, delay);
    timer.unref();
  };
  void tick();
  return () => {
    stopped = true;
    controller.abort();
    if (timer) clearTimeout(timer);
  };
}

/**
 * LicenseManager — thin stateful adapter the IPC layer instantiates once.
 * Wraps the verbatim module functions with a bound `home` so the handlers
 * keep their `read()`/`redeem()`/`forget()`/`onChange()` shape.
 */
class LicenseManager {
  constructor({ home, emit } = {}) {
    this.home = home ?? null;
    this._emit = emit ?? null;
    this._stopRecheck = null;
  }
  read() { return readLicense(this.home) ?? { plan: 'free' }; }
  current() { return this.read(); }
  state() {
    const v = readLicense(this.home);
    return v ? { licensed: licenceIsLive(v), ...v } : { licensed: false, plan: 'free' };
  }
  async redeem(key) { return redeemLicense(key, this.home); }
  async recheck() { return recheckLicense(this.home); }
  // Local build: a "trial" is meaningless — every run is already entitled.
  // registerTrial returns the healthy view so the renderer's trial button no-ops.
  async registerTrial() { return { ok: true, license: devProLicense() }; }
  forget() { forgetLicense(this.home); }
  onChange(fn) { return onLicenseChange(fn); }
  startChecking() { return this.start(); }
  start() {
    if (!this._stopRecheck) this._stopRecheck = startLicenseRecheckLoop(this.home);
    return this;
  }
  stop() {
    try { this._stopRecheck?.(); } catch {}
    this._stopRecheck = null;
  }
  admits() { return licenceAdmits(readLicense(this.home) ?? {}); }
  isLive() { const v = readLicense(this.home); return v ? licenceIsLive(v) : false; }
}

module.exports = {
  ALPHABET, FOLD, LICENSE_PREFIX, LICENSE_GROUPS, LICENSE_GROUP_LEN, LICENSE_BODY_LEN,
  bare, symbolValue, checksumOf, formatLicense, checkLicense, licenseFrom,
  licenceIsLive, licenceAdmits, LICENSE_STALE_MAX_MS, LICENSE_POLL_MS, LICENSE_LAPSED_POLL_MS,
  LICENSE_ROUTES, LICENSE_ORIGIN, filePath, deviceKeyPath, fingerprintFor, b64ToB64url,
  soloDeviceKey, deviceId, DEV_PRO, DEV_PRO_KEY, devProLicense, keyTail, isView,
  readLicense, writeLicense, clearLicense, forgetLicense, onLicenseChange,
  refusalOf, redeemLicense, recheckLicense, startLicenseRecheckLoop,
  LicenseManager,
};
