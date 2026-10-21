'use strict';
/**
 * IDE runtime — window lifecycle + IPC wiring, verbatim port of the reference
 * block (index.js ~31845-31920 + ~34210-34320). Holds the IdeWindows registry,
 * the dirty-buffers ledger, the lose-your-edits confirm (with the 10-second
 * re-ask suppression), and the IPC handlers that route between floor windows
 * and their detached IDE windows.
 *
 * Electron seams are injected at registration time so the module can be
 * exercised with a stub — the reference reads globals directly.
 */
const path = require('node:path');
const { IdeWindows, IdeDirtyLedger, ideQuitWarning } = require('./ide-windows');

let electron = null;
let deps = null;
let ideWindows = null;
let ideDirtyByWindow = null;
let ideLossAcceptedAt = 0;
let allowQuit = false;

function setAllowQuit(on) {
  allowQuit = on === true;
}
function getAllowQuit() {
  return allowQuit;
}
function dirtyLedger() {
  return ideDirtyByWindow;
}
function windows() {
  return ideWindows;
}
function lossAcceptedAt() {
  return ideLossAcceptedAt;
}

function confirmLosingIdeEdits(win2, unsaved) {
  if (unsaved <= 0) return true;
  if (Date.now() - ideLossAcceptedAt < 1e4) return true;
  const text = ideQuitWarning(unsaved);
  const opts = { type: "warning", buttons: ["Go back", "Lose the changes"], defaultId: 0, cancelId: 0, message: text.message, detail: text.detail };
  const choice = win2 && !win2.isDestroyed() ? electron.dialog.showMessageBoxSync(win2, opts) : electron.dialog.showMessageBoxSync(opts);
  if (choice !== 1) return false;
  ideLossAcceptedAt = Date.now();
  return true;
}
function clampBounds(raw) {
  if (!raw || typeof raw !== "object") return null;
  const n = (v) => typeof v === "number" && Number.isFinite(v);
  if (!n(raw.x) || !n(raw.y) || !n(raw.width) || !n(raw.height)) return null;
  if (raw.width < 200 || raw.height < 160) return null;
  return { x: Math.round(raw.x), y: Math.round(raw.y), width: Math.round(raw.width), height: Math.round(raw.height) };
}
function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...a);
    }, ms);
  };
}
function officeTitle() {
  try {
    return deps?.officeTitle?.() ?? "OzyComp";
  } catch {
    return "OzyComp";
  }
}
function installWindowHealth(win2, opts) {
  // the reference wires render-process-gone/unresponsive handlers here; ours
  // keep the seam so the host can attach its own health reporter.
  try {
    deps?.installWindowHealth?.(win2, opts);
  } catch {
  }
}
function createIdeWindow(ownerId) {
  const ownerWc = electron.webContents.fromId(ownerId);
  const owner = ownerWc ? electron.BrowserWindow.fromWebContents(ownerWc) : null;
  if (!owner || !ownerWc) throw new Error("the window that detached the IDE is gone");
  let saved = null;
  try {
    saved = clampBounds(deps.persist.getKv("window.ide.bounds"));
  } catch {
    saved = null;
  }
  const ob = owner.getBounds();
  const geom = saved ?? { x: ob.x + 40, y: ob.y + 40, width: ob.width, height: ob.height };
  const win2 = new electron.BrowserWindow({
    width: geom.width,
    height: geom.height,
    ...geom.x !== void 0 && geom.y !== void 0 ? { x: geom.x, y: geom.y } : {},
    // Smaller than an office window's minimum: an editor beside another app.
    minWidth: 720,
    minHeight: 480,
    title: `${officeTitle()} · IDE`,
    backgroundColor: "#FFF8E7",
    // The same frame the office window has on this platform.
    titleBarStyle: "hiddenInset",
    show: false,
    webPreferences: {
      preload: deps.preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The owner's session: the same localStorage, the same partition for a floor.
      session: owner.webContents.session
    }
  });
  win2.on("page-title-updated", (e) => {
    e.preventDefault();
  });
  const wc = win2.webContents;
  const wcId = wc.id;
  installWindowHealth(win2, { label: "ide" });
  win2.once("ready-to-show", () => win2.show());
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) electron.shell.openExternal(url);
    return { action: "deny" };
  });
  const saveBounds = debounce(() => {
    if (win2.isDestroyed() || win2.isMinimized() || win2.isMaximized()) return;
    try {
      deps.persist.setKv("window.ide.bounds", win2.getBounds());
    } catch {
    }
  }, 400);
  win2.on("resized", saveBounds);
  win2.on("moved", saveBounds);
  win2.on("close", (e) => {
    if (!win2.isDestroyed() && !win2.isMinimized() && !win2.isMaximized()) {
      try {
        deps.persist.setKv("window.ide.bounds", win2.getBounds());
      } catch {
      }
    }
    if (!ideWindows.closeRequested(wcId, allowQuit)) e.preventDefault();
  });
  win2.on("closed", () => {
    ideDirtyByWindow.forget(wcId);
    ideWindows.closed(wcId);
  });
  wc.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) ideDirtyByWindow.forget(wcId);
  });
  if (deps.isDev && deps.rendererUrl) {
    void win2.loadURL(`${deps.rendererUrl.replace(/\/$/, "")}/ide.html`);
  } else {
    void win2.loadFile(deps.ideHtmlPath);
  }
  return {
    id: wcId,
    send: (ch, p) => {
      if (!wc.isDestroyed()) wc.send(ch, p);
    },
    show: () => {
      if (win2.isDestroyed()) return;
      if (win2.isMinimized()) win2.restore();
      win2.show();
      win2.focus();
    },
    destroy: () => {
      if (!win2.isDestroyed()) win2.destroy();
    },
    isDestroyed: () => win2.isDestroyed()
  };
}

function registerIdeRuntime(e, d) {
  electron = e;
  deps = d;
  ideDirtyByWindow = new IdeDirtyLedger();
  ideWindows = new IdeWindows({
    create: (ownerId) => createIdeWindow(ownerId),
    owner: (ownerId) => {
      const wc = electron.webContents.fromId(ownerId);
      return wc ? { send: (ch, p) => {
        if (!wc.isDestroyed()) wc.send(ch, p);
      }, isDestroyed: () => wc.isDestroyed() } : null;
    },
    giveUp: (ideId) => {
      const wc = electron.webContents.fromId(ideId);
      const win2 = wc ? electron.BrowserWindow.fromWebContents(wc) : null;
      if (!win2 || win2.isDestroyed()) return;
      if (!confirmLosingIdeEdits(win2, ideDirtyByWindow.get(ideId) ?? 0)) return;
      win2.destroy();
    }
  });
  electron.ipcMain.on("ide:dirty", (evt, n) => {
    if (ideDirtyByWindow.report(evt.sender.id, n)) ideLossAcceptedAt = 0;
  });
  electron.ipcMain.handle("ide:detach", (evt, h) => {
    if (ideWindows.isIde(evt.sender.id)) return { ok: false, reason: "from-ide" };
    try {
      return ideWindows.detach(evt.sender.id, h);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
  electron.ipcMain.handle("ide:openIn", (evt, req) => ({ ok: !ideWindows.isIde(evt.sender.id) && ideWindows.openIn(evt.sender.id, req) }));
  electron.ipcMain.handle("ide:attach", (evt, h) => ideWindows.attach(evt.sender.id, h));
  electron.ipcMain.handle("ide:handoff", (evt) => ideWindows.isIde(evt.sender.id) ? ideWindows.boot(evt.sender.id) : { handoff: null, agents: [] });
  electron.ipcMain.handle("ide:state", (evt) => ideWindows.stateFor(evt.sender.id));
  electron.ipcMain.on("ide:attachedAck", (evt) => {
    ideWindows.ack(evt.sender.id);
  });
  electron.ipcMain.handle("ide:recall", (evt) => {
    const id = ideWindows.ideIdFor(evt.sender.id);
    if (id !== null) ideWindows.closeRequested(id, false);
    return { ok: id !== null };
  });
  electron.ipcMain.on("ide:agents", (evt, list) => {
    if (!ideWindows.isIde(evt.sender.id)) ideWindows.agents(evt.sender.id, list);
  });
  return { ideWindows, ideDirtyByWindow, confirmLosingIdeEdits };
}

module.exports = {
  registerIdeRuntime, confirmLosingIdeEdits, setAllowQuit, getAllowQuit,
  dirtyLedger, windows, lossAcceptedAt, clampBounds,
  _reset() {
    electron = null; deps = null; ideWindows = null; ideDirtyByWindow = null;
    ideLossAcceptedAt = 0; allowQuit = false;
  },
};
