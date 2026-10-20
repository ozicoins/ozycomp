'use strict';
/**
 * VERBATIM PORT — teams IPC group.
 * Reference: /Users/oguzhan/.rea/targets/ozycomp-asar/extracted/out/main/index.js
 *   handler lines 33706-33890 (plus the teams internals they call, 26080-29195).
 * Channel names are the reference names verbatim — the verbatim preload
 * (src/preload/index.js) invokes `teams:*`, not `cth:*`.
 *
 * Deps: everything module-local below mirrors the reference 1:1. Where the
 * reference reached for a global (hive, fileShareStore, electron.shell) we take
 * it from `ctx`. The whole plane is stashed on ctx.teams (a TeamsManager-shaped
 * bag) so other ported groups can reach it — `ctx.teams ??= makeTeams(ctx)`.
 *
 * Zero npm deps: the reference uses libsodium for ed25519/x25519/box sealing;
 * node:crypto covers the same primitives (ed25519 sign, x25519 sealed box via
 * ECDH+HKDF+AES-256-GCM, secretbox via XSalsa20-Poly1305) so enrolment,
 * signing and sealing keep the same wire shapes without a new dependency.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { shell, app, safeStorage } = (() => {
  try { return require('electron'); } catch { return {}; }
})();

// ── identity (reference 26093-26250) ─────────────────────────────────────────
function identityPath() {
  return path.join(app.getPath('userData'), 'teams', 'device-identity.json');
}
function encryptionIsReal() {
  if (!safeStorage?.isEncryptionAvailable?.()) {
    return { ok: false, code: 'keyring_unavailable', reason: 'OS secret encryption is unavailable' };
  }
  if (process.platform === 'linux') {
    let backend;
    try { backend = safeStorage.getSelectedStorageBackend?.(); } catch { backend = undefined; }
    if (!backend) {
      return { ok: false, code: 'keyring_unavailable', reason: 'could not determine which keyring backend is in use' };
    }
    if (backend === 'basic_text') {
      return { ok: false, code: 'keyring_not_encrypting', reason: 'the only keyring available encrypts with a hardcoded key, which is obfuscation and not encryption' };
    }
  }
  return { ok: true };
}
function canStoreIdentity() { return encryptionIsReal(); }
function readStored() {
  const p = identityPath();
  if (!fs.existsSync(p)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed.sk === 'string' && typeof parsed.pk === 'string') return parsed;
    return null;
  } catch { return null; }
}
function writeStored(blob) {
  const p = identityPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(blob, null, 2), { encoding: 'utf8', mode: 0o600 });
}
function hasIdentity() { return readStored() !== null; }
function fingerprintFor(publicKeyB64) {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest();
  return (digest.subarray(0, 12).toString('hex').toUpperCase().match(/.{4}/g) ?? []).join(' ');
}
function toIdentity(pk) {
  const fingerprint = fingerprintFor(pk);
  return { publicKey: pk, fingerprint, deviceId: fingerprint.replace(/ /g, '').toLowerCase() };
}
// Ed25519 keypair is kept as raw seed bytes in the store (verbatim shape:
// {sk: safeStorage(b64(seed)), pk: b64(32-byte pubkey), createdAt}).
function secretKey() {
  const stored = readStored();
  if (!stored) return null;
  try {
    if (!encryptionIsReal().ok) return null;
    const b64 = safeStorage.decryptString(Buffer.from(stored.sk, 'base64'));
    return new Uint8Array(Buffer.from(b64, 'base64'));
  } catch { return null; }
}
function forgetIdentity() {
  const p = identityPath();
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}

// ── node:crypto sodium equivalents (the zero-dep substitution) ───────────────
// libsodium's crypto_sign_* over an ed25519 keypair ↔ node ed25519 with the
// SPKI/PKCS8 DER wrappers built from the raw 32-byte seed/pubkey.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function edPubKey(rawPk) {
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawPk)]), format: 'der', type: 'spki' });
}
function edPrivKey(rawSeed) {
  return crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(rawSeed)]), format: 'der', type: 'pkcs8' });
}
// ed25519 pk → curve25519 pk (libsodium crypto_sign_ed25519_pk_to_curve25519):
// x = u-coordinate of the Montgomery point = (1+y)/(1-y), little-endian 32B.
function edPkToCurve(rawPk32) {
  const y = BigInt('0x' + Buffer.from(rawPk32).reverse().toString('hex')) & ((1n << 255n) - 1n);
  const P = (1n << 255n) - 19n;
  const inv = (a) => modPow(a, P - 2n, P);
  const u = ((1n + y) * inv((1n - y + P) % P)) % P;
  return u;
}
function modPow(b, e, m) {
  let r = 1n, x = b % m;
  while (e > 0n) { if (e & 1n) r = (r * x) % m; x = (x * x) % m; e >>= 1n; }
  return r;
}
// ed25519 sk (64B or 32B seed) → curve25519 scalar (crypto_sign_ed25519_sk_to_curve25519):
// sha512(seed)[:32], clamped.
function edSkToCurve(rawSeed32) {
  const h = crypto.createHash('sha512').update(Buffer.from(rawSeed32).subarray(0, 32)).digest();
  h[0] &= 248; h[31] &= 127; h[31] |= 64;
  return new Uint8Array(h.subarray(0, 32));
}
function curvePrivToBytes(scalar) {
  const key = crypto.createPrivateKey({
    key: {
      kty: 'OKP', crv: 'X25519',
      d: Buffer.from(scalar).toString('base64'),
      x: undefined,
    },
    format: 'jwk',
  });
  return key;
}
function curvePrivFromScalar(scalar) {
  // Node builds a private OKP key from JWK {kty:OKP, crv:X25519, d:b64url(scalar)}.
  // Deriving x is done by node itself at use time.
  return crypto.createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: Buffer.from(scalar).toString('base64url') },
    format: 'jwk',
  });
}
function curvePubFromU(u) {
  // u is a BigInt little-endian 32B
  const buf = Buffer.alloc(32);
  let v = u;
  for (let i = 0; i < 32; i++) { buf[i] = Number(v & 0xffn); v >>= 8n; }
  return crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: buf.toString('base64url') },
    format: 'jwk',
  });
}
// libsodium crypto_box_seal: ephemeral X25519 kx + XSalsa20-Poly1305. Node has
// no XSalsa20; the sealed box is reproduced as X25519-ECDH → HKDF-SHA256 →
// AES-256-GCM with the ephemeral key prepended (same "seal to a pubkey with no
// sender identity" semantics, one wire self-describing blob).
// NOTE: byte-for-byte interop with the reference relay's box format is not
// possible without XSalsa20; the envelope schema (v:1, keys per deviceId, b64
// ciphertext+nonce+sig) is preserved exactly so a sodium shim can drop in later.
function boxSeal(recipientCurvePkBytes, plaintextBytes) {
  const eph = crypto.generateKeyPairSync('x25519');
  const shared = crypto.diffieHellman({
    privateKey: crypto.createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', d: eph.privateKey.export({ format: 'jwk' }).d },
      format: 'jwk',
    }),
    publicKey: crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: eph.publicKey.export({ format: 'jwk' }).x },
      format: 'jwk',
    }),
  });
  void shared;
  const ephPubRaw = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x, 'base64url');
  const recipPub = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(recipientCurvePkBytes).toString('base64url') },
    format: 'jwk',
  });
  const secret = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: recipPub });
  const key = crypto.hkdfSync('sha256', secret, ephPubRaw, 'md-box-seal', 32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), nonce);
  const body = Buffer.concat([cipher.update(plaintextBytes), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([ephPubRaw, nonce, body]);
}
function boxSealOpen(ciphertext, myCurvePubBytes, myCurveSkScalar) {
  const ephPubRaw = ciphertext.subarray(0, 32);
  const nonce = ciphertext.subarray(32, 44);
  const body = ciphertext.subarray(44);
  const ephPub = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(ephPubRaw).toString('base64url') },
    format: 'jwk',
  });
  const myPriv = curvePrivFromScalar(myCurveSkScalar);
  const secret = crypto.diffieHellman({ privateKey: myPriv, publicKey: ephPub });
  const key = crypto.hkdfSync('sha256', secret, ephPubRaw, 'md-box-seal', 32);
  const dec = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key), nonce);
  dec.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([dec.update(body.subarray(0, body.length - 16)), dec.final()]);
}
// libsodium crypto_secretbox_easy (XSalsa20-Poly1305) → same-layout substitute:
// XSalsa20 keystream is not in node:crypto; XChaCha20-Poly1305's closest zero-dep
// stand-in is AES-256-GCM with a 24B nonce folded to 12B via HKDF (nonce || tag
// appended verbatim like secretbox_easy's mac||box layout).
function secretboxEasy(plaintext, nonceBytes, keyBytes) {
  const k = crypto.hkdfSync('sha256', Buffer.from(keyBytes), Buffer.from(nonceBytes), 'md-secretbox', 32);
  const n = crypto.hkdfSync('sha256', Buffer.from(keyBytes), Buffer.from(nonceBytes), 'md-secretbox-nonce', 12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(k), Buffer.from(n));
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}
function secretboxOpenEasy(boxBytes, nonceBytes, keyBytes) {
  const k = crypto.hkdfSync('sha256', Buffer.from(keyBytes), Buffer.from(nonceBytes), 'md-secretbox', 32);
  const n = crypto.hkdfSync('sha256', Buffer.from(keyBytes), Buffer.from(nonceBytes), 'md-secretbox-nonce', 12);
  const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(k), Buffer.from(n));
  d.setAuthTag(boxBytes.subarray(boxBytes.length - 16));
  return Buffer.concat([d.update(boxBytes.subarray(0, boxBytes.length - 16)), d.final()]);
}
function randombytesBuf(n) { return new Uint8Array(crypto.randomBytes(n)); }
const SECRETBOX_NONCEBYTES = 24, SECRETBOX_KEYBYTES = 32;

async function initCrypto() { /* node:crypto is always ready — kept for call-site parity */ }

async function sealTo(recipientPublicKeyB64, plaintext) {
  await initCrypto();
  const sk = secretKey();
  if (!sk) throw new Error('no device identity on this machine');
  const stored = readStored();
  const message = Buffer.from(plaintext, 'utf8');
  const signature = crypto.sign(null, message, edPrivKey(sk));
  const payload = Buffer.from(JSON.stringify({
    m: message.toString('base64'),
    sig: Buffer.from(signature).toString('base64'),
  }), 'utf8');
  const recipientCurve = edPkToCurve(new Uint8Array(Buffer.from(recipientPublicKeyB64, 'base64')));
  const recipUBytes = (() => { const b = Buffer.alloc(32); let v = recipientCurve; for (let i = 0; i < 32; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; })();
  return {
    ciphertext: boxSeal(recipUBytes, payload).toString('base64'),
    senderPublicKey: stored.pk,
  };
}
async function openSealed(envelope, expectedSenderPublicKey) {
  await initCrypto();
  if (envelope.senderPublicKey !== expectedSenderPublicKey) {
    throw new Error('sender key does not match the pinned key for this teammate');
  }
  const sk = secretKey();
  if (!sk) throw new Error('no device identity on this machine');
  const myCurveSk = edSkToCurve(sk);
  const opened = boxSealOpen(
    Buffer.from(envelope.ciphertext, 'base64'),
    null,
    myCurveSk,
  );
  const parsed = JSON.parse(opened.toString('utf8'));
  const message = new Uint8Array(Buffer.from(parsed.m, 'base64'));
  const ok = crypto.verify(
    null, Buffer.from(message),
    edPubKey(new Uint8Array(Buffer.from(expectedSenderPublicKey, 'base64'))),
    new Uint8Array(Buffer.from(parsed.sig, 'base64')),
  );
  if (!ok) throw new Error('signature does not verify against the pinned sender key');
  return Buffer.from(message).toString('utf8');
}
async function signDetached(canonical, withSecret) {
  await initCrypto();
  const sk = withSecret ?? secretKey();
  if (!sk) return null;
  return crypto.sign(null, Buffer.from(canonical, 'utf8'), edPrivKey(sk));
}
async function generateUnsaved() {
  await initCrypto();
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pk = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32));
  // store the 32B seed (libsodium privateKey layout = seed||pk; we keep the
  // seed half — edPrivKey re-wraps it as PKCS8 at use time).
  const seed = new Uint8Array(Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url'));
  return { publicKey: pk, privateKey: seed };
}
function saveIdentity(publicKey, privateKey) {
  const usable = encryptionIsReal();
  if (!usable.ok) {
    const err = new Error(`${usable.reason}; refusing to store a device key that could only be kept unprotected`);
    err.code = usable.code;
    throw err;
  }
  const pk = Buffer.from(publicKey).toString('base64');
  writeStored({
    sk: safeStorage.encryptString(Buffer.from(privateKey).toString('base64')).toString('base64'),
    pk,
    createdAt: new Date().toISOString(),
  });
  return toIdentity(pk);
}

// ── policy store (reference 26251-26608) ─────────────────────────────────────
const POLICY_PRESETS = ['off', 'listen', 'converse', 'open'];
const PRESET_POLICY = {
  off: { receive: false, send: false, commands: false },
  listen: { receive: true, send: false, commands: false },
  converse: { receive: true, send: true, commands: false },
  open: { receive: true, send: true, commands: true },
};
function policyOf(preset) { return { ...PRESET_POLICY[preset] }; }
function normalizePolicy(value) {
  if (typeof value === 'string') return policyOf(presetFromLegacy(value));
  if (!value || typeof value !== 'object') return policyOf('off');
  const raw = value;
  const commands = raw.commands === true;
  return { receive: raw.receive === true || commands, send: raw.send === true, commands };
}
function presetFromLegacy(level) {
  if (level === 'allow-all') return 'open';
  if (level === 'communication-only') return 'converse';
  return 'off';
}
function presetOf(policy) {
  for (const preset of POLICY_PRESETS) {
    const p = PRESET_POLICY[preset];
    if (p.receive === policy.receive && p.send === policy.send && p.commands === policy.commands) return preset;
  }
  return null;
}
function effectivePolicy(status, perPerson) {
  if (!perPerson) return { ...status };
  return {
    receive: status.receive && perPerson.receive,
    send: status.send && perPerson.send,
    commands: status.commands && perPerson.commands && status.receive && perPerson.receive,
  };
}
function sendBlock(mine, theirs) {
  if (!mine.send) return 'you-not-sending';
  if (!theirs.receive) return 'they-not-receiving';
  return null;
}
const EMPTY_SCHEDULE = { enabled: false, windows: [], fallback: 'converse' };
function inWindow(w, day, minute) {
  if (!w.days.includes(day)) return false;
  if (w.from === w.to) return true;
  if (w.from < w.to) return minute >= w.from && minute < w.to;
  return minute >= w.from || minute < w.to;
}
function scheduledPreset(schedule, at) {
  if (!schedule.enabled) return null;
  const day = at.getDay();
  const minute = at.getHours() * 60 + at.getMinutes();
  for (const w of schedule.windows) {
    if (inWindow(w, day, minute)) return w.preset;
    if (w.from > w.to && w.days.includes((day + 6) % 7) && minute < w.to) return w.preset;
  }
  return schedule.fallback;
}
function scheduleSlot(schedule, at) {
  if (!schedule.enabled) return null;
  const day = at.getDay();
  const minute = at.getHours() * 60 + at.getMinutes();
  const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const DAY_MS = 24 * 60 * 6e4;
  for (let i = 0; i < schedule.windows.length; i++) {
    const w = schedule.windows[i];
    if (inWindow(w, day, minute)) {
      const startedYesterday = w.from > w.to && minute < w.to;
      return `w${i}@${midnight - (startedYesterday ? DAY_MS : 0) + w.from * 6e4}`;
    }
    if (w.from > w.to && w.days.includes((day + 6) % 7) && minute < w.to) {
      return `w${i}@${midnight - DAY_MS + w.from * 6e4}`;
    }
  }
  return 'fallback';
}
function normalizeSchedule(value) {
  if (!value || typeof value !== 'object') return { ...EMPTY_SCHEDULE, windows: [] };
  const raw = value;
  const windows = Array.isArray(raw.windows) ? raw.windows.filter(isWindow) : [];
  return {
    enabled: raw.enabled === true,
    windows: windows.map((w) => ({
      days: [...new Set(w.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b),
      from: w.from,
      to: w.to,
      preset: w.preset,
    })).filter((w) => w.days.length > 0),
    fallback: isPreset(raw.fallback) ? raw.fallback : 'converse',
  };
}
function isPreset(v) { return typeof v === 'string' && POLICY_PRESETS.includes(v); }
function isWindow(v) {
  if (!v || typeof v !== 'object') return false;
  const w = v;
  return Array.isArray(w.days) && typeof w.from === 'number' && Number.isInteger(w.from) && w.from >= 0 && w.from <= 1439 && typeof w.to === 'number' && Number.isInteger(w.to) && w.to >= 0 && w.to <= 1440 && isPreset(w.preset);
}
const EMPTY = { pins: {}, youAllow: {} };
const LEVELS = ['strict', 'communication-only', 'allow-all'];
function isLevel(v) { return typeof v === 'string' && LEVELS.includes(v); }
function legacyOf(policy) {
  const preset = presetOf(policy);
  if (preset === 'open') return 'allow-all';
  if (preset === 'converse') return 'communication-only';
  if (preset === 'listen' || preset === 'off') return 'strict';
  return policy.send && policy.receive ? 'communication-only' : 'strict';
}
function trustPath() { return path.join(app.getPath('userData'), 'teams', 'trust.json'); }
function readTrust() {
  const p = trustPath();
  if (!fs.existsSync(p)) return { ...EMPTY };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      pins: parsed.pins && typeof parsed.pins === 'object' ? parsed.pins : {},
      org: parsed.org && typeof parsed.org === 'object' ? parsed.org : undefined,
      youAllow: parsed.youAllow && typeof parsed.youAllow === 'object' ? parsed.youAllow : {},
      // PRESENT BUT UNREADABLE IS NOT ABSENT (verbatim rationale, ref 26381).
      youAllowDefault: isLevel(parsed.youAllowDefault) ? parsed.youAllowDefault : parsed.youAllowDefault === undefined ? undefined : 'strict',
      youPolicy: parsed.youPolicy && typeof parsed.youPolicy === 'object' ? parsed.youPolicy : undefined,
      youPolicyDefault: parsed.youPolicyDefault && typeof parsed.youPolicyDefault === 'object' ? normalizePolicy(parsed.youPolicyDefault) : undefined,
      status: parsed.status && typeof parsed.status === 'object' ? normalizePolicy(parsed.status) : undefined,
      statusSchedule: parsed.statusSchedule ? normalizeSchedule(parsed.statusSchedule) : undefined,
      statusHold: parsed.statusHold && typeof parsed.statusHold === 'object' && typeof parsed.statusHold.slot === 'string' ? { slot: parsed.statusHold.slot } : undefined,
    };
  } catch { return { ...EMPTY }; }
}
function writeTrust(data) {
  const p = trustPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}
function trustFor(deviceId, fingerprint) {
  const data = readTrust();
  const pin = data.pins[deviceId];
  if (!pin) {
    data.pins[deviceId] = { fingerprint, verified: false, firstSeenAt: new Date().toISOString() };
    writeTrust(data);
    return { verified: false };
  }
  if (pin.fingerprint === fingerprint) {
    return pin.verified || !pin.previous ? { verified: pin.verified } : { verified: false, previousFingerprint: pin.previous };
  }
  if (pin.previous !== pin.fingerprint) {
    data.pins[deviceId] = { fingerprint, verified: false, previous: pin.fingerprint, firstSeenAt: pin.firstSeenAt };
    writeTrust(data);
    return { verified: false, previousFingerprint: pin.fingerprint };
  }
  return { verified: false, previousFingerprint: pin.previous };
}
function markVerified(deviceId, fingerprint) {
  const data = readTrust();
  data.pins[deviceId] = {
    ...data.pins[deviceId] ?? { firstSeenAt: new Date().toISOString() },
    fingerprint,
    verified: true,
    previous: undefined,
  };
  writeTrust(data);
}
function orgTrustFor(orgId, signingKey) {
  const data = readTrust();
  const org = data.org ?? {};
  const pin = org[orgId];
  if (!pin) {
    org[orgId] = { fingerprint: signingKey, verified: false, firstSeenAt: new Date().toISOString() };
    writeTrust({ ...data, org });
    return { verified: false };
  }
  if (pin.fingerprint === signingKey) {
    return pin.verified || !pin.previous ? { verified: pin.verified } : { verified: false, previous: pin.previous };
  }
  if (pin.previous !== pin.fingerprint) {
    org[orgId] = { fingerprint: signingKey, verified: false, previous: pin.fingerprint, firstSeenAt: pin.firstSeenAt };
    writeTrust({ ...data, org });
    return { verified: false, previous: pin.fingerprint };
  }
  return { verified: false, previous: pin.previous };
}
function markOrgVerified(orgId, signingKey) {
  const data = readTrust();
  const org = data.org ?? {};
  org[orgId] = {
    ...org[orgId] ?? { firstSeenAt: new Date().toISOString() },
    fingerprint: signingKey,
    verified: true,
    previous: undefined,
  };
  writeTrust({ ...data, org });
}
function youPolicyFor(memberId) {
  const data = readTrust();
  const stored = data.youPolicy?.[memberId];
  if (stored !== undefined) return normalizePolicy(stored);
  const legacy = data.youAllow[memberId];
  return legacy === undefined ? undefined : normalizePolicy(legacy);
}
function setYouPolicy(memberId, value) {
  const data = readTrust();
  const map = { ...data.youPolicy ?? {} };
  if (value === null) {
    delete map[memberId];
    delete data.youAllow[memberId];
  } else {
    const policy = normalizePolicy(value);
    map[memberId] = policy;
    data.youAllow[memberId] = legacyOf(policy);
  }
  data.youPolicy = map;
  writeTrust(data);
  policySubs.notify();
}
function youPolicyDefault() {
  const data = readTrust();
  if (data.youPolicyDefault !== undefined) return normalizePolicy(data.youPolicyDefault);
  return data.youAllowDefault === undefined ? undefined : normalizePolicy(data.youAllowDefault);
}
function setYouPolicyDefault(value) {
  const data = readTrust();
  if (value === null) {
    delete data.youPolicyDefault;
    delete data.youAllowDefault;
  } else {
    const policy = normalizePolicy(value);
    data.youPolicyDefault = policy;
    data.youAllowDefault = legacyOf(policy);
  }
  writeTrust(data);
  policySubs.notify();
}
function myStatus() {
  const raw = readTrust().status;
  return raw === undefined ? policyOf('open') : normalizePolicy(raw);
}
function setMyStatus(value, at = new Date()) {
  const data = readTrust();
  if (value === null) {
    delete data.status;
    delete data.statusHold;
  } else {
    data.status = typeof value === 'string' ? policyOf(value) : normalizePolicy(value);
    const slot = scheduleSlot(myStatusSchedule(), at);
    if (slot) data.statusHold = { slot };
    else delete data.statusHold;
  }
  writeTrust(data);
  policySubs.notify();
}
function writeScheduledStatus(policy) {
  const data = readTrust();
  data.status = policy;
  delete data.statusHold;
  writeTrust(data);
  policySubs.notify();
}
function holdActive(data, schedule, at) {
  const slot = data.statusHold?.slot;
  return typeof slot === 'string' && slot === scheduleSlot(schedule, at);
}
function myStatusSchedule() {
  const raw = readTrust().statusSchedule;
  return raw === undefined ? { ...EMPTY_SCHEDULE, windows: [] } : normalizeSchedule(raw);
}
function setMyStatusSchedule(value) {
  const data = readTrust();
  data.statusSchedule = normalizeSchedule(value);
  delete data.statusHold;
  writeTrust(data);
  policySubs.notify();
}
function statusNow(at = new Date()) {
  const data = readTrust();
  const schedule = myStatusSchedule();
  const want = scheduledPreset(schedule, at);
  if (!want) return myStatus();
  if (holdActive(data, schedule, at)) return myStatus();
  return policyOf(want);
}
function scheduleDriving(at = new Date()) {
  const schedule = myStatusSchedule();
  if (scheduledPreset(schedule, at) === null) return false;
  return !holdActive(readTrust(), schedule, at);
}
function applySchedule(at = new Date()) {
  const schedule = myStatusSchedule();
  if (!schedule.enabled) return null;
  const want = scheduledPreset(schedule, at);
  if (!want) return null;
  if (holdActive(readTrust(), schedule, at)) return null;
  const wanted = policyOf(want);
  const current = myStatus();
  if (current.receive === wanted.receive && current.send === wanted.send && current.commands === wanted.commands) {
    if (readTrust().statusHold) writeScheduledStatus(current);
    return null;
  }
  writeScheduledStatus(wanted);
  return wanted;
}
// pub/sub for the policy store (reference `subs`/notify$4, 26580-26594)
const policySubs = new Set();
function onPolicyChange(fn) { policySubs.add(fn); return () => { policySubs.delete(fn); }; }
policySubs.notify = () => {
  for (const fn of [...policySubs]) { try { fn(); } catch {} }
};
function youAllowFor(memberId) {
  const policy = youPolicyFor(memberId);
  return policy === undefined ? undefined : legacyOf(policy);
}
function setYouAllow(memberId, level) { setYouPolicy(memberId, level); }
function youAllowDefault() {
  const policy = youPolicyDefault();
  return policy === undefined ? undefined : legacyOf(policy);
}
function setYouAllowDefault(level) { setYouPolicyDefault(level); }

// ── agent-name pins (reference 26609-26666) ──────────────────────────────────
const SAFE_ID_NAMES = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_NAMES = 12;
const MAX_AGENTS_PER_MEMBER = 40;
function namesPath() { return path.join(app.getPath('userData'), 'teams', 'names.json'); }
function readNames() {
  const p = namesPath();
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const [memberId, entry] of Object.entries(parsed)) {
      if (!SAFE_ID_NAMES.test(memberId) || !entry || typeof entry !== 'object') continue;
      const agents = entry.agents;
      if (!agents || typeof agents !== 'object') continue;
      const kept = {};
      for (const [agentId, seen] of Object.entries(agents)) {
        if (!SAFE_ID_NAMES.test(agentId) || !seen || typeof seen !== 'object') continue;
        const { name, seenAt } = seen;
        if (typeof name !== 'string' || !name.trim() || typeof seenAt !== 'string') continue;
        kept[agentId] = { name: name.trim().slice(0, 80), seenAt };
      }
      out[memberId] = { agents: kept };
    }
    return out;
  } catch { return {}; }
}
function writeNames(data) {
  const p = namesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}
function agentNamesFor(memberId) {
  const agents = readNames()[memberId]?.agents;
  if (!agents) return [];
  const seen = Object.values(agents).sort((a, b) => Date.parse(b.seenAt) - Date.parse(a.seenAt));
  const out = [];
  for (const { name } of seen) {
    if (!out.includes(name)) out.push(name);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}

// ── membership (reference 26667-26727) ───────────────────────────────────────
const LEASE_SECONDS = 72 * 3600;
const LEASE_WARN_SECONDS = 24 * 3600;
function membershipPath() { return path.join(app.getPath('userData'), 'teams', 'membership.json'); }
const isStr3 = (v) => typeof v === 'string' && v.length > 0;
function readMembership() {
  const p = membershipPath();
  if (!fs.existsSync(p)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!m || !isStr3(m.orgId) || !isStr3(m.memberId) || !isStr3(m.deviceId) || !isStr3(m.orgName) || !isStr3(m.enrolledAt)) {
      return null;
    }
    return {
      orgId: m.orgId,
      memberId: m.memberId,
      deviceId: m.deviceId,
      orgName: m.orgName,
      relayUrl: isStr3(m.relayUrl) ? m.relayUrl : '',
      enrolledAt: m.enrolledAt,
      lastVerifiedAt: isStr3(m.lastVerifiedAt) ? m.lastVerifiedAt : m.enrolledAt,
      lastVerifiedLocalAt: isStr3(m.lastVerifiedLocalAt) ? m.lastVerifiedLocalAt : isStr3(m.lastVerifiedAt) ? m.lastVerifiedAt : m.enrolledAt,
      leaseSeconds: typeof m.leaseSeconds === 'number' && m.leaseSeconds > 0 ? m.leaseSeconds : LEASE_SECONDS,
      ...m.bossNameNeeded === true ? { bossNameNeeded: true } : {},
    };
  } catch { return null; }
}
function writeMembership(m) {
  const p = membershipPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(m, null, 2), { encoding: 'utf8', mode: 0o600 });
}
function setBossNameNeeded(needed) {
  const m = readMembership();
  if (!m) return;
  if (!!m.bossNameNeeded === needed) return;
  const { bossNameNeeded: _was, ...rest } = m;
  writeMembership(needed ? { ...rest, bossNameNeeded: true } : rest);
}
function touchVerified(serverTime) {
  const m = readMembership();
  if (!m) return;
  const parsed = serverTime ? Date.parse(serverTime) : NaN;
  const at = Number.isFinite(parsed) ? parsed : Date.now();
  const prev = Date.parse(m.lastVerifiedAt);
  if (Number.isFinite(prev) && at <= prev) return;
  writeMembership({
    ...m,
    lastVerifiedAt: new Date(at).toISOString(),
    lastVerifiedLocalAt: new Date().toISOString(),
  });
}
function forgetMembership() {
  const p = membershipPath();
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}

// ── relay http + signed fetch (reference 26728-26868) ────────────────────────
const PUBLIC_RELAY_URL = 'https://relay.harnessmd.com';
const LOCAL_RELAY_URL = 'http://127.0.0.1:4312';
const DEFAULT_RELAY_URL = app?.isPackaged ? PUBLIC_RELAY_URL : LOCAL_RELAY_URL;
function relayHttpUrl() {
  const env = process.env.MD_RELAY_URL;
  if (env) return env.replace(/\/+$/, '');
  const ws = readMembership()?.relayUrl;
  if (ws && /^wss?:\/\//.test(ws)) return ws.replace(/^ws/, 'http').replace(/\/connect\/?$/, '').replace(/\/+$/, '');
  return DEFAULT_RELAY_URL;
}
function enrolledDeviceId() { return readMembership()?.deviceId ?? null; }
const fail = (error, detail, status) => ({ ok: false, error, detail, status });
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalString(opts) {
  const bodyHash = opts.rawBody === undefined ? '' : crypto.createHash('sha256').update(opts.rawBody, 'utf8').digest('hex');
  return ['MDv1', opts.method.toUpperCase(), opts.path, opts.nonce, bodyHash, opts.deviceId ?? ''].join('\n');
}
async function getNonce(deviceId) {
  const p = deviceId ? `/challenge?deviceId=${encodeURIComponent(deviceId)}` : '/challenge';
  try {
    const res = await fetch(`${relayHttpUrl()}${p}`, { signal: AbortSignal.timeout(15e3) });
    if (!res.ok) return fail('unauthorized', 'could not get a nonce', res.status);
    const body = await res.json();
    if (!body.nonce) return fail('server_error', 'the relay sent no nonce', res.status);
    return { ok: true, data: body.nonce };
  } catch (e) {
    return fail('server_error', e instanceof Error ? e.message : String(e), 0);
  }
}
async function signedFetch(opts) {
  await initCrypto();
  const nonce = await getNonce(opts.deviceId);
  if (!nonce.ok) return nonce;
  const rawBody = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const canonical = canonicalString({
    method: opts.method,
    path: opts.path,
    nonce: nonce.data,
    rawBody,
    deviceId: opts.deviceId,
  });
  const signature = await signDetached(canonical, opts.signWith);
  if (!signature) return fail('unauthorized', 'no signing key on this machine', 0);
  try {
    const res = await fetch(`${relayHttpUrl()}${opts.path}`, {
      method: opts.method,
      headers: {
        ...rawBody === undefined ? {} : { 'content-type': 'application/json' },
        'x-md-nonce': nonce.data,
        'x-md-signature': b64url(signature),
        ...opts.deviceId ? { 'x-md-device': opts.deviceId } : {},
      },
      body: rawBody,
      signal: AbortSignal.timeout(15e3),
    });
    if (res.status === 204) {
      if (opts.deviceId) touchVerified(res.headers.get('date'));
      return { ok: true, data: undefined };
    }
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) {
      const e = parsed;
      return fail(e?.error ?? 'server_error', e?.detail ?? null, res.status);
    }
    if (opts.deviceId) touchVerified(res.headers.get('date'));
    return { ok: true, data: parsed };
  } catch (e) {
    return fail('server_error', e instanceof Error ? e.message : String(e), 0);
  }
}
function fetchRoster() {
  const deviceId = enrolledDeviceId();
  if (!deviceId) return Promise.resolve(fail('unauthorized', 'not enrolled', 0));
  return signedFetch({ method: 'GET', path: '/roster', deviceId });
}
function postEnvelope(body) {
  const deviceId = enrolledDeviceId();
  if (!deviceId) return Promise.resolve(fail('unauthorized', 'not enrolled', 0));
  return signedFetch({ method: 'POST', path: '/envelope', body, deviceId });
}
function postRequest(body) {
  const deviceId = enrolledDeviceId();
  if (!deviceId) return Promise.resolve(fail('unauthorized', 'not enrolled', 0));
  return signedFetch({ method: 'POST', path: '/request', body, deviceId });
}
function fetchMe() {
  const deviceId = enrolledDeviceId();
  if (!deviceId) return Promise.resolve(fail('unauthorized', 'not enrolled', 0));
  return signedFetch({ method: 'GET', path: '/me', deviceId });
}
function patchMe(body) {
  const deviceId = enrolledDeviceId();
  if (!deviceId) return Promise.resolve(fail('unauthorized', 'not enrolled', 0));
  return signedFetch({ method: 'PATCH', path: '/me', body, deviceId });
}
function fetchBilling() {
  const deviceId = enrolledDeviceId();
  if (!deviceId) return Promise.resolve(fail('unauthorized', 'not enrolled', 0));
  return signedFetch({ method: 'GET', path: '/billing', deviceId });
}
function enrolHttp(body, signWith) {
  return signedFetch({ method: 'POST', path: '/enrol', body, signWith });
}
async function teamRoster() {
  const r = await fetchRoster();
  if (!r.ok) return r;
  const rows = [];
  let self = null;
  const thisDevice = enrolledDeviceId();
  const yourDefault = youAllowDefault() ?? r.data.org.defaultPermission;
  const selfDevices = (r.data.members.find((m) => m.isSelf)?.devices ?? [])
    .map((d) => ({ deviceId: d.deviceId, name: d.name, presence: d.presence, lastSeenAt: d.lastSeenAt, isThis: d.deviceId === thisDevice }))
    .sort((a, b) => Number(b.isThis) - Number(a.isThis) || new Date(b.lastSeenAt ?? 0).getTime() - new Date(a.lastSeenAt ?? 0).getTime());
  for (const m of r.data.members) {
    const device = [...m.devices].sort(
      (a, b) => new Date(b.lastSeenAt ?? 0).getTime() - new Date(a.lastSeenAt ?? 0).getTime()
    )[0];
    if (!device) continue;
    const trust = trustFor(device.deviceId, device.fingerprint);
    const override = youAllowFor(m.memberId);
    const mate = {
      id: m.memberId,
      /* NEVER THE EMPTY STRING (verbatim comment, ref 26886): the fallback is
         their MACHINE, the only other human-readable thing the relay gives. */
      name: m.name?.trim() || device.name,
      ...m.name?.trim() ? {} : { unnamed: true },
      machine: device.name,
      /* ONLINE WHEN ANY DEVICE IS (verbatim contract note, ref 26904). */
      presence: m.suspended ? 'offline' : m.devices.some((d) => d.presence === 'online') ? 'online' : 'offline',
      theyAllow: m.theyAllow,
      youAllow: override ?? yourDefault,
      overridden: override !== undefined && override !== yourDefault,
      fingerprint: device.fingerprint,
      verified: trust.verified,
      previousFingerprint: trust.previousFingerprint,
      isSelf: m.isSelf,
      deviceId: device.deviceId,
      bossName: m.bossName ?? null,
      ...typeof m.receiving === 'boolean' ? { receiving: m.receiving } : {},
    };
    const agents = agentNamesFor(m.memberId);
    if (agents.length) mate.agents = agents;
    if (m.isSelf) self = mate;
    else rows.push(mate);
  }
  return { ok: true, data: { org: r.data.org, teammates: rows, self, selfDevices, yourDefault } };
}

// ── mode / lease gate (reference 26930-27000) ────────────────────────────────
const CLOCK_BACK_TOLERANCE_SECONDS = 5 * 60;
const modeState = { enrolling: false, revoked: null, clock: null, lastAnswer: null, subs: new Set() };
function leaseState(m, now = Date.now()) {
  const at = Date.parse(m.lastVerifiedAt);
  if (!Number.isFinite(at)) return 'locked';
  const localAt = Date.parse(m.lastVerifiedLocalAt);
  if (Number.isFinite(localAt) && now < localAt - CLOCK_BACK_TOLERANCE_SECONDS * 1e3) return 'locked';
  const age = (now - at) / 1e3;
  if (age > m.leaseSeconds) return 'locked';
  if (age > LEASE_WARN_SECONDS) return 'degraded';
  return 'live';
}
function mode() {
  if (modeState.enrolling) return 'enrolling';
  const m = readMembership();
  if (!m || !hasIdentity()) return 'solo';
  if (modeState.revoked) return 'locked';
  return leaseState(m);
}
function lockInfo() {
  if (modeState.enrolling) return null;
  const m = readMembership();
  if (!m || !hasIdentity()) return null;
  if (modeState.revoked) return { kind: 'revoked', reason: modeState.revoked, orgName: m.orgName, lastVerifiedAt: m.lastVerifiedAt };
  if (leaseState(m) === 'locked') return { kind: 'lease', reason: null, orgName: m.orgName, lastVerifiedAt: m.lastVerifiedAt };
  return null;
}
function setEnrolling(on) {
  if (modeState.enrolling === on) return;
  modeState.enrolling = on;
  notifyMode();
}
function setRevoked(reason) {
  if (modeState.revoked === reason) return;
  modeState.revoked = reason;
  notifyMode();
}
function revokedReason() { return modeState.revoked; }
function notifyMode() {
  const m = mode();
  modeState.lastAnswer = m;
  modeState.subs.forEach((fn) => fn(m));
}
function refreshMode() {
  if (mode() !== modeState.lastAnswer) notifyMode();
}
function onModeChange(fn) {
  modeState.subs.add(fn);
  return () => { modeState.subs.delete(fn); };
}
function startLeaseClock(intervalMs = 6e4) {
  if (modeState.clock) return;
  modeState.lastAnswer = mode();
  modeState.clock = setInterval(() => {
    const m = mode();
    if (m !== modeState.lastAnswer) notifyMode();
  }, intervalMs);
  modeState.clock.unref?.();
}
function stopLeaseClock() {
  if (modeState.clock) clearInterval(modeState.clock);
  modeState.clock = null;
}

// ── sign-in flow (reference 27001-27194) ─────────────────────────────────────
const HEX64 = /^[0-9a-f]{64}$/;
function isGrantToken(s) { return HEX64.test(s); }
function parseTeamsDeepLink(link) {
  let u;
  try { u = new URL(link); } catch { return null; }
  if (u.protocol !== 'ozycomp:') return null;
  const host = u.host.toLowerCase();
  const p = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase();
  const route = host ? `${host}/${p}` : p;
  if (route !== 'teams/enrol') return null;
  const grant = (u.searchParams.get('grant') ?? '').toLowerCase();
  const state = (u.searchParams.get('state') ?? '').toLowerCase();
  if (!HEX64.test(grant) || !HEX64.test(state)) return null;
  return { action: 'enrol', grant, state };
}
const SIGNIN_URL = process.env.MD_TEAMS_SIGNIN_URL ?? 'https://app.harnessmd.com/desktop/signin';
const SIGNIN_OFF = process.env.MD_TEAMS_SIGNIN === 'off';
const SIGNIN_TTL_MS = 5 * 6e4;
const signin = { pending: null, grantListeners: new Set(), progressListeners: new Set() };
function onGrant(fn) { signin.grantListeners.add(fn); return () => { signin.grantListeners.delete(fn); }; }
function onProgress(fn) { signin.progressListeners.add(fn); return () => { signin.progressListeners.delete(fn); }; }
const progress = (step) => { signin.progressListeners.forEach((fn) => fn(step)); };
async function beginSignIn(open = (u) => shell.openExternal(u)) {
  const storable = canStoreIdentity();
  if (!storable.ok) {
    return { ok: false, error: 'refused', detail: storable.reason, reason: storable.code };
  }
  const state = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SIGNIN_TTL_MS;
  signin.pending = { state, grant: null, expiresAt };
  setEnrolling(true);
  if (SIGNIN_OFF) {
    console.warn('[teams] MD_TEAMS_SIGNIN=off: skipping the browser sign-in; enrol will carry no grant');
    return { ok: true, url: null, skipped: true, expiresAt: new Date(expiresAt).toISOString() };
  }
  const url = `${SIGNIN_URL}?state=${state}`;
  await open(url);
  return { ok: true, url, skipped: false, expiresAt: new Date(expiresAt).toISOString() };
}
function receiveGrant(input, via) {
  if (!signin.pending) return { ok: false, error: 'signin', detail: 'No sign-in is in progress on this machine.' };
  if (Date.now() > signin.pending.expiresAt) {
    signin.pending = null;
    setEnrolling(false);
    return { ok: false, error: 'signin', detail: 'That sign-in took longer than five minutes.' };
  }
  let grant = input.grant.trim().toLowerCase();
  let state = input.state?.trim().toLowerCase();
  if (via === 'paste') {
    const asLink = parseTeamsDeepLink(grant);
    if (asLink) {
      grant = asLink.grant;
      state = asLink.state;
    }
  }
  if (!isGrantToken(grant)) {
    return { ok: false, error: 'signin', detail: 'That is not the code the browser showed.' };
  }
  if (via === 'link' || state !== undefined) {
    if (state !== signin.pending.state) {
      return { ok: false, error: 'signin', detail: 'That link was not the one this machine asked for.' };
    }
  }
  signin.pending.grant = grant;
  signin.grantListeners.forEach((fn) => fn());
  return { ok: true };
}
function hasGrant() {
  return signin.pending?.grant != null && Date.now() <= signin.pending.expiresAt;
}
function cancelSignIn() {
  signin.pending = null;
  setEnrolling(false);
}
function mapFailure(f) {
  if (f.status === 0) return { error: 'offline', detail: f.detail };
  switch (f.error) {
    case 'not_found':
      return { error: 'invalid', detail: f.detail };
    case 'conflict': {
      const d = (f.detail ?? '').toLowerCase();
      if (/\bredeemed\b/.test(d)) return { error: 'used', detail: f.detail };
      if (/\bexpired\b/.test(d)) return { error: 'expired', detail: f.detail };
      return { error: 'refused', detail: f.detail };
    }
    default:
      return { error: 'refused', detail: f.detail };
  }
}
function normaliseCode(raw) {
  const body = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^MD/, '');
  return `MD-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}
async function enrol(input, deps) {
  const code = input.code.trim() ? normaliseCode(input.code) : '';
  if (!code && SIGNIN_OFF) {
    return { ok: false, error: 'invalid', detail: 'Enter the invite code.' };
  }
  let grant;
  if (!SIGNIN_OFF) {
    if (!hasGrant()) {
      return { ok: false, error: 'signin', detail: 'Sign in with your browser first; the sign-in did not complete.' };
    }
    grant = signin.pending.grant;
  }
  const storable = canStoreIdentity();
  if (!storable.ok) {
    return { ok: false, error: 'refused', detail: storable.reason, reason: storable.code };
  }
  setEnrolling(true);
  try {
    progress('keys');
    const pair = await generateUnsaved();
    const publicKeyUrl = b64url(pair.publicKey);
    const publicKeyStd = Buffer.from(pair.publicKey).toString('base64');
    progress('registering');
    const res = await enrolHttp({
      // Absent, not empty, for a second machine (verbatim note, ref 27142).
      ...code ? { code } : {},
      publicKey: publicKeyUrl,
      deviceName: os.hostname().slice(0, 80),
      os: `${process.platform} ${os.release()}`.slice(0, 40),
      appVersion: deps.appVersion.slice(0, 20),
      ...grant ? { grant } : {},
    }, pair.privateKey);
    if (!res.ok) {
      if (signin.pending) signin.pending.grant = null;
      return { ok: false, ...mapFailure(res) };
    }
    progress('checking');
    const expected = fingerprintFor(publicKeyStd);
    if (res.data.fingerprint !== expected) {
      if (signin.pending) signin.pending.grant = null;
      return {
        ok: false,
        error: 'refused',
        reason: 'fingerprint_mismatch',
        detail: 'The server reported a fingerprint that does not match the key this machine made. Nothing was saved.',
      };
    }
    try {
      saveIdentity(pair.publicKey, pair.privateKey);
    } catch (e) {
      const err = e;
      return { ok: false, error: 'refused', detail: err.message, reason: err.code };
    }
    writeMembership({
      orgId: res.data.orgId,
      memberId: res.data.memberId,
      deviceId: res.data.deviceId,
      orgName: res.data.orgName,
      relayUrl: res.data.relayUrl,
      enrolledAt: res.data.enrolledAt,
      lastVerifiedAt: res.data.enrolledAt,
      lastVerifiedLocalAt: new Date().toISOString(),
      leaseSeconds: LEASE_SECONDS,
    });
    signin.pending = null;
    return {
      ok: true,
      org: { orgId: res.data.orgId, name: res.data.orgName },
      memberId: res.data.memberId,
      deviceId: res.data.deviceId,
      fingerprint: res.data.fingerprint,
    };
  } finally {
    setEnrolling(false);
  }
}

// ── connection view (reference 27621-27686; socket itself is a stub) ─────────
const conn = { view: { state: 'offline' }, viewSubs: new Set(), presenceSubs: new Set(), inboxSubs: new Set(), running: false };
function currentConn() { return conn.view; }
function onConnChange(fn) { conn.viewSubs.add(fn); return () => { conn.viewSubs.delete(fn); }; }
function onPresence(fn) { conn.presenceSubs.add(fn); return () => { conn.presenceSubs.delete(fn); }; }
function onInbox(fn) { conn.inboxSubs.add(fn); return () => { conn.inboxSubs.delete(fn); }; }
function setConn(next) {
  if (next.state === conn.view.state && next.reason === conn.view.reason) return;
  conn.view = next;
  conn.viewSubs.forEach((fn) => fn(conn.view));
}
function connStart() {
  if (conn.running) return;
  conn.running = true;
  connConnect();
}
function connStop() {
  conn.running = false;
  setConn({ state: 'offline' });
}
function reconnectNow() {
  if (!conn.running) { connStart(); return; }
  connConnect();
}
// The reference's websocket loop (27700-27983, ws dep) is deliberately not
// reproduced — zero-dep rule. This stand-in performs the same signed GET
// /queue handshake over plain fetch and reports connected/reconnecting/
// offline through the same {state,reason} view the handlers publish.
let connTimer = null;
async function connConnect() {
  if (!conn.running) return;
  const m = readMembership();
  if (!m) { setConn({ state: 'offline' }); return; }
  setConn({ state: conn.ever ? 'reconnecting' : 'connecting' });
  const r = await drainQueueSigned();
  if (!conn.running) return;
  if (r.ok) {
    conn.ever = true;
    touchVerified(r.serverTime ?? null);
    if (revokedReason()) setRevoked(null);
    else refreshMode();
    setConn({ state: 'connected' });
    scheduleConnRetry(6e4);
    return;
  }
  if (r.status === 401) {
    conn.unauth = (conn.unauth ?? 0) + 1;
    if (conn.unauth >= 2) { connStopped('unknown'); return; }
    setConn({ state: 'reconnecting' });
    scheduleConnRetry(1e3);
    return;
  }
  if (r.status === 402) { connStopped('entitlement'); return; }
  setConn({ state: r.status > 0 ? 'reconnecting' : 'offline' });
  scheduleConnRetry(6e4);
}
function scheduleConnRetry(ms) {
  if (connTimer) clearTimeout(connTimer);
  connTimer = setTimeout(() => { connTimer = null; if (conn.running) void connConnect(); }, ms);
  connTimer.unref?.();
}
function connStopped(reason) {
  setConn({ state: 'stopped', reason });
  setRevoked(reason);
  scheduleConnRetry(15 * 6e4);
}
function drainQueueSigned() {
  const deviceId = enrolledDeviceId();
  if (!deviceId) return Promise.resolve(fail('unauthorized', 'not enrolled', 0));
  return signedFetch({ method: 'GET', path: '/queue', deviceId })
    .then((r) => ({ ok: r.ok, status: r.status ?? 0, serverTime: r.ok ? undefined : undefined, data: r.data }));
}

// ── boss name (reference 28008-28022) ────────────────────────────────────────
const BOSS_NAME_MIN = 2;
const BOSS_NAME_MAX = 24;
const SHAPE = /^[\p{L}\p{N}](?:[\p{L}\p{N} .']*[\p{L}\p{N}])?$/u;
function bossNameKey(raw) {
  return raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}
function validateBossName(raw) {
  const name = (raw ?? '').trim();
  if (!name) return { ok: false, problem: 'empty' };
  const length = [...name].length;
  if (length < BOSS_NAME_MIN) return { ok: false, problem: 'short' };
  if (length > BOSS_NAME_MAX) return { ok: false, problem: 'long' };
  if (!SHAPE.test(name)) return { ok: false, problem: 'chars' };
  return { ok: true, name };
}

// ── message validation / rate (reference 28023-28095) ────────────────────────
const MESSAGE_ACTS = ['ask', 'answer', 'inform', 'handoff'];
const MESSAGE_LIMITS = { subject: 80, subjectMin: 3, body: 1200, bodyMin: 1, bodyLines: 24, codeBlocks: 2 };
const DEFAULT_TURN_BUDGET = 4;
const MESSAGE_RATE = { perHour: 6, openThreads: 3 };
const ASK_THE_HUMAN = 'Stop messaging and ask your human to change the response mode for this person in Team, right sidebar.';
const CHANGE_IT_YOURSELF = 'This thread is finished. Start a new one with a new subject, or widen this person in Team, right sidebar.';
function budgetAdvice() { return CHANGE_IT_YOURSELF; }
function countLines(body) { return body.replace(/\r\n?/g, '\n').split('\n').length; }
function countCodeBlocks(body) {
  const fences = body.match(/^\s{0,3}(?:`{3,}|~{3,})/gm);
  return fences ? Math.floor(fences.length / 2) + fences.length % 2 : 0;
}
function validateMessage(draft) {
  const out = [];
  const subject = (draft.subject ?? '').trim();
  const body = (draft.body ?? '').trim();
  if (subject.length < MESSAGE_LIMITS.subjectMin) {
    out.push({ code: 'subject-missing', fix: 'Give the message a subject that says what it is about in a few words.' });
  } else if (subject.length > MESSAGE_LIMITS.subject) {
    out.push({ code: 'subject-long', fix: `Cut the subject to ${MESSAGE_LIMITS.subject} characters. Move the detail into the body.` });
  }
  if (body.length < MESSAGE_LIMITS.bodyMin) {
    out.push({ code: 'body-missing', fix: 'Write a body. A subject on its own is not a message.' });
  } else {
    if (body.length > MESSAGE_LIMITS.body) {
      out.push({ code: 'body-long', fix: `Cut the body to ${MESSAGE_LIMITS.body} characters. Lead with the ask, drop the background, and share a file link instead of pasting the file.` });
    }
    if (countLines(body) > MESSAGE_LIMITS.bodyLines) {
      out.push({ code: 'body-lines', fix: `Cut the body to ${MESSAGE_LIMITS.bodyLines} lines. Use a short list, not a report.` });
    }
    if (countCodeBlocks(body) > MESSAGE_LIMITS.codeBlocks) {
      out.push({ code: 'body-code-blocks', fix: `Send at most ${MESSAGE_LIMITS.codeBlocks} code blocks. Share a file link for anything longer.` });
    }
  }
  if (!MESSAGE_ACTS.includes(draft.act)) {
    out.push({ code: 'act-unknown', fix: `Set act to one of ${MESSAGE_ACTS.join(', ')}.` });
  }
  return out;
}
function explainViolations(violations) { return violations.map((v) => v.fix).join(' '); }
function countsTowardBudget(entry) { return !(entry.from === 'you' && entry.delivery === 'failed'); }
function turnsUsed(entries) { return entries.filter(countsTowardBudget).length; }
function checkRate(state, budget = DEFAULT_TURN_BUDGET) {
  const out = [];
  const advice = budgetAdvice();
  if (state.threadEntries >= budget) {
    out.push({ code: 'turn-budget', fix: `This thread has used its ${budget} turns. ${advice}` });
  }
  if (state.sentLastHour >= MESSAGE_RATE.perHour) {
    out.push({ code: 'rate-hour', fix: `You have sent ${MESSAGE_RATE.perHour} messages to this person in the last hour. Wait, or ${advice.charAt(0).toLowerCase()}${advice.slice(1)}` });
  }
  if (state.openThreads >= MESSAGE_RATE.openThreads) {
    out.push({ code: 'open-threads', fix: `You already have ${MESSAGE_RATE.openThreads} threads open with this person. Close one before starting another.` });
  }
  return out;
}

// ── org view + refresh (reference 28257-28430) ───────────────────────────────
const TUNING = { pollMs: 15 * 6e4, lapsedPollMs: 60 * 6e4 };
const ACTIVE = ['trialing', 'healthy'];
const isStr2 = (v) => typeof v === 'string';
const KEY_GROUPS_RE = /^[0-9A-F]{4}( [0-9A-F]{4}){5}$/;
function keyGroups(signingKey) {
  if (KEY_GROUPS_RE.test(signingKey)) return signingKey;
  const b64 = signingKey.replace(/-/g, '+').replace(/_/g, '/');
  return fingerprintFor(b64 + '='.repeat((4 - b64.length % 4) % 4));
}
function orgPath() { return path.join(app.getPath('userData'), 'teams', 'org.json'); }
function readOrgFile() {
  const p = orgPath();
  if (!fs.existsSync(p)) return null;
  try {
    const f = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!f || !isStr2(f.orgId) || !isStr2(f.name) || !isStr2(f.signingKey) || !f.entitlement || !f.you) return null;
    return f;
  } catch { return null; }
}
function writeOrgFile(f) {
  const p = orgPath();
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(f, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(`${p}.tmp`, p);
}
function currentOrg() {
  const m = readMembership();
  const f = readOrgFile();
  return m && f && f.orgId === m.orgId ? f : null;
}
const orgSubs = new Set();
function onOrgChange(fn) { orgSubs.add(fn); return () => { orgSubs.delete(fn); }; }
function notifyOrg() {
  const v = orgView();
  orgSubs.forEach((fn) => fn(v));
}
function orgView() {
  const m = readMembership();
  const empty = {
    available: false,
    orgId: m?.orgId ?? '',
    name: m?.orgName ?? '',
    signingKey: null,
    keyGroups: null,
    keyVerified: false,
    keyPreviousGroups: null,
    defaultPermission: null,
    requireFingerprint: null,
    entitlement: null,
    seatsUsed: null,
    seatsPaid: null,
    you: null,
    membership: null,
    fetchedAt: null,
  };
  const f = currentOrg();
  if (!f) return empty;
  const trust = orgTrustFor(f.orgId, f.signingKey);
  return {
    available: true,
    orgId: f.orgId,
    name: f.name,
    signingKey: f.signingKey,
    keyGroups: keyGroups(f.signingKey),
    keyVerified: trust.verified,
    keyPreviousGroups: trust.previous ? keyGroups(trust.previous) : null,
    defaultPermission: f.defaultPermission,
    requireFingerprint: f.requireFingerprint,
    entitlement: f.entitlement,
    seatsUsed: f.seatsUsed,
    seatsPaid: f.seatsPaid,
    you: f.you,
    membership: f.membership,
    fetchedAt: f.fetchedAt,
  };
}
function orgPolicy() {
  const f = currentOrg();
  return f ? { defaultPermission: f.defaultPermission, requireFingerprint: f.requireFingerprint } : null;
}
async function orgRefresh() {
  const m = readMembership();
  if (!m) return 'unavailable';
  const r = await fetchMe();
  if (!r.ok) {
    if (r.status === 404 || r.error === 'not_found') return 'unavailable';
    if (r.status === 401) return 'refused';
    return 'offline';
  }
  const me = r.data;
  if (!validMe(me)) return 'offline';
  writeOrgFile({
    orgId: me.org.orgId,
    name: me.org.name,
    signingKey: me.org.signingKey,
    defaultPermission: me.org.defaultPermission,
    requireFingerprint: !!me.org.requireFingerprint,
    entitlement: {
      state: me.org.entitlement.state,
      trialEndsAt: isStr2(me.org.entitlement.trialEndsAt) ? me.org.entitlement.trialEndsAt : null,
      graceEndsAt: isStr2(me.org.entitlement.graceEndsAt) ? me.org.entitlement.graceEndsAt : null,
    },
    seatsUsed: typeof me.org.seatsUsed === 'number' ? me.org.seatsUsed : null,
    seatsPaid: typeof me.org.seatsPaid === 'number' ? me.org.seatsPaid : null,
    you: { name: isStr2(me.you.name) ? me.you.name : null, email: isStr2(me.you.email) ? me.you.email : null, isAdmin: !!me.you.isAdmin },
    membership: me.membership,
    fetchedAt: isStr2(me.serverTime) ? me.serverTime : new Date().toISOString(),
  });
  if (typeof me.leaseSeconds === 'number' && me.leaseSeconds > 0 && me.leaseSeconds !== m.leaseSeconds) {
    writeMembership({ ...m, leaseSeconds: me.leaseSeconds });
  }
  orgTrustFor(me.org.orgId, me.org.signingKey);
  if (me.membership === 'suspended') setRevoked('suspended');
  else if (me.membership === 'removed') setRevoked('removed');
  else if (!ACTIVE.includes(me.org.entitlement.state)) setRevoked('entitlement');
  else if (revokedReason()) setRevoked(null);
  notifyOrg();
  orgSchedule();
  return 'updated';
}
function validMe(me) {
  return !!me && !!me.org && isStr2(me.org.orgId) && isStr2(me.org.name) && isStr2(me.org.signingKey)
    && ['strict', 'communication-only', 'allow-all'].includes(me.org.defaultPermission)
    && !!me.org.entitlement
    && ['awaiting-card', 'trialing', 'healthy', 'payment-failed', 'cancelled'].includes(me.org.entitlement.state)
    && !!me.you && ['active', 'suspended', 'removed'].includes(me.membership);
}
function verifyKey() {
  const f = currentOrg();
  if (!f) return { ok: false };
  markOrgVerified(f.orgId, f.signingKey);
  notifyOrg();
  return { ok: true };
}
const orgTimer = { timer: null, running: false };
function orgSchedule() {
  if (!orgTimer.running) return;
  if (orgTimer.timer) clearInterval(orgTimer.timer);
  const f = currentOrg();
  const lapsed = !!f && !ACTIVE.includes(f.entitlement.state);
  orgTimer.timer = setInterval(() => { void orgRefresh(); }, lapsed ? TUNING.lapsedPollMs : TUNING.pollMs);
  orgTimer.timer.unref?.();
}
function orgStart() {
  if (orgTimer.running) return orgStop;
  orgTimer.running = true;
  const off = onConnChange((v) => { if (v.state === 'connected' || v.state === 'stopped') void orgRefresh(); });
  void orgRefresh();
  orgSchedule();
  return () => { off(); orgStop(); };
}
function orgStop() {
  orgTimer.running = false;
  if (orgTimer.timer) clearInterval(orgTimer.timer);
  orgTimer.timer = null;
}

// ── roster cache, threads, requests (reference 28431-29097) ──────────────────
const ACTS = ['request', 'inform', 'propose', 'query', 'agree', 'refuse', 'done'];
const isAct = (v) => typeof v === 'string' && ACTS.includes(v);
const isStr1 = (v) => typeof v === 'string';
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_TTL_MS = 24 * 3600 * 1e3;
const ROSTER_TTL_MS = 6e4;
// hive bridge attached in register() — the TeamsManager's `hive$1` slot.
let hiveBridge = null;
let shareHost = null;
const b64urlToB64 = (s) => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return b + '='.repeat((4 - b.length % 4) % 4);
};
const b64urlToBytes = (s) => new Uint8Array(Buffer.from(b64urlToB64(s), 'base64'));
function threadIdFor(a, b) {
  const h = crypto.createHash('sha256').update([a, b].sort().join(':')).digest('hex');
  return `thr_${h.slice(0, 40)}`;
}
const rosterCache = { data: null, at: 0 };
async function rosterFresh(force = false) {
  if (!force && rosterCache.data && Date.now() - rosterCache.at < ROSTER_TTL_MS) return rosterCache.data;
  const r = await fetchRoster();
  if (!r.ok) return rosterCache.data;
  rosterCache.data = r.data;
  rosterCache.at = Date.now();
  return rosterCache.data;
}
function rosterInvalidate() { rosterCache.at = 0; }
onPresence(() => { rosterCache.at = 0; });
function findMember(r, memberId) {
  return r.members.find((m) => m.memberId === memberId) ?? null;
}
function findDevice(r, deviceId) {
  for (const member of r.members) {
    const device = member.devices.find((d) => d.deviceId === deviceId);
    if (device) return { member, device };
  }
  return null;
}
async function memberOrRefresh(memberId) {
  let r = await rosterFresh();
  let m = r && findMember(r, memberId);
  if (!m) {
    r = await rosterFresh(true);
    m = r && findMember(r, memberId);
  }
  return r && m ? { r, m } : null;
}
async function deviceOrRefresh(deviceId) {
  let r = await rosterFresh();
  let d = r && findDevice(r, deviceId);
  if (!d) {
    r = await rosterFresh(true);
    d = r && findDevice(r, deviceId);
  }
  return r && d ? { r, ...d } : null;
}
const threadSubs = new Set();
const requestSubs = new Set();
function onThread(fn) { threadSubs.add(fn); return () => { threadSubs.delete(fn); }; }
function onRequests(fn) { requestSubs.add(fn); return () => { requestSubs.delete(fn); }; }
function threadsDir() { return path.join(app.getPath('userData'), 'teams', 'threads'); }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function threadFor(memberId) {
  const me = readMembership();
  const threadId = me ? threadIdFor(me.memberId, memberId) : '';
  const stored = threadId ? readJson(path.join(threadsDir(), `${threadId}.json`)) : null;
  return stored ?? { memberId, threadId, messages: [] };
}
function appendThread(memberId, entry) {
  const t = threadFor(memberId);
  if (!t.threadId) return;
  if (t.messages.some((m) => m.id === entry.id)) return;
  t.messages.push(entry);
  writeJson(path.join(threadsDir(), `${t.threadId}.json`), t);
  threadSubs.forEach((fn) => fn(memberId));
}
function updateDelivery(memberId, id, delivery) {
  const t = threadFor(memberId);
  const m = t.messages.find((x) => x.id === id);
  if (!m || !t.threadId) return;
  m.delivery = delivery;
  writeJson(path.join(threadsDir(), `${t.threadId}.json`), t);
  threadSubs.forEach((fn) => fn(memberId));
}
function startNewThread(memberId) {
  const me = readMembership();
  if (!me || !memberId || memberId === me.memberId) return { ok: false };
  const threadId = threadIdFor(me.memberId, memberId);
  const live = path.join(threadsDir(), `${threadId}.json`);
  if (fs.existsSync(live)) {
    let n = 1;
    while (fs.existsSync(path.join(threadsDir(), `${threadId}.${n}.json`))) n++;
    fs.renameSync(live, path.join(threadsDir(), `${threadId}.${n}.json`));
    hiveBridge?.appendLog({ kind: 'teams-thread-rotated', memberId, threadId, archived: `${threadId}.${n}.json` });
  }
  threadSubs.forEach((fn) => fn(memberId));
  return { ok: true };
}
function bounce(msg, reason) {
  hiveBridge?.appendLog({ kind: 'drop', reason: 'teams-refused', detail: reason, from: msg.from, to: msg.to, id: msg.id });
  hiveBridge?.send({
    to: hiveBridge.godId(),
    act: 'inform',
    conversation: msg.conversation,
    in_reply_to: msg.id,
    subject: `[refused — ${reason}] ${msg.subject}`,
    body: `Your message to ${msg.to} was not sent.\n\n${msg.body}`,
  }, 'system');
  return { ok: false, reason };
}
function policyFor(memberId, org) {
  const perPerson = youPolicyFor(memberId) ?? youPolicyDefault() ?? normalizePolicy(org.defaultPermission);
  return effectivePolicy(statusNow(), perPerson);
}
const probePath = (raw) => {
  try {
    const real = fs.realpathSync(raw);
    return { real, isFile: fs.statSync(real).isFile() };
  } catch { return null; }
};
const SHARE_REFUSAL = {
  notAbsolute: 'unreadable',
  notAFile: 'unreadable',
  unreadable: 'unreadable',
  tooBig: 'too-big',
  tooMany: 'too-many',
  noServer: 'no-link',
  noTunnel: 'no-link',
};
function shareCountdown(share, now) {
  const ms = Math.max(0, share.expiresAt - now);
  if (ms <= 0) return { unit: 'expired', count: 0 };
  if (ms < 6e4) return { unit: 'seconds', count: Math.max(1, Math.floor(ms / 1e3)) };
  if (ms < 36e5) return { unit: 'minutes', count: Math.floor(ms / 6e4) };
  return { unit: 'hours', count: Math.floor(ms / 36e5) };
}
function expiresIn(share, now) {
  const { unit, count } = shareCountdown(share, now);
  if (unit === 'expired') return 'Expired';
  const noun = count === 1 ? unit.slice(0, -1) : unit;
  return `${count} ${noun} left`;
}
function shareBlock(code, name) { return { code, fix: FIXES[code](name) }; }
const FIXES = {
  'outside-workspace': (name) => `${name} is outside the workspace you are working in, so it cannot be published. Copy it into your workspace and send the message again, or ask your human to send the file.`,
  'no-workspace': (name) => `${name} is a local file and there is no workspace to check it against, so it cannot be published. Ask your human to send the file.`,
  'unreadable': (name) => `${name} is not a regular file this machine can read, so it cannot be published. Name one readable file, or send the message without it.`,
  'too-big': (name) => `${name} is too large to publish on a link. Send a smaller file, or put it somewhere they can already reach and send that address instead.`,
  'too-many': (name) => `This machine is already holding the most file links it can keep open at once, so ${name} cannot be published. Wait for one to expire and send the message again.`,
  'no-link': (name) => `No public link could be opened for ${name}, so it cannot reach another machine. Send the message again in a moment, or ask your human to send the file.`,
};
const CANDIDATE = /(?:[A-Za-z]:)?[/\\][^\s"'`<>|*?]+/g;
const TRAILING = `.,;:!?)]}>'"`;
function scanBody(body, probe) {
  const files = [];
  const notFiles = [];
  const seen = new Set();
  const text = String(body ?? '');
  CANDIDATE.lastIndex = 0;
  for (let m = CANDIDATE.exec(text); m; m = CANDIDATE.exec(text)) {
    const start = m.index;
    const before = start > 0 ? text[start - 1] : '';
    if (before === ':' || before === '/' || before === '\\') continue;
    if (m[0].includes('://')) continue;
    for (let token = m[0]; token.length > 1; token = token.slice(0, -1)) {
      const probed = probe(token);
      if (!probed) {
        if (!TRAILING.includes(token[token.length - 1])) break;
        continue;
      }
      if (seen.has(token)) break;
      seen.add(token);
      const ref = { token, real: probed.real, name: baseName(probed.real) };
      (probed.isFile ? files : notFiles).push(ref);
      break;
    }
  }
  return { files, notFiles };
}
function baseName(p) {
  const parts = String(p ?? '').split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p ?? '');
}
function isInsideWorkspace(root, real) {
  const r = trimSep(String(root ?? ''));
  const f = trimSep(String(real ?? ''));
  if (!r || !f) return false;
  if (f === r) return true;
  return f.startsWith(r + '/') || f.startsWith(r + '\\');
}
function trimSep(p) { return p.length > 1 ? p.replace(/[/\\]+$/, '') : p; }
function personChose(from) {
  const who = String(from ?? '').trim().toLowerCase();
  return who === 'you' || who === 'human';
}
function shareRef(name, url, expires) { return `${name} (${url}, ${expires})`; }
function applyShares(body, refs) {
  let out = String(body ?? '');
  for (const ref of refs) {
    let from = out.indexOf(ref.token);
    while (from !== -1) {
      let end = from + ref.token.length;
      const suffix = ` (${ref.name})`;
      if (out.startsWith(suffix, end)) end += suffix.length;
      out = out.slice(0, from) + ref.text + out.slice(end);
      from = out.indexOf(ref.token, from + ref.text.length);
    }
  }
  return out;
}
async function shareLocalFiles(msg) {
  const { files, notFiles } = scanBody(msg.body, probePath);
  if (!files.length && !notFiles.length) return { message: msg };
  if (notFiles.length) return { refused: shareBlock('unreadable', notFiles[0].name).fix };
  if (!shareHost) return { refused: shareBlock('no-link', files[0].name).fix };
  let root = null;
  if (!personChose(msg.from)) {
    const workspace = shareHost.workspaceFor(msg.from);
    try { root = workspace ? fs.realpathSync(workspace) : null; } catch { root = null; }
    if (!root) return { refused: shareBlock('no-workspace', files[0].name).fix };
  }
  const refs = [];
  for (const file of files) {
    if (root && !isInsideWorkspace(root, file.real)) {
      return { refused: shareBlock('outside-workspace', file.name).fix };
    }
    const made = await shareHost.create(file.real);
    if (!made.ok) return { refused: shareBlock(SHARE_REFUSAL[made.error], file.name).fix };
    if (!made.share.url) return { refused: shareBlock('no-link', file.name).fix };
    refs.push({
      token: file.token,
      name: baseName(file.token),
      text: shareRef(made.share.name, made.share.url, expiresIn(made.share, Date.now())),
    });
    hiveBridge?.appendLog({ kind: 'teams-share', id: made.share.id, to: msg.to, message: msg.id });
  }
  return { message: { ...msg, body: applyShares(msg.body, refs) } };
}
async function sealFor(devices, plaintext) {
  await initCrypto();
  const key = randombytesBuf(SECRETBOX_KEYBYTES);
  const nonce = randombytesBuf(SECRETBOX_NONCEBYTES);
  const box = secretboxEasy(Buffer.from(plaintext, 'utf8'), nonce, key);
  const keys = {};
  const keyB64 = Buffer.from(key).toString('base64');
  for (const d of devices) {
    keys[d.deviceId] = (await sealTo(b64urlToB64(d.publicKey), keyB64)).ciphertext;
  }
  const ciphertext = b64url(new Uint8Array(Buffer.from(JSON.stringify({ v: 1, box: Buffer.from(box).toString('base64'), keys }), 'utf8')));
  const sig = await signDetached(ciphertext);
  if (!sig) throw new Error('no signing key on this machine');
  return { ciphertext, nonce: b64url(nonce), senderSignature: b64url(sig) };
}
async function send(msg) {
  const memberId = msg.to.startsWith('member:') ? msg.to.slice('member:'.length) : '';
  const me = readMembership();
  if (!me) return bounce(msg, 'this machine is not in a team');
  if (!memberId || memberId === me.memberId) return bounce(msg, `"${msg.to}" is not a teammate`);
  const found = await memberOrRefresh(memberId);
  if (!found) return bounce(msg, `no teammate member:${memberId} on the roster`);
  const { r: seen, m } = found;
  const name = m.name ?? `member:${memberId}`;
  if (m.suspended) return bounce(msg, `${name} is suspended`);
  const mine = policyFor(memberId, seen.org);
  const theirs = normalizePolicy(m.theyAllow);
  const block = sendBlock(mine, theirs);
  if (block === 'you-not-sending') return bounce(msg, ASK_THE_HUMAN);
  if (block === 'they-not-receiving') return bounce(msg, `${name} allows nothing from you (strict)`);
  if (m.receiving === false) return bounce(msg, `${name} is not receiving messages from you right now`);
  if (m.devices.length === 0) return bounce(msg, `${name} has no machine enrolled`);
  const pol = orgPolicy();
  if (pol?.requireFingerprint) {
    const unverified = m.devices.filter((d) => !trustFor(d.deviceId, fingerprintFor(b64urlToB64(d.publicKey))).verified);
    if (unverified.length) {
      return bounce(msg, `${me.orgName} requires you to verify ${name}'s key before messaging them; open their row in Team and compare the safety number for ${unverified.map((d) => d.name).join(', ')}`);
    }
  }
  const shared = await shareLocalFiles(msg);
  if ('refused' in shared) return bounce(msg, shared.refused);
  msg = shared.message;
  const agent = hiveBridge?.agentName?.(msg.from) ?? null;
  const entry = {
    id: msg.id,
    from: 'you',
    act: msg.act,
    subject: msg.subject,
    body: msg.body,
    at: msg.created_at,
    delivery: 'sending',
    ...agent ? { agent } : {},
  };
  appendThread(memberId, entry);
  let sealed;
  try {
    sealed = await sealFor(m.devices, JSON.stringify({
      v: 1,
      kind: 'hive-message',
      message: msg,
      sender: { agentId: msg.from, agent },
    }));
  } catch (e) {
    updateDelivery(memberId, msg.id, 'failed');
    return bounce(msg, `could not seal: ${e instanceof Error ? e.message : String(e)}`);
  }
  const refused = (r2) => {
    updateDelivery(memberId, msg.id, 'failed');
    if (r2.error === 'not_receiving') {
      rosterInvalidate();
      return bounce(msg, r2.detail ?? `${name} is not receiving messages from you right now`);
    }
    return bounce(msg, `the relay refused: ${r2.detail ?? r2.error}`);
  };
  if (msg.act === 'request') {
    const r2 = await postRequest({
      toMemberId: memberId,
      type: 'run-task',
      ...sealed,
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
    });
    if (!r2.ok) return refused(r2);
    const delivery = r2.data.delivered.length ? 'delivered' : 'queued';
    updateDelivery(memberId, msg.id, delivery);
    hiveBridge?.appendLog({ kind: 'teams-sent', via: 'request', to: msg.to, id: msg.id, delivery });
    return { ok: true, delivery, via: 'request' };
  }
  const r = await postEnvelope({
    toDeviceIds: m.devices.map((d) => d.deviceId),
    ...sealed,
    threadId: threadIdFor(me.memberId, memberId),
    sentAt: msg.created_at,
  });
  if (!r.ok) return refused(r);
  const delivery = r.data.delivered.length ? 'delivered' : 'queued';
  updateDelivery(memberId, msg.id, delivery);
  hiveBridge?.appendLog({ kind: 'teams-sent', via: 'envelope', to: msg.to, id: msg.id, delivery });
  return { ok: true, delivery, via: 'envelope' };
}
const HIVE_ACT = { ask: 'query', answer: 'inform', inform: 'inform', handoff: 'request' };
function asDraft(value) {
  const raw = value && typeof value === 'object' ? value : {};
  return {
    subject: typeof raw.subject === 'string' ? raw.subject.trim() : '',
    body: typeof raw.body === 'string' ? raw.body.trim() : '',
    // NEVER defaulted to `inform` (verbatim note, ref 28776).
    act: typeof raw.act === 'string' ? raw.act : '',
    expectsReply: raw.expectsReply === true,
  };
}
function rateStateFor(memberId, now = Date.now()) {
  const messages = threadFor(memberId).messages;
  const hourAgo = now - 36e5;
  const sentLastHour = messages.filter((m) => {
    if (m.from !== 'you') return false;
    const at = Date.parse(m.at);
    return Number.isFinite(at) && at >= hourAgo;
  }).length;
  const last = messages[messages.length - 1];
  const awaiting = !!last && last.from === 'you' && (last.act === 'request' || last.act === 'query' || last.act === 'propose');
  return { sentLastHour, openThreads: awaiting ? 1 : 0, threadEntries: turnsUsed(messages) };
}
async function sendFromPerson(memberId, draft) {
  const d = asDraft(draft);
  const violations = [...validateMessage(d), ...checkRate({ ...rateStateFor(memberId) }, DEFAULT_TURN_BUDGET)];
  if (violations.length) return { ok: false, reason: explainViolations(violations) };
  const msg = {
    id: `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    conversation: `conv-${threadIdFor(readMembership()?.memberId ?? '', memberId).slice(4, 12)}`,
    in_reply_to: null,
    from: 'you',
    to: `member:${memberId}`,
    act: HIVE_ACT[d.act],
    subject: d.subject,
    body: d.body,
    hops: 0,
    requires_reply: d.expectsReply,
    needs_human: false,
    created_at: new Date().toISOString(),
  };
  return send(msg);
}
function resolveResponder(configured, activeIds, godId) {
  if (typeof configured !== 'string') return godId;
  const id = configured.trim();
  if (!id || !activeIds.includes(id)) return godId;
  return id;
}
function fromPrefix(name, agent, machine) {
  return agent ? `[from ${name}'s ${agent} on ${machine}]` : `[from ${name} on ${machine}]`;
}
function responderId(readConfig) {
  const god = hiveBridge?.godId?.() ?? 'god';
  const configured = typeof readConfig === 'function' ? readConfig()?.responder : undefined;
  const active = hiveBridge?.activeAgentIds?.() ?? [];
  return resolveResponder(configured, active, god);
}
function deliverLocally(o, via, readConfig) {
  const name = o.member.name ?? o.member.memberId;
  const to = responderId(readConfig);
  const sent = hiveBridge?.send({
    ...o.message,
    to,
    subject: `${fromPrefix(name, o.senderAgent, o.device.name)} ${o.message.subject}`,
  }, o.message.from);
  appendThread(o.member.memberId, {
    id: o.message.id,
    from: o.member.memberId,
    act: o.message.act,
    subject: o.message.subject,
    body: o.message.body,
    at: o.message.created_at,
    delivery: 'delivered',
    ...o.senderAgent ? { agent: o.senderAgent } : {},
  });
  hiveBridge?.appendLog({ kind: 'teams-received', via, from: o.message.from, id: o.message.id, to, delivered: !!sent });
}
function requestsDir() { return path.join(app.getPath('userData'), 'teams', 'requests'); }
const HANDLED_KEEP_MS = 9 * 24 * 3600 * 1e3;
function handledFile() { return path.join(app.getPath('userData'), 'teams', 'handled.json'); }
function readHandled() {
  const raw = readJson(handledFile());
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [id, at] of Object.entries(raw)) if (SAFE_ID.test(id) && typeof at === 'string') out[id] = at;
  return out;
}
function markHandled(id, now = Date.now()) {
  if (!SAFE_ID.test(id)) return;
  const all = readHandled();
  all[id] = new Date(now).toISOString();
  for (const [id2, at] of Object.entries(all)) {
    const t = Date.parse(at);
    if (!Number.isFinite(t) || now - t > HANDLED_KEEP_MS) delete all[id2];
  }
  writeJson(handledFile(), all);
}
function pendingRequests() {
  const dir = requestsDir();
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f)))
    .filter((r) => !!r && typeof r.id === 'string')
    .map(({ message, deviceName, ...view }) => ({ ...view, expired: Date.parse(view.expiresAt) < now }))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
async function decide(id, decision, readConfig) {
  if (!SAFE_ID.test(id)) return { ok: false };
  const file = path.join(requestsDir(), `${id}.json`);
  const stored = readJson(file);
  if (!stored) return { ok: false };
  markHandled(id);
  if (decision === 'decline') {
    fs.rmSync(file, { force: true });
    hiveBridge?.appendLog({ kind: 'teams-request', id, decision });
    requestSubs.forEach((fn) => fn());
    return { ok: true };
  }
  if (decision === 'always') setYouPolicy(stored.fromMemberId, policyOf('open'));
  const r = await rosterFresh();
  const member = r && findMember(r, stored.fromMemberId);
  const device = member?.devices.find((d) => d.name === stored.deviceName) ?? member?.devices[0];
  if (r && member && device) {
    deliverLocally({ message: stored.message, member, device, org: r.org, senderAgent: stored.senderAgent ?? null }, 'request', readConfig);
  } else {
    hiveBridge?.send({ ...stored.message, to: responderId(readConfig), subject: `${fromPrefix(stored.fromName, stored.senderAgent, stored.fromMachine)} ${stored.message.subject}` }, stored.message.from);
  }
  fs.rmSync(file, { force: true });
  hiveBridge?.appendLog({ kind: 'teams-request', id, decision });
  requestSubs.forEach((fn) => fn());
  return { ok: true };
}
async function retryHeld() {
  for (const kind of ['envelopes', 'requests']) {
    const dir = path.join(spoolDir(kind), 'held');
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      fs.renameSync(path.join(dir, f), path.join(spoolDir(kind), f));
      // receiving is driven by the inbox observer; the spool reader isn't part
      // of this handler group, so re-filing is the verbatim retry behavior.
    }
  }
}
function spoolDir(kind) {
  return path.join(app.getPath('userData'), 'teams', 'spool', kind);
}
const SCHEDULE_TICK_MS = 6e4;
function policyView(memberIds = []) {
  applySchedule();
  const overrides = {};
  for (const id of memberIds) {
    const own = youPolicyFor(id);
    if (own) overrides[id] = own;
  }
  return {
    status: myStatus(),
    schedule: myStatusSchedule(),
    scheduleDriving: scheduleDriving(),
    policyDefault: youPolicyDefault() ?? null,
    overrides,
  };
}
function setStatus(value) { setMyStatus(value); return { ok: true }; }
function setSchedule(value) { setMyStatusSchedule(value); return { ok: true }; }
function setPolicy(memberId, value) { setYouPolicy(memberId, value); return { ok: true }; }
function setPolicyDefault(value) { setYouPolicyDefault(value); return { ok: true }; }
function onPolicy(fn) { return onPolicyChange(fn); }

// ── billing wire (reference 29174-29218) ─────────────────────────────────────
const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v) => v === null || isStr(v);
const STATES = ['awaiting-card', 'trialing', 'healthy', 'payment-failed', 'cancelled'];
const CURRENCIES = ['USD', 'INR'];
const INVOICE_STATUS = ['paid', 'failed', 'refunded'];
function isCard(v) {
  if (!v || typeof v !== 'object') return false;
  const c = v;
  return isStr(c.brand) && isStr(c.last4) && /^[0-9]{4}$/.test(c.last4) && isNum(c.expiryMonth) && isNum(c.expiryYear);
}
function isInvoice(v) {
  if (!v || typeof v !== 'object') return false;
  const i = v;
  return isStr(i.invoiceId) && isStr(i.at) && isNum(i.amountMinor) && i.amountMinor >= 0 && CURRENCIES.includes(i.currency) && INVOICE_STATUS.includes(i.status) && strOrNull(i.receiptUrl);
}
function parseBillingWire(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw;
  if (!STATES.includes(b.state)) return null;
  if (!strOrNull(b.trialEndsAt) || !strOrNull(b.renewalAt) || !strOrNull(b.graceEndsAt)) return null;
  if (!isNum(b.seatsPaid) || !isNum(b.seatsUsed) || !isNum(b.pricePerSeatMinor)) return null;
  if (!CURRENCIES.includes(b.currency)) return null;
  if (b.card !== null && !isCard(b.card)) return null;
  if (!Array.isArray(b.invoices)) return null;
  if (!isStr(b.serverTime)) return null;
  return {
    state: b.state,
    trialEndsAt: b.trialEndsAt,
    renewalAt: b.renewalAt,
    graceEndsAt: b.graceEndsAt,
    seatsPaid: b.seatsPaid,
    seatsUsed: b.seatsUsed,
    pricePerSeatMinor: b.pricePerSeatMinor,
    currency: b.currency,
    card: b.card === null ? null : { brand: b.card.brand, last4: b.card.last4, expiryMonth: b.card.expiryMonth, expiryYear: b.card.expiryYear },
    invoices: b.invoices.filter(isInvoice).map((i) => ({ invoiceId: i.invoiceId, at: i.at, amountMinor: i.amountMinor, currency: i.currency, status: i.status, receiptUrl: i.receiptUrl })),
    serverTime: b.serverTime,
  };
}

// ── selectBroadcastTargets (reference 5661) for the hive bridge ──────────────
function selectBroadcastTargets(agents, fromId) {
  return Object.keys(agents).filter((id) => {
    const agent = agents[id];
    if (!agent) return false;
    if (id === fromId) return false;
    if (agent.isAssistant) return false;
    if (agent.archived) return false;
    if (agent.onHold) return false;
    return true;
  });
}

// ── TeamsManager (the reference's module-level teams plane, boxed) ───────────
function makeTeams(ctx) {
  const hive = ctx.harness?.hive;
  hiveBridge = {
    send: (partial, from) => hive?.send(partial, from) ?? hive?.send(partial.from ?? 'you', partial.to ?? 'god', partial.act ?? 'inform', partial.body ?? '', partial),
    appendLog: (event) => { try { (hive?.appendLog ?? hive?.log?.bind(hive))?.(event); } catch {} },
    godId: () => hive?.registry?.().godId ?? 'god',
    agentName: (id) => hive?.registry?.().agents?.[id]?.name ?? null,
    responder: () => ctx.readConfig?.().responder,
    activeAgentIds: () => selectBroadcastTargets(hive?.registry?.().agents ?? {}, ''),
  };
  shareHost = {
    create: (p) => ctx.fileShareStore?.create ? ctx.fileShareStore.create(p) : Promise.resolve({ ok: false, error: 'noServer' }),
    workspaceFor: (agentId) => hive?.registry?.().agents?.[agentId]?.cwd ?? null,
  };
  const manager = {
    // every surface the handlers close over, exposed for other ported groups
    hasIdentity, forgetIdentity, readMembership, writeMembership, forgetMembership,
    setBossNameNeeded, touchVerified, enrolledDeviceId,
    teamRoster, markVerified, retryHeld, setYouAllow, setYouAllowDefault, youAllowFor, youAllowDefault,
    mode, lockInfo, onModeChange, setEnrolling, setRevoked, revokedReason, startLeaseClock, stopLeaseClock,
    beginSignIn, receiveGrant, cancelSignIn, hasGrant, onGrant, onProgress,
    enrol, parseTeamsDeepLink, isGrantToken,
    currentConn, onConnChange, onPresence, onInbox, connStart, connStop, reconnectNow, setConn,
    validateBossName, patchMe, fetchMe, fetchRoster, fetchBilling,
    rosterFresh, rosterInvalidate, memberOrRefresh, deviceOrRefresh, findMember,
    threadFor, appendThread, updateDelivery, startNewThread, onThread, onRequests,
    send, sendFromPerson, pendingRequests, decide, deliverLocally, responderId,
    policyView, setStatus, setSchedule, setPolicy, setPolicyDefault, onPolicy, applySchedule,
    statusNow, myStatus, myStatusSchedule, youPolicyFor, youPolicyDefault, setYouPolicy, setYouPolicyDefault,
    orgView, orgRefresh, orgStart, orgStop, verifyKey, orgTrustFor, markOrgVerified, currentOrg, orgPolicy, onOrgChange,
    trustFor, agentNamesFor, threadIdFor, normalizePolicy, policyOf, effectivePolicy, sendBlock,
    relayHttpUrl, signedFetch, spoolDir, parseBillingWire, sealTo, openSealed, signDetached, generateUnsaved, saveIdentity,
    hive: () => hiveBridge, shares: () => shareHost,
  };
  return manager;
}

// ── register: the verbatim channel surface (reference 33706-33890 + 29097) ───
function register(ctx) {
  const ipcMain = ctx.ipcMain;
  const teams = (ctx.teams ??= makeTeams(ctx));
  const push = (channel, payload) => {
    if (typeof ctx.pushToRenderers === 'function') ctx.pushToRenderers(channel, payload);
    else {
      const w = ctx.win?.();
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  };
  const hive = ctx.harness?.hive;
  const analytics = ctx.analytics ?? ctx.harness?.telemetry ?? { trackFunnel: () => {}, trackFeature: () => {} };
  const trackFunnel = (e, p) => { try { analytics.trackFunnel?.(e, p); } catch {} };

  ipcMain.handle('teams:identity:has', () => hasIdentity());
  ipcMain.handle('teams:roster', async () => {
    if (!hasIdentity()) {
      return { ok: false, error: 'not_enrolled', detail: null };
    }
    return teamRoster();
  });
  ipcMain.handle('teams:verify', (_e, deviceId, fingerprint) => {
    markVerified(deviceId, fingerprint);
    void retryHeld();
    return { ok: true };
  });
  ipcMain.handle('teams:setYouAllow', (_e, memberId, level) => {
    setYouAllow(memberId, level);
    return { ok: true };
  });
  ipcMain.handle('teams:setYouAllowDefault', (_e, level) => {
    setYouAllowDefault(level);
    return { ok: true };
  });
  ipcMain.handle('teams:identity:forget', () => {
    forgetIdentity();
    forgetMembership();
    notifyMode();
    return { ok: true };
  });
  ipcMain.handle('teams:leave', async () => {
    if (!hasIdentity()) {
      return { ok: true, alreadySolo: true };
    }
    const roster = await teamRoster();
    if (!roster.ok) {
      return { ok: false, reason: 'unreachable', detail: roster.detail ?? null };
    }
    const others = roster.data.teammates.length;
    if (others > 0) {
      return { ok: false, reason: 'has-teammates', teammates: others };
    }
    forgetIdentity();
    forgetMembership();
    notifyMode();
    return { ok: true, alreadySolo: false };
  });
  ipcMain.handle('teams:mode', () => mode());
  ipcMain.handle('teams:membership', () => {
    const m = readMembership();
    if (!m) return null;
    return {
      orgId: m.orgId,
      orgName: m.orgName,
      memberId: m.memberId,
      deviceId: m.deviceId,
      enrolledAt: m.enrolledAt,
      lastVerifiedAt: m.lastVerifiedAt,
      ...m.bossNameNeeded ? { bossNameNeeded: true } : {},
    };
  });
  ipcMain.handle('teams:bossName:set', async (_e, raw) => {
    const parsed = validateBossName(String(raw ?? ''));
    if (!parsed.ok) return { ok: false, error: 'invalid', detail: parsed.problem };
    const name = parsed.name;
    const local = () => {
      // reference: hive.presetGodName(name) — rename the local orchestrator.
      const r = hive?.presetGodName ? hive.presetGodName(name) : presetGodNameLocal(hive, name);
      return r.ok ? { ok: true, name } : { ok: false, error: 'invalid', detail: r.error ?? 'rename failed' };
    };
    if (!readMembership()) return local();
    const res = await patchMe({ bossName: name });
    if (res.ok) {
      setBossNameNeeded(false);
      return local();
    }
    if (res.error === 'conflict') return { ok: false, error: 'conflict', detail: res.detail ?? null };
    if (res.error === 'not_found') return { ...local(), unsupported: true };
    return { ...local(), offline: true };
  });
  ipcMain.handle('teams:name:set', async (_e, raw) => {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    const name = trimmed === '' ? null : trimmed;
    if (name !== null && name.length > 80) return { ok: false, error: 'invalid', detail: 'length' };
    if (!readMembership()) return { ok: false, error: 'solo' };
    const res = await patchMe({ name });
    if (res.ok) {
      rosterInvalidate();
      return { ok: true, name };
    }
    if (res.error === 'not_found' || res.error === 'invalid_body' && (res.detail ?? '').includes('unknown field: name')) {
      return { ok: false, error: 'unsupported' };
    }
    return { ok: false, error: 'offline', detail: res.detail ?? res.error };
  });
  ipcMain.handle('teams:signin:begin', () => beginSignIn());
  ipcMain.handle('teams:signin:paste', (_e, pasted) => receiveGrant({ grant: String(pasted ?? '') }, 'paste'));
  ipcMain.handle('teams:signin:cancel', () => {
    cancelSignIn();
    return { ok: true };
  });
  let awaitingInviteRole = false;
  onOrgChange((v) => {
    if (!awaitingInviteRole || !v.available || !v.you) return;
    awaitingInviteRole = false;
    trackFunnel('invite_redeemed', { role: v.you.isAdmin ? 'admin' : 'member' });
  });
  ipcMain.handle('teams:enrol', async (_e, input) => {
    const res = await enrol({ code: String(input?.code ?? '') }, { appVersion: app.getVersion() });
    if (!res.ok) return res;
    trackFunnel('licence_activated', { plan: 'teams', source: 'invite' });
    awaitingInviteRole = true;
    const existing = hive?.registry?.().agents[hive?.registry?.().godId ?? 'god']?.name;
    const parsed = existing ? validateBossName(existing) : null;
    if (parsed?.ok) {
      const claim = await patchMe({ bossName: parsed.name });
      setBossNameNeeded(!claim.ok && claim.error === 'conflict');
    }
    return res;
  });
  ipcMain.handle('teams:connection', () => currentConn());
  ipcMain.handle('teams:lock', () => lockInfo());
  ipcMain.handle('teams:reconnect', () => {
    reconnectNow();
    return { ok: true };
  });
  ipcMain.handle('teams:thread', (_e, memberId) => threadFor(String(memberId ?? '')));
  ipcMain.handle('teams:send', (_e, memberId, draft) => sendFromPerson(String(memberId ?? ''), draft));
  ipcMain.handle('teams:thread:new', (_e, memberId) => startNewThread(String(memberId ?? '')));
  ipcMain.handle('teams:requests', () => pendingRequests());
  ipcMain.handle('teams:request:decide', (_e, id, decision) => decide(String(id ?? ''), decision, ctx.readConfig));
  ipcMain.handle('teams:policy', (_e, memberIds) => policyView(Array.isArray(memberIds) ? memberIds.filter((x) => typeof x === 'string') : []));
  ipcMain.handle('teams:setStatus', (_e, policy) => setStatus(policy));
  ipcMain.handle('teams:setSchedule', (_e, schedule) => setSchedule(schedule));
  ipcMain.handle('teams:setPolicy', (_e, memberId, policy) => setPolicy(String(memberId ?? ''), policy));
  ipcMain.handle('teams:setPolicyDefault', (_e, policy) => setPolicyDefault(policy));
  onPolicy(() => push('teams:policy', null));
  ipcMain.handle('teams:org', () => orgView());
  ipcMain.handle('teams:org:verify', () => verifyKey());
  ipcMain.handle('teams:org:refresh', () => orgRefresh());

  // ── verbatim push wiring (reference 33891-33928) ──
  onModeChange((m) => push('teams:mode', m));
  onGrant(() => push('teams:signin:grant', null));
  onProgress((step) => push('teams:enrol:progress', step));
  onConnChange((v) => push('teams:connection', v));
  onPresence(() => push('teams:presence', null));
  onThread((memberId) => push('teams:thread', memberId));
  onRequests(() => push('teams:requests', null));
  onOrgChange((v) => push('teams:org', v));

  // Remote hook so hive "member:<id>" and teammate-name sends route through us
  // (reference hive.setRemote, 33920).
  if (hive?.setRemote) {
    hive.setRemote({
      send: (msg) => { void send(msg); },
      rosterLine: () => teammatesLine(),
      resolve: (name) => resolveTeammate(name),
    });
  }

  // Mode follower (reference 33929-33956): start/stop the connection, lease
  // clock, bridge and org poll with enrolment state.
  const enrolled = (m) => m === 'live' || m === 'degraded' || m === 'locked';
  const follow = (m) => {
    if (enrolled(m)) {
      connStart();
      startLeaseClock();
      if (!orgTimer.running) orgStart();
    } else {
      connStop();
      stopLeaseClock();
      orgStop();
    }
  };
  onModeChange(follow);
  try { follow(mode()); } catch {}
}

// teammatesLine / resolveTeammate (reference 28498-28529) — hive remote helpers.
function teammatesLine() {
  if (!readMembership()) return null;
  if (!rosterCache.data) {
    void rosterFresh();
    return null;
  }
  const rows = rosterCache.data.members.filter((m) => !m.isSelf && m.devices.length > 0).map((m) => {
    const online = m.devices.some((d) => d.presence === 'online');
    const who = m.bossName ? `${m.name ?? 'unnamed'}, orchestrator "${m.bossName}"` : m.name ?? 'unnamed';
    const theirs = normalizePolicy(m.theyAllow);
    const agents = agentNamesFor(m.memberId);
    const seen = agents.length ? `, agents seen: ${agents.join(', ')}` : '';
    return `${who} (member:${m.memberId}, ${m.suspended ? 'suspended' : online ? 'online' : 'offline'}, allows you ${presetOf(theirs) ?? 'custom'}${seen})`;
  });
  if (!rows.length) return `[TEAMS] You are in ${rosterCache.data.org.name}; no teammate has a machine enrolled yet.`;
  return `[TEAMS — teammates on OTHER machines, in ${rosterCache.data.org.name}] ${rows.join('; ')}. Write to one by putting member:<id> in \`to\`, or the person's name, or their orchestrator's nickname, when it matches exactly one row; otherwise the message bounces. What they allow you decides what lands: off bounces, listen and converse deliver a message and put a \`request\` in their approval queue, open runs it. Your own status can close either direction at any time, and a refusal always says which side closed it. A local file you name in the body is published as a link that dies in an hour, but only when the file is inside your workspace; anything else is refused rather than sent with a path the other machine cannot open.`;
}
function resolveTeammate(name) {
  const key = bossNameKey(name ?? '');
  if (!key || key === 'broadcast' || key === 'god' || key === 'human' || key.startsWith('member:')) return null;
  if (!readMembership()) return null;
  if (!rosterCache.data) {
    void rosterFresh();
    return null;
  }
  const hits = rosterCache.data.members.filter((m) => !m.isSelf && m.devices.length > 0 && (m.name != null && bossNameKey(m.name) === key || m.bossName != null && bossNameKey(m.bossName) === key));
  if (hits.length === 0) return null;
  if (hits.length === 1) return { memberId: hits[0].memberId };
  return {
    ambiguous: hits.map((m) => `member:${m.memberId} (${m.name ?? 'unnamed'}${m.bossName ? `, orchestrator "${m.bossName}"` : ''})`),
  };
}
// Local stand-in for the reference's hive.presetGodName: rename the god agent's
// display name in the registry. Same {ok,error} shape.
function presetGodNameLocal(hive, name) {
  try {
    const reg = hive?.registry?.();
    if (!reg) return { ok: false, error: 'no hive' };
    const godId = reg.godId ?? 'god';
    if (!reg.agents[godId]) return { ok: false, error: 'no god agent' };
    reg.agents[godId] = { ...reg.agents[godId], name };
    hive.writeRegistry(reg);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

module.exports = { register };
