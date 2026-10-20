'use strict';
/**
 * CircuitBreaker — verbatim port of the reference (index.js ~12700-12955).
 * Per-agent safety governor: healthy → steering → constrained → stopped,
 * escalated by repeat-loop / error-storm / token-cap / velocity /
 * no-progress signals, muted for a grace window around compaction.
 */
const node_crypto = require('node:crypto');

const LEVELS = ["healthy", "steering", "constrained", "stopped"];
const rank = (l) => LEVELS.indexOf(l);
const actionFor = (l) => l === "steering" ? "steer" : l === "constrained" ? "constrain" : l === "stopped" ? "stop" : "none";
const tokensOf = (s) => s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;
const workTokensOf = (s) => s ? s.input + s.output + s.cacheCreation : 0;
const DEFAULTS = {
  enabled: true,
  hardStop: false,
  repeatedToolLimit: 8,
  errorStormLimit: 5,
  tokenVelocityPerMin: 6e4
  // output tokens/min — coarse backstop, deliberately high
};
const COMPACT_GRACE_MS = 5 * 6e4;
const POST_COMPACT_GRACE_MS = 9e4;
const PROGRESS_TOOL_WINDOW_MS = 3e5;
const NO_PROGRESS_BEATS = 2;
class CircuitBreaker {
  constructor(getConfig) {
    // The reference takes a `() => cfg` getter; plain objects are wrapped so
    // both `new CircuitBreaker({...})` and `new CircuitBreaker(() => cfg)` work.
    this.getConfig = typeof getConfig === "function" ? getConfig : () => getConfig ?? {};
    this._mru = [];           // agentId MRU — adapters synthesise tick inputs
    this._extraCaps = new Map(); // agentId → per-agent work-token cap (setTokenCap)
  }
  agents = /* @__PURE__ */ new Map();
  cfg() {
    const c = this.getConfig() ?? {};
    return {
      enabled: c.enabled ?? DEFAULTS.enabled,
      hardStop: c.hardStop ?? DEFAULTS.hardStop,
      repeatedToolLimit: c.repeatedToolLimit ?? DEFAULTS.repeatedToolLimit,
      errorStormLimit: c.errorStormLimit ?? DEFAULTS.errorStormLimit,
      tokenVelocityPerMin: c.tokenVelocityPerMin ?? DEFAULTS.tokenVelocityPerMin,
      costCapUsd: c.costCapUsd ?? c.floorCostCapUsd,
      costCapTokens: c.costCapTokens ?? c.floorTokenCap,
      agentTokenCaps: { ...(c.agentTokenCaps ?? {}), ...Object.fromEntries(this._extraCaps) }
    };
  }
  get(agentId) {
    let s = this.agents.get(agentId);
    if (!s) {
      s = {
        level: "healthy",
        reason: "",
        lastSample: null,
        repeatKey: null,
        repeatCount: 0,
        errorCount: 0,
        compactingUntil: 0,
        lastDistinctToolAt: 0,
        lastUserPromptAt: 0,
        noProgressBeats: 0
      };
      this.agents.set(agentId, s);
    }
    return s;
  }
  /** Drop all state for an agent (call on archive/kill so it can't leak/zombie). */
  forget(agentId) {
    this.agents.delete(agentId);
  }
  /** Current breaker level for an agent (for the live fleet snapshot). */
  levelFor(agentId) {
    return this.agents.get(agentId)?.level ?? "healthy";
  }
  // ── event-driven inputs (fed by HookServer) ──────────────────────────────
  /** A tool call ran. A NEW (name+input) key counts as forward progress (resets
   *  the repeat + error counters and stamps the distinct-tool clock the
   *  no-progress arm reads); the SAME key in a row is the loop signal. */
  recordToolUse(agentId, toolName, toolInput, now = Date.now()) {
    const s = this.get(agentId);
    const key = this.toolKey(toolName, toolInput);
    if (key === s.repeatKey) {
      s.repeatCount += 1;
    } else {
      s.repeatKey = key;
      s.repeatCount = 1;
      s.errorCount = 0;
      s.lastDistinctToolAt = now;
    }
  }
  /** An api_error / retry occurred (no forward progress). */
  recordError(agentId) {
    this.get(agentId).errorCount += 1;
  }
  /** A human submitted a prompt to this agent (UserPromptSubmit hook). Stamps
   *  the conversation progress clock the no-progress arm reads (#376). Only
   *  that arm gains a way to see this work — the loop, error-storm, velocity
   *  and cap arms are unchanged. */
  recordUserPrompt(agentId, now = Date.now()) {
    this.get(agentId).lastUserPromptAt = now;
  }
  /** Compaction started (PreCompact hook). Exempt the Δoutput-based trips —
   *  compaction burns output tokens while touching no coordination file, which
   *  is exactly the false-positive shape of upstream issue #109 (the harness's
   *  own auto-compact mission tripping its own breaker on idle agents). */
  recordCompactStart(agentId, now = Date.now()) {
    this.get(agentId).compactingUntil = now + COMPACT_GRACE_MS;
  }
  /** Compaction finished (PostCompact, or any SessionStart). Shortens the
   *  cumulative diff. A no-op when no compaction is in flight, so a plain
   *  session start never grants an exemption. */
  recordCompactEnd(agentId, now = Date.now()) {
    const s = this.get(agentId);
    if (s.compactingUntil > now) s.compactingUntil = now + POST_COMPACT_GRACE_MS;
  }
  toolKey(toolName, toolInput) {
    let inp = "";
    try {
      inp = JSON.stringify(toolInput, (_k, v) => typeof v === "string" && v.length > 4096 ? v.slice(0, 4096) : v) ?? "";
    } catch {
      inp = String(toolInput);
    }
    return `${toolName ?? "?"}:${node_crypto.createHash("sha256").update(inp).digest("hex")}`;
  }
  // ── periodic evaluation (called by the heartbeat beat) ────────────────────
  /** Evaluate every agent for this beat and return a decision per agent. The
   *  caller emits each state (keeps the dashboard live) and enforces `action`
   *  when present. */
  tick(inputs, nowMs) {
    const cfg = this.cfg();
    const decisions = [];
    if (!cfg.enabled) {
      for (const { agentId } of inputs) {
        const s = this.get(agentId);
        const changed = s.level !== "healthy";
        s.level = "healthy";
        s.reason = "";
        decisions.push({ state: { agentId, level: "healthy", reason: "", ts: nowMs }, action: "none", changed });
      }
      return decisions;
    }
    let topSpender = null;
    if (typeof cfg.costCapUsd === "number" && cfg.costCapUsd > 0) {
      let total = 0;
      let max = -1;
      for (const i of inputs) {
        const usd = i.sample?.usd ?? 0;
        total += usd;
        if (usd > max) {
          max = usd;
          topSpender = i.agentId;
        }
      }
      if (total <= cfg.costCapUsd) topSpender = null;
    }
    let topTokenSpender = null;
    if (typeof cfg.costCapTokens === "number" && cfg.costCapTokens > 0) {
      let total = 0;
      let max = -1;
      for (const i of inputs) {
        const tok = tokensOf(i.sample);
        total += tok;
        if (tok > max) {
          max = tok;
          topTokenSpender = i.agentId;
        }
      }
      if (total <= cfg.costCapTokens) topTokenSpender = null;
    }
    for (const input of inputs) {
      const s = this.get(input.agentId);
      this._touch(input.agentId);
      const trip = this.evaluate(
        input,
        s,
        cfg,
        nowMs,
        input.agentId === topSpender,
        cfg.costCapUsd,
        input.agentId === topTokenSpender,
        cfg.costCapTokens
      );
      if (input.sample) s.lastSample = input.sample;
      const ceiling = cfg.hardStop ? "stopped" : "constrained";
      let target2 = s.level;
      if (trip.tripping) {
        target2 = LEVELS[Math.min(rank(s.level) + 1, rank(ceiling))];
      } else {
        target2 = LEVELS[Math.max(rank(s.level) - 1, 0)];
      }
      const changed = target2 !== s.level;
      const escalated = rank(target2) > rank(s.level);
      s.level = target2;
      s.reason = trip.tripping ? trip.reason : changed ? "recovering — signals cleared" : s.reason;
      decisions.push({
        state: { agentId: input.agentId, level: target2, reason: s.reason, ts: nowMs },
        action: escalated ? actionFor(target2) : "none",
        changed
      });
    }
    return decisions;
  }
  /** Pure trip evaluation for one agent given its signals + remembered baseline. */
  evaluate(input, s, cfg, nowMs, isTopSpender, costCapUsd, isTopTokenSpender, costCapTokens) {
    if (s.repeatCount >= cfg.repeatedToolLimit) {
      return { tripping: true, reason: `looping: ${s.repeatCount}× identical tool call (${s.repeatKey?.split(":")[0] ?? "?"})` };
    }
    if (s.errorCount >= cfg.errorStormLimit) {
      return { tripping: true, reason: `error storm: ${s.errorCount} consecutive api errors/retries` };
    }
    const perAgentCap = cfg.agentTokenCaps?.[input.agentId];
    if (typeof perAgentCap === "number" && perAgentCap > 0) {
      const work = workTokensOf(input.sample);
      if (work > perAgentCap) {
        return { tripping: true, reason: `token limit: ${work.toLocaleString()} work tokens over the agent cap of ${perAgentCap.toLocaleString()} (${tokensOf(input.sample).toLocaleString()} total incl. cache reads)` };
      }
    }
    if (isTopSpender && typeof costCapUsd === "number") {
      return { tripping: true, reason: `cost cap: floor total over $${costCapUsd} (top spender $${(input.sample?.usd ?? 0).toFixed(2)})` };
    }
    if (isTopTokenSpender && typeof costCapTokens === "number") {
      return { tripping: true, reason: `token cap: floor total over ${costCapTokens.toLocaleString()} tokens (top spender ${tokensOf(input.sample).toLocaleString()})` };
    }
    if (input.sample && s.lastSample && nowMs >= s.compactingUntil) {
      const dOut = input.sample.output - s.lastSample.output;
      const dMin = (input.sample.ts - s.lastSample.ts) / 6e4;
      if (dOut > 0 && dMin > 0) {
        const velocity = dOut / dMin;
        if (velocity > cfg.tokenVelocityPerMin) {
          return { tripping: true, reason: `token velocity ${Math.round(velocity)}/min > ${cfg.tokenVelocityPerMin}/min` };
        }
        const toolActive = nowMs - s.lastDistinctToolAt < PROGRESS_TOOL_WINDOW_MS;
        const workActive = typeof input.lastWorkAt === "number" && input.lastWorkAt > 0 && nowMs - input.lastWorkAt < PROGRESS_TOOL_WINDOW_MS;
        const humanActive = nowMs - s.lastUserPromptAt < PROGRESS_TOOL_WINDOW_MS;
        if (!input.progressing && !toolActive && !workActive && !humanActive) {
          s.noProgressBeats += 1;
          if (s.noProgressBeats >= NO_PROGRESS_BEATS) {
            return { tripping: true, reason: "no-progress: generating tokens without coordinating (stale log/files)" };
          }
        } else {
          s.noProgressBeats = 0;
        }
      }
    }
    return { tripping: false, reason: "" };
  }

  // ── event-driven adapter layer (the host's hook surface; thin shims over the
  //    verbatim core so callers never synthesise a tick themselves) ──────────
  _touch(agentId) {
    this._mru = [agentId, ...this._mru.filter((x) => x !== agentId)].slice(0, 64);
  }
  /** Evaluate just this agent against its remembered baseline — same trip
   *  rules as the verbatim tick, but escalation-only: a per-call eval never
   *  de-escalates (recovery belongs to the periodic tick, which sees the whole
   *  fleet and clears one rung per beat). */
  _reEval(agentId, now = Date.now()) {
    this._touch(agentId);
    const s = this.get(agentId);
    const cfg = this.cfg();
    if (!cfg.enabled) { s.level = "healthy"; s.reason = ""; return null; }
    const trip = this.evaluate(
      { agentId, sample: s.lastSample, progressing: true },
      s, cfg, now, false, cfg.costCapUsd, false, cfg.costCapTokens
    );
    if (!trip.tripping) return null;
    const ceiling = cfg.hardStop ? "stopped" : "constrained";
    const target2 = LEVELS[Math.min(rank(s.level) + 1, rank(ceiling))];
    const changed = target2 !== s.level;
    const escalated = rank(target2) > rank(s.level);
    s.level = target2;
    s.reason = trip.reason;
    return changed || escalated
      ? { state: { agentId, level: target2, reason: s.reason, ts: now }, action: escalated ? actionFor(target2) : "none", changed }
      : null;
  }
  /** Back-compat alias for the hook path (sig already folds name+input). */
  recordTool(agentId, sig, meta = {}) {
    if (meta.ok === false) this.recordError(agentId);
    else this.recordToolUse(agentId, sig, meta.input ?? meta);
    if (meta.tokens || meta.costUsd) this.usage(agentId, meta);
    this._reEval(agentId);
  }
  /** Forward progress — a distinct tool call or a fresh human prompt. */
  progress(agentId, now = Date.now()) {
    const s = this.get(agentId);
    s.repeatKey = null;
    s.repeatCount = 0;
    s.errorCount = 0;
    s.lastDistinctToolAt = now;
    s.noProgressBeats = 0;
  }
  /** SessionStart/PostCompact → end the compact grace arm. */
  compacted(agentId) {
    this.recordCompactEnd(agentId);
  }
  /** Feed a usage sample ({tokens?, costUsd?, input?, output?, cacheRead?, cacheCreation?}). */
  usage(agentId, u = {}, now = Date.now()) {
    const s = this.get(agentId);
    const prev = s.lastSample ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, usd: 0, ts: now };
    const t = u.tokens && typeof u.tokens === "object" ? u.tokens : null;
    s.lastSample = {
      input: prev.input + (t?.input ?? 0) + (typeof u.input === "number" ? u.input : 0),
      output: prev.output + (t?.output ?? 0) + (typeof u.output === "number" ? u.output : 0) + (typeof u.tokens === "number" ? u.tokens : 0),
      cacheRead: prev.cacheRead + (t?.cacheRead ?? 0),
      cacheCreation: prev.cacheCreation + (t?.cacheCreation ?? 0),
      usd: prev.usd + (u.costUsd ?? 0),
      ts: now
    };
    this._touch(agentId);
    this._reEval(agentId, now);
  }
  /** Per-agent work-token cap (spawn-time `tokenCap`). */
  setTokenCap(agentId, cap) {
    if (typeof cap === "number" && cap > 0) this._extraCaps.set(agentId, cap);
    else this._extraCaps.delete(agentId);
  }
  /** What would the breaker do to this agent right now ({action, level, reason}). */
  actionFor(agentId) {
    const level = this.levelFor(agentId);
    return { action: actionFor(level), level, reason: this.agents.get(agentId)?.reason ?? "" };
  }
  levelOf(agentId) { return this.levelFor(agentId); }
  /** Fleet-wide view for the status surface. */
  stats() {
    const out = {};
    for (const [id, s] of this.agents) out[id] = { level: s.level, reason: s.reason };
    return out;
  }
}

module.exports = {
  CircuitBreaker, LEVELS, rank, actionFor, tokensOf, workTokensOf,
  DEFAULTS, COMPACT_GRACE_MS, POST_COMPACT_GRACE_MS,
  PROGRESS_TOOL_WINDOW_MS, NO_PROGRESS_BEATS,
};
