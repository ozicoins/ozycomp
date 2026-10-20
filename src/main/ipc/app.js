'use strict';
/**
 * app:* + shared-shell IPC surface — verbatim port of the reference blocks
 * (index.js ~34948-34990, ~36228-36340, ~36495-36520, ~37185-37215) plus the
 * teardown helpers they call (~36134-36185, ~4382-4395).
 *
 * What lives here:
 *   app:copyToClipboard / readClipboard / readClipboardSync / info /
 *       openExternal / setLoginItem / setNotifications /
 *       confirmClose / cancelClose / resetAll
 *   dialog:chooseFolder, terminal:openAtFolder, window:newFloor,
 *   voice:terminal, clipboard:saveImage, drop:saveFile,
 *   (dev:noGod lives in ipc/config.js — not duplicated here),
 *   power:resume (push channel — emitted by resume-from-sleep),
 *   session:resolveCwd, fs:revealPath already under ipc/fs.js.
 *
 * ctx supplies every subsystem the stop-list iterates; each entry is wrapped
 * in the verbatim try/catch+log so a missing subsystem never aborts reset.
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

function register(ctx) {
  const { ipcMain, app, shell, dialog, clipboard, BrowserWindow } = ctx;

  // ── verbatim helpers ────────────────────────────────────────────────────
  const removeTreeFully = async (dir, opts = {}) => {
    const fs2 = require('node:fs');
    const p2 = require('node:path');
    const rmrf = async (d) => {
      try { await fs2.promises.rm(d, { recursive: true, force: true }); return { gone: true }; }
      catch (e) { return { gone: !fs2.existsSync(d), error: e instanceof Error ? e.message : String(e) }; }
    };
    const r = await rmrf(dir);
    if (r.gone) return r;
    if (opts.moveAside !== false) {
      const aside = `${dir}.reset-${Date.now()}`;
      try { await fs2.promises.rename(dir, aside); return { gone: true, movedAside: aside }; } catch {}
    }
    return r;
  };

  const resetConfig = () => {
    try {
      const cfgPath = path.join(ctx.ozycompHome?.() ?? app.getPath('userData'), 'config.json');
      const fresh = { version: 1 };
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify(fresh, null, 2));
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };

  // pendingRestart — the updater stashes its deferred quit-resolve here so
  // app:cancelClose can release it (verbatim global `pendingRestart`).
  const pendingRestartBox = (ctx.pendingRestart ??= { current: null });
  const abortPendingRestart = () => {
    if (!pendingRestartBox.current) return;
    const resolve = pendingRestartBox.current;
    pendingRestartBox.current = null;
    console.log('[quit] quitAndInstall cancelled by the user at the quit warning');
    resolve({ ok: false, error: 'cancelled' });
  };

  const stopList = (tag) => [
    ['stopAutomationArming', () => ctx.missionArming?.stop?.()],
    ['clearMissionTimers', () => ctx.missionScheduler?.clear?.()],
    ['clearContextTimers', () => ctx.contextTriggers?.clearTimers?.()],
    ['stopWebhookDoneObserver', () => ctx.webhooks?.doneObserver?.stop?.()],
    ['stopWorkerWatcher', () => ctx.workerWatcher?.stop?.()],
    ['broker.stop', () => ctx.integrationBroker?.stop?.()],
    ['stopRouter', () => ctx.harness?.hive?.stopRouting?.() ?? ctx.harness?.hive?.stopRouter?.()],
    ['stopTaskHygiene', () => ctx.taskHygiene?.stop?.()],
    ['hookServer.stop', () => ctx.harness?.hooks?.stop?.()],
    ['telemetry.stop', () => ctx.harness?.telemetry?.stop?.()],
    ['slack.stop', () => ctx.slackOps?.stopSlackIngestion?.() ?? ctx.slack?.stop?.()],
    ['memory.stop', () => ctx.harness?.memory?.stop?.()],
    ['reflector.stop', () => ctx.reflector?.stop?.()],
    ['persist.close', () => ctx.persist?.close?.()],
    ['killAll', () => ctx.harness?.pty?.killAll?.()],
    ['removeExposedCodexData', () => ctx.harness?.hive?.removeExposedCodexData?.()],
    ['dropCommits', () => ctx.harness?.hive?.dropCommits?.()],
    ['roster.archive', () => ctx.roster?.archive?.()],
    ['webhooks.stop', () => ctx.webhooks?.stop?.()],
    ['fileShare.stop', () => ctx.fileShareStore?.stop?.()],
    ['voice.stop', () => ctx.voice?.stop?.()],
    ['anyApp.stop', () => ctx.anyApp?.stop?.()],
    ['puckRuntime.stop', () => ctx.puckRuntime?.stop?.()],
  ];

  async function teardownAndQuit() {
    ctx.ideRuntime?.setAllowQuit?.(true);
    for (const [name, fn] of stopList('quit')) {
      try { await fn(); } catch (e) { console.error(`[quit] ${name}:`, e); }
    }
    app.quit();
  }
  ctx.teardownAndQuit = teardownAndQuit;

  // ── channels ────────────────────────────────────────────────────────────
  ipcMain.handle('app:copyToClipboard', (_e, text) => {
    if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
    try { clipboard.writeText(text); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  ipcMain.handle('app:readClipboard', () => {
    try { return clipboard.readText(); } catch { return ''; }
  });
  ipcMain.on('app:readClipboardSync', (evt) => {
    try { evt.returnValue = clipboard.readText(); } catch { evt.returnValue = ''; }
  });
  ipcMain.handle('app:info', () => {
    let changelog = '';
    for (const p of [path.join(app.getAppPath(), 'CHANGELOG.md'), path.join(process.cwd(), 'CHANGELOG.md')]) {
      try { changelog = fs.readFileSync(p, 'utf8'); if (changelog) break; } catch {}
    }
    const top = changelog ? changelog.split(/\n## /).slice(1, 3).map((s) => `## ${s}`).join('\n').slice(0, 8e3) : '';
    return { version: app.getVersion(), changelog: top };
  });
  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (typeof url !== 'string' || !/^(x-apple\.systempreferences:|ms-settings:|https:\/\/)/.test(url)) {
      return { ok: false, error: 'blocked url' };
    }
    await shell.openExternal(url);
    return { ok: true };
  });
  ipcMain.handle('app:setLoginItem', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled === true });
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('app:setNotifications', (_e, val) => ctx.writeConfig({ notifications: val === true }));
  ipcMain.handle('app:confirmClose', () => teardownAndQuit());
  ipcMain.handle('app:cancelClose', () => abortPendingRestart());

  ipcMain.handle('app:resetAll', async () => {
    ctx.ideRuntime?.setAllowQuit?.(true);
    for (const [name, fn] of stopList('reset')) {
      try { await fn(); } catch (e) { console.error(`[reset] ${name}:`, e); }
    }
    for (const dir of [ctx.harness?.hive?.root?.(), ctx.harness?.memory?.palacePath?.()].filter(Boolean)) {
      const removed = await removeTreeFully(dir);
      if (!removed.gone) console.error('[reset] rm', dir, removed.error);
      else if (removed.movedAside) console.warn(`[reset] ${dir} would not delete; moved aside to ${removed.movedAside}`);
    }
    resetConfig();
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('dialog:chooseFolder', async (evt) => {
    const win2 = BrowserWindow.fromWebContents(evt.sender);
    if (!win2) return { ok: false, error: 'no window' };
    const res = await dialog.showOpenDialog(win2, {
      properties: ['openDirectory', 'createDirectory'],
      title: 'Pick a folder',
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, error: 'cancelled' };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle('terminal:openAtFolder', async (_e, cwd) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
    return new Promise((resolve) => {
      const p = spawn('open', ['-a', 'Terminal', cwd]);
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('close', (code) => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: err.trim() || `open exited ${code}` });
      });
    });
  });

  ipcMain.handle('window:newFloor', (evt) => {
    if (!ctx.readConfig().multiWindow) return { ok: false };
    return { ok: ctx.openFloorPicker?.(BrowserWindow.fromWebContents(evt.sender)) ?? false };
  });

  // dev:noGod is registered in ipc/config.js (the verbatim version checks
  // app.isPackaged + MD_NO_GOD + OZYC_NO_GOD + --no-god argv). A second
  // ipcMain.handle here threw "second handler" and aborted config.js mid-
  // register, leaving config:homeSync (sendSync) with no listener — renderer
  // preload died. Kept removed.

  ipcMain.handle('session:resolveCwd', async (_e, p) => {
    if (typeof p !== 'string' || !p) return null;
    const tilde = p.replace(/^~(?=$|\/|\\)/, require('node:os').homedir());
    try {
      const st = await fs.promises.stat(tilde);
      return st.isDirectory() ? fs.realpathSync.native(tilde) : null;
    } catch { return null; }
  });

  // clipboard:saveImage — clipboard image → temp png file, verbatim (ref ~36082).
  ipcMain.handle('clipboard:saveImage', async () => {
    try {
      const img = clipboard.readImage();
      if (img.isEmpty()) return { ok: false, error: 'no image in clipboard' };
      const dir = path.join(app.getPath('temp'), 'cth-pastes');
      fs.mkdirSync(dir, { recursive: true });
      const name = `paste-${Date.now()}.png`;
      const dest = path.join(dir, name);
      fs.writeFileSync(dest, img.toPNG());
      return { ok: true, file: { path: dest, name } };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });

  // drop:saveFile — dragged file bytes → temp file, verbatim (ref ~36098).
  const DROP_SAVE_MAX_BYTES = 64 * 1024 * 1024;
  ipcMain.handle('drop:saveFile', async (_e, name, bytes) => {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        return { ok: false, error: 'no bytes' };
      }
      if (bytes.byteLength > DROP_SAVE_MAX_BYTES) {
        return { ok: false, error: 'file too large to persist' };
      }
      const raw = typeof name === 'string' && name ? name : 'drop';
      const safe = raw.replace(/[/\\]/g, '').replace(/[\u0000-\u001f]/g, '').slice(-80) || 'drop';
      const dir = path.join(app.getPath('temp'), 'cth-drops');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(dest, bytes);
      return { ok: true, file: { path: dest, name: safe } };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });

  // voice:terminal — last-N-lines tail for voice prompts, verbatim.
  ipcMain.handle('voice:terminal', (_e, ptyId, rows, lines) => {
    if (typeof ptyId !== 'string' || !ptyId) return { ok: false, lines: [], source: 'none' };
    const drawn = Array.isArray(rows) ? rows.filter((r) => typeof r === 'string') : [];
    const fromScreen = drawn.some((r) => /[\p{L}\p{N}]/u.test(r));
    const tail = ctx.harness?.pty?.scrollback?.(ptyId) ?? '';
    const source = fromScreen ? drawn : tail.split('\n').slice(-Math.max(1, typeof lines === 'number' ? lines : 40));
    return { ok: true, lines: source, source: fromScreen ? 'screen' : source.length ? 'stream' : 'none' };
  });
}

module.exports = { register };
