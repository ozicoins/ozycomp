'use strict';
/**
 * Electron main-process entry. Thin shell around Harness: owns the
 * BrowserWindow, exposes every harness surface to the renderer over IPC
 * (window.cth bridge), and streams PTY output + events to subscribers.
 *
 * Floor flags: `--floor-data=` / `--floor-shared=` / `--floor-home=` make this
 * process boot as a tenant floor (see src/main/floors.js).
 */
const { app, BrowserWindow, ipcMain, screen, powerMonitor } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Harness } = require('./harness');
const { parseFloorArgs, floorDataDirFor } = require('./floors');
const { SlackBridge } = require('./slack');
const { SecretsStore } = require('./secrets');
const { catalogForUi } = require('./mcp-catalog');
const { TranscribeRouter, DOWNLOADABLE_MODELS } = require('./voice');
const { AnyAppDictation, anyAppUnavailableReason, mdHotkeyPath } = require('./anyapp');
const skillsHub = require('./skills-hub');
const { commandGroupsFor } = require('./capabilities');
const { toolsStatus, loadModelCatalog } = require('./tools');
const { FileShareStore, loadHero } = require('./file-share');
const { WebhookManager } = require('./webhooks');
const { armHeartbeat } = require('./heartbeat');
const { hiveTextSearch } = require('./text-search');
const { contextCommandsForProvider, clearCommandForProvider, compactCommandForProvider } = require('./context-commands');
const { estimateCostUsd, priceFor } = require('./pricing');
const ib = require('./integration-broker');
const puckRuntime = require('./puck-runtime');
const ideRuntime = require('./ide-runtime');
const updater = require('./updater');
const { KvStore } = require('./kv-store');
const { PersistStore } = require('./persist-store');
const { AgentLedger, takePreviousLedger, sweepStaleAgents } = require('./agent-ledger');
const rendererHealth = require('./renderer-health');
const { createMissionScheduler, startArmingWatch, mergeSavedMissions,
  ContextTriggers, sanitizeContextRule, ensureDefaultMissions } = require('./missions');
const { startConnectionRequests, processConnectionRequests, missionSummary } = require('./connections');
const { OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION,
  DEFAULT_CONTEXT_TRIGGER } = require('./config');

let win = null;
let harness = null;
let electronMainAgentLedger = null;   // AgentLedger — set before boot(), installed on harness.pty
// verbatim ~31839: the module-scope PersistStore singleton — created at boot
// BEFORE contextTrigger/webhook wiring so their kv reads and writes are
// SQLite-backed like upstream. A DB that fails to open stays a safe null-op
// surface (getKv undefined, setKv swallowed, history:* falls back to JSONL).
let persist = null;
// verbatim ~24059: the module-scope Analytics singleton (allowlist-only
// capture; no client when posthog-node is absent — init logs the verbatim
// "init failed (telemetry disabled)" line and every track* no-ops).
const analytics = new (require('./analytics').Analytics)();
let analyticsFlushed = false;
let voice = null;
let anyApp = null;        // AnyAppDictation when the md-hotkey helper + a hotkey exist
const fileShareStore = new FileShareStore();
let webhooks = null;      // WebhookManager — config-gated inbound trigger plane
let contextTriggers = null; // compact/clear schedules from config.contextTrigger
let missionArming = null;   // config-write watcher re-arming missions+webhooks
let missionScheduler = null;
// verbatim ~36646: the 3s connection-request sweep + its dep bag (created in
// boot, stopped in the quit/reset lists).
let connectionDeps = null;
let connectionRequestTimer = null;

// Integration broker (verbatim module-scope creation, index.js ~31864):
// a loopback-only HTTP proxy that injects provider secrets server-side —
// workers hold per-worker capability tokens, never raw keys.
ib._bindConfig(() => readSettings(), (patch) => writeSettings(patch));
const integrationBroker = new ib.IntegrationBroker({ getRecord: ib.getRecord, getSecret: ib.getSecret });
const brokerGrants = new ib.BrokerGrants(integrationBroker, () => ib.enabledIds());
const integrationIpc = ib.integrationHandlers({
  upsertRecord: ib.upsertRecord,
  setSecret: ib.setSecret,
  removeRecord: ib.removeRecord,
  secretRefFor: ib.secretRefFor,
  onChanged: () => brokerGrants.onIntegrationsChanged(),
});

function isFloorBoot() { const f = parseFloorArgs(); return !!(f.floorHome ?? f.floorData); }

// verbatim ~12446-12498: take the .floor-lock on the hive root at boot; when
// another live floor holds it, offer "Choose another folder…" (up to 3 tries,
// then relaunch on the picked home) or quit. Returns false when the app must
// not continue booting on this hive.
function acquireFloorAtBoot(hiveRoot) {
  if (!hiveRoot) return true;
  const { acquireFloorLock, describeFloorLock, validateFloorRequest, normaliseHome } = require('./ipc/misc');
  const dialog = require('electron').dialog;
  const me2 = { pid: process.pid, userData: app.getPath('userData'), version: app.getVersion() };
  const r = acquireFloorLock(hiveRoot, me2);
  if (r.ok) {
    if (r.cleared) console.log(`[floor] cleared a stale floor lock on ${hiveRoot} (${describeFloorLock(r.cleared)})`);
    console.log(`[floor] lock taken on ${hiveRoot} (pid ${process.pid})`);
    return true;
  }
  if (r.error === 'io') {
    console.log(`[floor] could not write the floor lock on ${hiveRoot}: ${r.detail}; starting unguarded`);
    return true;
  }
  console.log(`[floor] REFUSED: ${hiveRoot} is open in another floor (${describeFloorLock(r.lock)})`);
  const refusalText = (refusal, lock) => {
    switch (refusal) {
      case 'current': return 'That folder is the hive this floor is already on.';
      case 'held': return `That folder is open in another floor${lock ? ` (${describeFloorLock(lock)})` : ''}.`;
      case 'same-data-dir': return "A floor cannot use this floor's own data folder.";
      default: return 'That is not a folder this app can open.';
    }
  };
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'This hive is open in another floor',
    message: `The folder ${readSettings().harnessHome ?? hiveRoot} is already open in another floor of OzyComp (${describeFloorLock(r.lock)}).`,
    detail: "A hive can be open in one floor at a time, or the two floors would take each other's agents. Close that floor and start again, or choose a different folder for this one.",
    buttons: ['Choose another folder…', 'Quit'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) {
    const ctx2 = { currentHome: null, userData: app.getPath('userData'), hiveRootOf: (h) => path.join(h, 'hive') };
    for (let attempt = 0; attempt < 3; attempt++) {
      const picked = dialog.showOpenDialogSync({ properties: ['openDirectory', 'createDirectory'], title: 'Choose a folder for this floor' });
      const home2 = picked?.[0];
      if (!home2) break;
      const v = validateFloorRequest({ harnessHome: home2 }, ctx2);
      if (!v.ok) {
        dialog.showMessageBoxSync({ type: 'warning', title: 'That folder is open too', message: refusalText(v.refusal, v.lock), buttons: ['Choose again'] });
        continue;
      }
      try { fs.mkdirSync(normaliseHome(v.harnessHome), { recursive: true }); } catch (e) {
        dialog.showMessageBoxSync({ type: 'error', title: 'Could not use that folder', message: e instanceof Error ? e.message : String(e), buttons: ['Choose again'] });
        continue;
      }
      writeSettings({ harnessHome: v.harnessHome });
      console.log(`[floor] relaunching on ${v.harnessHome}`);
      app.relaunch();
      break;
    }
  }
  app.exit(0);
  return false;
}

function ozycompHome() {
  // --floor-data=<dir> relocates the whole home (tenant floor boot)
  const floor = parseFloorArgs();
  const home = floor.floorHome ?? floor.floorData ?? path.join(os.homedir(), '.ozycomp');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function pushToRenderers(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows())
    try { w.webContents.send(channel, ...args); } catch {}
}

/** fireMission — a mission tick: hive message to its target + lastFiredAt. */
function fireMission(m) {
  try {
    if (m.kind !== 'compact') {
      harness.hive.send({ to: m.to || 'god', act: 'request', body: m.body, subject: m.label }, 'scheduler');
    }
    if (m.autoCompact || m.kind === 'compact') {
      contextTriggers.emit('compact', contextTriggers.rule('compact'));
    }
    const current = readSettings().missions ?? [];
    const next = current.map(x => x.id === m.id ? { ...x, lastFiredAt: Date.now() } : x);
    writeSettings({ missions: next });
    pushToRenderers('missions:updated');
  } catch (e) {
    console.error('[scheduler] mission', m.id, e);
  }
}

// verbatim ~36614: the secret-free state.json the connections README promises.
function connectionSnapshot() {
  const c = readSettings();
  const urls = webhooks?.endpointUrls?.() ?? [];
  return {
    note: 'Written by the app. Read only; to change anything, see README.md.',
    webhookServer: { running: webhooks?.server != null, url: webhooks?.lastUrl ?? '' },
    webhookResponder: c.webhookResponder ?? '',
    webhooks: (c.webhookTriggers ?? []).map((w) => ({
      id: w.id,
      name: w.name,
      source: w.source ?? 'custom',
      ...(w.source ? {} : { auth: w.auth ?? 'header' }),
      to: w.to ?? '',
      enabled: w.enabled,
      mode: w.mode,
      description: w.description ?? '',
      hasPrompt: !!w.prompt,
      url: urls.find((e) => e.id === w.id)?.url ?? '',
    })),
    missions: (c.missions ?? []).map((m) => missionSummary(m)),
    slack: {
      enabled: c.slackEnabled === true,
      mode: c.slackMode ?? '',
      channelId: c.slackChannelId ?? '',
      responder: c.responder ?? '',
      botTokenSet: !!c.slackBotToken,
      appTokenSet: !!c.slackAppToken,
      signingSecretSet: !!c.slackSigningSecret,
    },
  };
}

// verbatim ~32019: a worker whose worktree still holds unintegrated work is
// preserved (never auto-removed — god is the sole integrator) and god is
// informed; otherwise the tree is unlinked + removed and the ledger updated.
async function finalizeWorkerWorktree(wtPath, origCwd, worker) {
  try {
    const { unlinkWorktreeDeps } = require('./worktree-deps');
    const { worktreeHasUnintegratedWork, removeWorktree } = require('./ipc/git');
    const deps = await unlinkWorktreeDeps(origCwd, wtPath);
    if (!deps.ok) console.error('[worktree] dependency unlink failed:', deps.error);
    const work = await worktreeHasUnintegratedWork(wtPath, worker.baseBranch);
    const preserved = (_ipcCtx && (_ipcCtx.preservedWorktrees ??= new Map())) ?? new Map();
    const scratchDir = () => { const root = harness?.hive?.root?.(); return root ? path.join(root, 'agents', worker.workerId) : null; };
    if (work.keep) {
      console.warn(`[worker] PRESERVING worktree with unintegrated work: ${wtPath} (${work.detail})`);
      preserved.set(wtPath, {
        workerId: worker.workerId, wtPath, origCwd,
        baseBranch: worker.baseBranch, scratchDir: scratchDir(), slack: worker.slack,
        preservedAt: Date.now(),
      });
      try { _ipcCtx?.setWorkerHistoryWorktree?.(worker.workerId, 'preserved'); } catch {}
      informGod(
        `[worker worktree preserved] ${worker.workerId}`,
        `Ephemeral worker ${worker.workerId} ended but its worktree holds unintegrated work, so it was NOT auto-removed (you are the sole integrator).\nWorktree: ${wtPath}\nBranch: ${work.branch}\nState: ${work.detail}\nReview/merge it — it will be auto-reclaimed once its work lands in ${worker.baseBranch}, or remove it now with: git -C "${origCwd}" worktree remove "${wtPath}"`,
        worker.slack,
      );
      return;
    }
    const r = await removeWorktree(origCwd, wtPath);
    if (!r.ok) {
      console.error('[worker] removeWorktree failed:', r.error);
      return;
    }
    try { _ipcCtx?.setWorkerHistoryWorktree?.(worker.workerId, 'removed'); } catch {}
    preserved.set(wtPath, {
      workerId: worker.workerId, wtPath, origCwd,
      baseBranch: worker.baseBranch, scratchDir: scratchDir(), slack: worker.slack,
      preservedAt: Date.now(),
    });
  } catch (e) {
    console.error('[worker] finalizeWorkerWorktree threw (worktree left in place):', e);
  }
}
// verbatim ~32010: report a worker lifecycle event to god as a `temps` inform.
function informGod(subject, body, slack) {
  try {
    const slackLine = slack ? `\n\n[SLACK] Close the loop — post a reply to channel ${slack.channel} thread ${slack.thread_ts} via:\n  "${harness?.hive?.nodeCommand?.() ?? 'node'}" "${harness?.slackReplyScriptPath?.() ?? 'md-slack-reply.cjs'}" --channel ${slack.channel} --thread ${slack.thread_ts} --text "<your message>"` : '';
    harness?.hive?.send?.({ to: 'god', act: 'inform', subject, body: body + slackLine }, 'temps');
  } catch (e) {
    console.error('[worker] informGod failed:', e);
  }
}

async function boot() {
  const home = ozycompHome();
  // verbatim ~37950: persist opens before the context-trigger/webhook planes
  // so CONTEXT_LAST_RUN_KV_KEY and HELD_TOKENS_KV_KEY read SQLite, and before
  // createWindow so window.bounds restores. `open()` throws on a bad DB — the
  // failure is logged once and the kv seams fall back to config.kv.
  persist = new PersistStore();
  try {
    persist.open();
  } catch (e) {
    console.error('[persist] open failed:', e);
    persist = null;
  }
  const persistKv = {
    get: (k) => persist ? persist.getKv(k) : readSettings().kv?.[k],
    set: (k, v) => { if (persist) persist.setKv(k, v); else writeSettings({ kv: { ...(readSettings().kv ?? {}), [k]: v } }); },
  };
  // verbatim ~37677: take the .floor-lock before the harness opens the hive —
  // a second floor on the same hive would steal each other's agents.
  if (!acquireFloorAtBoot(path.join(home, 'hive'))) return;

  harness = new Harness({
    workDir: home,
    hiveRoot: path.join(home, 'hive'),
    defaultProvider: 'claude',
    secrets: new SecretsStore({ home }),
    brokerGrants,
    breaker: { tokenVelocityPerMin: 60_000 },
    // verbatim ~37554: the spawn-request sweep's autonomy switch is
    // orchestratorMaySpawn (tempsEnabled is the renderer's own legacy key).
    tempsEnabled: () => readSettings().orchestratorMaySpawn !== false,
    kgEnabled: () => readSettings().knowledgeGraph !== false,
    mcpIds: readSettings().mcpIds ?? [],
    responseStyle: () => readSettings().responseStyle ?? '',
    // verbatim ~31816-31838: the reflector's getHome/getCommand/getSettings
    // thunks read config like the reference's readConfig() singleton.
    readConfig: () => readSettings(),
  });
  // verbatim ~37925: the ledger constructed at whenReady is attached now that
  // the harness (and its PtyManager) exists — spawn() starts recording pids.
  try { if (electronMainAgentLedger) harness.pty?.setLedger?.(electronMainAgentLedger); } catch {}
  await harness.start();

  // verbatim ~37681-37683: tell the hive which build is running it (the
  // injected prompt's RUNNING BUILD line) and mirror the autonomy switch so
  // god's prompt can decide whether to mention the temp queue.
  try {
    harness.hive.refreshGeneratedDocs();
    // verbatim ~37680: drop md-hook-* wrappers whose launcher or script is gone —
    // a retired Gemini agent or temp would leave one for good without this.
    try { harness.nodeLauncher?.sweepHookWrappers?.(); } catch {}
    harness.hive.setRuntimeInfo({ version: app.getVersion(), packaged: app.isPackaged, appPath: app.getAppPath() });
    // verbatim ~37683-37684: the autonomy switch and the ticket prefix mirror
    // config — temps keep spawning only while orchestratorMaySpawn stays on.
    harness.hive.setOrchestratorMaySpawn(readSettings().orchestratorMaySpawn !== false);
    harness.hive.setTicketPrefix?.(readSettings().ticketPrefix);
    // verbatim ~37685-37697: log the build that just took the floor so a restart
    // or a stale-bundle switch is visible inside the hive itself.
    harness.hive.log({
      kind: 'app-start',
      version: app.getVersion(),
      packaged: app.isPackaged,
      appPath: app.getAppPath(),
      exePath: process.execPath,
      electron: process.versions.electron,
      platform: process.platform,
    });
    // verbatim ~37699: restore which agents the fleet's auto-delivery was held
    // for across this restart — the control registry starts empty every boot.
    _ipcCtx?.control?.replaceAutoDeliveryPauses?.(readSettings().autoDeliveryPausedAgents ?? []);
    // verbatim ~37682: the floor-independent home of the agy/grok global-config
    // hook shims (shared content-hashed bundle under appData).
    harness.nodeLauncher?.setSharedBinDir(path.join(app.getPath('appData'), 'ozycomp', 'shared', 'bin'));
    // verbatim ~32758: the reply helper path the temps' [SLACK JOB] preamble
    // hands to workers (resources/md-slack-reply.cjs, or resourcesPath when
    // packaged).
    harness.slackReplyScriptPath = () => app.isPackaged
      ? path.join(process.resourcesPath, 'md-slack-reply.cjs')
      : path.join(app.getAppPath(), 'resources', 'md-slack-reply.cjs');
  } catch {}

  // Slack spawn-request lane (verbatim temps pick up slack: manifests and get
  // bound back to their thread via harness.slack). Transport ingestion itself
  // runs through ctx.slackOps.startSlackIngestion — the bridge here is only the
  // worker↔thread map + manifest triage, never started as a poller.
  const s = readSettings();
  if (s.slackBotToken && (s.slackChannel || s.slackChannelId)) {
    harness.enableSlack(new SlackBridge({
      hive: harness.hive, botToken: s.slackBotToken, appToken: s.slackAppToken,
      channelId: s.slackChannel ?? s.slackChannelId, emit: (e, v) => pushToRenderers(`harness:${e}`, v),
    }));
  }
  // Relay: opt-in cross-floor link (settings.relayEnabled)
  if (s.relayEnabled) harness.enableRelay({ floorId: s.floorId ?? 'floor' });

  // ── Connections (verbatim ~36578-36660): agents drop request files into
  //    agents/<id>/connections/requests/, the 3s sweep applies webhook.slack
  //    mission/defaults ops and republishes connections/state.json + README.
  connectionDeps = {
    hiveRoot: () => harness.hive.root(),
    listWebhooks: () => readSettings().webhookTriggers ?? [],
    saveWebhooks: (list) => webhooks.save(list),
    mintSecret: () => crypto.randomBytes(32).toString('hex'),
    newWebhookId: () => `wh-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    endpointUrl: (id) => webhooks.endpointUrls().find((e) => e.id === id)?.url ?? '',
    applySlack: (patch) => {
      const ops = _ipcCtx?.slackOps;
      ops?.stopSlackIngestion?.();
      ops?.writeSlackConfig?.(patch);
      const c = readSettings();
      if (c.slackEnabled && !ops?.slackReadiness?.(c)?.error) void ops?.startSlackIngestion?.();
    },
    setDefaults: (d) => {
      writeSettings({
        ...(typeof d.webhookResponder === 'string' ? { webhookResponder: d.webhookResponder || undefined } : {}),
        ...(typeof d.responder === 'string' ? { responder: d.responder || undefined } : {}),
      });
    },
    snapshot: () => connectionSnapshot(),
    log: (e) => harness.hive.log(e),
    now: () => Date.now(),
    onChanged: () => {
      try { pushToRenderers('webhooks:changed'); } catch {}
      try { pushToRenderers('missions:updated'); } catch {}
    },
    listMissions: () => { missionArming?.check?.(); return readSettings().missions ?? []; },
    saveMissions: (list) => {
      writeSettings({ missions: mergeSavedMissions(Array.isArray(list) ? list : [], readSettings().missions ?? []) });
      if (missionArming) missionArming.check();
      else missionScheduler?.sync();
    },
    agentIds: () => [...new Set([...Object.keys(harness.hive.registry().agents ?? {}), 'god'])],
  };
  connectionRequestTimer = startConnectionRequests(connectionDeps);

  // Inbound webhook triggers (verbatim multi-endpoint surface): config-gated,
  // loopback HTTP + tunnelmole; held tokens persist in settings.kv
  webhooks = new WebhookManager({
    readConfig: readSettings,
    writeConfig: writeSettings,
    hive: harness.hive,
    historyFile: path.join(home, 'trigger-history.json'),
    // verbatim ~33281: held tokens live in the SQLite kv, not config.kv.
    kv: persistKv,
    notify: () => pushToRenderers('triggerHistory:updated'),
  });
  webhooks.reconcile();
  // verbatim ~37719: triggers already configured → the done-observer polls
  // finished tasks even while the inbound server stays off (manual-URL mode).
  if ((readSettings().webhookTriggers ?? []).length > 0) webhooks.startDoneObserver();

  // Context triggers + mission scheduler (verbatim): the compact/clear rules
  // live in config.contextTrigger; missions are recurring hive messages. The
  // arming watch re-reads config after every write and re-arms what changed.
  contextTriggers = new ContextTriggers({
    readConfig: readSettings,
    // verbatim ~32284: triggers.context.lastRun lives in the SQLite kv.
    kv: persistKv,
    emit: (action, rule) => {
      pushToRenderers('trigger:context', { action, rule });
      if (action === 'compact') pushToRenderers('mission:autoCompact');
    },
  }, DEFAULT_CONTEXT_TRIGGER);
  contextTriggers.sync();
  missionScheduler = createMissionScheduler({
    readMissions: () => readSettings().missions ?? [],
    fire: fireMission,
    armHeartbeat: m => armHeartbeat({
      hive: harness.hive,
      pty: harness.pty,
      readConfig: readSettings,
      writeConfig: writeSettings,
      inbox: id => { try { return fs.readdirSync(path.join(harness.hive.agentDir(id), 'inbox')).filter(f => f.endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(harness.hive.agentDir(id), 'inbox', f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { return []; } },
      logTail: n => harness.hive.logTail?.(n) ?? [],
      notify: ch => pushToRenderers(ch),
      timers: missionScheduler.timers,
    }, m),
  });
  ensureDefaultMissions(
    { readConfig: readSettings, writeConfig: writeSettings, contextTriggers },
    { OPS_STANDUP_MISSION, HEARTBEAT_MISSION, COMPACT_MAINTENANCE_MISSION, DEFAULT_CONTEXT_TRIGGER },
  );
  missionScheduler.sync();
  missionArming = startArmingWatch({
    readConfig: readSettings,
    configStamp: () => {
      try { const s = fs.statSync(path.join(ozycompHome(), 'config.json')); return `${s.mtimeMs}:${s.size}`; }
      catch { return null; }
    },
    missions: missionScheduler,
    reconcileWebhooks: () => webhooks.reconcile(),
    subscribe: fn => (configStore ??= new ConfigStore(path.join(ozycompHome(), 'config.json'))).onWritten(fn),
  });

  // Broker loopback listener (verbatim): start after the config seam is live,
  // re-grant every agent dir that outlived a restart.
  void integrationBroker.start().then((r) => {
    if (r.ok) {
      console.log('[broker] integration broker listening on', integrationBroker.url());
      const n = brokerGrants.onBrokerStart();
      if (n > 0) console.log(`[broker] re-granted ${n} running agent(s) via .broker`);
    } else console.error('[broker] failed to start:', r.error);
  });

  // ── The puck (verbatim registerPuck deps, index.js ~36974) ──
  const kv = new KvStore(path.join(home, 'app-state.json'));
  // persist opened at the top of boot() — verbatim ~37950 ordering.
  puckRuntime.registerPuck({
    readConfig: readSettings,
    writeConfig: writeSettings,
    onConfigWritten: fn => (configStore ??= new ConfigStore(path.join(ozycompHome(), 'config.json'))).onWritten(fn),
    hiveEnabled: () => true,
    hiveSend: (partial, from) => harness.hive.send(partial, from),
    transcribe: (opts) => voice.transcribe({ ...opts, mode: opts.mode ?? 'meeting' }),
    canTranscribe: () => voice.canTranscribe('meeting'),
    systemAudioSource: () => null,   // no tap helper bundled — renderer/helper paths can override
    startSystemAudio: async () => {},
    stopSystemAudio: async () => {},
    broadcast: (channel, payload) => pushToRenderers(channel, payload),
    openSettings: (section) => {
      const w = win && !win.isDestroyed() ? win : BrowserWindow.getAllWindows().find(x => !x.isDestroyed()) ?? null;
      if (!w) return;
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
      w.webContents.send('settings:open', { section });
    },
    agentIds: () => {
      try {
        return Object.entries(harness.hive.registry().agents)
          .filter(([id, a]) => !a.archived && !!harness.pty.get(id)).map(([id]) => id);
      } catch { return []; }
    },
    agentName: (id) => {
      try {
        const reg = harness.hive.registry();
        const godId = reg.godId ?? 'god';
        if (id === godId || id === 'god') return reg.agents[godId]?.name?.trim() || 'god';
        return reg.agents[id]?.name?.trim() || id;
      } catch { return id; }
    },
    preload: path.join(__dirname, '../preload/index.js'),
    rendererUrl: null,
    rendererDir: path.join(__dirname, '../renderer'),
  });

  // ── The detachable IDE (verbatim registerIdeRuntime) ──
  ideRuntime.registerIdeRuntime(require('electron'), {
    // verbatim ~34207: window.ide.bounds reads the SAME persist kv as every
    // other window/state scalar (a closed DB falls back to the JSON store).
    persist: persist ?? kv,
    installWindowHealth: (w, opts) => rendererHealth.installWindowHealth(w, opts),
    preloadPath: path.join(__dirname, '../preload/index.js'),
    ideHtmlPath: path.join(__dirname, '../renderer/ide.html'),
    rendererUrl: null,
    isDev: !app.isPackaged,
    openSettings: (section) => {
      const w = win && !win.isDestroyed() ? win : null;
      if (w) w.webContents.send('settings:open', { section });
    },
    officeTitle: () => 'OzyComp',
  });

  // Voice: dictation/meeting transcription — engine auto (apple→whisper→groq)
  voice = new TranscribeRouter({
    readConfig: () => ({ ...readSettings(), groqApiKey: harness.secrets.get('GROQ_API_KEY') ?? readSettings().groqApiKey }),
    userDataPath: home,
    resourcesPath: path.join(app.getAppPath(), 'resources'),
    log: l => harness.hive.log({ kind: 'voice', line: l }),
  });
  voice.warmUp();

  // Any-app dictation: global push-to-talk → transcribe → inject into the
  // frontmost app. Needs the bundled md-hotkey helper; without it we report
  // 'no-helper' (same as the reference on a bare checkout).
  const resourcesPath = path.join(app.getAppPath(), 'resources');
  const unavailable = anyAppUnavailableReason(resourcesPath, process.platform, process.env, { floor: isFloorBoot() });
  if (!unavailable) {
    const cfg = voice.config();
    if (cfg.anyApp) {
      anyApp = new AnyAppDictation({
        helperPath: mdHotkeyPath(resourcesPath),
        key: cfg.pushToTalkKey,
        transcriber: voice,
        route: () => win?.isFocused() === true,          // our window focused → keep text in-app
        ignore: () => false,
        onEvent: e => pushToRenderers('harness:voice-event', e),
      });
      anyApp.start().catch(e => harness.hive.log({ kind: 'anyapp', line: `arm failed: ${e.message}` }));
    }
  }

  // event fan-out → renderer
  for (const ev of ['hook', 'agent-spawned', 'steer', 'wake-nudge', 'open-question',
                    'temp-spawned', 'temp-failed', 'temp-needs-confirm', 'usage',
                    'automation-fired', 'license-changed', 'slack-triaged',
                    'relay-up', 'relay-down', 'relay-msg', 'relay-trust-changed',
                    'login-wait'])
    harness.on(ev, (...a) => pushToRenderers(`harness:${ev}`, ...a));
  harness.pty.on('data', (id, chunk) => pushToRenderers('pty:data', id, chunk));
  harness.pty.on('exit', (id, code) => pushToRenderers('pty:exit', id, code));

  return harness;
}

// ── settings (renderer-visible flags; secrets stay in SecretsStore) ──────────
// The store is the verbatim ConfigStore — config.json at the ozycomp home,
// DEFAULTS + trigger/model migrations handled inside read().
const { ConfigStore } = require('./config');
let configStore = null;
function readSettings() {
  configStore ??= new ConfigStore(path.join(ozycompHome(), 'config.json'));
  return configStore.read();
}
function writeSettings(patch) {
  configStore ??= new ConfigStore(path.join(ozycompHome(), 'config.json'));
  return configStore.write(patch);
}

// ── verbatim push wiring (reference ~34043-34155 + ~37853-38015) ─────────
// Per-window state for the close/visibility stream; the per-window ledger
// itself lives on ctx.windowVisibility (ipc/misc.js) — these locals only
// need to exist once per window.
const _winState = new WeakMap();
function wireWindowVerbatim(w, isFloor = false) {
  if (!w || _winState.has(w)) return;
  _winState.set(w, true);
  w.on('page-title-updated', (e) => e.preventDefault());
  // verbatim ~34048: the window's crash supervisor — reload-budgeted recovery
  // plus the WeakSet that keeps the quit path from prompting a dead renderer.
  rendererHealth.installWindowHealth(w, { label: isFloor ? 'floor' : 'primary' });
  w.on('focus', () => { win = w; });
  if (!isFloor) {
    // verbatim ~34101-34116: the primary's bounds persist to the SQLite kv on
    // move/resize (debounced) and once more on close.
    const saveBounds = debounce(() => {
      if (w.isDestroyed() || w.isMinimized() || w.isMaximized()) return;
      try { persist?.setKv('window.bounds', w.getBounds()); } catch {}
    }, 400);
    w.on('resized', saveBounds);
    w.on('moved', saveBounds);
    w.on('close', () => {
      if (w.isDestroyed() || w.isMinimized() || w.isMaximized()) return;
      try { persist?.setKv('window.bounds', w.getBounds()); } catch {}
    });
  }
  w.on('close', (e) => {
    if (isFloor) return;                       // floor windows close freely
    const count = harness?.pty?.list?.().length ?? 0;
    if (count === 0) return;
    // verbatim ~34147: a dead/crashed renderer is never asked to confirm —
    // the window just closes (logQuitPromptDecision leaves a health-log row).
    if (!rendererHealth.logQuitPromptDecision(w, 'window-close')) return;
    e.preventDefault();
    w.focus();
    if (!w.webContents.isDestroyed()) w.webContents.send('app:closeRequested', { ptyCount: count });
  });
  // A renderer reload re-arms the hire queue (verbatim: did-start-navigation
  // flips rendererReadyForHires off until hire:drainPending runs again).
  w.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && _ipcCtx) {
      _ipcCtx.setRendererReadyForHires?.(false);
    }
  });
}
let _ipcCtx = null;

function debounce(fn, ms) {
  let t = null;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn();
    }, ms);
  };
}

function createWindow() {
  // verbatim ~34005-34020: the last-saved bounds win over the launch geometry;
  // an off-screen save is dropped to size-only by clampBounds.
  let saved = null;
  try {
    saved = clampBounds(persist?.getKv('window.bounds'));
  } catch {
    saved = null;
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: saved?.width ?? Math.min(1600, width),
    height: saved?.height ?? Math.min(1000, height),
    ...(saved && saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    title: 'OzyComp',
    backgroundColor: '#0e0d0b',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium throttles timers in occluded windows — incl. behind the lock
      // screen — which silently stalls the hive while the user is away (ref).
      backgroundThrottling: false,
    },
  });
  wireWindowVerbatim(win, false);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// verbatim ~33555: a persisted bounds rect is clamped to a sane minimum and
// dropped to size-only when every display's workArea misses it entirely.
const MIN_WIN = { width: 1280, height: 800 };
function clampBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const r = b;
  if (typeof r.width !== 'number' || typeof r.height !== 'number') return null;
  const width = Math.max(MIN_WIN.width, Math.round(r.width));
  const height = Math.max(MIN_WIN.height, Math.round(r.height));
  if (typeof r.x !== 'number' || typeof r.y !== 'number') return { width, height };
  const x = Math.round(r.x), y = Math.round(r.y);
  const onScreen = screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return x < wa.x + wa.width && x + width > wa.x && y < wa.y + wa.height && y + height > wa.y;
  });
  return onScreen ? { x, y, width, height } : { width, height };
}

// ── IPC surface (all channels prefixed 'cth:') ─────────────────────────────
const RENDERER_URL = require('node:url').pathToFileURL(path.join(__dirname, '../renderer/index.html')).href;

/** Only our own bundled page may drive the harness. */
function guard(fn) {
  return (e, ...args) => {
    if (e.senderFrame?.url !== RENDERER_URL) throw new Error('ipc: untrusted sender');
    return fn(e, ...args);
  };
}

function ipc() {
  const handle = (ch, fn) => ipcMain.handle(ch, guard(fn));

  handle('cth:status', () => harness.status());
  handle('cth:providers', () => harness.status().providers);

  handle('cth:spawn', async (_e, { id, ...opts }) => {
    const a = await harness.spawnAgent(id, opts);
    return { ok: true, agent: a };
  });
  handle('cth:send', (_e, { id, text }) => harness.send(id, text));
  handle('cth:write', (_e, { id, data }) => harness.pty.write(id, data));
  handle('cth:resize', (_e, { id, cols, rows }) => harness.pty.resize(id, cols, rows));
  handle('cth:kill', (_e, id) => harness.pty.kill(id));
  handle('cth:scrollback', (_e, id) => harness.pty.scrollback(id));

  handle('cth:tasks', () => harness.hive.tasks().tasks);
  handle('cth:addTask', (_e, t) => harness.hive.addTask(t));
  handle('cth:patchTask', (_e, { id, patch }) => harness.hive.patchTask(id, patch));
  handle('cth:board', () => harness.hive.board());
  handle('cth:steer', (_e, { id, body }) => harness.steer(id, body));
  handle('cth:answerQuestion', (_e, { qid, answer }) => harness.answerQuestion(qid, answer));
  handle('cth:drainInbox', (_e, id) => harness.hive.drainInbox(id));
  handle('cth:breaker', () => harness.breaker.stats());

  // ── v2 surfaces ──
  handle('cth:usage', () => harness.telemetry.totals());
  handle('cth:kgSearch', (_e, { q, limit }) => harness.kg.search(q, limit));
  handle('cth:kgList', () => harness.kg.list());
  handle('cth:kgAdd', (_e, { file, title }) => harness.kg.ingest(file, { title }));
  handle('cth:kgNote', (_e, { title, text }) => harness.kg.ingest({ title, text }));
  handle('cth:kgRemove', (_e, id) => harness.kg.remove(id));
  handle('cth:memory', (_e, id) => harness.memory.read(id));
  handle('cth:memoryIndex', () => harness.memory.rebuildIndex());
  handle('cth:automations', () => harness.automations.all());
  handle('cth:addAutomation', (_e, a) => harness.automations.add(a));
  handle('cth:patchAutomation', (_e, { id, patch }) => harness.automations.patch(id, patch));
  handle('cth:removeAutomation', (_e, id) => harness.automations.remove(id));
  handle('cth:settings', () => ({ ...readSettings(), license: harness.license.state() }));
  handle('cth:patchSettings', (_e, patch) => writeSettings(patch));
  handle('cth:secretKeys', () => harness.secrets.keys());
  handle('cth:setSecret', (_e, { key, value }) => { harness.secrets.set(key, value); return true; });
  handle('cth:removeSecret', (_e, key) => { harness.secrets.remove(key); return true; });
  handle('cth:mcpCatalog', () => catalogForUi());
  handle('cth:license', () => harness.license.state());
  handle('cth:licenseRedeem', (_e, key) => harness.license.redeem(key));
  handle('cth:licenseTrial', () => harness.license.registerTrial());

  // ── voice (dictation / meeting transcription) ──
  handle('cth:voiceStatus', () => voice.status());
  handle('cth:voiceModels', () => DOWNLOADABLE_MODELS.map(m => ({ ...m, installed: voice.modelInstalledSync(m.id) })));
  handle('cth:voiceTranscribe', async (_e, call) => {
    // call: {audio: ArrayBuffer|base64 string, mimeType, filename, mode, timestamps}
    const audio = typeof call.audio === 'string' ? Buffer.from(call.audio, 'base64') : Buffer.from(call.audio);
    return voice.transcribe({ ...call, audio });
  });
  handle('cth:voiceDownload', (_e, id) =>
    voice.downloadModel(id, p => pushToRenderers('harness:voice-progress', p)));
  handle('cth:voiceCancelDownload', () => voice.cancelDownload());
  handle('cth:voicePatch', (_e, patch) => {
    const s = readSettings();
    s.transcribe = { ...(s.transcribe ?? {}), ...patch };
    writeSettings({ transcribe: s.transcribe });
    return voice.status();
  });

  // ── any-app dictation (global push-to-talk) ──
  handle('cth:anyAppStatus', () => ({
    armed: anyApp?.armed ?? null,
    unavailable: anyApp ? null : anyAppUnavailableReason(
      path.join(app.getAppPath(), 'resources'), process.platform, process.env, { floor: isFloorBoot() }),
    streamRefused: anyApp?.streamRefused ?? false,
  }));
  handle('cth:anyAppInject', (_e, { text, dryRun }) => anyApp ? anyApp.inject(text, dryRun) : { posted: false });
  handle('cth:anyAppPermissions', () => anyApp ? anyApp.permissions() : { mic: false, accessibility: false, postEvent: false });

  // ── skills & agent repos (skills-hub) ──
  handle('cth:skillsLocal', (_e, cwd) => {
    const cwds = [
      ...typeof cwd === 'string' && cwd ? [cwd] : [],
      ...(readSettings().registeredRepos ?? []),
    ];
    return skillsHub.listLocalSkills({
      cwds,
      bundledDir: path.join(app.getAppPath(), 'resources', 'skills'),
    });
  });
  handle('cth:skillsCatalog', (_e, force) =>
    skillsHub.loadCatalog(path.join(ozycompHome(), 'skill-catalog.json'), { force: force === true }));
  handle('cth:skillsInstall', (_e, { url, name }) => {
    if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'bad request' };
    return skillsHub.installSkill(url, typeof name === 'string' ? name : '');
  });
  handle('cth:skillsUninstall', (_e, p) =>
    skillsHub.uninstallSkill(p, { cwds: readSettings().registeredRepos ?? [] }));
  handle('cth:skillsReveal', (_e, p) => {
    if (!skillsHub.revealable(String(p ?? ''), { registeredRepos: readSettings().registeredRepos ?? [] }))
      return { ok: false, error: 'outside a managed skills directory' };
    require('electron').shell.showItemInFolder(path.resolve(p));
    return { ok: true };
  });
  handle('cth:registeredRepos', (_e, repos) => {
    if (repos === undefined) return readSettings().registeredRepos ?? [];
    writeSettings({ registeredRepos: skillsHub.normalizeRegisteredRepos(repos) });
    return readSettings().registeredRepos;
  });
  handle('cth:commandGroups', (_e, provider) => commandGroupsFor(provider));

  // ── tools:status + models:catalog (verbatim surfaces) ──
  handle('cth:toolsStatus', () => toolsStatus({
    mempalace: { available: !!harness.memory.palaceBin(), bin: harness.memory.palaceBin() },
  }));
  handle('cth:modelsCatalog', (_e, force) =>
    loadModelCatalog(path.join(ozycompHome(), 'model-catalog.json'), { force: force === true }));
  handle('cth:hero', (_e, force) =>
    loadHero(path.join(ozycompHome(), 'hero.json'), { force: force === true }));
  handle('cth:fileShareCreate', (_e, arg) => fileShareStore.create(arg));
  handle('cth:fileShareList', () => fileShareStore.list());
  handle('cth:fileShareRevoke', (_e, arg) => fileShareStore.revoke(arg));

  // ── webhook triggers (verbatim) ──
  handle('cth:webhooksList', () => readSettings().webhookTriggers ?? []);
  handle('cth:webhooksSave', (_e, arg) => webhooks.save(Array.isArray(arg) ? arg : []));
  handle('cth:webhooksDelete', (_e, arg) => webhooks.delete(typeof arg === 'string' ? arg : ''));
  handle('cth:webhooksGenerateSecret', () => crypto.randomBytes(32).toString('hex'));
  handle('cth:webhooksStatus', () => webhooks.status());
  handle('cth:webhooksRetry', async () => {
    if (webhooks.starting) return { ok: false, error: 'already starting' };
    if (webhooks.server && !webhooks.server.publicUrl()) webhooks.stop();
    return webhooks.start();
  });
  handle('cth:telegramSetWebhook', (_e, arg) => webhooks.telegramSetWebhook(arg));
  handle('cth:triggerHistoryList', () => webhooks.history.list());
  handle('cth:triggerHistoryClear', (_e, arg) => {
    webhooks.history.clear(arg === 'webhook' || arg === 'org' ? arg : undefined);
    webhooks.pruneHeldTokens();
    pushToRenderers('triggerHistory:updated');
    return { ok: true };
  });
  handle('cth:triggerHistoryDecide', (_e, arg) => webhooks.decide(arg));
  handle('cth:webhookLegacyGenerateSecret', () => {
    const secret = crypto.randomBytes(32).toString('hex');
    writeSettings({ webhookSecret: secret });
    webhooks.upsertLegacyTrigger({ secret });
    return { ok: true, secret };
  });
  // ── missions + context triggers ──
  handle('cth:missionsList', () => {
    missionArming?.check();
    return readSettings().missions ?? [];
  });
  handle('cth:missionsSave', (_e, missions) => {
    writeSettings({ missions: mergeSavedMissions(Array.isArray(missions) ? missions : [], readSettings().missions ?? []) });
    if (missionArming) missionArming.check();
    else missionScheduler?.sync();
    return { ok: true };
  });
  handle('cth:triggersGetContext', () => readSettings().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER);
  handle('cth:triggersSetContext', (_e, arg) => {
    const current = readSettings().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    const p = arg ?? {};
    const next = {
      compact: sanitizeContextRule(p.compact, current.compact),
      clear: sanitizeContextRule(p.clear, current.clear),
    };
    writeSettings({ contextTrigger: next });
    contextTriggers.sync();
    return next;
  });
  handle('cth:webhookLegacySetConfig', (_e, patch) => {
    const p = patch ?? {};
    const next = {};
    if (typeof p.secret === 'string') next.webhookSecret = p.secret.trim() || undefined;
    if (typeof p.port === 'number' && Number.isFinite(p.port)) next.webhookPort = p.port;
    if (typeof p.enabled === 'boolean') next.webhookEnabled = p.enabled;
    writeSettings(next);
    webhooks.upsertLegacyTrigger({
      secret: typeof p.secret === 'string' ? p.secret.trim() : undefined,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
    });
    webhooks.reconcile();
    return { ok: true };
  });
  // ── integrations (verbatim reference IPC names, guard-wrapped) ──
  handle('cth:integrationsList', () => ib.listRecordsRedacted());
  handle('cth:integrationsTemplates', () => ib.INTEGRATION_TEMPLATES);
  handle('cth:integrationsUpsert', (_e, record) => integrationIpc.upsert(record));
  handle('cth:integrationsSetSecret', (_e, payload) => integrationIpc.setSecret(payload));
  handle('cth:integrationsRemove', (_e, payload) => integrationIpc.remove(payload));
  handle('cth:integrationsTest', (_e, payload) => ib.testIntegration(payload));
  handle('cth:providerKeySet', (_e, payload) => {
    const p = payload ?? {};
    if (typeof p.backend !== 'string' || !(p.backend in ib.BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
    if (typeof p.key !== 'string' || !p.key) return { ok: false, error: 'key required' };
    return ib.setSecret(ib.providerKeyRef(p.backend), p.key);
  });
  handle('cth:providerKeyHas', (_e, backend) => typeof backend === 'string' ? ib.hasSecret(ib.providerKeyRef(backend)) : false);
  handle('cth:providerKeyClear', (_e, backend) => {
    if (typeof backend !== 'string' || !(backend in ib.BACKEND_KEY_ENV)) return { ok: false, error: 'unknown backend' };
    try {
      ib.deleteSecret(ib.providerKeyRef(backend));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  handle('cth:customSecretList', () => ib.customSecretNames(ib.listSecretRefs()));
  handle('cth:customSecretSet', (_e, payload) => {
    const p = payload ?? {};
    if (typeof p.name !== 'string') return { ok: false, error: 'name required' };
    const problem = ib.secretNameProblem(p.name);
    if (problem) return { ok: false, error: `${p.name || 'name'}: ${problem === 'reserved' ? 'the harness sets this one itself' : 'use only capitals, digits and underscores'}` };
    if (typeof p.value !== 'string' || !p.value) return { ok: false, error: 'value required' };
    return ib.setSecret(ib.customSecretRef(p.name), p.value);
  });
  handle('cth:customSecretRemove', (_e, name) => {
    if (typeof name !== 'string' || ib.secretNameProblem(name)) return { ok: false, error: 'unknown secret' };
    try {
      ib.deleteSecret(ib.customSecretRef(name));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  // ── hive search + log + context commands (verbatim reference surfaces) ──
  handle('cth:textSearch', (_e, query) => hiveTextSearch(harness.hive.root(), query));
  handle('cth:log', (_e, n) => harness.hive.logTail(typeof n === 'number' ? n : 200));
  handle('cth:contextCommands', (_e, provider) => contextCommandsForProvider(provider));

  // ── verbatim reference IPC surface (src/main/ipc/*.js, group files ported
  //    from out/main/index.js; the verbatim preload speaks these names) ──
  // ── verbatim ctx dep bag: the reference's module-scope singletons become
  //    ctx fields so every ipc group shares the same state. ────────────────
  const ctxDeps = {
    ipcMain, app, shell: require('electron').shell, dialog: require('electron').dialog,
    clipboard: require('electron').clipboard, BrowserWindow, screen,
    harness, readConfig: readSettings, writeConfig: writeSettings,
    // verbatim: the reflector is a module-scope singleton next to memory —
    // ipc groups reach it as ctx.reflector (memory:reflectNow + the stop lists).
    reflector: harness.reflector,
    // verbatim ~31839: the PersistStore singleton (SQLite kv + command
    // history) — history:* IPC reads it as ctx.persist; the quit/reset stop
    // lists call persist.close.
    persist,
    pushToRenderers, win: () => win, fileShareStore, webhooks, voice, anyApp,
    skillsHub, updater, ib, ideRuntime, integrationBroker, brokerGrants,
    integrationIpc, missionScheduler, missionArming, contextTriggers,
    isFloorBoot, ozycompHome, guard, analytics,
    // keep-awake ledger (verbatim module scope)
    keepAwakeMode: null, keepAwakeId: null,
    // floor spawner + verbatim helpers the ipc groups close over
    spawnFloor: (opts) => require('./floors').spawnFloor?.({
      ...opts,
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
      sharedDir: require('./floors').sharedDataDir?.(),
    }) ?? Promise.resolve({ ok: false, error: 'unavailable' }),
    writeFleetSnapshot: () => harness?._writeFleetSnapshot?.(),
    breakerToast: (title, body) => pushToRenderers?.('hud:toast', { title, body }),
    claudeVersionOnce: (bin, env) => require('./probes').probeVersion(bin).then((r) => r.ok ? r.version : null),
    skillsResourceDir: () => skillsHub?.resourceDir?.() ?? null,
    recordWorkerTeardown: (rec) => { try { harness.workerHistory?.recordTeardown?.(rec); } catch {} },
    finalizeWorkerWorktree: (wtPath, origCwd, worker) => finalizeWorkerWorktree(wtPath, origCwd, worker),
    // free/pro/billing surfaces — degrade to the reference's "unavailable"
    // branches (the hosted backends are the reference's own services)
    freeSignin: null, regionalPricing: () => require('./pricing').priceFor?.() ?? null,
    beginProCheckout: null, fetchBilling: null, parseBillingWire: null,
    teams: { org: () => ({ available: false }) },
  };
  require('./ipc').registerAll(ctxDeps);
  _ipcCtx = ctxDeps;

  // ── verbatim push wiring (reference ~37100-37185 + ~37853-38015) ─────────
  // liveWebContents() — verbatim: main window first, else any live window.
  const liveWebContents = () => {
    const wc = win && !win.isDestroyed() ? win.webContents : null;
    if (wc && !wc.isDestroyed()) return wc;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
    }
    return null;
  };

  // armAlwaysOnBeats injects — verbatim (ref ~32569): runBreakerBeat reaches the
  // renderer (control:breakerState), the toast lane and the pty maps through
  // these module-scope singletons upstream; here they land as harness fields.
  harness.liveWebContents = liveWebContents;
  harness.breakerToast = (title, body) => pushToRenderers?.('hud:toast', { title, body });
  harness.ptyForAgent = (agentId) => ctxDeps.ptyForAgent?.(agentId) ?? null;
  harness.teardownPty = (id, reason) => ctxDeps.teardownPty?.(id, reason);

  // hive.emit — verbatim (ref ~31725-31737): the HiveManager's second ctor arg is a
  // renderer-facing sink (webContents.send). It carries hive:message,
  // hive:terminalHandoff and hive:degraded to animate routed messages + surface
  // degraded spawns on the office floor. Wired post-boot because the window is
  // only live here; calls before this are no-ops (emit?.).
  harness.hive.emit = (channel, payload) => {
    const wc = liveWebContents();
    if (!wc) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  };

  // telemetry:event — verbatim (ref ~22948/23157/23170/23333): the collector's
  // emit() raises usage / tool_result / api_error samples. Harness forwards them
  // through 'telemetry-event'; here we push the payload to the live renderer.
  harness.on('telemetry-event', (channel, payload) => {
    try { liveWebContents()?.send(channel, payload); } catch {}
  });

  // hive:degraded — verbatim (ref ~8039/8049): a spawn whose proxy bridge or
  // hook command failed to bind surfaces on the floor as a degraded agent.
  // The harness emits 'hive-degraded' with {agentId, reason, message}; forward
  // it under the IPC channel name the renderer listens on.
  harness.on('hive-degraded', ({ agentId, reason, message }) => {
    let name;
    try { name = harness.hive?.registry?.().agents?.[agentId]?.name; } catch {}
    try { liveWebContents()?.send('hive:degraded', { agentId, name, reason, message }); } catch {}
  });

  // hive:agentSpawned — verbatim spawnedCard on every live spawn (reference
  // emits it inside the realtime spawn path; the harness's agent-spawned event
  // is the same signal for every other spawn path).
  const { spawnedCard } = require('./ipc/realtime');
  harness.on('agent-spawned', ({ id, provider }) => {
    try {
      const rec = harness.hive?.registry?.().agents?.[id];
      liveWebContents()?.send('hive:agentSpawned', spawnedCard({
        id,
        name: rec?.name,
        provider: provider ?? rec?.provider,
        cwd: rec?.cwd,
        role: rec?.role,
        worktreePath: rec?.worktreePath,
        character: rec?.character,
        accent: rec?.accent,
      }));
    } catch {}
  });

  // hive:hookEvent + hive:modelUpdate — verbatim payload shape (ref ~12038):
  // the HookServer already tracks contextById/modelById and fires 'ModelUpdate'
  // through onHook; here we forward the full verbatim hook payload.
  const { validateHookEvent, promptTail } = require('./hook-server');
  harness.on('hook', (agentId, event, p) => {
    if (event === 'ModelUpdate') {
      try { liveWebContents()?.send('hive:modelUpdate', { agentId, model: p?.model }); } catch {}
      return;
    }
    const payload = {
      agentId,
      event,
      tool: p?.tool_name,
      notificationType: p?.notification_type,
      source: p?.source,
      message: p?.message,
      blocked: false,
      ...(event === 'UserPromptSubmit' && typeof p?.prompt === 'string' ? { promptTail: promptTail(p.prompt) } : {}),
    };
    if (!validateHookEvent(payload)) return;
    try { liveWebContents()?.send('hive:hookEvent', payload); } catch {}
  });

  // hive:contextUpdate — verbatim Status-event shape (ref ~11881): {agentId,
  // tokens, limit} straight from the HookServer's context_window record.
  harness.on('context-update', (agentId, rec) => {
    try { liveWebContents()?.send('hive:contextUpdate', { agentId, tokens: rec?.tokens, limit: rec?.limit }); } catch {}
  });

  // control:approvalRequest — verbatim emitControl (ref ~12038): an operator
  // gate (paused agent / gated tool) is pushed to the renderer before the deny
  // reply rides back to the CLI.
  harness.on('control-gated', (agentId, tool, reason) => {
    try { liveWebContents()?.send('control:approvalRequest', { agentId, tool, reason }); } catch {}
  });

  // config:changed — verbatim onConfigWritten fan-out (ref ~38009): every live
  // window gets the new config object on every write.
  (configStore ??= new ConfigStore(path.join(ozycompHome(), 'config.json'))).onWritten((config) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      w.webContents.send('config:changed', config);
    }
    // teams:policy — verbatim onPolicy push (ref ~33870): a null policy object
    // signals "policy may have changed, refetch" to the settings pane.
    try { liveWebContents()?.send('teams:policy', null); } catch {}
    // webhooks:changed — verbatim (ref ~36602): the triggers list changed.
    try { liveWebContents()?.send('webhooks:changed'); } catch {}
  });

  // openFloorPicker — verbatim (ref ~12506): send floor:pickerOpen to the
  // focused (or any live) window; the renderer shows the floor picker.
  ctxDeps.openFloorPicker = (target) => {
    const w = target && !target.isDestroyed() ? target
      : BrowserWindow.getFocusedWindow()
      ?? BrowserWindow.getAllWindows().find((x) => !x.isDestroyed()) ?? null;
    if (!w || w.isDestroyed() || w.webContents.isDestroyed()) return false;
    w.webContents.send('floor:pickerOpen');
    return true;
  };

  // powerMonitor resume → verbatim healthCheckPtys (ref ~37853): after sleep,
  // re-arm the schedulers, ping every PTY pid, toast wedged agents, push
  // power:resume {reason, awayMs, dead, total}.
  let lastSuspendAt = null;
  let resumeHealthTimer = null;
  const healthCheckPtys = (reason, awayMs) => {
    const ptys = harness?.pty?.list?.() ?? [];
    const dead = [];
    for (const p of ptys) {
      if (typeof p.pid === 'number' && p.pid > 0) {
        try { process.kill(p.pid, 0); } catch (e) { if (e?.code === 'ESRCH') dead.push(p.id); }
      }
    }
    const away = awayMs != null ? ` (away ~${Math.round(awayMs / 1e3)}s)` : '';
    if (dead.length) {
      console.warn(`[power] ${reason}${away}: ${dead.length}/${ptys.length} PTY(s) look wedged (process gone):`, dead.join(', '));
      ctxDeps.breakerToast?.('Agents need a restart', `${dead.length} agent terminal(s) didn't survive sleep — re-open them to resume.`);
    } else {
      console.log(`[power] ${reason}${away}: ${ptys.length} PTY(s) healthy`);
    }
    try { liveWebContents()?.send('power:resume', { reason, awayMs, dead, total: ptys.length }); } catch {}
  };
  const onSystemResume = (reason) => {
    console.log(`[power] ${reason} — re-arming scheduler, beats, router, keep-awake`);
    try { missionScheduler?.sync?.(); } catch (e) { console.error('[power] syncMissions on resume', e); }
    try { contextTriggers?.sync?.(); } catch (e) { console.error('[power] syncContextTriggers on resume', e); }
    try { ctxDeps.slackOps?.startSlackIngestion?.(); } catch (e) { console.error('[power] slack on resume', e); }
    const awayMs = lastSuspendAt != null ? Date.now() - lastSuspendAt : null;
    if (resumeHealthTimer) clearTimeout(resumeHealthTimer);
    resumeHealthTimer = setTimeout(() => { resumeHealthTimer = null; healthCheckPtys(reason, awayMs); }, 15e3);
    resumeHealthTimer.unref?.();
  };
  try {
    powerMonitor.on('suspend', () => { lastSuspendAt = Date.now(); });
    powerMonitor.on('resume', () => onSystemResume('resume'));
  } catch {}
}

app.whenReady().then(async () => {
  // verbatim ~37921: process-level health diary (child-process-gone) starts
  // before anything else can die unnoticed.
  try { rendererHealth.bindElectron(require('electron')); rendererHealth.installProcessHealth(); } catch {}
  // verbatim ~37922-37932: the stale-agent ledger is taken off disk BEFORE the
  // new harness boots, the live PtyManager gets its AgentLedger, and the prior
  // run's rows are swept in the background — a pid that still matches its
  // recorded identity is a leaked agent and is killed; a recycled pid is spared.
  try {
    const agentLedgerPath = path.join(app.getPath('userData'), 'agent-pids.json');
    const previousAgents = takePreviousLedger(agentLedgerPath);
    const ledger = new AgentLedger(agentLedgerPath);
    // harness is constructed in boot(); set the ledger onto its pty manager
    // now so spawn() starts recording pids immediately.
    const setLedger = () => { try { harness?.pty?.setLedger?.(ledger); } catch {} };
    setLedger();
    if (previousAgents.length) {
      void sweepStaleAgents(previousAgents, (m, d) => console.log(m, d)).catch((e) => console.error('[stale-agents] sweep failed:', e));
    }
    // keep a reference so boot() can re-set it once the harness exists
    electronMainAgentLedger = ledger;
  } catch (e) {
    console.error('[stale-agents] ledger setup failed:', e);
  }
  // verbatim ~37939: anonymous, allowlisted telemetry. With posthog-node
  // absent init() lands in the verbatim catch and every track* no-ops.
  try {
    analytics.init({
      stateDir: app.getPath('userData'),
      appVersion: app.getVersion(),
      enabled: readSettings().telemetryEnabled !== false,
    });
  } catch (e) { console.error('[analytics] init threw:', e); }
  // verbatim ~37948: the reply endpoint's {port,token} file — agent terminals
  // and the bundled md-slack-reply.cjs read it to post thread replies.
  try {
    process.env.MD_SLACK_REPLY_CONFIG = path.join(app.getPath('userData'), 'slack-reply.json');
  } catch {}
  await boot();
  ipc();
  if (!isFloorBoot()) updater.initAutoUpdater(() => win?.webContents ?? null);
  createWindow();
  // verbatim ~37978: auto-start the configured Slack transport at boot —
  // readiness lives in ipc/slack.js (slack:start maps onto the same path).
  try {
    const slackCfg = readSettings();
    if (slackCfg.slackEnabled) {
      void _ipcCtx?.slackOps?.startSlackIngestion?.().then((r) => {
        if (!r || r.ok === false) console.error('[slack] auto-start failed:', r?.error);
        else console.log(`[slack] ${slackCfg.slackMode ?? 'polling'} started`, r.url ? `(tunnel: ${r.url})` : '');
      });
    }
  } catch (e) { console.error('[slack] auto-start threw:', e); }
  // OZYC_SMOKE=1: boot, spawn a shell agent, prove the round trip, quit
  if (process.env.OZYC_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      await harness.spawnAgent('smoke', { provider: 'shell' });
      let out = '';
      harness.pty.subscribe('smoke', c => { out += c; });
      await harness.send('smoke', 'echo SMOKE_$((6*7))');
      await new Promise(r => setTimeout(r, 1500));
      const bridge = await win.webContents.executeJavaScript(
        'window.cth.hiveRegistry().then(s => `ipc-ok:${Object.keys(s.agents ?? {}).length}agents`, e => `ipc-fail:${e.message}`)');
      // probe the hive:message push path — the renderer registers onHiveMessage
      // and resolves when a pushed envelope lands (or times out). The listener
      // MUST be registered before sendMessage routes, so the send fires right
      // after registration instead of inside the resolved-promise .then.
      const hiveMsgPromise = win.webContents.executeJavaScript(`new Promise((res) => {
        const off = window.cth.onHiveMessage((m) => { off(); res('hive-msg-ok:' + (m && m.subject)); });
        setTimeout(() => res('hive-msg-timeout'), 1500);
      })`);
      // give the renderer a tick to attach the listener, then route a message —
      // sendMessage normalizes + routes synchronously → emitMessage → emit().
      await new Promise((r) => setTimeout(r, 100));
      try { harness.hive.sendMessage({ to: 'god', act: 'request', subject: 'PROBE_SUBJ', body: 'probe body' }, 'scheduler'); } catch (e) { console.error('[smoke] sendMessage:', e); }
      const hiveMsg = await hiveMsgPromise;
      console.log(JSON.stringify({
        smoke: out.includes('SMOKE_42'), bridge, hiveMsg,
        hookPort: harness.hooks.port, otel: harness.telemetry.endpoint(),
        webhook: harness.webhook.boundPort,
      }));
      harness.pty.kill('smoke');
      app.exit(0);
    });
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', async () => {
  try { ideRuntime.setAllowQuit(true); } catch {}
  try { voice?.stop(); } catch {}
  try { missionArming?.stop(); } catch {}
  try { missionScheduler?.clear(); } catch {}
  try { contextTriggers?.clearTimers(); } catch {}
  try { webhooks?.stop(); } catch {}
  try { integrationBroker?.stop(); } catch {}
  try { await harness?.stop(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', (e) => {
  // Lose-your-edits gate (verbatim ~37995): teardown paths (changeHome /
  // resetAll / single-instance abort / window-all-closed teardown) flip
  // allowQuit first so they never prompt; a normal quit asks once, with the
  // 10-second re-ask suppression inside confirmLosingIdeEdits.
  try {
    const dirty = ideRuntime.dirtyLedger()?.total() ?? 0;
    if (!ideRuntime.confirmLosingIdeEdits(win, dirty)) {
      e.preventDefault();
      return;
    }
  } catch {}
  const count = harness?.pty?.list?.().length ?? 0;
  if (count !== 0) {
    // verbatim ~38004: never prompt a dead/crashed renderer — the quit just
    // proceeds (the log row records why the prompt was skipped).
    if (rendererHealth.logQuitPromptDecision(win, 'before-quit')) {
      e.preventDefault();
      try { win.focus(); } catch {}
      try { win.webContents.send('app:closeRequested', { ptyCount: count }); } catch {}
      return;
    }
  }
  // verbatim ~38027: one last whole-repo scan, bounded — a quit that outlives
  // it stops the git tree and waits, so no git of ours is writing on exit.
  try { void harness?.hive?.drainCommitsForQuit?.(); } catch {}
  try { harness?.pty?.killAll(); } catch {}
});
app.on('will-quit', (e) => {
  try { fileShareStore.stop(); } catch {}
  try { connectionRequestTimer?.stop?.(); } catch {}
  // verbatim ~38021-38047: the analytics endSession flush and the hive commit
  // drain race a timeout together; the quit waits for neither past it. Fires
  // once (analyticsFlushed) — a second will-quit falls straight through.
  if (analyticsFlushed) return;
  analyticsFlushed = true;
  e.preventDefault();
  const finish = () => app.exit(0);
  const quitStarted = Date.now();
  const hiveDrained = Promise.resolve()
    .then(() => harness?.hive?.drainCommitsForQuit?.())
    .then(
      (drained) => {
        try {
          harness?.hive?.appendLog?.({ kind: 'app-quit', commitsDrained: drained, ms: Date.now() - quitStarted });
        } catch {
        }
      },
      () => {
        try {
          harness?.hive?.appendLog?.({ kind: 'app-quit', commitsDrained: false, ms: Date.now() - quitStarted });
        } catch {
        }
      }
    );
  Promise.all([
    Promise.race([
      analytics.endSession(),
      new Promise((r) => setTimeout(r, 1200)),
    ]),
    hiveDrained,
  ]).then(finish, finish);
});
