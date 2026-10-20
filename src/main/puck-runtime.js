'use strict';
/**
 * Puck runtime — the floating stapler's live surfaces, verbatim port of the
 * reference block (index.js ~19560-21084). Window lifecycle, drag physics,
 * gaze follow, screen-capture overlay, meeting/message recording with a
 * two-track transcript, and the full IPC surface.
 *
 * `deps` is injected by the host: readConfig/writeConfig/onConfigWritten,
 * agentIds/agentName, hiveSend/hiveEnabled, broadcast, transcribe,
 * systemAudioSource/startSystemAudio/stopSystemAudio, openSettings,
 * rendererUrl|rendererDir, preload.
 */
const node_fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const {
  DEFAULT_PUCK_STATE, DEFAULT_PUCK_CONFIG,
  normalizePuckConfig, isZoomKey, resolvePuckPlacement,
  cornerPosition, clampCentre, snapToEdge, centreOf, windowFor,
  initialRegion, clampRegion, inside,
  meetingIdFor, clockOf, puckRecipients, sendToFor,
  meetingEditable, meetingMessage, segmentTranscribed, segmentError, settleMeetingStatus,
  PUCK_SHOT_TTL_MS, PUCK_MAX_SHOTS, PUCK_AUDIO_TTL_MS, PUCK_SWEEP_EVERY_MS,
  PUCK_DIR, PUCK_SCREENSHOTS_DIR, PUCK_MEETINGS_DIR, PUCK_MESSAGE_MAX_SECONDS,
  PUCK_MEETING_DESCRIPTION_MAX, PUCK_MEETING_TEXT_MAX, PUCK_MEETING_SEND_MAX,
} = require('./puck');
const { withTranscribeDefaults } = require('./voice');
const { encodeWav } = require('./voice');

const RING_RATE = 16e3;
const TAKE_WATCHDOG_MS = 6e4;
const WAV_SAMPLE_RATE = 16e3;

let deps = null;
let win = null;
let overlay = null;
let overlayDisplay = null;
let admitted = false;
let centre = null;
let dragging = false;
let drag = null;
const DRAG_TICK_MS = 8;
const DELTA_FALLBACK_PX = 24;
const POINTER_TRUST_PX = 200;
const DRAG_SILENT_MS = 700;
let hiddenForCapture = false;
let settleTimers = [];
let manualInvisible = false;
let micLive = false;
let state = { ...DEFAULT_PUCK_STATE };
const transcribeQueues = /* @__PURE__ */ new Map();
let systemSource = null;
let ring = null;
const meetingSystemAudio = {
  begin(startedAt = Date.now()) {
    ring = { startedAt, chunks: [], samples: 0 };
  },
  active() {
    return ring !== null;
  },
  push(pcm16, ts) {
    if (!ring) return;
    const pcm = pcm16 instanceof Int16Array ? pcm16 : new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.byteLength / 2));
    if (pcm.length === 0) return;
    const at = typeof ts === "number" && Number.isFinite(ts) ? ts : ring.startedAt + ring.samples / RING_RATE * 1e3;
    ring.chunks.push({ at, pcm: pcm.slice() });
    ring.samples += pcm.length;
  },
  /** The samples between two moments on the wall clock, silence where the
   *  helper gave nothing (a gap is a gap, never a time shift). */
  cut(fromAt, toAt) {
    const n = Math.max(0, Math.round((toAt - fromAt) / 1e3 * RING_RATE));
    const out = new Int16Array(n);
    if (!ring || n === 0) return out;
    for (const c of ring.chunks) {
      const offset = Math.round((c.at - fromAt) / 1e3 * RING_RATE);
      if (offset >= n || offset + c.pcm.length <= 0) continue;
      const src0 = Math.max(0, -offset);
      const dst0 = Math.max(0, offset);
      const len = Math.min(c.pcm.length - src0, n - dst0);
      if (len > 0) out.set(c.pcm.subarray(src0, src0 + len), dst0);
    }
    return out;
  },
  /** Drop what a delivered segment no longer needs, so a long call does not
   *  hold every chunk of itself. */
  trim(beforeAt) {
    if (!ring) return;
    ring.chunks = ring.chunks.filter((c) => c.at + c.pcm.length / RING_RATE * 1e3 > beforeAt);
  },
  end() {
    ring = null;
  }
};
const pendingThem = /* @__PURE__ */ new Map();
function puckMicLive() {
  return micLive;
}
function isPuckContents(wc) {
  return !!wc && !!win && !win.isDestroyed() && win.webContents === wc;
}
const cfgOf = () => normalizePuckConfig(deps?.readConfig().puck);
const themeOf = () => deps?.readConfig().terminalTheme === "dark" ? "dark" : "light";
function sleep(ms2) {
  return new Promise((r) => setTimeout(r, ms2));
}
function errMsg$1(e) {
  return e instanceof Error ? e.message : String(e);
}
function setState(patch, quiet = false) {
  state = { ...state, ...patch };
  try {
    if (win && !win.isDestroyed()) win.webContents.send("puck:state", state);
  } catch {
  }
  if (quiet) return;
  try {
    deps?.broadcast("puck:state", state);
  } catch {
  }
}
function pushConfig(cfg) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send("puck:config", cfg);
  } catch {
  }
}
function screenAccess() {
  if (process.platform !== "darwin") return "granted";
  try {
    return electron.systemPreferences.getMediaAccessStatus("screen");
  } catch {
    return "unknown";
  }
}
function dictationOn() {
  return deps ? withTranscribeDefaults(deps.readConfig().transcribe).dictation : true;
}
function canTranscribe() {
  if (!deps) return false;
  const t = withTranscribeDefaults(deps.readConfig().transcribe);
  return t.engine !== "off" || (deps.readConfig().groqApiKey ?? "") !== "";
}
function loadPage(w, page) {
  if (!deps) return;
  if (deps.rendererUrl) void w.loadURL(`${deps.rendererUrl.replace(/\/$/, "")}/${page}.html`);
  else void w.loadFile(path.join(deps.rendererDir, `${page}.html`));
}
function lockZoom(w) {
  const wc = w.webContents;
  const reset = () => {
    try {
      if (!wc.isDestroyed() && wc.getZoomLevel() !== 0) wc.setZoomLevel(0);
    } catch {
    }
  };
  wc.on("did-finish-load", () => {
    reset();
    try {
      void wc.setVisualZoomLevelLimits(1, 1);
    } catch {
    }
  });
  wc.on("zoom-changed", reset);
  wc.on("before-input-event", (e, input) => {
    if (isZoomKey(input, process.platform === "darwin")) {
      e.preventDefault();
      reset();
    }
  });
}
function platformWindowType() {
  if (process.platform === "darwin") return { type: "panel" };
  if (process.platform === "win32") return { type: "toolbar" };
  return {};
}
function raise(w, onTop) {
  const capturing = state.capturing;
  try {
    w.setAlwaysOnTop(onTop || capturing, "screen-saver", capturing ? 3 : 1);
    w.setVisibleOnAllWorkspaces(onTop || capturing, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch {
  }
}
const asDisplay = (d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea });
function target(cfg) {
  if (dragging && centre) return { centre, area: electron.screen.getDisplayNearestPoint(centre).workArea };
  let all = [];
  let primaryId = null;
  try {
    all = electron.screen.getAllDisplays();
    primaryId = electron.screen.getPrimaryDisplay().id;
  } catch {
  }
  const t = resolvePuckPlacement({ home: cfg.home, position: cfg.position, corner: cfg.corner, size: cfg.size, displays: all.map(asDisplay), primaryId });
  if (t) return { centre: t.centre, area: t.display.workArea };
  const area = electron.screen.getPrimaryDisplay().workArea;
  return { centre: cornerPosition(cfg.corner, area, cfg.size), area };
}
function currentCentre(cfg) {
  return centre ?? target(cfg).centre;
}
function readPointer() {
  try {
    return electron.screen.getCursorScreenPoint();
  } catch {
    return null;
  }
}
const GAZE_TICK_MS = 50;
let gazeTimer = null;
let lastGaze = null;
function gazeTick() {
  const w = win;
  if (!w || w.isDestroyed() || !w.isVisible()) return;
  const p = readPointer();
  if (!p || lastGaze && lastGaze.x === p.x && lastGaze.y === p.y) return;
  lastGaze = p;
  try {
    const b = w.getContentBounds();
    w.webContents.send("puck:cursor", { x: p.x - b.x, y: p.y - b.y });
  } catch {
  }
}
function syncGaze(on) {
  if (on && !gazeTimer) {
    lastGaze = null;
    gazeTimer = setInterval(gazeTick, GAZE_TICK_MS);
    gazeTimer.unref?.();
  } else if (!on && gazeTimer) {
    clearInterval(gazeTimer);
    gazeTimer = null;
    lastGaze = null;
  }
}
function stopDrag() {
  if (drag?.timer) clearInterval(drag.timer);
  drag = null;
  dragging = false;
}
function dragTick() {
  const g = drag;
  if (!g || g.mode !== "cursor" || !win || win.isDestroyed()) return;
  const p = readPointer();
  if (!p) return;
  const now = Date.now();
  if (g.last && p.x === g.last.x && p.y === g.last.y) {
    if (g.unheard !== null && now - g.unheard > DRAG_SILENT_MS) endDrag();
    return;
  }
  if (g.last && g.unheard === null) g.unheard = now;
  if (g.unheard !== null && now - g.unheard > DRAG_SILENT_MS) {
    endDrag();
    return;
  }
  g.last = p;
  centre = { x: p.x - g.grab.x, y: p.y - g.grab.y };
  place(cfgOf());
}
function endDrag() {
  const g = drag;
  if (!g || !deps) {
    stopDrag();
    return;
  }
  if (g.timer) {
    clearInterval(g.timer);
    g.timer = null;
  }
  const cfg = cfgOf();
  if (g.mode === "cursor") {
    const p = readPointer();
    if (p) centre = { x: p.x - g.grab.x, y: p.y - g.grab.y };
  }
  const c = currentCentre(cfg);
  const on = electron.screen.getDisplayNearestPoint(c);
  centre = cfg.snapToEdges ? snapToEdge(c, on.workArea, cfg.size) : clampCentre(c, on.workArea, cfg.size);
  place(cfg);
  const parked = centre;
  stopDrag();
  deps.writeConfig({ puck: { ...cfg, position: parked, home: { displayId: on.id, dx: parked.x - on.bounds.x, dy: parked.y - on.bounds.y } } });
}
function place(cfg) {
  if (!win || win.isDestroyed()) return;
  const t = target(cfg);
  const { window: bounds, offset, screen: onIt } = windowFor(t.centre, t.area, cfg.size);
  let disc = { x: bounds.x + offset.x, y: bounds.y + offset.y };
  let real2 = bounds;
  try {
    win.setBounds(bounds);
    const got = win.getBounds();
    if (got.x !== bounds.x || got.y !== bounds.y || got.width !== bounds.width || got.height !== bounds.height) {
      real2 = got;
      const inWin = { x: Math.max(t.area.x, got.x), y: Math.max(t.area.y, got.y), width: 0, height: 0 };
      inWin.width = Math.min(t.area.x + t.area.width, got.x + got.width) - inWin.x;
      inWin.height = Math.min(t.area.y + t.area.height, got.y + got.height) - inWin.y;
      if (inWin.width > 0 && inWin.height > 0) disc = clampCentre(disc, inWin, cfg.size);
    }
  } catch {
  }
  centre = disc;
  const at = { x: disc.x - real2.x, y: disc.y - real2.y };
  const screenIn = real2 === bounds ? onIt : { x0: t.area.x - real2.x, y0: t.area.y - real2.y, x1: t.area.x + t.area.width - real2.x, y1: t.area.y + t.area.height - real2.y };
  setState({ offset: at, screen: screenIn }, true);
}
function rehome() {
  if (!win || win.isDestroyed()) return;
  if (!dragging) centre = null;
  place(cfgOf());
  if (state.shown && !hiddenForCapture) {
    raise(win, cfgOf().alwaysOnTop);
    try {
      if (!win.isVisible()) win.showInactive();
    } catch {
    }
  }
}
function displaysChanged() {
  for (const t of settleTimers) clearTimeout(t);
  rehome();
  settleTimers = [400, 2e3].map((ms2) => {
    const t = setTimeout(() => {
      rehome();
    }, ms2);
    t.unref?.();
    return t;
  });
}
function installLoopback(w) {
  if (process.platform !== "win32") return;
  try {
    w.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
      electron.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }).then((sources) => {
        const source = sources[0];
        if (!source) {
          callback({});
          return;
        }
        callback({ video: source, audio: "loopback" });
      }).catch(() => callback({}));
    });
  } catch (e) {
    console.log(`[puck] loopback handler not installed: ${errMsg$1(e)}`);
  }
}
async function captureByKey() {
  if (!deps) return { ok: false, error: "not-registered" };
  if (overlay && !overlay.isDestroyed()) {
    const r2 = requestCapture();
    return r2.ok ? { ok: true, step: "capture" } : r2;
  }
  if (!win || win.isDestroyed()) {
    if (!admitted) return { ok: false, error: "not-admitted" };
    const cfg = cfgOf();
    if (!cfg.enabled) return { ok: false, error: "puck-off" };
    createWindow$1(cfg);
  }
  const w = win;
  if (!w || w.isDestroyed()) return { ok: false, error: "no-window" };
  try {
    if (!w.isVisible()) w.showInactive();
    raise(w, cfgOf().alwaysOnTop);
  } catch {
  }
  if (w.webContents.isLoading()) await new Promise((res) => w.webContents.once("did-finish-load", () => res()));
  const r = await openOverlay();
  return r.ok ? { ok: true, step: "open" } : r;
}
function puckDictationEvent(e, sounds) {
  const w = win;
  if (!w || w.isDestroyed() || w.webContents.isLoading()) return;
  try {
    w.webContents.send("puck:dictation", { ...e, sounds });
  } catch {
  }
}
function puckTranscribeChanged() {
  if (!deps) return;
  setState({ canTranscribe: canTranscribe(), dictation: dictationOn() });
}
function toggleMeetingByKey() {
  if (!deps) return { ok: false, error: "not-registered" };
  if (state.recording?.kind === "message") return { ok: false, error: "message-recording" };
  if (!win || win.isDestroyed()) {
    if (!admitted) return { ok: false, error: "not-admitted" };
    const cfg = cfgOf();
    if (!cfg.enabled) return { ok: false, error: "puck-off" };
    createWindow$1(cfg);
  }
  const w = win;
  if (!w || w.isDestroyed()) return { ok: false, error: "no-window" };
  try {
    if (!w.isVisible()) w.showInactive();
    raise(w, cfgOf().alwaysOnTop);
  } catch {
  }
  const send2 = () => {
    if (!w.isDestroyed()) w.webContents.send("puck:meetingToggle", { at: Date.now() });
  };
  if (w.webContents.isLoading()) w.webContents.once("did-finish-load", send2);
  else send2();
  return { ok: true };
}
function createWindow$1(cfg) {
  if (!deps || win) return;
  const first = target(cfg);
  const { window: bounds } = windowFor(first.centre, first.area, cfg.size);
  win = new electron.BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#00000000",
    ...platformWindowType(),
    webPreferences: { preload: deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  const w = win;
  lockZoom(w);
  installLoopback(w);
  try {
    w.setMenuBarVisibility(false);
  } catch {
  }
  w.webContents.on("did-finish-load", () => {
    if (w.isDestroyed()) return;
    pushConfig(cfgOf());
    setState({ shown: true });
    try {
      w.showInactive();
      raise(w, cfgOf().alwaysOnTop);
    } catch {
    }
  });
  w.on("closed", () => {
    if (win === w) {
      win = null;
      syncGaze(false);
      setState({ shown: false, menuOpen: false });
    }
  });
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  loadPage(w, "puck");
}
function destroyWindow() {
  syncGaze(false);
  closeOverlay();
  if (win && !win.isDestroyed()) {
    try {
      win.destroy();
    } catch {
    }
  }
  win = null;
  stopDrag();
  centre = null;
  setState({ shown: false, menuOpen: false, capturing: false });
}
function sync() {
  const cfg = cfgOf();
  const facts = { theme: themeOf(), ...who() };
  if (facts.theme !== state.theme || !sameWho(facts)) setState(facts);
  const want = admitted && cfg.enabled;
  if (want && !win) createWindow$1(cfg);
  if (!want && win) {
    destroyWindow();
    return;
  }
  if (!win || win.isDestroyed()) return;
  raise(win, cfg.alwaysOnTop);
  applyProtection(cfg);
  pushConfig(cfg);
  place(cfg);
  syncGaze(cfg.eyesFollow);
  setState({ canTranscribe: canTranscribe(), dictation: dictationOn(), theme: themeOf(), ...who() });
}
function applyProtection(cfg) {
  const on = manualInvisible || state.recording !== null && cfg.invisibleWhileRecording;
  for (const w of [win, overlay]) {
    if (w && !w.isDestroyed()) {
      try {
        w.setContentProtection(on);
      } catch {
      }
    }
  }
  if (state.invisible !== on) setState({ invisible: on });
}
function puckRoot() {
  const home = deps?.readConfig().harnessHome;
  return home ? path.join(home, PUCK_DIR) : null;
}
function ensureDir(p) {
  node_fs.mkdirSync(p, { recursive: true });
  return p;
}
function underPuck(p) {
  const root = puckRoot();
  if (!root || typeof p !== "string" || !p) return null;
  const abs = path.resolve(p);
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}
function readJson$1(p) {
  try {
    return JSON.parse(node_fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
async function ensureScreenAccess() {
  const access = screenAccess();
  if (access !== "denied" && access !== "restricted") return access;
  try {
    await electron.desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
  } catch {
  }
  return screenAccess();
}
async function openOverlay() {
  if (!deps || !win || win.isDestroyed()) return { ok: false, error: "puck not shown" };
  if (overlay) return { ok: true };
  const access = await ensureScreenAccess();
  setState({ screenAccess: access });
  if (access === "denied" || access === "restricted") return { ok: false, error: "screen-denied" };
  const cfg = cfgOf();
  const display = electron.screen.getDisplayNearestPoint(currentCentre(cfg));
  overlayDisplay = display;
  const b = display.bounds;
  overlay = new electron.BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    show: false,
    backgroundColor: "#00000000",
    ...platformWindowType(),
    webPreferences: { preload: deps.preload, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  const o = overlay;
  lockZoom(o);
  try {
    o.setMenuBarVisibility(false);
  } catch {
  }
  try {
    o.setAlwaysOnTop(true, "screen-saver", 2);
    o.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  } catch {
  }
  o.webContents.on("did-finish-load", () => {
    if (o.isDestroyed()) return;
    const region = initialRegion(cfg.captureRegion, { id: String(display.id), width: b.width, height: b.height });
    o.webContents.send("puck:captureInit", { region, width: b.width, height: b.height });
    try {
      o.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    } catch {
    }
    o.show();
    o.focus();
  });
  o.on("closed", () => {
    if (overlay === o) {
      overlay = null;
      overlayDisplay = null;
    }
    setState({ capturing: false });
  });
  loadPage(o, "capture");
  applyProtection(cfg);
  setState({ capturing: true, menuOpen: false });
  raise(win, cfg.alwaysOnTop);
  return { ok: true };
}
function requestCapture() {
  if (!overlay || overlay.isDestroyed()) return { ok: false, error: "no capture in progress" };
  try {
    overlay.webContents.send("puck:captureRequest");
  } catch {
    return { ok: false, error: "no capture in progress" };
  }
  return { ok: true };
}
function closeOverlay() {
  if (overlay && !overlay.isDestroyed()) {
    try {
      overlay.destroy();
    } catch {
    }
  }
  overlay = null;
  overlayDisplay = null;
  if (state.capturing) setState({ capturing: false });
  if (win && !win.isDestroyed()) raise(win, cfgOf().alwaysOnTop);
}
const CAPTURE_RETRIES = 3;
const CAPTURE_RETRY_MS = 300;
async function capture(rectIn) {
  if (!deps) return { ok: false, error: "not registered" };
  const display = overlayDisplay;
  const root = puckRoot();
  if (!display) return { ok: false, error: "no capture in progress" };
  if (!root) return { ok: false, error: "no harness home" };
  const r = rectIn ?? {};
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) return { ok: false, error: "bad region" };
  const rect = clampRegion(r, display.bounds.width, display.bounds.height);
  const cfg = cfgOf();
  deps.writeConfig({ puck: { ...cfg, captureRegion: { ...rect, displayId: String(display.id) } } });
  try {
    overlay?.hide();
  } catch {
  }
  hiddenForCapture = true;
  try {
    win?.hide();
  } catch {
  }
  await sleep(240);
  try {
    const scale = display.scaleFactor || 1;
    const grab = async () => {
      const sources = await electron.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: Math.round(display.bounds.width * scale), height: Math.round(display.bounds.height * scale) }
      });
      return sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
    };
    let src = await grab();
    for (let i = 0; i < CAPTURE_RETRIES && src && src.thumbnail.isEmpty(); i++) {
      await sleep(CAPTURE_RETRY_MS);
      src = await grab();
      console.warn(`[puck] capture: empty picture, asked again (${i + 1})${src && !src.thumbnail.isEmpty() ? ", got it" : ""}`);
    }
    if (!src) return { ok: false, error: "no screen source" };
    const full = src.thumbnail;
    const size = full.getSize();
    if (size.width === 0 || size.height === 0) return { ok: false, error: screenAccess() === "granted" ? "screen-empty" : "screen-denied" };
    const sx = size.width / display.bounds.width;
    const sy = size.height / display.bounds.height;
    const crop = full.crop({
      x: Math.round(rect.x * sx),
      y: Math.round(rect.y * sy),
      width: Math.max(1, Math.round(rect.width * sx)),
      height: Math.max(1, Math.round(rect.height * sy))
    });
    const dir = ensureDir(path.join(root, PUCK_SCREENSHOTS_DIR));
    const stamp2 = meetingIdFor(/* @__PURE__ */ new Date());
    const path$1 = path.join(dir, `${stamp2}.png`);
    node_fs.writeFileSync(path$1, crop.toPNG());
    const side = {
      takenAt: (/* @__PURE__ */ new Date()).toISOString(),
      region: rect,
      displayId: String(display.id),
      width: crop.getSize().width,
      height: crop.getSize().height,
      note: null,
      sentAt: null
    };
    node_fs.writeFileSync(path.join(dir, `${stamp2}.json`), JSON.stringify(side, null, 2));
    const preview = crop.resize({ width: Math.min(360, crop.getSize().width) }).toDataURL();
    const result = { ok: true, path: path$1, preview, width: side.width, height: side.height };
    try {
      if (win && !win.isDestroyed()) win.webContents.send("puck:captured", result);
    } catch {
    }
    return result;
  } catch (e) {
    return { ok: false, error: errMsg$1(e) };
  } finally {
    closeOverlay();
    hiddenForCapture = false;
    try {
      if (win && !win.isDestroyed()) win.showInactive();
    } catch {
    }
    setState({ screenAccess: screenAccess() });
  }
}
function sweepScreenshots(now = Date.now()) {
  const root = puckRoot();
  const out = { removed: 0, tombstoned: 0 };
  if (!root) return out;
  const dir = path.join(root, PUCK_SCREENSHOTS_DIR);
  if (!node_fs.existsSync(dir)) return out;
  for (const f of node_fs.readdirSync(dir)) {
    if (!f.endsWith(".png")) continue;
    const png = path.join(dir, f);
    const sidePath = path.join(dir, f.replace(/\.png$/, ".json"));
    const side = readJson$1(sidePath);
    let takenAt = side?.takenAt ? Date.parse(side.takenAt) : NaN;
    if (!Number.isFinite(takenAt)) {
      try {
        takenAt = node_fs.statSync(png).mtimeMs;
      } catch {
        continue;
      }
    }
    if (now - takenAt < PUCK_SHOT_TTL_MS) continue;
    try {
      node_fs.rmSync(png, { force: true });
    } catch {
      continue;
    }
    out.removed += 1;
    if (side?.sentAt) {
      try {
        node_fs.writeFileSync(sidePath, JSON.stringify({ ...side, deletedAt: new Date(now).toISOString() }, null, 2));
        out.tombstoned += 1;
      } catch {
      }
    } else {
      try {
        node_fs.rmSync(sidePath, { force: true });
      } catch {
      }
    }
  }
  return out;
}
function sweepMeetingAudio(now = Date.now()) {
  const root = puckRoot();
  const out = { removed: 0 };
  if (!root) return out;
  const base = path.join(root, PUCK_MEETINGS_DIR);
  if (!node_fs.existsSync(base)) return out;
  for (const id of node_fs.readdirSync(base)) {
    const dir = meetingDir(id);
    const meta = dir ? readMeta(id) : null;
    if (!dir || !meta) continue;
    let changed = false;
    for (const seg of meta.segments) {
      for (const part of [seg, seg.them].filter((x) => !!x)) {
        if (!part.transcribed || part.audioDeletedAt) continue;
        const file = path.join(dir, part.file);
        if (!node_fs.existsSync(file)) continue;
        let at = part.transcribedAt ? Date.parse(part.transcribedAt) : NaN;
        if (!Number.isFinite(at)) {
          try {
            at = node_fs.statSync(file).mtimeMs;
          } catch {
            continue;
          }
        }
        if (now - at < PUCK_AUDIO_TTL_MS) continue;
        try {
          node_fs.rmSync(file, { force: true });
        } catch {
          continue;
        }
        part.audioDeletedAt = new Date(now).toISOString();
        changed = true;
        out.removed += 1;
      }
    }
    if (changed) {
      writeMeta(meta);
      deps?.broadcast("puck:meetingsChanged", { id });
    }
  }
  return out;
}
function sweepPuck(now = Date.now()) {
  sweepScreenshots(now);
  sweepMeetingAudio(now);
}
function listScreenshots() {
  const root = puckRoot();
  if (!root) return [];
  const dir = path.join(root, PUCK_SCREENSHOTS_DIR);
  if (!node_fs.existsSync(dir)) return [];
  const out = [];
  const names = /* @__PURE__ */ new Set();
  for (const f of node_fs.readdirSync(dir)) {
    if (f.endsWith(".png")) names.add(f.slice(0, -4));
    else if (f.endsWith(".json")) names.add(f.slice(0, -5));
  }
  for (const stamp2 of [...names].sort().reverse().slice(0, 60)) {
    const path$1 = path.join(dir, `${stamp2}.png`);
    const side = readJson$1(path.join(dir, `${stamp2}.json`));
    const alive2 = node_fs.existsSync(path$1);
    if (!alive2 && !side) continue;
    let thumb = "";
    if (alive2) {
      try {
        thumb = electron.nativeImage.createFromPath(path$1).resize({ width: 240 }).toDataURL();
      } catch {
        thumb = "";
      }
    }
    out.push({
      path: path$1,
      takenAt: side?.takenAt ?? (alive2 ? new Date(node_fs.statSync(path$1).mtimeMs).toISOString() : (/* @__PURE__ */ new Date(0)).toISOString()),
      note: side?.note ?? null,
      sentAt: side?.sentAt ?? null,
      width: side?.width ?? 0,
      height: side?.height ?? 0,
      thumb,
      deletedAt: alive2 ? null : side?.deletedAt ?? null
    });
  }
  return out;
}
function captureTarget() {
  const ids = deps?.agentIds() ?? [];
  return resolveResponder(cfgOf().sendTo, ids, "god");
}
function recipientName(id) {
  try {
    const to = id ?? captureTarget();
    return deps?.agentName(to) || to;
  } catch {
    return id ?? "";
  }
}
function who() {
  try {
    const id = captureTarget();
    return { recipient: recipientName(id), recipientId: id, recipients: puckRecipients(deps?.agentIds() ?? [], (x) => recipientName(x)) };
  } catch {
    return { recipient: state.recipient, recipientId: state.recipientId, recipients: state.recipients };
  }
}
const sameWho = (a) => a.recipient === state.recipient && a.recipientId === state.recipientId && JSON.stringify(a.recipients) === JSON.stringify(state.recipients);
function sendCapture(arg) {
  if (!deps) return { ok: false, error: "not registered" };
  if (!deps.hiveEnabled()) return { ok: false, error: "hive disabled (no harnessHome)" };
  const a = arg ?? {};
  const note = typeof a.note === "string" ? a.note.trim() : "";
  const asked = [...Array.isArray(a.screenshots) ? a.screenshots : [], a.screenshot];
  const shots = [...new Set(asked.map(underPuck).filter((x) => !!x))].slice(0, PUCK_MAX_SHOTS);
  const transcript = underPuck(a.transcript);
  if (!note && shots.length === 0 && !transcript) return { ok: false, error: "nothing to send" };
  const lines = [];
  if (note) lines.push(note);
  if (shots.length > 0) {
    const taken = shots.map((s) => readJson$1(s.replace(/\.png$/, ".json"))?.takenAt).map((x) => x ? Date.parse(x) : Date.now());
    const goesAt = new Date(Math.min(...taken) + PUCK_SHOT_TTL_MS);
    if (shots.length === 1) {
      lines.push(
        "",
        `Screenshot: ${shots[0]}`,
        "Read the image at that path; it is a region of my screen I captured with the puck.",
        `The image is deleted automatically 24 hours after it was taken (about ${goesAt.toISOString()}). Read it now, or ask me for it again.`
      );
    } else {
      lines.push(
        "",
        ...shots.map((s, i) => `Screenshot ${i + 1} of ${shots.length}: ${s}`),
        `Read the images at those paths, in that order; each is a region of my screen I captured with the puck.`,
        `The images are deleted automatically 24 hours after they were taken (the first about ${goesAt.toISOString()}). Read them now, or ask me for them again.`
      );
    }
  }
  if (transcript) lines.push("", `Meeting transcript: ${transcript}`, "Read the transcript at that path; it was recorded with the puck.");
  const first = (note.split("\n")[0] || (shots.length > 1 ? `${shots.length} screenshots from the puck` : shots.length === 1 ? "Screenshot from the puck" : "Meeting transcript from the puck")).slice(0, 120);
  try {
    const to = captureTarget();
    const msg = deps.hiveSend({ to, act: "request", subject: first, body: lines.join("\n") }, "human");
    for (const shot of shots) {
      const side = shot.replace(/\.png$/, ".json");
      const cur = readJson$1(side);
      if (cur) node_fs.writeFileSync(side, JSON.stringify({ ...cur, note: note || null, sentAt: (/* @__PURE__ */ new Date()).toISOString() }, null, 2));
    }
    return { ok: true, id: msg.id, to: recipientName(to) };
  } catch (e) {
    return { ok: false, error: errMsg$1(e) };
  }
}
function meetingDir(id) {
  const root = puckRoot();
  if (!root || !/^[0-9_\-]+$/.test(id)) return null;
  return path.join(root, PUCK_MEETINGS_DIR, id);
}
function readMeta(id) {
  const dir = meetingDir(id);
  return dir ? readJson$1(path.join(dir, "meta.json")) : null;
}
function writeMeta(meta) {
  const dir = meetingDir(meta.id);
  if (dir) node_fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}
function refreshRecordingState(meta) {
  if (state.recording?.kind === "meeting" && state.recording.meetingId === meta.id) {
    setState({ recording: { ...state.recording, segments: meta.segments.length, transcribed: meta.segments.filter(segmentTranscribed).length, tracks: meta.twoTrack ? 2 : 1 } });
  }
}
function trackFile(seq, ext, track) {
  return `seg-${String(seq + 1).padStart(3, "0")}${track === "them" ? "-them" : ""}.${ext}`;
}
function mimeOfFile(file) {
  return file.endsWith(".wav") ? "audio/wav" : file.endsWith(".ogg") ? "audio/ogg" : "audio/webm";
}
function attachThem(dir, seg, bytes, ext) {
  const file = trackFile(seg.seq, ext, "them");
  node_fs.writeFileSync(path.join(dir, file), bytes);
  seg.them = { file, transcribed: false, error: null, transcribedAt: null, audioDeletedAt: null };
}
function rebuildTranscript(dir, meta) {
  const head = `# ${meta.title}

Started ${meta.startedAt}

`;
  const blocks = [];
  for (const seg of [...meta.segments].sort((a, b) => a.seq - b.seq)) {
    if (!seg.transcribed || !seg.lines) continue;
    if (seg.them && !seg.them.transcribed && !seg.them.error) continue;
    const them = seg.them?.lines ?? [];
    const you = them.length > 0 ? removeEcho(seg.lines, them).lines : seg.lines;
    blocks.push(transcriptBlock(you, them, seg.startMs, { label: true }));
  }
  node_fs.writeFileSync(path.join(dir, transcriptFileFor(meta)), head + blocks.join(""));
}
function transcriptFileFor(meta) {
  return meta.editedAt ? "transcript.auto.md" : "transcript.md";
}
function meetingStart() {
  if (!deps) return { ok: false, error: "not registered" };
  const root = puckRoot();
  if (!root) return { ok: false, error: "no harness home" };
  if (state.recording) return { ok: false, error: "already recording" };
  if (!canTranscribe()) return { ok: false, error: "no transcription engine" };
  const cfg = cfgOf();
  const now = /* @__PURE__ */ new Date();
  const id = meetingIdFor(now);
  const dir = ensureDir(path.join(root, PUCK_MEETINGS_DIR, id));
  const wantsThem = withTranscribeDefaults(deps.readConfig().transcribe).meetingSystemAudio;
  const systemAudio = wantsThem ? deps.systemAudioSource ? deps.systemAudioSource() : systemSource : null;
  const meta = { id, title: `Meeting ${now.toLocaleString()}`, startedAt: now.toISOString(), endedAt: null, status: "recording", segments: [], ...systemAudio ? { twoTrack: true } : {} };
  node_fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  node_fs.writeFileSync(path.join(dir, "transcript.md"), `# ${meta.title}

Started ${now.toISOString()}

`);
  if (systemAudio === "helper") {
    meetingSystemAudio.begin(now.getTime());
    void deps.startSystemAudio?.(now.getTime()).catch((e) => {
      console.log(`[puck] system audio did not start: ${errMsg$1(e)}`);
    });
  }
  micLive = true;
  setState({ recording: { kind: "meeting", meetingId: id, startedAt: now.getTime(), segments: 0, transcribed: 0, tracks: systemAudio ? 2 : 1 }, menuOpen: false });
  applyProtection(cfg);
  return { ok: true, meetingId: id, segmentMinutes: cfg.segmentMinutes, systemAudio };
}
async function meetingSegment(arg) {
  const a = arg ?? {};
  const id = typeof a.meetingId === "string" ? a.meetingId : "";
  const dir = meetingDir(id);
  const meta = readMeta(id);
  if (!dir || !meta) return { ok: false, error: "unknown meeting" };
  if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) return { ok: false, error: "no audio" };
  const bytes = a.audio instanceof Uint8Array ? a.audio : new Uint8Array(a.audio);
  if (bytes.byteLength === 0) return { ok: false, error: "empty audio" };
  const seq = typeof a.seq === "number" && Number.isInteger(a.seq) && a.seq >= 0 ? a.seq : meta.segments.length;
  const mime = typeof a.mimeType === "string" ? a.mimeType : "audio/webm";
  const ext = mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "webm";
  const track = a.track === "them" ? "them" : "you";
  if (track === "them") {
    if (!meta.twoTrack) return { ok: false, error: "not a two track meeting" };
    const seg2 = meta.segments.find((s) => s.seq === seq);
    if (!seg2) {
      let m = pendingThem.get(id);
      if (!m) {
        m = /* @__PURE__ */ new Map();
        pendingThem.set(id, m);
      }
      m.set(seq, { bytes, ext });
      return { ok: true };
    }
    attachThem(dir, seg2, bytes, ext);
    writeMeta(meta);
    refreshRecordingState(meta);
    queueTranscribe(id, seq, mime, "them");
    return { ok: true };
  }
  const file = trackFile(seq, ext, "you");
  node_fs.writeFileSync(path.join(dir, file), bytes);
  const seg = {
    seq,
    file,
    startMs: typeof a.startMs === "number" ? a.startMs : 0,
    durationMs: typeof a.durationMs === "number" ? a.durationMs : 0,
    transcribed: false,
    error: null,
    transcribedAt: null,
    audioDeletedAt: null
  };
  if (meta.twoTrack) {
    const startedAt = Date.parse(meta.startedAt);
    const waiting = pendingThem.get(id)?.get(seq);
    if (waiting) {
      pendingThem.get(id)?.delete(seq);
      attachThem(dir, seg, waiting.bytes, waiting.ext);
    } else if (meetingSystemAudio.active() && Number.isFinite(startedAt) && seg.durationMs > 0) {
      const from = startedAt + seg.startMs;
      const pcm = meetingSystemAudio.cut(from, from + seg.durationMs);
      attachThem(dir, seg, new Uint8Array(encodeWav(pcm, RING_RATE)), "wav");
      meetingSystemAudio.trim(from + seg.durationMs);
    }
  }
  meta.segments = meta.segments.filter((s) => s.seq !== seq).concat(seg).sort((x, y) => x.seq - y.seq);
  writeMeta(meta);
  refreshRecordingState(meta);
  queueTranscribe(id, seq, mime, "you");
  if (seg.them) queueTranscribe(id, seq, mimeOfFile(seg.them.file), "them");
  return { ok: true };
}
function queueTranscribe(id, seq, mime, track = "you") {
  const prev = transcribeQueues.get(id) ?? Promise.resolve();
  const next = prev.then(() => transcribeOne(id, seq, mime, track)).catch(() => void 0);
  transcribeQueues.set(id, next);
}
async function transcribeOne(id, seq, mime, track = "you") {
  if (!deps) return;
  const dir = meetingDir(id);
  const meta = readMeta(id);
  if (!dir || !meta) return;
  const seg = meta.segments.find((s2) => s2.seq === seq);
  if (!seg) return;
  const part = track === "them" ? seg.them : seg;
  if (!part || part.transcribed) return;
  if (!canTranscribe()) return;
  const key = deps.readConfig().groqApiKey ?? "";
  const cfg = cfgOf();
  const audioPath = path.join(dir, part.file);
  if (!node_fs.existsSync(audioPath)) {
    const gone = readMeta(id) ?? meta;
    const g = gone.segments.find((x) => x.seq === seq);
    const gp = track === "them" ? g?.them : g;
    if (gp) {
      gp.error = "audio is no longer on disk";
      writeMeta(gone);
      deps.broadcast("puck:meetingsChanged", { id });
    }
    return;
  }
  const audio = node_fs.readFileSync(audioPath);
  const res = await deps.transcribe({ apiKey: key, audio, mimeType: mime, filename: part.file, language: cfg.language || void 0, mode: "meeting", timestamps: !!meta.twoTrack });
  const fresh = readMeta(id) ?? meta;
  const s = fresh.segments.find((x) => x.seq === seq);
  if (!s) return;
  const p = track === "them" ? s.them : s;
  if (!p) return;
  if (res.ok) {
    p.transcribed = true;
    p.error = null;
    p.transcribedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (fresh.twoTrack) {
      const lines = res.segments?.length ? res.segments : wholeClip(res.text ?? "", s.durationMs);
      p.lines = lines;
      rebuildTranscript(dir, fresh);
    } else if (res.text) {
      const file = path.join(dir, transcriptFileFor(fresh));
      if (!node_fs.existsSync(file)) node_fs.writeFileSync(file, `# ${fresh.title}

Started ${fresh.startedAt}

`);
      node_fs.appendFileSync(file, `[${clockOf(s.startMs)}] ${res.text.trim()}

`);
    }
  } else {
    p.error = res.error ?? "transcription failed";
    if (fresh.twoTrack && track === "them") rebuildTranscript(dir, fresh);
  }
  if (fresh.endedAt) fresh.status = settleMeetingStatus(fresh);
  writeMeta(fresh);
  refreshRecordingState(fresh);
  deps.broadcast("puck:meetingsChanged", { id });
}
function meetingStop(arg) {
  const a = arg ?? {};
  const id = typeof a.meetingId === "string" ? a.meetingId : "";
  const meta = readMeta(id);
  micLive = false;
  if (meetingSystemAudio.active()) void deps?.stopSystemAudio?.().catch(() => {
  });
  meetingSystemAudio.end();
  pendingThem.delete(id);
  const wasThis = state.recording?.kind === "meeting" && state.recording.meetingId === id;
  if (wasThis || state.recording?.kind === "meeting") setState({ recording: null });
  applyProtection(cfgOf());
  if (!meta) return { ok: false, error: "unknown meeting" };
  meta.endedAt = (/* @__PURE__ */ new Date()).toISOString();
  meta.status = meta.segments.every(segmentTranscribed) ? "done" : canTranscribe() ? "transcribing" : "pending";
  writeMeta(meta);
  void (transcribeQueues.get(id) ?? Promise.resolve()).then(() => {
    const m = readMeta(id);
    if (m) {
      m.status = settleMeetingStatus(m);
      writeMeta(m);
      deps?.broadcast("puck:meetingsChanged", { id });
    }
  });
  deps?.broadcast("puck:meetingsChanged", { id });
  return { ok: true };
}
function localDay(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA");
}
function transcriptHit(path2, needle) {
  if (!node_fs.existsSync(path2)) return null;
  for (const line of node_fs.readFileSync(path2, "utf8").split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    if (line.toLowerCase().includes(needle)) return line.replace(/^\[[^\]]+\]\s*/, "").trim().slice(0, 240);
  }
  return null;
}
function listMeetings(filter) {
  const root = puckRoot();
  if (!root) return [];
  const base = path.join(root, PUCK_MEETINGS_DIR);
  if (!node_fs.existsSync(base)) return [];
  const q = typeof filter?.q === "string" ? filter.q.trim().toLowerCase() : "";
  const from = typeof filter?.from === "string" && filter.from ? filter.from : null;
  const to = typeof filter?.to === "string" && filter.to ? filter.to : null;
  const out = [];
  for (const id of node_fs.readdirSync(base).sort().reverse()) {
    const meta = readMeta(id);
    if (!meta) continue;
    const day = localDay(meta.startedAt);
    if (from && day < from) continue;
    if (to && day > to) continue;
    const dir = path.join(base, id);
    const transcriptPath = path.join(dir, "transcript.md");
    let hit = null;
    if (q) {
      const inTitle = meta.title.toLowerCase().includes(q);
      hit = transcriptHit(transcriptPath, q);
      if (!inTitle && !hit) continue;
    }
    const durationMs = meta.segments.reduce((n, s) => Math.max(n, s.startMs + s.durationMs), 0);
    out.push({ ...meta, status: statusOf(meta), dir, transcriptPath, durationMs, hit });
  }
  return out;
}
function meetingRename(arg) {
  const a = arg ?? {};
  const id = typeof a.id === "string" ? a.id : "";
  const title = typeof a.title === "string" ? a.title.trim().slice(0, 120) : "";
  if (!title) return { ok: false, error: "a meeting needs a name" };
  const dir = meetingDir(id);
  const meta = readMeta(id);
  if (!dir || !meta) return { ok: false, error: "unknown meeting" };
  meta.title = title;
  writeMeta(meta);
  const tp = path.join(dir, "transcript.md");
  if (node_fs.existsSync(tp)) {
    const body2 = node_fs.readFileSync(tp, "utf8");
    node_fs.writeFileSync(tp, body2.replace(/^# .*$/m, `# ${title}`));
  }
  deps?.broadcast("puck:meetingsChanged", { id });
  return { ok: true };
}
function statusOf(meta) {
  return meta.endedAt ? meta.status === "transcribing" ? "transcribing" : settleMeetingStatus(meta) : "recording";
}
function meetingSave(arg) {
  const a = arg ?? {};
  const id = typeof a.id === "string" ? a.id : "";
  const dir = meetingDir(id);
  const meta = readMeta(id);
  if (!dir || !meta) return { ok: false, error: "unknown meeting" };
  if (typeof a.title === "string") {
    const r = meetingRename({ id, title: a.title });
    if (!r.ok) return r;
    Object.assign(meta, readMeta(id) ?? {});
  }
  if (typeof a.text === "string") {
    if (!meetingEditable(statusOf(meta))) return { ok: false, error: "the transcript is still being written" };
    if (a.text.length > PUCK_MEETING_TEXT_MAX) return { ok: false, error: "the transcript is too long" };
    node_fs.writeFileSync(path.join(dir, "transcript.md"), a.text);
    meta.editedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  if (typeof a.description === "string") meta.description = a.description.trim().slice(0, PUCK_MEETING_DESCRIPTION_MAX);
  writeMeta(meta);
  deps?.broadcast("puck:meetingsChanged", { id });
  return { ok: true };
}
function meetingSendTo(arg) {
  if (!deps) return { ok: false, sent: [], failed: [], error: "not registered" };
  if (!deps.hiveEnabled()) return { ok: false, sent: [], failed: [], error: "hive disabled (no harnessHome)" };
  const a = arg ?? {};
  const id = typeof a.id === "string" ? a.id : "";
  const dir = meetingDir(id);
  const meta = readMeta(id);
  if (!dir || !meta) return { ok: false, sent: [], failed: [], error: "unknown meeting" };
  if (statusOf(meta) === "recording") return { ok: false, sent: [], failed: [], error: "still recording" };
  const reachable = /* @__PURE__ */ new Set(["god", ...deps.agentIds()]);
  const asked = [...new Set((Array.isArray(a.to) ? a.to : []).filter((x) => typeof x === "string"))].slice(0, PUCK_MEETING_SEND_MAX);
  if (asked.length === 0) return { ok: false, sent: [], failed: [], error: "pick at least one agent" };
  const transcriptPath = path.join(dir, "transcript.md");
  let text = "";
  try {
    text = node_fs.readFileSync(transcriptPath, "utf8");
  } catch {
    text = "";
  }
  const msg = meetingMessage({ id, title: meta.title, startedAt: meta.startedAt, description: meta.description, text, transcriptPath });
  const sent = [];
  const failed = [];
  for (const to of asked) {
    if (!reachable.has(to)) {
      failed.push({ id: to, error: "not running" });
      continue;
    }
    try {
      deps.hiveSend({ to, act: "request", subject: msg.subject, body: msg.body }, "human");
      sent.push(recipientName(to));
    } catch (e) {
      failed.push({ id: to, error: errMsg$1(e) });
    }
  }
  return { ok: failed.length === 0, sent, failed, inline: msg.inline };
}
function meetingTranscript(arg) {
  const a = arg ?? {};
  const id = typeof a.id === "string" ? a.id : "";
  const dir = meetingDir(id);
  const meta = readMeta(id);
  if (!dir || !meta) return { ok: false, error: "unknown meeting" };
  let text = "";
  try {
    text = node_fs.readFileSync(path.join(dir, "transcript.md"), "utf8");
  } catch {
    text = "";
  }
  return { ok: true, text, meta };
}
function meetingTranscribePending(arg) {
  const a = arg ?? {};
  const id = typeof a.id === "string" ? a.id : "";
  const meta = readMeta(id);
  if (!meta) return { ok: false, queued: 0, error: "unknown meeting" };
  if (!canTranscribe()) return { ok: false, queued: 0, error: "no transcription engine" };
  let queued = 0;
  for (const s of meta.segments) {
    if (!s.transcribed) {
      s.error = null;
      queueTranscribe(id, s.seq, mimeOfFile(s.file), "you");
      queued++;
    }
    if (s.them && !s.them.transcribed) {
      s.them.error = null;
      queueTranscribe(id, s.seq, mimeOfFile(s.them.file), "them");
      queued++;
    }
  }
  meta.status = queued > 0 ? "transcribing" : settleMeetingStatus(meta);
  writeMeta(meta);
  void (transcribeQueues.get(id) ?? Promise.resolve()).then(() => {
    const m = readMeta(id);
    if (m) {
      m.status = settleMeetingStatus(m);
      writeMeta(m);
      deps?.broadcast("puck:meetingsChanged", { id });
    }
  });
  return { ok: true, queued };
}
let messageWatch = null;
function messageStart() {
  if (state.recording) return { ok: false, error: "already recording" };
  if (!dictationOn()) return { ok: false, error: "dictation off" };
  if (!canTranscribe()) return { ok: false, error: "no transcription engine" };
  micLive = true;
  const startedAt = Date.now();
  setState({ recording: { kind: "message", startedAt }, menuOpen: false });
  applyProtection(cfgOf());
  if (messageWatch) clearTimeout(messageWatch);
  messageWatch = setTimeout(() => {
    messageWatch = null;
    if (state.recording?.kind === "message" && state.recording.startedAt === startedAt && messageOverdue(startedAt, Date.now(), PUCK_MESSAGE_MAX_SECONDS)) {
      micLive = false;
      setState({ recording: null });
      applyProtection(cfgOf());
    }
  }, PUCK_MESSAGE_MAX_SECONDS * 1e3 + TAKE_WATCHDOG_MS);
  return { ok: true };
}
async function transcribeClip(arg) {
  if (!deps) return { ok: false, error: "not registered" };
  const a = arg ?? {};
  if (!(a.audio instanceof ArrayBuffer) && !(a.audio instanceof Uint8Array)) return { ok: false, error: "no audio" };
  if (a.audio.byteLength === 0) return { ok: false, error: "no audio" };
  if (!canTranscribe()) return { ok: false, error: "no transcription engine" };
  const key = deps.readConfig().groqApiKey ?? "";
  const mime = typeof a.mimeType === "string" ? a.mimeType : "audio/webm";
  const res = await deps.transcribe({
    apiKey: key,
    audio: a.audio,
    mimeType: mime,
    filename: `message.${mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "webm"}`,
    language: cfgOf().language || void 0,
    mode: "dictation"
  });
  if (!res.ok || !res.text) return { ok: false, error: res.error ?? "transcription failed" };
  return { ok: true, text: res.text };
}
function messageSegment(arg) {
  if (state.recording?.kind !== "message") return Promise.resolve({ ok: false, error: "not recording a message" });
  return transcribeClip(arg);
}
async function messageStop(arg) {
  if (messageWatch) {
    clearTimeout(messageWatch);
    messageWatch = null;
  }
  micLive = false;
  if (state.recording?.kind === "message") setState({ recording: null });
  applyProtection(cfgOf());
  return transcribeClip(arg);
}
function resolveResponder(configured, activeIds, godId) {
  if (typeof configured !== "string") return godId;
  const id = configured.trim();
  if (!id || !activeIds.includes(id)) return godId;
  return id;
}
function messageOverdue(startedAt, now, maxSeconds, limit = TAKE_WATCHDOG_MS) {
  return now - startedAt >= maxSeconds * 1e3 + limit;
}

// ─── transcript assembly (verbatim from index.js ~19430-19560) ───────────────
const clean$1 = (s) => s.replace(/\s+/g, " ").trim();
function timed(lines, speaker, offsetMs) {
  const out = [];
  for (const l of lines) {
    const text = clean$1(l.text ?? "");
    if (!text) continue;
    const t0 = Number.isFinite(l.t0) ? Math.max(0, l.t0) : 0;
    const t1 = Number.isFinite(l.t1) ? Math.max(t0, l.t1) : t0;
    out.push({ speaker, startMs: Math.round(offsetMs + t0 * 1e3), endMs: Math.round(offsetMs + t1 * 1e3), text });
  }
  return out;
}
function mergeTracks(you, them, offsetMs = 0) {
  const all = [...timed(you, "you", offsetMs), ...timed(them, "them", offsetMs)];
  all.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || (a.speaker === "you" ? -1 : 1) - (b.speaker === "you" ? -1 : 1));
  const runs = [];
  for (const line of all) {
    const last = runs[runs.length - 1];
    if (last && last.speaker === line.speaker) {
      last.text = `${last.text} ${line.text}`;
      last.endMs = Math.max(last.endMs, line.endMs);
    } else {
      runs.push({ ...line });
    }
  }
  return runs;
}
function clockStamp(ms2) {
  const s = Math.max(0, Math.floor(ms2 / 1e3));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `[${two(h)}:${two(m)}:${two(sec)}]` : `[${two(m)}:${two(sec)}]`;
}
const TRANSCRIPT_WORDS = { you: "You", them: "Them" };
function transcriptBlock(you, them, offsetMs = 0, opts = {}) {
  const words = opts.words ?? TRANSCRIPT_WORDS;
  if (them === null && !opts.label) {
    const lines = timed(you, "you", offsetMs).sort((a, b) => a.startMs - b.startMs);
    return lines.map((l) => `${clockStamp(l.startMs)} ${l.text}

`).join("");
  }
  const runs = mergeTracks(you, them ?? [], offsetMs);
  return runs.map((r) => `${clockStamp(r.startMs)} ${words[r.speaker]}: ${r.text}

`).join("");
}
function wholeClip(text, durationMs) {
  const t = clean$1(text);
  return t ? [{ t0: 0, t1: Math.max(0, durationMs) / 1e3, text: t }] : [];
}
const ECHO_DEFAULTS = { windowS: 2, minRun: 4 };
function normWord(w) {
  return w.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}']/gu, "").replace(/^'+|'+$/g, "");
}
function stream(lines) {
  const raw = [];
  const words = [];
  lines.forEach((l, line) => {
    const toks = (l.text ?? "").split(/\s+/).filter(Boolean);
    raw.push(toks);
    const t0 = Number.isFinite(l.t0) ? l.t0 : 0;
    const t1 = Number.isFinite(l.t1) ? Math.max(t0, l.t1) : t0;
    toks.forEach((w, idx) => {
      const norm2 = normWord(w);
      if (norm2) words.push({ line, idx, norm: norm2, t: t0 + (t1 - t0) * (idx + 0.5) / toks.length });
    });
  });
  words.sort((a, b) => a.t - b.t || a.line - b.line || a.idx - b.idx);
  return { words, raw };
}
function removeEcho(you, them, opts = {}) {
  const o = { ...ECHO_DEFAULTS, ...opts };
  const y = stream(you);
  const th = stream(them).words;
  const used = new Array(th.length).fill(false);
  const cut2 = /* @__PURE__ */ new Set();
  const Y = y.words;
  let i = 0;
  while (i < Y.length) {
    let best = 0;
    let at = -1;
    for (let j = 0; j < th.length; j++) {
      if (used[j] || th[j].norm !== Y[i].norm || Math.abs(th[j].t - Y[i].t) > o.windowS) continue;
      let k = 0;
      while (i + k < Y.length && j + k < th.length && !used[j + k] && Y[i + k].norm === th[j + k].norm) k++;
      if (k > best) {
        best = k;
        at = j;
      }
    }
    if (best >= o.minRun) {
      for (let k = 0; k < best; k++) {
        used[at + k] = true;
        cut2.add(`${Y[i + k].line}:${Y[i + k].idx}`);
      }
      i += best;
    } else i++;
  }
  const lines = [];
  let dropped = 0;
  let trimmed = 0;
  you.forEach((l, n) => {
    const toks = y.raw[n];
    const keep = toks.filter((_, idx) => !cut2.has(`${n}:${idx}`));
    if (keep.length === toks.length) {
      lines.push(l);
      return;
    }
    if (!keep.some((w) => normWord(w))) {
      dropped++;
      return;
    }
    trimmed++;
    lines.push({ ...l, text: keep.join(" ") });
  });
  return { lines, dropped, trimmed, words: cut2.size };
}

function registerPuck(d) {
  deps = d;
  d.onConfigWritten(() => sync());
  void electron.app.whenReady().then(() => {
    electron.screen.on("display-added", displaysChanged);
    electron.screen.on("display-removed", displaysChanged);
    electron.screen.on("display-metrics-changed", displaysChanged);
  });
  electron.app.on("before-quit", () => {
    destroyWindow();
  });
  void electron.app.whenReady().then(() => {
    sweepPuck();
    setInterval(() => {
      sweepPuck();
    }, PUCK_SWEEP_EVERY_MS).unref?.();
  });
  electron.ipcMain.handle("puck:admit", (_e, on) => {
    admitted = on === true;
    sync();
    return state;
  });
  electron.ipcMain.handle("puck:state", () => {
    const w = who();
    if (!sameWho(w)) setState(w);
    return state;
  });
  electron.ipcMain.handle("puck:config", () => cfgOf());
  electron.ipcMain.handle("puck:dragStart", (_e, at) => {
    const cfg = cfgOf();
    stopDrag();
    const from = currentCentre(cfg);
    const a = at ?? {};
    const near = (v) => typeof v === "number" && Number.isFinite(v) ? Math.max(-cfg.size, Math.min(cfg.size, v)) : 0;
    const grab = { x: near(a.x), y: near(a.y) };
    const read2 = readPointer();
    const first = read2 && Math.hypot(read2.x - grab.x - from.x, read2.y - grab.y - from.y) <= POINTER_TRUST_PX ? read2 : null;
    drag = { grab, mode: first ? "cursor" : "deltas", first, last: null, from, moved: { x: 0, y: 0 }, travel: 0, unheard: null, timer: null };
    dragging = true;
    if (drag.mode === "cursor") {
      drag.timer = setInterval(dragTick, DRAG_TICK_MS);
      drag.timer.unref?.();
      dragTick();
    }
    return state;
  });
  electron.ipcMain.handle("puck:drag", (_e, delta) => {
    const g = drag;
    if (!g) return state;
    const dl = delta ?? {};
    const dx = typeof dl.dx === "number" && Number.isFinite(dl.dx) ? dl.dx : 0;
    const dy = typeof dl.dy === "number" && Number.isFinite(dl.dy) ? dl.dy : 0;
    g.unheard = null;
    g.moved = { x: g.moved.x + dx, y: g.moved.y + dy };
    g.travel += Math.abs(dx) + Math.abs(dy);
    if (g.mode === "cursor") {
      const p = readPointer();
      const still = !p || g.first !== null && p.x === g.first.x && p.y === g.first.y;
      if (!still || g.travel < DELTA_FALLBACK_PX) {
        dragTick();
        return state;
      }
      if (g.timer) {
        clearInterval(g.timer);
        g.timer = null;
      }
      g.mode = "deltas";
    }
    centre = { x: g.from.x + g.moved.x, y: g.from.y + g.moved.y };
    place(cfgOf());
    return state;
  });
  electron.ipcMain.handle("puck:dragEnd", () => {
    endDrag();
    return state;
  });
  electron.ipcMain.handle("puck:resetPosition", () => {
    stopDrag();
    const cfg = cfgOf();
    const main = electron.screen.getPrimaryDisplay();
    const mid = centreOf(main.workArea);
    centre = null;
    d.writeConfig({ puck: { ...cfg, position: mid, home: { displayId: main.id, dx: mid.x - main.bounds.x, dy: mid.y - main.bounds.y } } });
    place(cfgOf());
    return state;
  });
  electron.ipcMain.handle("puck:menu", (_e, open2) => {
    setState({ menuOpen: open2 === true, ...who() });
    if (open2 === true && win && !win.isDestroyed()) {
      try {
        win.focus();
      } catch {
      }
    }
    return state;
  });
  electron.ipcMain.handle("puck:ignoreMouse", (_e, ignore) => {
    if (win && !win.isDestroyed()) {
      try {
        win.setIgnoreMouseEvents(ignore === true, { forward: true });
      } catch {
      }
    }
    return true;
  });
  electron.ipcMain.handle("puck:invisible", (_e, on) => {
    manualInvisible = on === true;
    applyProtection(cfgOf());
    return state;
  });
  electron.ipcMain.handle("puck:captureStart", () => openOverlay());
  electron.ipcMain.handle("puck:captureConfirm", async (_e, rect) => {
    const r = await capture(rect);
    if (!r.ok) {
      try {
        if (win && !win.isDestroyed()) win.webContents.send("puck:captureFailed", { error: r.error });
      } catch {
      }
    }
    return r;
  });
  electron.ipcMain.handle("puck:captureCancel", () => {
    closeOverlay();
    return state;
  });
  electron.ipcMain.handle("puck:captureRequest", () => requestCapture());
  electron.ipcMain.handle("puck:openScreenAccess", () => {
    if (process.platform === "darwin") {
      void electron.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    }
    return true;
  });
  electron.ipcMain.handle("puck:openMicAccess", () => {
    if (process.platform === "darwin") {
      void electron.shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
    }
    return true;
  });
  electron.ipcMain.handle("puck:openSettings", (_e, section) => {
    d.openSettings(typeof section === "string" && section ? section : void 0);
    return true;
  });
  electron.ipcMain.handle("puck:send", (_e, arg) => sendCapture(arg));
  electron.ipcMain.handle("puck:sendTo", (_e, id) => {
    if (typeof id !== "string") return state;
    const offered = puckRecipients(deps?.agentIds() ?? [], (x) => recipientName(x)).some((r) => r.id === id);
    if (!offered) return state;
    const d2 = deps;
    if (!d2) return state;
    d2.writeConfig({ puck: { ...cfgOf(), sendTo: sendToFor(id) } });
    setState(who());
    return state;
  });
  electron.ipcMain.handle("puck:meetingStart", () => meetingStart());
  electron.ipcMain.handle("puck:meetingSegment", (_e, arg) => meetingSegment(arg));
  electron.ipcMain.handle("puck:meetingStop", (_e, arg) => meetingStop(arg));
  electron.ipcMain.handle("puck:meetings", (_e, filter) => {
    sweepPuck();
    return listMeetings(filter ?? {});
  });
  electron.ipcMain.handle("puck:meetingRename", (_e, arg) => meetingRename(arg));
  electron.ipcMain.handle("puck:meetingTranscript", (_e, arg) => meetingTranscript(arg));
  electron.ipcMain.handle("puck:meetingSave", (_e, arg) => meetingSave(arg));
  electron.ipcMain.handle("puck:meetingSendTo", (_e, arg) => meetingSendTo(arg));
  electron.ipcMain.handle("puck:meetingTranscribe", (_e, arg) => meetingTranscribePending(arg));
  electron.ipcMain.handle("puck:meetingDelete", async (_e, arg) => {
    const a = arg ?? {};
    const dir = meetingDir(typeof a.id === "string" ? a.id : "");
    if (!dir || !node_fs.existsSync(dir)) return { ok: false, error: "unknown meeting" };
    if (state.recording?.kind === "meeting" && state.recording.meetingId === a.id) return { ok: false, error: "still recording" };
    try {
      await electron.shell.trashItem(dir);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg$1(e) };
    }
  });
  electron.ipcMain.handle("puck:messageStart", () => messageStart());
  electron.ipcMain.handle("puck:messageSegment", (_e, arg) => messageSegment(arg));
  electron.ipcMain.handle("puck:messageStop", (_e, arg) => messageStop(arg));
  electron.ipcMain.handle("puck:screenshots", () => {
    sweepPuck();
    return listScreenshots();
  });
  electron.ipcMain.handle("puck:screenshotDelete", async (_e, p) => {
    const abs = underPuck(p);
    if (!abs || !abs.endsWith(".png")) return { ok: false, error: "not a puck screenshot" };
    const side = abs.replace(/\.png$/, ".json");
    if (!node_fs.existsSync(abs) && !node_fs.existsSync(side)) return { ok: false, error: "not a puck screenshot" };
    try {
      if (node_fs.existsSync(abs)) await electron.shell.trashItem(abs);
      if (node_fs.existsSync(side)) await electron.shell.trashItem(side);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: errMsg$1(e) };
    }
  });
  electron.ipcMain.handle("puck:reveal", (_e, p) => {
    const abs = underPuck(p);
    if (!abs || !node_fs.existsSync(abs)) return { ok: false, error: "not a puck file" };
    electron.shell.showItemInFolder(abs);
    return { ok: true, name: path.basename(abs) };
  });
}

module.exports = {
  registerPuck, puckMicLive, isPuckContents, captureByKey, toggleMeetingByKey,
  puckDictationEvent, puckTranscribeChanged, sync, destroyWindow,
  meetingSystemAudio, resolveResponder, messageOverdue,
  // internal surfaces kept testable
  _state: () => state, _setState: (s) => { state = { ...state, ...s }; },
  _setDeps: (d) => { deps = d; }, _setAdmitted: (a) => { admitted = a; },
  _setWin: (w) => { win = w; }, _setOverlay: (o) => { overlay = o; },
  _setOverlayDisplay: (d) => { overlayDisplay = d; },
  _setSystemSource: (s) => { systemSource = s; },
  _reset: () => {
    deps = null; win = null; overlay = null; overlayDisplay = null;
    admitted = false; centre = null; dragging = false; drag = null;
    hiddenForCapture = false; settleTimers = []; manualInvisible = false;
    micLive = false; state = { ...DEFAULT_PUCK_STATE }; ring = null;
    pendingThem.clear(); transcribeQueues.clear(); systemSource = null;
    if (messageWatch) { clearTimeout(messageWatch); messageWatch = null; }
    if (gazeTimer) { clearInterval(gazeTimer); gazeTimer = null; lastGaze = null; }
  },
  // internals for unit tests (not part of the reference's surface)
  __test: {
    sweepPuck, sweepScreenshots, sweepMeetingAudio, listScreenshots, listMeetings,
    meetingDir, readMeta, writeMeta, capture, openOverlay, requestCapture, closeOverlay,
    sendCapture, meetingStart, meetingSegment, meetingStop, meetingSave, meetingRename,
    meetingSendTo, meetingTranscript, meetingTranscribePending, transcribeClip,
    messageStart, messageSegment, messageStop, trackFile, mimeOfFile, attachThem,
    rebuildTranscript, transcriptFileFor, who, captureTarget, recipientName,
    transcriptBlock, wholeClip, removeEcho, mergeTracks, timed, clockStamp,
    localDay, transcriptHit, statusOf, underPuck, puckRoot, screenAccess,
    dictationOn, canTranscribe, cfgOf, themeOf, platformWindowType, raise,
    target, currentCentre, readPointer, displaysChanged, installLoopback,
    syncGaze, gazeTick, stopDrag, dragTick, endDrag, place, rehome,
    applyProtection, ensureScreenAccess, ensureDir, readJson: readJson$1,
  },
};
