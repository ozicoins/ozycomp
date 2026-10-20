'use strict';
/**
 * Session resume + restore gate — verbatim port of the reference pieces:
 *
 *   • pushSessionHistory / pickResumableSession — an agent keeps a capped
 *     history of the session_ids it has owned; a restart tries the current
 *     key first, then the keys it displaced.
 *   • providerSessionStore + storeCanCheck + storeHasSession + chooseResumeSession
 *     — where each provider keeps its on-disk sessions, so a `--resume <id>`
 *     is only attempted when the transcript actually exists.
 *   • RestoreGateStore — <hive>/restore-gate.json: the set of agent ids whose
 *     terminal ended. snapshot() is captured once at boot so a teardown later
 *     in THIS session can never retire an agent at a restore that has not
 *     happened yet.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SESSION_HISTORY_CAP = 8;
function pushSessionHistory(history, sessionId) {
  const prior = history ?? [];
  if (!sessionId) return [...prior];
  return [sessionId, ...prior.filter((s) => s !== sessionId)].slice(0, SESSION_HISTORY_CAP);
}
function pickResumableSession(candidates, exists) {
  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (exists(c)) return c;
  }
  return void 0;
}

// ─── per-provider on-disk session stores ─────────────────────────────────────

const set$1 = (v) => typeof v === "string" && v.trim().length > 0;
const joinPath = (...p) => path.join(...p);

/**
 * Where `provider` keeps its sessions on disk. Returns
 * {root, segments, match(entry, sid)} or null when the provider either has no
 * resumable store or its config redirects sessions somewhere we cannot predict
 * (a custom runtimeOutputDir / sessionDir / config dir overrides the layout —
 * resume guesses are worse than a cold start).
 */
function providerSessionStore(provider, ctx) {
  const { env, home } = ctx;
  switch (provider) {
    case "kimi": {
      const root = set$1(env.KIMI_CODE_HOME) ? env.KIMI_CODE_HOME : joinPath(home, ".kimi-code");
      return { root, segments: ["sessions", "*"], match: (e, sid) => e === `session_${sid}` };
    }
    case "grok": {
      const root = set$1(env.GROK_HOME) ? env.GROK_HOME : joinPath(home, ".grok");
      return { root, segments: ["sessions", "*"], match: (e, sid) => e === sid };
    }
    case "qwen": {
      const configDir = set$1(env.QWEN_HOME) ? env.QWEN_HOME : joinPath(home, ".qwen");
      if (!set$1(env.QWEN_RUNTIME_DIR)) {
        const settings = [joinPath(configDir, "settings.json"), ctx.cwd ? joinPath(joinPath(ctx.cwd, ".qwen"), "settings.json") : ""];
        if (settings.some((f) => f && (ctx.readText(f) ?? "").includes("runtimeOutputDir"))) return null;
      }
      const root = set$1(env.QWEN_RUNTIME_DIR) ? env.QWEN_RUNTIME_DIR : configDir;
      return { root, segments: ["projects", "*", "chats"], match: (e, sid) => e.startsWith(sid) };
    }
    case "pi": {
      if (set$1(env.PI_CODING_AGENT_SESSION_DIR)) {
        return { root: env.PI_CODING_AGENT_SESSION_DIR, segments: [], match: (e, sid) => e.includes(sid) };
      }
      const agentDir = set$1(env.PI_CODING_AGENT_DIR) ? env.PI_CODING_AGENT_DIR : joinPath(joinPath(home, ".pi"), "agent");
      if ((ctx.readText(joinPath(agentDir, "settings.json")) ?? "").includes("sessionDir")) return null;
      return { root: agentDir, segments: ["sessions", "*"], match: (e, sid) => e.includes(sid) };
    }
    case "cursor": {
      if (set$1(env.CURSOR_CONFIG_DIR) || set$1(env.CURSOR_DATA_DIR) || set$1(env.XDG_CONFIG_HOME)) return null;
      return { root: joinPath(home, ".cursor"), segments: ["chats", "*"], match: (e, sid) => e === sid };
    }
    default:
      return null;
  }
}
function storeCanCheck(spec, list) {
  let dir = spec.root;
  for (const seg of spec.segments) {
    if (seg === "*") break;
    dir = joinPath(dir, seg);
  }
  return list(dir) !== null;
}
function storeHasSession(spec, sid, list) {
  let dirs = [spec.root];
  for (const seg of spec.segments) {
    dirs = seg === "*" ? dirs.flatMap((d) => (list(d) ?? []).map((e) => joinPath(d, e))) : dirs.map((d) => joinPath(d, seg));
  }
  return dirs.some((d) => (list(d) ?? []).some((e) => spec.match(e, sid)));
}
function chooseResumeSession(candidates, spec, list) {
  const first = candidates.find((c) => !!c);
  if (!spec || !storeCanCheck(spec, list)) return { sid: first, checked: false };
  for (const c of candidates) {
    if (c && storeHasSession(spec, c, list)) return { sid: c, checked: true };
  }
  return { sid: void 0, checked: true };
}
/** The default `list` over the real filesystem — null means "can't read it". */
function listDir(dir) {
  try { return fs.readdirSync(dir); } catch { return null; }
}
function sessionStoreCtx({ env = process.env, home = os.homedir(), cwd } = {}) {
  return {
    env, home, cwd,
    readText: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
  };
}

// ─── restore gate ────────────────────────────────────────────────────────────

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
    if (!p || !fs.existsSync(p)) return emptyFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
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
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const ended = [...ids].slice(-MAX_HELD);
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, ended }), "utf8");
      fs.renameSync(tmp, p);
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

module.exports = {
  SESSION_HISTORY_CAP, pushSessionHistory, pickResumableSession,
  providerSessionStore, storeCanCheck, storeHasSession, chooseResumeSession,
  listDir, sessionStoreCtx,
  RESTORE_GATE_FILE, MAX_HELD, RestoreGateStore,
};
