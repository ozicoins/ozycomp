'use strict';
/**
 * Provider bridges — the per-provider hook/plugin installers that wire a
 * non-Claude CLI into the hive event plane, verbatim from the reference:
 *
 *   • hooks kind: agy → ~/.gemini hooks.json (translating shim)
 *                 gemini → per-agent system-settings.json
 *                 codex → per-agent CODEX_HOME config.toml ([[hooks]] tables,
 *                         trust entry, sandbox_workspace_write.writable_roots)
 *                 pi → per-agent PI_CODING_AGENT_DIR extension
 *                 opencode → per-agent OPENCODE_CONFIG_DIR plugin/*
 *                 grok → ~/.grok/hooks/ozy-hive.json
 *   • proxy kind: qwen/crush → loopback sidecar (bin/proxy-bridge.cjs) that
 *                 synthesizes Status/CostSample/PostToolUse/Stop from the
 *                 provider's own API traffic.
 *
 * Everything is best-effort: a failed install logs and degrades, it never
 * blocks the spawn.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const BIN = (...f) => path.join(__dirname, '..', '..', 'bin', ...f);

// ─── TOML helpers (verbatim semantics) ────────────────────────────────────

function tomlBasicString(s) { return JSON.stringify(String(s)); }

/** True when config.toml already holds a [projects.<dir>] table for dir. */
function hasCodexProjectTable(toml, dir) {
  const re = /^\s*\[([^\]]+)\]\s*$/gm;
  let m;
  while ((m = re.exec(toml))) {
    const segs = m[1].split('.').map(s => s.trim().replace(/^"(.*)"$/, '$1'));
    if (segs[0] === 'projects' && segs.slice(1).join('.') === dir) return true;
  }
  return false;
}

/** `[projects."<dir>"] trust_level = "trusted"` block, deduped. */
function codexTrustEntry(dir, existing = '') {
  if (hasCodexProjectTable(existing, dir)) return '';
  return `\n[projects.${tomlBasicString(dir)}]\ntrust_level = "trusted"\n`;
}

/**
 * Merge writable roots into config.toml — verbatim: if a writable_roots key
 * already exists (at root or under [sandbox_workspace_write]) leave the file
 * untouched (returns null = "respect the user's own list, pass --add-dir").
 */
function codexWritableRootsToml(toml, dirs) {
  if (!dirs.length) return toml;
  if (/^\s*(sandbox_workspace_write\.)?writable_roots\s*=/m.test(toml)) return null;
  const list = `[${dirs.map(d => tomlBasicString(d)).join(', ')}]`;
  const header = /^\s*\[sandbox_workspace_write\]\s*$/m.exec(toml);
  if (header) {
    const at = header.index + header[0].length;
    return `${toml.slice(0, at)}\nwritable_roots = ${list}${toml.slice(at)}`;
  }
  return `sandbox_workspace_write.writable_roots = ${list}\n${toml}`;
}

// ─── per-provider installers ───────────────────────────────────────────────

const cmd = bin => `node "${bin}"`;
const CODEX_HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop',
  'SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostCompact',
];

/**
 * Windows hook-command line, verbatim (ref ~9394/9447/9525): on win32 the
 * provider's hooks go through the launcher's `nodeRunWindowsHook`, which picks
 * the 8.3-short line, falls back to a PATH wrapper, or reports an unrunnable
 * line into `hookLineNotices` (the notice rides the next spawn's `degraded`,
 * surfaced as `hive:degraded` reason `hook-command`). Off win32 it is the plain
 * double-quoted `nodeRun`. `hooks` is the harness's NodeLauncher-shaped object;
 * without one the installer keeps its historical `node "bin"` line.
 */
const hookCmd = (hooks, provider, pathProven, shim, args = []) =>
  (hooks && process.platform === 'win32'
    ? hooks.nodeRunWindowsHook(provider, pathProven, shim, ...args)
    : (hooks ? hooks.nodeRun(shim, ...args) : [cmd(shim), ...args].join(' ')));

/**
 * agy (Antigravity): writes a `ozy-hive` hook group into BOTH candidate
 * Gemini-family hook files (~/.gemini/config/hooks.json and
 * ~/.gemini/antigravity-cli/hooks.json). Global, scoped by AGENT_ID inside the
 * shim — ordinary agy sessions exit the shim untouched.
 */
function installAgyHooks(log = console.error, hooks = null) {
  const legacy = BIN('agy-hook.cjs');
  // verbatim ~9392: when a shared bin is configured the bundle's launcher +
  // shim replace the per-floor path; the hook line then runs the launcher
  // (bundled node) against the shared shim, not `node shim`.
  const shared = hooks?.installSharedShim?.('agy-hook.cjs') ?? null;
  const shim = shared?.shim ?? legacy;
  // agy's PATH is not proven to reach its hooks (environmentSanitization strips
  // it) → pathProven=false: a spaced path reports, never wraps (ref ~9394).
  const command = event =>
    (hooks && process.platform === 'win32'
      ? (shared ? hooks.windowsHookLine('antigravity', shared.launcher, shim, [event], false)
                : hooks.nodeRunWindowsHook('antigravity', false, shim, event))
      : (shared ? [`"${shared.launcher}"`, `"${shim}"`, event].join(' ')
                : (hooks ? hooks.nodeRun(shim, event) : [cmd(shim), event].join(' '))));
  const tool = event => ({ matcher: '*', hooks: [{ type: 'command', command: command(event), timeout: 0 }] });
  const plain = event => ({ hooks: [{ type: 'command', command: command(event), timeout: 0 }] });
  const group = {
    PreToolUse: [tool('PreToolUse')],
    PostToolUse: [tool('PostToolUse')],
    PreInvocation: [plain('PreInvocation')],
    PostInvocation: [plain('PostInvocation')],
    Stop: [plain('Stop')],
  };
  const gem = path.join(os.homedir(), '.gemini');
  for (const p of [path.join(gem, 'config', 'hooks.json'), path.join(gem, 'antigravity-cli', 'hooks.json')]) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      let existing = {};
      if (fs.existsSync(p)) { try { existing = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { existing = {}; } }
      existing['ozy-hive'] = group;
      fs.writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
    } catch (e) { log('[hive] installAgyHooks failed:', e?.message ?? e); }
  }
}

/**
 * gemini: per-agent system settings file with the hook block — isolated from
 * the user's own GEMINI_CLI_HOME (object/array settings merge across layers).
 * Returns the settings path for GEMINI_CLI_SYSTEM_SETTINGS_PATH.
 */
function installGeminiHooks(dir, log = console.error, hooks = null) {
  const home = path.join(dir, '.gemini-hive');
  const settingsPath = path.join(home, 'system-settings.json');
  const shim = BIN('gemini-hook.cjs');
  try {
    fs.mkdirSync(home, { recursive: true });
    const hook = (name, matcher) => ({
      ...(matcher ? { matcher } : {}),
      sequential: true,
      hooks: [{ name: `ozy-hive-${name}`, type: 'command', command: hookCmd(hooks, 'gemini', true, shim), timeout: 30000 }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooksConfig: { enabled: true, notifications: false },
      hooks: {
        SessionStart: [hook('session-start')],
        BeforeAgent: [hook('before-agent')],
        BeforeTool: [hook('before-tool', '.*')],
        AfterTool: [hook('after-tool', '.*')],
        AfterAgent: [hook('after-agent')],
      },
    }, null, 2), 'utf8');
  } catch (e) { log('[hive] installGeminiHooks failed:', e?.message ?? e); }
  return settingsPath;
}

/**
 * codex: per-agent CODEX_HOME (<agentDir>/.codex) — copies/links the user's
 * auth + packages, extends their config.toml with [[hooks.*]] command tables
 * pointing at the Claude-shaped hive-hook shim (codex's hook contract IS
 * Claude-shaped), a [projects.<cwd>] trust entry, and
 * sandbox_workspace_write.writable_roots so `-s workspace-write` still reaches
 * the hive folders. Returns {home, rootsInConfig}.
 */
function installCodexHooks(agentDir, agentId, cwd, writableRoots = [], log = console.error, hooks = null) {
  const home = path.join(agentDir, '.codex');
  let rootsInConfig = false;
  try {
    fs.mkdirSync(home, { recursive: true });
    const userHome = path.join(os.homedir(), '.codex');
    for (const f of ['auth.json']) {
      const src = path.join(userHome, f), dest = path.join(home, f);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        try { fs.symlinkSync(src, dest); } catch { try { fs.copyFileSync(src, dest); } catch {} }
      }
    }
    const pkgSrc = path.join(userHome, 'packages'), pkgDest = path.join(home, 'packages');
    if (fs.existsSync(pkgSrc) && !fs.existsSync(pkgDest)) {
      try { fs.symlinkSync(pkgSrc, pkgDest, process.platform === 'win32' ? 'junction' : 'dir'); } catch {}
    }
    let config = '';
    const userConfig = path.join(userHome, 'config.toml');
    if (fs.existsSync(userConfig)) { try { config = fs.readFileSync(userConfig, 'utf8'); } catch {} }
    const shim = BIN('hive-hook.cjs');
    // codex's hooks see the agent's PATH (registry.rs Hooks::new →
    // build_command) → pathProven=true: a spaced path may take the wrapper.
    const codexCmd = hookCmd(hooks, 'codex', true, shim);
    config += '\n# --- ozy-hive lifecycle hooks (auto-generated; do not edit) ---\n';
    for (const ev of CODEX_HOOK_EVENTS) {
      config += `\n[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = ${JSON.stringify(codexCmd)}\ntimeout = 30\n`;
    }
    if (cwd) {
      let trusted = cwd;
      try { trusted = fs.realpathSync(cwd); } catch {}
      config += codexTrustEntry(trusted, config);
    }
    if (writableRoots.length) {
      const withRoots = codexWritableRootsToml(config, writableRoots);
      if (withRoots !== null) { config = withRoots; rootsInConfig = true; }
    }
    fs.writeFileSync(path.join(home, 'config.toml'), config, 'utf8');
    // expose session data roots so resume can find this agent's codex sessions
    for (const kind of ['sessions', 'archived_sessions']) {
      try {
        const src = path.join(userHome, kind), dest = path.join(home, kind);
        if (fs.existsSync(src) && !fs.existsSync(dest)) fs.symlinkSync(src, dest, 'dir');
      } catch {}
    }
  } catch (e) { log('[hive] installCodexHooks failed:', e?.message ?? e); }
  return { home, rootsInConfig };
}

/**
 * pi: per-agent PI_CODING_AGENT_DIR holding the hive-bridge extension +
 * extensions.json manifest; user model stores are copied in. Returns the dir.
 */
function installPiHooks(dir, log = console.error) {
  const home = path.join(dir, '.pi-agent');
  try {
    const extDir = path.join(home, 'extensions');
    fs.mkdirSync(extDir, { recursive: true });
    fs.copyFileSync(BIN('pi-hive-bridge.js'), path.join(extDir, 'hive-bridge.js'));
    fs.writeFileSync(path.join(home, 'extensions.json'), JSON.stringify(
      { name: 'ozy-hive-bridge', version: '0.3.2', main: 'extensions/hive-bridge.js', auto: true }, null, 2), 'utf8');
    const userPi = path.join(os.homedir(), '.pi', 'agent');
    for (const f of ['models.json', 'models-store.json']) {
      try { fs.copyFileSync(path.join(userPi, f), path.join(home, f)); }
      catch (e) { if (e.code !== 'ENOENT') log(`[hive] installPiHooks copy ${f} failed:`, e?.message ?? e); }
    }
  } catch (e) { log('[hive] installPiHooks failed:', e?.message ?? e); }
  return home;
}

/**
 * opencode: per-agent OPENCODE_CONFIG_DIR with the hive-bridge plugin dropped
 * into BOTH plugin/ and plugins/ (OpenCode auto-loads from either across
 * versions). `theme` writes the TUI theme pin. Returns the config dir.
 */
function installOpenCodePlugin(dir, theme, log = console.error) {
  const home = path.join(dir, '.opencode');
  try {
    if (theme) {
      fs.mkdirSync(home, { recursive: true });
      const choice = { theme: 'system' };
      fs.writeFileSync(path.join(home, 'tui.json'), JSON.stringify({ $schema: 'https://opencode.ai/tui.json', ...choice }, null, 2), 'utf8');
      fs.writeFileSync(path.join(home, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...choice }, null, 2), 'utf8');
    }
    for (const name of ['plugin', 'plugins']) {
      const pluginDir = path.join(home, name);
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.copyFileSync(BIN('opencode-hive-bridge.js'), path.join(pluginDir, 'hive-bridge.js'));
    }
  } catch (e) { log('[hive] installOpenCodePlugin failed:', e?.message ?? e); }
  return home;
}

/**
 * crush: no base-url env override exists, so the per-agent CRUSH_GLOBAL_CONFIG
 * pins every standard provider's base_url at the loopback proxy. Returns
 * {config, data} for the spawn env.
 */
function installCrushConfig(dir, loopbackUrl, api, theme, log = console.error) {
  const config = path.join(dir, 'crush.json');
  const data = path.join(dir, '.crush-data');
  try {
    fs.mkdirSync(data, { recursive: true });
    const wireProvider = api === 'anthropic' ? 'anthropic' : 'openai';
    const providers = { [wireProvider]: { base_url: loopbackUrl } };
    const options = theme ? { tui: { transparent: true } } : undefined;
    fs.writeFileSync(config, JSON.stringify(options ? { providers, options } : { providers }, null, 2), 'utf8');
  } catch (e) { log('[hive] installCrushConfig failed:', e?.message ?? e); }
  return { config, data };
}

/**
 * grok: hooks live in the user's global ~/.grok/hooks/ dir (global hooks are
 * trusted; grok sessions stay in the normal GROK_HOME). The shim self-scopes
 * by AGENT_ID. Idempotent overwrite of ozy-hive.json.
 */
function installGrokHooks(log = console.error, hooks = null) {
  const legacy = BIN('grok-hook.cjs');
  const shared = hooks?.installSharedShim?.('grok-hook.cjs') ?? null;
  const shim = shared?.shim ?? legacy;
  // verbatim ~9779: grok takes the plain double-quoted line (no win32 hook-line
  // branch — its hook host already keeps the line quoted). With a shared bin it
  // is `"launcher" "shim"` (bundled node), else the `nodeRun` node line.
  const command = shared
    ? [`"${shared.launcher}"`, `"${shim}"`].join(' ')
    : (hooks ? hooks.nodeRun(shim) : cmd(shim));
  const tool = matcher => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command }],
  });
  try {
    const hooks = {
      PreToolUse: [tool('.*')],
      PostToolUse: [tool('.*')],
      Stop: [tool()],
      SubagentStop: [tool('.*')],
      SessionStart: [tool('.*')],
      UserPromptSubmit: [tool()],
      PreCompact: [tool('.*')],
      PostCompact: [tool('.*')],
    };
    const hookDir = path.join(os.homedir(), '.grok', 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });
    fs.writeFileSync(path.join(hookDir, 'ozy-hive.json'), JSON.stringify({ hooks }, null, 2), 'utf8');
  } catch (e) { log('[hive] installGrokHooks failed:', e?.message ?? e); }
}

// ─── proxy-bridge sidecar (qwen, crush) ────────────────────────────────────

const PROXY_BIND_ATTEMPTS = 3;
// verbatim ~7056: wait between failed binds — short, then longer.
const PROXY_BIND_BACKOFF_MS = [250, 750];

class ProxyBridges {
  constructor(log = console.error) { this.children = new Map(); this.log = log; }

  /** Spawn bin/proxy-bridge.cjs as a node sidecar; resolves the bound port (0 on failure). */
  start(agentId, { sock, sessionId, api, upstream }) {
    this.stop(agentId);
    return new Promise(resolve => {
      let settled = false;
      const settle = p => { if (!settled) { settled = true; resolve(p); } };
      let child;
      try {
        child = spawn(process.execPath, [BIN('proxy-bridge.cjs')], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            HIVE_SOCK: sock,
            AGENT_ID: agentId,
            UPSTREAM_BASE_URL: upstream,
            HIVE_PROXY_SESSION: sessionId,
            HIVE_PROXY_API: api,
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch (e) { this.log(`[hive] proxy bridge spawn failed for ${agentId}:`, e?.message ?? e); return settle(0); }
      this.children.set(agentId, child);
      let buf = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', d => {
        if (settled) return;
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        try { settle(JSON.parse(buf.slice(0, nl)).port ?? 0); } catch { settle(0); }
      });
      child.on('exit', () => { this.children.delete(agentId); settle(0); });
      setTimeout(() => settle(0), 5000).unref?.();
    });
  }

  /** start() with a short retry ladder. Every attempt kills the previous
   *  sidecar first (start is idempotent), so a retry never leaks a listener.
   *  Resolves the bound port, or 0 once every attempt has failed.
   *  verbatim ref ~8510-8521 + PROXY_BIND_BACKOFF_MS [250,750] (~7056). */
  async startWithRetry(agentId, cfg, attempts = PROXY_BIND_ATTEMPTS) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const port = await this.start(agentId, cfg);
      if (port > 0) return port;
      if (attempt < attempts) {
        console.warn(`[hive] proxy bridge for ${agentId} did not bind (attempt ${attempt}/${attempts}), retrying`);
        await new Promise((r) => setTimeout(r, PROXY_BIND_BACKOFF_MS[attempt - 1] ?? 1e3));
      }
    }
    return 0;
  }

  stop(agentId) {
    const c = this.children.get(agentId);
    if (c) { try { c.kill(); } catch {} this.children.delete(agentId); }
  }

  stopAll() { for (const id of [...this.children.keys()]) this.stop(id); }
}

function proxySessionId(root, agentId) {
  return `proxy-${agentId}-${crypto.createHash('sha1').update(root + agentId + Date.now()).digest('hex').slice(0, 12)}`;
}

module.exports = {
  installAgyHooks, installGeminiHooks, installCodexHooks, installPiHooks,
  installOpenCodePlugin, installCrushConfig, installGrokHooks,
  codexTrustEntry, codexWritableRootsToml, hasCodexProjectTable,
  ProxyBridges, proxySessionId, PROXY_BIND_ATTEMPTS,
};
