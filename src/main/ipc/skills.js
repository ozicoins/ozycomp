'use strict';
/**
 * Verbatim port — `skills` IPC group (5 channels).
 * Reference: out/main/index.js handlers at lines 35944–35980 (skills:local,
 * skills:catalog, skills:install, skills:uninstall, skills:reveal) with
 * skillsResourceDir() verbatim from line 32761. The underlying hub —
 * listLocalSkills, loadCatalog, installSkill, uninstallSkill — lives in
 * src/main/skills-hub.js and is injected as ctx.skillsHub.
 */
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

function skillsResourceDir() {
  // packaged: extraResources copies repo skills/ → <resourcesPath>/skills;
  // dev: the bundled catalog lives at the repo root `skills/` (one level up
  // from appPath == package.json dir), not under a resources/ subdir.
  if (electron.app.isPackaged) return path.join(process.resourcesPath, 'skills');
  const appPath = electron.app.getAppPath();
  const repoSkills = path.join(appPath, 'skills');
  return require('node:fs').existsSync(repoSkills)
    ? repoSkills
    : path.join(appPath, 'resources', 'skills');
}

function register(ctx) {
  const ipcMain = ctx.ipcMain;
  const hub = ctx.skillsHub ?? require('../skills-hub');
  const shell = ctx.shell ?? electron.shell;

  ipcMain.handle('skills:local', (_evt, cwd) => {
    const cfg = ctx.readConfig();
    const cwds = [
      ...typeof cwd === 'string' && cwd ? [cwd] : [],
      ...cfg.registeredRepos ?? []
    ];
    try {
      return hub.listLocalSkills({ cwds, bundledDir: skillsResourceDir() });
    } catch (e) {
      console.error('[skills] local scan failed:', e);
      return [];
    }
  });

  ipcMain.handle('skills:catalog', async (_evt, force) => {
    const cachePath = path.join(electron.app.getPath('userData'), 'skill-catalog.json');
    return hub.loadCatalog(cachePath, { force: force === true });
  });

  ipcMain.handle('skills:install', async (_evt, url, name) => {
    if (typeof url !== 'string' || typeof name !== 'string') {
      return { ok: false, error: 'bad request' };
    }
    return hub.installSkill(url, name);
  });

  ipcMain.handle('skills:uninstall', (_evt, path2) => {
    if (typeof path2 !== 'string') return { ok: false, error: 'bad request' };
    const cfg = ctx.readConfig();
    return hub.uninstallSkill(path2, { cwds: cfg.registeredRepos ?? [] });
  });

  ipcMain.handle('skills:reveal', (_evt, path$1) => {
    if (typeof path$1 !== 'string' || !path$1.trim()) return { ok: false, error: 'bad request' };
    const skillRoots = [path.join(os.homedir(), '.claude', 'skills'), path.join(os.homedir(), '.config', 'opencode')];
    const target2 = path.resolve(path$1);
    const inRoot = skillRoots.some((r) => target2.startsWith(path.resolve(r) + path.sep)) || (ctx.readConfig().registeredRepos ?? []).some((c) => target2.startsWith(path.resolve(c) + path.sep));
    if (!inRoot) return { ok: false, error: 'outside a managed skills directory' };
    shell.showItemInFolder(target2);
    return { ok: true };
  });
}

module.exports = { register };
