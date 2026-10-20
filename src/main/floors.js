'use strict';
/**
 * Floors — multi-office tenancy. One OzyComp process = one floor. A floor is a
 * self-contained harness rooted at its own home dir, spawned as a child
 * process of the same binary with extra flags:
 *
 *   ozycomp --floor-data=<dir> [--floor-shared=<dir>] [--floor-home=<dir>]
 *
 *   --floor-data    per-floor private data dir (the floor's userData)
 *   --floor-shared  shared cross-floor dir (announcements, company-wide board)
 *   --floor-home    the floor's harness home (hive, workspaces); defaults to
 *                   <userData>/floors/<sha1(resolved floorHome)[0:12]>
 *
 * Env MD_* variables are stripped from the child's environment so a parent
 * floor's OZYC_* / MD_* overrides never leak down. The parent's config is
 * copied minus the per-floor keys in FLOOR_CONFIG_STRIP.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson } = require('./hive');

/** Config keys that are per-floor and must NOT be inherited by a child floor
 *  (verbatim FLOOR_CONFIG_STRIP, ref ~12575). */
const FLOOR_CONFIG_STRIP = new Set([
  'harnessHome', 'recentHives', 'registeredRepos', 'missions',
  'opsStandupSeeded', 'heartbeatSeeded', 'compactMaintenanceSeeded',
  'agentTokenCaps', 'agentMcp', 'autoDeliveryPausedAgents',
  'avatars', 'slackEnabled', 'slackSigningSecret', 'slackBotToken',
  'slackChannelId', 'slackPort', 'slackProactivePosting', 'slackMode',
  'webhookEnabled', 'webhookSecret', 'webhookPort', 'webhookTriggers',
  'floorData', 'floorShared', 'floorHome',
  'slackAppToken', 'slackChannel', 'license', 'deviceId',
]);

const FLOORS_FILE = 'floors.json';

/** `--floor-data=x` / `--floor-data x` / env fallbacks → {floorData?,floorShared?,floorHome?} */
function parseFloorArgs(argv = process.argv, env = process.env) {
  const out = {};
  const grab = (flag, key) => {
    const eq = argv.find(a => a.startsWith(`--${flag}=`));
    if (eq) { out[key] = eq.slice(flag.length + 3); return; }
    const i = argv.indexOf(`--${flag}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[i + 1];
  };
  grab('floor-data', 'floorData');
  grab('floor-shared', 'floorShared');
  grab('floor-home', 'floorHome');
  out.floorData   ??= env.MD_FLOOR_DATA;
  out.floorShared ??= env.MD_FLOOR_SHARED;
  out.floorHome   ??= env.MD_FLOOR_HOME;
  return out;
}

/** `<userData>/floors/<sha1(resolved home)[0:12]>` — stable per target home. */
function floorDataDirFor(userDataDir, floorHome) {
  const hash = crypto.createHash('sha1').update(path.resolve(floorHome)).digest('hex').slice(0, 12);
  return path.join(userDataDir, 'floors', hash);
}

const FLOOR_DATA_FLAG = '--floor-data=';
const FLOOR_SHARED_FLAG = '--floor-shared=';
const FLOOR_HOME_FLAG = '--floor-home=';

/**
 * Plan the child spawn. VERBATIM (ref ~12565): the SAME app re-launched with
 * the three floor flags — `packaged ? flags : [appPath, ...flags]`, returns
 * {command, args} with no env (env comes from floorSpawnEnv at spawn). The
 * clone's tests/planner also pass the argv-filter shape
 * {execPath, argv, floorData, floorShared, floorHome, env} — keep it: when `argv`
 * or `env` is present we return {command, args, env, cwd} exactly as before.
 */
function floorSpawnPlan(o = {}) {
  // verbatim shape — {execPath, appPath, packaged, dataDir, sharedDir, home}
  if (o.home !== undefined || (o.argv === undefined && o.env === undefined && o.floorHome === undefined)) {
    const flags = [`${FLOOR_DATA_FLAG}${o.dataDir}`, `${FLOOR_SHARED_FLAG}${o.sharedDir}`, `${FLOOR_HOME_FLAG}${o.home}`];
    return { command: o.execPath, args: o.packaged ? flags : [o.appPath, ...flags] };
  }
  // legacy argv-filter shape — {execPath, argv, floorData, floorShared, floorHome, env}
  const { execPath = process.execPath, argv = process.argv.slice(1),
          floorData, floorShared, floorHome, env = process.env } = o;
  const args = argv.filter((a, i) => {
    if (/^--floor-(data|shared|home)=/.test(a)) return false;
    if (/^--floor-(data|shared|home)$/.test(a) ) return false;
    if (i > 0 && /^--floor-(data|shared|home)$/.test(argv[i - 1])) return false;
    return true;
  });
  if (floorData)   args.push(`--floor-data=${floorData}`);
  if (floorShared) args.push(`--floor-shared=${floorShared}`);
  if (floorHome)   args.push(`--floor-home=${floorHome}`);
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^(MD_|OZYC_)/.test(k)));
  if (floorHome) childEnv.MD_FLOOR_HOME = floorHome;
  if (floorData) childEnv.MD_FLOOR_DATA = floorData;
  return { command: execPath, args, env: childEnv, cwd: env.HOME ?? '/' };
}

/** verbatim ~12569: strip this floor's own overrides so the child starts clean. */
function floorSpawnEnv(env) {
  const out = { ...env };
  delete out.MD_USER_DATA;
  delete out.MD_FLOOR_DATA;
  delete out.MD_FLOOR_SHARED;
  delete out.MD_FLOOR_HOME;
  return out;
}

/** verbatim ~12596: the child floor's config = main minus per-floor keys. */
function seedFloorConfig(main, harnessHome) {
  const out = {};
  for (const [k, v] of Object.entries(main)) if (!FLOOR_CONFIG_STRIP.has(k)) out[k] = v;
  out.harnessHome = path.resolve(harnessHome);
  out.recentHives = [path.resolve(harnessHome)];
  out.slackEnabled = false;
  out.webhookEnabled = false;
  return out;
}

let shared = null;
function setSharedDataDir(dir) { shared = dir; }
function sharedDataDir() {
  return shared ?? require('electron').app.getPath('userData');
}

/**
 * verbatim ~37654 spawnFloor: launch a sibling OzyComp process rooted at
 * harnessHome under its own data dir, detached, with the floor flags.
 */
function spawnFloor({ harnessHome, execPath = process.execPath, appPath, packaged, sharedDir } = {}) {
  const { spawn } = require('node:child_process');
  const dataDir = floorDataDirFor(sharedDir ?? sharedDataDir(), harnessHome);
  const plan = floorSpawnPlan({ execPath, appPath: appPath ?? process.cwd(), packaged: !!packaged, dataDir, sharedDir: sharedDir ?? sharedDataDir(), home: harnessHome });
  return new Promise((done) => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', env: floorSpawnEnv(process.env) });
      child.once('spawn', () => {
        child.unref();
        console.log(`[floor] spawned pid ${child.pid} on ${harnessHome} (data ${dataDir})`);
        done({ ok: true });
      });
      child.once('error', (e) => done({ ok: false, error: e.message }));
    } catch (e) {
      done({ ok: false, error: String(e) });
    }
  });
}

// ── floor registry (who lives on which floor) ────────────────────────────────
class FloorRegistry {
  constructor(homeDir) { this.homeDir = homeDir; }
  file() { return path.join(this.homeDir, FLOORS_FILE); }
  all()  { return readJson(this.file(), { floors: [] }).floors; }
  save(list) { writeJson(this.file(), { floors: list }); }

  register(floor) {
    const list = this.all().filter(f => f.id !== floor.id);
    list.push({ createdAt: new Date().toISOString(), ...floor });
    this.save(list);
    return floor;
  }
  remove(id) { this.save(this.all().filter(f => f.id !== id)); }
}

/** Copy the parent config for a child floor minus per-floor keys. */
function floorChildConfig(parentConfig = {}) {
  return Object.fromEntries(
    Object.entries(parentConfig).filter(([k]) => !FLOOR_CONFIG_STRIP.has(k)));
}

module.exports = {
  parseFloorArgs, floorDataDirFor, floorSpawnPlan, floorSpawnEnv,
  seedFloorConfig, spawnFloor, setSharedDataDir, sharedDataDir, floorChildConfig,
  FloorRegistry, FLOOR_CONFIG_STRIP, FLOORS_FILE,
};
