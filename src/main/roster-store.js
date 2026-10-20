'use strict';
/**
 * Roster persistence + retention helpers — verbatim port of the reference.
 * RosterStore keeps the floor roster at <hive>/roster.json with a backup on
 * every write (empty-first-write guard, per-day backup retention via
 * reapRosterBackups). The retention planners/reapers themselves moved to
 * retention.js where the verbatim file keeps them (CostCarryFold, trimLedger,
 * runRetention, task hygiene) — they are re-exported from here so existing
 * require('./roster-store') callers keep working. CodexUsageScheduler debounces
 * transcript reads; readCodexUsage tails a codex rollout .jsonl for the last
 * token_count event.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  FRESH_FLOOR_MS, RETENTION_POLICIES, COMMAND_HISTORY_LIMIT,
  planTrim, dayKey, planReap,
  ROSTER_BACKUP, MESSAGE_FILE, SPAWN_FILE, MEMORY_BACKUP_STAMP, AGENT_DIR,
  NOTHING, withinRoot, isPlainDir, plainFileStat, dirSize,
  reapFiles, reapDirs, reapRosterBackups,
} = require('./retention');

const PRUNE_EVERY = 25;
function rosterPath(home) {
  return path.join(home, "roster.json");
}
function rosterBackupDir(home) {
  return path.join(home, "roster-backups");
}
function isSnapshot(v) {
  if (!v || typeof v !== "object") return false;
  const s = v;
  return Array.isArray(s.agents) && Array.isArray(s.archived) && Array.isArray(s.restorable);
}
function entryCount(s) {
  return s.agents.length + s.archived.length + s.restorable.length;
}
class RosterStore {
  constructor(getHome) {
    this.getHome = getHome;
  }
  /** Set once this store has written successfully. The empty-guard applies only
   *  before that: see `write`. */
  wrote = false;
  /** Disambiguates backups made inside the same millisecond. Two writes in one
   *  tick used to produce the same filename, and the second silently replaced
   *  the first — a backup folder that quietly loses backups is worse than none. */
  backupSeq = 0;
  /** Backups written since the last prune. See `backup`. */
  sinceReap = 0;
  home() {
    try {
      return this.getHome();
    } catch {
      return null;
    }
  }
  /** The stored roster, or null when there isn't one (or it can't be parsed).
   *  Null means "no opinion" — the renderer then keeps using localStorage, so a
   *  corrupt file degrades to the old behaviour instead of to an empty floor. */
  read() {
    const home = this.home();
    if (!home) return null;
    try {
      const p = rosterPath(home);
      if (!fs.existsSync(p)) return null;
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      return isSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  /**
   * Write the roster, keeping the previous contents as a backup.
   *
   * THE EMPTY-GUARD. The dangerous sequence is: open the packaged build for the
   * first time, its localStorage is empty (different origin), the store boots
   * with zero agents, and the first mirror write flattens a file that holds a
   * real roster. So an empty write is refused until this run has landed a
   * NON-empty write — only then has the renderer proven it actually holds a
   * roster, and a later empty write means the user really removed their agents
   * (refusing those would make deletion impossible). The guard must survive a
   * refusal: a renderer reload used to re-send the same empty snapshot, and
   * because the first refusal disarmed the guard, the second empty write went
   * through and flattened the file (seen live 2026-08-16 20:40:03). The previous
   * file is backed up either way, so even a wrong call here is recoverable.
   */
  write(snap) {
    const home = this.home();
    if (!home) return { ok: false, error: "no harnessHome" };
    if (!isSnapshot(snap)) return { ok: false, error: "invalid snapshot" };
    const p = rosterPath(home);
    try {
      fs.mkdirSync(home, { recursive: true });
      const existing = this.read();
      if (!this.wrote && existing && entryCount(existing) > 0 && entryCount(snap) === 0) {
        this.backup(home, p, "declined");
        console.warn("[roster] refused to overwrite a non-empty roster with an empty one");
        return { ok: false, skipped: "empty-first-write" };
      }
      this.backup(home, p, this.wrote ? "write" : "run-start");
      const body = {
        version: 1,
        savedAt: (/* @__PURE__ */ new Date()).toISOString(),
        agents: snap.agents,
        archived: snap.archived,
        restorable: snap.restorable,
        queues: snap.queues && typeof snap.queues === "object" ? snap.queues : {},
        selectedId: typeof snap.selectedId === "string" ? snap.selectedId : null
      };
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
      fs.renameSync(tmp, p);
      this.wrote = true;
      return { ok: true };
    } catch (e) {
      try {
        fs.rmSync(`${p}.tmp`, { force: true });
      } catch {
      }
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  /**
   * Retire the active roster during a full reset: copied into `roster-backups/`
   * first, then the live file is removed.
   *
   * Reset wipes the hive, and the roster must not be left behind as the one
   * survivor — pointing the home folder back here afterwards would show a floor
   * full of agents whose sessions, memory and inboxes no longer exist. Archived
   * rather than deleted, because a roster is never destroyed, only superseded.
   */
  archive() {
    const home = this.home();
    if (!home) return;
    const p = rosterPath(home);
    try {
      if (!fs.existsSync(p)) return;
      this.backup(home, p, "reset");
      fs.rmSync(p, { force: true });
    } catch {
    }
  }
  /**
   * Copy the current roster into the backup folder, then keep the folder inside
   * its cap.
   *
   * The backup on every write is right and it stays. What was wrong was the
   * folder: the last line of defence does not need three thousand copies of the
   * same roster, and nothing else ever removed them. `reapRosterBackups` keeps
   * the newest 50 plus one per day for a month, which covers both recoveries
   * that actually happen: the bad write noticed in the next minute, and the
   * agent noticed missing some day last week.
   *
   * Pruned on a counter rather than on every write because the reap reads the
   * whole directory, and this runs on every note and every queue move. The
   * hourly sweep in main/retention.ts catches an app that writes fewer than
   * PRUNE_EVERY backups in a run.
   */
  backup(home, p, reason) {
    try {
      if (!fs.existsSync(p)) return;
      const dir = rosterBackupDir(home);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      this.backupSeq += 1;
      fs.copyFileSync(p, path.join(dir, `roster-${stamp}-${this.backupSeq}-${reason}.json`));
    } catch {
    }
    this.sinceReap += 1;
    if (this.sinceReap >= PRUNE_EVERY) {
      this.sinceReap = 0;
      try {
        reapRosterBackups(home);
      } catch {
      }
    }
  }
}

/** The standing goal a roster entry carries for `agentId`, or null. Read at
 *  steer time so a goal set in the renderer survives restarts. */
function standingGoalFromRoster(roster, agentId) {
  const snap = roster.read();
  if (!snap || !Array.isArray(snap.agents)) return null;
  for (const entry of snap.agents) {
    if (!entry || typeof entry !== "object") continue;
    const a = entry;
    if (a.id !== agentId) continue;
    return typeof a.goal === "string" && a.goal.trim() ? a.goal.trim() : null;
  }
  return null;
}

// ─── codex usage tail reader + scheduler (verbatim) ─────────────────────────
const MAX_TAIL_BYTES = 1024 * 1024;
const READ_BLOCK_BYTES = 64 * 1024;
function tokenCount(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
function parseCodexUsageTail(text) {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const event = row;
    if (event.type !== "event_msg" || !event.payload || typeof event.payload !== "object") continue;
    const payload = event.payload;
    if (payload.type !== "token_count" || !payload.info || typeof payload.info !== "object") continue;
    const usage = payload.info.total_token_usage;
    if (!usage || typeof usage !== "object") continue;
    const totals = usage;
    const inputTokens = totals.input_tokens;
    const cachedTokens = totals.cached_input_tokens;
    const outputTokens = totals.output_tokens;
    const cacheWriteTokens = totals.cache_write_input_tokens ?? 0;
    const ts = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
    if (!tokenCount(inputTokens) || !tokenCount(cachedTokens) || !tokenCount(outputTokens) || !tokenCount(cacheWriteTokens) || cachedTokens > inputTokens || !Number.isFinite(ts)) continue;
    return {
      input: inputTokens - cachedTokens,
      output: outputTokens,
      cacheRead: cachedTokens,
      cacheCreation: cacheWriteTokens,
      ts
    };
  }
  return null;
}
function isWithin(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
async function readCodexUsage(path$1, agentCodexHome) {
  try {
    const resolvedPath = await fs.promises.realpath(path$1);
    if (path.extname(resolvedPath).toLowerCase() !== ".jsonl") return null;
    if (!agentCodexHome) return null;
    const resolvedRoot = await fs.promises.realpath(path.join(agentCodexHome, "sessions"));
    if (!isWithin(resolvedRoot, resolvedPath)) return null;
    const file = await fs.promises.open(resolvedPath, "r");
    try {
      const size = (await file.stat()).size;
      const firstByte = Math.max(0, size - MAX_TAIL_BYTES);
      let position = size;
      let tail = Buffer.alloc(0);
      while (position > firstByte) {
        const length = Math.min(READ_BLOCK_BYTES, position - firstByte);
        position -= length;
        const block = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(block, 0, length, position);
        if (!bytesRead) break;
        tail = Buffer.concat([block.subarray(0, bytesRead), tail]);
        const text = tail.toString("utf8");
        const firstNewline = text.indexOf("\n");
        const completeTail = position === 0 ? text : firstNewline === -1 ? "" : text.slice(firstNewline + 1);
        const usage = parseCodexUsageTail(completeTail);
        if (usage) return usage;
      }
      return null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
class CodexUsageScheduler {
  constructor(deps) {
    this.deps = deps;
  }
  pending = new Map();
  epochs = new Map();
  schedule(agentId, transcriptPath, sessionId, model) {
    if (!agentId || path.basename(agentId) !== agentId || agentId === "." || agentId === "..") return;
    if (!/^rollout-.*\.jsonl$/i.test(path.basename(transcriptPath))) return;
    const previous = this.pending.get(agentId);
    if (previous) clearTimeout(previous.timer);
    const revision = (previous?.revision ?? 0) + 1;
    const timer = setTimeout(() => {
      void (async () => {
        if (this.pending.get(agentId)?.revision !== revision) return;
        this.pending.delete(agentId);
        const epoch = this.epochOf(agentId);
        const home = this.deps.codexHomeFor(agentId);
        if (!home) return;
        const usage = await (this.deps.read ?? readCodexUsage)(transcriptPath, home);
        if (!usage || this.epochOf(agentId) !== epoch) return;
        this.deps.ingest({ agentId, sessionId, model, usd: 0, ...usage });
      })().catch(() => {
      });
    }, this.deps.delayMs ?? 2e3);
    this.pending.set(agentId, { timer, revision });
  }
  /** The agent's PTY is torn down: cancel a pending read and invalidate one in flight. */
  forget(agentId) {
    const pending = this.pending.get(agentId);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(agentId);
    this.epochs.set(agentId, this.epochOf(agentId) + 1);
  }
  epochOf(agentId) {
    return this.epochs.get(agentId) ?? 0;
  }
}

// ─── activity digest (verbatim) ─────────────────────────────────────────────
const ACTIVITY_RING = 200;
class ActivityDigest {
  constructor(getWebContents, cap = ACTIVITY_RING) {
    this.getWebContents = getWebContents;
    this.cap = cap;
  }
  rings = new Map();
  /** Append one entry for an agent, dropping the oldest past the cap, and push it live. */
  record(agentId, entry) {
    if (!agentId) return;
    let ring = this.rings.get(agentId);
    if (!ring) {
      ring = [];
      this.rings.set(agentId, ring);
    }
    ring.push(entry);
    if (ring.length > this.cap) ring.splice(0, ring.length - this.cap);
    const push = { agentId, entry };
    try {
      this.getWebContents()?.send("hive:agentActivity", push);
    } catch {
    }
  }
  /** The newest `limit` entries, oldest first. The renderer reads updatedAt off the last one. */
  list(agentId, limit = ACTIVITY_RING) {
    const ring = this.rings.get(agentId);
    if (!ring || ring.length === 0) return [];
    const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, ring.length) : ring.length;
    return ring.slice(ring.length - n);
  }
  /** Drop an agent's ring when main tears the agent down, so a replacement with the same id starts clean. */
  forget(agentId) {
    this.rings.delete(agentId);
  }
}

module.exports = {
  FRESH_FLOOR_MS, RETENTION_POLICIES, COMMAND_HISTORY_LIMIT,
  planTrim, dayKey, planReap,
  ROSTER_BACKUP, MESSAGE_FILE, SPAWN_FILE, MEMORY_BACKUP_STAMP, AGENT_DIR,
  NOTHING, withinRoot, isPlainDir, plainFileStat, dirSize,
  reapFiles, reapDirs, reapRosterBackups,
  PRUNE_EVERY, rosterPath, rosterBackupDir, isSnapshot, entryCount,
  RosterStore, standingGoalFromRoster,
  MAX_TAIL_BYTES, READ_BLOCK_BYTES, tokenCount, parseCodexUsageTail,
  isWithin, readCodexUsage, CodexUsageScheduler,
  ACTIVITY_RING, ActivityDigest,
};
