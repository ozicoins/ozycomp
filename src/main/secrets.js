'use strict';
/**
 * Secrets — write-only credential store for the MCP secret tier.
 *
 * Values are encrypted with Electron's safeStorage when available (Keychain /
 * DPAPI backed) and stored base64'd in <home>/secrets.json (0600). Without
 * safeStorage (headless tests) the store still works with an AES-256-GCM key
 * derived from the device id — never plaintext.
 *
 * Contract for callers: secrets go IN through set(), come OUT only through
 * envFor(keys) at spawn time, and are never logged or sent to the renderer —
 * the UI only sees which keys are set.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { deviceId } = require('./license');

const FILE = 'secrets.json';

function makeCipher(home) {
  // Prefer Electron safeStorage; fall back to a device-derived AES key.
  try {
    const { safeStorage } = require('electron');
    if (safeStorage?.isEncryptionAvailable()) {
      return {
        enc: s => `ss:${safeStorage.encryptString(s).toString('base64')}`,
        dec: v => v.startsWith('ss:') ? safeStorage.decryptString(Buffer.from(v.slice(3), 'base64')) : '',
      };
    }
  } catch {}
  const key = crypto.createHash('sha256').update(`ozycomp:${deviceId(home)}`).digest();
  return {
    enc: s => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(s, 'utf8'), c.final()]);
      return `gcm:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
    },
    dec: v => {
      if (!v.startsWith('gcm:')) return '';
      const [, iv, tag, data] = v.split(':');
      const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      d.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
    },
  };
}

class SecretsStore {
  constructor({ home } = {}) {
    this.home = home;
    this.file = path.join(home, FILE);
    this.cipher = makeCipher(home);
  }

  _all() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; }
  }
  _save(map) { fs.writeFileSync(this.file, JSON.stringify(map, null, 2), { mode: 0o600 }); }

  set(key, value) {
    const map = this._all();
    map[key] = this.cipher.enc(String(value));
    this._save(map);
  }
  has(key) { return key in this._all(); }
  get(key) {
    const v = this._all()[key];
    if (!v) return null;
    try { return this.cipher.dec(v); } catch { return null; }
  }
  remove(key) { const m = this._all(); delete m[key]; this._save(m); }
  keys() { return Object.keys(this._all()); }

  /** Decrypt just the named keys into a plain env-style map. */
  envFor(keys) {
    const out = {};
    for (const k of keys) { const v = this.get(k); if (v) out[k] = v; }
    return out;
  }
}

module.exports = { SecretsStore };
