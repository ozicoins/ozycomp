'use strict';
/**
 * Harness — glues the planes together:
 *   terminal (PtyManager) + hooks (HookServer) + hive files (HiveManager)
 *   + governor (CircuitBreaker) + providers (buildLaunch) + telemetry (OTLP)
 *   + memory (MemoryManager/MemPalace) + knowledge (KnowledgeManager)
 *   + temps (spawn-request watcher) + automations + webhook ingress.
 *
 * The "god" agent is a privileged coordinator persona: it receives the user's
 * high-level ask, decomposes it, spawns workers, and scribes board.md. In this
 * build the god is itself a CLI agent (provider 'claude' by default) seeded
 * with a coordinator system prompt appended to its CLAUDE-style context.
 *
 * Headless: no Electron imports. The Electron main process (electron-main.js)
 * instantiates this class and proxies it over IPC to the renderer.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { PtyManager } = require('./pty-manager');
const { HiveManager, assertAgentId, dropAllCommitQueues } = require('./hive');
const { HookServer, WorkerWakeWatchdog } = require('./hook-server');
const { CircuitBreaker } = require('./circuit-breaker');
const { providerFor, providerFromCommand, buildLaunch, listProviders } = require('./providers');
const { TelemetryCollector, CumulativeSampleGate } = require('./telemetry');
const { MemoryManager } = require('./memory');
const { MemoryReflector } = require('./memory-reflector');
const { KnowledgeManager } = require('./kg');
const { TempsManager } = require('./temps');
const { AutomationsManager } = require('./automations');
const { WebhookServer } = require('./webhook-server');
const { SecretsStore } = require('./secrets');
const { resolveMcp, catalogForUi } = require('./mcp-catalog');
const { LicenseManager } = require('./license');
const { parseFloorArgs, floorDataDirFor, FloorRegistry } = require('./floors');
const { RelayClient } = require('./relay');
const { CliLoginWatcher, probeVersion } = require('./probes');
const bridges = require('./provider-bridges');
const { renderResponseStyle } = require('./config');
const { RestoreGateStore } = require('./session-resume');
const { CostLedgerTotals } = require('./cost-ledger-totals');

const GOD_ID = 'god';

const GOD_PROMPT = `You are the god/coordinator agent of an agentic office.
You own the hive at the working directory's ./hive folder:
  - hive/tasks.json    kanban (todo|doing|blocked|done)
  - hive/board.md      shared plan — YOU are the only scribe
  - hive/agents/<id>/inbox + outbox — JSON envelopes {from,to,act,body}
  - hive/PROTOCOL.md + COMMANDS.md — the wire protocol (already generated)
  - hive/spawn-requests/ — drop {objective,provider?,model?} to hire a temp
Decompose the user's ask into tasks, register them in tasks.json, and send
'task' envelopes to worker agents by writing to hive/agents/<worker>/inbox.
Report progress to the human by writing to hive/agents/god/outbox with
to=human. Keep board.md current. Do not do all the work yourself — delegate.
If KG_ROOT is set, run kg search before researching and kg note to record
what you learn so the whole office can reuse it.`;

class Harness extends EventEmitter {
  /**
   * @param {object} opts {hiveRoot, workDir, breaker: {}, defaultProvider,
   *   tempsEnabled():bool, kgEnabled():bool, mcpIds:[], secrets:SecretsStore}
   */
  constructor(opts = {}) {
    super();
    this.workDir = opts.workDir ?? process.cwd();
    this.hive = new HiveManager(opts.hiveRoot ?? path.join(this.workDir, 'hive'));
    // The node launcher + Windows hook-line machinery (verbatim): it lives on
    // the hive in the reference; here it is a NodeLauncher rooted at the hive
    // and exposed back onto the hive so ipc/pty's refreshNodeLauncher() reaches
    // it. reportHookLine feeds hookLineNotices; spawnAgent takes them once.
    this.nodeLauncher = new (require('./hive-node').NodeLauncher)(
      () => this.hive.root(),
      (e) => this.hive.log(e));
    this.hive.nodeLauncher = this.nodeLauncher;
    this.hive.refreshNodeLauncher = () => this.nodeLauncher.refreshNodeLauncher();
    this.hive.takeHookLineNotice = (p) => this.nodeLauncher.takeHookLineNotice(p);
    // verbatim ensureAgent (the launch-spec builder on the hive) reaches the
    // hook sock, the proxy sidecars and the provider installers through these —
    // the harness owns all three, so it injects them rather than the hive
    // importing the bridge/hook-server modules itself.
    this.hive.hooksSockPath = () => this.hooks.sockPath;
    this.hive.proxyBridges = this.proxyBridges ??= new bridges.ProxyBridges();
    this.hive._installers = bridges;
    // Bundled Patron company dir — dev resolves to the repo `company/`,
    // packaged to the app's `resources/company/` (electron-builder `files`).
    this.hive.companyResourceDir = () => {
      if (opts.companyResourceDir) return opts.companyResourceDir();
      let packaged = false;
      try { packaged = require('electron').app?.isPackaged === true; } catch {}
      return packaged ? path.join(process.resourcesPath, 'company')
                      : path.join(__dirname, '..', '..', 'company');
    };
    this.pty = new PtyManager();
    this.breaker = new CircuitBreaker(opts.breaker ?? {});
    // verbatim ~31752: the breaker beat's ledger gate — one CumulativeSampleGate
    // per harness, deciding which usage samples land in cost-ledger.jsonl.
    this.ledgerGate = new CumulativeSampleGate();
    // verbatim ~32632: the incremental cost-ledger fold — the fleet snapshot's
    // lifetime usd column. Refreshed on every snapshot write.
    this.costTotals = new CostLedgerTotals();
    // verbatim ~32633: 'starting' until the renderer's floor:state IPC moves it.
    this.floorState = 'starting';
    this.hooks = new HookServer({
      hive: this.hive,
      onHook: (a, h, p) => this._onHook(a, h, p),
      decide: (a, h, p) => this._decide(a, h, p),
      onUsageEvent: s => this._onCostSample(s),
      onStatus: (a, ctx) => this.emit('context-update', a, ctx),
      onControl: (agentId, tool, reason) => this.emit('control-gated', agentId, tool, reason),
    });
    this.defaultProvider = opts.defaultProvider ?? 'claude';
    this.watchdog = new WorkerWakeWatchdog({
      hive: this.hive, pty: this.pty, control: this.control,
      onNudge: (id, pending) => this.emit('wake-nudge', id, pending),
    });
    // verbatim name used by the pty layer (workerWake()?.noteSpawn/forget/holdsInput)
    this.workerWake = this.watchdog;
    // the hook server feeds every hook event to the watchdog (ref ~24930)
    this.hooks.watchdog = this.watchdog;
    // A terminal that ended is held in the restore gate (verbatim): the next
    // boot's captureEndedAtBoot reads it as ended — unless it respawned first.
    this.pty.on('exit', (id) => {
      try { this.restoreGate.hold(id); } catch {}
      try { this.brokerGrants?.release(id); } catch {}
    });

    // ── v2 planes ──────────────────────────────────────────────────────────
    this.secrets = opts.secrets ?? new SecretsStore({ home: this.workDir });
    this.telemetry = new TelemetryCollector({
      onUsage: (agentId, u) => {
        // feed the governor with real token/cost deltas
        if (u.tokens || u.costUsd) this.breaker.usage?.(agentId, u);
        this.emit('usage', agentId, u);
      },
      ledger: row => this.hive.ledgerAppend(row),
      // renderer-facing push sink — forwarded to webContents by electron-main
      emit: (ch, p) => this.emit('telemetry-event', ch, p),
      onApiError: (agentId) => this.breaker.recordError?.(agentId),
      // verbatim (ref ~31746-31749): scope the transcript fallback to this
      // agent's own cwd + session so a shared repo dir never sums other agents.
      resolveCwd: (agentId) => this.hive.registry().agents[agentId]?.cwd ?? null,
      resolveSessionId: (agentId) => this.hive.lastSession(agentId),
    });
    this.memory = new MemoryManager({ hive: this.hive, home: this.workDir });
    // verbatim ~31816-31838: the memory-reflection condenser. Home follows the
    // config's harnessHome like the verbatim getHome thunk (the clone's
    // readConfig() exposes it); command mirrors readConfig().defaultCommand;
    // appendLog feeds hive log.jsonl (the same sink condense events land in
    // upstream). The reflector is the verbatim subsystem — the clone's
    // MemoryManager.compact() is the simpler byte-cap fold only.
    const cfg = opts.readConfig ?? (() => ({}));
    this._readConfig = cfg;   // start()'s hygiene/retention sweeps read the same thunk
    this.reflector = new MemoryReflector(
      () => cfg().harnessHome ?? this.workDir,
      () => cfg().defaultCommand ?? 'claude',
      () => this.memory.env(),
      () => {
        const c = cfg();
        return {
          enabled: c.reflectEnabled !== false,
          intervalMs: c.reflectIntervalMs ?? 18e5,
          byteTriggerPct: c.reflectByteTriggerPct ?? 50,
          sectionTrigger: c.reflectSectionTrigger ?? 50,
          recentKeep: c.reflectRecentKeep ?? 12,
          minBytes: c.reflectMinBytes ?? 16384,
        };
      },
      (event) => { try { this.hive.log(event); } catch {} },
    );
    this.kg = new KnowledgeManager({ home: this.workDir, enabled: opts.kgEnabled });
    this.license = new LicenseManager({ home: this.workDir, emit: (e, v) => this.emit(e, v) });
    this.floors = new FloorRegistry(this.workDir);
    this.mcpIds = opts.mcpIds ?? [];                  // catalog ids attached by the user

    this.temps = new TempsManager({
      hive: this.hive,
      enabled: opts.tempsEnabled ?? (() => true),
      emit: (e, v) => this.emit(e, v),
      spawnAgent: (id, m) => this.spawnAgent(id, m).then(a => {
        if (m.slack) this.slack?.bindWorker(id, m.slack);
        return a;
      }),
      // verbatim ~37399-37417 deps: the spawn brief's reply command, memory
      // index, KG line and node command come from the same singletons the
      // reference reads at module scope.
      slackReplyScriptPath: () => this.slackReplyScriptPath?.() ?? 'md-slack-reply.cjs',
      memory: () => this.memory,
      knowledge: () => this.kg,
      nodeCommand: () => this.hive?.nodeCommand?.() ?? 'node',
      liveWorkers: this.liveWorkers ??= new Map(),
      usageOf: (id) => { const s = this.telemetry?.getAgentUsage?.(id); return s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0; },
      // verbatim ~37475 reaper deps: the preserved-worktree ledger shares the
      // map ipc/git.js + ipc/misc.js read; pty/config/teardown are lazy so the
      // headless harness never dereferences a missing window layer.
      preservedWorktrees: this.preservedWorktrees ??= new Map(),
      pty: () => this.pty,
      readConfig: this._readConfig ?? (() => ({})),
      teardownPty: (id, reason) => this.teardownPty?.(id, reason),
      worktreeDeps: require('./worktree-deps').unlinkWorktreeDeps
        ? { unlinkWorktreeDeps: require('./worktree-deps').unlinkWorktreeDeps,
            worktreeIsGcSafe: (w, b) => require('./ipc/git').worktreeIsGcSafe(w, b),
            removeWorktree: (c, w) => require('./ipc/git').removeWorktree(c, w),
            worktreeHasUnintegratedWork: (w, b) => require('./ipc/git').worktreeHasUnintegratedWork(w, b) }
        : null,
    });
    this.automations = new AutomationsManager({
      hive: this.hive,
      send: (id, text) => this.send(id, text),
      emit: (e, v) => this.emit(e, v),
    });
    this.webhook = new WebhookServer({
      hive: this.hive, home: this.workDir,
      emit: (e, v) => this.emit(e, v),
    });
    this.slack = null;   // set via enableSlack(cfg)
    this.relay = null;   // set via enableRelay(cfg) — cross-floor link
    this.brokerGrants = opts.brokerGrants ?? null; // BrokerGrants — .broker file + per-worker capability
    this.loginWatcher = new CliLoginWatcher({
      pty: this.pty, emit: (e, id, hint) => this.emit(e, id, hint),
    });
    // this.proxyBridges is created up at the hive-wiring block (this.hive.proxyBridges).
    this._steers = new Map();   // agentId → [steer reason] (breaker steering)
    /** The goal last delivered to each agent's current session. Goals are durable
     *  roster state, so repeating an unchanged multi-kilobyte briefing on every
     *  prompt only bloats the transcript. One entry per agent is sufficient: an
     *  agent has one live session, and a new session id replaces the old entry. */
    this.deliveredGoalByAgent = new Map();

    this.floorArgs = opts.floorArgs ?? parseFloorArgs();
    this._responseStyle = opts.responseStyle ?? (() => '');
    this.restoreGate = new RestoreGateStore(() => this.hive.root());
    this._started = false;
  }

  /** Attach the cross-floor relay (called by the config layer when enabled). */
  enableRelay(cfg = {}) {
    this.relay = new RelayClient({
      hive: this.hive, home: this.workDir,
      floorId: cfg.floorId ?? 'floor', token: cfg.token,
      emit: (e, v) => this.emit(e, v),
    });
    this.relay.start();
  }

  async start() {
    if (this._started) return;
    this.hive.ensure();
    this.captureEndedAtBoot();
    this.archiveOrphanedAgents();
    await this.hooks.start();
    await this.telemetry.start();
    // verbatim ~37726: only now is the collector bound — point newly-spawned
    // claude agents at it. Spawns before this line keep telemetry off.
    this.hive.setOtelEndpoint(this.telemetry.endpoint());
    await this.webhook.start();
    this.hive.startRouting();
    // verbatim ~37702: one whole-repo scan at app start (untracked cache off).
    this.hive.scanCommitsAtStart();
    // verbatim ~37705-37706: the two hourly sweeps start here, after the router
    // — task hygiene (kanban archive + board-size ask) and retention (the
    // RETENTION_POLICIES table over ledgers, backups and archives). The IPC
    // shim layer installs applyTaskHygiene/hygieneState/appendBoardArchive on
    // the hive at register() time; a headless harness never runs register(), so
    // the sweep installs them lazily the same way.
    try {
      const cfg = this._readConfig ?? (() => ({}));
      require('./ipc/hive').installHiveVerbatim(this.hive, () => cfg().harnessHome ?? this.workDir);
      this.taskHygiene = { stop: () => require('./retention').stopTaskHygiene() };
      require('./retention').startTaskHygiene(this.hive, { readConfig: cfg });
      this.retention = { stop: () => require('./retention').stopRetention() };
      require('./retention').startRetention(() => ({ hiveRoot: this.hive.root(), harnessHome: cfg().harnessHome ?? null }));
    } catch (e) {
      console.error('[harness] hygiene/retention start failed:', e);
    }
    this.temps.start();
    this.automations.start();
    this.memory.startMining();          // no-op without `mempalace` on PATH
    // verbatim ~37731: the reflector's interval starts with the rest of the
    // boot-time subsystems — after the hive is ensured and the memory miner is
    // armed, gated internally by reflectEnabled + harnessHome.
    this.reflector.start();
    this.license.startChecking();
    this._fleetTimer = setInterval(() => this._writeFleetSnapshot(), 8_000);
    this._fleetTimer.unref?.();
    this._writeFleetSnapshot();
    this.armAlwaysOnBeats();
    this._started = true;
    this.emit('started', {
      hookPort: this.hooks.port, hookSock: this.hooks.sockPath,
      otelEndpoint: this.telemetry.endpoint(), webhookPort: this.webhook.boundPort,
    });
  }

  /** verbatim ~37818 armAlwaysOnBeats: fleet snapshot (8s) + breaker beat
   *  (30s) + worker-wake (15s, already the watchdog's own timer) + hook-health
   *  (15s). The wake watchdog owns its own interval, so this arms only the two
   *  beats the harness side must drive. `liveWebContents`/`breakerToast` are
   *  injected by the IPC layer; headless they no-op. */
  armAlwaysOnBeats() {
    const HB = require('./heartbeat');
    if (this._breakerBeatTimer) clearInterval(this._breakerBeatTimer);
    this._breakerBeatTimer = setInterval(() => {
      try { this.runBreakerBeat(3e5); } catch (e) { console.error('[breaker beat]', e); }
    }, 3e4);
    this._breakerBeatTimer.unref?.();
    // workerWake beat — the watchdog's own 15s interval (ref ~37761), already
    // armed in the WorkerWakeWatchdog ctor.
    if (this._hookHealthTimer) clearInterval(this._hookHealthTimer);
    this._hookHealthTimer = setInterval(() => {
      this.hooks.ensureListening().catch((e) => console.error('[hooks beat]', e));
    }, 15e3);
    this._hookHealthTimer.unref?.();
  }
  /** verbatim ~32569: one breaker pass — fold new cost samples into the ledger,
   *  record sessions, then feed every live agent's progress/work signals into
   *  breaker.tick and act on steer/constrain/stop. */
  runBreakerBeat(progressWindowMs) {
    const { sampleProvesConversation } = require('./memory-rules');
    const { lastCoordinationAt, lastWorkAt } = require('./heartbeat');
    if (!this.hive.enabled?.() && !this.hive.root()) return;
    const reg = this.hive.registry();
    const now = Date.now();
    const inputs = [];
    for (const [id, a] of Object.entries(reg.agents)) {
      if (a.archived) continue;
      if (a.isAssistant) continue;
      const ptyId = this.ptyForAgent?.(id) ?? (this.pty.get(id)?.alive ? id : null);
      if (id !== reg.godId && !ptyId) continue;
      const sample = this.telemetry?.getAgentUsage?.(id);
      if (sample?.sessionId) {
        const moved = this.ledgerGate?.admits?.(sample, { ignoreTs: a.provider === 'grok' });
        if (moved) this.hive.appendCostLedger?.(sample);
      }
      if (sample?.sessionId && sampleProvesConversation(sample)) this.hive.recordSession(id, sample.sessionId);
      if (id === reg.godId) continue;
      const spans = this.telemetry?.getSpans?.(id) ?? [];
      const lastSpanAt = spans.length ? spans[spans.length - 1].ts : 0;
      inputs.push({
        agentId: id,
        sample,
        progressing: now - lastCoordinationAt({ hive: this.hive }, id) < progressWindowMs || now - lastSpanAt < progressWindowMs,
        lastWorkAt: lastWorkAt({ hive: this.hive }, id),
      });
    }
    for (const d of this.breaker.tick(inputs, now)) {
      try { this.liveWebContents?.()?.send?.('control:breakerState', d.state); } catch {}
      if (d.action === 'none') continue;
      const name = reg.agents[d.state.agentId]?.name ?? d.state.agentId;
      const reason = d.state.reason;
      if (d.action === 'steer') {
        this.hive.send({
          to: d.state.agentId, act: 'request', subject: 'Circuit breaker: steer',
          body: `Automated guardrail: ${reason}. Re-check your approach — if you're looping or stuck, STOP repeating, summarize what you've tried, and ask god for direction.`,
        }, 'breaker');
      } else if (d.action === 'constrain') {
        this.hive.send({
          to: d.state.agentId, act: 'request', subject: 'Circuit breaker: constrain',
          body: `Automated guardrail escalated: ${reason}. Stop active work now: switch to read-only/plan, write a short plan of your next step, and send it to god for sign-off BEFORE running more tools.`,
        }, 'breaker');
        this.breakerToast?.(`${name} constrained`, reason);
      } else if (d.action === 'stop') {
        const ptyId = this.ptyForAgent?.(d.state.agentId) ?? (this.pty.get(d.state.agentId)?.alive ? d.state.agentId : null);
        if (ptyId) {
          try { this.pty.kill(ptyId); } catch {}
          this.teardownPty?.(ptyId, 'guardrail');
        }
        this.breakerToast?.(`${name} stopped by circuit breaker`, reason);
      }
    }
  }

  /** Boot-capture the restore gate + drop ids the registry forgot (verbatim). */
  captureEndedAtBoot() {
    try {
      const ended = this.restoreGate.snapshot();
      this.restoreGate.prune(Object.keys(this.hive.registry().agents));
      console.log("[restore-gate] ended in the previous session:", ended.length);
    } catch (e) {
      console.error("[restore-gate] captureEndedAtBoot failed:", e);
    }
  }
  /** Boot sweep: an agent with no live PTY is archived (verbatim migration). */
  archiveOrphanedAgents() {
    try {
      const reg = this.hive.registry();
      for (const [id, a] of Object.entries(reg.agents)) {
        if (a.archived) continue;
        if (id === reg.godId) continue;
        if (this.pty.get(id)?.alive) continue;
        this.setArchived(id, true);
        try {
          this.emit('agent-archived', { id });
        } catch {
        }
        console.log("[migration] archived orphaned agent (no live PTY):", id);
      }
    } catch (e) {
      console.error("[migration] archiveOrphanedAgents failed:", e);
    }
  }
  /** Set the registry archived flag on an agent (verbatim setArchived). */
  setArchived(id, archived = true) {
    const reg = this.hive.registry();
    const a = reg.agents?.[id];
    if (!a) return;
    a.archived = archived === true;
    this.hive.writeRegistry(reg);
  }

  /** Attach a Slack bridge (called by the config layer when tokens exist). */
  enableSlack(bridge) {
    this.slack = bridge;
    bridge.start();
    this.on('temp-spawned', ({ id, manifest }) => { if (manifest.slack) bridge.bindWorker(id, manifest.slack); });
  }

  /**
   * Spawn an agent PTY under harness control.
   * opts: {provider, command, model, cwd, prompt, role, name, auto, resume,
   *        isolate, tokenCap, slack, character, accent, cols, rows, mcpIds}
   */
  async spawnAgent(id, opts = {}) {
    assertAgentId(id);
    const provider = opts.provider ? providerFor(opts.provider)
      : opts.command ? providerFor(providerFromCommand(opts.command))
      : providerFor(this.defaultProvider);

    // isolate → own git worktree under workspaces/<id>-wt (when in a repo)
    let cwd = opts.cwd ?? path.join(this.workDir, 'workspaces', id);
    if (opts.isolate) cwd = this._isolateWorktree(id, cwd) ?? cwd;
    fs.mkdirSync(cwd, { recursive: true });

    // resolve attached MCP servers (secret tier pulls from the secrets store)
    const mcpSpecs = (opts.mcpIds ?? this.mcpIds)
      .map(mid => resolveMcp(mid, { cwd, secrets: this.secrets.envFor(['GITHUB_PERSONAL_ACCESS_TOKEN', 'DATABASE_URL', 'GOOGLE_OAUTH_TOKEN', 'BRAVE_API_KEY']) }))
      .filter(r => r && !r.error);

    const launch = buildLaunch(provider, {
      command: opts.command, model: opts.model, auto: opts.auto ?? true,
      prompt: opts.prompt, resume: opts.resume,
      agentId: id, agentName: opts.name ?? id,
      systemPrompt: id === GOD_ID ? GOD_PROMPT : undefined,
      otelEndpoint: provider.supportsOtel ? this.telemetry.endpoint() : null,
    });

    const env = {
      ...this.hooks.envFor(),
      OZYC_HIVE: this.hive.root(),
      HIVE_AUTO_APPROVE: (opts.auto ?? true) ? '1' : '0',
      ...this.memory.env(),
      ...this.kg.env(),
      ...launch.env,
    };
    for (const m of mcpSpecs) Object.assign(env, m.env);

    // per-provider bridge installs (per-agent config dirs / global hook files,
    // proxy sidecars) — best-effort, must run BEFORE the PTY spawn so the CLI
    // picks up its env/config on first boot. Writable roots let codex's
    // workspace-write sandbox reach the hive folders.
    const agentDir = this.hive.agentDir(id);
    const writableRoots = [...new Set([cwd, agentDir, this.hive.root()])];
    try {
      const bridge = provider.bridge;
      if (bridge?.kind === 'hooks') {
        if (bridge.shim === 'agy') bridges.installAgyHooks(console.error, this.nodeLauncher);
        else if (bridge.shim === 'codex') {
          const codex = bridges.installCodexHooks(agentDir, id, cwd, writableRoots, console.error, this.nodeLauncher);
          // Session exposure at spawn (verbatim ~9560): the verbatim mover
          // lives on the hive — the bridge's own sessions/archived_sessions
          // symlink loop below covers the same dirs only for the empty case.
          this.hive.exposeCodexDataDirs(codex.home, path.join(os.homedir(), '.codex'), id);
          env.CODEX_HOME = codex.home;
          launch.args.unshift('--dangerously-bypass-hook-trust');
          if (!codex.rootsInConfig)
            for (const d of writableRoots) launch.args.unshift('--add-dir', d);
        }
        else if (bridge.shim === 'pi') env.PI_CODING_AGENT_DIR = bridges.installPiHooks(agentDir);
        else if (bridge.shim === 'opencode') env.OPENCODE_CONFIG_DIR = bridges.installOpenCodePlugin(agentDir, opts.theme);
        else if (bridge.shim === 'gemini') env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = bridges.installGeminiHooks(agentDir, console.error, this.nodeLauncher);
        else if (bridge.shim === 'grok') bridges.installGrokHooks(console.error, this.nodeLauncher);
      } else if (bridge?.kind === 'proxy' && this.hooks.sockPath) {
        const sessionId = bridges.proxySessionId(this.hive.root() + id, id);
        env.HIVE_PROXY_SESSION = sessionId;
        const upstream = process.env[bridge.baseUrlEnv]
          || (bridge.api === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
        const port = await this.proxyBridges.startWithRetry(id, {
          sock: this.hooks.sockPath, sessionId, api: bridge.api, upstream,
        });
        if (port > 0) {
          const loopback = `http://127.0.0.1:${port}`;
          if (provider.id === 'crush') {
            const crush = bridges.installCrushConfig(agentDir, loopback, bridge.api, opts.theme);
            env.CRUSH_GLOBAL_CONFIG = agentDir;
            env.CRUSH_GLOBAL_DATA = crush.data;
          } else {
            env[bridge.baseUrlEnv] = loopback;
          }
        } else {
          const degraded = `${opts.name ?? id} is running without hive events: its proxy bridge did not bind after ${bridges.PROXY_BIND_ATTEMPTS} attempts. Live status, cost and inbox wake will not work for this session.`;
          this.hive.log({ kind: 'proxy-degraded', agentId: id, provider: provider.id });
          this.emit('hive-degraded', { agentId: id, reason: 'proxy-bind', message: degraded });
        }
      }
    } catch (e) {
      this.hive.log({ kind: 'bridge-install-failed', agentId: id, provider: provider.id, error: String(e?.message ?? e) });
    }

    // verbatim ~8046: a Windows hook line that could not be made runnable rides
    // the first spawn after it was found — take the provider's queued notice
    // once and surface it as a degraded agent on the floor.
    const hookNotice = provider.id ? this.nodeLauncher.takeHookLineNotice(provider.id) : undefined;
    if (hookNotice) {
      this.emit('hive-degraded', { agentId: id, reason: 'hook-command', message: hookNotice });
    }

    // Registry record only — the verbatim ensureAgent(meta,opts) launch-spec
    // lives on the hive for the pty:spawn path; this clone spawn path builds
    // its own args/env above, so it takes the registry row via _registerAgent.
    const agent = this.hive._registerAgent(id, {
      provider: provider.id, name: opts.name, role: opts.role,
      slack: opts.slack, character: opts.character, accent: opts.accent,
      tokenCap: opts.tokenCap,
    });
    if (opts.tokenCap) this.breaker.setTokenCap(id, opts.tokenCap);
    // Integration broker (verbatim): grant a per-worker capability token and
    // drop the .broker file into the agent dir so the CLI can re-read it.
    // env merges BEFORE spawn; on a failed spawn the grant is released.
    Object.assign(env, this.brokerGrants?.grant(id, agentDir) ?? {});
    const p = this.pty.spawn(id, {
      provider: provider.id,
      command: launch.command,
      args: launch.args,
      cwd, env,
      cols: opts.cols, rows: opts.rows,
    });
    // The agent is running again — it is no longer an ending (verbatim gate).
    this.restoreGate.release(id);

    // seed context files the CLI will pick up (per-provider conventions)
    this._seedContext(id, cwd, opts, provider, mcpSpecs, writableRoots);

    // type-into-tui providers get their seed prompt typed after boot
    if (launch.seedPrompt) {
      const text = launch.seedPrompt;
      setTimeout(() => this.pty.typeAndSubmit(id, text), 3000).unref?.();
    }

    this.hive.log({ kind: 'agent-spawned', id, provider: provider.id, pid: p.pid, isolate: !!opts.isolate });
    this.emit('agent-spawned', { id, provider: provider.id, pid: p.pid });
    return agent;
  }

  /** Create a git worktree for the agent when the workspace is inside a repo. */
  _isolateWorktree(id, base) {
    const wt = path.join(this.workDir, 'worktrees', id);
    const probe = spawnSync('git', ['-C', base, 'rev-parse', '--git-dir'], { encoding: 'utf8' });
    if (probe.status !== 0) return null;
    const r = spawnSync('git', ['-C', base, 'worktree', 'add', '--detach', wt, 'HEAD'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    this.hive.log({ kind: 'worktree', id, path: wt });
    return wt;
  }

  _seedContext(id, cwd, opts, provider, mcpSpecs = [], writableRoots = []) {
    const isGod = id === GOD_ID;
    const hive = this.hive.root();
    const ctx = [
      `# Agent ${id} (${opts.role ?? (isGod ? 'god' : 'worker')})`,
      isGod ? GOD_PROMPT.replaceAll('./hive', hive).replaceAll('hive/', `${hive}/`) : '',
      `Hive root: ${hive}`,
      `Read ${hive}/PROTOCOL.md and ${hive}/COMMANDS.md for the wire protocol.`,
      `Messages for you arrive as JSON files in ${hive}/agents/${id}/inbox/ — read, act, then delete them.`,
      `To message another agent write {"from":"${id}","to":"<id>","act":"report","body":"…"} as a new .json file in ${hive}/agents/${id}/outbox/.`,
      `Your durable memory is ./memory.md — keep it short and current.`,
      this.kg.enabled() ? `Knowledge graph: kg search|note|add|get|list|stats (KG_ROOT is set).` : '',
    ].filter(Boolean).join('\n\n');
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'])
      fs.writeFileSync(path.join(cwd, f), ctx, 'utf8');

    // memory.md lives in the hive, symlinked into the workspace
    this.memory.ensure(id, opts.name ?? id);
    const memSrc = this.memory.file(id);
    const memLink = path.join(cwd, 'memory.md');
    try { if (!fs.existsSync(memLink)) fs.symlinkSync(memSrc, memLink); } catch {}

    // packaged office skills → the agent's own .claude/skills dir
    const skillsSrc = path.join(__dirname, '..', '..', 'skills');
    const skillsDst = path.join(cwd, '.claude', 'skills');
    if (provider.id === 'claude' && fs.existsSync(skillsSrc)) {
      try { fs.cpSync(skillsSrc, skillsDst, { recursive: true }); } catch {}
    }

    // MCP attachments (Claude reads .mcp.json)
    if (mcpSpecs.length && provider.id === 'claude') {
      const mcpJson = { mcpServers: {} };
      for (const m of mcpSpecs)
        mcpJson.mcpServers[m.id] = { command: m.command, args: m.args, env: m.env };
      fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify(mcpJson, null, 2), 'utf8');
    }

    // hook plane: Claude gets a per-session settings.json carrying the full
    // hook matrix + statusLine gauge + OS sandbox pinning the hive dirs — the
    // verbatim hookSettings() shape (ref ~8385). Written to the agent dir and
    // pointed at by --settings on the verbatim path; here we seed the same file
    // plus a .claude/settings.local.json copy so the legacy spawn picks it up.
    const hookBin = path.join(__dirname, '..', '..', 'bin', 'hive-hook.cjs');
    if (provider.id === 'claude') {
      const launcher = this.nodeLauncher;
      const { hookSettings } = require('./hook-settings');
      const settings = hookSettings(
        launcher ?? { nodeRun: s => `node "${s}"`, nodeRunSh: s => `node "${s}"` },
        hookBin, cwd, opts.mcpDefaults, opts.theme, writableRoots, opts.outputStyle, undefined);
      // verbatim ~8084 writes <agentDir>/settings.json; the legacy seed path
      // also needs it at cwd/.claude/settings.local.json for the CLI to read.
      this.hive.atomicWriteJson?.(path.join(this.hive.agentDir(id), 'settings.json'), settings);
      fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify(settings, null, 2), 'utf8');
    } else if (provider.bridge?.kind === 'hooks' && !this._bridged(provider)) {
      // fallback for hook-shimmed CLIs we don't have a dedicated installer for:
      // drop a hint file pointing at the generic shim
      const shimBin = path.join(__dirname, '..', '..', 'bin', 'hook-shim.cjs');
      fs.mkdirSync(path.join(cwd, '.ozycomp'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.ozycomp', 'hook-shim.json'), JSON.stringify({
        shim: provider.bridge.shim, bin: shimBin,
        usage: `node "${shimBin}" tool <name> [ok] | session | stop [questionId] | notify <text>`,
      }, null, 2), 'utf8');
    }
  }

  /** Providers whose bridge was already installed by provider-bridges.js. */
  _bridged(provider) {
    return ['agy', 'codex', 'pi', 'opencode', 'gemini', 'grok'].includes(provider.bridge?.shim);
  }

  /** Type text into an agent and submit it (with proof record). */
  async send(id, text) {
    const action = this.breaker.actionFor(id);
    if (action.action === 'stop')
      return { ok: false, reason: `circuit-open:${action.reason}` };
    if (action.action === 'steer')
      this._steer(id, action.reason);
    const proof = await this.pty.typeAndSubmit(id, text);
    if (proof.ok) {
      this.hive.log({ kind: 'submit', agent: id, bytes: proof.bytes });
      this.breaker.progress(id);
    }
    return proof;
  }

  _steer(id, reason) {
    this.hive.send(
      { to: id, act: 'steer',
        body: `Circuit breaker noticed: ${reason}. Vary your approach — stop repeating identical calls.` },
      'god');
    this._queueSteer(id, reason);
    this.emit('steer', id, reason);
  }

  /** Hive-level message from the human to an agent (verbatim send envelope). */
  steer(id, body) { return this.hive.send({ to: id, act: 'steer', body }, 'human'); }

  _onHook(agentId, hook, payload) {
    if (hook === 'PostToolUse') {
      const sig = payload?.tool_sig ?? payload?.tool_name ?? 'unknown';
      this.breaker.recordTool(agentId, sig, {
        ok: payload?.ok !== false,
        tokens: payload?.tokens ?? 0,
        costUsd: payload?.costUsd ?? 0,
      });
      if (payload?.progress) this.breaker.progress(agentId);
    } else if (hook === 'Stop' && payload?.questionId) {
      this.emit('open-question', this.hooks.questions.list().at(-1));
    } else if (hook === 'SessionStart' || hook === 'PostCompact') {
      this.breaker.compacted(agentId);
    } else if (hook === 'UserPromptSubmit') {
      this.breaker.progress(agentId);
    } else if (hook === 'Stop' || hook === 'SubagentStop') {
      this.emit('agent-idle', agentId);
      this._drainInboxOnStop(agentId);
    }
    this.emit('hook', agentId, hook, payload);
  }

  /**
   * Hook decision plane — the reference's control path: a stopped breaker
   * halts the agent outright; a steering note rides back as additionalContext;
   * god gets the LIVE roster injected on SessionStart/UserPromptSubmit.
   * Returns the Claude-shaped reply object the shim prints to the CLI.
   */
  _decide(agentId, event, p) {
    if (!agentId) return {};
    const action = this.breaker.actionFor(agentId);
    if (action.action === 'stop')
      return { continue: false, stopReason: `Halted by the operator from the floor. (${action.reason})` };
    if (event === 'Stop' || event === 'SubagentStop') {
      // honor stop_hook_active loops like the reference: let recursion finish
      if (p?.stop_hook_active) return {};
      const mail = this._peekInbox(agentId);
      if (mail > 0)
        return { decision: 'block', reason: `You have ${mail} unread message(s) in your inbox (${this.hive.agentDir(agentId)}/inbox). Read and act on them before going idle.` };
      return {};
    }
    let steer = null;
    if ((event === 'UserPromptSubmit' || event === 'PostToolUse') && this._steers.get(agentId)?.length) {
      steer = `[operator steering] ${this._takeSteer(agentId)}`;
    }
    const roster = (event === 'SessionStart' || event === 'UserPromptSubmit')
      ? this._rosterContext(agentId) : null;
    const wantsGoal = event === 'SessionStart' || event === 'UserPromptSubmit';
    const goalRaw = wantsGoal ? this._standingGoal(agentId) : null;
    let goal = null;
    if (wantsGoal) {
      const sessionId = p?.session_id ?? null;
      const delivered = this.deliveredGoalByAgent.get(agentId);
      const newSession = !delivered || delivered.sessionId !== sessionId;
      const changed = !!delivered && delivered.sessionId === sessionId && delivered.goal !== goalRaw;
      if (event === 'SessionStart' || newSession || changed) {
        this.deliveredGoalByAgent.set(agentId, { sessionId, goal: goalRaw });
        if (goalRaw) {
          goal = `<goal>\n${goalRaw}\n</goal>`;
        } else if (changed && delivered?.goal) {
          goal = "<goal>\n[Cleared by the operator. Stop following the previous standing goal.]\n</goal>";
        }
      }
    }
    const style = wantsGoal ? renderResponseStyle(this._responseStyle?.() ?? '') : null;
    if (steer || roster || goal || style) {
      return {
        hookSpecificOutput: {
          hookEventName: event,
          // ORDER, deliberately: style, roster, goal, steer.
          //  - The style leads because it is the only invariant piece. It is the
          //    same text on every turn for every agent, so putting it ahead of the
          //    roster (whose token/cost/ctx numbers move every turn) keeps the
          //    stable prefix of this block stable.
          //  - The style is HOW to answer and the goal is WHAT to do, so the goal
          //    sits closer to the work: a standing tone brief must never read as
          //    if it outranks the mission.
          //  - The steer stays last, where it already was. It is the operator
          //    speaking about THIS turn, and the most immediate instruction is
          //    the one that should be read last.
          additionalContext: [style, roster, goal, steer].filter(Boolean).join("\n\n")
        }
      };
    }
    return {};
  }

  /** The agent's standing goal (verbatim: roster snapshot 'goal' field wins). */
  _standingGoal(agentId) {
    try {
      const reg = this.hive.registry();
      const goal = reg.agents?.[agentId]?.goal;
      return typeof goal === 'string' && goal.trim() ? goal.trim() : null;
    } catch { return null; }
  }

  _peekInbox(agentId) {
    try {
      return fs.readdirSync(path.join(this.hive.agentDir(agentId), 'inbox'))
        .filter(f => f.endsWith('.json')).length;
    } catch { return 0; }
  }

  /** On Stop: nudge the agent to drain pending inbox mail (work-order type-in). */
  _drainInboxOnStop(agentId) {
    const pending = this._peekInbox(agentId);
    if (!pending) return;
    const a = this.pty.get(agentId);
    if (a?.alive) setTimeout(() =>
      this.pty.typeAndSubmit(agentId, `check your inbox — ${pending} message(s) waiting under hive/agents/${agentId}/inbox`), 800).unref?.();
  }

  _queueSteer(id, reason) {
    const q = this._steers.get(id) ?? [];
    q.push(reason ?? 'steer');
    this._steers.set(id, q);
    this.emit('steer-queued', { id, reason });
  }
  _takeSteer(id) {
    const q = this._steers.get(id);
    if (!q?.length) return null;
    this._steers.delete(id);
    return q.join(' · ');
  }

  /**
   * Live roster line for god — the reference pushes fleet.json into god's
   * context on every turn so a resumed session can't message archived agents.
   * The verbatim implementation is installed onto the hive by
   * installHiveVerbatim (ipc/hive.js); the inline copy below is the fallback for
   * a harness that never ran the verbatim installer.
   */
  _rosterContext(agentId) {
    if (agentId !== GOD_ID) return null;
    if (typeof this.hive.rosterContext === 'function')
      return this.hive.rosterContext((id) => this.hooks.contextFor(id));
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(this.hive.root(), 'fleet.json'), 'utf8'));
      const agents = Array.isArray(snap.agents) ? snap.agents : [];
      if (!agents.length) return null;
      const ago = s => typeof s !== 'number' ? 'unknown' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
      const rows = agents.slice(0, 24).map(a => {
        const bits = [a.role ?? 'agent',
          typeof a.lastActiveSecAgo === 'number' ? `active ${ago(a.lastActiveSecAgo)}` : 'no activity yet'];
        if (a.tokens) bits.push(`${Math.round(a.tokens / 1e3)}k tok`);
        if (a.usd) bits.push(`$${a.usd.toFixed(2)}`);
        if (a.inboxBacklog) bits.push(`inbox ${a.inboxBacklog}`);
        if (a.isGod) bits.push('you');
        const cw = this.hooks.contextFor(a.id);
        if (cw?.limit > 0) bits.push(`ctx ${Math.round(cw.tokens / cw.limit * 100)}%`);
        return `${a.id}${a.name ? ` "${a.name}"` : ''} (${bits.join(', ')})`;
      });
      const more = agents.length > 24 ? ` +${agents.length - 24} more` : '';
      return `[LIVE ROSTER — auto-injected from fleet.json] ${agents.length} ACTIVE agent(s): ${rows.join('; ')}.${more} This is the CURRENT floor and it SUPERSEDES any roster earlier in this conversation — agents you remember that are absent here have been archived or killed, so do not message them. Route work to someone on this list before spawning anyone new.`;
    } catch { return null; }
  }

  /** CostSample event → usage ledger + governor feed (verbatim shape). */
  _onCostSample(s) {
    try { this.hive.ledgerAppend?.(s); } catch {}
    if (s.input || s.output)
      this.breaker.usage(s.agentId, { tokens: (s.input ?? 0) + (s.output ?? 0) });
    this.emit('usage', s.agentId, s);
  }

  /** fleet.json snapshot writer — the file god's roster context reads
   *  (verbatim writeFleetSnapshot ~32646): lifetime usd from the incremental
   *  cost-ledger fold, per-agent last tool + activity age, breaker level,
   *  onHold, hook-socket health and the floor state. */
  _writeFleetSnapshot() {
    try {
      const reg = this.hive.registry();
      const snap = this.telemetry.snapshot();
      const usageById = new Map(snap.usage.map((u) => [u.agentId, u]));
      const now = Date.now();
      const hiveRoot = this.hive.root();
      if (hiveRoot) void this.costTotals.refresh(path.join(hiveRoot, 'cost-ledger.jsonl'));
      const agents = Object.entries(reg.agents).filter(([, a]) => !a.archived).map(([id, a]) => {
        const u = usageById.get(id);
        const spans = snap.spans[id] ?? [];
        const tokens = u ? u.input + u.output + u.cacheRead + u.cacheCreation : 0;
        const lifetime = this.costTotals.usdFor(id);
        const sessionUsd = u ? Number(u.usd.toFixed(4)) : 0;
        return {
          id,
          name: a.name,
          role: a.role ?? (a.isGod ? 'orchestrator' : 'agent'),
          cwd: a.cwd,
          isGod: !!a.isGod,
          breaker: this.breaker.levelFor(id),
          tokens,
          usd: lifetime === null ? sessionUsd : Number(lifetime.toFixed(4)),
          sessionUsd,
          lastTool: spans.length ? spans[spans.length - 1].tool : null,
          lastActiveSecAgo: u ? Math.round((now - u.ts) / 1e3) : null,
          inboxBacklog: this.hive.inboxBacklog?.(id) ?? this._peekInbox(id),
          onHold: !!a.onHold,
        };
      });
      const snapshot = { ts: now, floor: this.floorState, agents, hooks: this.hooks.health() };
      if (typeof this.hive.writeFleetSnapshot === 'function') this.hive.writeFleetSnapshot(snapshot);
      else fs.writeFileSync(path.join(hiveRoot, 'fleet.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (e) {
      console.error('[fleet] snapshot failed:', e);
    }
  }

  /** Answer an open question → envelope to the asking agent. */
  answerQuestion(qid, answer) {
    const q = this.hooks.questions.answer(qid, answer);
    if (q) this.hive.send({ to: q.agent, act: 'answer', body: answer, questionId: qid }, 'human');
    return q;
  }

  status() {
    return {
      started: this._started,
      hookPort: this.hooks.port,
      hookSock: this.hooks.sockPath,
      otelEndpoint: this.telemetry.endpoint(),
      webhookPort: this.webhook.boundPort,
      providers: listProviders(),
      agents: this.pty.list(),
      registry: this.hive.registry(),
      tasks: this.hive.tasks().tasks,
      breaker: this.breaker.stats(),
      openQuestions: this.hooks.questions.list(),
      usage: this.telemetry.totals(),
      kg: this.kg.enabled() ? this.kg.stats() : null,
      license: this.license.state(),
      automations: this.automations.all(),
      mcpCatalog: catalogForUi(),
      relay: this.relay ? { connected: this.relay.connected, host: this.relay.host } : null,
      // live context-window gauges pushed by the statusLine shim
      context: Object.fromEntries([...this.hooks.contextById].map(([id, c]) => [id, { tokens: c.tokens, limit: c.limit }])),
      models: Object.fromEntries(this.hooks.modelById),
    };
  }

  async stop() {
    clearInterval(this._fleetTimer);
    clearInterval(this._breakerBeatTimer);
    clearInterval(this._hookHealthTimer);
    this.proxyBridges.stopAll();
    this.watchdog.stop();
    this.temps.stop();
    this.automations.stop();
    this.memory.stopMining();
    // verbatim quit-path: the reflector's interval is NOT unref'd upstream (an
    // Electron app keeps the loop alive anyway), so it must be stopped here —
    // in a headless test the bare timer would hold the event loop open.
    try { this.reflector.stop(); } catch {}
    try { this.taskHygiene?.stop?.(); } catch {}
    try { this.retention?.stop?.(); } catch {}
    this.license.stop();
    this.slack?.stop();
    this.relay?.stop();
    this.loginWatcher.stop();
    this.webhook.stop();
    this.telemetry.stop();
    this.hive.stopRouting();
    try { await this.hive.dropCommits?.(2e3); } catch {}
    // Test/multi-hive teardown: other HiveManager instances on this process
    // hold their own commit queues with live git children — drop them all so
    // no spawned git outlives the harness that owns the event loop.
    try { await dropAllCommitQueues(2e3); } catch {}
    this.hooks.stop();
    this.pty.dispose();
    this._started = false;
  }
}

module.exports = { Harness, GOD_ID };
