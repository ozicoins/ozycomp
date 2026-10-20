'use strict';
/**
 * config:* IPC surface — verbatim port of the reference handlers
 * (index.js ~35065-35220). The heavy config helpers already live in
 * ../config.js (expandTilde, normalizeHiveHome, withAgentMcp,
 * sanitizeAgentMcp, MAX_AGENT_TOKEN_CAP) and ../avatars.js (save/delete);
 * this file re-implements the verbatim patch/write flow on top of
 * ctx.readConfig/ctx.writeConfig plus the verbatim stop-list for changeHome.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  expandTilde, withAgentMcp, sanitizeAgentMcp, MAX_AGENT_TOKEN_CAP,
} = require('../config');
const { sanitizeAvatarName, normalizeRecipe, newCustomAvatarId, MAX_CUSTOM_AVATARS } = require('../avatars');
const { MCP_CATALOG } = require('../mcp-catalog');

function register(ctx) {
  const { ipcMain, app } = ctx;
  const readConfig = ctx.readConfig;
  const writeConfig = ctx.writeConfig;
  const persistConfig = (next) => { writeConfig(next); return ctx.readConfig(); };

  function sanitizeAvatars(raw) {
    const out = [];
    if (Array.isArray(raw)) {
      for (const r of raw) {
        if (!r || typeof r !== 'object') continue;
        const recipe = normalizeRecipe(r.recipe);
        if (!recipe) continue;
        out.push({ id: String(r.id ?? ''), name: sanitizeAvatarName(r.name) || 'Avatar', recipe, createdAt: r.createdAt, updatedAt: r.updatedAt });
      }
    }
    return out.slice(0, MAX_CUSTOM_AVATARS);
  }
  function setAgentTokenCap(agentId, tokenCap) {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) throw new Error('invalid agent token cap');
    if (tokenCap !== void 0 && (typeof tokenCap !== 'number' || !Number.isInteger(tokenCap) || tokenCap <= 0 || tokenCap > MAX_AGENT_TOKEN_CAP)) throw new Error('invalid agent token cap');
    const current2 = readConfig();
    const agentTokenCaps = { ...current2.agentTokenCaps ?? {} };
    if (tokenCap === void 0) delete agentTokenCaps[agentId];
    else agentTokenCaps[agentId] = tokenCap;
    return persistConfig({ ...current2, agentTokenCaps });
  }
  function setAgentMcp(agentId, mcpId, enabled) {
    if (typeof agentId !== 'string' || agentId.trim().length === 0) throw new Error('invalid agent mcp grant');
    if (typeof mcpId !== 'string' || !MCP_CATALOG.some((e) => e.id === mcpId)) throw new Error('invalid agent mcp grant');
    if (enabled !== null && typeof enabled !== 'boolean') throw new Error('invalid agent mcp grant');
    const current2 = readConfig();
    return persistConfig({ ...current2, agentMcp: withAgentMcp(sanitizeAgentMcp(current2.agentMcp), agentId, mcpId, enabled) });
  }
  function saveAvatar(input) {
    if (!input || typeof input !== 'object') throw new Error('invalid avatar');
    const a = input;
    const recipe = normalizeRecipe(a.recipe);
    if (!recipe) throw new Error('invalid avatar');
    const name = sanitizeAvatarName(a.name) || 'Avatar';
    const current2 = readConfig();
    const list = sanitizeAvatars(current2.avatars);
    const now = new Date().toISOString();
    if (a.id !== void 0) {
      const i = list.findIndex((x) => x.id === a.id);
      if (i < 0) throw new Error('unknown avatar');
      list[i] = { ...list[i], name, recipe, updatedAt: now };
    } else {
      if (list.length >= MAX_CUSTOM_AVATARS) throw new Error('avatar limit');
      let id = newCustomAvatarId();
      while (list.some((x) => x.id === id)) id = newCustomAvatarId();
      list.push({ id, name, recipe, createdAt: now, updatedAt: now });
    }
    return persistConfig({ ...current2, avatars: list });
  }
  function deleteAvatar(id) {
    if (typeof id !== 'string' || !id) throw new Error('invalid avatar id');
    const current2 = readConfig();
    return persistConfig({ ...current2, avatars: sanitizeAvatars(current2.avatars).filter((x) => x.id !== id) });
  }
  function ensureHarnessHome(p2) {
    try { fs.mkdirSync(expandTilde(p2), { recursive: true }); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  const ensureClaudeGlobalPermissions = (home) => {
    const dir = path.join(home, '.claude');
    const p = path.join(dir, 'settings.json');
    try {
      let s = {};
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        s = parsed;
      }
      if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
        s.skipDangerousModePermissionPrompt = true;
        s.skipAutoPermissionPrompt = true;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
      }
    } catch (error) { console.warn(`[config] Could not safely update Claude config at ${p}:`, error); }
  };

  const stopList = (tag) => [
    ['stopAutomationArming', () => ctx.missionArming?.stop?.()],
    ['clearMissionTimers', () => ctx.missionScheduler?.clear?.()],
    ['clearContextTimers', () => ctx.contextTriggers?.clearTimers?.()],
    ['stopWebhookDoneObserver', () => ctx.webhooks?.doneObserver?.stop?.()],
    ['stopWorkerWatcher', () => ctx.workerWatcher?.stop?.()],
    ['broker.stop', () => ctx.integrationBroker?.stop?.()],
    ['stopRouter', () => ctx.harness?.hive?.stopRouting?.() ?? ctx.harness?.hive?.stopRouter?.()],
    ['hookServer.stop', () => ctx.harness?.hooks?.stop?.()],
    ['slack.stop', () => ctx.slackOps?.stopSlackIngestion?.() ?? ctx.slack?.stop?.()],
    ['webhook.stop', () => ctx.webhooks?.stop?.()],
    ['memory.stop', () => ctx.harness?.memory?.stop?.()],
    ['reflector.stop', () => ctx.reflector?.stop?.()],
    ['flushCommits', () => ctx.harness?.hive?.flushCommits?.()],
  ];

  ipcMain.handle('config:get', () => readConfig());
  ipcMain.handle('dev:noGod', () => (!app.isPackaged && (process.argv.includes('--no-god') || process.env.MD_NO_GOD === '1' || process.env.OZYC_NO_GOD === '1')));
  ipcMain.handle('config:update', (_e, patch) => {
    const hiveWasEnabled = ctx.harness?.hive?.enabled?.() ?? false;
    const wasOnboarded = readConfig().onboardingComplete;
    if ('responder' in patch) patch.responder = typeof patch.responder === 'string' && patch.responder.trim() ? patch.responder.trim() : void 0;
    if ('webhookResponder' in patch) patch.webhookResponder = typeof patch.webhookResponder === 'string' && patch.webhookResponder.trim() ? patch.webhookResponder.trim() : void 0;
    if ('seasonalTheme' in patch) patch.seasonalTheme = patch.seasonalTheme === 'halloween' || patch.seasonalTheme === 'none' ? patch.seasonalTheme : void 0;
    const next = writeConfig(patch);
    if (typeof patch?.telemetryEnabled === 'boolean') ctx.analytics?.setEnabled?.(patch.telemetryEnabled);
    if (!wasOnboarded && next?.onboardingComplete) ctx.analytics?.track?.('onboarding_completed', { provider: next.godProvider ?? 'claude' });
    if (typeof patch?.orchestratorMaySpawn === 'boolean') ctx.harness?.hive?.setOrchestratorMaySpawn?.(patch.orchestratorMaySpawn);
    if (patch && 'ticketPrefix' in patch) ctx.harness?.hive?.setTicketPrefix?.(patch.ticketPrefix);
    if (!hiveWasEnabled && (ctx.harness?.hive?.enabled?.() ?? false)) {
      try { ctx.bootstrapHiveServices?.(); } catch (e) { console.error('[hive] bootstrap after onboarding:', e); }
    }
    return next;
  });
  ipcMain.handle('config:setAgentTokenCap', (_e, agentId, tokenCap) => setAgentTokenCap(agentId, tokenCap));
  ipcMain.handle('config:setAgentMcp', (_e, agentId, mcpId, enabled) => setAgentMcp(agentId, mcpId, enabled));
  ipcMain.handle('config:saveAvatar', (_e, input) => saveAvatar(input));
  ipcMain.handle('config:deleteAvatar', (_e, id) => deleteAvatar(id));
  ipcMain.handle('config:ensureHome', (_e, p2) => {
    if (typeof p2 !== 'string' || p2.length === 0) return { ok: false, error: 'invalid path' };
    return ensureHarnessHome(p2);
  });
  ipcMain.on('config:homeSync', (evt) => { evt.returnValue = readConfig().harnessHome ?? null; });
  ipcMain.handle('config:changeHome', async (_e, payload) => {
    const p = payload ?? {};
    if (typeof p.newHome !== 'string' || !p.newHome) return { ok: false, error: 'invalid newHome' };
    const mode2 = p.mode === 'fresh' ? 'fresh' : 'move';
    const newHome = path.resolve(expandTilde(p.newHome));
    const oldRaw = readConfig().harnessHome;
    const oldHome = oldRaw ? path.resolve(oldRaw) : null;
    if (oldHome) {
      if (newHome === oldHome) return { ok: false, error: 'That is already the current home folder.' };
      const a = newHome + path.sep, b = oldHome + path.sep;
      if (a.startsWith(b) || b.startsWith(a)) return { ok: false, error: 'Pick a folder that is not inside (or a parent of) the current home.' };
    }
    const ensured = ensureHarnessHome(newHome);
    if (!ensured.ok) return ensured;
    for (const [name, fn] of stopList('changeHome')) {
      try { await fn(); } catch (e) { console.error(`[changeHome] ${name}:`, e); }
    }
    if (mode2 === 'move' && oldHome) {
      try {
        for (const sub of ['hive', 'palace', 'roster.json', 'roster-backups', 'restore-gate.json']) {
          const src = path.join(oldHome, sub);
          if (!fs.existsSync(src)) continue;
          fs.cpSync(src, path.join(newHome, sub), { recursive: true, force: true, dereference: false });
        }
      } catch (e) {
        try { ctx.bootstrapHiveServices?.(); } catch {}
        const cfg = readConfig();
        if (cfg.slackEnabled) void ctx.slackOps?.startSlackIngestion?.();
        ctx.webhooks?.reconcile?.();
        return { ok: false, error: `Could not copy data: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    ctx.ideRuntime?.setAllowQuit?.(true);
    writeConfig({ harnessHome: newHome });
    try { ctx.harness?.pty?.killAll?.(); } catch (e) { console.error('[changeHome] killAll:', e); }
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
}

module.exports = { register };
