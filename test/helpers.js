'use strict';
/** Shared test seams — electron stub wired through Module._load so puck-runtime
 *  and updater can be exercised without a real Electron. */
const Module = require('module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const _origLoad = Module._load;
let electronStub = null;
Module._load = function (request, parent, isMain) {
  if (request === 'electron' && electronStub) return electronStub;
  return _origLoad.apply(this, arguments);
};

function fakeElectron(overrides = {}) {
  const handlers = new Map();
  const stub = {
    app: {
      isPackaged: false,
      getVersion: () => '0.0.0-test',
      getPath: (name) => path.join(os.tmpdir(), `ozycomp-test-${name}`),
      getAppPath: () => os.tmpdir(),
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
      exit: () => {},
      ...overrides.app,
    },
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: () => {},
      _handlers: handlers,
    },
    screen: {
      on: () => {},
      getAllDisplays: () => [fakeDisplay()],
      getPrimaryDisplay: () => fakeDisplay(),
      getDisplayNearestPoint: () => fakeDisplay(),
      getDisplayMatching: () => fakeDisplay(),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      ...overrides.screen,
    },
    shell: {
      openExternal: async () => {},
      showItemInFolder: () => {},
      trashItem: async () => {},
      ...overrides.shell,
    },
    nativeImage: {
      createFromPath: () => ({ resize: () => ({ toDataURL: () => 'data:,' }), isEmpty: () => false }),
      createFromBuffer: () => ({ isEmpty: () => false }),
      ...overrides.nativeImage,
    },
    desktopCapturer: {
      getSources: async () => [{ display_id: '1', thumbnail: fakeImage() }],
      ...overrides.desktopCapturer,
    },
    systemPreferences: {
      getMediaAccessStatus: () => 'granted',
      ...overrides.systemPreferences,
    },
    BrowserWindow: overrides.BrowserWindow ?? FakeWindow,
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      ...overrides.dialog,
    },
  };
  return stub;
}
function fakeDisplay(over = {}) {
  return { id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, ...over };
}
function fakeImage(over = {}) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width: 1920, height: 1080 }),
    crop: (r) => fakeImage({ _size: r }),
    resize: () => fakeImage(),
    toPNG: () => Buffer.from('png'),
    toDataURL: () => 'data:,',
    ...over,
  };
}
class FakeWindow {
  static nextId = 1;
  constructor(opts = {}) {
    this.id = FakeWindow.nextId++;
    this.opts = opts;
    this.destroyed = false;
    this.visible = false;
    this.bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width ?? 80, height: opts.height ?? 80 };
    this._sent = [];
    this.webContents = {
      sent: this._sent,
      send: (ch, p) => this._sent.push([ch, p]),
      on: () => {},
      once: () => {},
      isLoading: () => false,
      isDestroyed: () => this.destroyed,
      setWindowOpenHandler: () => {},
      setZoomLevel: () => {},
      getZoomLevel: () => 0,
      setVisualZoomLevelLimits: async () => {},
      getContentBounds: () => this.bounds,
      session: { setDisplayMediaRequestHandler: () => {} },
    };
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isMinimized() { return false; }
  isMaximized() { return false; }
  restore() {}
  destroy() { this.destroyed = true; }
  show() { this.visible = true; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  focus() {}
  close() { this.destroyed = true; }
  setBounds(b) { this.bounds = { ...b }; }
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.bounds }; }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setContentProtection() {}
  setIgnoreMouseEvents() {}
  setMenuBarVisibility() {}
  on() {}
  once() {}
  loadURL() { return Promise.resolve(); }
  loadFile() { return Promise.resolve(); }
}

function puckDeps(home, over = {}) {
  const cfg = {
    harnessHome: home,
    terminalTheme: 'light',
    groqApiKey: '',
    puck: {},
    transcribe: {},
    ...over.config,
  };
  const broadcasts = [];
  return {
    cfg, broadcasts,
    readConfig: () => cfg,
    writeConfig: (patch) => { Object.assign(cfg, patch); },
    onConfigWritten: () => {},
    agentIds: () => over.agentIds ?? ['w1', 'w2'],
    agentName: (id) => over.agentNames?.[id] ?? id,
    hiveEnabled: () => over.hiveEnabled ?? true,
    hiveSend: (msg, from) => ({ id: 'msg-1' }),
    broadcast: (ch, p) => broadcasts.push([ch, p]),
    transcribe: over.transcribe ?? (async () => ({ ok: true, text: 'transcribed' })),
    systemAudioSource: over.systemAudioSource,
    startSystemAudio: over.startSystemAudio,
    stopSystemAudio: over.stopSystemAudio,
    openSettings: () => {},
    rendererDir: '/tmp',
    preload: '/tmp/preload.js',
    ...over.deps,
  };
}

function loadPuckRuntime(over = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'puck-rt-'));
  electronStub = fakeElectron(over.electron ?? {});
  // fresh module so module-level state is clean for each test
  delete require.cache[require.resolve('../src/main/puck-runtime.js')];
  const pr = require('../src/main/puck-runtime.js');
  const deps = puckDeps(home, over);
  pr._setDeps(deps);
  pr._setAdmitted(over.admitted ?? true);
  return { ...pr, __test: pr.__test, deps, home, electron: electronStub };
}
function resetPuckRuntime() {
  delete require.cache[require.resolve('../src/main/puck-runtime.js')];
  electronStub = null;
}
module.exports = { fakeElectron, fakeDisplay, fakeImage, FakeWindow, puckDeps, loadPuckRuntime, resetPuckRuntime, _setElectronStub: (s) => { electronStub = s; } };
