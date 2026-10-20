'use strict';
/**
 * Renderer health — verbatim port of the reference's window-crash supervisor
 * (out/main/index.js ~1504-1681): a per-window ReloadBudget (3 automatic
 * reloads per 10 minutes, then the dialog takes over), a WeakSet of
 * renderer-dead windows so the quit path never prompts into a corpse, the
 * renderer-health.log diary under userData/logs, and installWindowHealth's
 * crash/hang wiring (render-process-gone → budgeted reload or "keeps
 * crashing" dialog; unresponsive → 20s fuse → "stopped responding" dialog;
 * responsive/did-finish-load mark the renderer alive again). The process-wide
 * half, installProcessHealth, diaries child-process-gone.
 *
 * Electron is injected: bindElectron(electronNs) at register time so the module
 * loads headless and every function is a no-op-safe guard.
 */
const node_fs = require('node:fs');
const path = require('node:path');

let electron = null;
function bindElectron(ns) { electron = ns; }

const RECOVERABLE_REASONS = new Set([
  'crashed',
  'oom',
  'killed',
  'abnormal-exit',
  'launch-failed',
  'integrity-failure',
]);
function shouldRecoverFrom(reason) {
  return RECOVERABLE_REASONS.has(reason);
}
const BUDGET_LIMIT = 3;
const BUDGET_WINDOW_MS = 10 * 60 * 1e3;

class ReloadBudget {
  constructor(limit = BUDGET_LIMIT, windowMs = BUDGET_WINDOW_MS, now = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.stamps = [];
  }
  /** Whether one more automatic reload is allowed right now. Read-only. */
  allows() {
    return this.live().length < this.limit;
  }
  /** Consume one reload. Returns false (and consumes nothing) when spent. */
  take() {
    const live = this.live();
    if (live.length >= this.limit) return false;
    live.push(this.now());
    this.replace(live);
    return true;
  }
  /** Reloads used inside the current window — for the diagnostic record. */
  used() {
    return this.live().length;
  }
  live() {
    const cutoff = this.now() - this.windowMs;
    return this.stamps.filter((t) => t > cutoff);
  }
  replace(next) {
    this.stamps.length = 0;
    this.stamps.push(...next);
  }
}

const deadRenderers = new WeakSet();
function markRendererDead(win) {
  deadRenderers.add(win);
}
function markRendererAlive(win) {
  deadRenderers.delete(win);
}
function canPromptRenderer(win) {
  if (!win || win.isDestroyed()) return false;
  if (deadRenderers.has(win)) return false;
  const wc = win.webContents;
  return !wc.isDestroyed() && !wc.isCrashed();
}
function logQuitPromptDecision(win, where) {
  const ok = canPromptRenderer(win);
  logHealthEvent('quit-prompt', {
    where,
    willPrompt: ok,
    hasWindow: !!win,
    marked: !!win && !win.isDestroyed() && deadRenderers.has(win),
    crashed: !!win && !win.isDestroyed() && !win.webContents.isDestroyed() && win.webContents.isCrashed(),
  });
  return ok;
}
function healthLogPath() {
  return path.join(electron.app.getPath('userData'), 'logs', 'renderer-health.log');
}
function logHealthEvent(event, detail = {}) {
  const line = `${new Date().toISOString()} ${event} ${JSON.stringify(detail)}\n`;
  console.error(`[renderer-health] ${line.trimEnd()}`);
  try {
    const file = healthLogPath();
    node_fs.mkdirSync(path.join(file, '..'), { recursive: true });
    node_fs.appendFileSync(file, line);
  } catch {
  }
}

const HANG_PROMPT_AFTER_MS = 2e4;
function installWindowHealth(win, opts) {
  const { label } = opts;
  const budget = new ReloadBudget();
  let hangTimer = null;
  let hangPromptOpen = false;
  const clearHangTimer = () => {
    if (hangTimer) {
      clearTimeout(hangTimer);
      hangTimer = null;
    }
  };
  const reload = (why) => {
    if (win.isDestroyed()) return;
    logHealthEvent('reload', { label, why, used: budget.used() });
    try {
      win.webContents.reload();
      opts.onReloaded?.(win.webContents);
    } catch (e) {
      logHealthEvent('reload-failed', { label, why, error: String(e) });
    }
  };
  win.webContents.on('render-process-gone', (_e, details) => {
    clearHangTimer();
    markRendererDead(win);
    const { reason, exitCode } = details;
    logHealthEvent('render-process-gone', { label, reason, exitCode });
    if (!shouldRecoverFrom(reason)) return;
    if (win.isDestroyed()) return;
    if (budget.take()) {
      reload(`render-process-gone:${reason}`);
      return;
    }
    logHealthEvent('reload-budget-exhausted', { label, reason, exitCode });
    void electron.dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['Reload window', 'Leave it'],
      defaultId: 0,
      cancelId: 1,
      message: 'The OzyComp window keeps crashing.',
      detail: `The interface crashed ${BUDGET_LIMIT} times in a row (${reason}). Your agents are still running — this window is the only thing affected.\n\nDiagnostics: ${healthLogPath()}`,
    }).then(({ response }) => {
      if (response === 0) reload('user:after-budget');
    });
  });
  win.on('unresponsive', () => {
    logHealthEvent('unresponsive', { label });
    clearHangTimer();
    hangTimer = setTimeout(() => {
      hangTimer = null;
      if (win.isDestroyed() || hangPromptOpen) return;
      hangPromptOpen = true;
      logHealthEvent('unresponsive-prompt', { label, afterMs: HANG_PROMPT_AFTER_MS });
      void electron.dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Reload window', 'Keep waiting'],
        defaultId: 1,
        cancelId: 1,
        message: 'The OzyComp window has stopped responding.',
        detail: `Your agents keep running either way — reloading only rebuilds the interface. Closing the window from the desktop instead would stop every running agent.\n\nDiagnostics: ${healthLogPath()}`,
      }).then(({ response }) => {
        hangPromptOpen = false;
        if (response === 0) reload('user:unresponsive');
      }).catch(() => {
        hangPromptOpen = false;
      });
    }, HANG_PROMPT_AFTER_MS);
  });
  win.webContents.on('did-finish-load', () => {
    markRendererAlive(win);
  });
  win.webContents.on('did-start-loading', () => {
    markRendererAlive(win);
  });
  win.on('responsive', () => {
    clearHangTimer();
    logHealthEvent('responsive', { label });
  });
  win.on('closed', clearHangTimer);
}
function installProcessHealth() {
  electron.app.on('child-process-gone', (_e, details) => {
    logHealthEvent('child-process-gone', {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
      name: details.name,
    });
  });
}

module.exports = {
  RECOVERABLE_REASONS, shouldRecoverFrom,
  BUDGET_LIMIT, BUDGET_WINDOW_MS, HANG_PROMPT_AFTER_MS,
  ReloadBudget,
  markRendererDead, markRendererAlive, canPromptRenderer,
  logQuitPromptDecision, healthLogPath, logHealthEvent,
  installWindowHealth, installProcessHealth,
  bindElectron,
};
