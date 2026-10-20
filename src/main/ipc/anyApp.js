'use strict';
/**
 * anyApp:* / captureHotkey:* / meetingHotkey:* / systemAudio:* IPC surface —
 * verbatim port of reference index.js ~35430-35847.
 *
 * Shared verbatim state lives in the ctx.dictationHelper bag created by
 * dictation.js (mainDictationFocus / inAppHolding / anyAppTrusted) plus the
 * loop singleton stashed here as ctx.anyAppLoop (getter fn) so dictation.js
 * reads the same armed loop the reference does.
 */
const path = require('node:path');
const {
  AnyAppDictation, LineHelper, HelperError,
  mdHotkeyPath, anyAppUnavailableReason, hotkeyProblem,
  needsNewHelperKey, meetingKeyFor, captureKeyFor, defaultMeetingKey, defaultCaptureKey,
  PRINT_SCREEN,
} = require('../anyapp');
const {
  withTranscribeDefaults, defaultPushToTalkKeyFor, correctTranscript,
  MdSpeech, mdSpeechPath, mdSpeechAvailable, encodeWav,
} = require('../voice');

function sameChord(a, b) {
  const norm2 = (n) => {
    const parts = String(n ?? '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
    const last = parts.pop() ?? '';
    const key = PRINT_SCREEN.has(last) ? 'printscreen' : last;
    const mods = parts.map((m) => m === 'cmd' || m === 'super' || m === 'meta' ? 'command' : m === 'ctrl' ? 'control' : m === 'option' || m === 'opt' ? 'alt' : m).sort();
    return [...mods, key].join('+');
  };
  return norm2(a) === norm2(b);
}

/** Verbatim MeetingHotkey (ref ~21196) — tap-only LineHelper loop. */
class MeetingHotkey {
  constructor(opts) {
    this.opts = opts;
    this.helper = new LineHelper(opts.helperPath, {
      env: opts.env,
      onEvent: (e) => {
        if (e.event === 'tap') this.pressed(typeof e.at === 'number' ? e.at : Date.now());
      },
      onExit: () => { this.armedKey = null; },
    });
    this.armedKey = null;
    this.lastAt = 0;
  }
  get armed() { return this.armedKey; }
  pressed(at) {
    if (at - this.lastAt < 250) return;
    this.lastAt = at;
    this.opts.onToggle(at);
  }
  async start() {
    try {
      const ping = await this.helper.request({ op: 'ping' });
      if (ping.tap !== true) throw new HelperError('no-tap', { version: ping.version });
      const r = await this.helper.request({ op: 'tap', key: this.opts.key });
      this.armedKey = this.opts.key;
      return { key: this.opts.key, keyCode: Number(r.keyCode) };
    } catch (e) {
      await this.helper.stop().catch(() => {});
      if (e instanceof HelperError) throw e;
      throw new HelperError('start-failed', { detail: e instanceof Error ? e.message : String(e) });
    }
  }
  async stop() {
    this.armedKey = null;
    if (!this.helper.running) return;
    try { await this.helper.request({ op: 'untap' }); } catch {}
    await this.helper.stop().catch(() => {});
  }
  get lineHelper() { return this.helper; }
}

function register(ctx) {
  const { ipcMain, app, BrowserWindow } = ctx;

  // ── verbatim shared state ────────────────────────────────────────────────
  const st = ctx.dictationHelper ??= { mainDictationFocus: 'other', inAppHolding: false, anyAppTrusted: false };
  const mainWindow = () => ctx.win();
  const puck = () => ctx.puckRuntime ?? require('../puck-runtime');

  const anyAppResources = () => app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../resources');
  const anyAppReason = () => anyAppUnavailableReason(anyAppResources(), process.platform, process.env, { floor: ctx.isFloorBoot?.() ?? false });
  const mainWindowFocused = () => {
    const f = BrowserWindow.getFocusedWindow();
    return !!f && f === mainWindow();
  };
  const getTranscribeRouter = () => ctx.voice;

  function anyAppViaRouter(route) {
    return {
      transcribe: async (req) => {
        const bytes = new Uint8Array(req.pcm16.byteLength - req.pcm16.byteLength % 2);
        bytes.set(req.pcm16.subarray(0, bytes.byteLength));
        const wav = Buffer.from(encodeWav(new Int16Array(bytes.buffer), req.sampleRate));
        const r = await route(wav);
        if (!r.ok) throw new Error(r.error ?? 'transcription failed');
        return { text: (r.text ?? '').trim() };
      },
    };
  }
  function anyAppTranscriber() {
    const router = getTranscribeRouter();
    const engine = router.status().chosen.dictation;
    if (engine !== 'apple') {
      if (!engine) return null;
      return anyAppViaRouter((wav) => router.transcribe({ audio: wav, mimeType: 'audio/wav', mode: 'dictation' }));
    }
    if (!mdSpeechAvailable(anyAppResources())) return null;
    loop.speech ??= new MdSpeech(mdSpeechPath(anyAppResources()));
    const speech = loop.speech;
    const spell = (r) => ({ ...r, text: correctTranscript(r.text, router.words(), router.config().customWords) });
    return {
      transcribe: (req, onPartial) => speech.transcribe({ ...req, autoInstall: true }, onPartial).then(spell),
      openStream: (req, onPartial) => speech.openStream(req, onPartial).then((s2) => ({ push: (b) => s2.push(b), cancel: () => s2.cancel(), end: () => s2.end().then(spell) })),
    };
  }
  let anyAppWarmed = null;
  function warmAnyAppSpeech() {
    const speech = loop.speech;
    if (!speech || anyAppWarmed === speech) return;
    anyAppWarmed = speech;
    void speech.install('en_US').then(() => speech.warm('en_US')).then((r) => console.log(`[anyApp] md-speech warm in ${r.ms} ms`)).catch((e) => {
      anyAppWarmed = null;
      console.log(`[anyApp] warm: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  // ── the loop singleton + verbatim event plumbing ─────────────────────────
  const loop = ctx.anyAppLoop ??= { loop: null, speech: null };
  ctx.anyAppLoopRef = loop;
  const anyAppLoopGet = () => loop.loop;
  ctx.anyAppLoop = anyAppLoopGet;   // dictation.js prefers the fn form

  let helperTake = null;
  const takeLine = (p) => {
    const ms2 = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 6e5 ? Math.round(v) : null;
    const secs = typeof p.clipSeconds === 'number' && Number.isFinite(p.clipSeconds) && p.clipSeconds >= 0 ? Math.round(p.clipSeconds * 100) / 100 : null;
    const outcome = p.outcome === 'empty' || p.outcome === 'error' ? p.outcome : 'text';
    return {
      kind: 'dictation-take', path: p.path, inWindow: p.path === 'in-app' || p.inWindow === true,
      engine: typeof p.engine === 'string' && /^[a-z]{1,16}$/.test(p.engine) ? p.engine : null,
      clipSeconds: secs, downToRecordingMs: ms2(p.downToRecordingMs), upToTextMs: ms2(p.upToTextMs),
      streamed: p.streamed === true, outcome,
    };
  };
  const dictationEngineNow = () => { try { return getTranscribeRouter().status().chosen.dictation; } catch { return null; } };
  function logDictationTake(line) { try { ctx.harness.hive.log({ ...line }); } catch {} }
  function noteHelperTake(e) {
    if (e.type === 'keydown') {
      helperTake = { keyupAt: 0, seconds: null, streamed: false, inWindow: e.routed === true };
      return;
    }
    const t = helperTake;
    if (!t) return;
    if (e.type === 'keyup') { t.keyupAt = Date.now(); return; }
    if (e.type === 'transcribing') { t.seconds = e.seconds; t.streamed = e.streamed; return; }
    if (e.type === 'injected' || e.type === 'empty' || e.type === 'error') {
      helperTake = null;
      logDictationTake(takeLine({
        path: 'helper', inWindow: t.inWindow, engine: dictationEngineNow(),
        clipSeconds: t.seconds, downToRecordingMs: null,
        upToTextMs: e.type === 'injected' ? e.ms : t.keyupAt ? Date.now() - t.keyupAt : null,
        streamed: e.type === 'injected' ? e.streamed : t.streamed,
        outcome: e.type === 'injected' ? 'text' : e.type,
      }));
      return;
    }
    if (e.type === 'cancelled' || e.type === 'tap' || e.type === 'helper-exited') helperTake = null;
  }
  function anyAppEvent(e) {
    const sounds = withTranscribeDefaults(ctx.readConfig().transcribe).dictationSounds;
    puck().puckDictationEvent?.(e, sounds && !e.routed);
    if (e.type === 'level') return;
    noteHelperTake(e);
    const wc = mainWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send('anyApp:event', e.routed ? { ...e, sounds } : e);
  }
  const anyAppIgnoresTake = () => ctx.dictationIgnore?.() ?? false;
  const anyAppRoutesTake = () => ctx.dictationRoute?.() ?? mainWindowFocused();

  function pushHelperReady() { st.pushHelperReady?.(); }
  async function refreshAnyAppTrust() {
    const l = loop.loop;
    let trusted = false;
    if (l) {
      try {
        const p = await l.permissions();
        trusted = p.accessibility && p.mic !== 'denied' && p.mic !== 'restricted';
      } catch { trusted = false; }
    }
    st.anyAppTrusted = trusted;
    pushHelperReady();
  }
  ctx.refreshAnyAppTrust = refreshAnyAppTrust;

  ipcMain.handle('anyApp:status', async () => {
    const reason = anyAppReason();
    const available = reason === null;
    const l = loop.loop ?? (available ? new AnyAppDictation({ helperPath: mdHotkeyPath(anyAppResources()), key: defaultPushToTalkKeyFor(process.platform), transcriber: { transcribe: async () => ({ text: '' }) } }) : null);
    let permissions = null;
    if (l) {
      try { permissions = await l.permissions(); } catch { permissions = null; }
    }
    if (!loop.loop && l) await l.stop();
    return { available, reason, platform: process.platform, armed: loop.loop?.armed ?? null, transcriber: anyAppTranscriber() ? getTranscribeRouter().status().chosen.dictation : null, permissions };
  });

  async function startAnyApp(key, words) {
    if (ctx.isFloorBoot?.()) return { ok: false, error: 'main-floor-only', detail: 'Dictate into any app is armed by the main floor' };
    const reason = anyAppReason();
    if (reason) return { ok: false, error: 'not-available', detail: reason };
    const transcriber = anyAppTranscriber();
    if (!transcriber) return { ok: false, error: 'no-transcriber' };
    if (loop.loop) await loop.loop.stop();
    loop.loop = new AnyAppDictation({
      helperPath: mdHotkeyPath(anyAppResources()),
      key: key || defaultPushToTalkKeyFor(process.platform),
      transcriber,
      words: words ? () => words : () => getTranscribeRouter().words(),
      onEvent: anyAppEvent,
      ignore: anyAppIgnoresTake,
      route: anyAppRoutesTake,
    });
    try {
      const r = await loop.loop.start();
      if (getTranscribeRouter().status().chosen.dictation === 'apple') warmAnyAppSpeech();
      return { ok: true, ...r };
    } catch (e) {
      const code = e instanceof HelperError ? e.code : 'start-failed';
      await loop.loop.stop().catch(() => {});
      loop.loop = null;
      return { ok: false, error: code, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  ctx.startAnyApp = startAnyApp;

  const anyAppWanted = (anyApp2, windowFocused, dictation = true) => dictation && (anyApp2 || windowFocused);
  async function disarmAnyAppWhenIdle() {
    const l = loop.loop;
    if (!l) return;
    await l.whenIdle();
    const now = withTranscribeDefaults(ctx.readConfig().transcribe);
    if (loop.loop !== l || anyAppWanted(now.anyApp, mainWindowFocused(), now.dictation)) return;
    await l.stop();
    loop.loop = null;
    st.anyAppTrusted = false;
    pushHelperReady();
  }
  let anyAppAsked = false;
  async function askAnyAppPermissionsOnce() {
    const l = loop.loop;
    if (!l) return;
    try {
      let p = await l.permissions();
      if (!anyAppAsked) {
        anyAppAsked = true;
        if (p.mic === 'notDetermined') await l.requestMic();
        if (!p.accessibility) await l.requestAccessibility();
        p = await l.permissions();
      }
      const missing = p.mic !== 'authorized' ? 'microphone' : !p.accessibility ? 'accessibility' : null;
      if (missing) puck().puckDictationEvent?.({ type: 'error', error: 'permission', detail: missing }, false);
    } catch (e) {
      console.log(`[anyApp] permissions: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function syncAnyAppNow(t) {
    if (anyAppReason()) return;
    if (!anyAppWanted(t.anyApp, mainWindowFocused(), t.dictation)) {
      await disarmAnyAppWhenIdle();
      return;
    }
    if (loop.loop && loop.loop.armed === t.pushToTalkKey) return;
    const r = await startAnyApp(t.pushToTalkKey);
    if (!r.ok) {
      console.log(`[anyApp] could not arm ${t.pushToTalkKey}: ${r.error}${r.detail ? ` (${r.detail})` : ''}`);
      pushHelperReady();
      return;
    }
    if (t.anyApp) await askAnyAppPermissionsOnce();
    await refreshAnyAppTrust();
  }
  let anyAppSyncing = Promise.resolve();
  function syncAnyAppToConfig(t) {
    const run2 = anyAppSyncing.then(() => syncAnyAppNow(t ?? withTranscribeDefaults(ctx.readConfig().transcribe)));
    anyAppSyncing = run2.catch(() => void 0);
    return run2;
  }
  ctx.syncAnyAppToConfig = syncAnyAppToConfig;

  // ── meeting / capture hotkey loops ─────────────────────────────────────────
  const hk = ctx.anyAppHotkeys ??= { meeting: null, meetingError: null, capture: null, captureError: null };
  function meetingHotkeyReason() {
    const r = anyAppReason();
    return r === 'no-helper' ? 'not-available' : r;
  }
  async function syncMeetingHotkeyToConfig(t = withTranscribeDefaults(ctx.readConfig().transcribe)) {
    if (meetingHotkeyReason()) return;
    const key = meetingKeyFor(t.meetingKey, process.platform);
    if (hk.meeting && hk.meeting.armed === key) return;
    if (hk.meeting) { await hk.meeting.stop(); hk.meeting = null; }
    const problem = hotkeyProblem(key, process.platform);
    if (problem) {
      hk.meetingError = { reason: 'bad-key', detail: problem };
      console.log(`[meetingKey] not a chord: ${key} (${problem})`);
      return;
    }
    if (sameChord(key, t.pushToTalkKey)) {
      hk.meetingError = { reason: 'register-failed', detail: 'in-use-by-arm' };
      console.log(`[meetingKey] ${key} is the push to talk key`);
      return;
    }
    const l = new MeetingHotkey({
      helperPath: mdHotkeyPath(anyAppResources()),
      key,
      onToggle: () => {
        const r = puck().toggleMeetingByKey?.() ?? { ok: false, error: 'no-puck' };
        console.log(`[meetingKey] ${key}: ${r.ok ? 'toggled' : r.error}`);
      },
    });
    try {
      await l.start();
      hk.meeting = l;
      hk.meetingError = null;
      console.log(`[meetingKey] armed ${key}`);
    } catch (e) {
      hk.meetingError = { reason: e instanceof HelperError ? e.code : 'start-failed', detail: e instanceof Error ? e.message : String(e) };
      console.log(`[meetingKey] could not arm ${key}: ${hk.meetingError.reason} (${hk.meetingError.detail})`);
    }
  }
  async function syncCaptureHotkeyToConfig(t = withTranscribeDefaults(ctx.readConfig().transcribe)) {
    if (meetingHotkeyReason()) return;
    const key = captureKeyFor(t.captureKey, process.platform);
    if (hk.capture && hk.capture.armed === key) return;
    if (hk.capture) { await hk.capture.stop(); hk.capture = null; }
    hk.captureError = null;
    const problem = hotkeyProblem(key, process.platform);
    if (problem) {
      hk.captureError = { reason: 'bad-key', detail: problem };
      console.log(`[captureKey] not a chord: ${key} (${problem})`);
      return;
    }
    if (sameChord(key, t.pushToTalkKey)) {
      hk.captureError = { reason: 'register-failed', detail: 'in-use-by-arm' };
      return;
    }
    if (sameChord(key, meetingKeyFor(t.meetingKey, process.platform))) {
      hk.captureError = { reason: 'register-failed', detail: 'in-use-by-meeting' };
      return;
    }
    const l = new MeetingHotkey({
      helperPath: mdHotkeyPath(anyAppResources()),
      key,
      onToggle: () => {
        void (puck().captureByKey?.() ?? Promise.resolve({ ok: false, error: 'no-puck' })).then((r) => console.log(`[captureKey] ${key}: ${r.ok ? r.step : r.error}`));
      },
    });
    try {
      await l.start();
      hk.capture = l;
      console.log(`[captureKey] armed ${key}`);
    } catch (e) {
      hk.captureError = { reason: e instanceof HelperError ? e.code : 'start-failed', detail: e instanceof Error ? e.message : String(e) };
      if (hk.captureError.reason === 'bad-key' && needsNewHelperKey(key)) hk.captureError = { reason: 'needs-helper' };
      console.log(`[captureKey] could not arm ${key}: ${hk.captureError.reason} (${hk.captureError.detail})`);
    }
  }
  ctx.syncMeetingHotkeyToConfig = syncMeetingHotkeyToConfig;
  ctx.syncCaptureHotkeyToConfig = syncCaptureHotkeyToConfig;

  ipcMain.handle('captureHotkey:status', () => {
    const t = withTranscribeDefaults(ctx.readConfig().transcribe);
    return {
      platform: process.platform,
      key: captureKeyFor(t.captureKey, process.platform),
      defaultKey: defaultCaptureKey(process.platform),
      armed: hk.capture?.armed ?? null,
      reason: meetingHotkeyReason() ?? hk.captureError?.reason ?? null,
      detail: hk.captureError?.detail,
    };
  });
  ipcMain.handle('meetingHotkey:status', () => {
    const t = withTranscribeDefaults(ctx.readConfig().transcribe);
    return {
      platform: process.platform,
      key: meetingKeyFor(t.meetingKey, process.platform),
      defaultKey: defaultMeetingKey(process.platform),
      armed: hk.meeting?.armed ?? null,
      reason: meetingHotkeyReason() ?? hk.meetingError?.reason ?? null,
      detail: hk.meetingError?.detail,
    };
  });
  ipcMain.handle('anyApp:start', async (_evt, key, words) => {
    const list = Array.isArray(words) ? words.filter((w) => typeof w === 'string') : void 0;
    return startAnyApp(typeof key === 'string' && key ? key : defaultPushToTalkKeyFor(process.platform), list && list.length ? list : void 0).then(async (r) => {
      await refreshAnyAppTrust();
      return r;
    });
  });

  // ── systemAudio — no md-tap helper is bundled in this build, so the tap is
  //    always 'no-helper'; the linux monitor + status/request/openSettings
  //    shapes stay verbatim. ────────────────────────────────────────────────
  const sa = ctx.systemAudioState ??= { linuxMonitor: null, granted: false };
  const systemTapReady = () => false;
  const getSystemTap = () => null;
  async function systemAudioStatus() {
    if (process.platform === 'darwin') {
      if (!systemTapReady()) return { platform: 'darwin', available: false, granted: false, source: null, reason: 'no-helper' };
      sa.granted = false;
      return { platform: 'darwin', available: true, granted: false, source: null, reason: 'screen-not-granted' };
    }
    if (process.platform === 'win32') return { platform: 'win32', available: true, granted: true, source: 'renderer' };
    if (process.platform === 'linux') {
      return sa.linuxMonitor ? { platform: 'linux', available: true, granted: true, source: 'renderer', detail: sa.linuxMonitor.label } : { platform: 'linux', available: false, granted: true, source: null, reason: 'no-monitor' };
    }
    return { platform: process.platform, available: false, granted: false, source: null, reason: 'not-yet' };
  }
  ipcMain.on('systemAudio:monitor', (_e, m) => {
    const ok = !!m && typeof m === 'object' && typeof m.deviceId === 'string' && typeof m.label === 'string';
    const next = ok ? { deviceId: m.deviceId, label: m.label } : null;
    if ((next?.label ?? null) !== (sa.linuxMonitor?.label ?? null)) console.log(`[systemAudio] linux monitor: ${next ? next.label : 'none'}`);
    sa.linuxMonitor = next;
  });
  ipcMain.handle('systemAudio:status', () => systemAudioStatus());
  ipcMain.handle('systemAudio:request', async () => {
    const tap = getSystemTap();
    if (!tap) return { ok: false, error: 'not-available' };
    try {
      const r = await tap.requestPermission();
      sa.granted = r.screen;
      return { ok: true, granted: r.screen };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  ipcMain.handle('systemAudio:openSettings', async () => {
    const tap = getSystemTap();
    if (!tap) return { ok: false, error: 'not-available' };
    return { ok: await tap.openSettings() };
  });
  void systemAudioStatus().catch(() => {});

  // ── stop + withAnyAppHelper fan ──────────────────────────────────────────
  ipcMain.handle('anyApp:stop', async () => {
    if (loop.loop) {
      await loop.loop.stop();
      loop.loop = null;
    }
    st.anyAppTrusted = false;
    pushHelperReady();
    return { ok: true };
  });
  async function withAnyAppHelper(fn) {
    if (anyAppReason()) return { ok: false, error: 'not-available' };
    if (loop.loop) return fn(loop.loop);
    const tmp = new AnyAppDictation({ helperPath: mdHotkeyPath(anyAppResources()), key: defaultPushToTalkKeyFor(process.platform), transcriber: { transcribe: async () => ({ text: '' }) } });
    try {
      return await fn(tmp);
    } finally {
      await tmp.stop();
    }
  }
  ipcMain.handle('anyApp:requestMic', () => withAnyAppHelper(async (l) => ({ ok: true, mic: await l.requestMic() })));
  ipcMain.handle('anyApp:requestAccessibility', () => withAnyAppHelper(async (l) => ({ ok: true, accessibility: await l.requestAccessibility() })));
  ipcMain.handle('anyApp:openSettings', (_evt, pane) => withAnyAppHelper(async (l) => ({ ok: await l.openSettings(pane === 'microphone' ? 'microphone' : 'accessibility') })));
  ipcMain.handle('anyApp:testPaste', (_evt, text) => withAnyAppHelper(async (l) => {
    try {
      return { ok: true, ...await l.inject(typeof text === 'string' ? text : 'OzyComp can type here.') };
    } catch (e) {
      return { ok: false, error: e instanceof HelperError ? e.code : 'inject-failed' };
    }
  }));

  app.on('will-quit', () => {
    void loop.loop?.stop();
    void loop.speech?.stop();
  });
}

module.exports = { register };
