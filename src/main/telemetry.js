'use strict';
/**
 * TelemetryCollector — a loopback OTLP/HTTP-JSON receiver. Claude Code exports
 * `claude_code.token.usage` + `claude_code.cost.usage` metrics and tool_result /
 * tool_decision / api_error log records (CLATDE_CODE_ENABLE_TELEMETRY=1 + OTEL_*
 * pointing here). Live per-session accumulations fold into per-agent usage,
 * push deltas to subscribers (the breaker and the dashboard) and append rows to
 * the hive cost ledger. Transcript / Grok fallbacks answer for agents with no
 * live OTel yet; externalUsage takes a provider's own cumulative snapshot
 * (Codex rollout totals) verbatim.
 *
 * CumulativeSampleGate: OTLP cumulative counters can arrive out of order or
 * repeat; only a strictly larger value for a (session, series) advances the
 * total, so totals never double count or go backwards.
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeModel } = require('./pricing');
const { readAgentUsage } = require('./ipc/hive');

const SPAN_RING_CAP = 200;

class CumulativeSampleGate {
  constructor() { this.last = new Map(); }
  /** Returns the positive delta since the last accepted sample, or 0. */
  accept(key, value) {
    const prev = this.last.get(key) ?? 0;
    if (!(value > prev)) return 0;
    this.last.set(key, value);
    return value - prev;
  }
  /** verbatim ~13327: true when this sample differs from the last one admitted
   *  for the agent — the breaker beat's ledger gate. */
  admits(sample, opts = {}) {
    const signature = [
      sample.sessionId,
      sample.input,
      sample.output,
      sample.cacheRead,
      sample.cacheCreation,
      sample.model,
      sample.usd,
      opts.ignoreTs ? '' : sample.ts,
    ].join('|');
    if (this.last.get(sample.agentId) === signature) return false;
    this.last.set(sample.agentId, signature);
    return true;
  }
  /** Drop an agent's memory (archived/despawned) so the map cannot grow forever. */
  forget(agentId) {
    this.last.delete(agentId);
  }
}

/** Pull a string attribute out of an OTLP attribute list. */
function attr(list, key) {
  const a = (list ?? []).find(x => x.key === key);
  if (!a) return undefined;
  const v = a.value ?? {};
  return v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
}
/** Flatten OTLP attributes[{key,value:{...}}] → {key:primitive} (verbatim). */
function flattenAttrs(attrs) {
  const out = {};
  for (const a of attrs ?? []) {
    const v = a.value ?? {};
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue;
  }
  return out;
}
const str = (v) => typeof v === 'string' && v ? v : undefined;
const numAttr = (v) => typeof v === 'number' && Number.isFinite(v) ? v : 0;
const truthy = (v) => v === true || v === 'true' || v === 1;

class TelemetryCollector {
  /**
   * @param opts {host, port, emit, resolveCwd, resolveSessionId, onUsage, ledger,
   *   onApiError} — emit is the renderer-facing sink (webContents.send in the
   *   main process, no-op in tests/headless); resolveCwd/resolveSessionId let the
   *   transcript fallback read an agent's own session file.
   */
  constructor({ host = '127.0.0.1', port = 0, emit, resolveCwd, resolveSessionId, onUsage, ledger, onApiError } = {}) {
    this.host = host; this.port = port;
    this.emit = emit;
    this.resolveCwd = resolveCwd;
    this.resolveSessionId = resolveSessionId;
    this.onUsage = onUsage ?? (() => {});
    this.ledger = ledger ?? (() => {});
    /** agentId → Set<sessionId> of live OTel sessions. */
    this.agentSessions = new Map();
    /** sessionId → {input,output,cacheRead,cacheCreation,usd,model,ts} */
    this.sessions = new Map();
    /** agentId → provider-supplied CUMULATIVE usage (Codex rollouts) verbatim. */
    this.externalUsage = new Map();
    /** agentId → the DEAD session id forgetAgent saw: the file fallbacks stay
     *  dark while the registry still names that session (verbatim #571). A Set
     *  would never un-dark for an agent with no OTel at all (Grok, telemetry
     *  off) — the Map lets fallbackDark self-clear on a new session id. */
    this.resetAgents = new Map();
    /** agentId → ring buffer of recent tool spans. */
    this.spans = new Map();
    /** push subscribers (breaker + dashboard). */
    this.usageSubs = new Set();
    /** api_error subscribers — Lane A's breaker error-storm trip. */
    this.apiErrorSubs = new Set();
    if (typeof onApiError === 'function') this.apiErrorSubs.add(onApiError);
    this.gate = new CumulativeSampleGate();
    this.server = null;
    this.boundPort = null;
    // legacy aggregate kept for the dashboard totals() + agentUsage() readers
    this.usage = new Map();   // agentId → {tokens:{…}, costUsd, sessions:Set}
  }

  endpoint() { return this.boundPort ? `http://${this.host}:${this.boundPort}` : null; }

  /** Subscribe to an agent's fresh aggregate whenever telemetry lands. */
  onAgentUsage(cb) { this.usageSubs.add(cb); return () => this.usageSubs.delete(cb); }
  /** Subscribe to api_error samples (breaker Lane A). Returns an unsubscribe fn. */
  onApiError(cb) { this.apiErrorSubs.add(cb); return () => this.apiErrorSubs.delete(cb); }

  async start() {
    if (this.server) return this.endpoint();
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((ok, bad) => this.server.listen(this.port, this.host, e => e ? bad(e) : ok()));
    this.boundPort = this.server.address().port;
    return this.endpoint();
  }
  stop() { try { this.server?.close(); } catch {} this.server = null; this.boundPort = null; }

  _handle(req, res) {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 8e6) req.destroy(); });
    req.on('end', () => {
      try {
        const url = req.url ?? '';
        if (req.method === 'POST' && url.startsWith('/v1/metrics')) {
          this.ingestMetrics(JSON.parse(buf || '{}'));
        } else if (req.method === 'POST' && url.startsWith('/v1/logs')) {
          this.ingestLogs(JSON.parse(buf || '{}'));
        }
      } catch {}
      // OTLP exporters only care about 2xx; never fail the agent
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  }

  // ─── live session accumulation ────────────────────────────────────────────
  session(agentId, sessionId) {
    let accum = this.sessions.get(sessionId);
    if (!accum) {
      accum = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, usd: 0, model: '', ts: 0 };
      this.sessions.set(sessionId, accum);
    }
    let set = this.agentSessions.get(agentId);
    if (!set) { set = new Set(); this.agentSessions.set(agentId, set); }
    set.add(sessionId);
    return accum;
  }

  /** Fold one OTLP ExportMetricsServiceRequest (cumulative → deltas). */
  ingestMetrics(body) {
    const touched = new Set();
    for (const rm of body.resourceMetrics ?? []) {
      const agentId = attr(rm.resource?.attributes, 'agent.id') ?? 'unknown';
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of sm.metrics ?? []) {
          const points = m.sum?.dataPoints ?? m.gauge?.dataPoints ?? [];
          for (const p of points) {
            const value = Number(p.asDouble ?? p.asInt ?? 0);
            const session = attr(p.attributes, 'session.id') ?? 'default';
            const type = attr(p.attributes, 'type') ?? '';
            const model = attr(p.attributes, 'model') ?? '';
            const key = `${agentId}|${session}|${m.name}|${type}|${model}`;
            const delta = this.gate.accept(key, value);
            if (!delta) continue;
            const accum = this.session(agentId, session);
            if (model) accum.model = model;
            accum.ts = Date.now();
            const u = this._agent(agentId);
            u.sessions.add(session);
            if (m.name === 'claude_code.token.usage') {
              const slot = { input: 'input', output: 'output', cacheRead: 'cacheRead', cacheCreation: 'cacheCreation' }[type] ?? 'input';
              u.tokens[slot] += delta;
              accum[slot] += delta;
              touched.add(agentId);
              this.onUsage(agentId, { tokens: delta, costUsd: 0, type, model });
              this.ledger({ agent: agentId, kind: 'tokens', type, model, delta });
            } else if (m.name === 'claude_code.cost.usage') {
              u.costUsd += delta;
              accum.usd += delta;
              touched.add(agentId);
              this.onUsage(agentId, { tokens: 0, costUsd: delta, model });
              this.ledger({ agent: agentId, kind: 'cost', model, deltaUsd: delta });
            }
          }
        }
      }
    }
    for (const agentId of touched) {
      this.resetAgents.delete(agentId);
      this.publishUsage(agentId);
    }
  }

  /** Fold one OTLP ExportLogsServiceRequest → tool_result / tool_decision /
   *  api_error (verbatim ref ~23136-23177). */
  ingestLogs(body) {
    if (!Array.isArray(body?.resourceLogs)) return;
    for (const rl of body.resourceLogs) {
      const resAttrs = flattenAttrs(rl.resource?.attributes);
      for (const sl of rl.scopeLogs ?? []) {
        for (const lr of sl.logRecords ?? []) {
          const attrs = flattenAttrs(lr.attributes);
          const name = str(attrs['event.name']) || str(lr.body?.stringValue);
          const agentId = str(attrs['agent.id']) || str(resAttrs['agent.id']);
          const sessionId = str(attrs['session.id']);
          if (!agentId) continue;
          if (name === 'tool_result') {
            const span = {
              agentId,
              sessionId,
              ts: Date.now(),
              tool: str(attrs['tool_name']) || 'tool',
              success: truthy(attrs['success']),
              durationMs: numAttr(attrs['duration_ms']),
              decision: undefined
            };
            this.pushSpan(span);
            try { this.emit?.('telemetry:event', { kind: 'tool_result', span }); } catch {}
          } else if (name === 'tool_decision') {
            const decision = str(attrs['decision']) === 'reject' ? 'reject' : 'accept';
            const ring = this.spans.get(agentId);
            if (ring?.length) ring[ring.length - 1].decision = decision;
          } else if (name === 'api_error' || (name && name.includes('error'))) {
            const error = str(attrs['error']) || str(attrs['message']) || name;
            for (const cb of this.apiErrorSubs) { try { cb(agentId); } catch {} }
            try { this.emit?.('telemetry:event', { kind: 'api_error', agentId, sessionId, ts: Date.now(), error }); } catch {}
          }
        }
      }
    }
  }

  pushSpan(span) {
    let ring = this.spans.get(span.agentId);
    if (!ring) { ring = []; this.spans.set(span.agentId, ring); }
    ring.push(span);
    if (ring.length > SPAN_RING_CAP) ring.splice(0, ring.length - SPAN_RING_CAP);
  }
  getSpans(agentId) { return this.spans.get(agentId)?.slice() ?? []; }

  /** Fire every usage subscriber with the agent's fresh aggregate. */
  publishUsage(agentId) {
    const sample = this.getAgentUsage(agentId);
    if (!sample) return;
    for (const cb of this.usageSubs) { try { cb(sample); } catch {} }
    try { this.emit?.('telemetry:event', { kind: 'usage', sample }); } catch {}
  }

  /** Sum an agent's live sessions into one cumulative sample (sessionId/model =
   *  the most recently active). Null when the agent has no live data. */
  aggregateLive(agentId) {
    const set = this.agentSessions.get(agentId);
    if (!set || set.size === 0) return null;
    const out = { agentId, sessionId: '', ts: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, model: '', usd: 0 };
    for (const sid of set) {
      const a = this.sessions.get(sid);
      if (!a) continue;
      out.input += a.input;
      out.output += a.output;
      out.cacheRead += a.cacheRead;
      out.cacheCreation += a.cacheCreation;
      out.usd += a.usd;
      if (a.ts >= out.ts) { out.ts = a.ts; out.sessionId = sid; out.model = a.model; }
    }
    return out;
  }

  /** Live OTel only, never a transcript or Grok read — the wake beat's activity
   *  evidence (#455): a fallback sample's ts is a read time, not a turn time. */
  getLiveUsage(agentId) { return this.aggregateLive(agentId); }

  /** Pull (contract primary). OTel-live aggregate preferred, then a provider
   *  snapshot, then a session-scoped transcript read. Null when neither source
   *  has anything — the just-spawned / telemetry-off case, not an error. */
  getAgentUsage(agentId) {
    const live = this.aggregateLive(agentId);
    if (live) return live;
    const external = this.externalUsage.get(agentId);
    if (external) return { ...external };
    if (this.fallbackDark(agentId)) return null;
    return this.grokFallback(agentId) ?? this.transcriptFallback(agentId);
  }
  /** getAgentUsage for a caller that can wait — re-read when the first pull ran
   *  while a background transcript slice was still in flight. */
  async getAgentUsageSettled(agentId) {
    const now = this.getAgentUsage(agentId);
    if (now?.sessionId) return now;
    return this.getAgentUsage(agentId);
  }

  /** Drop an agent's live usage so a respawn starts with a fresh counter
   *  (verbatim ~22973). Clears in-memory accumulation only — the on-disk cost
   *  ledger and transcript fallback are untouched, so lifetime spending still
   *  reports. The span ring goes too: it is keyed by agent id, so a replacement
   *  would otherwise inherit the dead agent's tool waterfall.
   *
   *  Keeps the file fallbacks (transcript, Grok) dark for this agent (#571):
   *  ensureAgent preserves the registry sessionId across a respawn (it is the
   *  --resume key), so after this call that id still names the DEAD session,
   *  and reading it would hand the breaker the prior run's totals. Dark until
   *  the first live metric or a new session id. */
  forgetAgent(agentId) {
    const sessionIds = this.agentSessions.get(agentId);
    if (sessionIds) {
      for (const sessionId of sessionIds) this.sessions.delete(sessionId);
    }
    this.agentSessions.delete(agentId);
    this.externalUsage.delete(agentId);
    this.spans.delete(agentId);
    this.usage.delete(agentId);
    let dead;
    try { dead = this.resolveSessionId?.(agentId); } catch { dead = undefined; }
    if (dead) this.resetAgents.set(agentId, dead);
    else this.resetAgents.delete(agentId);
  }
  /** Clone-name alias — same routine as forgetAgent. */
  resetAgentUsage(agentId) { this.forgetAgent(agentId); }
  /** True while a respawned agent's fallbacks would still read its dead
   *  session (verbatim ~22995): no live metric has landed since forgetAgent,
   *  and the registry still names the session that was live then. Self-clears
   *  the moment the registry names a DIFFERENT session, so an agent with no
   *  OTel at all (Grok, telemetry off) reads its new session's file as soon as
   *  that session is recorded. */
  fallbackDark(agentId) {
    const dead = this.resetAgents.get(agentId);
    if (!dead) return false;
    let current;
    try { current = this.resolveSessionId?.(agentId); } catch { current = undefined; }
    if (current && current !== dead) {
      this.resetAgents.delete(agentId);
      return false;
    }
    return true;
  }

  /** A provider's CUMULATIVE snapshot (Codex rollout totals, verbatim #629) as
   *  the agent's usage, never as a delta. Unchanged snapshots are dropped. */
  ingestAgentUsage(sample) {
    const previous = this.externalUsage.get(sample.agentId);
    if (previous && previous.sessionId === sample.sessionId && previous.model === sample.model &&
        previous.input === sample.input && previous.output === sample.output &&
        previous.cacheRead === sample.cacheRead && previous.cacheCreation === sample.cacheCreation &&
        previous.usd === sample.usd) return;
    this.externalUsage.set(sample.agentId, { ...sample });
    for (const cb of this.usageSubs) { try { cb(sample); } catch {} }
    try { this.emit?.('telemetry:event', { kind: 'usage', sample }); } catch {}
  }

  /** Grok usage.json read (verbatim ~23296): ~/.grok/sessions/<enc(cwd)>/
   *  <sessionId>/usage.json — the file Grok's own CLI maintains, resolved via
   *  the same resolveCwd/resolveSessionId the transcript fallback uses (the
   *  Grok hook bridge normalizes its payload to session_id, so both resolvers
   *  answer for a Grok agent exactly as for a Claude one). Null for a Claude
   *  agent — its session id is not a directory under ~/.grok/sessions.
   *
   *  Unlike transcriptFallback this returns the REAL session id: the empty id
   *  is how the transcript path stays out of the ledger, and the whole point
   *  here is to get IN; the duplicate-row risk '' guards against is handled at
   *  write time by the delta gate. */
  grokFallback(agentId) {
    const cwd = this.resolveCwd?.(agentId);
    const sessionId = this.resolveSessionId?.(agentId);
    if (!cwd || !sessionId) return null;
    const file = path.join(os.homedir(), '.grok', 'sessions', encodeURIComponent(cwd), sessionId, 'usage.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const totals = parsed.session;
      if (!totals) return null;
      const ts = Date.parse(String(parsed.updatedAt ?? ''));
      return {
        agentId,
        sessionId,
        ts: Number.isFinite(ts) ? ts : Date.now(),
        input: numAttr(totals.inputTokens),
        output: numAttr(totals.outputTokens),
        cacheRead: numAttr(totals.cachedReadTokens),
        cacheCreation: numAttr(totals.cacheCreationTokens),
        model: normalizeModel(String(totals.primaryModelId ?? '')),
        // Grok reports cost in integer ticks, 10^10 to the dollar (its own
        // docs, user-guide/17-sessions.md). Taken as given, never recomputed —
        // same rule the Claude live path follows for Claude's own figure.
        usd: numAttr(totals.costUsdTicks) / 1e10,
      };
    } catch { return null; }
  }

  /** Session-scoped transcript read (verbatim D11): the agent's own
   *  ~/.claude/projects/<key>/<sessionId>.jsonl, resolved via resolveCwd +
   *  resolveSessionId so a shared cwd never sums someone else's history.
   *  sessionId stays '' on the sample so it still reads as "no live session". */
  transcriptFallback(agentId) {
    const cwd = this.resolveCwd?.(agentId);
    if (!cwd) return null;
    const sessionId = this.resolveSessionId?.(agentId);
    if (!sessionId) return null;
    const u = readAgentUsage(cwd, { sessionId });
    if (!u) return null;
    if (!u.inputTokens && !u.outputTokens && !u.cacheReadTokens && !u.cacheWriteTokens) return null;
    return {
      agentId,
      sessionId: '',
      ts: u.asOf ?? Date.now(),
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheCreation: u.cacheWriteTokens,
      model: u.model ?? '',
      usd: u.estimatedCostUsd
    };
  }

  _agent(id) {
    let u = this.usage.get(id);
    if (!u) {
      u = { tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, costUsd: 0, sessions: new Set() };
      this.usage.set(id, u);
    }
    return u;
  }

  agentUsage(id) {
    const u = this.usage.get(id);
    if (!u) return null;
    const t = u.tokens;
    return { tokens: { ...t }, total: t.input + t.output + t.cacheRead + t.cacheCreation, costUsd: u.costUsd, sessions: [...u.sessions] };
  }
  totals() {
    const out = { agents: {}, tokens: 0, costUsd: 0 };
    for (const id of this.usage.keys()) {
      const a = this.agentUsage(id);
      out.agents[id] = a;
      out.tokens += a.total;
      out.costUsd += a.costUsd;
    }
    return out;
  }
  /** Dashboard pull: live aggregate per agent + the recent span rings. */
  snapshot() {
    const usage = [];
    for (const id of new Set([...this.usage.keys(), ...this.agentSessions.keys(), ...this.externalUsage.keys()])) {
      const live = this.getAgentUsage(id);
      const legacy = this.agentUsage(id);
      usage.push({ agentId: id, ...(live ?? {}), total: live ? (live.input + live.output + live.cacheRead + live.cacheCreation) : legacy?.total, costUsd: live?.usd ?? legacy?.costUsd ?? 0 });
    }
    const spans = {};
    for (const [id, ring] of this.spans) spans[id] = ring.slice();
    return { usage, spans };
  }
}

module.exports = { TelemetryCollector, CumulativeSampleGate };
