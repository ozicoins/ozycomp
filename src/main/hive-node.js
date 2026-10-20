'use strict';
/**
 * The bundled-node launcher — verbatim port of the reference. A hive gets
 * `<root>/bin/hive-node` (and `hive-node.cmd` on Windows): a wrapper that
 * prefers a real, new enough system node and falls back to
 * ELECTRON_RUN_AS_NODE. Anything an agent is told to run is baked with the
 * ABSOLUTE path — never `$HIVE_NODE`, which is dead on arrival under
 * cmd.exe/PowerShell.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { shellPathGeneration, userShellPath } = require('./command-resolver');

function joinCommandLine(parts) {
  return parts.map((part) => /\s/.test(part) ? `"${part}"` : part).join(" ");
}
function hookWrapperSafe(p) {
  return /^[\x20-\x7e]+$/.test(p);
}
function hookWrapperBody(launcher, script) {
  const q = (p) => `"${p.replace(/%/g, "%%")}"`;
  return `@${q(launcher)} ${q(script)} %*\r
`;
}
function hookWrapperTargets(body2) {
  const m = body2.match(/^@"([^"]*)" "([^"]*)" %\*\r?\n?$/);
  return m ? [m[1].replace(/%%/g, "%"), m[2].replace(/%%/g, "%")] : null;
}
function shimBundleHash(files) {
  const h = crypto.createHash("sha256");
  for (const name of Object.keys(files).sort()) h.update(name).update("\0").update(files[name]).update("\0");
  return h.digest("hex").slice(0, 16);
}
const MAX_CRASH_LOGS = 50;
function pruneCrashLogs(dir) {
  try {
    const logs = fs.readdirSync(dir).filter((f) => f.endsWith(".log")).sort();
    for (const stale of logs.slice(0, Math.max(0, logs.length - MAX_CRASH_LOGS))) {
      try {
        fs.unlinkSync(path.join(dir, stale));
      } catch {
      }
    }
  } catch {
  }
}

function nodeLauncherBodies(execPath, systemNode, platform = process.platform) {
  const fwd = (p) => p.replace(/\\/g, "/");
  const electronSh = `ELECTRON_RUN_AS_NODE=1 exec "${fwd(execPath)}" "$@"
`;
  const posix = systemNode ? `#!/bin/sh
if [ -x "${fwd(systemNode)}" ]; then exec "${fwd(systemNode)}" "$@"; fi
${electronSh}` : `#!/bin/sh
${electronSh}`;
  if (platform !== "win32") return { main: posix, posix };
  const electronCmd = `set ELECTRON_RUN_AS_NODE=1\r
"${execPath}" %*\r
`;
  const main = systemNode ? `@echo off\r
if not exist "${systemNode}" goto electron\r
"${systemNode}" %*\r
goto :eof\r
:electron\r
${electronCmd}` : `@echo off\r
${electronCmd}`;
  return { main, posix };
}
function findNodeOnPath(pathValue, platform = process.platform) {
  const names = platform === "win32" ? ["node.exe"] : ["node"];
  const sep = platform === "win32" ? ";" : path.delimiter;
  for (const dir of pathValue.split(sep)) {
    const d = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!d || !path.isAbsolute(d)) continue;
    for (const n of names) {
      const p = path.join(d, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const NODE_FLOOR_MAJOR = 20;
const DIST = "https://nodejs.org/dist";
function nodeMajor(version) {
  const m = /^v?(\d+)\./.exec((version ?? "").trim());
  return m ? Number(m[1]) : null;
}
function nodeIsUsable(version) {
  const major = nodeMajor(version);
  return major !== null && major >= NODE_FLOOR_MAJOR;
}
const execNodeVersion = (nodePath) => (
  require("node:child_process").execFileSync(nodePath, ["--version"], { encoding: "utf8", timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] })
);
function detectNodeVersion(nodePath, probe = execNodeVersion) {
  if (!nodePath) return null;
  try {
    const out = (probe(nodePath) || "").trim();
    return /^v?\d+\./.test(out) ? out : null;
  } catch {
    return null;
  }
}
function pickLatestLts(index) {
  return index.find((e) => e && e.lts) ?? null;
}
function nodeArtifactFor(version, platform, arch) {
  if (platform === "darwin") return { file: `node-${version}.pkg`, kind: "pkg" };
  if (platform === "win32") {
    const a = arch === "arm64" ? "arm64" : "x64";
    return { file: `node-${version}-${a}.msi`, kind: "msi" };
  }
  if (platform === "linux") {
    const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
    if (!a) return null;
    return { file: `node-${version}-linux-${a}.tar.xz`, kind: "tar" };
  }
  return null;
}

/**
 * NodeLauncher — the per-hive launcher holder. `root` is a function (the hive
 * root can arrive after construction, like the reference's hive.root()).
 */
class NodeLauncher {
  constructor(root, appendLog = () => {}) {
    this._root = root;            // () => string | null
    this._appendLog = appendLog;  // reportHookLine → hive.log (verbatim this.appendLog)
    this.systemNodeCache = void 0;
    this.systemNodeGen = -1;
    this.systemNodeSeen = null;
  }
  nodeLauncherPath() {
    const root = this._root();
    if (!root) return null;
    return path.join(root, "bin", process.platform === "win32" ? "hive-node.cmd" : "hive-node");
  }
  /** The POSIX launcher's path, on every platform. On POSIX it IS
   *  nodeLauncherPath(); on Windows it is written ALONGSIDE the .cmd, for the
   *  one hook host there that is a POSIX shell (Claude Code's Git Bash, see
   *  nodeRunSh). */
  posixLauncherPath() {
    const root = this._root();
    return root ? path.join(root, "bin", "hive-node") : null;
  }
  /** An absolute path to a real, new enough system node, or null (then the
   *  launcher is Electron only, as before). The PATH is the user's shell PATH
   *  that every agent spawn already resolves and caches, scanned as plain
   *  directories: no extra login shell on the main thread. */
  systemNode() {
    const gen = shellPathGeneration();
    if (this.systemNodeCache !== void 0 && this.systemNodeGen === gen) return this.systemNodeCache;
    let found = null;
    try {
      const pathValue = process.platform === "win32" ? process.env.PATH || "" : userShellPath();
      const node = findNodeOnPath(pathValue);
      if (this.systemNodeCache !== void 0 && node === this.systemNodeSeen) {
        this.systemNodeGen = gen;
        return this.systemNodeCache;
      }
      this.systemNodeSeen = node;
      if (node && nodeIsUsable(detectNodeVersion(node))) found = node;
    } catch {
    }
    this.systemNodeCache = found;
    this.systemNodeGen = gen;
    return found;
  }
  /** Write the node launcher again for the PATH in use now. */
  refreshNodeLauncher() {
    if (!this._root()) return;
    this.writeNodeLauncher();
  }
  /** Write the launcher described above. Best-effort: on failure callers fall
   *  back to bare `node`, i.e. exactly the pre-fix behavior. */
  writeNodeLauncher() {
    const p = this.nodeLauncherPath();
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const bodies = nodeLauncherBodies(process.execPath, this.systemNode());
      const posixBody = bodies.posix;
      if (process.platform === "win32") {
        fs.writeFileSync(p, bodies.main, "utf8");
        const posix = this.posixLauncherPath();
        if (posix) fs.writeFileSync(posix, posixBody, "utf8");
      } else {
        fs.writeFileSync(p, posixBody, "utf8");
        fs.chmodSync(p, 493);
      }
    } catch (e) {
      console.error("[hive] writeNodeLauncher failed:", e);
    }
  }
  /** The launcher path if it is actually on disk, else null (→ callers fall back
   *  to bare `node`, i.e. exactly the pre-fix behavior — never worse than before). */
  nodeLauncher() {
    const p = this.nodeLauncherPath();
    return p && fs.existsSync(p) ? p : null;
  }
  /** The ABSOLUTE bundled-node command to BAKE into any text an agent is expected
   *  to run (`<launcher> <script> …`), falling back to bare `node`. */
  nodeCommand() {
    return this.nodeLauncher() ?? "node";
  }
  /** Build a hook command string that runs `script` under the guaranteed node,
   *  DOUBLE-QUOTED (safe for paths with spaces). */
  nodeRun(script, ...args) {
    const launcher = this.nodeLauncher();
    return [launcher ? `"${launcher}"` : "node", `"${script}"`, ...args].join(" ");
  }
  /** nodeRun for a hook that a POSIX shell runs ON WINDOWS — Claude Code hosts
   *  its hooks in Git Bash there. Same shape as POSIX nodeRun (the sh launcher,
   *  double-quoted, so a space stays inside one argument) with two Windows
   *  adjustments: forward slashes, because bash treats a backslash outside
   *  quotes as an escape and Windows accepts either separator; and the POSIX
   *  launcher rather than the .cmd one, because bash runs a .cmd by handing the
   *  whole line to cmd.exe, whose `/c "A" "B"` quote stripping is exactly the
   *  failure this avoids. */
  nodeRunSh(script, ...args) {
    const fwd = (p) => p.replace(/\\/g, "/");
    const posix = this.posixLauncherPath();
    const launcher = posix && fs.existsSync(posix) ? `"${fwd(posix)}"` : `ELECTRON_RUN_AS_NODE=1 "${fwd(process.execPath)}"`;
    return [launcher, `"${fwd(script)}"`, ...args].join(" ");
  }
  /** `<root>/bin/runtime` — the dir appended to every agent's PATH. */
  runtimeBinDir() {
    const root = this._root();
    return root ? path.join(root, "bin", "runtime") : null;
  }
  /** Write the `node` runtime shim described above. Best-effort. */
  writeRuntimeShims() {
    const dir = this.runtimeBinDir();
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (process.platform === "win32") {
        fs.writeFileSync(
          path.join(dir, "node.cmd"),
          `@echo off\r
set ELECTRON_RUN_AS_NODE=1\r
"${process.execPath}" %*\r
`,
          "utf8"
        );
      } else {
        const p = path.join(dir, "node");
        fs.writeFileSync(p, `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"
`, "utf8");
        fs.chmodSync(p, 493);
      }
    } catch (e) {
      console.error("[hive] writeRuntimeShims failed:", e);
    }
  }
  /** 0.5.5 (M30-48): a `mempalace` shim beside the `node` one. */
  writeMempalaceShim(bin) {
    const dir = this.runtimeBinDir();
    if (!dir || !bin || !path.isAbsolute(bin) || !fs.existsSync(bin)) return;
    const win2 = process.platform === "win32";
    const p = path.join(dir, win2 ? "mempalace.cmd" : "mempalace");
    const body2 = win2 ? `@echo off\r
"${bin}" %*\r
` : `#!/bin/sh
exec "${bin}" "$@"
`;
    try {
      if (fs.existsSync(p) && fs.readFileSync(p, "utf8") === body2) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, body2, "utf8");
      if (!win2) fs.chmodSync(p, 493);
    } catch (e) {
      console.error("[hive] writeMempalaceShim failed:", e);
    }
  }
  /** Windows 8.3 short form of `p`, or `p` unchanged when it needs no shortening
   *  (no space), is not Windows, or the volume has 8.3 names disabled. Memoized:
   *  every resolution costs a `cmd` spawn and the same handful of paths are asked
   *  for on each agent spawn.
   *
   *  THE QUOTES COME FROM THE ENVIRONMENT, not from the command line, and that is
   *  the whole trick. `for %I in (<set>)` splits its set on spaces, so the path
   *  has to be quoted — but a `"` inside a spawn argument never reaches cmd.exe
   *  intact: Node escapes it as `\"` (MSVCRT convention) and cmd, which has no
   *  backslash escape, reads the line as garbage. Expanding `%HIVE_SHORT_SRC%`
   *  inside cmd sidesteps Node's argument escaping entirely. */
  shortPathCache = /* @__PURE__ */ new Map();
  /** Test seam: stands in for the cmd lookup below (tests have no cmd.exe). */
  shortNameLookup;
  shortenForShell(p) {
    if (process.platform !== "win32" || !p.includes(" ")) return p;
    const hit = this.shortPathCache.get(p);
    if (hit !== void 0) return hit;
    let out = p;
    try {
      const res = this.shortNameLookup ? { stdout: this.shortNameLookup(p) ?? "" } : spawnSync("cmd", ["/d", "/c", "for %I in (%HIVE_SHORT_SRC%) do @echo %~sI"], {
        encoding: "utf8",
        env: { ...process.env, HIVE_SHORT_SRC: `"${p}"` }
      });
      const short = (res.stdout ?? "").trim();
      if (short && !short.includes(" ") && (this.shortNameLookup || fs.existsSync(short))) out = short;
    } catch {
    }
    this.shortPathCache.set(p, out);
    return out;
  }
  /** A provider's hook line on Windows: UNQUOTED, for shells that cannot keep
   *  embedded quotes (cmd and PowerShell as the providers drive them). POSIX
   *  JSON hook configs must use nodeRun(), because the user chosen hive path may
   *  legitimately contain spaces.
   *
   *  On Windows the paths are first reduced to their 8.3 SHORT form, because
   *  unquoted is only safe while nothing contains a space, and the DEFAULT
   *  harness home does: `Documents\OzyComp`. With no short name,
   *  windowsHookLine picks the PATH wrapper or reports the line (plan F). */
  nodeRunWindowsHook(provider, pathProven, script, ...args) {
    return this.windowsHookLine(provider, this.nodeLauncher() ?? "node", script, args, pathProven);
  }
  /** The hook command line for a provider whose hooks run under cmd or
   *  PowerShell on Windows (plan F, T1 to T3). The line must have no quote and
   *  no space: PowerShell `-Command` parses a line that starts with a quoted
   *  string as an expression, and fails every hook with exit 1.
   *   1. Short (8.3) names for both paths: the tested shape, used whenever it works.
   *   2. No short name, and the provider's hooks provably see the agent's PATH:
   *      a small `md-hook-<hash>.cmd` in `<hive root>\bin\runtime` (already on
   *      every agent's PATH, pty.ts withHiveRuntimeFallback) that runs the quoted
   *      paths itself. The hook line is then its bare name.
   *   3. Otherwise the quoted line stays and the person is told once per launch,
   *      with the path and the fix. It is not a working line: PowerShell rejects
   *      it, and `cmd /c` strips its outer quotes (windows-hook-shortpath). It is
   *      only the least wrong thing to write. */
  windowsHookLine(provider, launcher, script, args, pathProven) {
    const l = this.shortenForShell(launcher);
    const s = this.shortenForShell(script);
    if (!/\s/.test(l) && !/\s/.test(s)) return joinCommandLine([l, s, ...args]);
    const spaced = /\s/.test(l) ? launcher : script;
    const wrapper = pathProven && hookWrapperSafe(launcher) && hookWrapperSafe(script) ? this.writeHookWrapper(launcher, script) : null;
    if (wrapper) {
      this.reportHookLine("hook-command-wrapper", provider, spaced);
      return joinCommandLine([wrapper, ...args]);
    }
    this.reportHookLine("hook-command-unrunnable", provider, spaced);
    return joinCommandLine([l, s, ...args]);
  }
  /** Write `<runtime>\md-hook-<hash>.cmd`, which runs `launcher script %*`.
   *  Quotes are safe INSIDE a .cmd file: cmd parses its own file, no shell stack
   *  in between. `%` is doubled, or cmd would expand `100% done` as a variable.
   *  Only called for paths hookWrapperSafe accepts. Named by a hash of both
   *  paths, so each target gets one stable file and nothing another floor wrote
   *  is overwritten. Returns the bare name, or null when it cannot be written
   *  (the caller then reports). */
  writeHookWrapper(launcher, script) {
    const dir = this.runtimeBinDir();
    if (!dir) return null;
    try {
      const name = `md-hook-${crypto.createHash("sha256").update(`${launcher}\u0000${script}`).digest("hex").slice(0, 8)}`;
      const file = path.join(dir, `${name}.cmd`);
      const body2 = hookWrapperBody(launcher, script);
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== body2) fs.writeFileSync(file, body2, "utf8");
      return name;
    } catch (e) {
      console.error("[hive] writeHookWrapper failed:", e);
      return null;
    }
  }
  /** Hook command problems already reported this launch (kind|provider|path). */
  hookLineReported = /* @__PURE__ */ new Set();
  /** provider → path → the notice that provider's next spawn carries
   *  (ensureAgent `degraded`). By path too, so a second path is not lost. */
  hookLineNotices = /* @__PURE__ */ new Map();
  /** When each memory.md notice (`<id>:rules`, `<id>:sort`) last rode in a
   *  spawn prompt: each at most once a day per agent. In memory only, so an
   *  app restart may give one again sooner. */
  memoryNoticeAt = /* @__PURE__ */ new Map();
  reportHookLine(kind, provider, path2, appendLog = this._appendLog) {
    const key = `${kind}|${provider}|${path2}`;
    if (this.hookLineReported.has(key)) return;
    this.hookLineReported.add(key);
    appendLog({ kind, provider, path: path2 });
    if (kind === "hook-command-wrapper") {
      console.warn(`[hive] no 8.3 short name for ${path2}; ${provider} hooks run through a PATH wrapper`);
      return;
    }
    console.error(`[hive] no 8.3 short name for ${path2}; ${provider} hooks cannot run`);
    if (!this.hookLineNotices.has(provider)) this.hookLineNotices.set(provider, /* @__PURE__ */ new Map());
    this.hookLineNotices.get(provider).set(path2, `${provider} hooks cannot run on this computer: the path ${path2} has a space and Windows has no short name for it. Live status, cost and the inbox wake will not work for ${provider} agents. ` + (/[^\x20-\x7e]/.test(path2) ? "Fix: move the hive home to a folder whose path has only plain English letters and no space, in Settings." : "Fix: move the hive home to a folder with no space in Settings, or turn on short (8.3) names for that drive."));
  }
  /** The notices for a provider's hooks, once: the first spawn after they were found. */
  takeHookLineNotice(provider) {
    const notices = this.hookLineNotices.get(provider);
    if (!notices || notices.size === 0) return void 0;
    this.hookLineNotices.delete(provider);
    return [...notices.values()].join(" ");
  }
  /** Remove hook wrappers whose launcher or script is gone (gate of #190, W5).
   *  One is written per target, and Gemini's target is per agent, so without
   *  this every retired Gemini agent and temp would leave one for good. Run
   *  once per launch; a wrapper still in use is rewritten on the next spawn
   *  anyway. Reads only files named md-hook-*.cmd, and only its own shape. */
  sweepHookWrappers() {
    const dir = this.runtimeBinDir();
    if (!dir || !fs.existsSync(dir)) return;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^md-hook-[0-9a-f]{8}\.cmd$/.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const targets = hookWrapperTargets(fs.readFileSync(file, "utf8"));
        if (!targets || targets.every((t) => fs.existsSync(t))) continue;
        fs.unlinkSync(file);
      } catch {
      }
    }
  }
  /**
   * The FLOOR INDEPENDENT home of the hook shims that live in a user's GLOBAL
   * CLI config (agy's `~/.gemini/…/hooks.json`, Grok's `~/.grok/hooks/`). Set by
   * the main process to `app.getPath('appData')/ozycomp/shared/bin`;
   * hive.ts deliberately does not import electron. null (tests, headless) keeps
   * the legacy per floor path. */
  _sharedBinDir = null;
  setSharedBinDir(dir) {
    this._sharedBinDir = dir;
  }
  sharedBinDir() {
    return this._sharedBinDir;
  }
  /** The launcher text `writeNodeLauncher` bakes: it carries process.execPath,
   *  so it is part of the bundle hash (a moved or updated app gets a new bundle
   *  rather than overwriting the one a still running floor is using). */
  nodeLauncherText() {
    return process.platform === "win32" ? `@echo off\r
set ELECTRON_RUN_AS_NODE=1\r
"${process.execPath}" %*\r
` : `#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"
`;
  }
  /**
   * Write the shared shim bundle (both global config shims plus the bundled
   * node launcher they run under) into the shared bin under ONE content hashed
   * directory and return the paths a hook command for `name` should name.
   * Idempotent: an identical bundle is left untouched, a different text lands
   * in a new directory, nothing is ever deleted. null when no shared dir is
   * configured or the write failed, and the caller stays on the legacy per
   * floor paths (exactly the pre fix behaviour).
   */
  installSharedShim(name, files = null) {
    const base = this._sharedBinDir;
    if (!base) return null;
    try {
      const launcherName = process.platform === "win32" ? "hive-node.cmd" : "hive-node";
      // verbatim ~7815: the default bundle is BOTH global-config shims + the
      // launcher. `files` is an optional override for tests / future providers.
      const { AGY_HOOK_SHIM, GROK_HOOK_SHIM } = files == null ? require('./hook-shims') : {};
      const bundle = {
        [launcherName]: this.nodeLauncherText(),
        ...(files ?? { "agy-hook.cjs": AGY_HOOK_SHIM, "grok-hook.cjs": GROK_HOOK_SHIM }),
      };
      const dir = path.join(base, shimBundleHash(bundle));
      fs.mkdirSync(dir, { recursive: true });
      for (const [file, body2] of Object.entries(bundle)) {
        const p = path.join(dir, file);
        let current2 = null;
        if (fs.existsSync(p)) {
          try {
            current2 = fs.readFileSync(p, "utf8");
          } catch {
            current2 = null;
          }
        }
        if (current2 !== body2) fs.writeFileSync(p, body2, "utf8");
        if (file === launcherName && process.platform !== "win32") fs.chmodSync(p, 493);
      }
      return { shim: path.join(dir, name), launcher: path.join(dir, launcherName) };
    } catch (e) {
      console.error("[hive] installSharedShim failed:", e);
      return null;
    }
  }
}

module.exports = {
  joinCommandLine, hookWrapperSafe, hookWrapperBody, hookWrapperTargets,
  shimBundleHash, MAX_CRASH_LOGS, pruneCrashLogs,
  nodeLauncherBodies, findNodeOnPath, NODE_FLOOR_MAJOR, DIST,
  nodeMajor, nodeIsUsable, detectNodeVersion, pickLatestLts, nodeArtifactFor,
  NodeLauncher,
};
