'use strict';
/**
 * Verbatim port — `hive` IPC group (31 channels).
 * Reference: out/main/index.js handler lines 35409–36456 — the hive:* block at
 * 35409–35429 (registry/renameAgent/setAgentHold/humanMailSince/board), the
 * tasks+mail block at 35858–35940, the mempalace block at 36017–36029, the
 * fleet/usage block at 36346–36390, and hive:textSearch at 36456–36490.
 * Helpers (ACTIVITY_RING, keywordsOf/scoreLine/keywordThreshold/excerptAround,
 * readContextTokens, RestoreGateStore) are verbatim from reference lines
 * 5848, 13294–13326, 24606–24680, 25646–25678.
 *
 * Dep mapping: hive → ctx.harness.hive (its root is a plain string prop;
 * enabled() ↔ root !== null). Missing hive methods (tasksArchive, ticketMeta,
 * patchTasks, deleteTask, memory, hasMemory, inboxPath, renameAgent,
 * setAgentHold, setArchived, patchAgentRole, appendLog, send, root, enabled)
 * are installed verbatim-shaped on the hive instance here. `activity` digest,
 * `restoreGate`, `analytics` and `readAgentUsageSettled` are stashed on ctx
 * for other groups. memory → ctx.harness.memory (with verbatim-shaped
 * refresh/search/wakeUp shims over the clone's palaceBin/mineNow), hookServer
 * → ctx.harness.hooks, telemetry → ctx.harness.telemetry, breaker →
 * ctx.harness.breaker.
 */
const node_fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const node_child_process = require('node:child_process');

const ACTIVITY_RING = 200;

// ── verbatim search scoring (reference ~25646-25678) ────────────────────────
const STOP = new Set("the a an and or of to in on at for with about what who when where why how did do does is are was were be been we you i it that this they them our us me my your have has had tell say said know remember decide decided note noted learn learned team memory please any some there here from by as into up out over just so then than also which whom whose will would could should can let get got one thing things something anything everything".split(" "));
function keywordsOf(query) {
  const out = [];
  for (const w of (query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}
function scoreLine(line, keywords) {
  const l = (line || "").toLowerCase();
  let n = 0;
  for (const k of keywords) if (l.includes(k)) n++;
  return n;
}
function keywordThreshold(keywords) {
  return Math.max(1, Math.ceil(keywords.length / 2));
}
function excerptAround(line, keywords, width = 220) {
  const l = line.trim();
  if (l.length <= width) return l;
  const lower = l.toLowerCase();
  let at = -1;
  for (const k of keywords) {
    const i = lower.indexOf(k);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start2 = Math.max(0, Math.min(at === -1 ? 0 : at - Math.floor(width / 3), l.length - width));
  return `${start2 ? "…" : ""}${l.slice(start2, start2 + width).trim()}${start2 + width < l.length ? "…" : ""}`;
}

// ── verbatim context-window tail read (reference ~13294-13326) ──────────────
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
const CONTEXT_TAIL_BYTES = 256 * 1024;
function readContextTokens(transcriptPath) {
  try {
    if (!node_fs.existsSync(transcriptPath)) return null;
    const fd = node_fs.openSync(transcriptPath, "r");
    try {
      const size = node_fs.fstatSync(fd).size;
      const len = Math.min(size, CONTEXT_TAIL_BYTES);
      if (len === 0) return null;
      const buf = Buffer.alloc(len);
      node_fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        let rec;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (rec.type !== "assistant") continue;
        const u = rec.message?.usage;
        if (!u) continue;
        return num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
      }
      return null;
    } finally {
      node_fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// ── verbatim transcript usage reader (reference ~13066-13291, compacted) ────
// The reference reads ~/.claude/projects/<slug>/*.jsonl incrementally through a
// size/mtime cache with chunked async tails; this is the same parse fold and
// cache shape minus the background-slice plumbing (small reads run inline).
function zero() {
  return {
    inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0,
    estimatedCostUsd: 0, sessionsSeen: 0, asOf: Date.now(), model: null
  };
}
const VALID_SESSION_ID = /^[A-Za-z0-9_-]+$/;
function projectDir(cwd) {
  const slug = cwd.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "-";
  return path.join(os.homedir(), ".claude", "projects", slug);
}
function num$1(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function parseUsageBuffer(buf, entry) {
  for (const line of buf.toString("utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const sid = typeof rec.sessionId === "string" ? rec.sessionId
      : typeof rec.session_id === "string" ? rec.session_id : null;
    if (!sid) continue;
    if (rec.type !== "assistant") continue;
    const u = rec.message?.usage;
    if (!u) continue;
    const model = typeof rec.message?.model === "string" ? rec.message.model : null;
    let totals = entry.perSession.get(sid);
    if (!totals) {
      totals = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, estimatedCostUsd: 0, model: null };
      entry.perSession.set(sid, totals);
    }
    const input = num$1(u.input_tokens), output = num$1(u.output_tokens);
    const cacheWrite = num$1(u.cache_creation_input_tokens), cacheRead = num$1(u.cache_read_input_tokens);
    const deltaInput = Math.max(0, input - (totals.lastInput ?? 0));
    const deltaOutput = Math.max(0, output - (totals.lastOutput ?? 0));
    const deltaWrite = Math.max(0, cacheWrite - (totals.lastCacheWrite ?? 0));
    const deltaRead = Math.max(0, cacheRead - (totals.lastCacheRead ?? 0));
    totals.lastInput = input; totals.lastOutput = output;
    totals.lastCacheWrite = cacheWrite; totals.lastCacheRead = cacheRead;
    totals.inputTokens += deltaInput;
    totals.outputTokens += deltaOutput;
    totals.cacheWriteTokens += deltaWrite;
    totals.cacheReadTokens += deltaRead;
    if (model) totals.model = model;
    entry.all.inputTokens += deltaInput;
    entry.all.outputTokens += deltaOutput;
    entry.all.cacheWriteTokens += deltaWrite;
    entry.all.cacheReadTokens += deltaRead;
  }
}
const usageCache = new Map();
function readFileUsage(dir, file) {
  const full = path.join(dir, file);
  let st;
  try {
    st = node_fs.statSync(full);
  } catch {
    usageCache.delete(`${dir}|${file}`);
    return null;
  }
  const cached = usageCache.get(`${dir}|${file}`);
  const base = cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs ? cached : null;
  const entry = base ?? { size: st.size, mtimeMs: st.mtimeMs, offset: 0, all: zero(), perSession: new Map() };
  try {
    const fd = node_fs.openSync(full, "r");
    try {
      const len = st.size - entry.offset;
      if (len > 0) {
        const buf = Buffer.alloc(len);
        const read2 = node_fs.readSync(fd, buf, 0, len, entry.offset);
        const cut2 = buf.subarray(0, read2).lastIndexOf(10) + 1;
        if (cut2 > 0) {
          parseUsageBuffer(buf.subarray(0, cut2), entry);
          entry.offset += cut2;
        }
      }
    } finally {
      node_fs.closeSync(fd);
    }
  } catch {
  }
  entry.size = st.size;
  entry.mtimeMs = st.mtimeMs;
  usageCache.set(`${dir}|${file}`, entry);
  return entry;
}
function readAgentUsage(cwd, opts = {}) {
  const usage = zero();
  try {
    const dir = projectDir(cwd);
    if (!node_fs.existsSync(dir)) return usage;
    let files;
    if (opts.sessionId) {
      const own = `${opts.sessionId}.jsonl`;
      if (!VALID_SESSION_ID.test(opts.sessionId) || !node_fs.existsSync(path.join(dir, own))) {
        usage.asOf = Date.now();
        return usage;
      }
      files = [own];
    } else {
      files = node_fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    }
    let lastModel;
    let asOf = Infinity;
    for (const file of files) {
      const entry = readFileUsage(dir, file);
      if (!entry) continue;
      asOf = Math.min(asOf, entry.mtimeMs);
      const totals = opts.sessionId ? entry.perSession.get(opts.sessionId) : entry.all;
      if (!totals) continue;
      usage.inputTokens += totals.inputTokens;
      usage.outputTokens += totals.outputTokens;
      usage.cacheWriteTokens += totals.cacheWriteTokens;
      usage.cacheReadTokens += totals.cacheReadTokens;
      usage.estimatedCostUsd += totals.estimatedCostUsd;
      if (totals.model) lastModel = totals.model;
    }
    usage.sessionsSeen = files.length;
    if (lastModel) usage.model = lastModel;
    usage.asOf = Number.isFinite(asOf) ? asOf : Date.now();
    return usage;
  } catch {
    return zero();
  }
}
async function readAgentUsageSettled(cwd, opts = {}) {
  // The reference re-reads while background transcript slices are in flight;
  // our reader is fully inline, so the first read is already settled.
  return readAgentUsage(cwd, opts);
}

// ── verbatim task-ledger helpers (reference ~5700-5748, 5803-5816) ──────────
function idOf(entry) {
  return entry && typeof entry.id === "string" ? entry.id : null;
}
function mergeTaskLedger(existing, incoming) {
  const incomingList = Array.isArray(incoming) ? incoming : [];
  const existingList = Array.isArray(existing) ? existing : [];
  const byId = /* @__PURE__ */ new Map();
  for (const entry of existingList) {
    const id = idOf(entry);
    if (id && !byId.has(id)) byId.set(id, entry);
  }
  return incomingList.map((entry) => {
    const id = idOf(entry);
    if (!id) return entry;
    const prior = byId.get(id);
    return prior ? { ...prior, ...entry } : entry;
  });
}
function applyTaskPatches(tasks, patches) {
  const next = tasks.slice();
  const applied = [];
  for (const { id, patch } of patches) {
    const index = next.findIndex((task) => task?.id === id);
    if (index < 0) continue;
    next[index] = { ...next[index], ...patch, id };
    applied.push(id);
  }
  return { next, applied };
}
const TICKET_KEY_RE = /^[A-Z][A-Z0-9]{2}-\d+$/;
const TICKET_PREFIX_RE = /^[A-Z][A-Z0-9]{2}$/;
const ALIAS_MEMORY = 500;
const isRaw = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function isTicketKey(id) {
  return typeof id === "string" && TICKET_KEY_RE.test(id);
}
function isTicketPrefix(p) {
  return typeof p === "string" && TICKET_PREFIX_RE.test(p);
}
function derivePrefix(folderName) {
  const name = (folderName || "").replace(/[^A-Za-z0-9]+/g, " ").trim();
  const firstLetter = name.match(/[A-Za-z]/)?.[0]?.toUpperCase();
  if (!firstLetter) return "TSK";
  const digits = name.replace(/[^0-9]/g, "");
  if (digits.length >= 2) return `${firstLetter}${digits.slice(-2)}`;
  const words = name.split(/\s+|(?<=[a-z0-9])(?=[A-Z])/).filter((w) => /[A-Za-z]/.test(w));
  let out = words.map((w) => (w.match(/[A-Za-z]/)?.[0] ?? "").toUpperCase()).join("");
  if (out.length < 3) {
    const rest = [...words].reverse().map((w) => w.replace(/^[^A-Za-z]*[A-Za-z]/, "")).join("").toUpperCase();
    for (const c of rest.replace(/[^BCDFGHJKLMNPQRSTVWXZ]/g, "")) {
      if (out.length >= 3) break;
      out += c;
    }
    for (const c of rest.replace(/[^A-Z0-9]/g, "")) {
      if (out.length >= 3) break;
      out += c;
    }
  }
  out = (out + "XXX").slice(0, 3);
  return isTicketPrefix(out) ? out : "TSK";
}
function numberUnder(prefix, id) {
  if (!isTicketKey(id) || !id.startsWith(`${prefix}-`)) return 0;
  return Number(id.slice(prefix.length + 1)) || 0;
}
function readTicketMeta(file, folderName) {
  const raw = isRaw(file) && isRaw(file.ticket) ? file.ticket : null;
  const prefix = raw && isTicketPrefix(raw.prefix) ? raw.prefix : derivePrefix(folderName);
  const next = raw && typeof raw.next === "number" && Number.isFinite(raw.next) && raw.next >= 1 ? Math.floor(raw.next) : 1;
  const aliases = {};
  if (raw && isRaw(raw.aliases)) {
    for (const [k, v] of Object.entries(raw.aliases)) if (isTicketKey(v)) aliases[k] = v;
  }
  return { prefix, next, aliases };
}
function assignTicketKeys(tasks, meta, archive = []) {
  const list = Array.isArray(tasks) ? tasks : [];
  const archived = Array.isArray(archive) ? archive : [];
  const aliases = { ...meta.aliases ?? {} };
  let next = Math.max(1, meta.next);
  for (const t of [...list, ...archived]) if (isRaw(t)) next = Math.max(next, numberUnder(meta.prefix, t.id) + 1);
  const taken = /* @__PURE__ */ new Set();
  for (const t of list) if (isRaw(t) && isTicketKey(t.id)) taken.add(t.id);
  let changed = next !== meta.next;
  const out = list.map((t) => {
    if (!isRaw(t) || isTicketKey(t.id)) return t;
    const old = typeof t.id === "string" ? t.id.trim() : "";
    let key = old && aliases[old] && !taken.has(aliases[old]) ? aliases[old] : "";
    if (!key) {
      key = `${meta.prefix}-${next}`;
      next += 1;
    }
    taken.add(key);
    if (old) {
      delete aliases[old];
      aliases[old] = key;
    }
    changed = true;
    const card = { ...t, id: key };
    if (old && !(typeof t.alias === "string" && t.alias)) card.alias = old;
    return card;
  });
  const names = Object.keys(aliases);
  for (const k of names.slice(0, Math.max(0, names.length - ALIAS_MEMORY))) delete aliases[k];
  return { tasks: out, meta: { prefix: meta.prefix, next, aliases }, changed };
}
function resolveTask(tasks, ref) {
  if (!ref) return void 0;
  return tasks.find((t) => t.id === ref) ?? tasks.find((t) => t.alias === ref);
}
const DOING = /* @__PURE__ */ new Set(["doing", "in-progress", "in_progress", "inprogress", "active", "wip"]);
const DONE = /* @__PURE__ */ new Set(["done", "complete", "completed", "closed"]);
const statusOf$1 = (c) => typeof c.status === "string" ? c.status.trim().toLowerCase() : "";
const str$6 = (v) => typeof v === "string" && v ? v : void 0;
const isCard$1 = (c) => !!c && typeof c === "object" && !Array.isArray(c);
function body(c) {
  const { updatedAt: _u, updated_at: _uu, ...rest } = c;
  return JSON.stringify(rest);
}
function stampTaskTimes(prev, next, now) {
  const before = /* @__PURE__ */ new Map();
  for (const c of prev ?? []) {
    if (!isCard$1(c)) continue;
    if (str$6(c.id)) before.set(c.id, c);
    if (str$6(c.alias) && !before.has(c.alias)) before.set(c.alias, c);
  }
  let changed = false;
  const tasks = next.map((c) => {
    if (!isCard$1(c)) return c;
    const was = str$6(c.id) && before.get(c.id) || str$6(c.alias) && before.get(c.alias) || void 0;
    const out = { ...c };
    const status = statusOf$1(c);
    const wasStatus = was ? statusOf$1(was) : "";
    if (!str$6(out.createdAt) && str$6(out.created_at)) out.createdAt = out.created_at;
    if (DONE.has(status) && !str$6(out.doneAt) && str$6(out.completedAt)) out.doneAt = out.completedAt;
    if (was) {
      for (const k of ["createdAt", "startedAt", "doneAt"]) if (!str$6(out[k]) && str$6(was[k])) out[k] = was[k];
    }
    if (!was && !str$6(out.createdAt)) out.createdAt = now;
    if (status !== wasStatus || !was) {
      if (DOING.has(status) && !str$6(out.startedAt)) out.startedAt = now;
      if (DONE.has(status) && !str$6(out.doneAt)) out.doneAt = now;
      if (was && DONE.has(wasStatus) && !DONE.has(status)) out.reopenedAt = now;
    }
    if (!was || body(out) !== body(was)) out.updatedAt = now;
    if (body(out) === body(c) && out.updatedAt === c.updatedAt) return c;
    changed = true;
    return out;
  });
  return { tasks, changed };
}

// ── verbatim ActivityDigest (reference ~12687-12722) ────────────────────────
class ActivityDigest {
  constructor(getWebContents, cap = ACTIVITY_RING) {
    this.getWebContents = getWebContents;
    this.cap = cap;
  }
  rings = /* @__PURE__ */ new Map();
  /** Append one entry for an agent, dropping the oldest past the cap, and push it live. */
  record(agentId, entry) {
    if (!agentId) return;
    let ring2 = this.rings.get(agentId);
    if (!ring2) {
      ring2 = [];
      this.rings.set(agentId, ring2);
    }
    ring2.push(entry);
    if (ring2.length > this.cap) ring2.splice(0, ring2.length - this.cap);
    const push = { agentId, entry };
    try {
      this.getWebContents()?.send("hive:agentActivity", push);
    } catch {
    }
  }
  /** The newest `limit` entries, oldest first. The renderer reads updatedAt off the last one. */
  list(agentId, limit = ACTIVITY_RING) {
    const ring2 = this.rings.get(agentId);
    if (!ring2 || ring2.length === 0) return [];
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, ring2.length) : ring2.length;
    return ring2.slice(ring2.length - n);
  }
  /** Drop an agent's ring when main tears the agent down, so a replacement with the same id starts clean. */
  forget(agentId) {
    this.rings.delete(agentId);
  }
}

// ── verbatim RestoreGateStore (reference ~24606-24680) ──────────────────────
const RESTORE_GATE_FILE = "restore-gate.json";
const MAX_HELD = 2e3;
function emptyFile() {
  return { version: 1, ended: [] };
}
class RestoreGateStore {
  constructor(homeFor) {
    this.homeFor = homeFor;
  }
  /** Read once per home at bootstrap: the answer the gate uses all session. */
  snapshotIds = null;
  snapshotHome = null;
  /** The live set, mirrored in memory so a hold or release is one write. */
  live = null;
  liveHome = null;
  path() {
    const home = this.homeFor();
    return home ? path.join(home, RESTORE_GATE_FILE) : null;
  }
  read() {
    const p = this.path();
    if (!p || !node_fs.existsSync(p)) return emptyFile();
    try {
      const parsed = JSON.parse(node_fs.readFileSync(p, "utf8"));
      if (!parsed || typeof parsed !== "object") return emptyFile();
      const ended = parsed.ended;
      if (!Array.isArray(ended)) return emptyFile();
      return { version: 1, ended: ended.filter((x) => typeof x === "string" && !!x) };
    } catch {
      return emptyFile();
    }
  }
  write(ids) {
    const p = this.path();
    if (!p) return;
    try {
      node_fs.mkdirSync(path.dirname(p), { recursive: true });
      const ended = [...ids].slice(-MAX_HELD);
      const tmp = `${p}.tmp`;
      node_fs.writeFileSync(tmp, JSON.stringify({ version: 1, ended }), "utf8");
      node_fs.renameSync(tmp, p);
    } catch (e) {
      console.error("[restore-gate] write failed:", e);
    }
  }
  /** The live set for the current home, loaded on first use. */
  set() {
    const home = this.homeFor() ?? "";
    if (!this.live || this.liveHome !== home) {
      this.live = new Set(this.read().ended);
      this.liveHome = home;
    }
    return this.live;
  }
  /**
   * What the PREVIOUS session left ended. Captured once per home; every later
   * call returns the same answer, so a teardown later in THIS session can never
   * retire an agent at a restore that has not happened yet.
   */
  snapshot() {
    const home = this.homeFor() ?? "";
    if (this.snapshotIds === null || this.snapshotHome !== home) {
      this.snapshotIds = this.read().ended;
      this.snapshotHome = home;
    }
    return this.snapshotIds;
  }
  /** This agent's terminal ended. Called from `teardownPty`, never from the
   *  startup sweep — that difference is the whole point of the file. */
  hold(id) {
    if (!id) return;
    const set2 = this.set();
    if (set2.has(id)) return;
    set2.add(id);
    this.write(set2);
  }
  /** This agent is running again (spawned, restarted, restored or reopened), so
   *  it is no longer an ending. */
  release(id) {
    if (!id) return;
    const set2 = this.set();
    if (!set2.delete(id)) return;
    this.write(set2);
  }
  /** Drop ids the registry no longer knows about, so a deleted agent does not
   *  sit in the file forever. Cheap, and called once at bootstrap. */
  prune(knownIds) {
    const known = new Set(knownIds);
    const set2 = this.set();
    let changed = false;
    for (const id of [...set2]) if (!known.has(id)) {
      set2.delete(id);
      changed = true;
    }
    if (changed) this.write(set2);
  }
}

// ── verbatim hive-method shims (reference ~7253-7340, 8091-8300, 9058-9237) ──
// The clone's HiveManager already implements the core surfaces; these fill the
// verbatim gaps in place so every handler body below reads exactly like the
// reference. Installed once per hive instance.
function installHiveVerbatim(hive, getHome) {
  if (!hive || hive.__ipcVerbatim) return hive;
  const json = (file, fallback) => {
    try {
      if (!node_fs.existsSync(file)) return fallback;
      return JSON.parse(node_fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };
  const writeJson = (file, obj) => {
    node_fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    node_fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    node_fs.renameSync(tmp, file);
  };
  // hive.root()/hive.enabled() are class methods (verbatim ref shape). Do NOT
  // re-assign them via Object.assign below — a closure named `root` installed
  // over the method made `path.join(this.root…)` receive `function root`.
  const root = () => hive.root();
  const enabled = () => hive.enabled();
  const appendLog = (event) => hive.log(event);
  const commit = hive.commit?.bind(hive) ?? (() => {});
  const emit = hive.emit?.bind(hive) ?? (() => {});
  const readJson = hive.readJson?.bind(hive) ?? json;
  const writeJson2 = hive.writeJson?.bind(hive) ?? writeJson;

  const ticketMeta = (file) => {
    const meta = readTicketMeta(file, path.basename(getHome() ?? ""));
    return hive._ticketPrefix ? { ...meta, prefix: hive._ticketPrefix } : meta;
  };
  const archivedTasks = () => {
    if (!root()) return [];
    const a = json(path.join(root(), "tasks-archive.json"), { tasks: [] });
    return Array.isArray(a?.tasks) ? a.tasks : [];
  };
  const writeLedger = (path2, current2, cards) => {
    const keyed = assignTicketKeys(cards, ticketMeta(current2), archivedTasks());
    const base = current2 && typeof current2 === "object" && !Array.isArray(current2) ? current2 : {};
    const prev = Array.isArray(base.tasks) ? base.tasks : [];
    const { tasks } = stampTaskTimes(prev, keyed.tasks, (/* @__PURE__ */ new Date()).toISOString());
    writeJson2(path2, { ...base, tasks, ticket: keyed.meta });
    return tasks;
  };
  const readLedgerForWrite = (path2) => {
    if (!node_fs.existsSync(path2)) return { tasks: [] };
    try {
      return JSON.parse(node_fs.readFileSync(path2, "utf8"));
    } catch (e) {
      appendLog({ kind: "tasks-write-refused", reason: "unreadable ledger", error: e instanceof Error ? e.message : String(e) });
      throw new Error("hive: tasks.json is unreadable (torn write or corruption); refusing to overwrite it. Restore it from the hive git history or fix it by hand, then retry");
    }
  };
  const writeTasks = (tasks) => {
    if (!root()) return;
    const path$1 = path.join(root(), "tasks.json");
    const current2 = readLedgerForWrite(path$1);
    const onDisk = Array.isArray(current2?.tasks) ? current2.tasks : [];
    const incoming = (Array.isArray(tasks) ? tasks : []).map((c) => {
      const hit = c && typeof c.id === "string" ? resolveTask(onDisk, c.id) : void 0;
      return hit && hit.id !== c.id ? { ...c, id: hit.id } : c;
    });
    const merged = writeLedger(path$1, current2, mergeTaskLedger(current2?.tasks, incoming));
    appendLog({ kind: "tasks", count: merged.length });
    commit(`hive: tasks (${merged.length})`);
  };
  const inboxPath = (id) => {
    if (!root()) return null;
    return path.join(hive.agentDir(id), "inbox");
  };
  const tasksArchive = () => {
    if (!root()) return { tasks: [] };
    return json(path.join(root(), "tasks-archive.json"), { tasks: [] });
  };
  // — hygiene (v0.4.9 W-A): the archive-ledger write, board archive, latch —
  /** The sweep's one write to the two ledgers (verbatim ~9075-9091). `live` is
   *  the raw list the caller just read; `apply` is the pure applySweepPlan
   *  bound to that plan. One commit for both files. */
  const applyTaskHygiene = (live, apply) => {
    const root = hive.root();
    if (!root) return { archived: 0, stamped: 0 };
    hive.ensure?.();
    const archivePath = path.join(root, "tasks-archive.json");
    const current2 = json(archivePath, { tasks: [] });
    const archive = Array.isArray(current2?.tasks) ? current2.tasks : [];
    const next = apply(archive);
    if (!next.archived && !next.stamped) return { archived: 0, stamped: 0 };
    const livePath = path.join(root, "tasks.json");
    const liveNow = readLedgerForWrite(livePath);
    if (next.archived) writeJson2(archivePath, { tasks: next.archive });
    writeLedger(livePath, liveNow, next.live);
    appendLog({ kind: "tasks-hygiene", archived: next.archived, stamped: next.stamped, live: live.length - next.archived });
    commit(`hive: archived ${next.archived} task(s), stamped ${next.stamped}`);
    return { archived: next.archived, stamped: next.stamped };
  };
  /** Append one dated block to `<root>/board-archive.md` (verbatim ~9095-9103).
   *  Append only: nothing ever rewrites it. */
  const appendBoardArchive = (entry) => {
    const root = hive.root();
    const p = path.join(root, "board-archive.md");
    if (!node_fs.existsSync(p)) {
      node_fs.writeFileSync(p, "# Board archive\n\n_Every full copy of board.md taken before it was condensed. Append only; the god condenses board.md, never this file._\n", "utf8");
    }
    node_fs.appendFileSync(p, entry, "utf8");
    return p;
  };
  /** The board latch, in `<root>/hygiene.json` (verbatim ~9107-9118): when the
   *  outstanding "condense the board" ask was sent, or null. On disk so a
   *  restart does not ask again while the same crossing is still open. */
  const hygieneState = () => {
    const root = hive.root();
    if (!root) return { boardAskedAt: null };
    const s = json(path.join(root, "hygiene.json"), {});
    return { boardAskedAt: typeof s?.boardAskedAt === "number" ? s.boardAskedAt : null };
  };
  const setHygieneState = (state) => {
    const root = hive.root();
    if (!root) return;
    writeJson2(path.join(root, "hygiene.json"), state);
    commit("hive: hygiene state");
  };
  const memory = (id) => {
    const p = path.join(hive.agentDir(id), "memory.md");
    return node_fs.existsSync(p) ? node_fs.readFileSync(p, "utf8") : "";
  };
  const hasMemory = (id) => {
    const p = path.join(hive.agentDir(id), "memory.md");
    if (!node_fs.existsSync(p)) return false;
    try {
      return node_fs.readFileSync(p, "utf8").trim().length > 200;
    } catch {
      return false;
    }
  };
  /** Verbatim writeFleetSnapshot (~9810): the live fleet.json the beat writes
   *  and god's roster context reads. Best-effort — called from a timer. */
  const writeFleetSnapshot = (snapshot) => {
    const r = hive.root();
    if (!r) return;
    try {
      node_fs.writeFileSync(path.join(r, "fleet.json"), JSON.stringify(snapshot, null, 2), "utf8");
    } catch {
    }
  };
  /**
   * Verbatim rosterContext (~9850): the one-line LIVE ROSTER pushed into god's
   * context on SessionStart/UserPromptSubmit so a resumed session cannot
   * message agents that no longer exist. `ctxOf` (optional, HookServer's
   * contextFor) layers live window occupancy as `ctx NN%`. */
  const rosterContext = (ctxOf) => {
    const r = hive.root();
    if (!r) return null;
    try {
      const raw = node_fs.readFileSync(path.join(r, "fleet.json"), "utf8");
      const snap = JSON.parse(raw);
      const agents = Array.isArray(snap.agents) ? snap.agents : [];
      if (!agents.length) return null;
      const ago = (s) => typeof s !== "number" ? "unknown" : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
      const MAX = 24;
      const shown = agents.slice(0, MAX);
      let anyCtx = false;
      let anyHold = false;
      const rows = shown.map((a) => {
        const bits = [
          a.role ?? "agent",
          typeof a.lastActiveSecAgo === "number" ? `active ${ago(a.lastActiveSecAgo)}` : "no activity yet"
        ];
        if (a.tokens) bits.push(`${Math.round(a.tokens / 1e3)}k tok`);
        if (a.usd) bits.push(`$${a.usd.toFixed(2)}`);
        if (a.inboxBacklog) bits.push(`inbox ${a.inboxBacklog}`);
        if (a.breaker && a.breaker !== "ok" && a.breaker !== "none") bits.push(`breaker ${a.breaker}`);
        if (a.isGod) bits.push("you");
        if (a.onHold) {
          bits.push("ON HOLD — 1:1 with the human");
          anyHold = true;
        }
        const cw = ctxOf?.(a.id);
        if (cw && cw.limit > 0) {
          const pct = Math.max(0, Math.min(100, Math.round(cw.tokens / cw.limit * 100)));
          bits.push(`ctx ${pct}%`);
          anyCtx = true;
        }
        return `${a.id}${a.name ? ` "${a.name}"` : ""} (${bits.join(", ")})`;
      });
      const more = agents.length > shown.length ? ` +${agents.length - shown.length} more` : "";
      const age = typeof snap.ts === "number" ? ago(Math.round((Date.now() - snap.ts) / 1e3)) : "unknown";
      return `[LIVE ROSTER — auto-injected from ${path.join(r, "fleet.json")}, snapshot ${age}] ${agents.length} ACTIVE agent(s): ${rows.join("; ")}.${more} This is the CURRENT floor and it SUPERSEDES any roster earlier in this conversation — agents you remember that are absent here have been archived or killed, so do not message them. ` + (anyCtx ? "`ctx NN%` = live window occupancy; absent = not yet reported (unknown, not empty). " : "") + (anyHold ? "An agent marked `ON HOLD — 1:1 with the human` is UNAVAILABLE: the human is working with them directly. Do NOT message them, do NOT dispatch to them, and do NOT count them when picking an owner. Route to someone else, or say the work is waiting. They are still running and their terminal is alive, so this is not a reason to archive them or spawn a replacement. The human flips it off when they are done. " : "") + "Route work to someone on this list before spawning anyone new." + (hive.remote?.rosterLine?.() ? ` ${hive.remote.rosterLine()}` : "");
    } catch {
      return null;
    }
  };
  const mirrorFleet = (id, patch) => {
    const fleetPath = path.join(root(), "fleet.json");
    if (!node_fs.existsSync(fleetPath)) return;
    try {
      const fleet = json(fleetPath, {});
      if (Array.isArray(fleet.agents)) {
        const row = fleet.agents.find((candidate) => candidate.id === id);
        if (row) {
          Object.assign(row, patch);
          writeJson2(fleetPath, fleet);
        }
      }
    } catch {
    }
  };
  const patchAgentRole = (id, role) => {
    if (!root()) return { ok: false, error: "hive disabled" };
    const next = typeof role === "string" ? role.trim() : "";
    if (!next) return { ok: false, error: "empty role" };
    try {
      const reg = hive.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: "unknown agent" };
      if (agent.role === next) return { ok: true };
      agent.role = next;
      writeJson2(path.join(root(), "registry.json"), reg);
      mirrorFleet(id, { role: next });
      appendLog({ kind: "role", agentId: id, role: next });
      commit(`hive: role ${id}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const setArchived = (id, archived) => {
    if (!root()) return;
    const reg = hive.registry();
    const agent = reg.agents[id];
    if (!agent || agent.archived === archived) return;
    agent.archived = archived;
    writeJson2(path.join(root(), "registry.json"), reg);
    appendLog({ kind: "archive", agentId: id, archived });
    commit(archived ? `hive: archive ${id}` : `hive: unarchive ${id}`);
  };
  const setAgentHold = (id, hold) => {
    if (!root()) return { ok: false, error: "hive disabled (no harnessHome)" };
    try {
      const reg = hive.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: "Agent not found" };
      if (!!agent.onHold === hold) return { ok: true, onHold: hold };
      agent.onHold = hold;
      writeJson2(path.join(root(), "registry.json"), reg);
      emit("hive:agentHold", { agentId: id, onHold: hold });
      mirrorFleet(id, { onHold: hold });
      appendLog({ kind: "agent-hold", id, onHold: hold });
      return { ok: true, onHold: hold };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
  const renameAgent = (id, name) => {
    if (!root()) return { ok: false, error: "hive disabled (no harnessHome)" };
    const nextName = name.trim();
    if (!nextName) return { ok: false, error: "Name is required" };
    try {
      const reg = hive.registry();
      const agent = reg.agents[id];
      if (!agent) return { ok: false, error: "Agent not found" };
      if (agent.name === nextName) return { ok: true, name: nextName };
      const previousName = agent.name;
      agent.name = nextName;
      writeJson2(path.join(root(), "registry.json"), reg);
      mirrorFleet(id, { name: nextName });
      appendLog({ kind: "rename", agentId: id, previousName, name: nextName });
      commit(`hive: rename ${id}`);
      return { ok: true, name: nextName };
    } catch {
      return { ok: false, error: "Could not rename agent" };
    }
  };
  const addTask = (task) => {
    const ledger = hive.tasks();
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    if (task.id && resolveTask(tasks, task.id)) return false;
    writeTasks([...tasks, task]);
    return true;
  };
  const patchTask = (id, patch) => {
    const ledger = hive.tasks();
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const hit = resolveTask(tasks, id);
    const index = hit ? tasks.indexOf(hit) : -1;
    if (index < 0) return false;
    const next = tasks.slice();
    next[index] = { ...tasks[index], ...patch, id: tasks[index].id };
    writeTasks(next);
    return true;
  };
  const patchTasks = (patches) => {
    const ledger = hive.tasks();
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const keyOf = /* @__PURE__ */ new Map();
    const keyed = patches.map(({ id, patch }) => {
      const key = resolveTask(tasks, id)?.id ?? id;
      if (!keyOf.has(key)) keyOf.set(key, id);
      return { id: key, patch };
    });
    const { next, applied } = applyTaskPatches(tasks, keyed);
    if (applied.length) writeTasks(next);
    return applied.map((key) => keyOf.get(key) ?? key);
  };
  const deleteTask = (id) => {
    const ledger = hive.tasks();
    const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
    const hit = resolveTask(tasks, id);
    const next = tasks.filter((task) => task !== hit);
    if (!hit || next.length === tasks.length) return false;
    writeTasks(next);
    return true;
  };
  const send = (partial, from = "system") => {
    const msg = hive.normalize(partial, from);
    hive.routeMessage(msg);
    commit(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  };
  // Verbatim keyAgentTasks (ref ~7297-7338): every routeOnce watches tasks.json's
  // mtime and, on change, assigns ticket keys + stamps create/start/done times.
  // The state lives on the hive instance (tasksSeen / tasksSeenMtime).
  const keyAgentTasks = () => {
    const r = hive.root();
    if (!r) return 0;
    const file = path.join(r, "tasks.json");
    let mtime = 0;
    try { mtime = node_fs.statSync(file).mtimeMs; } catch { return 0; }
    if (mtime === hive.tasksSeenMtime) return 0;
    let current2;
    try { current2 = JSON.parse(node_fs.readFileSync(file, "utf8")); } catch { return 0; }
    const cards = current2 && typeof current2 === "object" && Array.isArray(current2.tasks) ? current2.tasks : null;
    if (!cards) { hive.tasksSeenMtime = mtime; return 0; }
    const keyed = assignTicketKeys(cards, ticketMeta(current2), archivedTasks());
    const hasMeta = !!current2.ticket;
    const stamped = hive.tasksSeen ? stampTaskTimes(hive.tasksSeen, keyed.tasks, (/* @__PURE__ */ new Date()).toISOString()) : { tasks: keyed.tasks, changed: false };
    hive.tasksSeen = stamped.tasks;
    if (!keyed.changed && !stamped.changed && hasMeta) { hive.tasksSeenMtime = mtime; return 0; }
    const before = cards.filter((c, i) => c !== keyed.tasks[i]).length;
    writeJson2(file, { ...current2, tasks: stamped.tasks, ticket: keyed.meta });
    try { hive.tasksSeenMtime = node_fs.statSync(file).mtimeMs; } catch {}
    if (before) {
      appendLog({ kind: "tasks-keyed", count: before });
      commit(`hive: keyed ${before} task(s)`);
    }
    return before;
  };

  Object.assign(hive, {
    __ipcVerbatim: true,
    appendLog, ticketMeta, archivedTasks, writeLedger,
    readLedgerForWrite, writeTasks, inboxPath, tasksArchive, memory, hasMemory,
    writeFleetSnapshot, rosterContext,
    applyTaskHygiene, appendBoardArchive, hygieneState, setHygieneState,
    patchAgentRole, setArchived, setAgentHold, renameAgent,
    addTask, patchTask, patchTasks, deleteTask, send, keyAgentTasks,
  });
  return hive;
}

/** Verbatim-shaped memory surface over the clone's MemoryManager + mempalace CLI. */
function installMemoryVerbatim(mem) {
  if (!mem || mem.__ipcVerbatim) return mem;
  const { spawn } = require('node:child_process');
  const runCli = (args, label) => new Promise((settle) => {
    const bin = mem.palaceBin?.() ?? null;
    if (!bin) return settle({ ok: false, output: "", error: "mempalace not found" });
    const env = { ...process.env, MEMPALACE_PALACE_PATH: mem.palacePath() ?? "" };
    let out = "";
    let proc;
    try {
      proc = spawn(bin, args, { env });
    } catch (e) {
      return settle({ ok: false, output: "", error: e instanceof Error ? e.message : String(e) });
    }
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      settle({ ok: false, output: out, error: `${label} timed out` });
    }, 120_000);
    proc.stdout?.on("data", (d) => { out += d.toString("utf8"); });
    proc.stderr?.on("data", (d) => { out += d.toString("utf8"); });
    proc.on("error", (e) => {
      clearTimeout(timer);
      settle({ ok: false, output: "", error: e.message });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) settle({ ok: false, output: out, error: (out || `${label} failed`).trim() });
      else settle({ ok: true, output: out });
    });
  });
  const status = () => {
    const bin = mem.palaceBin?.() ?? null;
    const palace = mem.palacePath?.() ?? null;
    return {
      available: bin !== null,
      enabled: true,
      active: bin !== null && palace !== null,
      initialized: !!palace && node_fs.existsSync(palace),
      palacePath: palace,
      model: "minilm",
      bin
    };
  };
  Object.assign(mem, {
    __ipcVerbatim: true,
    status,
    statusWithBin: (bin) => ({ ...status(), available: bin !== null, bin }),
    refresh: () => {
      try { mem.startMining?.(); } catch {}
      return status();
    },
    search: (query, opts = {}) => {
      const args = ["search", query, "--results", String(opts.results ?? 8)];
      if (opts.wing) args.push("--wing", opts.wing);
      return runCli(args, "search");
    },
    wakeUp: (wing) => {
      const args = ["wake-up"];
      if (wing) args.push("--wing", wing);
      return runCli(args, "wake-up");
    },
  });
  return mem;
}

function register(ctx) {
  const hive = installHiveVerbatim(ctx.harness?.hive, () => ctx.readConfig?.().harnessHome ?? ctx.ozycompHome?.() ?? null);
  const memory = installMemoryVerbatim(ctx.harness?.memory);
  const telemetry = ctx.harness?.telemetry;
  const breaker = ctx.harness?.breaker;
  const hookServer = ctx.harness?.hooks;

  // liveWebContents() — verbatim: main window first, else any live window.
  const liveWebContents = () => {
    const wc = ctx.win()?.webContents;
    if (wc && !wc.isDestroyed()) return wc;
    for (const w of ctx.BrowserWindow?.getAllWindows?.() ?? []) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
    }
    return null;
  };

  // The reference `activity`/`restoreGate`/`analytics` globals — stash on ctx.
  const activity = ctx.activity ??= ctx.harness?.activity ?? new ActivityDigest(() => liveWebContents());
  if (ctx.harness && !ctx.harness.activity) ctx.harness.activity = activity;
  const restoreGate = ctx.restoreGate ??= ctx.harness?.restoreGate ?? new RestoreGateStore(() => ctx.readConfig?.().harnessHome ?? hive?.root?.() ?? null);
  const analytics = ctx.analytics ??= { trackMessageSent: () => {} };
  // launchEnvReady(): the reference waits for the login-shell PATH probe then
  // re-resolves launchers. The clone resolves lazily — a no-op seam here.
  const launchEnvReady = ctx.launchEnvReady ??= async () => {};

  // ── verbatim handlers: reference lines 35409-35429 ──
  ctx.ipcMain.handle("hive:registry", () => hive.registry());
  ctx.ipcMain.handle("hive:renameAgent", (_evt, id, name) => {
    if (typeof id !== "string" || typeof name !== "string") {
      return { ok: false, error: "Invalid rename request" };
    }
    return hive.renameAgent(id, name);
  });
  ctx.ipcMain.handle("hive:setAgentHold", (_evt, id, hold) => {
    if (typeof id !== "string" || typeof hold !== "boolean") {
      return { ok: false, error: "Invalid hold request" };
    }
    return hive.setAgentHold(id, hold);
  });
  ctx.ipcMain.handle("hive:humanMailSince", (_evt, since) => {
    const map = {};
    if (since && typeof since === "object") {
      for (const [k, v] of Object.entries(since)) if (typeof v === "string") map[k] = v;
    }
    return hive.humanMailSinceAsync(map);
  });
  ctx.ipcMain.handle("hive:board", () => hive.board());

  // ── verbatim handlers: reference lines 35858-35940 ──
  ctx.ipcMain.handle("hive:tasks", () => hive.tasks());
  ctx.ipcMain.handle("hive:ticketPrefix", () => hive.ticketMeta(hive.tasks()).prefix);
  ctx.ipcMain.handle("hive:tasksArchive", () => hive.tasksArchive());
  ctx.ipcMain.handle("hive:log", (_evt, n) => hive.logTail(typeof n === "number" ? n : 200));
  ctx.ipcMain.handle("hive:memory", (_evt, id) => typeof id === "string" ? hive.memory(id) : "");
  ctx.ipcMain.handle("hive:inbox", (_evt, id) => typeof id === "string" ? hive.inbox(id) : []);
  ctx.ipcMain.handle("hive:inboxPath", (_evt, id) => typeof id === "string" ? hive.inboxPath(id) : null);
  ctx.ipcMain.handle(
    "hive:messages",
    (_evt, opts) => hive.voiceMessagesAsync(opts && typeof opts === "object" ? opts : {})
  );
  ctx.ipcMain.handle("hive:agentActivity", (_evt, agentId, limit) => {
    if (typeof agentId !== "string" || !agentId.trim()) return [];
    const n = typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : ACTIVITY_RING;
    return activity.list(agentId, n);
  });
  ctx.ipcMain.handle("hive:send", (_evt, partial, from) => {
    if (!hive.enabled()) return { ok: false, error: "hive disabled (no harnessHome)" };
    const sender = typeof from === "string" ? from : "system";
    const msg = hive.send(partial ?? {}, sender);
    if (sender === "human") analytics.trackMessageSent("hive");
    return { ok: true, message: msg };
  });
  ctx.ipcMain.handle("hive:addTask", (_evt, task) => {
    if (!task || typeof task !== "object" || Array.isArray(task) || typeof task.id !== "string") {
      return { ok: false, error: "invalid task" };
    }
    if (!hive.enabled()) return { ok: false, error: "hive disabled (no harnessHome)" };
    try {
      return { ok: hive.addTask(task) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ctx.ipcMain.handle("hive:patchTask", (_evt, id, patch) => {
    if (typeof id !== "string" || !id || !patch || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: false, error: "invalid task patch" };
    }
    if (!hive.enabled()) return { ok: false, error: "hive disabled (no harnessHome)" };
    try {
      return { ok: hive.patchTask(id, patch) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ctx.ipcMain.handle("hive:patchTasks", (_evt, patches) => {
    if (!Array.isArray(patches)) return { ok: false, applied: [], error: "invalid task patches" };
    if (!hive.enabled()) return { ok: false, applied: [], error: "hive disabled (no harnessHome)" };
    const valid2 = patches.filter((p) => !!p && typeof p === "object" && typeof p.id === "string" && !!p.id && !!p.patch && typeof p.patch === "object" && !Array.isArray(p.patch));
    try {
      return { ok: true, applied: hive.patchTasks(valid2) };
    } catch (err) {
      return { ok: false, applied: [], error: err instanceof Error ? err.message : String(err) };
    }
  });
  ctx.ipcMain.handle("hive:deleteTask", (_evt, id) => {
    if (typeof id !== "string" || !id) return { ok: false, error: "invalid task id" };
    if (!hive.enabled()) return { ok: false, error: "hive disabled (no harnessHome)" };
    try {
      return { ok: hive.deleteTask(id) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ctx.ipcMain.handle("hive:archivedAtBoot", () => {
    try {
      return restoreGate.snapshot();
    } catch {
      return [];
    }
  });
  ctx.ipcMain.handle("hive:setArchived", (_evt, id, archived) => {
    if (typeof id !== "string") return { ok: false, error: "invalid id" };
    if (!hive.enabled()) return { ok: false, error: "hive disabled (no harnessHome)" };
    hive.setArchived(id, archived === true);
    return { ok: true };
  });
  ctx.ipcMain.handle("hive:patchAgentRole", (_evt, id, role) => {
    if (typeof id !== "string") return { ok: false, error: "invalid id" };
    if (typeof role !== "string") return { ok: false, error: "invalid role" };
    if (!hive.enabled()) return { ok: false, error: "hive disabled (no harnessHome)" };
    return hive.patchAgentRole(id, role);
  });

  // ── verbatim handlers: reference lines 36017-36029 (mempalace) ──
  ctx.ipcMain.handle("hive:memoryStatus", async () => {
    await launchEnvReady();
    return memory.refresh();
  });
  ctx.ipcMain.handle("hive:searchMemory", (_evt, query, wing) => {
    if (typeof query !== "string" || !query.trim()) return { ok: false, output: "", error: "empty query" };
    return memory.search(query, { wing: typeof wing === "string" ? wing : void 0 });
  });
  ctx.ipcMain.handle("hive:memoryWakeUp", (_evt, wing) => memory.wakeUp(typeof wing === "string" ? wing : void 0));
  ctx.ipcMain.handle("hive:mineNow", () => {
    memory.mineNow();
    return { ok: true };
  });

  // ── verbatim handlers: reference lines 36346-36390 ──
  ctx.ipcMain.handle("hive:agentUsage", (_evt, cwd) => typeof cwd === "string" ? readAgentUsageSettled(cwd) : null);
  ctx.ipcMain.handle("hive:agentContext", (_evt, agentId) => {
    if (typeof agentId !== "string") return null;
    const tp = hookServer.transcriptPath(agentId);
    if (!tp) return null;
    return readContextTokens(tp) ?? 0;
  });
  ctx.ipcMain.handle("hive:agentDirectory", () => {
    if (!hive.enabled()) return { godId: null, agents: [] };
    const reg = hive.registry();
    const snap = telemetry.snapshot();
    const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
    const now = Date.now();
    const agents = Object.entries(reg.agents).map(([id, a]) => {
      const u = usageById.get(id);
      const spans = snap.spans[id] ?? [];
      const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
      const ctx2 = hookServer.contextFor(id);
      return {
        id,
        name: a.name,
        role: a.role ?? (a.isGod ? "orchestrator" : "agent"),
        provider: a.provider ?? "claude",
        model: u?.model ?? null,
        status: a.status ?? "idle",
        cwd: a.cwd ?? null,
        cwdValid: a.cwdValid ?? null,
        archived: !!a.archived,
        isGod: !!a.isGod,
        isAssistant: !!a.isAssistant,
        sessionId: a.sessionId ?? null,
        hasMemory: hive.hasMemory(id),
        inboxBacklog: hive.inboxBacklog(id),
        breaker: breaker.levelFor(id),
        tokens,
        usd: u ? Number(u.usd.toFixed(4)) : 0,
        lastTool: spans.length ? spans[spans.length - 1].tool : null,
        lastActiveSecAgo: u ? Math.round((now - u.ts) / 1e3) : null,
        contextTokens: ctx2?.tokens ?? null,
        contextLimit: ctx2?.limit ?? null,
        contextPct: ctx2 && ctx2.limit > 0 ? Math.round(ctx2.tokens / ctx2.limit * 100) : null
      };
    });
    return { godId: reg.godId, agents };
  });

  // ── verbatim handler: reference lines 36456-36490 ──
  ctx.ipcMain.handle("hive:textSearch", (_evt, query) => {
    if (typeof query !== "string" || !query.trim()) return { ok: false, results: [] };
    const root = hive.root();
    if (!root) return { ok: false, results: [] };
    const q = query.trim().toLowerCase();
    const keywords = keywordsOf(q);
    const threshold = keywordThreshold(keywords);
    const scored = [];
    const targets = [
      { path: path.join(root, "board.md"), source: "board.md" },
      { path: path.join(root, "tasks.json"), source: "tasks.json" }
    ];
    const agentsDir = path.join(root, "agents");
    if (node_fs.existsSync(agentsDir)) {
      for (const id of node_fs.readdirSync(agentsDir)) {
        targets.push({ path: path.join(agentsDir, id, "memory.md"), source: `${id}/memory.md` });
      }
    }
    for (const { path: path2, source } of targets) {
      if (!node_fs.existsSync(path2)) continue;
      const mine = [];
      for (const line of node_fs.readFileSync(path2, "utf8").split("\n")) {
        const lower = line.toLowerCase();
        const phrase = lower.includes(q);
        const score = phrase ? keywords.length + 1 : keywords.length ? scoreLine(lower, keywords) : 0;
        if (phrase ? false : keywords.length ? score < threshold : true) continue;
        mine.push({ source, excerpt: excerptAround(line, keywords.length ? keywords : [q]), score });
      }
      mine.sort((a, b) => b.score - a.score);
      scored.push(...mine.slice(0, 3));
    }
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, 14).map(({ source, excerpt }) => ({ source, excerpt }));
    return { ok: true, results };
  });

  // ── verbatim handlers: github:issues / github:ciRuns (reference ~15162-15235, ~36491-36498) ──
  // Both shell out to the `gh` CLI inside the agent's cwd; a missing gh binary
  // resolves {ok:false} rather than throwing, same as reference.
  ctx.ipcMain.handle("github:issues", (_evt, cwd) => typeof cwd === "string" ? listIssues(cwd) : { ok: false, error: "no cwd" });
  ctx.ipcMain.handle("github:ciRuns", (_evt, cwd) => typeof cwd === "string" ? listCIRuns(cwd) : { ok: false, error: "no cwd" });
}

// ── verbatim helpers: listIssues / listCIRuns (reference 15162-15235) ────────
function listIssues(cwd) {
  return new Promise((resolve) => {
    const proc = node_child_process.spawn(
      "gh",
      ["issue", "list", "--json", "number,title,body,assignees,labels,url,state", "--limit", "30"],
      { cwd }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (e) => resolve({ ok: false, error: e.message }));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `gh exited ${code}` });
        return;
      }
      try {
        const raw = JSON.parse(stdout);
        const issues = (Array.isArray(raw) ? raw : []).map((i) => ({
          number: i.number ?? 0,
          title: i.title ?? "",
          body: i.body ?? "",
          url: i.url ?? "",
          labels: (i.labels ?? []).map((l) => l.name ?? "").filter(Boolean),
          assignees: (i.assignees ?? []).map((a) => a.login ?? "").filter(Boolean)
        }));
        resolve({ ok: true, issues });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}
function listCIRuns(cwd) {
  return new Promise((resolve) => {
    const proc = node_child_process.spawn(
      "gh",
      ["run", "list", "--limit", "5", "--json", "name,status,conclusion,url,databaseId"],
      { cwd }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (e) => resolve({ ok: false, error: e.message }));
    proc.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `gh exited ${code}` });
        return;
      }
      try {
        const raw = JSON.parse(stdout);
        const runs = (Array.isArray(raw) ? raw : []).map((r) => ({
          name: r.name ?? "",
          status: r.status ?? "",
          conclusion: r.conclusion ?? null,
          url: r.url ?? ""
        }));
        resolve({ ok: true, runs });
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
  });
}

module.exports = { register, readAgentUsage, readAgentUsageSettled, installHiveVerbatim, installMemoryVerbatim };
