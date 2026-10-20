'use strict';
/**
 * PersistStore — verbatim port of the reference's SQLite-backed scalar store
 * (out/main/index.js ~15020-15156): one `kv` table (JSON-encoded scalars) plus
 * a `command_history` table capped at COMMAND_HISTORY_LIMIT rows, migrated by
 * user_version. The reference binds better-sqlite3; this port binds
 * `node:sqlite`'s DatabaseSync so the clone keeps its zero-dep constraint —
 * same schema, same pragmas, same method surface (open/close/getKv/setKv/
 * addHistory/listHistory/searchHistory/trimHistory).
 *
 * KvStore (kv-store.js) stays for the plain-JSON consumers (IDE window
 * bounds); anything that needs the verbatim command-history surface or the
 * SQL-shaped kv table uses this.
 */
const path = require('node:path');
const { COMMAND_HISTORY_LIMIT } = require('./retention');

const MIGRATIONS = [
  // → user_version 1 (Phase A): scalar kv + net-new command history.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,     -- JSON-encoded
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_history (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        cwd      TEXT,
        text     TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ch_agent_ts ON command_history(agent_id, ts DESC);
    `);
  }
];

function clampLimit(n, fallback) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(1e3, v);
}

class PersistStore {
  /** @param dbPath  Override the DB location (tests). Defaults to
   *  userData/harness.db — resolved lazily so requiring this module outside
   *  Electron never touches `electron.app`. */
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }
  /** Open (creating if needed) and migrate the DB. Idempotent — a second call
   *  is a no-op. When `node:sqlite` is unavailable (electron's bundled Node can
   *  predate it) the store falls back to a JSON file beside the DB path — same
   *  method surface, no SQL, so callers never see a dead persist. Only a file
   *  that can't be created throws; callers guard so a DB failure can't crash
   *  app startup. */
  open() {
    if (this.db) return;
    const file = this.dbPath ?? path.join(require('electron').app.getPath('userData'), 'harness.db');
    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      DatabaseSync = null;
    }
    if (!DatabaseSync) {
      // JSON fallback: kv + command_history live in <file>.json. A plain
      // object standing in for the DB keeps every method's guard (this.db
      // truthy) intact.
      this.db = this._openJson(file + '.json');
      return;
    }
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    this.migrate(db);
    this.db = db;
    this.trimHistory();
  }
  /** The node:sqlite-less store: {__json:true, kv:{}, history:[]}, flushed on
   *  every write. Reads/writes go through the same getKv/setKv/addHistory…
   *  surface via the `__json` marker the methods branch on. */
  _openJson(file) {
    const fs = require('node:fs');
    let data = { kv: {}, history: [] };
    try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
    const flush = () => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
        fs.renameSync(tmp, file);
      } catch {}
    };
    return { __json: true, file, data, flush, close() { flush(); } };
  }
  _json() { return this.db && this.db.__json ? this.db : null; }
  /**
   * Drop everything past the newest COMMAND_HISTORY_LIMIT rows.
   *
   * By `id`, not by `ts`: id is AUTOINCREMENT and therefore monotonic whatever
   * the clock does, and a machine whose clock stepped backwards must not lose
   * the rows it wrote after the step. The subquery is one seek down the primary
   * key index and returns NULL when the table is under the cap, in which case
   * `id <= NULL` matches nothing and the statement costs nothing.
   */
  trimHistory() {
    if (!this.db) return;
    const j = this._json();
    if (j) {
      const over = j.data.history.length - COMMAND_HISTORY_LIMIT;
      if (over > 0) { j.data.history.splice(0, over); j.flush(); }
      return;
    }
    try {
      this.db.prepare(
        `DELETE FROM command_history
          WHERE id <= (SELECT id FROM command_history ORDER BY id DESC LIMIT 1 OFFSET ?)`
      ).run(COMMAND_HISTORY_LIMIT);
    } catch {
    }
  }
  migrate(db) {
    const version = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      db.exec('BEGIN');
      try {
        MIGRATIONS[i](db);
        db.exec(`PRAGMA user_version = ${i + 1}`);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch {}
        throw e;
      }
    }
  }
  /** Close the handle (checkpoints WAL). Safe to call when already closed. */
  close() {
    try {
      this.db?.close();
    } catch {
    }
    this.db = null;
  }
  get isOpen() {
    return this.db !== null;
  }
  // ─── kv (scalar app state) ─────────────────────────────────────────────────
  /** Read a JSON-decoded scalar, or undefined if absent/unparseable. */
  getKv(key) {
    if (!this.db) return void 0;
    const j = this._json();
    if (j) return j.data.kv[key];
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    if (!row) return void 0;
    try {
      return JSON.parse(row.value);
    } catch {
      return void 0;
    }
  }
  /** Upsert a JSON-encoded scalar. */
  setKv(key, value) {
    if (!this.db) return;
    const j = this._json();
    if (j) { j.data.kv[key] = value; j.flush(); return; }
    this.db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, JSON.stringify(value), Date.now());
  }
  // ─── command history (net-new) ─────────────────────────────────────────────
  /** Record one submitted prompt, then re-apply the cap. Empty text or missing
   *  agent id are ignored. Capping on insert rather than on a sweep is how the
   *  other two ledgers do it (SLACK_HISTORY_LIMIT, WORKER_HISTORY_LIMIT): the
   *  table can then never be over its bound between sweeps, and there is one
   *  code path to reason about instead of two. */
  addHistory(entry) {
    if (!this.db) return;
    const text = (entry.text ?? '').trim();
    if (!text || !entry.agentId) return;
    const j = this._json();
    if (j) {
      const maxId = j.data.history.reduce((m, r) => Math.max(m, r.id), 0);
      j.data.history.push({ id: maxId + 1, agentId: entry.agentId, cwd: entry.cwd ?? null, text, ts: Date.now() });
      this.trimHistory();
      j.flush();
      return;
    }
    this.db.prepare('INSERT INTO command_history (agent_id, cwd, text, ts) VALUES (?, ?, ?, ?)').run(entry.agentId, entry.cwd ?? null, text, Date.now());
    this.trimHistory();
  }
  /** Most-recent-first history, optionally scoped to one agent. */
  listHistory(agentId, limit = 100) {
    if (!this.db) return [];
    const lim = clampLimit(limit, 100);
    const j = this._json();
    if (j) {
      return j.data.history
        .filter((r) => !agentId || r.agentId === agentId)
        .sort((a, b) => (b.ts - a.ts) || (b.id - a.id))
        .slice(0, lim);
    }
    const rows = agentId ? this.db.prepare(
      'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE agent_id = ? ORDER BY ts DESC, id DESC LIMIT ?'
    ).all(agentId, lim) : this.db.prepare(
      'SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history ORDER BY ts DESC, id DESC LIMIT ?'
    ).all(lim);
    return rows;
  }
  /** Substring search over prompt text, most-recent-first. */
  searchHistory(query, limit = 50) {
    if (!this.db) return [];
    const q = (query ?? '').trim();
    if (!q) return [];
    const lim = clampLimit(limit, 50);
    const j = this._json();
    if (j) {
      const n = q.toLowerCase();
      return j.data.history
        .filter((r) => r.text.toLowerCase().includes(n))
        .sort((a, b) => (b.ts - a.ts) || (b.id - a.id))
        .slice(0, lim);
    }
    const needle = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return this.db.prepare(
      "SELECT id, agent_id AS agentId, cwd, text, ts FROM command_history WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC, id DESC LIMIT ?"
    ).all(needle, lim);
  }
}

module.exports = { PersistStore, MIGRATIONS };
