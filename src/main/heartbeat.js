'use strict';
/**
 * Heartbeat machinery — verbatim port of the reference's quiet-floor detector.
 * A heartbeat-kind mission does not fire on a dumb interval: each beat checks
 * whether the floor actually went quiet (no log/inbox/outbox writes, no PTY
 * output for quietThresholdMs) or whether god has ACTIONABLE mail, and only
 * then re-engages the orchestrator with a digest. A floor that stays busy
 * defers the next beat to 2.5× the interval; a floor that looks stuck
 * (agents live but silent, mail waiting) hastens it to interval/4.
 */
const fs = require('node:fs');
const path = require('node:path');

function isFloorQuiet(deps, thresholdMs) {
  const root = deps.hive.root();
  if (!root) return false;
  const times = [];
  const pushMtime = (p) => {
    try {
      times.push(fs.statSync(p).mtimeMs);
    } catch {
    }
  };
  pushMtime(path.join(root, "log.jsonl"));
  const agentsDir = path.join(root, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const id of fs.readdirSync(agentsDir)) {
      pushMtime(path.join(agentsDir, id, "inbox"));
      pushMtime(path.join(agentsDir, id, "outbox", ".sent"));
    }
  }
  for (const t of deps.pty.list()) times.push(t.lastOutputAt);
  if (times.length === 0) return false;
  return Date.now() - Math.max(...times) > thresholdMs;
}
function lastCoordinationAt(deps, agentId) {
  const root = deps.hive.root();
  if (!root) return 0;
  const times = [0];
  const pushMtime = (p) => {
    try {
      times.push(fs.statSync(p).mtimeMs);
    } catch {
    }
  };
  const dir = path.join(root, "agents", agentId);
  pushMtime(path.join(dir, "inbox"));
  pushMtime(path.join(dir, "inbox", ".done"));
  pushMtime(path.join(dir, "outbox"));
  pushMtime(path.join(dir, "outbox", ".sent"));
  pushMtime(path.join(dir, "memory.md"));
  return Math.max(...times);
}
function lastWorkAt(deps, agentId) {
  const cwd = deps.hive.registry().agents[agentId]?.cwd;
  if (!cwd) return 0;
  const times = [0];
  const pushMtime = (p) => {
    try {
      times.push(fs.statSync(p).mtimeMs);
    } catch {
    }
  };
  pushMtime(cwd);
  const git = path.join(cwd, ".git");
  pushMtime(path.join(git, "index"));
  pushMtime(path.join(git, "logs", "HEAD"));
  pushMtime(path.join(git, "FETCH_HEAD"));
  pushMtime(path.join(git, "refs", "remotes"));
  pushMtime(path.join(git, "packed-refs"));
  return Math.max(...times);
}
function ptyForAgent(deps, agentId) {
  const a = deps.pty.get(agentId);
  return a?.alive ? agentId : void 0;
}
function looksStuck(deps, windowMs) {
  const reg = deps.hive.registry();
  const now = Date.now();
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived || id === reg.godId) continue;
    const ptyId = ptyForAgent(deps, id);
    if (!ptyId) continue;
    const idle = deps.pty.idleFor?.(ptyId) ?? Infinity;
    if (idle < 15e3 && now - lastCoordinationAt(deps, id) > windowMs) return true;
  }
  return false;
}
function buildHeartbeatDigest(deps, quietMs, actionable = 0) {
  const reg = deps.hive.registry();
  const active = Object.entries(reg.agents).filter(([id, a]) => !a.archived && id !== reg.godId);
  const names = active.map(([, a]) => a.name).join(", ") || "—";
  const boardHead = deps.hive.board().split("\n").slice(0, 10).join("\n").trim();
  const log = deps.logTail(8).map((e) => {
    try {
      return JSON.stringify(e);
    } catch {
      return "";
    }
  }).filter(Boolean).join("\n");
  const withInbox = active.filter(([id]) => deps.inbox(id).length > 0).map(([, a]) => a.name);
  const header = actionable > 0 ? `Floor heartbeat — ${actionable} actionable inbox message(s) awaiting you (worker/human mail). Drain your inbox NOW and act on them.` : `Floor heartbeat — quiet ~${Math.round(quietMs / 6e4)}m.`;
  return [
    header,
    `Active agents (${active.length}): ${names}.`,
    withInbox.length ? `Undrained inbox: ${withInbox.join(", ")}.` : "No undrained inboxes.",
    "",
    "Board (head):",
    boardHead || "(empty)",
    "",
    "Recent log:",
    log || "(none)",
    "",
    "Re-engage anyone stalled or blocked and keep the board accurate — or rest if the work is genuinely done."
  ].join("\n");
}
const SYSTEM_SENDERS = new Set(["heartbeat", "scheduler", "breaker", "system"]);
function godActionableInboxCount(deps) {
  try {
    const godId = deps.hive.registry().godId;
    if (!godId) return 0;
    return deps.inbox(godId).filter((m) => !SYSTEM_SENDERS.has(m.from)).length;
  } catch {
    return 0;
  }
}
function reengageGod(deps, digest) {
  deps.hive.send({ to: "god", act: "request", body: digest, subject: "Heartbeat" }, "heartbeat");
}

/**
 * armHeartbeat(m) — one heartbeat-kind mission's timer, kept in `timers`
 * (the mission scheduler's own Map) so a re-arm or clear() tears it down
 * with everything else. Deps: {hive, pty, readConfig, writeConfig,
 * inbox(id), logTail(n), notify(channel), timers}.
 */
function armHeartbeat(deps, m) {
  const base = m.intervalMs;
  const quiet = m.quietThresholdMs ?? 3e5;
  const beat = () => {
    let next = base;
    try {
      const actionable = godActionableInboxCount(deps);
      if (isFloorQuiet(deps, quiet) || actionable > 0) {
        reengageGod(deps, buildHeartbeatDigest(deps, quiet, actionable));
        next = Math.round(base * 2.5);
      } else if (looksStuck(deps, quiet)) {
        next = Math.max(3e4, Math.round(base / 4));
      }
      const cur = deps.readConfig().missions ?? [];
      deps.writeConfig({ missions: cur.map((x) => x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x) });
      try {
        deps.notify?.("missions:updated");
      } catch {
      }
    } catch (e) {
      console.error("[heartbeat]", e);
    }
    const entry = deps.timers.get(m.id) ?? {};
    entry.timeout = setTimeout(beat, next);
    deps.timers.set(m.id, entry);
  };
  const remaining = Math.max(0, base - (Date.now() - (m.lastFiredAt ?? 0)));
  deps.timers.set(m.id, { timeout: setTimeout(beat, remaining) });
}

module.exports = {
  isFloorQuiet, lastCoordinationAt, lastWorkAt, looksStuck,
  buildHeartbeatDigest, godActionableInboxCount, reengageGod, armHeartbeat,
  SYSTEM_SENDERS,
};
