'use strict';
/**
 * MemoryManager — durable agent memory.
 *
 *   • memory.md per agent (in the hive). Shape rule: a "## Rules" section holds
 *     always/never instructions and is never rewritten; "## Notes" is free
 *     text that is capped — past PINNED_NOTES_CAP_BYTES the oldest notes are
 *     folded into memory-archive.md so the injected prompt stays small.
 *   • memory-index.md at the hive root: one line per agent summarizing its
 *     memory, rebuilt on demand and injected into briefs.
 *   • MemPalace (optional semantic memory): if the `mempalace` CLI is on PATH,
 *     every agent's memory.md is mined into <home>/palace on a timer and the
 *     agent env gets MEMPALACE_PALACE_PATH so `mempalace search` works. When the
 *     CLI is absent this is a silent no-op.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { which } = require('./providers');
const { shellPathGeneration, userShellPath, findCommandOnPath } = require('./command-resolver');
const { ensureMineIgnore } = require('./hive');

const {
  RULES_HEADING, RULES_HEADING_PREFIX, PINNED_NOTES_CAP_BYTES,
  PINNED_HEADING_PREFIX, PINNED_PLACEHOLDER, ARCHIVE_FILE,
  regionBodyOf, rulesBodyOf, pinnedNotesBytesOf,
} = require('./memory-rules');
// The clone's memory.md keeps the verbatim two-region shape — "## 📏 Rules
// (never moved)" holds always/never lines; everything else lives as free text
// the byte-cap fold trims into ARCHIVE_FILE. The injected prompt's sort/rules
// notices gate on exactly these headings, so this file must write them.
const NOTES_HEADING = '## Notes';
// verbatim (ref ~13389): 10-minute base gap, 30-minute backoff ceiling,
// 10-minute per-mine timeout.
const MINE_INTERVAL_MS = 6e5;
const MINE_BACKOFF_MAX_MS = 18e5;
const MINE_TIMEOUT_MS = 10 * 6e4;

// ── verbatim palace-quarantine helpers (ref ~13350-13372) ────────────────────
const QUARANTINE = /\.(?:drift|corrupt)-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
function quarantineStampMs(name) {
  const m = QUARANTINE.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return Number.isNaN(t) ? null : t;
}
const REAP_DEFAULTS = { keep: 2, minAgeMs: 10 * 6e4 };
function quarantineDirsToReap(entries, nowMs, opts = {}) {
  const keep = opts.keep ?? REAP_DEFAULTS.keep;
  const minAgeMs = opts.minAgeMs ?? REAP_DEFAULTS.minAgeMs;
  const stamped = [];
  for (const e of entries) {
    const ts = quarantineStampMs(e.name);
    if (ts !== null) stamped.push({ name: e.name, ts });
  }
  stamped.sort((a, b) => b.ts - a.ts || b.name.localeCompare(a.name));
  return stamped.slice(Math.max(0, keep)).filter((q) => nowMs - q.ts >= minAgeMs).map((q) => q.name);
}
function nextMineDelayMs(currentMs, baseMs, maxMs, quarantinedThisPass) {
  if (!quarantinedThisPass) return baseMs;
  return Math.min(Math.max(currentMs, baseMs) * 2, maxMs);
}
function mempalaceDevice(platform, envOverride) {
  if (envOverride) return undefined;
  return platform === 'darwin' ? 'cpu' : undefined;
}
const MEMPALACE_DEVICE = mempalaceDevice(process.platform, process.env.MEMPALACE_EMBEDDING_DEVICE);

function template(name) {
  return `# ${name} — durable memory\n\n${RULES_HEADING}\n\n${NOTES_HEADING}\n`;
}

// Re-exported so ipc/hive.js + tests see the verbatim heading string.
const VERBATIM_RULES_HEADING = RULES_HEADING;

class MemoryManager {
  constructor({ hive, home }) {
    this.hive = hive;
    this.home = home;
    this.lastMined = new Map();  // agentId → mtimeMs
    this.mineTimer = null;
    this.mining = false;
    // verbatim (ref ~13402-13416): cached CLI path + the PATH generation it was
    // resolved against, self-scheduling loop state, quarantine backoff.
    this.binCache = undefined;
    this.binGen = -1;
    this.mineStopped = false;
    this.mineDelayMs = MINE_INTERVAL_MS;
    this.lastQuarantineTs = 0;
    this.initStarted = false;
  }

  file(id) { return path.join(this.hive.agentDir(id), 'memory.md'); }

  read(id) {
    try { return fs.readFileSync(this.file(id), 'utf8'); } catch { return ''; }
  }

  ensure(id, name = id) {
    const f = this.file(id);
    if (!fs.existsSync(f) || !this.read(id).includes(RULES_HEADING)) {
      const prev = this.read(id).replace(/^# .*\n/, '').trim();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, template(name) + (prev ? `\n${prev}\n` : ''), 'utf8');
    }
  }

  /** Split memory.md into {head, rules, notes}: the rules region is found by
   *  its "## 📏" prefix (verbatim regionBodyOf), notes is whatever sits under
   *  "## Notes". A file without both regions parses as all-head. */
  parse(md) {
    const lines = String(md ?? '').split('\n');
    let ri = -1, ni = -1;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (ri < 0 && l.startsWith(RULES_HEADING_PREFIX)) ri = i;
      if (ni < 0 && l === NOTES_HEADING) ni = i;
    }
    if (ri < 0 || ni < 0 || ni < ri) return { head: md, rules: '', notes: '' };
    return {
      head: lines.slice(0, ri).join('\n'),
      rules: lines.slice(ri + 1, ni).join('\n').trim(),
      notes: lines.slice(ni + 1).join('\n').trim(),
    };
  }

  appendNote(id, note) {
    this.ensure(id);
    fs.appendFileSync(this.file(id), `\n- ${new Date().toISOString().slice(0, 10)} ${String(note).trim()}\n`, 'utf8');
    this.compact(id);
  }

  /** Fold oldest notes into memory-archive.md once notes pass the cap. Rules never move. */
  compact(id) {
    const md = this.read(id);
    const { head, rules, notes } = this.parse(md);
    if (Buffer.byteLength(notes) <= PINNED_NOTES_CAP_BYTES) return false;
    const lines = notes.split('\n');
    const archived = [];
    while (lines.length && Buffer.byteLength(lines.join('\n')) > PINNED_NOTES_CAP_BYTES * 0.7) archived.push(lines.shift());
    fs.appendFileSync(path.join(this.hive.agentDir(id), 'memory-archive.md'), archived.join('\n') + '\n', 'utf8');
    fs.writeFileSync(this.file(id), `${head}${RULES_HEADING}\n\n${rules}\n\n${NOTES_HEADING}\n\n${lines.join('\n')}\n`, 'utf8');
    return true;
  }

  /** Rebuild hive/memory-index.md: one line per agent. */
  rebuildIndex() {
    const reg = this.hive.registry();
    const rows = Object.values(reg.agents).map(a => {
      const { rules, notes } = this.parse(this.read(a.id));
      const first = (notes.split('\n').find(l => l.trim()) ?? '').replace(/^-\s*/, '').slice(0, 120);
      return `- **${a.id}** (${a.role}) — ${rules ? 'kuralları var; ' : ''}${first || 'henüz not yok'}`;
    });
    const md = `# Memory index\n\n${rows.join('\n')}\n`;
    fs.writeFileSync(path.join(this.hive.root(), 'memory-index.md'), md, 'utf8');
    return md;
  }

  // ── MemPalace (optional) ────────────────────────────────────────────────
  palacePath() { return this.home ? path.join(this.home, 'palace') : null; }

  /** Resolve the mempalace CLI against PATH + common uv/pip spots (verbatim ~13422).
   *  Cached per shell-PATH generation so a PATH change re-resolves. */
  bin() {
    const gen = shellPathGeneration();
    if (this.binCache && this.binGen === gen && fs.existsSync(this.binCache)) return this.binCache;
    const isWin = process.platform === 'win32';
    if (isWin && this.binCache === null && this.binGen === gen) return null;
    let found = null;
    try {
      if (isWin) {
        const res = spawnSync('where', ['mempalace'], { encoding: 'utf8', timeout: 3e3 });
        const p = res.stdout.trim().split(/\r?\n/)[0]?.trim();
        if (p && fs.existsSync(p)) found = p;
      } else {
        found = findCommandOnPath('mempalace', userShellPath());
      }
    } catch {}
    if (!found) found = this.fallbackBin();
    this.binCache = found;
    this.binGen = gen;
    return found;
  }
  /** The common uv tool / homebrew / pip locations, existsSync-only (verbatim ~13445). */
  fallbackBin() {
    const isWin = process.platform === 'win32';
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    const candidates = isWin ? [
      path.join(home, '.local', 'bin', 'mempalace.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mempalace.exe'),
    ] : [
      `${home}/.local/bin/mempalace`,
      '/opt/homebrew/bin/mempalace',
      '/usr/local/bin/mempalace',
    ];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
    return null;
  }
  /** Force re-resolution (e.g. after the user installs mempalace) (verbatim ~13460). */
  resetBinCache() { this.binCache = undefined; }
  /** Clone shim — the resolved CLI path, or null. */
  palaceBin() { return this.bin() ?? which('mempalace'); }

  available() { return this.bin() !== null; }
  active()    { return this.available() && this.home != null; }
  model()     { return 'minilm'; }

  /** Verbatim-shaped status; `statusWithBin` lets an async resolver reuse a
   *  CLI path it already found without launching a login-shell probe. */
  status() { return this.statusWithBin(this.bin()); }
  statusWithBin(bin) {
    const palace = this.palacePath();
    return {
      available: bin !== null,
      enabled: true,
      active: bin !== null && palace !== null,
      initialized: !!palace && fs.existsSync(palace),
      palacePath: palace,
      model: this.model(),
      bin,
    };
  }

  /** Env merged into each agent's spawn so its `mempalace` CLI hits the shared palace. */
  env() {
    const palace = this.palacePath();
    if (!this.active() || !palace) return {};
    return {
      MEMPALACE_PALACE_PATH: palace,
      MEMPALACE_EMBEDDING_MODEL: this.model(),
      ...(MEMPALACE_DEVICE ? { MEMPALACE_EMBEDDING_DEVICE: MEMPALACE_DEVICE } : {}),
    };
  }
  childEnv() {
    return {
      ...process.env,
      MEMPALACE_PALACE_PATH: this.palacePath() ?? '',
      MEMPALACE_EMBEDDING_MODEL: this.model(),
      ...(MEMPALACE_DEVICE ? { MEMPALACE_EMBEDDING_DEVICE: MEMPALACE_DEVICE } : {}),
    };
  }

  // — lifecycle —
  /** Verbatim start() (ref ~13517): reap quarantine, arm the loop. `mempalace
   *  mine` auto-creates the palace; we deliberately do NOT run `mempalace init`
   *  — its interactive "Mine now? [Y/n]" prompt hangs a spawned child. */
  start() {
    if (!this.active() || this.initStarted) return;
    if (!this.bin() || !this.palacePath()) return;
    this.initStarted = true;
    this.reapPalace();
    this.startMineLoop();
  }
  stop() {
    this.mineStopped = true;
    if (this.mineTimer) { clearTimeout(this.mineTimer); this.mineTimer = null; }
  }
  /** Clone-name aliases kept for harness.js / ipc/app.js / ipc/config.js. */
  startMining() { this.mineStopped = false; this.start(); return this.active(); }
  stopMining()  { this.stop(); }

  /** Re-resolve the CLI, arm the loop if it is only now possible, report status
   *  (verbatim ~13548): the status poll is the one thing that reliably notices
   *  a mempalace install that lands AFTER boot — start() is idempotent. */
  refresh() {
    if (!this.binCache) this.resetBinCache();
    this.start();
    return this.status();
  }

  /** Self-scheduling rather than setInterval so the gap can widen while the
   *  palace quarantines and snap back when it stops (verbatim ~13555). */
  startMineLoop() {
    if (this.mineTimer) return;
    const tick = () => {
      void this.mineNow().finally(() => {
        if (this.mineStopped) return;
        this.mineTimer = setTimeout(tick, this.mineDelayMs);
        this.mineTimer.unref?.();
      });
    };
    this.mineTimer = setTimeout(tick, 0);
    this.mineTimer.unref?.();
  }

  // — mining (store) —
  /** Mine every agent whose memory.md changed, ONE AT A TIME — the palace
   *  permits a single writer (verbatim ~13572). `mining` guards a slow pass
   *  against overlap; the delay doubles while the palace quarantines. */
  async mineNow() {
    const home = this.home;
    const bin = this.bin();
    if (!this.active() || !home || !bin) return { mined: 0 };
    if (this.mining) return { mined: 0 };
    const agentsDir = path.join(this.hive.root(), 'agents');
    if (!fs.existsSync(agentsDir)) return { mined: 0 };
    let ids;
    try { ids = fs.readdirSync(agentsDir); } catch { return { mined: 0 }; }
    this.mining = true;
    let mined = 0;
    try {
      for (const id of ids) {
        const agentDir = path.join(agentsDir, id);
        const mem = path.join(agentDir, 'memory.md');
        if (!fs.existsSync(mem)) continue;
        let mtime = 0;
        try { mtime = fs.statSync(mem).mtimeMs; } catch { continue; }
        if (this.lastMined.get(id) === mtime) continue;
        this.lastMined.set(id, mtime);
        await this.mineAgent(agentDir, id);
        if (this.lastMined.get(id) === mtime) mined++;
      }
    } finally { this.mining = false; }
    const quarantined = this.reapPalace();
    this.mineDelayMs = nextMineDelayMs(this.mineDelayMs, MINE_INTERVAL_MS, MINE_BACKOFF_MAX_MS, quarantined);
    return { mined };
  }

  /** Delete quarantined segment copies MemPalace renamed aside (verbatim ~13625).
   *  Best-effort disk hygiene — keeps the newest couple, refuses anything
   *  recent enough to still be mid-recovery. Returns true when a NEWER
   *  quarantine stamp appeared since last pass. */
  reapPalace() {
    const palace = this.palacePath();
    if (!palace || !fs.existsSync(palace)) return false;
    let names;
    try { names = fs.readdirSync(palace); } catch { return false; }
    let newest = 0;
    for (const name of names) {
      const ts = quarantineStampMs(name);
      if (ts !== null && ts > newest) newest = ts;
    }
    const fresh = this.lastQuarantineTs > 0 && newest > this.lastQuarantineTs;
    if (newest > this.lastQuarantineTs) this.lastQuarantineTs = newest;
    const doomed = quarantineDirsToReap(names.map((name) => ({ name })), Date.now());
    if (!doomed.length) return fresh;
    let removed = 0;
    for (const name of doomed) {
      try { fs.rmSync(path.join(palace, name), { recursive: true, force: true }); removed += 1; } catch {}
    }
    if (removed) console.log(`[memory] reaped ${removed} quarantined palace segment(s)`);
    return fresh;
  }

  /** One agent's `mempalace mine` (verbatim ~13654): `--wing id --agent id`,
   *  stderr captured for the failure log, SIGTERM + ensureKilled after the
   *  10-minute timeout, lastMined rolled back on failure so the next pass
   *  retries. */
  mineAgent(agentDir, id) {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!bin) { resolve(); return; }
      try { ensureMineIgnore(agentDir); } catch {}
      const proc = spawn(bin, ['mine', agentDir, '--wing', id, '--agent', id], {
        env: this.childEnv(),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      proc.stderr?.on('data', (d) => { err += d.toString(); });
      const timer = setTimeout(() => {
        console.error(`[memory] mine ${id} timed out after ${MINE_TIMEOUT_MS / 6e4}min — killing`);
        try { proc.kill('SIGTERM'); } catch {}
        ensureKilledLocal(proc.pid);
      }, MINE_TIMEOUT_MS);
      timer.unref?.();
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.error(`[memory] mine ${id} exited ${code}: ${err.slice(-300)}`);
          this.lastMined.delete(id);
        }
        resolve();
      });
      proc.on('error', () => {
        clearTimeout(timer);
        this.lastMined.delete(id);
        resolve();
      });
    });
  }

  // — recall (read) —
  /** One mempalace read command, async so a cold model load never blocks the
   *  main process (verbatim ~13699). */
  runCli(args, label) {
    return new Promise((resolve) => {
      const bin = this.bin();
      if (!this.active() || !bin) {
        resolve({ ok: false, output: '', error: 'semantic memory not active' });
        return;
      }
      let proc;
      try {
        proc = spawn(bin, args, { env: this.childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) });
        return;
      }
      let out = '', err = '', settled = false;
      const settle = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
      proc.stdout?.setEncoding('utf8');
      proc.stderr?.setEncoding('utf8');
      proc.stdout?.on('data', (d) => { out += d; });
      proc.stderr?.on('data', (d) => { err += d; });
      const timer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        ensureKilledLocal(proc.pid);
        settle({ ok: false, output: out, error: `${label} timed out` });
      }, 12e4);
      timer.unref?.();
      proc.on('close', (code) => {
        if (code !== 0) settle({ ok: false, output: out, error: (err || `${label} failed`).trim() });
        else settle({ ok: true, output: out });
      });
      proc.on('error', (e) => settle({ ok: false, output: '', error: e.message }));
    });
  }
  /** Semantic search across the shared palace (verbatim ~13747). */
  search(query, opts = {}) {
    const args = ['search', query, '--results', String(opts.results ?? 8)];
    if (opts.wing) args.push('--wing', opts.wing);
    return this.runCli(args, 'search');
  }
  /** Session-start digest (~600-900 tokens) (verbatim ~13753). */
  wakeUp(wing) {
    const args = ['wake-up'];
    if (wing) args.push('--wing', wing);
    return this.runCli(args, 'wake-up');
  }
}

// ── verbatim ensureKilled (ref ~110) — the pty.js copy is module-private, so
// the mine timeout + runCli sweep use this local port of the same routine. ───
const KILL_GRACE_MS = 4e3;
function hardKillTreeLocal(pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}
function groupMembersLocal(pgid) {
  if (process.platform === 'win32' || typeof pgid !== 'number' || pgid <= 0) return null;
  try {
    const out = spawnSync('ps', ['-axo', 'pid=,pgid=,lstart='], { encoding: 'utf8', timeout: 3e3 }).stdout ?? '';
    const members = new Map();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(-?\d+)\s+(.+)$/);
      if (m && Number.parseInt(m[2], 10) === pgid) members.set(Number(m[1]), m[3]);
    }
    return members;
  } catch { return null; }
}
function shouldSweepLocal(before, after) {
  if (before === null || after === null) return true;
  if (after.size === 0) return false;
  for (const [pid, started] of after) if (before.get(pid) === started) return true;
  return false;
}
function ensureKilledLocal(pid, graceMs = KILL_GRACE_MS) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const t = setTimeout(() => hardKillTreeLocal(pid), graceMs);
    t.unref?.();
    return;
  }
  const before = groupMembersLocal(pid);
  const t = setTimeout(() => { if (shouldSweepLocal(before, groupMembersLocal(pid))) hardKillTreeLocal(pid); }, graceMs);
  t.unref?.();
}

module.exports = { MemoryManager, RULES_HEADING, NOTES_HEADING, PINNED_NOTES_CAP_BYTES };
