'use strict';
/**
 * slack:* IPC surface — verbatim port of the reference handlers
 * (index.js ~33022-33263 and ~36511-36556). The three transports —
 * SlackPoller / SlackSocketClient / SlackWebhookServer — are verbatim classes
 * in slack.js + slack-servers.js; the reply endpoint (SlackReplyServer) and
 * the done observer are the verbatim globals the module scope holds.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildAutonomousRequestProtocol, downloadSlackFiles, slackFilesDir, SlackPoller, SlackSocketClient } = require('../slack');
const {
  SlackWebhookServer, SlackReplyServer, postSlackReply: postSlackReplyVerbatim,
  setSlackPostSink: setSlackPostSinkVerbatim, startSlackDoneObserver,
} = require('../slack-servers');

const SLACK_MODES = ['polling', 'socket', 'webhook'];
const SLACK_RECEIVED_TEXT = ':hourglass_flowing_sand: *Received.* The office is on it and will reply here when done.';
// verbatim ~16372 — the scopes the settings test diffs against auth.test's
// granted list. Socket reuses the polling list (apps.connections.open needs
// connections:write on the app token, not a bot scope).
const SLACK_BOT_SCOPES = {
  polling: ['channels:history', 'groups:history', 'chat:write', 'files:read', 'channels:read', 'groups:read'],
  socket: ['channels:history', 'groups:history', 'chat:write', 'files:read', 'channels:read', 'groups:read'],
  webhook: ['chat:write', 'channels:history', 'groups:history'],
};
const SLACK_PROACTIVE_OFF_REASON = 'Slack posting on its own is off, so nothing was sent. Turn on "Post in Slack on its own" in Settings, Connections, Slack.';

function register(ctx) {
  const { ipcMain } = ctx;
  const liveWebContents = () => {
    const wc = ctx.win()?.webContents;
    if (wc && !wc.isDestroyed()) return wc;
    for (const w of ctx.BrowserWindow?.getAllWindows?.() ?? []) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
    }
    return null;
  };

  // ── shared state (verbatim globals ~32726-32757) ────────────────────────
  const st = (ctx.slackState ??= {
    poller: null, socket: null, server: null, lastUrl: null,
    replyServer: null, doneObserver: null,
    // Threads where an agent posted a direct substantive reply via the reply
    // endpoint — the done observer skips them (verbatim directlyRepliedThreads).
    directlyRepliedThreads: new Set(),
  });
  const slackLog = (kind, extra) => {
    try { ctx.harness?.hive?.appendLog?.({ kind: 'slack', ...extra }); } catch {}
  };
  const userData = () => ctx.ozycompHome?.() ?? require('electron').app.getPath('userData');
  const slackPollStatePath = () => path.join(userData(), 'slack-poll.json');
  const slackDoneNotifiedPath = () => path.join(userData(), 'slack-done-notified.json');
  const slackReplyConfigPath = () => path.join(userData(), 'slack-reply.json');
  const slackHistoryPath = () => path.join(userData(), 'slack-history.jsonl');
  const listSlackHistory = () => {
    try {
      return fs.readFileSync(slackHistoryPath(), 'utf8').split('\n').filter(Boolean).slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  };
  const appendSlackHistory = (row) => {
    try {
      fs.mkdirSync(path.dirname(slackHistoryPath()), { recursive: true });
      fs.appendFileSync(slackHistoryPath(), JSON.stringify({ ts: Date.now(), ...row }) + '\n');
    } catch {}
  };
  const notifySlackHistoryUpdated = () => { try { liveWebContents()?.send('slack:historyUpdated'); } catch {} };
  // verbatim ~32758: the helper script the autonomy preamble hands to agents;
  // it POSTs to the reply endpoint using MD_SLACK_REPLY_CONFIG's {port,token}.
  const slackReplyScriptPath = () => {
    try {
      const app = require('electron').app;
      return app.isPackaged ? path.join(process.resourcesPath, 'md-slack-reply.cjs') : path.join(app.getAppPath(), 'resources', 'md-slack-reply.cjs');
    } catch { return path.join(userData(), 'md-slack-reply.cjs'); }
  };
  // verbatim postSlackReply (~15482) — JSON body, sink into outbound history.
  const postSlackReply = async ({ botToken, channel, thread_ts, text }) =>
    postSlackReplyVerbatim({ botToken, channel, thread_ts, text });
  // outbound history sink — every postSlackReply (reply endpoint, ack, done
  // summary, IPC slack:reply) lands here via the shared module postSink.
  setSlackPostSinkVerbatim((r) => { appendSlackHistory({ direction: 'outbound', channel: r.channel, thread_ts: r.thread_ts, text: r.text, ok: r.ok, error: r.error }); notifySlackHistoryUpdated(); });
  // verbatim ~36557: typed field map (untyped keys dropped), readiness
  // compared before/after — a mode change or a now-broken config stops
  // ingestion so a half-applied patch can't leave a dead transport running.
  const writeSlackConfig = (patch) => {
    const p = patch ?? {};
    const before = slackReadiness(ctx.readConfig());
    const next = {};
    if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
    if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
    if (typeof p.appToken === 'string') next.slackAppToken = p.appToken.trim() || undefined;
    if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
    if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
    if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
    if (typeof p.proactivePosting === 'boolean') next.slackProactivePosting = p.proactivePosting;
    if (typeof p.mode === 'string' && SLACK_MODES.includes(p.mode)) next.slackMode = p.mode;
    if (typeof p.pollSeconds === 'number') next.slackPollSeconds = resolvePollSeconds(p.pollSeconds);
    if (typeof p.catchupSeconds === 'number') next.slackSocketCatchupSeconds = resolveCatchupSeconds(p.catchupSeconds);
    if (typeof p.tempCwd === 'string') next.slackTempCwd = p.tempCwd.trim() || undefined;
    void p.triage;
    ctx.writeConfig(next);
    const after = slackReadiness(ctx.readConfig());
    if (after.error || after.mode !== before.mode) stopSlackIngestion();
    return { ok: true };
  };
  // verbatim ~16358: mode comes from config slackMode, else signing-secret ⇒
  // webhook, else polling. (socket is only ever an explicit pick.)
  const resolveSlackMode = (cfg) => {
    const m = cfg?.slackMode;
    if (m === 'polling' || m === 'socket' || m === 'webhook') return m;
    if (cfg?.slackEnabled && typeof cfg.slackSigningSecret === 'string' && cfg.slackSigningSecret.trim()) return 'webhook';
    return 'polling';
  };
  const SLACK_POLL_DEFAULT = 60, SLACK_POLL_MIN = 30, SLACK_POLL_MAX = 300;
  const SLACK_CATCHUP_DEFAULT = 300, SLACK_CATCHUP_MIN = 60, SLACK_CATCHUP_MAX = 3600;
  const resolvePollSeconds = (v) => typeof v === 'number' && Number.isFinite(v) && v >= SLACK_POLL_MIN && v <= SLACK_POLL_MAX ? Math.round(v) : SLACK_POLL_DEFAULT;
  const resolveCatchupSeconds = (v) => v === 0 ? 0 : (typeof v === 'number' && Number.isFinite(v) && v >= SLACK_CATCHUP_MIN && v <= SLACK_CATCHUP_MAX ? Math.round(v) : SLACK_CATCHUP_DEFAULT);
  const slackReadiness = (cfg) => {
    const mode = resolveSlackMode(cfg);
    if (!cfg.slackEnabled) return { mode, error: 'slack disabled' };
    if (mode === 'webhook') return cfg.slackSigningSecret ? { mode } : { mode, error: 'missing signing secret' };
    if (!cfg.slackBotToken) return { mode, error: 'missing bot token' };
    if (mode === 'socket') return cfg.slackAppToken ? { mode } : { mode, error: 'missing app token' };
    if (!cfg.slackChannelId?.trim()) return { mode, error: 'missing channel' };
    return { mode };
  };
  // verbatim ~15772-15791 + ~16039: JSON-shape api (status/json/scopes on the
  // result); users.conversations for the channel list; the socket probe checks
  // apps.connections.open returns a wss:// url.
  const { slackAuthTest, slackListChannels, slackConnectionsOpenTest } = require('../slack');

  // ── reply endpoint + done observer (verbatim ~33052-33021) ──────────────
  const startSlackReplyServer = async () => {
    st.replyServer?.stop();
    const token = crypto.randomBytes(24).toString('hex');
    st.replyServer = new SlackReplyServer({
      token,
      getBotToken: () => ctx.readConfig().slackBotToken,
      // An agent posted a DIRECT substantive reply into this thread → record it
      // so the done-summary poller skips it (the poller is a fallback, not a
      // duplicator).
      onReplied: (thread_ts) => { st.directlyRepliedThreads.add(thread_ts); },
    });
    const r = await st.replyServer.start();
    if (!r.ok || r.port === undefined) {
      console.error('[slack] reply endpoint failed to start:', r.error);
      st.replyServer = null;
      return;
    }
    try {
      fs.writeFileSync(slackReplyConfigPath(), JSON.stringify({ port: r.port, token }), { mode: 384 });
    } catch (e) {
      console.error('[slack] could not write reply config:', e);
    }
  };
  const startDoneObserver = () => {
    st.doneObserver?.stop();
    st.doneObserver = startSlackDoneObserver({
      readTasks: () => { try { const l = ctx.harness?.hive?.tasks?.(); return Array.isArray(l?.tasks) ? l.tasks : []; } catch { return []; } },
      botToken: () => ctx.readConfig().slackBotToken,
      doneNotifiedFile: slackDoneNotifiedPath(),
      directlyRepliedThreads: st.directlyRepliedThreads,
    });
  };
  const stopSlackServer = () => {
    try { st.server?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
    st.server = null;
    try { st.replyServer?.stop(); } catch (e) { console.error('[slack] reply stop failed:', e); }
    st.replyServer = null;
    st.doneObserver?.stop();
    st.doneObserver = null;
    try {
      if (fs.existsSync(slackReplyConfigPath())) fs.unlinkSync(slackReplyConfigPath());
    } catch {}
  };

  const stopSlackIngestion = () => {
    const wasRunning = st.poller != null || st.socket != null || st.server != null;
    try { st.poller?.stop(); } catch (e) { console.error('[slack] poller stop failed:', e); }
    st.poller = null;
    try { st.socket?.stop(); } catch (e) { console.error('[slack] socket stop failed:', e); }
    st.socket = null;
    stopSlackServer();
    if (wasRunning) slackLog('stopped');
  };
  // Verbatim onSlackTransportMessage (reference ~33099): download the files,
  // log inbound history, push slack:incomingMessage (with the autonomous
  // protocol preamble + any local files), and — when proactive posting is on —
  // acknowledge the message in-thread.
  const onSlackTransportMessage = async (m) => {
    const cfg = ctx.readConfig();
    const localFiles = await downloadSlackFiles(m._rawFiles ?? [], cfg.slackBotToken, slackFilesDir(userData()));
    appendSlackHistory({ direction: 'inbound', channel: m.channel, thread_ts: m.thread_ts, text: m.text, ok: true });
    notifySlackHistoryUpdated();
    const ipcMsg = {
      text: m.text,
      channel: m.channel,
      ts: m.ts,
      thread_ts: m.thread_ts,
      responder: cfg.responder ?? '',
      autonomyPreamble: buildAutonomousRequestProtocol(m.channel, m.thread_ts, slackReplyScriptPath(), 'god', ctx.harness?.hive?.nodeCommand?.() ?? 'node'),
    };
    if (localFiles.length > 0) ipcMsg.files = localFiles;
    try {
      liveWebContents()?.send('slack:incomingMessage', ipcMsg);
    } catch {}
    if (cfg.slackProactivePosting && cfg.slackBotToken) {
      void postSlackReply({ botToken: cfg.slackBotToken, channel: m.channel, thread_ts: m.thread_ts, text: SLACK_RECEIVED_TEXT });
    }
  };

  // verbatim startSlackServer (~33022): the webhook transport — HMAC-verified
  // POST endpoint on a configured port, tunnelmole URL on top. port-in-use
  // falls back to an OS-assigned port and reports `movedFrom`.
  const startSlackServer = async () => {
    const cfg = ctx.readConfig();
    if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
      return { ok: false, error: 'slack disabled or missing signing secret' };
    }
    st.server?.stop();
    st.server = new SlackWebhookServer({
      port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
      signingSecret: cfg.slackSigningSecret,
      channelId: cfg.slackChannelId,
      onMessage: (m) => onSlackTransportMessage(m),
    });
    const res = await st.server.start();
    if (res.movedFrom !== undefined) console.warn(`[slack] port ${res.movedFrom} was in use (an older OzyComp may still be running); listening on ${res.port} instead`);
    if (!res.ok) {
      st.server.stop();
      st.server = null;
      return res;
    }
    if (res.url) st.lastUrl = res.url;
    await startSlackReplyServer();
    startDoneObserver();
    try { ctx.analytics?.trackFeature?.('slack_trigger'); } catch {}
    return res;
  };
  // verbatim startSlackIngestion (~33137): readiness → stop → transport pick.
  const startSlackIngestion = async () => {
    const cfg = ctx.readConfig();
    const ready = slackReadiness(cfg);
    slackLog('start-attempt', { mode: ready.mode });
    if (ready.error) { slackLog('refused', { mode: ready.mode, error: ready.error }); return { ok: false, error: ready.error }; }
    stopSlackIngestion();
    if (ready.mode === 'webhook') {
      const r = await startSlackServer();
      slackLog(r.ok ? 'started' : 'failed', { mode: ready.mode, ...(r.ok ? {} : { error: r.error ?? 'unknown' }) });
      return r;
    }
    const common = {
      botToken: cfg.slackBotToken,
      channelId: (cfg.slackChannelId ?? '').trim(),
      stateFile: slackPollStatePath(),
      onMessage: onSlackTransportMessage,
      log: (line) => slackLog('transport', { line }),
    };
    let res;
    if (ready.mode === 'polling') {
      st.poller = new SlackPoller({ ...common, intervalMs: resolvePollSeconds(cfg.slackPollSeconds) * 1e3 });
      res = await st.poller.start();
      if (!res.ok) {
        st.poller.stop();
        st.poller = null;
        slackLog('failed', { mode: ready.mode, error: res.error ?? 'unknown' });
        return res;
      }
    } else {
      st.socket = new SlackSocketClient({ ...common, appToken: cfg.slackAppToken, catchupMs: resolveCatchupSeconds(cfg.slackSocketCatchupSeconds) * 1e3 });
      res = await st.socket.start();
      if (!res.ok) {
        st.socket.stop();
        st.socket = null;
        slackLog('failed', { mode: ready.mode, error: res.error ?? 'unknown' });
        return res;
      }
    }
    await startSlackReplyServer();
    startDoneObserver();
    try { ctx.analytics?.trackFeature?.('slack_trigger'); } catch {}
    slackLog('started', { mode: ready.mode });
    return res;
  };
  const slackStatusNow = () => {
    const cfg = ctx.readConfig();
    const mode2 = resolveSlackMode(cfg);
    const tempsLive = [...(ctx.liveWorkers?.values?.() ?? [])].filter((w) => !!w.slack).length;
    if (st.poller) {
      const s = st.poller.status();
      return { running: s.running, mode: mode2, team: s.team, botName: s.botName, lastPollAt: s.lastPollAt, nextPollAt: s.nextPollAt, lastError: s.lastError, hotThreads: s.hotThreads, tempsLive };
    }
    if (st.socket) {
      const s = st.socket.status();
      return { running: s.running, mode: mode2, team: s.team, botName: s.botName, socketConnectedAt: s.connected ? s.connectedAt : undefined, lastCatchupAt: s.lastCatchupAt, lastError: s.lastError, hotThreads: s.hotThreads, tempsLive };
    }
    return { running: st.server != null, mode: mode2, url: st.lastUrl, ...(st.server?.boundPort() ?? {}), tempsLive, configError: slackReadiness(cfg).error };
  };
  const slackTestNow = async (draft) => {
    const cfg = ctx.readConfig();
    const mode2 = draft?.mode ?? resolveSlackMode(cfg);
    const botToken = (draft?.botToken ?? cfg.slackBotToken ?? '').trim();
    const appToken = (draft?.appToken ?? cfg.slackAppToken ?? '').trim();
    const signingSecret = (draft?.signingSecret ?? cfg.slackSigningSecret ?? '').trim();
    const missing = [];
    if (mode2 === 'webhook' && !signingSecret) missing.push('signing secret');
    if (mode2 !== 'webhook' && !botToken) missing.push('bot token');
    if (mode2 === 'socket' && !appToken) missing.push('app token');
    const out = { ok: false, ...(missing.length ? { missing } : {}) };
    if (!botToken) { out.error = 'no bot token to test yet'; out.ok = mode2 === 'webhook' && missing.length === 0; return out; }
    const auth = await slackAuthTest(botToken);
    if (auth.scopes) { out.grantedScopes = auth.scopes; out.missingScopes = (SLACK_BOT_SCOPES[mode2] ?? []).filter((s) => !auth.scopes.includes(s)); }
    if (!auth.ok) { out.error = auth.error ?? 'auth.test failed'; return out; }
    out.team = auth.team; out.botName = auth.botName; out.ok = missing.length === 0;
    const chans = await slackListChannels(botToken);
    if (chans.ok) out.channels = chans.channels;
    else if (chans.needsScope) out.channelsNeedScope = true;
    else out.channelsError = chans.error;
    if (mode2 === 'socket') {
      if (!appToken) { out.socket = { ok: false, error: 'missing app token' }; out.ok = false; return out; }
      const sock = await slackConnectionsOpenTest(appToken);
      out.socket = sock;
      if (!sock.ok) out.ok = false;
    }
    return out;
  };

  ctx.slackOps = { startSlackIngestion, stopSlackIngestion, slackStatusNow, slackTestNow, writeSlackConfig, slackReadiness, appendSlackHistory, postSlackReply, slackReplyScriptPath, slackReplyConfigPath };

  ipcMain.handle('slack:start', () => startSlackIngestion());
  ipcMain.handle('slack:stop', () => { ctx.writeConfig({ slackEnabled: false }); stopSlackIngestion(); return { ok: true }; });
  ipcMain.handle('slack:status', () => slackStatusNow());
  ipcMain.handle('slack:test', (_e, draft) => {
    const d = draft ?? {};
    const str2 = (v) => typeof v === 'string' ? v : void 0;
    return slackTestNow({
      mode: SLACK_MODES.includes(String(d.mode)) ? d.mode : void 0,
      botToken: str2(d.botToken), appToken: str2(d.appToken), signingSecret: str2(d.signingSecret),
    });
  });
  ipcMain.handle('slack:history', () => listSlackHistory());
  ipcMain.handle('slack:replyScriptPath', () => slackReplyScriptPath());
  ipcMain.handle('slack:reply', (_e, arg) => {
    const p = arg ?? {};
    const cfg = ctx.readConfig();
    if (!cfg.slackProactivePosting) return { ok: false, error: SLACK_PROACTIVE_OFF_REASON };
    const botToken = cfg.slackBotToken;
    if (!botToken) return { ok: false, error: 'no bot token' };
    if (typeof p.channel !== 'string' || typeof p.thread_ts !== 'string' || typeof p.text !== 'string') {
      return { ok: false, error: 'channel, thread_ts, text required' };
    }
    if (!p.channel.trim() || !p.thread_ts.trim()) return { ok: false, error: 'explicit channel + thread_ts required' };
    return postSlackReply({ botToken, channel: p.channel, thread_ts: p.thread_ts, text: p.text });
  });
  ipcMain.handle('slack:setConfig', (_e, patch) => writeSlackConfig(patch));
}

module.exports = { register };
