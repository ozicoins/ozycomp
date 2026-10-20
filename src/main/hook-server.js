'use strict';
/**
 * HookServer — the hook control plane. CLI agents (claude, codex, gemini…)
 * fire lifecycle hooks (PreToolUse, PostToolUse, Notification, Stop,
 * SessionStart…) over a local channel. Two transports, same handler:
 *
 *   • Unix domain socket  <hive>/hooks.sock        (preferred, zero auth needed
 *                                                 beyond filesystem perms)
 *   • Loopback HTTP       http://127.0.0.1:<port>  (Bearer <hook-token>)
 *     token lives at <hive>/hook-token, mode 0600
 *
 * Wire contract (reference parity): newline-delimited JSON carrying the
 * provider-shaped payload — {hook_event_name, agent_id, session_id?,
 * transcript_path?, tool_name?, tool_input?, context_window?, …}. The handler
 * replies with a decision object the shim prints verbatim to the CLI
 * (deny / block / additionalContext / continue:false).
 *
 * Semantics: FAIL-OPEN. A hook handler error must never block the agent —
 * we ack 200 {ok:true} / {} and log. Every received hook appends a
 * HookProofRecord to the hive log so submits can be correlated with tool runs.
 *
 * Also hosts: OpenQuestionTracker (Stop-hook questions the UI must answer)
 * and WorkerWakeWatchdog (agent has inbox mail but PTY has been idle → nudge).
 */
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { estimateCostUsd } = require('./pricing');

// ── verbatim worker-wake constants + helpers (ref ~24821-24895) ───────────
const HUMAN_QUESTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode'];
const WORKER_WAKE_IDLE_MS = 12e3;
const WORKER_WAKE_BOOT_GRACE_MS = 35e3;
const WORKER_WAKE_COOLDOWN_MS = 6e4;
const WORKER_WAKE_HITL_REARM_MS = 5 * 6e4;
const WORKER_WAKE_STALL_MS = 9e4;
const WORKER_WAKE_OPEN_TURN_MS = 15 * 6e4;
const WORKER_WAKE_POLL_MS = 15e3;
const WAKE_IDLE_MS = 20_000;   // kept for the check() fallback idle test

/** verbatim watchdog turn set (ref ~24835) — distinct from the proof-record
 *  TURN_EVENTS below, which additionally tracks compact/invocation hooks. */
const WAKE_TURN_EVENTS = new Set([
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop',
]);
function isHumanQuestionTool(tool) { return !!tool && HUMAN_QUESTION_TOOLS.includes(tool); }
function questionEffect(event, tool) {
  if (event === 'PreToolUse') return isHumanQuestionTool(tool) ? 'open' : null;
  if (event === 'PostToolUse') return isHumanQuestionTool(tool) ? 'close' : null;
  if (event === 'Stop' || event === 'UserPromptSubmit' || event === 'SessionStart') return 'close';
  return null;
}
function classifyHook(event, message) {
  if (event === 'Notification') {
    const msg = (message ?? '').toLowerCase();
    const idleWaiting = !msg || msg.includes('waiting for your input') || msg.includes('is idle') || msg.includes('waiting for input');
    const needsHuman = msg.includes('permission') || msg.includes('approve') || msg.includes('confirm') || msg.includes('needs your');
    if (needsHuman && !idleWaiting) return 'needsHuman';
    return 'idle';
  }
  return null;
}
function isTurnHook(event) { return WAKE_TURN_EVENTS.has(event); }
function liveInboxIds(f) { return new Set((f.inboxIds ?? []).filter((id) => typeof id === 'string' && id.length > 0)); }
function isStalledWorker(f, now = Date.now()) {
  const mailAt = f.oldestMailAt ?? 0;
  if (mailAt <= 0 || liveInboxIds(f).size === 0) return false;
  if (now - mailAt < WORKER_WAKE_STALL_MS) return false;
  return (f.lastActivityAt ?? 0) < mailAt;
}
/** verbatim OpenQuestionTracker shape — agentId → open question tool (the
 *  hook-driven tracker; distinct from the IPC open-question store above). */
class WakeQuestionTracker {
  constructor() { this.open = new Map(); }
  note(agentId, event, tool) {
    if (!agentId) return null;
    const effect = questionEffect(event, tool);
    if (effect === 'open') this.open.set(agentId, tool);
    else if (effect === 'close') this.open.delete(agentId);
    return effect;
  }
  isOpen(agentId) { return !!agentId && this.open.has(agentId); }
  forget(agentId) { this.open.delete(agentId); }
}

// ─── hook proof record (verbatim from the reference) ─────────────────────────

const TURN_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PreInvocation",
  "PostInvocation"
]);
const PROMPTS_KEPT = 8;
const PROMPT_TAIL_CHARS = 48;
function promptTail(text, n = PROMPT_TAIL_CHARS) {
  return text.replace(/<\/?pasted_content[^>]*>/g, "").replace(/\s+/g, "").slice(-n);
}
function tailMatches(hookTail, ourTail) {
  return ourTail.length > 0 && hookTail.endsWith(ourTail);
}

/**
 * HookProofRecord — per-agent proof that a typed/queued submit actually reached
 * the CLI. Every received hook event is noted with its arrival time; submit
 * paths then ask activitySeen ("did a turn event land since I sent?") and
 * promptSeen ("did the prompt I typed land?") before retrying.
 */
class HookProofRecord {
  constructor(now = Date.now) {
    this.now = now;
  }
  byAgent = new Map();
  note(agentId, event, prompt) {
    if (!agentId) return;
    const at = this.now();
    let a = this.byAgent.get(agentId);
    if (!a) {
      a = { lastAt: new Map(), turnAt: 0, prompts: [] };
      this.byAgent.set(agentId, a);
    }
    a.lastAt.set(event, at);
    if (TURN_EVENTS.has(event)) a.turnAt = at;
    if (event === "UserPromptSubmit" && typeof prompt === "string") {
      a.prompts.push({ at, tail: promptTail(prompt) });
      if (a.prompts.length > PROMPTS_KEPT) a.prompts.shift();
    }
  }
  /** A turn event (TURN_EVENTS) from this agent at or after `sinceMs`: a
   *  prompt was taken or a turn ran. Asked since the terminal started, it is
   *  also "this agent's hook channel works". */
  activitySeen(agentId, sinceMs) {
    const a = agentId ? this.byAgent.get(agentId) : void 0;
    return !!a && a.turnAt > 0 && a.turnAt >= sinceMs;
  }
  /** One of `events` at or after `sinceMs`. */
  eventSeen(agentId, sinceMs, events) {
    const a = agentId ? this.byAgent.get(agentId) : void 0;
    return !!a && events.some((e) => {
      const at = a.lastAt.get(e) ?? 0;
      return at > 0 && at >= sinceMs;
    });
  }
  /** When `event` last arrived from this agent, or 0. */
  lastEventAt(agentId, event) {
    return (agentId ? this.byAgent.get(agentId)?.lastAt.get(event) : void 0) ?? 0;
  }
  /** A UserPromptSubmit at or after `sinceMs` whose prompt ends with `tail`. */
  promptSeen(agentId, sinceMs, tail) {
    const a = agentId ? this.byAgent.get(agentId) : void 0;
    return !!a && a.prompts.some((p) => p.at >= sinceMs && tailMatches(p.tail, tail));
  }
}

const OPTIONAL_STRING_FIELDS = ["tool", "notificationType", "source", "message", "promptTail"];
function validateHookEvent(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value;
  if (typeof candidate.event !== "string" || candidate.event.length === 0) return false;
  if (candidate.agentId !== void 0 && (typeof candidate.agentId !== "string" || candidate.agentId.length === 0)) return false;
  for (const field of OPTIONAL_STRING_FIELDS) {
    if (candidate[field] !== void 0 && typeof candidate[field] !== "string") return false;
  }
  return candidate.blocked === void 0 || typeof candidate.blocked === "boolean";
}
/** Model id in a hook payload — a plain string, or {id} — skipped for
 *  subagent-typed payloads (payload.agent_type marks a Task subagent, not the
 *  parent session's model). */
function liveModelOf(payload) {
  if (!payload || payload.agent_type) return void 0;
  const m = payload.model;
  const id = typeof m === "string" ? m : m && typeof m === "object" && typeof m.id === "string" ? m.id : "";
  const trimmed = id.trim();
  return trimmed || void 0;
}

class OpenQuestionTracker {
  constructor() { this.open = new Map(); }
  add(q) {
    const id = q.id ?? crypto.randomUUID();
    this.open.set(id, { id, agent: q.agent, question: q.question, at: new Date().toISOString(), options: q.options ?? [] });
    return id;
  }
  answer(id, answer) {
    const q = this.open.get(id);
    if (!q) return null;
    this.open.delete(id);
    return { ...q, answer, answeredAt: new Date().toISOString() };
  }
  list() { return [...this.open.values()]; }
}

/**
 * VERBATIM WorkerWakeWatchdog (ref ~24898): the stall/nudge state machine.
 * The harness feeds hook events via noteHook() and spawns via noteSpawn(); the
 * beat (check) builds per-agent facts and calls decide() — the pure function
 * that returns the ids to nudge. A worker is re-nudged only when a NEW inbox
 * id appears (edge trigger) or the stall rule fires, never twice for the same
 * mail. Holds: open question menu, needs-human prompt, boot grace, mid-turn,
 * open turn, cooldown.
 *
 * The clone keeps the {hive,pty,onNudge} constructor + check()/stop() shape so
 * the existing harness wiring is unchanged; check() now runs decide() over the
 * same fact records the verbatim beat built.
 */
class WorkerWakeWatchdog {
  constructor({ hive, pty, onNudge, control }) {
    this.hive = hive; this.pty = pty; this.onNudge = onNudge;
    this.control = control ?? null;      // ControlRegistry — pause/halt/delivery flags
    this.spawnedAt = new Map();          // ptyId → spawn ts (boot grace)
    this.lastNudgeAt = new Map();        // agentId → last nudge ts (cooldown)
    this.announcedInboxIds = new Map();  // agentId → ids in last nudge (edge)
    this.lastHumanNeedsAt = new Map();   // agentId → last needsHuman ts
    this.questions = new WakeQuestionTracker();
    this.lastTurnAt = new Map();         // agentId → last TURN_EVENTS ts
    this.hookSeenAt = new Map();         // agentId → last hook of any kind
    this.lastTurnHookAt = new Map();     // agentId → last isTurnHook ts
    this.lastTurnHookEvent = new Map();  // agentId → that event's name
    this.lastHoldReportAt = new Map();   // agentId → last hold-report ts
    this.timer = setInterval(() => this.check(), WORKER_WAKE_POLL_MS);
    this.timer.unref?.();
  }

  /** Record a PTY spawn so its boot sequence is left alone (verbatim). */
  noteSpawn(ptyId, at = Date.now()) { this.spawnedAt.set(ptyId, at); }

  /** Feed hook events so a HITL prompt blocks nudges (verbatim ~24926). */
  noteHook(agentId, event, message, at = Date.now(), tool) {
    if (!agentId) return;
    this.questions.note(agentId, event, tool);
    this.hookSeenAt.set(agentId, at);
    if (isTurnHook(event) && at > (this.lastTurnHookAt.get(agentId) ?? 0)) {
      this.lastTurnHookAt.set(agentId, at);
      this.lastTurnHookEvent.set(agentId, event);
    }
    if (classifyHook(event, message) === 'needsHuman') this.lastHumanNeedsAt.set(agentId, at);
    else if (event && WAKE_TURN_EVENTS.has(event)) this.lastTurnAt.set(agentId, at);
  }

  /** A menu or a person's decision owns this agent's input (verbatim ~24945). */
  holdsInput(agentId, now = Date.now()) {
    if (this.questions.isOpen(agentId)) return true;
    const lastHuman = this.lastHumanNeedsAt.get(agentId) ?? 0;
    if (lastHuman <= 0 || now - lastHuman >= WORKER_WAKE_HITL_REARM_MS) return false;
    return lastHuman > (this.lastTurnAt.get(agentId) ?? 0);
  }

  /** When the agent's hooks last proved a turn, or 0 (verbatim ~24957). */
  turnHookAt(agentId) { return this.lastTurnHookAt.get(agentId) ?? 0; }

  /** Hooks show a turn in progress — newest turn hook isn't a close (verbatim). */
  openTurn(agentId, now = Date.now()) {
    const at = this.lastTurnHookAt.get(agentId) ?? 0;
    if (at <= 0 || now - at >= WORKER_WAKE_OPEN_TURN_MS) return false;
    const event = this.lastTurnHookEvent.get(agentId);
    return event !== 'Stop' && event !== 'StopFailure';
  }

  /** The stall rule on all known evidence (verbatim ~24966). */
  isStalled(f, now) {
    const observable = !!f.hasTelemetry || this.hookSeenAt.has(f.agentId);
    if (!observable) return false;
    if (this.openTurn(f.agentId, now)) return false;
    const lastActivityAt = Math.max(f.lastActivityAt ?? 0, this.turnHookAt(f.agentId));
    return isStalledWorker({ ...f, lastActivityAt }, now);
  }

  /** Forget per-agent state (pty closed / agent archived) (verbatim ~24977). */
  forget(agentId, ptyId) {
    this.lastNudgeAt.delete(agentId);
    this.announcedInboxIds.delete(agentId);
    this.lastHumanNeedsAt.delete(agentId);
    this.lastTurnAt.delete(agentId);
    this.hookSeenAt.delete(agentId);
    this.lastTurnHookAt.delete(agentId);
    this.lastTurnHookEvent.delete(agentId);
    this.lastHoldReportAt.delete(agentId);
    this.questions.forget(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** Why this worker is held right now, or null → nudge (verbatim ~24989). */
  explain(f, now = Date.now()) {
    const inboxIds = liveInboxIds(f);
    if (inboxIds.size === 0) return 'no-mail';
    if (f.isGod) return 'god';
    if (!f.ptyId) return 'no-pty';
    if (f.autoDeliveryPaused) return 'delivery-paused';
    if (f.paused) return 'paused';
    if (f.halted) return 'halted';
    if (f.onHold) return 'on-hold';
    const stalled = this.isStalled(f, now);
    if (f.lastOutputAt <= 0 && !stalled) return 'booting';
    if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS && !stalled) return 'mid-turn';
    const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
    if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) return 'boot-grace';
    const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
    if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) return 'hitl';
    if (this.questions.isOpen(f.agentId)) return 'question';
    const announced = this.announcedInboxIds.get(f.agentId);
    if (announced && !stalled && !Array.from(inboxIds).some((id) => !announced.has(id))) return 'announced';
    const lastNudge = this.lastNudgeAt.get(f.agentId) ?? 0;
    if (lastNudge > 0 && now - lastNudge < WORKER_WAKE_COOLDOWN_MS) return 'cooldown';
    return null;
  }

  /** The worker ids to nudge right now — pure decision (verbatim ~25015). */
  decide(facts, now = Date.now()) {
    const out = [];
    for (const f of facts) {
      const inboxIds = liveInboxIds(f);
      if (inboxIds.size === 0) { this.announcedInboxIds.delete(f.agentId); continue; }
      if (this.explain(f, now) !== null) continue;
      this.lastNudgeAt.set(f.agentId, now);
      this.announcedInboxIds.set(f.agentId, inboxIds);
      out.push(f.agentId);
    }
    return out;
  }

  /** True once per cooldown per worker — the hold-report log gate (verbatim). */
  shouldReportHold(agentId, now = Date.now()) {
    const last = this.lastHoldReportAt.get(agentId) ?? 0;
    if (last > 0 && now - last < WORKER_WAKE_COOLDOWN_MS) return false;
    this.lastHoldReportAt.set(agentId, now);
    return true;
  }

  /** Last nudge ts for this worker, 0 = never (verbatim ~25040). */
  lastNudge(agentId) { return this.lastNudgeAt.get(agentId) ?? 0; }

  /**
   * The beat: build the per-agent fact record and nudge whoever decide() names.
   * Clone shape — the verbatim beat lives in runWorkerWakeBeat; here the watchdog
   * owns its own tick because the harness wired check() to an 8s interval (now
   * WORKER_WAKE_POLL_MS = 15s) and a simpler {hive,pty} context than the
   * verbatim beat's full telemetry+control snapshot.
   */
  check() {
    const reg = this.hive.registry();
    const now = Date.now();
    const facts = [];
    for (const id of Object.keys(reg.agents ?? {})) {
      const a = reg.agents[id];
      if (id === reg.godId || a?.archived) continue;
      const agent = this.pty.get(id);
      if (!agent?.alive) continue;
      const mail = this.hive.inbox(id) ?? [];
      let oldestMailAt = 0;
      for (const m of mail) {
        const t = Date.parse(m.created_at ?? '');
        if (Number.isFinite(t) && (oldestMailAt === 0 || t < oldestMailAt)) oldestMailAt = t;
      }
      facts.push({
        agentId: id,
        isGod: id === reg.godId,
        ptyId: id,
        lastOutputAt: agent.lastOutputAt ?? 0,
        inboxIds: mail.map((m) => m.id).filter(Boolean),
        autoDeliveryPaused: !!(this.control?.isAutoDeliveryPaused?.(id) ?? a.autoDeliveryPaused),
        paused: !!(this.control?.map?.get?.(id)?.paused ?? a.paused),
        halted: !!(this.control?.shouldHalt?.(id) ?? a.halted),
        onHold: !!a.onHold,
        lastActivityAt: this.turnHookAt(id),
        hasTelemetry: this.hookSeenAt.has(id),
        oldestMailAt,
      });
    }
    for (const id of this.decide(facts, now)) {
      const ids = this.hive.inbox(id).map((m) => m.id).filter(Boolean);
      if (!ids.length) continue;
      this.onNudge?.(id, ids.length);
      this.hive.log({ kind: 'wake-nudge', agent: id, pending: ids.length });
    }
    for (const f of facts) {
      if (f.inboxIds.length === 0) continue;
      const mailAge = f.oldestMailAt && f.oldestMailAt > 0 ? now - f.oldestMailAt : 0;
      const hold = this.explain(f, now);
      if (hold && this.shouldReportHold(f.agentId, now))
        this.hive.log({ kind: 'worker-held', agent: f.agentId, hold, mailAgeMs: mailAge });
    }
  }

  stop() { clearInterval(this.timer); }
}

class HookServer {
  /**
   * @param {object} deps {hive, onHook(agentId, event, payload),
   *   decide?(agentId, event, payload) → decision object|null,
   *   onUsageEvent?(sample), onStatus?(agentId,{tokens,limit})}
   * decide() may return the Claude-shaped response ({hookSpecificOutput…},
   * {decision:'block',reason}, {continue:false,stopReason}) — sent back
   * verbatim so the calling shim can translate it for its own CLI contract.
   */
  constructor(deps) {
    this.hive = deps.hive;
    this.onHook = deps.onHook ?? (() => {});
    this.decide = deps.decide ?? null;
    this.onUsageEvent = deps.onUsageEvent ?? null;
    this.onStatus = deps.onStatus ?? null;
    // Verbatim (ref ~12038): operator tool gates surface to the renderer on
    // control:approvalRequest so the control strip/toast can show them.
    this.onControl = deps.onControl ?? null;
    this.questions = new OpenQuestionTracker();
    this.transcriptPaths = new Map();
    this.contextById = new Map();
    this.modelById = new Map();
    this.proof = new HookProofRecord();
    this.port = null;
    this.token = crypto.randomBytes(24).toString('hex');
    this._servers = [];
  }

  /** verbatim ~7369: `hooks.sock` in the hive root; a named pipe on win32. */
  get sockPath() {
    const root = this.hive.root();
    if (!root) return null;
    if (process.platform === 'win32') {
      const id = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
      return `\\\\.\\pipe\\ozycomp-${id}`;
    }
    return path.join(root, 'hooks.sock');
  }
  get tokenPath() { return path.join(this.hive.root(), 'hook-token'); }

  /** The transcript file of an agent's CURRENT session, if any hook fired. */
  transcriptPath(agentId) { return this.transcriptPaths.get(agentId); }
  /** Latest context-window accounting (tokens + real size), if reported. */
  contextFor(agentId) { return this.contextById.get(agentId); }
  /** Model slug the agent last reported through a hook payload. */
  modelFor(agentId) { return this.modelById.get(agentId); }

  /**
   * Core dispatch. `p` is the provider-shaped payload (hook_event_name…);
   * `legacy` accepts our older {agentId, hook, payload} envelope too.
   * Returns the decision object to send back ({} = allow / no directive).
   */
  handle(p, legacy) {
    const agentId = p?.agent_id ?? legacy?.agentId;
    const event = p?.hook_event_name ?? legacy?.hook ?? 'Unknown';
    try {
      this.hive.log({ kind: 'hook', agent: agentId, hook: event, id: crypto.randomUUID() });
    } catch {}
    if (agentId && typeof p?.transcript_path === 'string' && p.transcript_path)
      this.transcriptPaths.set(agentId, p.transcript_path);
    const model = liveModelOf(p) ?? null;
    if (agentId && model && this.modelById.get(agentId) !== model) {
      this.modelById.set(agentId, model);
      this.onHook(agentId, 'ModelUpdate', { model });
    }
    this.proof.note(agentId, event, typeof p?.prompt === 'string' ? p.prompt : undefined);
    // verbatim (ref ~24930): every hook event lands on the wake watchdog — it
    // tracks open question menus, needs-human prompts and turn lifecycle so a
    // worker with mail is only nudged when a person isn't already in the loop.
    try { this.watchdog?.noteHook?.(agentId, event, p?.message ?? p?.notification_message, Date.now(), p?.tool_name); } catch {}
    if (event === 'Status') {
      const cw = p?.context_window;
      if (agentId && cw && typeof cw.total_input_tokens === 'number' && typeof cw.context_window_size === 'number' && cw.context_window_size > 0) {
        const rec = { tokens: cw.total_input_tokens, limit: cw.context_window_size, ts: Date.now() };
        this.contextById.set(agentId, rec);
        this.onStatus?.(agentId, rec);
      }
      return {};
    }
    if (event === 'CostSample' && agentId && p?.session_id) {
      const tokens = {
        inputTokens: p.input ?? 0, outputTokens: p.output ?? 0,
        cacheReadTokens: p.cache_read ?? 0, cacheWriteTokens: p.cache_creation ?? 0,
      };
      this.onUsageEvent?.({
        agentId, sessionId: p.session_id, ts: Date.now(),
        input: tokens.inputTokens, output: tokens.outputTokens,
        cacheRead: tokens.cacheReadTokens, cacheCreation: tokens.cacheWriteTokens,
        usd: estimateCostUsd(model, tokens),
        model: model ?? '',
      });
      return {};
    }
    if (agentId && p?.session_id && ['PostToolUse', 'Stop', 'PostCompact'].includes(event) && p?.transcript_path) {
      this.onUsageEvent?.({ agentId, event, transcriptPath: p.transcript_path, sessionId: p.session_id, model: model ?? '' });
    }
    if (event === 'Stop' && p?.question) {
      const qid = this.questions.add({ agent: agentId, question: p.question, options: p.options });
      this.onHook(agentId, event, { ...p, questionId: qid });
    } else {
      this.onHook(agentId, event, p ?? legacy?.payload ?? {});
    }
    // Verbatim PreToolUse gate (ref ~11939-11951): a paused agent or a gated
    // tool is denied with the operator's reason — AND the renderer is told on
    // control:approvalRequest before the deny reply rides back to the CLI.
    if (event === 'PreToolUse' && agentId && this.control) {
      const d = this.control.toolDecision(agentId, p?.tool_name ?? '');
      if (d.deny) {
        try { this.onControl?.(agentId, p?.tool_name, d.reason); } catch {}
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: d.reason ?? 'Denied by operator.',
          },
        };
      }
    }
    try { return this.decide?.(agentId, event, p ?? {}) ?? {}; }
    catch (e) {
      try { this.hive.log({ kind: 'hook-error', agent: agentId, hook: event, error: String(e?.message ?? e) }); } catch {}
      return {};
    }
  }

  _handleHttpBody(body, reply) {
    try {
      // provider-shaped {hook_event_name…} or legacy {agentId, hook, payload}
      const out = body?.hook_event_name !== undefined || body?.agent_id !== undefined
        ? this.handle(body)
        : this.handle(body?.payload ?? {}, body);
      reply(200, out ?? { ok: true });
    } catch (e) {
      try { this.hive.log({ kind: 'hook-error', error: String(e?.message ?? e) }); } catch {}
      reply(200, { ok: true }); // still ack — agent must not hang
    }
  }

  _readJson(req, cb) {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 1e6) req.destroy(); });
    req.on('end', () => { try { cb(JSON.parse(buf || '{}')); } catch { cb({}); } });
  }

  async start() {
    fs.mkdirSync(this.hive.root(), { recursive: true });
    fs.writeFileSync(this.tokenPath, this.token, { mode: 0o600 });

    // ── Unix socket transport: newline-delimited JSON, reply is one line ──
    try { fs.rmSync(this.sockPath, { force: true }); } catch {}
    const uds = net.createServer(conn => {
      let buf = '';
      conn.setEncoding('utf8');
      const flush = chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let body = {};
          try { body = JSON.parse(line); } catch {}
          const out = body?.hook_event_name !== undefined || body?.agent_id !== undefined
            ? this.handle(body)
            : this.handle(body?.payload ?? {}, body);
          try { conn.write(JSON.stringify(out ?? {}) + '\n'); } catch {}
        }
      };
      conn.on('data', flush);
      // tolerate peers that send one JSON blob and half-close without newline
      conn.on('end', () => {
        if (buf.trim()) {
          let body = {};
          try { body = JSON.parse(buf); } catch {}
          const out = body?.hook_event_name !== undefined || body?.agent_id !== undefined
            ? this.handle(body)
            : this.handle(body?.payload ?? {}, body);
          try { conn.end(JSON.stringify(out ?? {}) + '\n'); } catch {}
        }
      });
    });
    await new Promise((res, rej) => uds.listen(this.sockPath, e => e ? rej(e) : res()));
    try { fs.chmodSync(this.sockPath, 0o600); } catch {}
    this._servers.push(uds);
    this.bindAttempts = (this.bindAttempts ?? 0) + 1;
    this._boundAt = Date.now();

    // ── Loopback HTTP transport ──
    const httpd = http.createServer((req, res) => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || !req.url.startsWith('/hook')) return reply(404, { ok: false });
      // verbatim ~11776 httpTokenOk: constant-time compare — a plain string `!==`
      // leaks the token length and early-exits on the first wrong byte.
      const want = Buffer.from(`Bearer ${this.token}`);
      const got = Buffer.from(req.headers.authorization ?? '');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want))
        return reply(401, { ok: false, error: 'bad-token' });
      this._readJson(req, body => this._handleHttpBody(body, reply));
    });
    await new Promise((res, rej) => httpd.listen(0, '127.0.0.1', e => e ? rej(e) : res()));
    this.port = httpd.address().port;
    this._servers.push(httpd);
    return { sockPath: this.sockPath, port: this.port };
  }

  /** The bound loopback endpoint, or null before the listener is up (ref ~11764). */
  httpEndpoint() {
    return this.port === null ? null : { port: this.port, token: this.token };
  }

  /** verbatim ~11503 ensureListening: the 15s health beat's self-heal — if the
   *  hook socket file vanished (cleaned, rotated, or never bound) the listener
   *  re-binds so shims can reach it again. Idempotent: a live socket is a no-op. */
  async ensureListening() {
    if (this._servers.length > 0 && !!this.sockPath && fs.existsSync(this.sockPath)) return true;
    try {
      await this.start();
      return true;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return false;
    }
  }

  /** The hook socket's live state — the beat writes it into fleet.json
   *  (verbatim ~11503). `listening` reflects this process's own socket:
   *  unix-transport up + the file still present. `bound.since` is the start()
   *  timestamp. */
  health() {
    const listening = this._servers.length > 0 && !!this.sockPath && fs.existsSync(this.sockPath);
    return {
      path: this.sockPath,
      listening,
      since: listening && this._boundAt ? this._boundAt : null,
      lastError: this.lastError ?? null,
      attempts: this.bindAttempts ?? 0,
      orphans: this.orphans ?? [],
    };
  }

  /** Env block injected into spawned agent processes (HIVE_SOCK for shims). */
  envFor() {
    return {
      HIVE_SOCK: this.sockPath,
      OZYC_HOOK_SOCK: this.sockPath,
      OZYC_HOOK_URL: `http://127.0.0.1:${this.port}/hook`,
      OZYC_HOOK_TOKEN: this.token,
    };
  }

  stop() { for (const s of this._servers) { try { s.close(); } catch {} } this._servers = []; }
}

module.exports = {
  HookServer, OpenQuestionTracker, WorkerWakeWatchdog,
  HookProofRecord, TURN_EVENTS, PROMPT_TAIL_CHARS, PROMPTS_KEPT,
  promptTail, tailMatches, validateHookEvent, liveModelOf, OPTIONAL_STRING_FIELDS,
};
