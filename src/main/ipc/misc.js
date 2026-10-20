'use strict';
/**
 * The small verbatim handlers that don't own a module-sized group:
 *   analytics:*          ref ~34925-34946   (ctx.analytics optional — no-op w/o)
 *   history:*            ref ~36119-36133   (JSONL command-history store)
 *   roster:*             ref ~35401-35408   (RosterStore verbatim)
 *   floor:probe/open/state + window:getVisibility + window:newFloor picker
 *                        ref ~12505-12540, ~32634-32644, ~36228
 *   telemetry:*          ref ~36391-36393   (ctx.harness.telemetry)
 *   hero:payload         ref ~35941         (file-share.js loadHero)
 *   models:catalog       ref ~35943         (tools.js loadModelCatalog)
 *   tools:status         ref ~35981         (tools.js toolsStatus + mempalace)
 *   workers:*            ref ~37599-37642   (ctx.liveWorkers/preservedWorktrees
 *                                            + worker history JSONL)
 *   terminal:probe:reply — registered in ipc/pty.js (ipcMain.on → terminalProbes.reply)
 *   integrations:* / providerKey:* / customSecret:*
 *                        ref ~34996-35050   (ib.* verbatim names)
 *   solo/free/pro/billing ref ~33763-33890  (license + free-account + pricing;
 *                                            reduced to the local license.js)
 *   hire:*               ref ~33957-33975   (manifest import dialog + pending queue)
 *   memory:reflectNow already lives in webhooks.js.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { RosterStore } = require('../roster-store');
const { loadHero } = require('../file-share');
const { toolsStatus, loadModelCatalog } = require('../tools');
const ib = require('../integration-broker');
const {
  initialWindowVisibility, nextWindowVisibility, windowHidden,
} = require('../pty-submit');

// ── verbatim helpers ──────────────────────────────────────────────────────
const FLOOR_LOCK_FILE = '.floor-lock';
const floorLockPath = (hiveRoot) => path.join(hiveRoot, FLOOR_LOCK_FILE);
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function normaliseHome(p) {
  const t = String(p ?? '').trim();
  const expanded = t === '~' ? os.homedir() : t.startsWith('~/') || t.startsWith('~\\') ? path.join(os.homedir(), t.slice(2)) : t;
  return path.resolve(expanded);
}
function samePath(a, b) {
  const x = normaliseHome(a), y = normaliseHome(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
function readFloorLock(hiveRoot) {
  const file = floorLockPath(hiveRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return 'unreadable';
    if (!Number.isInteger(raw.pid) || typeof raw.userData !== 'string' || !raw.userData) return 'unreadable';
    return { pid: raw.pid, userData: raw.userData, since: typeof raw.since === 'string' ? raw.since : '', version: typeof raw.version === 'string' ? raw.version : void 0 };
  } catch { return 'unreadable'; }
}
function checkFloorLock(hiveRoot, me2, opts = {}) {
  const lock = readFloorLock(hiveRoot);
  if (lock === null) return { state: 'free' };
  if (lock === 'unreadable') return { state: 'unreadable' };
  if (samePath(lock.userData, me2.userData)) return { state: 'mine', lock };
  const alive2 = (opts.isAlive ?? pidAlive)(lock.pid);
  return alive2 ? { state: 'held', lock } : { state: 'stale', lock };
}
function probeFloor(home, ctx2, opts = {}) {
  const h = normaliseHome(home);
  if (!fs.existsSync(h)) return { state: 'missing' };
  if (ctx2.currentHome && samePath(h, ctx2.currentHome)) return { state: 'current' };
  const s = checkFloorLock(ctx2.hiveRootOf(h), { pid: process.pid, userData: ctx2.userData }, opts);
  if (s.state === 'held') return { state: 'held', lock: s.lock };
  if (s.state === 'mine') return { state: 'current' };
  return { state: 'free' };
}
function validateFloorRequest(req, ctx2, opts = {}) {
  if (typeof req.harnessHome !== 'string' || !req.harnessHome.trim()) return { ok: false, refusal: 'invalid', detail: 'no folder' };
  const home = normaliseHome(req.harnessHome);
  if (ctx2.currentHome && samePath(home, ctx2.currentHome)) return { ok: false, refusal: 'current' };
  if (req.dataDir) {
    if (samePath(req.dataDir, ctx2.userData)) return { ok: false, refusal: 'same-data-dir' };
    const parentInsideChild = (normaliseHome(ctx2.userData) + path.sep).startsWith(normaliseHome(req.dataDir) + path.sep);
    if (parentInsideChild) return { ok: false, refusal: 'same-data-dir', detail: "the data folder contains this floor's own" };
  }
  const state2 = checkFloorLock(ctx2.hiveRootOf(home), { pid: process.pid, userData: ctx2.userData }, opts);
  if (state2.state === 'held') return { ok: false, refusal: 'held', lock: state2.lock };
  if (state2.state === 'mine') return { ok: false, refusal: 'current' };
  return { ok: true, harnessHome: home };
}
// verbatim ~12363-12396: 3-attempt wx-create of the .floor-lock file so two
// floors never open the same hive. The picker IPC only reads locks — boot is
// the only writer (acquireFloorAtBoot).
function acquireFloorLock(hiveRoot, me2, opts = {}) {
  const file = floorLockPath(hiveRoot);
  const lock = { pid: me2.pid, userData: normaliseHome(me2.userData), since: new Date().toISOString(), version: me2.version };
  let cleared;
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = checkFloorLock(hiveRoot, me2, opts);
    if (current.state === 'held') return { ok: false, error: 'held', lock: current.lock };
    if (current.state !== 'free') {
      if (current.state === 'stale') cleared = current.lock;
      try { fs.unlinkSync(file); } catch {}
    } else if (attempt === 0) {
      opts.onFree?.();
    }
    try {
      fs.mkdirSync(hiveRoot, { recursive: true });
      const fd = fs.openSync(file, 'wx', 384);
      try { fs.writeSync(fd, JSON.stringify(lock, null, 2)); } finally { fs.closeSync(fd); }
      return { ok: true, lock, cleared };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, error: 'io', detail: e instanceof Error ? e.message : String(e) };
    }
  }
  const last = checkFloorLock(hiveRoot, me2, opts);
  if (last.state === 'held') return { ok: false, error: 'held', lock: last.lock };
  return { ok: false, error: 'io', detail: 'could not create the lock after three attempts' };
}
function releaseFloorLock(hiveRoot, me2) {
  const lock = readFloorLock(hiveRoot);
  if (lock === null) return false;
  if (lock !== 'unreadable' && !samePath(lock.userData, me2.userData)) return false;
  try { fs.unlinkSync(floorLockPath(hiveRoot)); return true; } catch { return false; }
}
function describeFloorLock(lock) {
  const when = lock.since ? ` since ${lock.since}` : '';
  const ver = lock.version ? `, app ${lock.version}` : '';
  return `pid ${lock.pid}${ver}, data ${lock.userData}${when}`;
}
function isFloorState(v) { return v === 'awaiting-hive-selection' || v === 'open'; }

// ── hire manifest validation (verbatim ~25677-25890) ──────────────────────
const HIRE_SPEC_V1 = 'ozycomp/hire@1';
const BUNDLED_SKILL_IDS = new Set(['md-hive-sync', 'md-fetch-summarize', 'md-audit']);
const HIRE_MAX_BYTES = 64 * 1024;
const FLAG_RE = /^[A-Za-z0-9._/=:,@+-]{1,100}$/;
const MODEL_RE = /^[A-Za-z0-9 ._()[\]/:@+-]{1,80}$/;
const SAFE_FLAG_NAMES = new Set(['--model', '--max-turns', '--output-format', '--verbose']);
function isSafeFlag(token) {
  if (!token.startsWith('-')) return false;
  const name = token.split('=', 1)[0].toLowerCase();
  return SAFE_FLAG_NAMES.has(name);
}
const str2 = (v) => typeof v === 'string';
function capped(v, max, field, errors, required = false) {
  if (v === void 0 || v === null) {
    if (required) errors.push(`"${field}" is required`);
    return void 0;
  }
  if (!str2(v)) { errors.push(`"${field}" must be a string`); return void 0; }
  const t = v.trim();
  if (required && !t) { errors.push(`"${field}" must not be empty`); return void 0; }
  if (t.length > max) { errors.push(`"${field}" exceeds ${max} chars`); return void 0; }
  return t || void 0;
}
const PROVIDER_IDS = ['claude', 'codex', 'gemini', 'opencode', 'antigravity', 'shell'];
const { MCP_CATALOG } = require('../mcp-catalog');
const { MAX_AGENT_TOKEN_CAP } = require('../config');
const mcpCatalogEntry = (id) => MCP_CATALOG.find((e) => e.id === id);
function validateHireManifest(raw) {
  const errors = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest must be a JSON object'] };
  }
  const o = raw;
  if (o.spec !== HIRE_SPEC_V1) {
    return { ok: false, errors: [`unsupported spec "${String(o.spec)}" (expected "${HIRE_SPEC_V1}")`] };
  }
  const name = capped(o.name, 40, 'name', errors, true);
  const description = capped(o.description, 200, 'description', errors);
  const goal = capped(o.goal, 4e3, 'goal', errors);
  const character = capped(o.character, 24, 'character', errors)?.toLowerCase();
  const accent = capped(o.accent, 24, 'accent', errors)?.toLowerCase();
  const model = capped(o.model, 80, 'model', errors);
  if (model !== void 0 && !MODEL_RE.test(model)) {
    errors.push('"model" contains disallowed characters (it goes onto the spawn command line; letters, digits, spaces and . _ - ( ) [ ] / : @ + only)');
  }
  const author = capped(o.author, 80, 'author', errors);
  const homepage = capped(o.homepage, 300, 'homepage', errors);
  let provider;
  if (o.provider !== void 0) {
    const p = str2(o.provider) ? o.provider === 'agy' ? 'antigravity' : o.provider : o.provider;
    if (str2(p) && PROVIDER_IDS.includes(p)) provider = p;
    else errors.push(`"provider" must be one of ${PROVIDER_IDS.join(', ')} (or "agy")`);
  }
  let commandFlags;
  if (o.commandFlags !== void 0) {
    if (!Array.isArray(o.commandFlags) || o.commandFlags.length > 16) {
      errors.push('"commandFlags" must be an array of at most 16 items');
    } else {
      commandFlags = [];
      let valueAllowed = false;
      for (let i = 0; i < o.commandFlags.length; i++) {
        const f = o.commandFlags[i];
        if (!str2(f) || !FLAG_RE.test(f)) {
          errors.push(`commandFlags entry ${JSON.stringify(f)} is not a safe flag token`);
          valueAllowed = false;
          continue;
        }
        if (i === 0 && !f.startsWith('-')) {
          errors.push('"commandFlags" must start with a flag (e.g. "--model")');
          valueAllowed = false;
          continue;
        }
        if (f.startsWith('-')) {
          if (!isSafeFlag(f)) {
            errors.push(`commandFlags entry ${JSON.stringify(f)} is not in the shared-hire safe-flag list — for safety a shared hire may only embed known-harmless flags (${[...SAFE_FLAG_NAMES].join(', ')}). If you need this flag, add it by hand in the command field after importing.`);
            valueAllowed = false;
            continue;
          }
          commandFlags.push(f);
          valueAllowed = !f.includes('=');
        } else {
          if (!valueAllowed) {
            errors.push(`commandFlags entry ${JSON.stringify(f)} is not allowed here (a value may only follow an allowed flag such as "--model")`);
            continue;
          }
          commandFlags.push(f);
          valueAllowed = false;
        }
      }
      if (commandFlags.length === 0) commandFlags = void 0;
    }
  }
  let capabilities;
  if (o.capabilities !== void 0) {
    if (!Array.isArray(o.capabilities) || o.capabilities.length > 12) {
      errors.push('"capabilities" must be an array of at most 12 items');
    } else {
      capabilities = o.capabilities.filter(str2).map((c) => c.trim().slice(0, 40)).filter(Boolean);
      if (capabilities.length === 0) capabilities = void 0;
    }
  }
  let isolate;
  if (o.isolate !== void 0) {
    if (typeof o.isolate === 'boolean') isolate = o.isolate;
    else errors.push('"isolate" must be a boolean');
  }
  let tokenCap;
  if (o.tokenCap !== void 0) {
    if (typeof o.tokenCap === 'number' && Number.isInteger(o.tokenCap) && o.tokenCap > 0 && o.tokenCap <= MAX_AGENT_TOKEN_CAP) tokenCap = o.tokenCap;
    else errors.push('"tokenCap" must be a positive integer (max 1e10)');
  }
  let skills;
  if (o.skills !== void 0) {
    if (!Array.isArray(o.skills) || o.skills.length > 8) {
      errors.push('"skills" must be an array of at most 8 items');
    } else {
      skills = [];
      for (const s of o.skills) {
        if (!str2(s) || !s.trim()) {
          errors.push('"skills" entries must be non-empty strings');
          continue;
        }
        const id = s.trim();
        if (!BUNDLED_SKILL_IDS.has(id)) {
          errors.push(`"skills" entry ${JSON.stringify(id)} is not a bundled skill id — a hire may only reference the built-in safe skills (${[...BUNDLED_SKILL_IDS].join(', ')})`);
        } else {
          skills.push(id);
        }
      }
      if (skills.length === 0) skills = void 0;
    }
  }
  let mcpServers;
  const consentRequired = [];
  if (o.mcpServers !== void 0) {
    if (!Array.isArray(o.mcpServers) || o.mcpServers.length > 8) {
      errors.push('"mcpServers" must be an array of at most 8 items');
    } else {
      mcpServers = [];
      for (const s of o.mcpServers) {
        if (!str2(s) || !s.trim()) {
          errors.push('"mcpServers" entries must be non-empty strings');
          continue;
        }
        const id = s.trim();
        const entry = mcpCatalogEntry(id);
        if (!entry) {
          errors.push(`"mcpServers" entry ${JSON.stringify(id)} is not a known catalog id — a hire may only reference built-in MCP servers`);
        } else {
          mcpServers.push(id);
          if (entry.tier !== 'safe-readonly') consentRequired.push(id);
        }
      }
      if (mcpServers.length === 0) mcpServers = void 0;
    }
  }
  if (homepage && !homepage.startsWith('https://')) errors.push('"homepage" must be https');
  if (errors.length > 0 || !name) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    consentRequired: consentRequired.length > 0 ? consentRequired : void 0,
    manifest: { spec: HIRE_SPEC_V1, name, description, goal, character, accent, provider, model, commandFlags, capabilities, isolate, tokenCap, author, homepage, skills, mcpServers },
  };
}
function finishHire(v) {
  if (v.ok && v.manifest) return { ok: true, manifest: v.manifest };
  return { ok: false, error: `invalid hire manifest: ${v.errors.join('; ')}` };
}
function readHireManifestFile(p2) {
  try {
    if (fs.statSync(p2).size > HIRE_MAX_BYTES) return { ok: false, error: 'manifest too large' };
    const parsed = JSON.parse(fs.readFileSync(p2, 'utf8'));
    return finishHire(validateHireManifest(parsed));
  } catch (e) {
    return { ok: false, error: `could not read manifest: ${String(e)}` };
  }
}
function readHireManifestFiles(paths) {
  const manifests = [];
  const errors = [];
  for (const p2 of paths) {
    const result = readHireManifestFile(p2);
    if (result.ok) manifests.push(result.manifest);
    else {
      const name = path.basename(p2);
      errors.push(`${name}: ${result.error.split(p2).join(name)}`);
    }
  }
  return { manifests, errors };
}

// ── analytics verbatim lists (ref ~23780-23800) ───────────────────────────
const RENDERER_MESSAGE_SURFACES = new Set(['terminal', 'composer']);
const isRendererMessageSurface = (v) => typeof v === 'string' && RENDERER_MESSAGE_SURFACES.has(v);
const FUNNEL_EVENTS = ['paywall_shown', 'checkout_opened', 'checkout_finished', 'licence_activated', 'access_blocked', 'invite_redeemed'];
const isFunnelEvent = (v) => typeof v === 'string' && FUNNEL_EVENTS.includes(v);
const RENDERER_FUNNEL_EVENTS = new Set(['paywall_shown', 'access_blocked', 'checkout_opened']);

// ── command-history JSONL store (PersistStore.command_history equivalent) ─
const HISTORY_LIMIT = 500;
const WORKER_HISTORY_LIMIT = 500;
function clampLimit(n, fallback) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(1e3, v);
}
class JsonlLedger {
  constructor(file, limit) { this.file = file; this.limit = limit; }
  readAll() {
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  }
  writeAll(rows) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {}
  }
  append(row) { this.writeAll([row, ...this.readAll()].slice(0, this.limit)); }
}
function withWorkerHistoryEntry(current, input, id, ts) {
  const prior = current.find((e) => e.id === input.id);
  const entry = { ...(prior ?? {}), ...input, id: prior?.id ?? input.id ?? id, ts: input.ts ?? prior?.ts ?? ts };
  return { entry, next: [entry, ...current.filter((e) => e.id !== entry.id)].slice(0, WORKER_HISTORY_LIMIT) };
}
function withWorktreeFate(current, workerId, fate) {
  return current.map((e) => e.id === workerId ? { ...e, worktreeFate: fate } : e);
}

function register(ctx) {
  const { ipcMain, app, dialog, BrowserWindow } = ctx;
  const liveWebContents = () => {
    const wc = ctx.win()?.webContents;
    if (wc && !wc.isDestroyed()) return wc;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
    }
    return null;
  };

  // ── shared verbatim state ────────────────────────────────────────────────
  const roster = ctx.roster ??= new RosterStore(() => ctx.readConfig().harnessHome);
  const windowVisibility = ctx.windowVisibility ??= new Map();
  const floorStateBox = ctx.floorStateBox ??= { state: 'starting' };
  const pendingHires = ctx.pendingHires ??= [];
  const workerHistory = ctx.workerHistoryLedger ??= new JsonlLedger(path.join(ctx.ozycompHome?.() ?? app.getPath('userData'), 'worker-history.json'), WORKER_HISTORY_LIMIT);
  // verbatim ~36119-36133: command history is persist.addHistory/listHistory/
  // searchHistory over the SQLite command_history table. ctx.persist is a
  // PersistStore opened at boot; the JSONL fallback keeps headless tests on
  // the same call shape when it is absent.
  const cmdHistory = ctx.persist ?? (ctx.commandHistoryLedger ??= new JsonlLedger(path.join(ctx.ozycompHome?.() ?? app.getPath('userData'), 'command-history.json'), HISTORY_LIMIT));
  ctx.listWorkerHistory = () => workerHistory.readAll();
  const notifyWorkerHistoryUpdated = () => { try { liveWebContents()?.send('workers:historyUpdated'); } catch {} };
  ctx.appendWorkerHistory = (input) => {
    const { entry, next } = withWorkerHistoryEntry(workerHistory.readAll(), input, crypto.randomBytes(8).toString('hex'), Date.now());
    workerHistory.writeAll(next);
    notifyWorkerHistoryUpdated();
    return entry;
  };
  ctx.setWorkerHistoryWorktree = (workerId, fate) => {
    workerHistory.writeAll(withWorktreeFate(workerHistory.readAll(), workerId, fate));
    notifyWorkerHistoryUpdated();
  };

  // ── analytics (verbatim ~34925-34946) ────────────────────────────────────
  ipcMain.handle('analytics:messageSent', (_evt, surface) => {
    if (!isRendererMessageSurface(surface)) return { ok: false };
    ctx.analytics?.trackMessageSent?.(surface);
    return { ok: true };
  });
  ipcMain.handle('analytics:funnel', (_evt, event, props) => {
    if (!isFunnelEvent(event) || !RENDERER_FUNNEL_EVENTS.has(event)) return { ok: false };
    const clean2 = {};
    if (props && typeof props === 'object') {
      for (const [k, v] of Object.entries(props)) {
        if (typeof v === 'string') clean2[k] = v;
      }
    }
    if (event === 'checkout_opened' && clean2.plan !== 'teams') return { ok: false };
    ctx.analytics?.trackFunnel?.(event, clean2);
    return { ok: true };
  });

  // ── command history (verbatim ~36119-36133) ──────────────────────────────
  ipcMain.handle('history:add', (_evt, payload) => {
    const p = payload ?? {};
    if (typeof p.agentId !== 'string' || typeof p.text !== 'string') return { ok: false, error: 'invalid args' };
    try {
      if (typeof cmdHistory.addHistory === 'function') {
        cmdHistory.addHistory({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text });
      } else {
        cmdHistory.append({ agentId: p.agentId, cwd: typeof p.cwd === 'string' ? p.cwd : null, text: p.text, ts: Date.now() });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('history:list', (_evt, agentId, limit) => {
    if (typeof cmdHistory.listHistory === 'function') {
      return cmdHistory.listHistory(typeof agentId === 'string' && agentId ? agentId : void 0, typeof limit === 'number' ? limit : void 0);
    }
    const lim = clampLimit(limit, 100);
    const rows = cmdHistory.readAll();
    const scoped = typeof agentId === 'string' && agentId ? rows.filter((r) => r.agentId === agentId) : rows;
    return scoped.slice(0, lim);
  });
  ipcMain.handle('history:search', (_evt, query, limit) => {
    if (typeof cmdHistory.searchHistory === 'function') {
      return cmdHistory.searchHistory(typeof query === 'string' ? query : '', typeof limit === 'number' ? limit : void 0);
    }
    const q = (typeof query === 'string' ? query : '').trim();
    if (!q) return [];
    const lim = clampLimit(limit, 50);
    const needle = q.toLowerCase();
    return cmdHistory.readAll().filter((r) => (r.text ?? '').toLowerCase().includes(needle)).slice(0, lim);
  });

  // ── roster (verbatim ~35401-35408) ───────────────────────────────────────
  ipcMain.on('roster:readSync', (evt) => { evt.returnValue = roster.read(); });
  ipcMain.handle('roster:read', () => roster.read());
  ipcMain.handle('roster:write', (_evt, snap) => roster.write(snap));

  // ── telemetry (verbatim ~36391-36393) ────────────────────────────────────
  const telemetry = () => ctx.harness?.telemetry;
  const getAgentUsageSettled = async (agentId) => {
    const t = telemetry();
    if (!t) return null;
    if (typeof t.getAgentUsageSettled === 'function') return t.getAgentUsageSettled(agentId);
    return t.agentUsage?.(agentId) ?? null;
  };
  ipcMain.handle('telemetry:usage', (_evt, agentId) => typeof agentId === 'string' ? getAgentUsageSettled(agentId) : null);
  ipcMain.handle('telemetry:spans', (_evt, agentId) => {
    const t = telemetry();
    if (!t) return [];
    if (typeof t.getSpans === 'function') return t.getSpans(agentId);
    return t.spans?.get?.(agentId)?.slice() ?? [];
  });
  ipcMain.handle('telemetry:snapshot', () => {
    const t = telemetry();
    if (!t) return { usage: [], spans: {} };
    if (typeof t.snapshot === 'function') return t.snapshot();
    return t.totals?.() ?? { usage: [], spans: {} };
  });

  // ── hero + models + tools (verbatim ~35941-36010) ───────────────────────
  ipcMain.handle('hero:payload', (_evt, force) => loadHero(path.join(app.getPath('userData'), 'hero.json'), { force: force === true }));
  const MODEL_CATALOG_CACHE = () => path.join(app.getPath('userData'), 'model-catalog.json');
  ipcMain.handle('models:catalog', (_evt, force) => loadModelCatalog(MODEL_CATALOG_CACHE(), { force: force === true }));
  ipcMain.handle('tools:status', async () => {
    const mem = (() => {
      try { return ctx.harness?.memory?.statusWithBin?.(ctx.harness?.memory?.fallbackBin?.()) ?? null; } catch { return null; }
    })();
    return toolsStatus({ mempalace: mem });
  });

  // ── window + floors (verbatim ~36228, ~12505-12540, ~32634) ──────────────
  ipcMain.handle('window:getVisibility', (e) => {
    const win2 = BrowserWindow.fromWebContents(e.sender);
    if (!win2 || win2.isDestroyed()) return { hidden: false };
    const state2 = windowVisibility.get(win2) ?? initialWindowVisibility(win2.isVisible(), win2.isMinimized());
    return { hidden: windowHidden(state2) };
  });
  const floorCtxOf = () => ({
    currentHome: ctx.readConfig().harnessHome ?? null,
    userData: app.getPath('userData'),
    hiveRootOf: (home) => path.join(home, 'hive'),
  });
  ipcMain.handle('floor:probe', (_evt, paths) => {
    const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && !!p) : [];
    const c = floorCtxOf();
    return list.map((p) => ({ path: p, ...probeFloor(p, c) }));
  });
  ipcMain.handle('floor:open', async (_evt, arg) => {
    const a = arg ?? {};
    const harnessHome = typeof a.harnessHome === 'string' ? a.harnessHome : '';
    const dataDir = typeof a.dataDir === 'string' ? a.dataDir : void 0;
    const v = validateFloorRequest({ harnessHome, dataDir }, floorCtxOf());
    if (!v.ok) return { ok: false, refusal: v.refusal, lock: v.lock, detail: v.detail };
    try { fs.mkdirSync(v.harnessHome, { recursive: true }); } catch (e) { return { ok: false, refusal: 'mkdir-failed', detail: e instanceof Error ? e.message : String(e) }; }
    if (!ctx.spawnFloor) return { ok: false, refusal: 'no-spawner' };
    try {
      const r = await ctx.spawnFloor({ harnessHome: v.harnessHome });
      return r.ok ? { ok: true } : { ok: false, refusal: 'spawn-failed', detail: r.error };
    } catch (e) {
      return { ok: false, refusal: 'spawn-failed', detail: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.on('floor:state', (_evt, state2) => {
    if (!isFloorState(state2)) return;
    if (state2 === floorStateBox.state) return;
    floorStateBox.state = state2;
    // verbatim ~32633: the same value rides on the harness so the fleet
    // snapshot's `floor` field follows the renderer's picker state.
    try { if (ctx.harness) ctx.harness.floorState = state2; } catch {}
    const hive = ctx.harness?.hive;
    if (hive?.enabled?.()) {
      hive.appendLog?.(state2 === 'open' ? { kind: 'floor-open' } : {
        kind: 'floor-waiting',
        reason: 'harness-config picker is showing; no agents will spawn until a config is opened (set openLastHiveOnLaunch in config.json to skip it on unattended hosts)',
      });
    }
    try { ctx.writeFleetSnapshot?.(); } catch {}
  });
  app.on('will-quit', () => {
    const root = ctx.harness?.hive?.root?.() ?? null;
    if (root) {
      // verbatim ~12536: releaseFloorLock — only unlink when the lock is ours
      // (or unreadable, which the reference treats as releasable).
      try { releaseFloorLock(root, { pid: process.pid, userData: app.getPath('userData') }); } catch {}
    }
  });

  // ── workers (verbatim ~37599-37642) ──────────────────────────────────────
  const liveWorkers = ctx.liveWorkers ??= new Map();
  const preservedWorktrees = ctx.preservedWorktrees ??= new Map();
  const workerTokensUsed = (workerId) => {
    const s = ctx.harness?.telemetry?.agentUsage?.(workerId) ?? ctx.harness?.telemetry?.getAgentUsage?.(workerId);
    if (!s) return 0;
    const t = s.tokens ?? s;
    return (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheCreation ?? 0);
  };
  ipcMain.handle('workers:list', () => {
    const cfg = ctx.readConfig();
    const defaultCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0 ? cfg.defaultWorkerTokenCap : 0;
    const now = Date.now();
    const live = [...liveWorkers.values()].map((rec) => {
      const idle = ctx.harness?.pty?.idleFor?.(rec.workerId);
      const effCap = rec.tokenCap && rec.tokenCap > 0 ? rec.tokenCap : defaultCap > 0 ? defaultCap : 0;
      return {
        workerId: rec.workerId,
        reqId: rec.reqId,
        name: rec.name ?? rec.workerId,
        baseBranch: rec.baseBranch,
        spawnedAt: rec.spawnedAt,
        ageMs: Math.max(0, now - rec.spawnedAt),
        idleMs: idle === void 0 ? null : idle,
        tokensUsed: workerTokensUsed(rec.workerId),
        tokenCap: effCap > 0 ? effCap : null,
        hasSlack: !!rec.slack,
        releasing: !!rec.releasing,
        status: rec.releasing ? 'releasing' : 'working',
      };
    });
    const preserved = [...preservedWorktrees.values()].map((e) => ({
      workerId: e.workerId, wtPath: e.wtPath, baseBranch: e.baseBranch, preservedAt: e.preservedAt,
    }));
    return { live, preserved, maxWorkers: Math.max(1, cfg.maxConcurrentWorkers ?? 4) };
  });
  ipcMain.handle('workers:history', () => ctx.listWorkerHistory());
  ipcMain.handle('workers:stop', (_evt, workerId) => {
    if (typeof workerId !== 'string' || !workerId) return { ok: false, error: 'invalid worker id' };
    const rec = liveWorkers.get(workerId);
    if (!rec) return { ok: false, error: 'no such live worker' };
    if (rec.releasing) return { ok: true };
    rec.releasing = true;
    rec.result = 'stopped';
    console.log(`[worker] manual stop requested for ${workerId}`);
    try { ctx.harness?.pty?.kill?.(workerId); } catch (e) { return { ok: false, error: String(e) }; }
    try { ctx.teardownPty?.(workerId, 'worker'); } catch {}
    return { ok: true };
  });

  // terminal:probe:reply is an ipcMain.on (send) channel — registered verbatim
  // in ipc/pty.js (~34883 → terminalProbes.reply). No ipcMain.handle copy here:
  // the renderer uses ipcRenderer.send, and a stray handle would misroute an
  // invoke to pty.submit(id, text) instead of the probe registry.

  // ── integrations / providerKey / customSecret (verbatim ~34996-35050) ────
  ipcMain.handle('integrations:list', () => ib.listRecordsRedacted());
  ipcMain.handle('integrations:templates', () => ib.INTEGRATION_TEMPLATES);
  const integrationIpc = ctx.integrationIpc ?? ib.integrationHandlers({
    upsertRecord: ib.upsertRecord,
    setSecret: ib.setSecret,
    removeRecord: ib.removeRecord,
    secretRefFor: ib.secretRefFor,
    onChanged: () => ctx.brokerGrants?.onIntegrationsChanged?.(),
  });
  ipcMain.handle('integrations:upsert', (_evt, record) => integrationIpc.upsert(record));
  ipcMain.handle('integrations:setSecret', (_evt, payload) => integrationIpc.setSecret(payload));
  ipcMain.handle('integrations:remove', (_evt, payload) => integrationIpc.remove(payload));
  ipcMain.handle('providerKey:set', (_evt, payload) => {
    const p = payload ?? {};
    if (typeof p.backend !== 'string' || !(p.backend in ib.BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
    if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key required' };
    return ib.setSecret(ib.providerKeyRef(p.backend), p.key);
  });
  ipcMain.handle('providerKey:has', (_evt, backend) => typeof backend === 'string' ? ib.hasSecret(ib.providerKeyRef(backend)) : false);
  ipcMain.handle('providerKey:clear', (_evt, backend) => {
    if (typeof backend !== 'string' || !(backend in ib.BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
    try { ib.deleteSecret(ib.providerKeyRef(backend)); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  ipcMain.handle('customSecret:list', () => ib.customSecretNames(ib.listSecretRefs()));
  ipcMain.handle('customSecret:set', (_evt, payload) => {
    const p = payload ?? {};
    if (typeof p.name !== 'string') return { ok: false, error: 'name required' };
    const problem = ib.secretNameProblem(p.name);
    if (problem) return { ok: false, error: `${p.name || 'name'}: ${problem === 'reserved' ? 'the harness sets this one itself' : 'use only capitals, digits and underscores'}` };
    if (typeof p.value !== 'string' || !p.value) return { ok: false, error: 'value required' };
    return ib.setSecret(ib.customSecretRef(p.name), p.value);
  });
  ipcMain.handle('customSecret:remove', (_evt, name) => {
    if (typeof name !== 'string' || ib.secretNameProblem(name)) return { ok: false, error: 'unknown secret' };
    try { ib.deleteSecret(ib.customSecretRef(name)); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  ipcMain.handle('integrations:test', async (_evt, payload) => {
    const p = payload ?? {};
    if (typeof p.id !== 'string' || !p.id) return { ok: false, error: 'id required' };
    return ib.testIntegration(p);
  });

  // ── solo / free / pro / billing (verbatim ~33763-33890) ─────────────────
  // The clone ships the license surface; the free-account + pro-checkout
  // backends are the reference's hosted services — the handlers keep the
  // verbatim shapes and degrade to the same "unavailable" branches.
  const licenseMod = ctx.licenseMod ??= (() => { try { return require('../license'); } catch { return null; } })();
  const licenseMgr = ctx.license ??= (licenseMod?.LicenseManager ? new licenseMod.LicenseManager({ home: ctx.ozycompHome?.() ?? app.getPath('userData') }) : null);
  const readLicense = () => {
    try { return licenseMgr?.read?.() ?? licenseMgr?.current?.() ?? { plan: 'free' }; } catch { return { plan: 'free' }; }
  };
  const onLicenseChange = (fn) => { try { licenseMgr?.onChange?.(fn); } catch {} };
  ipcMain.handle('solo:license', () => readLicense());
  ipcMain.handle('solo:license:redeem', async (_e, key) => {
    const res = await (licenseMgr?.redeem?.(typeof key === 'string' ? key : '') ?? Promise.resolve({ ok: false, error: 'unavailable' }));
    if (res.ok) ctx.analytics?.trackFunnel?.('licence_activated', { plan: 'pro', source: 'key_entry' });
    return res;
  });
  onLicenseChange((v) => {
    const wc = liveWebContents();
    if (wc) wc.send('solo:license', v);
  });

  // Local build: there is no hosted free-account service, so the renderer is
  // handed a stable local identity. freeAdmits() only checks email+personId are
  // non-empty strings, which keeps the free-path admits true alongside the
  // always-healthy licence — the app never shows a sign-in or paywall.
  const LOCAL_FREE_ACCOUNT = { email: 'local@ozycomp.app', personId: 'local' };
  const freeBox = ctx.freeAccountBox ??= { account: LOCAL_FREE_ACCOUNT, pending: null };
  const readFreeAccount = () => freeBox.account;
  const pushFreeAccount = () => { try { liveWebContents()?.send('free:account', freeBox.account); } catch {} };
  ipcMain.handle('free:account', () => readFreeAccount());
  ipcMain.handle('free:signin:begin', () => ({ ok: true, account: LOCAL_FREE_ACCOUNT }));
  ipcMain.handle('free:signin:paste', (_e, pasted) => { void pasted; return { ok: true, account: LOCAL_FREE_ACCOUNT }; });
  ipcMain.handle('free:signin:cancel', () => { ctx.freeSignin?.cancel?.(); return { ok: true }; });
  ipcMain.handle('free:register', () => ({ ok: true, account: LOCAL_FREE_ACCOUNT }));
  ipcMain.handle('free:signout', () => {
    ctx.freeSignin?.cancel?.();
    freeBox.account = LOCAL_FREE_ACCOUNT;
    try { licenseMgr?.forget?.(); } catch {}
    pushFreeAccount();
    return { ok: true };
  });
  ipcMain.handle('pro:pricing', () => ctx.regionalPricing?.() ?? { ok: false, error: 'unavailable' });
  ipcMain.handle('pro:checkout:begin', async () => {
    const r = await (ctx.beginProCheckout?.() ?? Promise.resolve({ ok: false, error: 'unavailable' }));
    if (r?.url) {
      ctx.analytics?.trackFunnel?.('checkout_opened', { plan: 'pro', seats_bucket: '1' });
      return { ok: true, url: r.url };
    }
    return r ?? { ok: false, error: 'unavailable' };
  });
  // Verbatim (ref ~33638 + ~33672): a refused or failed checkout return is
  // pushed to EVERY window as pro:checkout:return {ok:false, reason}.
  ctx.pushCheckoutReturn = (payload) => {
    const p = payload ?? { ok: false, reason: 'other' };
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('pro:checkout:return', p); } catch {}
    }
  };
  ipcMain.handle('billing:summary', async () => {
    const org = ctx.teams?.org?.() ?? { available: false };
    if (!org.available || org.you?.isAdmin !== true) return { ok: false, reason: 'refused' };
    const r = await (ctx.fetchBilling?.() ?? Promise.resolve({ ok: false, status: 0 }));
    if (!r.ok) {
      if (r.status === 404 || r.error === 'not_found') return { ok: false, reason: 'unavailable' };
      if (r.status === 0) return { ok: false, reason: 'offline' };
      return { ok: false, reason: 'error', error: r.error };
    }
    return ctx.parseBillingWire?.(r.data) ? { ok: true, view: ctx.parseBillingWire(r.data) } : { ok: false, reason: 'error', error: 'invalid_body' };
  });

  // ── hire (verbatim ~33957-33975) ─────────────────────────────────────────
  let rendererReadyForHires = ctx.rendererReadyForHires ?? false;
  ctx.setRendererReadyForHires = (v) => { rendererReadyForHires = v; };
  ctx.queueHire = (manifest) => {
    if (rendererReadyForHires) { try { liveWebContents()?.send('hire:import', manifest); } catch {} }
    else pendingHires.push(manifest);
  };
  ipcMain.handle('hire:drainPending', () => {
    rendererReadyForHires = true;
    const out = pendingHires.splice(0, pendingHires.length);
    return out;
  });
  ipcMain.handle('hire:openFile', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Import hire manifests',
      filters: [{ name: 'Hire manifest', extensions: ['json'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || res.filePaths.length === 0) {
      return { ok: false, manifests: [], errors: [], error: 'cancelled' };
    }
    const batch = readHireManifestFiles(res.filePaths);
    // Verbatim (ref ~33611): a rejected manifest batch is pushed to the
    // renderer as a hire:error so the import card can show why.
    if (batch.manifests.length === 0 && batch.errors.length > 0) {
      try { liveWebContents()?.send('hire:error', { error: batch.errors.join('; ') }); } catch {}
    }
    return {
      ok: batch.manifests.length > 0,
      ...batch,
      error: batch.manifests.length === 0 ? 'no valid hire manifests selected' : void 0,
    };
  });
  // Verbatim (ref ~33608-33612): an inbound hire deep link whose manifest
  // fetch/validate fails surfaces as hire:error on the main window.
  ctx.pushHireError = (error) => {
    try { liveWebContents()?.send('hire:error', { error: String(error ?? 'unknown') }); } catch {}
  };

  // ── window visibility tracker (verbatim ~34060-34071): per-window ledger
  //    fed by minimize/restore/hide/show/focus — each transition updates the
  //    ledger AND pushes `window:visibility` {hidden} to that window's wc. ──
  const trackWindow = (w) => {
    if (!w || w.isDestroyed()) return;
    const wc = w.webContents;
    windowVisibility.set(w, windowVisibility.get(w) ?? initialWindowVisibility(w.isVisible(), w.isMinimized()));
    const onVisibility = (ev) => {
      const next = nextWindowVisibility(windowVisibility.get(w) ?? initialWindowVisibility(true, false), ev);
      windowVisibility.set(w, next);
      if (!wc.isDestroyed()) wc.send('window:visibility', { hidden: windowHidden(next) });
    };
    w.on('minimize', () => onVisibility('minimize'));
    w.on('restore', () => onVisibility('restore'));
    w.on('hide', () => onVisibility('hide'));
    w.on('show', () => onVisibility('show'));
    w.on('focus', () => onVisibility('focus'));
    w.on('closed', () => windowVisibility.delete(w));
  };
  app.on('browser-window-created', (_e, w) => trackWindow(w));
}

module.exports = { register, acquireFloorLock, releaseFloorLock, checkFloorLock, describeFloorLock, validateFloorRequest, probeFloor, normaliseHome, samePath };
