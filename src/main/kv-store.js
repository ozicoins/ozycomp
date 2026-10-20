'use strict';
/**
 * kv-store — JSON-backed scalar app state, the zero-dep stand-in for the
 * reference's PersistStore kv table (getKv/setKv). One file, atomic writes;
 * only the surfaces the ported modules read are implemented.
 */
const fs = require('node:fs');
const path = require('node:path');

class KvStore {
  constructor(file) {
    this.file = file;
    this._map = null;
  }
  _load() {
    if (this._map) return this._map;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this._map = parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      this._map = {};
    }
    return this._map;
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this._map, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
  getKv(key) {
    return this._load()[key];
  }
  setKv(key, value) {
    this._load()[key] = value;
    try { this._save(); } catch {}
  }
}

module.exports = { KvStore };
