'use strict';
/**
 * realtime:* IPC surface — verbatim port of the reference blocks
 * (index.js ~21906-22620, ~22638-23060, ~37051-37215): the voice action
 * dispatcher (verb table, confirm gates, runAction), the completion watcher,
 * and the token mint/keys plumbing.
 *
 * Deps land on ctx: ctx.teams? No — ctx.harness.hive, ctx.control (installed
 * by control.js), ctx.completionWatcher (installed here), ctx.spawnAgentCore
 * (installed by pty.js when it registers), ctx.readConfig/writeConfig.
 */
const crypto = require('node:crypto');

const DEFAULT_POLL_MS = 4e3;
const MAX_PENDING = 200;
const PENDING_TTL_MS = 24 * 60 * 60 * 1e3;
const MAX_QUEUED = 50;
const REALTIME_MODEL = 'gpt-realtime';
const VOICE_ACTOR = 'michael-voice';

// ── verbatim floor-watcher constants (reference ~4705-4708) ───────────────
const FLOOR_POLL_MS = 5e3;
const MIN_PUSH_GAP_MS = 12e3;
const ACTIVE_WINDOW_MS = 8e3;
const MAX_PUSH_CHARS = 600;

// ── verbatim spawn-card helpers (reference ~5481, ~25238-25265) ───────────
function tokenizeCommand(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function modelFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--model=')) return a.slice('--model='.length) || void 0;
    if (a === '--model') {
      const v = args[i + 1];
      return v && !v.startsWith('-') ? v : void 0;
    }
  }
  return void 0;
}
function spawnedCard(input) {
  const tokens = input.command ? tokenizeCommand(input.command) : [];
  return {
    id: input.id,
    name: input.name?.trim() || input.id,
    provider: require('../provider-presets').inferAgentProvider(input.command, input.provider),
    cwd: input.cwd ?? '',
    command: input.command,
    // The command line is what a restore replays, so it is asked first.
    model: modelFromArgs(tokens.slice(1)) ?? modelFromArgs(input.args ?? []),
    role: input.role,
    worktreePath: input.worktreePath,
    character: input.character,
    accent: input.accent,
  };
}

/** Verbatim RealtimeFloorWatcher (reference ~4709-4790): diffs the registry,
 *  task board and PTY activity each tick into a one-line floor digest for the
 *  voice session — pushed on `realtime:floorDelta` only while live. */
class RealtimeFloorWatcher {
  constructor(deps2) {
    this.deps = deps2;
    this.timer = null;
    this.live = false;
    this.lastPushAt = 0;
    this.buffer = [];
    this.prevAgents = new Map();
    this.prevTasks = new Map();
    this.prevActive = new Map();
    this.primed = false;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch {} }, FLOOR_POLL_MS);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  setSessionLive(live) {
    this.live = live;
    this.buffer = [];
    this.primed = false;
  }
  tick() {
    if (!this.deps.enabled()) return;
    const reg = this.deps.registry();
    const agents = new Map();
    for (const [id, m] of Object.entries(reg.agents ?? {})) {
      agents.set(id, { archived: !!m.archived, name: m.name || id });
    }
    const tasksRaw = this.deps.tasks();
    const tasks = new Map();
    for (const t of Array.isArray(tasksRaw?.tasks) ? tasksRaw.tasks : []) {
      if (typeof t?.id === 'string') tasks.set(t.id, { status: t.status ?? 'todo', title: t.title ?? t.id });
    }
    const now = Date.now();
    const active = new Map();
    for (const p of this.deps.ptys()) {
      active.set(p.id.replace(/^pty-/, ''), now - p.lastOutputAt < ACTIVE_WINDOW_MS);
    }
    if (this.primed && this.live) {
      for (const [id, cur] of agents) {
        const prev = this.prevAgents.get(id);
        if (!prev) this.buffer.push(`${cur.name} joined the floor`);
        else if (!prev.archived && cur.archived) this.buffer.push(`${cur.name} was archived`);
        else if (prev.archived && !cur.archived) this.buffer.push(`${cur.name} is back from the archive`);
      }
      for (const [id, cur] of tasks) {
        const prev = this.prevTasks.get(id);
        if (!prev) this.buffer.push(`new task "${cur.title.slice(0, 60)}"`);
        else if (prev.status !== cur.status) this.buffer.push(`task "${cur.title.slice(0, 60)}" moved to ${cur.status}`);
      }
      for (const [id, isActive] of active) {
        const prev = this.prevActive.get(id);
        const name = agents.get(id)?.name;
        if (prev === void 0 || !name || agents.get(id)?.archived) continue;
        if (prev && !isActive) this.buffer.push(`${name} went quiet (likely done or idle)`);
        else if (!prev && isActive) this.buffer.push(`${name} started producing output`);
      }
    }
    this.prevAgents = agents;
    this.prevTasks = tasks;
    this.prevActive = active;
    this.primed = true;
    if (!this.live || this.buffer.length === 0) {
      if (!this.live) this.buffer = [];
      return;
    }
    if (now - this.lastPushAt < MIN_PUSH_GAP_MS) return;
    const text = this.buffer.join('; ').slice(0, MAX_PUSH_CHARS);
    this.buffer = [];
    this.lastPushAt = now;
    this.deps.push(text);
  }
}

const INJECTION_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\b[^.!?\n]*\b(?:previous|above|prior|instruction|system|prompt)\b[^.!?\n]*/gi,
  /\b(?:system|assistant|developer|user)\s*:/gi,
  /\byou are (?:now )?[^.!?\n]*/gi,
  /\bnew instructions?\b[^.!?\n]*/gi,
];
function neutralizeForVoice(text) {
  let out = String(text ?? '').replace(/[\u0000-]+/g, ' ');
  for (const p of INJECTION_PATTERNS) out = out.replace(p, '[omitted]');
  return out.replace(/\s+/g, ' ').trim().slice(0, 100);
}
function isDoneStatus(status) { return (status ?? '').trim().toLowerCase() === 'done'; }
function parseTs(iso) { const t = Date.parse(iso); return Number.isFinite(t) ? t : null; }
function isSystemSender(from) { const f = (from ?? '').toLowerCase(); return f === 'breaker' || f === 'scheduler' || f === 'system' || f === ''; }
function speakableName(agentId) { const head = String(agentId ?? '').split('-')[0] ?? String(agentId); return head ? head.charAt(0).toUpperCase() + head.slice(1) : String(agentId); }
function summarize(pending2, via) {
  const who2 = speakableName(pending2.targetAgentId);
  const obj2 = pending2.objective ? neutralizeForVoice(pending2.objective) : '';
  const what = obj2 ? ` on "${obj2}"` : '';
  const tail = via === 'card-done' ? ' (card marked done)' : '';
  return `${who2} finished${what}.${tail}`.replace(' .', '.');
}
function detectCompletion(pending2, ctx2) {
  if (pending2.taskId) {
    const card = ctx2.tasks.find((t) => t.id === pending2.taskId) ?? ctx2.tasks.find((t) => t.alias === pending2.taskId);
    if (card && isDoneStatus(card.status)) return { done: true, via: 'card-done', at: pending2.dispatchedAt, summary: summarize(pending2, 'card-done') };
  }
  let best = null;
  for (const m of ctx2.inbox) {
    if (m.from !== pending2.targetAgentId) continue;
    if (isSystemSender(m.from)) continue;
    const replyMatch = !!pending2.dispatchMessageId && m.in_reply_to === pending2.dispatchMessageId;
    const at = parseTs(m.created_at);
    const postDates = at === null ? false : at >= pending2.dispatchedAt;
    if (replyMatch || postDates) {
      const effAt = at ?? pending2.dispatchedAt;
      if (!best || effAt >= best.at) best = { msg: m, at: effAt };
      if (replyMatch) break;
    }
  }
  if (best) return { done: true, via: 'inbox-reply', at: best.at, messageId: best.msg.id, summary: summarize(pending2, 'inbox-reply') };
  return { done: false };
}
function safeRead(reader) { try { const v = reader(); return Array.isArray(v) ? v : []; } catch { return []; } }

class RealtimeCompletionWatcher {
  constructor(deps2) {
    this.deps = deps2;
    this.now = deps2.now ?? (() => Date.now());
    this.pollMs = deps2.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.pending = new Map();
    this.waiters = new Set();
    this.queued = [];
    this.listeners = new Set();
    this.sessionLive = false;
    this.timer = null;
  }
  track(record) { this.pending.set(record.correlationId, record); this.prunePending(); }
  untrack(correlationId) { this.pending.delete(correlationId); }
  onCompletion(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  waitFor(taskId, timeoutMs) {
    const immediate = this.checkOne(this.pendingForTask(taskId) ?? this.syntheticPending(taskId));
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      const waiter = { taskId, resolve: (e) => resolve(e) };
      this.waiters.add(waiter);
      const timer2 = setTimeout(() => { this.waiters.delete(waiter); resolve({ timedOut: true, taskId }); }, Math.max(0, timeoutMs));
      if (typeof timer2 === 'object' && timer2 && 'unref' in timer2) timer2.unref();
    });
  }
  setSessionLive(live) { this.sessionLive = live; }
  drainQueuedCompletions() { const out = this.queued; this.queued = []; return out; }
  get pendingCount() { return this.pending.size; }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) this.timer.unref();
  }
  stop() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  poll() {
    if (this.pending.size === 0 && this.waiters.size === 0) return;
    this.prunePending();
    for (const record of [...this.pending.values()]) {
      const event = this.checkOne(record);
      if (event) { this.pending.delete(record.correlationId); this.route(event); }
    }
  }
  prunePending() {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [id, rec] of this.pending) {
      if (rec.dispatchedAt > 0 && rec.dispatchedAt < cutoff) this.pending.delete(id);
    }
    if (this.pending.size > MAX_PENDING) {
      const oldestFirst = [...this.pending.entries()].sort((a, b) => a[1].dispatchedAt - b[1].dispatchedAt);
      const overflow = this.pending.size - MAX_PENDING;
      for (let i = 0; i < overflow; i++) this.pending.delete(oldestFirst[i][0]);
    }
  }
  snapshot() { return { tasks: safeRead(this.deps.readTasks), inbox: safeRead(this.deps.readInbox) }; }
  checkOne(record) {
    const res = detectCompletion(record, this.snapshot());
    if (!res.done) return null;
    return {
      correlationId: record.correlationId, kind: record.kind, targetAgentId: record.targetAgentId,
      taskId: record.taskId, objective: record.objective, via: res.via ?? 'inbox-reply',
      completedAt: res.at ?? this.now(), summary: res.summary ?? summarize(record, res.via), messageId: res.messageId,
    };
  }
  route(event) {
    for (const w of [...this.waiters]) {
      if (event.taskId && w.taskId === event.taskId) { this.waiters.delete(w); w.resolve(event); }
    }
    if (this.sessionLive) {
      for (const l of this.listeners) { try { l(event); } catch {} }
    } else {
      this.queued.push(event);
      if (this.queued.length > MAX_QUEUED) this.queued = this.queued.slice(-MAX_QUEUED);
      try { this.deps.onNotify?.(event); } catch {}
    }
  }
  pendingForTask(taskId) { for (const r of this.pending.values()) if (r.taskId === taskId) return r; return void 0; }
  syntheticPending(taskId) { return { correlationId: `wait:${taskId}`, kind: 'task', targetAgentId: '', taskId, dispatchedAt: 0 }; }
}

// ── action verb tables (verbatim ~21913-22010) ───────────────────────────────
const VERBS = {
  ping: { tier: 'confirm', confirmWord: 'ping', agentTargeted: true },
  dispatch: { tier: 'confirm', confirmWord: 'dispatch', agentTargeted: true },
  steer: { tier: 'confirm', confirmWord: 'steer', agentTargeted: true },
  create_schedule: { tier: 'confirm', confirmWord: 'schedule', agentTargeted: false },
  kill: { tier: 'confirm', confirmWord: 'kill', agentTargeted: true },
  halt: { tier: 'confirm', confirmWord: 'halt', agentTargeted: true },
  archive: { tier: 'confirm', confirmWord: 'archive', agentTargeted: true },
  clear_context: { tier: 'confirm', confirmWord: 'clear', agentTargeted: true },
  delete_task: { tier: 'confirm', confirmWord: 'delete', agentTargeted: false },
  edit_schedule: { tier: 'confirm', confirmWord: 'schedule', agentTargeted: false },
  spawn: { tier: 'confirm', confirmWord: 'spawn', agentTargeted: false },
  update_setting: { tier: 'confirm', confirmWord: 'setting', agentTargeted: false },
  create_task: { tier: 'soft', confirmWord: 'create', agentTargeted: false },
  assign_task: { tier: 'soft', confirmWord: 'assign', agentTargeted: false },
  update_task: { tier: 'soft', confirmWord: 'update', agentTargeted: false },
  pause: { tier: 'soft', confirmWord: 'pause', agentTargeted: true },
  resume: { tier: 'soft', confirmWord: 'resume', agentTargeted: true },
  auto_delivery: { tier: 'soft', confirmWord: 'delivery', agentTargeted: true },
  gate_tool: { tier: 'soft', confirmWord: 'gate', agentTargeted: true },
  unarchive: { tier: 'soft', confirmWord: 'unarchive', agentTargeted: true },
};
const SETTING_POLICY = {
  notifications: { tier: 'soft', type: 'boolean' },
  tvShowOffices: { tier: 'soft', type: 'boolean' },
  officeTheme: { tier: 'soft', type: 'string', values: ['office', 'friends', 'brooklyn99', 'siliconvalley', 'got', 'hogwarts'] },
  terminalTheme: { tier: 'soft', type: 'string', values: ['light', 'dark'] },
  strongKeepalive: { tier: 'soft', type: 'boolean' },
  autoUpdate: { tier: 'soft', type: 'boolean' },
  realtimeIdleDisconnectMs: { tier: 'soft', type: 'number', min: 3e4, max: 36e5 },
  defaultModel: { tier: 'soft', type: 'string' },
  godProvider: { tier: 'soft', type: 'string' },
  godModel: { tier: 'soft', type: 'string' },
  slackEnabled: { tier: 'soft', type: 'boolean' },
  webhookEnabled: { tier: 'soft', type: 'boolean' },
  semanticMemory: { tier: 'soft', type: 'boolean' },
  multiWindow: { tier: 'soft', type: 'boolean' },
};

const norm = (v) => String(v ?? '').trim().toLowerCase();
const str = (v) => typeof v === 'string' ? v : undefined;
function pendingFresh() { return moduleState.pending; }
function confirmAccepted(phrase, confirmWord) {
  const p = norm(phrase);
  if (!p) return false;
  return p === 'confirm' || p === confirmWord || p.includes(confirmWord);
}
const moduleState = { pending: null };
function logActionFailure(deps2, channel, verb, e) {
  try { deps2.hiveLog?.({ kind: 'realtime-action-error', channel, verb, error: e instanceof Error ? e.message : String(e) }); } catch {}
}
function runAction(deps2, verb, a) {
  const spec = VERBS[verb];
  if (!spec) return { ok: false, spoken: `I don't know the action "${verb}".` };
  if (spec.agentTargeted && !str(a.agentId) && !str(a.agent)) {
    return { ok: false, spoken: `Which agent should I ${verb}?` };
  }
  const agentId = str(a.agentId) ?? str(a.agent);
  const targetLabel = agentId ? speakableName(agentId) : '';
  const commit = async () => {
    switch (verb) {
      case 'ping': case 'dispatch': case 'steer': return deps2.controlSteer?.(agentId, str(a.text) ?? str(a.body) ?? '') , `${targetLabel} got it.`;
      case 'kill': { const r = deps2.killAgent?.(agentId); return r?.ok === false ? `Couldn't kill ${targetLabel}: ${r.error}` : `${targetLabel} is down.`; }
      case 'halt': deps2.controlHalt?.(agentId); return `${targetLabel} halted.`;
      case 'pause': deps2.controlPause?.(agentId, true); return `${targetLabel} paused.`;
      case 'resume': deps2.controlResume?.(agentId); return `${targetLabel} resumed.`;
      case 'archive': case 'unarchive': { const r = deps2.setArchived?.(agentId, verb === 'archive'); return r?.ok === false ? `Couldn't ${verb} ${targetLabel}: ${r.error}` : `${targetLabel} ${verb}d.`; }
      case 'clear_context': deps2.enqueueToAgent?.(agentId, '/clear'); return `${targetLabel} will clear context.`;
      case 'auto_delivery': deps2.controlAutoDelivery?.(agentId, a.paused === true); return `${targetLabel} delivery ${a.paused === true ? 'paused' : 'resumed'}.`;
      case 'gate_tool': deps2.controlGateTool?.(agentId, str(a.tool), a.on !== false); return `${targetLabel} tool ${a.on !== false ? 'gated' : 'ungated'}.`;
      case 'create_task': { const r = deps2.hiveAddTask?.(a.task ?? a); return r ? 'Task created.' : "Couldn't create the task."; }
      case 'assign_task': deps2.hivePatchTask?.(str(a.taskId), { assignee: agentId }); return 'Task assigned.';
      case 'update_task': deps2.hivePatchTask?.(str(a.taskId), a.patch ?? {}); return 'Task updated.';
      case 'delete_task': deps2.hiveDeleteTask?.(str(a.taskId)); return 'Task deleted.';
      case 'create_schedule': case 'edit_schedule': { const ms = deps2.listMissions?.() ?? []; const r = deps2.saveMissions?.(a.missions ?? ms); return 'Schedule saved.'; }
      case 'update_setting': { const k = str(a.key); const pol = SETTING_POLICY[k]; if (!pol) return `I can't change "${k}".`; deps2.patchConfig?.({ [k]: a.value }); return `Set ${k}.`; }
      case 'spawn': { const r = await deps2.spawnAgent?.(a.opts ?? {}); return r?.ok === false ? `Spawn failed: ${r.error}` : 'Agent spawned.'; }
      default: return `I don't know the action "${verb}".`;
    }
  };
  if (spec.tier === 'confirm') {
    moduleState.pending = { verb, targetLabel, confirmWord: spec.confirmWord, commit, createdAt: Date.now() };
    return { ok: false, spoken: `Say "confirm" or "${spec.confirmWord}" and I'll ${verb} ${targetLabel || 'it'}.` };
  }
  return commit().then((spoken) => ({ ok: true, spoken: typeof spoken === 'string' ? spoken : `${verb} done.` }));
}

function register(ctx) {
  const { ipcMain } = ctx;
  const hive = () => ctx.harness?.hive;
  const control = () => ctx.control;
  const liveWebContents = () => {
    const wc = ctx.win()?.webContents;
    if (wc && !wc.isDestroyed()) return wc;
    for (const w of ctx.BrowserWindow?.getAllWindows?.() ?? []) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
    }
    return null;
  };
  const hasOpenAiKey = () => !!(ctx.readConfig()?.openaiApiKey ?? ctx.harness?.secrets?.get?.('OPENAI_API_KEY'));
  const mintRealtimeToken = async (model = REALTIME_MODEL) => {
    const key = ctx.readConfig()?.openaiApiKey ?? ctx.harness?.secrets?.get?.('OPENAI_API_KEY');
    if (!key) return { ok: false, error: 'no OpenAI key' };
    try {
      const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ session: { type: 'realtime', model } }),
        signal: AbortSignal.timeout(15e3),
      });
      const data = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, ...data } : { ok: false, error: data?.error?.message ?? `openai ${r.status}` };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };

  const deps2 = {
    hiveEnabled: () => hive()?.enabled?.() ?? false,
    hiveSend: (partial, from) => hive()?.send?.(partial, from),
    hiveTasks: () => hive()?.tasks?.(),
    hiveAddTask: (task) => hive()?.addTask?.(task),
    hivePatchTask: (id, patch) => hive()?.patchTask?.(id, patch),
    hiveDeleteTask: (id) => hive()?.deleteTask?.(id),
    hiveRegistry: () => hive()?.registry?.(),
    hiveLog: (event) => hive()?.appendLog?.(event),
    controlPause: (id, on) => control()?.pause?.(id, on),
    controlResume: (id) => control()?.resume?.(id),
    controlSteer: (id, text) => control()?.steer?.(id, text),
    controlHalt: (id) => control()?.halt?.(id),
    controlSnapshot: (id) => control()?.snapshot?.(id),
    controlAutoDelivery: (id, paused) => control()?.pauseAutoDelivery?.(id, paused),
    controlGateTool: (id, tool, on) => control()?.gateTool?.(id, tool, on),
    killAgent: (id) => {
      const ptyId = ctx.ptyForAgent?.(id);
      if (!ptyId) return { ok: false, error: `no agent is live: ${id}` };
      const r = ctx.harness?.pty?.kill?.(ptyId);
      ctx.teardownPty?.(ptyId, 'person');
      try { liveWebContents()?.send('hive:agentArchived', { id }); } catch {}
      return r ?? { ok: true };
    },
    spawnAgent: async (opts) => {
      const o = opts;
      const res = ctx.spawnAgentCore
        ? await ctx.spawnAgentCore({ ...o, installNow: true }, null)
        : { ok: false, error: 'spawnAgentCore not ready' };
      if (res.ok) {
        try {
          liveWebContents()?.send('hive:agentSpawned', spawnedCard({
            id: o.id,
            name: o.hive?.name,
            provider: o.provider ?? o.hive?.provider,
            cwd: res.worktreePath ?? o.cwd,
            command: o.command,
            args: o.args,
            role: o.hive?.role,
            worktreePath: res.worktreePath,
          }));
        } catch {}
      }
      return res;
    },
    listMissions: () => { ctx.missionArming?.check?.(); return ctx.readConfig()?.missions ?? []; },
    saveMissions: (missions) => ctx.writeConfig({ missions }),
    trackDispatch: (d) => { try { completionWatcher.track({ ...d, kind: 'dispatch' }); } catch {} },
    setArchived: (id, archived) => {
      if (!hive()?.enabled?.()) return { ok: false, error: 'hive disabled' };
      hive()?.setArchived?.(id, archived);
      const rec = hive()?.registry?.().agents?.[id];
      try { liveWebContents()?.send(archived ? 'hive:agentArchived' : 'hive:agentSpawned', archived ? { id } : spawnedCard({ id, name: rec?.name, provider: rec?.provider, cwd: rec?.cwd, role: rec?.role })); } catch {}
      return { ok: true };
    },
    enqueueToAgent: (id, text) => { try { liveWebContents()?.send('realtime:enqueue', { agentId: id, text }); } catch {} },
    getConfigValue: (key) => ctx.readConfig()?.[key],
    patchConfig: (patch) => ctx.writeConfig(patch),
  };

  const completionWatcher = (ctx.completionWatcher ??= new RealtimeCompletionWatcher({
    readTasks: () => { const t = hive()?.tasks?.(); return Array.isArray(t?.tasks) ? t.tasks : []; },
    readInbox: () => {
      try {
        const mv = hive()?.inbox?.(VOICE_ACTOR) ?? [];
        const godId = hive()?.registry?.().godId;
        const god = godId ? hive()?.inbox?.(godId) ?? [] : [];
        const seen = new Set();
        return [...mv, ...god].filter((m) => !!m?.id && !seen.has(m.id) && seen.add(m.id) !== void 0);
      } catch { return []; }
    },
    onNotify: (evt) => {
      try {
        if (!require('electron').Notification.isSupported()) return;
        const reg = hive()?.registry?.() ?? {};
        const title = reg.agents?.[reg.godId ?? 'god']?.name ?? 'OzyComp';
        new (require('electron').Notification)({ title, body: evt.summary }).show();
      } catch {}
    },
  }));
  // Verbatim: the floor watcher is its own class polling registry+tasks+ptys
  // into `realtime:floorDelta` lines; the completion watcher is separate.
  if (!ctx.floorWatcher || ctx.floorWatcher === ctx.completionWatcher) {
    ctx.floorWatcher = new RealtimeFloorWatcher({
      enabled: () => hive()?.enabled?.() ?? false,
      registry: () => hive()?.registry?.() ?? { agents: {} },
      tasks: () => hive()?.tasks?.(),
      ptys: () => (ctx.harness?.pty?.list?.() ?? []).map((p) => ({ id: p.id, lastOutputAt: p.lastOutputAt })),
      push: (text) => { try { liveWebContents()?.send('realtime:floorDelta', { text }); } catch {} },
    });
  }
  ctx.floorWatcher.start?.();

  ipcMain.handle('realtime:hasKey', () => hasOpenAiKey());
  ipcMain.handle('realtime:mintToken', async (_e, payload) => {
    const p = payload ?? {};
    const model = typeof p.model === 'string' && p.model.trim() ? p.model.trim() : REALTIME_MODEL;
    return mintRealtimeToken(model);
  });
  ipcMain.handle('realtime:action', async (_e, payload) => {
    const p = payload ?? {};
    const verb = norm(str(p.verb)).replace(/\s+/g, '_');
    try {
      const res = await runAction(deps2, verb, p);
      if (!res.ok) console.warn(`[realtime-action] verb=${verb} rejected: ${res.spoken}`);
      return res;
    } catch (e) {
      logActionFailure(deps2, 'realtime:action', verb, e);
      const msg = e instanceof Error ? e.message : 'unknown error';
      return { ok: false, spoken: `That action failed: ${msg}.` };
    }
  });
  ipcMain.handle('realtime:action:confirm', async (_e, payload) => {
    const p = payload ?? {};
    const cur = pendingFresh();
    if (!cur) return { ok: false, spoken: "There's nothing waiting to confirm." };
    const phrase = str(p.phrase) || str(p.confirm) || str(p.text);
    if (!confirmAccepted(phrase, cur.confirmWord)) {
      return { ok: false, spoken: `I won't ${cur.verb} ${cur.targetLabel} on that — for safety I need you to say "confirm" or "${cur.confirmWord}", not just yes. Say it clearly, or say cancel.` };
    }
    const commit = cur.commit;
    const verb = cur.verb;
    moduleState.pending = null;
    try { const spoken = await commit(); return { ok: true, spoken }; }
    catch (e) { logActionFailure(deps2, 'realtime:action:confirm', verb, e); const msg = e instanceof Error ? e.message : 'unknown error'; return { ok: false, spoken: `That action failed: ${msg}.` }; }
  });
  ipcMain.handle('realtime:action:cancel', async () => {
    const had = pendingFresh();
    moduleState.pending = null;
    return { ok: true, spoken: had ? `Cancelled the ${had.verb}.` : 'Nothing to cancel.' };
  });
  ipcMain.handle('realtime:setSessionLive', (_e, live) => {
    completionWatcher.setSessionLive(live === true);
    ctx.floorWatcher?.setSessionLive?.(live === true);
    return { ok: true };
  });
  ipcMain.handle('realtime:drainCompletions', () => completionWatcher.drainQueuedCompletions());
  ipcMain.handle('realtime:waitFor', (_e, taskId, timeoutMs) =>
    typeof taskId === 'string' ? completionWatcher.waitFor(taskId, typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 12e4) : Promise.resolve({ timedOut: true, taskId: '' }));

  completionWatcher.onCompletion((evt) => { try { liveWebContents()?.send('realtime:completion', evt); } catch {} });
  completionWatcher.start();
}

module.exports = { register, RealtimeCompletionWatcher, RealtimeFloorWatcher, spawnedCard, tokenizeCommand, modelFromArgs };
