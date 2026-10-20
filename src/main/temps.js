'use strict';
/**
 * Temps — drop-in worker hiring. Anything (a Slack triage flow, the UI, god,
 * a cron) can hire a temp agent by writing a JSON manifest into the hive's
 * spawn-requests/ directory. This manager polls that directory and spawns a
 * `worker-<id>` agent per manifest, then moves the file to .done/ or .failed/.
 *
 * Manifest shape (same vocabulary as the reference harness):
 *   {
 *     "objective": "fix the flaky login test",   // seed prompt (required)
 *     "command":   "codex",                      // free-form command line (optional)
 *     "provider":  "codex",                      // explicit preset id (optional)
 *     "model":     "gpt-5.2-codex",
 *     "isolate":   true,                         // own git worktree
 *     "tokenCap":  400000,                       // per-agent token cap
 *     "slack":     { "channel": "C…", "thread_ts": "…" },
 *     "character": "…", "accent": "…"            // persona cosmetics
 *   }
 * A special manifest { "kind": "research/hires", … } needs human confirmation
 * in the UI — it is reported as `temp-needs-confirm` and left in place.
 *
 * The autonomy switch (Settings → "Temps can self-hire", ON by default) only
 * gates non-Slack manifests: Slack-triaged requests always go through.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertAgentId, readJson } = require('./hive');
const { providerFromCommand } = require('./providers');
const { writeMemoryIndex, memoryContextBlock } = require('./memory-rules');
const { buildAutonomousRequestProtocol } = require('./slack');

// verbatim ~37216: the spawn-requests sweep runs every 1.5s.
const POLL_MS = 1500;
// verbatim ~37432-37475: the GC sweep over preserved worktrees runs inside the
// same tick, throttled to once a minute and re-entrant-guarded.
const GC_SWEEP_MS = 6e4;
const WORKER_PREFIX = 'worker-';
const REQUEST_PREFIX = 'slack-';
function slackTaskId(requestId) { return `task-${requestId}`; }
function slackRequestIdOfWorker(workerId) {
  const prefix = `${WORKER_PREFIX}${REQUEST_PREFIX}`;
  return workerId.startsWith(prefix) ? workerId.slice(WORKER_PREFIX.length) : null;
}

class TempsManager {
  /**
   * @param {object} deps {hive, spawnAgent(id,opts), enabled():bool, emit(ev,...),
   *   slackReplyScriptPath():string, memory():{active():bool}, knowledge():{active,env},
   *   nodeCommand():string, liveWorkers:Map, usageOf(id):number}
   * The last four mirror the reference's module-scope singletons — injected so
   * the manager stays headless-testable.
   */
  constructor({ hive, spawnAgent, enabled, emit, slackReplyScriptPath, memory, knowledge, nodeCommand, liveWorkers, usageOf, preservedWorktrees, pty, readConfig, teardownPty, worktreeDeps } = {}) {
    this.hive = hive;
    this.spawnAgent = spawnAgent;                 // async (id, manifest-derived opts) → agent
    this.enabled = enabled ?? (() => true);       // autonomy switch — default ON
    this.emit = emit ?? (() => {});
    this.slackReplyScriptPath = slackReplyScriptPath ?? (() => 'md-slack-reply.cjs');
    this.memory = memory ?? (() => ({ active: () => false }));
    this.knowledge = knowledge ?? (() => ({ active: () => false, env: () => ({}) }));
    this.nodeCommand = nodeCommand ?? (() => 'node');
    this.liveWorkers = liveWorkers ?? new Map();
    this.usageOf = usageOf ?? (() => 0);
    // verbatim ~31877/37216: the preserved-worktree ledger + the reaper's own
    // handles (pty idle/kill, the worker-idle timeout and per-worker token cap
    // come from config each tick).
    this.preservedWorktrees = preservedWorktrees ?? new Map();
    this.pty = pty ?? (() => null);               // () => ptyManager {idleFor,kill}
    this.readConfig = readConfig ?? (() => ({}));
    this.teardownPty = teardownPty ?? (() => {});
    // {unlinkWorktreeDeps, worktreeIsGcSafe, removeWorktree, worktreeHasUnintegratedWork}
    this.worktreeDeps = worktreeDeps ?? null;
    this.timer = null;
    this.busy = false;
    this.lastGcSweepAt = 0;
    this.gcSweepRunning = false;
  }

  dir()    { const r = this.hive.root?.(); return r ? path.join(r, 'spawn-requests') : null; }
  doneDir(){ const d = this.dir(); return d ? path.join(d, '.done') : null; }
  failDir(){ const d = this.dir(); return d ? path.join(d, '.failed') : null; }

  start() {
    // verbatim ~37580: no-op without a live hive root — the watcher re-arms
    // when the hive appears (the worker-wake beat calls start() again).
    if (this.timer || !this.dir()) return;
    try { fs.mkdirSync(this.dir(), { recursive: true }); } catch {}
    this.timer = setInterval(() => { void this.tick(); }, POLL_MS);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** One scan: reap live workers (done-signal / token-cap / idle-timeout),
   *  then process every pending manifest oldest-first, then GC preserved
   *  worktrees — verbatim ephemeralWorkerTick (~37475). */
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = this.readConfig();
      const maxWorkers = Math.max(1, cfg.maxConcurrentWorkers ?? 4);
      const idleTimeoutMs = Math.max(1, cfg.workerIdleTimeoutMinutes ?? 20) * 6e4;
      const defaultTokenCap = typeof cfg.defaultWorkerTokenCap === 'number' && cfg.defaultWorkerTokenCap > 0 ? cfg.defaultWorkerTokenCap : 0;
      const pty = this.pty();
      for (const [workerId, rec] of [...this.liveWorkers]) {
        if (rec.releasing) continue;
        const done = this.workerSignaledDone(workerId, rec.spawnedAt);
        if (done !== null) {
          rec.releasing = true;
          rec.result = 'done';
          console.log(`[worker] ${workerId} signaled done — releasing`);
          try { this.onTempFinished(workerId, { ok: true, body: done.body }); } catch {}
          const doneAt = done.at;
          const settled = this.hive.settleInbox?.(workerId, doneAt) ?? { moved: 0, kept: 0, unanswered: [] };
          if (settled.moved > 0) console.log(`[worker] ${workerId}: filed ${settled.moved} unread inbox message(s) under inbox/.done`);
          if (settled.kept > 0) console.log(`[worker] ${workerId}: left ${settled.kept} message(s) that arrived after its done signal pending`);
          const unanswered = (settled.unanswered ?? []).filter((m) => m.conversation !== `worker-${rec.reqId}`);
          if (unanswered.length > 0) {
            const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');
            const lines = unanswered.map((m) => `- ${m.act} ${oneLine(m.id)} from ${oneLine(m.from)}: "${oneLine(m.subject)}"`);
            this.informGod(
              `[worker released — mail filed unread] ${workerId}`,
              `Worker ${workerId} signaled done and was released. These messages were still unread in its inbox and were filed under inbox/.done without an answer:\n` + lines.join('\n') + `\nIf one of them is not the order it just completed, nobody is working on it: resend it to another agent or re-hire the worker.`,
              rec.slack,
            );
          }
          try { pty?.kill?.(workerId); } catch {}
          try { this.teardownPty(workerId, 'worker'); } catch {}
          continue;
        }
        const tokenCap = rec.tokenCap && rec.tokenCap > 0 ? rec.tokenCap : defaultTokenCap;
        if (tokenCap > 0) {
          const used = this.usageOf(workerId);
          if (used > tokenCap) {
            rec.releasing = true;
            rec.result = 'token-cap';
            console.warn(`[worker] reaping ${workerId} — token cap (${used.toLocaleString()} > ${tokenCap.toLocaleString()})`);
            this.informGod(
              `[worker reaped — token cap] ${workerId}`,
              `Worker ${workerId} used ${used.toLocaleString()} tokens (> its cap of ${tokenCap.toLocaleString()}) and was reaped. Any committed work on its branch is preserved for you.`,
              rec.slack,
            );
            try { this.onTempFinished(workerId, { ok: false, reason: `over its token cap of ${tokenCap.toLocaleString()}` }); } catch {}
            try { pty?.kill?.(workerId); } catch {}
            try { this.teardownPty(workerId, 'worker'); } catch {}
            continue;
          }
        }
        const idleMs = pty?.idleFor?.(workerId);
        if (idleMs === undefined) continue;
        if (idleMs > idleTimeoutMs) {
          rec.releasing = true;
          rec.result = 'idle';
          console.warn(`[worker] reaping idle ${workerId} (${Math.round(idleMs / 6e4)}min idle)`);
          this.informGod(
            `[worker reaped — idle] ${workerId}`,
            `Worker ${workerId} produced no output for ${Math.round(idleMs / 6e4)} min (> the ${Math.round(idleTimeoutMs / 6e4)} min cap) and never signaled done, so it was reaped. Any committed work on its branch is preserved for you.`,
            rec.slack,
          );
          try { this.onTempFinished(workerId, { ok: false, reason: `idle for ${Math.round(idleMs / 6e4)} min` }); } catch {}
          try { pty?.kill?.(workerId); } catch {}
          try { this.teardownPty(workerId, 'worker'); } catch {}
        }
      }
      const maySpawn = this.enabled();
      const reqDir = this.dir();
      let files = [];
      if (reqDir) { try { files = fs.readdirSync(reqDir); } catch { files = []; } }
      for (const f of files.sort()) {
        if (this.liveWorkers.size >= maxWorkers) break;
        if (!f.endsWith('.json')) continue;
        const fp = path.join(reqDir, f);
        // verbatim: the autonomy switch gates only non-slack manifests.
        if (!maySpawn && this.spawnRequestOrigin(fp) !== 'slack') continue;
        await this._process(fp, f);
      }
      const now = Date.now();
      if (this.preservedWorktrees.size > 0 && now - this.lastGcSweepAt >= GC_SWEEP_MS) {
        this.lastGcSweepAt = now;
        await this.gcPreservedWorktrees();
      }
    } catch (e) {
      console.error('[worker] tick error:', e);
    } finally { this.busy = false; }
  }

  /** verbatim ~32010: report a worker lifecycle event to god as a `temps`
   *  inform — the slack tail line hands god the verbatim reply command. */
  informGod(subject, body, slack) {
    try {
      const slackLine = slack ? `\n\n[SLACK] Close the loop — post a reply to channel ${slack.channel} thread ${slack.thread_ts} via:\n  "${this.nodeCommand()}" "${this.slackReplyScriptPath()}" --channel ${slack.channel} --thread ${slack.thread_ts} --text "<your message>"` : '';
      this.hive.send({ to: 'god', act: 'inform', subject, body: body + slackLine }, 'temps');
    } catch (e) {
      console.error('[worker] informGod failed:', e);
    }
  }

  /** verbatim ~37244: a worker is done when its outbox (or .sent archive)
   *  holds an act:"done" message created after the spawn. */
  workerSignaledDone(workerId, spawnedAt) {
    const root = this.hive.root();
    if (!root) return null;
    const base = path.join(root, 'agents', workerId, 'outbox');
    let found = null;
    for (const dir of [base, path.join(base, '.sent')]) {
      if (!fs.existsSync(dir)) continue;
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const fp = path.join(dir, f);
        try {
          const msg = JSON.parse(fs.readFileSync(fp, 'utf8'));
          if (msg.act !== 'done') continue;
          let ts = Date.parse(msg.created_at ?? '');
          if (!Number.isFinite(ts)) {
            try { ts = fs.statSync(fp).mtimeMs; } catch { ts = NaN; }
          }
          if (Number.isFinite(ts) && ts > spawnedAt && (found === null || ts > found.at)) {
            const body = typeof msg.body === 'string' && msg.body.trim() ? msg.body : typeof msg.subject === 'string' ? msg.subject : '';
            found = { body, at: ts };
          }
        } catch {
        }
      }
    }
    return found;
  }
  /** verbatim ~37269: manifest origin — 'slack' bypasses the autonomy gate. */
  spawnRequestOrigin(filePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return raw.origin === 'slack' ? 'slack' : undefined;
    } catch {
      return undefined;
    }
  }
  /** verbatim ~37432: preserved worktrees are reclaimed once their work
   *  integrates — dependency-unlinked, gc-safe-checked, then removed. */
  async gcPreservedWorktrees() {
    if (this.gcSweepRunning || this.preservedWorktrees.size === 0) return;
    this.gcSweepRunning = true;
    const d = this.worktreeDeps;
    try {
      for (const [key, e] of [...this.preservedWorktrees]) {
        if (this.liveWorkers.has(e.workerId)) continue;
        if (!fs.existsSync(e.wtPath)) {
          this.removeWorkerScratch(e.workerId);
          this.preservedWorktrees.delete(key);
          console.log(`[worker gc] ${e.workerId}: worktree already gone — reclaimed scratch`);
          continue;
        }
        if (!d) continue;
        const deps = await d.unlinkWorktreeDeps(e.origCwd, e.wtPath);
        if (!deps.ok) {
          console.error('[worker gc] dependency unlink failed (keeping):', deps.error);
          continue;
        }
        let safe;
        try {
          safe = await d.worktreeIsGcSafe(e.wtPath, e.baseBranch);
        } catch (err) {
          console.error('[worker gc] gc-safe check threw (keeping):', err);
          continue;
        }
        if (!safe.gc) continue;
        const r = await d.removeWorktree(e.origCwd, e.wtPath);
        if (!r.ok) {
          console.error(`[worker gc] removeWorktree failed (keeping ${e.workerId}):`, r.error);
          continue;
        }
        this.removeWorkerScratch(e.workerId);
        this.preservedWorktrees.delete(key);
        console.log(`[worker gc] reclaimed ${e.workerId} (${safe.detail})`);
        this.informGod(
          `[worker worktree reclaimed] ${e.workerId}`,
          `The preserved worktree for ${e.workerId} is now integrated (${safe.detail}), so it and its scratch dir were garbage-collected.\nWorktree: ${e.wtPath}`,
          e.slack,
        );
      }
    } finally {
      this.gcSweepRunning = false;
    }
  }
  /** verbatim ~32080: delete agents/<workerId> once the worker is off the
   *  live map — path-constrained so only a worker scratch dir can go. */
  removeWorkerScratch(workerId) {
    if (this.liveWorkers.has(workerId)) return;
    const root = this.hive.root();
    if (!root) return;
    const dir = path.join(root, 'agents', workerId);
    const agentsRoot = path.join(root, 'agents');
    if (path.resolve(dir) !== path.join(path.resolve(agentsRoot), path.basename(dir)) || path.basename(dir) !== workerId) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error('[worker] removeWorkerScratch failed:', e);
    }
  }

  async _process(full, fname) {
    const m = readJson(full, null);
    if (!m || typeof m !== 'object') return this._move(full, fname, '.failed', 'unreadable-manifest');

    // research/hires manifests are proposals, not orders — wait for the human
    if (m.kind === 'research/hires') {
      this.emit('temp-needs-confirm', { file: fname, manifest: m });
      return;                                     // stays in place until confirmed/deleted
    }

    // verbatim ~37567: the autonomy gate lives in tick() — it SKIPS (does not
    // fail) a non-slack manifest, leaving the file in place for a later tick.
    // _process itself never re-checks the switch; slack manifests carry
    // origin:"slack" and reached us past the gate.

    const objective = String(m.objective ?? m.prompt ?? '').trim();
    if (!objective) return this._move(full, fname, '.failed', 'missing-objective');

    const id = `${WORKER_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
    try { assertAgentId(id); } catch { return this._move(full, fname, '.failed', 'bad-id'); }

    const provider = m.provider ?? (m.command ? providerFromCommand(m.command) : undefined);
    const reqId = fname.replace(/\.json$/, '');
    const slack = m.slack && typeof m.slack === 'object' ? { channel: m.slack.channel, thread_ts: m.slack.thread_ts } : undefined;
    const tokenCap = Number(m.tokenCap) || undefined;
    try {
      await this.spawnAgent(id, {
        provider, command: m.command, model: m.model,
        isolate: m.isolate === true,
        tokenCap,
        slack: m.slack, character: m.character, accent: m.accent,
        role: 'temp',
        name: m.name,
      });
      // verbatim ~37397: liveWorkers record, then the brief lands as a hive
      // request — NOT as the spawn prompt — so the memory index + capabilities
      // + done protocol wrap it exactly once.
      this.liveWorkers.set(id, { workerId: id, reqId, name: m.name ?? id, slack, spawnedAt: Date.now(), tokenCap, job: objective });
      try {
        const prefix = slack
          ? buildAutonomousRequestProtocol(slack.channel, slack.thread_ts, this.slackReplyScriptPath(), 'temp', this.nodeCommand())
          : '[TEMP JOB] You are a temp: one job, and no human is watching in the app. Work autonomously; no interactive questions. The job: ';
        let context = '';
        try {
          const root = this.hive.root();
          if (root) {
            const indexPath = writeMemoryIndex(root, this.hive.memoryIndexRows());
            const knowledge = this.knowledge();
            const kg = knowledge.active() && knowledge.env().KG_CLI ? `"${this.nodeCommand()}" "${knowledge.env().KG_CLI}" search "<the request in a few words>"` : undefined;
            context = memoryContextBlock(root, indexPath, this.memory().active(), kg) + '\n\n';
          }
        } catch (e) {
          console.error('[worker] memory index skipped:', e instanceof Error ? e.message : e);
        }
        const skillFile = path.join(this.hive.root() ?? '', 'agents', id, '.claude', 'skills', 'capabilities', 'SKILL.md');
        const suffix = `

[CAPABILITIES] Read ${skillFile} once (or run /capabilities) before you start: it lists your date skills (/today, /last30Days, /lastQuarter and more) and the integrations you reach through the loopback broker (MD_BROKER_URL is set for you), with how to call each. Resolve any time window with the date skills, never by hand.

[DONE] When finished, send god ONE outbox message with "act":"done" and a short result summary; that releases you (terminal closed, your branch handed to god). Do not push to any remote; god is the only integrator.`;
        this.hive.send({ to: id, conversation: `worker-${reqId}`, act: 'request', subject: m.name ?? id, body: `${prefix}${context}${objective}${suffix}` }, 'god');
      } catch (e) {
        console.error('[worker] dispatch send failed:', e);
      }
      this.hive.log({ kind: 'temp-spawned', id, provider, slack: slack?.channel });
      this.emit('temp-spawned', { id, manifest: m });
      this._move(full, fname, '.done');
    } catch (e) {
      this._move(full, fname, '.failed', String(e?.message ?? e));
      this.emit('temp-failed', { file: fname, error: String(e?.message ?? e) });
    }
  }

  /** verbatim ~15718 onTempFinished: when a slack worker ends, patch the task
   *  ledger row that requested it (task-<reqId>) done/blocked so the done
   *  observer can post the ✅ summary to the thread. */
  onTempFinished(workerId, outcome) {
    const requestId = slackRequestIdOfWorker(workerId);
    if (!requestId) return false;
    const taskId = slackTaskId(requestId);
    const at = new Date().toISOString();
    const patch = outcome.ok
      ? { status: 'done', result: outcome.body?.trim() || undefined, doneAt: at, updatedAt: at }
      : { status: 'blocked', result: `The temp ended before it finished: ${outcome.reason?.trim() || 'no reason given'}`, updatedAt: at };
    try {
      return this.hive.patchTask?.(taskId, patch) ?? false;
    } catch {
      return false;
    }
  }

  _move(full, fname, sub, reason) {
    const base = sub === '.done' ? this.doneDir() : this.failDir();
    if (!base) return;
    const dest = path.join(base, fname);
    try {
      if (reason) {
        const m = readJson(full, {}) ?? {};
        m.__failedReason = reason;
        fs.writeFileSync(full, JSON.stringify(m, null, 2), 'utf8');
      }
      fs.renameSync(full, dest);
    } catch {}
  }
}

module.exports = { TempsManager, WORKER_PREFIX };
