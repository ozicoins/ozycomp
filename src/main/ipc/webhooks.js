'use strict';
/**
 * webhooks:* / webhook:* / triggerHistory:* / telegram:setWebhook /
 * triggers:get|setContext / fileShare:* / missions:* / memory:reflectNow —
 * verbatim port of reference index.js ~36656-36838 + ~36443-36449 + ~36030.
 * The heavy lifting lives in ctx.webhooks (WebhookManager), ctx.fileShareStore,
 * ctx.contextTriggers, ctx.missionScheduler, ctx.missionArming, ctx.reflector.
 */
const crypto = require('node:crypto');

const DEFAULT_CONTEXT_TRIGGER = {
  compact: { enabled: false, everyMs: 36e5, minContextPct: 40, minContextPctLargeWindow: 55, message: '' },
  clear: { enabled: false, everyMs: 864e5, minContextPct: 90, minContextPctLargeWindow: 95, message: '' },
};

function sanitizeContextRule(patch, current2) {
  const p = patch ?? {};
  const num2 = (v, fallback, min, max) => typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : current2.enabled,
    everyMs: num2(p.everyMs, current2.everyMs, 6e4, 864e5),
    minContextPct: num2(p.minContextPct, current2.minContextPct, 0, 100),
    minContextPctLargeWindow: num2(p.minContextPctLargeWindow, current2.minContextPctLargeWindow, 0, 100),
    message: typeof p.message === 'string' ? p.message : current2.message,
  };
}

function register(ctx) {
  const { ipcMain, app } = ctx;
  const webhooks = () => ctx.webhooks;
  const liveWebContents = () => {
    const wc = ctx.win()?.webContents;
    if (wc && !wc.isDestroyed()) return wc;
    for (const w of ctx.BrowserWindow?.getAllWindows?.() ?? []) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
    }
    return null;
  };
  const notifyTriggerHistoryUpdated = () => { try { liveWebContents()?.send('triggerHistory:updated'); } catch {} };

  // ── context triggers (verbatim ~36656) ──────────────────────────────────
  ipcMain.handle('triggers:getContext', () => ctx.readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER);
  ipcMain.handle('triggers:setContext', (_evt, arg) => {
    const current2 = ctx.readConfig().contextTrigger ?? DEFAULT_CONTEXT_TRIGGER;
    const p = arg ?? {};
    const next = {
      compact: sanitizeContextRule(p.compact, current2.compact),
      clear: sanitizeContextRule(p.clear, current2.clear),
    };
    ctx.writeConfig({ contextTrigger: next });
    ctx.contextTriggers?.sync?.();
    return next;
  });

  // ── file share (verbatim ~36680) ────────────────────────────────────────
  ipcMain.handle('fileShare:create', (_evt, arg) => ctx.fileShareStore.create(arg));
  ipcMain.handle('fileShare:list', () => ctx.fileShareStore.list());
  ipcMain.handle('fileShare:revoke', (_evt, arg) => ctx.fileShareStore.revoke(arg));
  app.on('will-quit', () => { try { ctx.fileShareStore.stop(); } catch {} });

  // ── missions (verbatim ~36443) ──────────────────────────────────────────
  ipcMain.handle('missions:list', () => {
    ctx.missionArming?.check?.();
    return ctx.readConfig().missions ?? [];
  });
  ipcMain.handle('missions:save', (_evt, missions) => {
    const { mergeSavedMissions } = require('../missions');
    ctx.writeConfig({ missions: mergeSavedMissions(Array.isArray(missions) ? missions : [], ctx.readConfig().missions ?? []) });
    if (ctx.missionArming) ctx.missionArming.check?.();
    else ctx.missionScheduler?.sync?.();
    return { ok: true };
  });

  // ── memory reflect (verbatim ~36030) ────────────────────────────────────
  ipcMain.handle('memory:reflectNow', (_evt, id) => ctx.reflector?.reflectNow?.(typeof id === 'string' && id ? id : void 0) ?? ctx.harness?.memory?.reflectNow?.(typeof id === 'string' && id ? id : void 0));

  // ── multi-endpoint webhooks (verbatim ~36689-36745) ─────────────────────
  ipcMain.handle('webhooks:list', () => {
    ctx.missionArming?.check?.();
    return ctx.readConfig().webhookTriggers ?? [];
  });
  ipcMain.handle('webhooks:save', (_evt, arg) => webhooks()?.save?.(Array.isArray(arg) ? arg : []) ?? []);
  ipcMain.handle('webhooks:delete', (_evt, arg) => {
    const id = typeof arg === 'string' ? arg : '';
    return webhooks()?.delete?.(id) ?? (ctx.readConfig().webhookTriggers ?? []).filter((t) => t.id !== id);
  });
  ipcMain.handle('webhooks:generateSecret', () => crypto.randomBytes(32).toString('hex'));
  ipcMain.handle('telegram:setWebhook', (_evt, arg) => webhooks()?.telegramSetWebhook?.(arg) ?? { ok: false, error: 'no-webhooks' });
  ipcMain.handle('webhooks:status', () => (ctx.missionArming?.check?.(), webhooks()?.status?.() ?? { running: false, endpoints: [] }));
  ipcMain.handle('webhooks:retry', async () => {
    const w = webhooks();
    if (!w) return { ok: false, error: 'no-webhooks' };
    if (w.starting) return { ok: false, error: 'already starting' };
    if (w.server && !w.server.publicUrl?.()) w.stop();
    return w.start();
  });

  // ── trigger history (verbatim ~36789-36797) ─────────────────────────────
  ipcMain.handle('triggerHistory:list', () => webhooks()?.history?.list?.() ?? []);
  ipcMain.handle('triggerHistory:clear', (_evt, arg) => {
    const source = arg === 'webhook' || arg === 'org' ? arg : void 0;
    webhooks()?.history?.clear?.(source);
    webhooks()?.pruneHeldTokens?.();
    notifyTriggerHistoryUpdated();
    return { ok: true };
  });
  ipcMain.handle('triggerHistory:decide', (_evt, arg) => webhooks()?.decide?.(arg) ?? null);

  // ── legacy single-webhook surface (verbatim ~36826-36838) ───────────────
  ipcMain.handle('webhook:start', () => webhooks()?.start?.() ?? { ok: false, error: 'no-webhooks' });
  ipcMain.handle('webhook:stop', () => {
    webhooks()?.stop?.();
    return { ok: true };
  });
  ipcMain.handle('webhook:status', () => {
    const w = webhooks();
    return { running: w?.server != null, url: w?.lastUrl ?? null, ...(w?.server?.boundPort?.() ?? {}) };
  });
  ipcMain.handle('webhook:generateSecret', () => {
    const secret = crypto.randomBytes(32).toString('hex');
    ctx.writeConfig({ webhookSecret: secret });
    webhooks()?.upsertLegacyTrigger?.({ secret });
    return { ok: true, secret };
  });
  ipcMain.handle('webhook:setConfig', (_evt, patch) => {
    const p = patch ?? {};
    const next = {};
    if (typeof p.secret === 'string') next.webhookSecret = p.secret.trim() || void 0;
    if (typeof p.port === 'number' && Number.isFinite(p.port)) next.webhookPort = p.port;
    if (typeof p.enabled === 'boolean') next.webhookEnabled = p.enabled;
    ctx.writeConfig(next);
    webhooks()?.upsertLegacyTrigger?.({
      secret: typeof p.secret === 'string' ? p.secret.trim() : void 0,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : void 0,
    });
    webhooks()?.reconcile?.();
    return { ok: true };
  });
}

module.exports = { register };
