'use strict';
/**
 * Config — the app-level settings store, verbatim from the reference:
 *
 *   • DEFAULTS — every config key the app knows, seeded the same way
 *     (missions: [OPS_STANDUP_MISSION], contextTrigger at 40min/30%, the
 *     Opus 5.5 god+default model, mcpDefaults seeded from the catalog).
 *   • readConfig — merge over DEFAULTS with withTriggerDefaults (the seeded
 *     compact-trigger migration), the v1/v053/opus55 one-shot migrations,
 *     transcribe + responseStyle normalisation, and an mtime-cache.
 *   • writeConfig — patch semantics with hive-home + repo normalisation and
 *     write listeners.
 *   • the mission seeds (OPS_STANDUP / HEARTBEAT / COMPACT_MAINTENANCE),
 *     response-style tag render/strip, normalizeHiveHome, pruneDeletedHives,
 *     and the agent-MCP overlay helpers (mcpEnabledFor / effectiveMcp /
 *     withAgentMcp / sanitizeAgentMcp).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MCP_CATALOG } = require('./mcp-catalog');
const { DEFAULT_TRANSCRIBE, withTranscribeDefaults } = require('./voice');

// ─── response style brief ────────────────────────────────────────────────────

const RESPONSE_STYLE_TAG = 'response_style';
const DEFAULT_RESPONSE_STYLE = [
  'Answer in the house style, on every message:',
  'Stay on the subject you were asked about, and answer the question that was actually asked.',
  'Be factual. Say what you checked and what you found. If you do not know, say that you do not know.',
  'Be short and crisp. Lead with the answer, then add only the detail that changes it.',
  'Use plain language anyone on the team can read. Spell a term out the first time you use it.',
  'Cut filler. No preamble, no flattery, no repeating the question back.',
  'When something is genuinely long, break it into short labelled parts instead of one block.',
].join('\n');
const RESPONSE_STYLE_MAX = 1200;
const TAG_PATTERN = new RegExp(`</?\\s*${RESPONSE_STYLE_TAG}\\s*/?>`, 'gi');
function stripControls(value) {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || (code >= 32 && code !== 127)) out += ch;
  }
  return out;
}
function normalizeResponseStyle(value) {
  if (typeof value !== 'string') return DEFAULT_RESPONSE_STYLE;
  const cleaned = stripControls(value.replace(/\r\n?/g, '\n').replace(TAG_PATTERN, '')).trim();
  if (!cleaned) return DEFAULT_RESPONSE_STYLE;
  return cleaned.length > RESPONSE_STYLE_MAX ? cleaned.slice(0, RESPONSE_STYLE_MAX).trim() : cleaned;
}
function renderResponseStyle(value) {
  return `<${RESPONSE_STYLE_TAG}>\n${normalizeResponseStyle(value)}\n</${RESPONSE_STYLE_TAG}>`;
}

// ─── hive home / recent hives ────────────────────────────────────────────────

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  const t = p.trim();
  if (!t) return p;
  let out = t;
  if (t === '~') out = os.homedir();
  else if (t.startsWith('~/') || t.startsWith('~\\')) out = path.join(os.homedir(), t.slice(2));
  if (!path.isAbsolute(out)) return t;
  return path.resolve(out);
}
function normalizeHiveHome(home, prior = [], cap = 8) {
  const abs = expandTilde(home);
  const seen = new Set([abs]);
  const recentHives = [abs];
  for (const h of prior) {
    if (typeof h !== 'string' || !h.trim()) continue;
    const e = expandTilde(h);
    if (seen.has(e)) continue;
    seen.add(e);
    recentHives.push(e);
  }
  return { home: abs, recentHives: recentHives.slice(0, cap) };
}
function pruneDeletedHives(recent, current, probe) {
  return recent.filter(h => h === current || probe(h) !== 'deleted');
}
function probeHive(p) {
  try {
    if (fs.existsSync(p)) return 'present';
    return fs.existsSync(path.dirname(p)) ? 'deleted' : 'unreachable';
  } catch { return 'unreachable'; }
}

// ─── agent MCP overlay ───────────────────────────────────────────────────────

function defaultMcpDefaults() {
  const out = {};
  for (const e of MCP_CATALOG) out[e.id] = { enabled: e.defaultEnabled };
  return out;
}
function mcpEnabledFor(entry, floor, perAgent, agentId) {
  const own = perAgent?.[agentId]?.[entry.id]?.enabled;
  if (typeof own === 'boolean') return own;
  const floorRow = floor?.[entry.id]?.enabled;
  if (typeof floorRow === 'boolean') return floorRow;
  return entry.defaultEnabled;
}
function effectiveMcp(floor, perAgent, agentId, catalog = MCP_CATALOG) {
  const out = {};
  for (const e of catalog) out[e.id] = { enabled: mcpEnabledFor(e, floor, perAgent, agentId) };
  return out;
}
function withAgentMcp(perAgent, agentId, mcpId, enabled) {
  const next = { ...(perAgent ?? {}) };
  const row = { ...(next[agentId] ?? {}) };
  if (enabled === null) delete row[mcpId];
  else row[mcpId] = { enabled };
  if (Object.keys(row).length === 0) delete next[agentId];
  else next[agentId] = row;
  return next;
}
function sanitizeAgentMcp(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const [agentId, rows] of Object.entries(raw)) {
    if (!rows || typeof rows !== 'object') continue;
    const clean = {};
    for (const [mcpId, v] of Object.entries(rows)) {
      const enabled = v?.enabled;
      if (typeof enabled === 'boolean') clean[mcpId] = { enabled };
    }
    if (Object.keys(clean).length) out[agentId] = clean;
  }
  return Object.keys(out).length ? out : undefined;
}
const MAX_AGENT_TOKEN_CAP = 1e10;

// ─── missions (seeded schedules) ─────────────────────────────────────────────

const OPS_STANDUP_MISSION = {
  id: 'ops-standup',
  label: 'Hourly ops standup',
  intervalMs: 36e5,
  to: 'god',
  body: 'Hourly ops standup. Review every agent: who is doing what, and confirm each is still running (not stalled or idle-stale). Check the task board — are in-flight tasks on track, and is anything blocked or unowned? Flag stale agents and at-risk tasks, and keep the board accurate. (As part of this standup each working agent is asked to summarise its current task and the next step, then compact and resume from the same point — so terminal contexts stay bounded without losing work. The compaction is queued and runs when an agent is idle, so it never interrupts work mid-step.)',
  enabled: true,
  // NO autoCompact. Compaction belongs to contextTrigger.compact and nothing else.
};
const HEARTBEAT_MISSION = {
  id: 'heartbeat',
  label: 'Floor heartbeat',
  intervalMs: 12e4,
  to: 'god',
  body: 'Floor heartbeat: the team has gone quiet. Review the digest in your inbox, re-engage anyone stalled or blocked, and keep the board accurate — or rest if the work is genuinely done.',
  enabled: false,
  kind: 'heartbeat',
  quietThresholdMs: 3e5,
};
const DEFAULT_COMPACTION_FOCUS = 'Keep the current task, recent decisions, open questions, and file paths in play. Drop resolved tangents.';
const DEFAULT_CONTEXT_TRIGGER = {
  compact: {
    enabled: true,
    // Every 40 minutes at 30% of the window, and 30% on a ~1M window too:
    // one bar for every model size.
    everyMs: 24e5,
    minContextPct: 30,
    minContextPctLargeWindow: 30,
    message: DEFAULT_COMPACTION_FOCUS,
  },
  clear: {
    enabled: false,
    everyMs: 72e5,
    minContextPct: 90,
    minContextPctLargeWindow: 80,
    message: '',
  },
};
const COMPACT_MAINTENANCE_MISSION = {
  id: 'compact-maintenance',
  label: 'Auto-compact (maintenance)',
  // 40 minutes, matching DEFAULT_CONTEXT_TRIGGER.compact.everyMs. The two
  // cadences must agree: this mission is the schedule half of the behaviour
  // the context trigger owns.
  intervalMs: DEFAULT_CONTEXT_TRIGGER.compact.everyMs,
  to: '',
  body: '',
  enabled: false,
  autoCompact: true,
  kind: 'compact',
};
const LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS = 36e5;
const SEEDED_COMPACT_MAINTENANCE_INTERVALS_MS = new Set([LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS, 72e5]);
const SEEDED_COMPACT_TRIGGERS = [
  { everyMs: 72e5, minContextPct: 60, minContextPctLargeWindow: 40 },
  // the first 0.5.3 draft
  { everyMs: 24e5, minContextPct: 30, minContextPctLargeWindow: 20 },
];

// ─── the defaults table ──────────────────────────────────────────────────────

const { DEFAULT_WEBHOOK_SCHEMA, DEFAULT_TRIGGER_MODE } = require('./webhooks');

const DEFAULTS = {
  // Local build: there is no account/licence step to complete, so onboarding
  // is born finished and the hive home defaults to ~/.ozycomp — the app opens
  // straight into the workspace on first launch with zero questions asked.
  onboardingComplete: true,
  harnessHome: '~/.ozycomp',
  // The renderer's shouldAutoOpenHive() requires this too — without it the
  // first screen is the "şirket yapılandırmasını seç" picker even though the
  // home above already points at a real hive. A local build opens the last
  // floor directly.
  openLastHiveOnLaunch: true,
  recentHives: [],
  registeredRepos: [],
  autoMode: true,
  orchestratorMaySpawn: true,
  defaultCommand: 'claude',
  godProvider: 'claude',
  godModel: 'claude-opus-5-5',
  // Global default model for every agent that hasn't picked one explicitly —
  // wins over the role-based tiers, so all agents default to Opus 5.5. A
  // per-agent model choice still overrides it.
  defaultModel: 'claude-opus-5-5',
  // Seeded from the MCP catalog so the consent defaults never drift from it
  // (safe-readonly ON, write/secret OFF).
  mcpDefaults: defaultMcpDefaults(),
  maxConcurrentWorkers: 4,
  workerIdleTimeoutMinutes: 20,
  integrations: [],
  defaultWorkerTokenCap: 0,          // 0 = unlimited (no per-worker cap)
  semanticMemory: true,
  embeddingModel: 'embeddinggemma',
  missions: [OPS_STANDUP_MISSION],
  notifications: false,
  strongKeepalive: false,
  autoUpdate: true,
  telemetryEnabled: true,
  multiWindow: true,
  tvShowOffices: false,
  officeTheme: 'office',
  slackEnabled: false,
  slackSigningSecret: undefined,
  slackBotToken: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  slackProactivePosting: false,
  slackMode: undefined,
  slackAppToken: undefined,
  slackPollSeconds: undefined,
  slackSocketCatchupSeconds: undefined,
  slackTempCwd: undefined,
  slackTriage: undefined,
  responder: undefined,
  webhookResponder: undefined,
  defaultView: undefined,
  seasonalTheme: undefined,
  freeflowEnabled: true,
  groqApiKey: undefined,
  freeflowModel: 'whisper-large-v3-turbo',
  transcribe: { ...DEFAULT_TRANSCRIBE },
  realtimeVoiceEnabled: false,
  realtimeIdleDisconnectMs: 18e4,
  webhookEnabled: false,
  webhookSecret: undefined,
  webhookPort: undefined,
  // These three are the ONLY object/array defaults handed straight back out of
  // readConfig for a config that never persisted them — withTriggerDefaults
  // re-copies them on every read.
  contextTrigger: DEFAULT_CONTEXT_TRIGGER,
  webhookTriggers: [],
  triggersMigratedV1: false,
  // Memory reflection — sits dark until an agent's memory crosses a threshold.
  reflectEnabled: true,
  reflectIntervalMs: 18e5,
  reflectByteTriggerPct: 50,
  reflectSectionTrigger: 50,
  reflectRecentKeep: 12,
  reflectMinBytes: 16384,
  // Knowledge Graph — opt-in; dark until the user enables it.
  knowledgeGraph: { enabled: false },
  // Every agent works under a response style brief from the first launch.
  responseStyle: DEFAULT_RESPONSE_STYLE,
};

// ─── read path: defaults ⇄ stored ⇄ one-shot migrations ─────────────────────

function withTriggerDefaults(cfg) {
  const storedCompact = cfg.contextTrigger?.compact;
  const untouchedCompact = !!storedCompact && SEEDED_COMPACT_TRIGGERS.some(seed =>
    storedCompact.everyMs === seed.everyMs
    && storedCompact.minContextPct === seed.minContextPct
    && storedCompact.minContextPctLargeWindow === seed.minContextPctLargeWindow);
  const compact = untouchedCompact
    ? {
        ...DEFAULT_CONTEXT_TRIGGER.compact,
        ...storedCompact,
        everyMs: DEFAULT_CONTEXT_TRIGGER.compact.everyMs,
        minContextPct: DEFAULT_CONTEXT_TRIGGER.compact.minContextPct,
        minContextPctLargeWindow: DEFAULT_CONTEXT_TRIGGER.compact.minContextPctLargeWindow,
      }
    : { ...DEFAULT_CONTEXT_TRIGGER.compact, ...storedCompact };
  const seededMission = m => m?.id === COMPACT_MAINTENANCE_MISSION.id && m.enabled === false
    && SEEDED_COMPACT_MAINTENANCE_INTERVALS_MS.has(m.intervalMs);
  const missions = Array.isArray(cfg.missions)
    ? cfg.missions.map(m => seededMission(m) ? { ...m, intervalMs: COMPACT_MAINTENANCE_MISSION.intervalMs } : m)
    : cfg.missions;
  return {
    ...cfg,
    ...(missions !== cfg.missions ? { missions } : {}),
    contextTrigger: {
      compact,
      clear: { ...DEFAULT_CONTEXT_TRIGGER.clear, ...cfg.contextTrigger?.clear },
    },
    webhookTriggers: Array.isArray(cfg.webhookTriggers) ? cfg.webhookTriggers.map(t => ({ ...t })) : [],
  };
}
function withResponseStyleDefault(cfg) {
  return { ...cfg, responseStyle: normalizeResponseStyle(cfg.responseStyle) };
}
function withTranscribe(cfg) {
  return { ...cfg, transcribe: withTranscribeDefaults(cfg.transcribe) };
}
function normalizeStoredHomes(cfg) {
  if (typeof cfg.harnessHome === 'string' && cfg.harnessHome.trim())
    cfg.harnessHome = expandTilde(cfg.harnessHome);
  if (Array.isArray(cfg.recentHives)) {
    const seen = new Set();
    cfg.recentHives = cfg.recentHives
      .filter(h => typeof h === 'string' && !!h.trim())
      .map(h => expandTilde(h))
      .filter(h => seen.has(h) ? false : (seen.add(h), true));
  }
  return cfg;
}

const PRE_OPUS55_DEFAULT_MODEL = 'claude-fable-5';
const PRE_OPUS55_GOD_MODEL = 'claude-opus-4-8';
function withOpus55Default(cfg) {
  const next = { ...cfg, opus55DefaultMigrated: true };
  if (cfg.defaultModel === PRE_OPUS55_DEFAULT_MODEL) next.defaultModel = 'claude-opus-5-5';
  if (cfg.godModel === PRE_OPUS55_GOD_MODEL) next.godModel = 'claude-opus-5-5';
  return next;
}

/**
 * ConfigStore — file-backed config with the reference's merge + migration
 * chain. `new ConfigStore(file)`; read() caches on (ino,size,mtime) the way
 * the reference's lastRead does; write() normalises hive homes, repo lists
 * and the response style, and notifies write listeners.
 */
class ConfigStore {
  constructor(file) {
    this.file = file;
    this.lastRead = null;
    this.listeners = new Set();
    this.triggersMigrationRan = false;
    this.tempsMigrationRan = false;
    this.opus55MigrationRan = false;
  }

  read() {
    const p = this.file;
    if (!fs.existsSync(p)) {
      this.lastRead = null;
      return withTranscribe(withResponseStyleDefault(withTriggerDefaults({ ...DEFAULTS })));
    }
    let id = null;
    try {
      const st = fs.statSync(p);
      id = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
    } catch { id = null; }
    if (id && this.lastRead && this.lastRead.path === p
        && this.lastRead.ino === id.ino && this.lastRead.size === id.size
        && this.lastRead.mtimeMs === id.mtimeMs) {
      return structuredClone(this.lastRead.cfg);
    }
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      // Local build: a saved onboardingComplete:false from a previous run must
      // not resurrect the account gate — force it back on, same as the default.
      if (parsed && typeof parsed === 'object' && parsed.onboardingComplete === false) {
        parsed.onboardingComplete = true;
      }
      // Same class of saved-false gate: a previous run that stored
      // openLastHiveOnLaunch:false would keep showing the config picker.
      if (parsed && typeof parsed === 'object' && parsed.openLastHiveOnLaunch === false) {
        parsed.openLastHiveOnLaunch = true;
      }
      const cfg = withTranscribe(withResponseStyleDefault(
        normalizeStoredHomes(this._migrateOpus55(this._migrateTemps(
          this._migrateTriggers(withTriggerDefaults({ ...DEFAULTS, ...parsed })))))
      ));
      try {
        const st = fs.statSync(p);
        id = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
      } catch { id = null; }
      this.lastRead = id ? { path: p, ...id, cfg: structuredClone(cfg) } : null;
      return cfg;
    } catch {
      this.lastRead = null;
      return withTranscribe(withResponseStyleDefault(withTriggerDefaults({ ...DEFAULTS })));
    }
  }

  _persist(next) {
    const p = this.file;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${Math.random().toString(36).slice(2, 10)}`;
    this.lastRead = null;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw e;
    }
    const view = withResponseStyleDefault(normalizeStoredHomes(withTriggerDefaults({ ...DEFAULTS, ...next })));
    for (const listener of this.listeners) {
      try { listener(view); } catch {}
    }
    return next;
  }

  write(patch) {
    const current = this.read();
    const next = { ...current, ...patch };
    if (Array.isArray(patch.registeredRepos)) {
      const seen = new Set();
      next.registeredRepos = patch.registeredRepos
        .map(r => expandTilde(r))
        .filter(r => r && !seen.has(r) && (seen.add(r), true));
    }
    if (typeof patch.harnessHome === 'string' && patch.harnessHome) {
      const { home, recentHives } = normalizeHiveHome(patch.harnessHome, current.recentHives ?? []);
      next.harnessHome = home;
      next.recentHives = recentHives;
    }
    if (patch.responseStyle !== undefined) {
      next.responseStyle = normalizeResponseStyle(patch.responseStyle);
    }
    return this._persist(next);
  }

  onWritten(listener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  pruneRecentHivesOnDisk(probe = probeHive) {
    const cfg = this.read();
    const before = cfg.recentHives ?? [];
    const after = pruneDeletedHives(before, cfg.harnessHome ?? undefined, probe);
    if (after.length === before.length) return [];
    this.write({ recentHives: after });
    return before.filter(h => !after.includes(h));
  }

  // ── one-shot migrations (each runs once, marks its flag) ──
  _migrateOpus55(cfg) {
    if (cfg.opus55DefaultMigrated || this.opus55MigrationRan) return cfg;
    this.opus55MigrationRan = true;
    try { return this._persistSilent(withOpus55Default(cfg)); } catch { return cfg; }
  }
  _migrateTemps(cfg) {
    if (cfg.tempsOnMigratedV053 || this.tempsMigrationRan) return cfg;
    this.tempsMigrationRan = true;
    try { return this._persistSilent({ ...cfg, orchestratorMaySpawn: true, tempsOnMigratedV053: true }); }
    catch { return cfg; }
  }
  _migrateTriggers(cfg) {
    if (cfg.triggersMigratedV1 || this.triggersMigrationRan) return cfg;
    this.triggersMigrationRan = true;
    try {
      const next = { ...cfg, triggersMigratedV1: true };
      const legacySecret = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret.trim() : '';
      if (legacySecret && (cfg.webhookTriggers?.length ?? 0) === 0) {
        next.webhookTriggers = [{
          id: 'legacy', name: 'Default webhook', secret: legacySecret,
          enabled: cfg.webhookEnabled ?? false,
          mode: DEFAULT_TRIGGER_MODE, schema: DEFAULT_WEBHOOK_SCHEMA,
          createdAt: Date.now(),
        }];
      }
      const missions = Array.isArray(cfg.missions) ? cfg.missions : [];
      const stale = m => m?.id === COMPACT_MAINTENANCE_MISSION.id
        && m.intervalMs === LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS;
      if (missions.some(stale)) {
        next.missions = missions.map(m => stale(m) ? { ...m, intervalMs: COMPACT_MAINTENANCE_MISSION.intervalMs } : m);
      }
      return this._persistSilent(next);
    } catch { return cfg; }
  }
  /** Persist during a migration without re-entering listeners' notify path. */
  _persistSilent(next) {
    const p = this.file;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${Math.random().toString(36).slice(2, 10)}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return next;
  }
}

module.exports = {
  ConfigStore, DEFAULTS, DEFAULT_CONTEXT_TRIGGER, DEFAULT_COMPACTION_FOCUS,
  OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION,
  SEEDED_COMPACT_TRIGGERS, SEEDED_COMPACT_MAINTENANCE_INTERVALS_MS,
  LEGACY_COMPACT_MAINTENANCE_INTERVAL_MS,
  DEFAULT_RESPONSE_STYLE, RESPONSE_STYLE_TAG, RESPONSE_STYLE_MAX,
  normalizeResponseStyle, renderResponseStyle, stripControls,
  expandTilde, normalizeHiveHome, normalizeStoredHomes, pruneDeletedHives, probeHive,
  defaultMcpDefaults, mcpEnabledFor, effectiveMcp, withAgentMcp, sanitizeAgentMcp,
  MAX_AGENT_TOKEN_CAP, withTriggerDefaults, withOpus55Default,
  PRE_OPUS55_DEFAULT_MODEL, PRE_OPUS55_GOD_MODEL,
};
