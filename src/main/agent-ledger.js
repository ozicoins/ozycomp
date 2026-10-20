'use strict';
/**
 * AgentLedger — verbatim port of the reference's stale-agent sweep
 * (out/main/index.js ~1682-1820): a tiny ledger at userData/agent-pids.json
 * recording each spawned PTY's {id, pid, startedAt, command} so the NEXT run
 * can tell a live process is really the agent it spawned and not a pid the OS
 * recycled. takePreviousLedger lifts the rows off disk at boot; sweepStaleAgents
 * re-verifies each row against `ps` and hardKillTree's only the ones that still
 * match — a recycled pid is spared, never killed on an id alone.
 */
const node_fs = require('node:fs');
const path = require('node:path');
const node_child_process = require('node:child_process');

const IDENTITY_DELAY_MS = 1500;
const PS_TIMEOUT_MS = 2e3;
function parsePsIdentities(stdout) {
  const out = new Map();
  for (const raw of String(stdout ?? '').split('\n')) {
    const m = raw.match(/^\s*(\d+)\s+(.*\S)\s+(\S+)\s*$/);
    if (!m) continue;
    out.set(Number(m[1]), { startedAt: m[2].trim(), command: m[3] });
  }
  return out;
}
function readIdentities(pids) {
  const valid = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (!valid.length || process.platform === 'win32') return Promise.resolve(new Map());
  return new Promise((resolve) => {
    try {
      node_child_process.execFile(
        'ps',
        ['-o', 'pid=,lstart=,comm=', '-p', valid.join(',')],
        { timeout: PS_TIMEOUT_MS, encoding: 'utf8' },
        // `ps` exits 1 when any listed pid is gone, with the others still
        // printed, so stdout is read whatever the exit status.
        (_err, stdout) => resolve(parsePsIdentities(String(stdout ?? '')))
      );
    } catch {
      resolve(new Map());
    }
  });
}
function isSameProcess(entry, live) {
  if (!live) return false;
  if (!entry.startedAt || !entry.command) return false;
  return live.startedAt === entry.startedAt && live.command === entry.command;
}
function readLedger(path2) {
  try {
    if (!node_fs.existsSync(path2)) return [];
    const raw = JSON.parse(node_fs.readFileSync(path2, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((e) => !!e && typeof e.pid === 'number' && typeof e.startedAt === 'string' && typeof e.command === 'string');
  } catch {
    return [];
  }
}
function writeLedger(path2, rows) {
  try {
    node_fs.mkdirSync(path.dirname(path2), { recursive: true });
    node_fs.writeFileSync(path2, JSON.stringify(rows));
  } catch {
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function hardKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      node_child_process.spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 1e4 });
    } catch {
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
}
class AgentLedger {
  constructor(path2, identify = readIdentities, delayMs = IDENTITY_DELAY_MS) {
    this.path = path2;
    this.identify = identify;
    this.delayMs = delayMs;
    this.rows = [];
    this.pending = new Map();
  }
  /** Note a PTY we just started. Costs a Map insert and an unref'd timer: the
   *  identity is read later by one async `ps`, while the pid is still ours
   *  (a pid that exits first is forgotten by remove() and never recorded).
   *  Reading it at sweep time instead would describe whoever holds the pid
   *  then, which proves nothing. Returns when the row is settled (tests). */
  add(id, pid) {
    if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return Promise.resolve();
    this.pending.set(pid, id);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        void this.identify([pid]).then((ids) => {
          if (this.pending.get(pid) !== id) {
            resolve();
            return;
          }
          this.pending.delete(pid);
          const live = ids.get(pid);
          if (!live) {
            resolve();
            return;
          }
          this.rows = this.rows.filter((r) => r.pid !== pid);
          this.rows.push({ id, pid, ...live });
          writeLedger(this.path, this.rows);
          resolve();
        }, () => resolve());
      }, this.delayMs);
      t.unref?.();
    });
  }
  /** Forget a PTY that exited or was killed. */
  remove(pid) {
    this.pending.delete(pid);
    const next = this.rows.filter((r) => r.pid !== pid);
    if (next.length === this.rows.length) return;
    this.rows = next;
    writeLedger(this.path, next);
  }
  /** Drop the whole ledger: the clean quit path, where killAll() has already
   *  stopped everything and nothing should be swept next time. */
  clear() {
    this.rows = [];
    this.pending.clear();
    try {
      node_fs.rmSync(this.path, { force: true });
    } catch {
    }
  }
}
function takePreviousLedger(ledgerPath) {
  const rows = readLedger(ledgerPath);
  try {
    node_fs.rmSync(ledgerPath, { force: true });
  } catch {
  }
  return rows;
}
async function sweepStaleAgents(rows, log = () => {}, identify = readIdentities) {
  const report = { killed: [], spared: [] };
  const alive2 = rows.filter((e) => isAlive(e.pid));
  if (!alive2.length) return report;
  const ids = await identify(alive2.map((e) => e.pid));
  for (const entry of alive2) {
    if (!isSameProcess(entry, ids.get(entry.pid))) {
      report.spared.push(entry);
      continue;
    }
    hardKillTree(entry.pid);
    report.killed.push(entry);
  }
  if (report.killed.length || report.spared.length) {
    log('[stale-agents] swept a previous run', {
      killed: report.killed.map((e) => `${e.id}:${e.pid}`),
      spared: report.spared.map((e) => `${e.id}:${e.pid}`)
    });
  }
  return report;
}

module.exports = {
  IDENTITY_DELAY_MS, PS_TIMEOUT_MS,
  parsePsIdentities, readIdentities, isSameProcess,
  readLedger, writeLedger, isAlive, hardKillTree,
  AgentLedger, takePreviousLedger, sweepStaleAgents,
};
