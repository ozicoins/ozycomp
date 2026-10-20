'use strict';
/**
 * Verbatim port — reference out/main/index.js lines 35517-36968
 * (`dictation:*` in-app dictation group: focus, inAppHold, helperReady,
 * inAppEvent, take).
 *
 * Mapping to ctx deps:
 *   mainWindow            → ctx.win()
 *   anyAppLoop            → ctx.anyAppLoop() ?? ctx.anyApp (the live
 *                           AnyAppDictation armed by electron-main's boot or a
 *                           future anyApp group; `?.armed` reads identically)
 *   anyAppTrusted         → ctx.dictationHelper state (armed + a fresh
 *                           loop.permissions() grant flip it; the anyApp
 *                           group's refreshAnyAppTrust writes it too when it
 *                           shares this object)
 *   puckDictationEvent /
 *   isPuckContents        → ctx.puckRuntime (../puck-runtime.js exports both)
 *   getTranscribeRouter() → ctx.voice
 *   hive.appendLog(line)  → ctx.harness.hive.log(line) (clone log signature)
 *   helperIgnoresTake /
 *   cleanInAppEvent /
 *   takeLine / ms         → verbatim copies below (module-local, same names)
 *   withTranscribeDefaults,
 *   defaultPushToTalkKeyFor → ../voice.js exports
 *
 * The state bag is stashed as ctx.dictationHelper (and aliased
 * ctx.dictationState) so the anyApp/meetingHotkey groups can share
 * mainDictationFocus / inAppHolding / anyAppTrusted verbatim.
 */

const { withTranscribeDefaults, defaultPushToTalkKeyFor } = require('../voice');

// ── verbatim helpers (reference lines 5015-5020, 31386-31410) ────────────────
function anyAppStandsAside(focus, inAppHolding2) {
  return focus === "password" || inAppHolding2;
}
function helperIgnoresTake(windowFocused, anyApp, focus, inAppHolding2) {
  return windowFocused ? anyAppStandsAside(focus, inAppHolding2) : !anyApp;
}
const IN_APP_EVENT_TYPES = ["keydown", "level", "keyup", "transcribing", "injected", "empty", "cancelled"];
function cleanInAppEvent(raw) {
  const e = raw && typeof raw === "object" ? raw : {};
  const type = e.type;
  if (!IN_APP_EVENT_TYPES.includes(type)) return null;
  if (type === "level") {
    const num2 = (v) => typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    return { type, rms: num2(e.rms), peak: num2(e.peak) };
  }
  if (type === "cancelled") return { type, why: typeof e.why === "string" ? e.why.slice(0, 40) : "" };
  return { type };
}
const ms = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 6e5 ? Math.round(v) : null;
function takeLine(p) {
  const secs = typeof p.clipSeconds === "number" && Number.isFinite(p.clipSeconds) && p.clipSeconds >= 0 ? Math.round(p.clipSeconds * 100) / 100 : null;
  const outcome = p.outcome === "empty" || p.outcome === "error" ? p.outcome : "text";
  return {
    kind: "dictation-take",
    path: p.path,
    inWindow: p.path === "in-app" || p.inWindow === true,
    engine: typeof p.engine === "string" && /^[a-z]{1,16}$/.test(p.engine) ? p.engine : null,
    clipSeconds: secs,
    downToRecordingMs: ms(p.downToRecordingMs),
    upToTextMs: ms(p.upToTextMs),
    streamed: p.streamed === true,
    outcome
  };
}

function register(ctx) {
  // Reference globals — shared verbatim-shaped bag so sibling groups (anyApp,
  // meetingHotkey) read the same focus/hold/trust the renderer reported.
  const st = ctx.dictationHelper ??= { mainDictationFocus: "other", inAppHolding: false, anyAppTrusted: false };
  ctx.dictationState ??= st;

  const mainWindow = () => ctx.win();
  const anyAppLoop = () => (typeof ctx.anyAppLoop === "function" ? ctx.anyAppLoop() : null) ?? ctx.anyApp ?? null;

  const mainWindowFocused = () => {
    const f = ctx.BrowserWindow.getFocusedWindow();
    return !!f && f === mainWindow();
  };
  function anyAppIgnoresTake() {
    return helperIgnoresTake(mainWindowFocused(), withTranscribeDefaults(ctx.readConfig().transcribe).anyApp, st.mainDictationFocus, st.inAppHolding);
  }
  // Exposed verbatim seams the anyApp group wires into the loop's opts.
  ctx.dictationIgnore = anyAppIgnoresTake;
  ctx.dictationRoute = () => mainWindowFocused();

  function helperReadyNow() {
    return process.platform === "darwin" && anyAppLoop()?.armed === defaultPushToTalkKeyFor("darwin") && st.anyAppTrusted;
  }
  function pushHelperReady() {
    const wc = mainWindow()?.webContents;
    if (wc && !wc.isDestroyed()) wc.send("dictation:helperReady", helperReadyNow());
  }
  st.pushHelperReady = pushHelperReady;
  st.helperReadyNow = helperReadyNow;

  function logDictationTake(line) {
    try {
      ctx.harness.hive.log({ ...line });
    } catch {
    }
  }
  const dictationEngineNow = () => {
    try {
      return ctx.voice.status().chosen.dictation;
    } catch {
      return null;
    }
  };
  const puck = () => ctx.puckRuntime ?? require('../puck-runtime');

  // ── dictation:focus (reference ~35517) ─────────────────────────────────────
  ctx.ipcMain.on("dictation:focus", (e, focus) => {
    const w = mainWindow();
    if (!w || e.sender !== w.webContents) return;
    st.mainDictationFocus = focus === "composer" || focus === "field" || focus === "password" ? focus : "other";
  });

  // ── dictation:inAppHold (reference ~35523) ─────────────────────────────────
  ctx.ipcMain.on("dictation:inAppHold", (e, on) => {
    const w = mainWindow();
    if (!w || e.sender !== w.webContents) return;
    st.inAppHolding = on === true;
  });

  // ── dictation:helperReady (reference ~35542) ───────────────────────────────
  ctx.ipcMain.handle("dictation:helperReady", () => helperReadyNow());

  // ── dictation:inAppEvent (reference ~36962) ────────────────────────────────
  ctx.ipcMain.handle("dictation:inAppEvent", (e, raw) => {
    const ev = cleanInAppEvent(raw);
    const sounds = ev?.type === "keydown" ? withTranscribeDefaults(ctx.readConfig().transcribe).dictationSounds : true;
    if (ev && !puck().isPuckContents(e.sender)) puck().puckDictationEvent(ev, false);
    return { sounds };
  });

  // ── dictation:take (reference ~36968) ──────────────────────────────────────
  ctx.ipcMain.on("dictation:take", (e, raw) => {
    if (puck().isPuckContents(e.sender)) return;
    const r = raw ?? {};
    logDictationTake(takeLine({ path: "in-app", engine: dictationEngineNow(), clipSeconds: r.clipSeconds, downToRecordingMs: r.downToRecordingMs, upToTextMs: r.upToTextMs, streamed: r.streamed, outcome: r.outcome }));
  });
}

module.exports = { register };
