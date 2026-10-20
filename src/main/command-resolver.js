'use strict';
/**
 * Command resolution + login-shell PATH — verbatim port of the reference.
 * A packaged app starts with a stub PATH (no Homebrew, no ~/.local/bin), so
 * the user's real login shell is read once, cached, and retried on failure;
 * command names resolve against it first and the well-known bin dirs second.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile, spawnSync } = require('node:child_process');

let shellPath = null;
let reading = null;
let readFailed = false;
let retryTimer = null;
let retryCount = 0;
let generation = 0;
let shellsStarted = 0;
let readsStarted = 0;
const SHELL_PATH_LIMIT_MS = 1e4;
const RETRY_DELAYS_MS = [5e3, 3e4, 12e4];
const FENCE = "__MD_SHELL_FENCE__";
let limitMs = SHELL_PATH_LIMIT_MS;
let retryDelaysMs = RETRY_DELAYS_MS;
function readFromLoginShell(script, timeoutMs = limitMs) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timer2 = null;
    const fenced = () => {
      const start2 = output.indexOf(FENCE);
      const end = output.lastIndexOf(FENCE);
      return start2 < 0 || end <= start2 ? null : output.slice(start2 + FENCE.length, end);
    };
    const finish2 = (value) => {
      if (settled) return;
      settled = true;
      if (timer2) clearTimeout(timer2);
      resolve(value);
    };
    let child;
    try {
      shellsStarted++;
      child = spawn(
        process.env.SHELL ?? "/bin/zsh",
        ["-ilc", `printf %s ${FENCE}; ${script}; printf %s ${FENCE}`],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch {
      resolve(null);
      return;
    }
    timer2 = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      } catch {
      }
      finish2(null);
    }, timeoutMs);
    timer2.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      const value = fenced();
      if (value !== null) finish2(value);
    });
    child.stderr?.resume();
    child.on("error", () => finish2(null));
    child.on("close", () => finish2(fenced()));
  });
}
function fallbackShellPath(env = process.env) {
  const seen = new Set();
  const out = [];
  for (const dir of [...(env.PATH ?? "").split(path.delimiter), ...commonBinDirs(env.HOME ?? "")]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out.join(path.delimiter);
}
function scheduleRetry() {
  if (retryTimer || retryCount >= retryDelaysMs.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryCount++;
    const mine = ++readsStarted;
    void readShellPathOnce().then((value) => {
      if (mine !== readsStarted) return;
      if (value === null) {
        scheduleRetry();
        return;
      }
      land(value);
    });
  }, retryDelaysMs[retryCount]);
  retryTimer.unref?.();
}
function land(value) {
  readFailed = false;
  retryCount = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (shellPath !== value) generation++;
  shellPath = value;
}
async function readShellPathOnce() {
  const value = (await readFromLoginShell('printf %s "$PATH"'))?.trim();
  return value && !value.includes("\n") ? value : null;
}
function startRead() {
  const seq = ++readsStarted;
  const mine = readShellPathOnce().then((value) => {
    const current2 = seq === readsStarted;
    if (reading === mine) reading = null;
    if (value !== null) {
      if (current2 || shellPath === null) land(value);
      return shellPath ?? value;
    }
    if (!current2) return shellPath ?? fallbackShellPath();
    if (!readFailed) {
      console.error(`[shell] the login shell gave no PATH within ${limitMs / 1e3} s; agents start with the fallback PATH, and the read is tried again in the background`);
    }
    readFailed = true;
    scheduleRetry();
    return shellPath ?? fallbackShellPath();
  });
  reading = mine;
  return mine;
}
function shellPathReady() {
  if (process.platform === "win32") return Promise.resolve(process.env.PATH || "");
  if (reading) return reading;
  if (shellPath !== null) return Promise.resolve(shellPath);
  if (readFailed) return Promise.resolve(fallbackShellPath());
  return startRead();
}
function refreshShellPath() {
  if (process.platform === "win32") return Promise.resolve(process.env.PATH || "");
  if (reading) return reading;
  readFailed = false;
  retryCount = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  return startRead();
}
function forgetShellLookups() {
  generation++;
  if (process.platform === "win32") return;
  readFailed = false;
  retryCount = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  void startRead();
}
function shellPathGeneration() {
  return generation;
}
function commonBinDirs(home) {
  return ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.claude/local`, `${home}/.volta/bin`, `${home}/.kimi-code/bin`, `${home}/.grok/bin`];
}
function userShellPath() {
  if (process.platform === "win32") return process.env.PATH || "";
  if (shellPath !== null) return shellPath;
  if (!reading && !readFailed) void startRead();
  return fallbackShellPath();
}
function findCommandOnPath(command, pathValue) {
  if (!isSafeCommandName(command)) return null;
  for (const raw of pathValue.split(path.delimiter)) {
    const dir = raw.trim();
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, command);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
}
function isSafeCommandName(command) {
  return /^[A-Za-z0-9._+-]+$/.test(command);
}
const WINDOWS_FALLBACK_LOCATIONS = [
  {
    commands: ["agy"],
    root: "LOCALAPPDATA",
    segments: ["agy", "bin", "agy.exe"]
  }
];
function isAbsoluteWindowsPathWithVolume(path$1) {
  if (!path.win32.isAbsolute(path$1)) return false;
  const root = path.win32.parse(path$1).root;
  return root !== "\\" && root !== "/";
}
function windowsFallbackCandidates(command, env = process.env) {
  const appData = env.APPDATA ?? "";
  const localAppData = env.LOCALAPPDATA ?? "";
  const home = env.USERPROFILE ?? env.HOME ?? "";
  const candidates = [
    `${appData}\\npm\\${command}.cmd`,
    `${appData}\\npm\\${command}`,
    `${localAppData}\\Programs\\claude\\${command}.exe`,
    `${home}\\.claude\\local\\${command}.cmd`,
    `${home}\\.claude\\local\\${command}`
  ];
  const normalizedCommand = command.replace(/\.exe$/i, "").toLowerCase();
  for (const location of WINDOWS_FALLBACK_LOCATIONS) {
    if (!location.commands.includes(normalizedCommand)) continue;
    const root = env[location.root];
    if (!root || !isAbsoluteWindowsPathWithVolume(root)) continue;
    candidates.push(path.win32.join(root, ...location.segments));
  }
  return candidates;
}
function whereAsync(command) {
  return new Promise((resolve) => {
    execFile("where", [command], { encoding: "utf8", timeout: 3e3 }, (_error, stdout) => {
      const resolvedPath = String(stdout ?? "").trim().split(/\r?\n/)[0];
      resolve(resolvedPath && fs.existsSync(resolvedPath) ? resolvedPath : null);
    });
  });
}
async function resolveCommands(commands) {
  const names = [...new Set(commands.filter((command) => isSafeCommandName(command)))];
  const found = new Map(names.map((command) => [command, null]));
  if (names.length === 0) return found;
  if (process.platform === "win32") {
    const paths = await Promise.all(names.map(whereAsync));
    names.forEach((command, i) => found.set(command, paths[i]));
  } else {
    const pathValue = await refreshShellPath();
    for (const command of names) found.set(command, findCommandOnPath(command, pathValue));
  }
  for (const command of names) {
    if (found.get(command)) continue;
    const candidates = process.platform === "win32" ? windowsFallbackCandidates(command) : commonBinDirs(process.env.HOME ?? "").map((d) => `${d}/${command}`);
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        found.set(command, candidate);
        break;
      }
    }
  }
  return found;
}
function resolveCommand(command) {
  if (command.includes("/") || command.includes("\\")) return command;
  if (!isSafeCommandName(command)) return command;
  if (process.platform === "win32") {
    try {
      const res = spawnSync("where", [command], { encoding: "utf8", timeout: 3e3 });
      const path2 = (res.stdout ?? "").trim().split(/\r?\n/)[0];
      if (path2 && fs.existsSync(path2)) return path2;
    } catch {
    }
    const winCandidates = windowsFallbackCandidates(command);
    for (const c of winCandidates) if (fs.existsSync(c)) return c;
    return command;
  }
  const onPath = findCommandOnPath(command, userShellPath());
  if (onPath) return onPath;
  const candidates = commonBinDirs(process.env.HOME ?? "").map((d) => `${d}/${command}`);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return command;
}
function withHiveRuntimeFallback(path$1, hiveRoot) {
  if (!hiveRoot) return path$1;
  const dir = path.join(hiveRoot, "bin", "runtime");
  if (!fs.existsSync(dir)) return path$1;
  const entries = path$1.split(path.delimiter).filter(Boolean);
  if (entries.includes(dir)) return path$1;
  return [...entries, dir].join(path.delimiter);
}

module.exports = {
  isSafeCommandName, commonBinDirs, windowsFallbackCandidates,
  findCommandOnPath, userShellPath, fallbackShellPath,
  readFromLoginShell, shellPathReady, refreshShellPath, forgetShellLookups,
  shellPathGeneration, resolveCommand, resolveCommands, whereAsync,
  withHiveRuntimeFallback,
};
