'use strict';
/**
 * Codex remote control + resume-home discovery — verbatim port of the
 * reference. A codex agent gets a per-agent CODEX_HOME; remote control needs
 * the app-server daemon's unix socket, whose path must fit sun_path (104B),
 * so the real home is aliased under /tmp/mdc/<hash>. On resume, the agent
 * whose CODEX_HOME holds the session's rollout file wins the session.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveCommand } = require('./command-resolver');
const { codexWritableRootsToml } = require('./provider-bridges');

const CODEX_REMOTE_SOCKET_RELATIVE = "app-server-control/app-server-control.sock";
const CODEX_REMOTE_ALIAS_ROOT = "/tmp/mdc";
const CODEX_REMOTE_SOCKET_MAX = 104;
function codexRemoteAliasPath(realHome, agentId, tempRoot = CODEX_REMOTE_ALIAS_ROOT) {
  const digest = crypto.createHash("sha256").update(`${realHome}\0${agentId}`).digest("hex").slice(0, 8);
  return path.join(tempRoot, digest);
}
function codexRemoteSocketFits(shortHome) {
  return path.join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE).length < CODEX_REMOTE_SOCKET_MAX;
}
function codexRemoteEndpoint(shortHome) {
  return `unix://${path.join(shortHome, CODEX_REMOTE_SOCKET_RELATIVE)}`;
}
function splitCodexAddDirs(args) {
  const out = [];
  const dirs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--add-dir" && i + 1 < args.length) {
      dirs.push(args[++i]);
      continue;
    }
    if (a.startsWith("--add-dir=")) {
      dirs.push(a.slice("--add-dir=".length));
      continue;
    }
    out.push(a);
  }
  return { args: out, dirs };
}
function withCodexRemoteArgs(args, endpoint) {
  const rest = splitCodexAddDirs(args).args;
  if (rest.includes("--remote")) return rest;
  return ["--remote", endpoint, ...rest];
}
function runCodexDaemonCommand(executable, args, env, timeoutMs = 2e4) {
  return new Promise((resolveResult) => {
    let settled = false;
    let stderr = "";
    let child;
    try {
      child = spawn(executable, args, {
        env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true
      });
    } catch (e) {
      resolveResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let timer2;
    const finish2 = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer2);
      resolveResult(result);
    };
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 8e3) stderr += String(chunk);
    });
    child.once("error", (e) => finish2({ ok: false, error: e.message }));
    child.once("exit", (code) => {
      finish2(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `Codex exited with code ${code ?? "unknown"}` });
    });
    timer2 = setTimeout(() => {
      try {
        child.kill();
      } catch {
      }
      finish2({ ok: false, error: `Codex daemon command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
  });
}
async function enableCodexRemoteForSpawn(opts, agentId) {
  if (process.platform === "win32") return false;
  const realHome = opts.env?.CODEX_HOME;
  if (!realHome) return false;
  try {
    const alias = codexRemoteAliasPath(realHome, agentId);
    if (!codexRemoteSocketFits(alias)) {
      console.warn("[codex-remote] socket path exceeds sun_path; starting local TUI:", alias);
      return false;
    }
    const aliasRoot = path.dirname(alias);
    fs.mkdirSync(aliasRoot, { recursive: true });
    if (fs.existsSync(alias)) {
      const st = fs.lstatSync(alias);
      if (!st.isSymbolicLink() || path.resolve(path.dirname(alias), fs.readlinkSync(alias)) !== path.resolve(realHome)) {
        console.warn("[codex-remote] short home alias is occupied; starting local TUI:", alias);
        return false;
      }
    } else {
      fs.symlinkSync(realHome, alias, "dir");
    }
    const { dirs } = splitCodexAddDirs(opts.args ?? []);
    if (dirs.length > 0) {
      const configPath2 = path.join(realHome, "config.toml");
      const toml = fs.existsSync(configPath2) ? fs.readFileSync(configPath2, "utf8") : "";
      const next = codexWritableRootsToml(toml, dirs);
      if (next === null) {
        console.warn("[codex-remote] config.toml sets writable_roots itself; starting local TUI");
        return false;
      }
      fs.writeFileSync(configPath2, next, "utf8");
    }
    const socket = path.join(alias, CODEX_REMOTE_SOCKET_RELATIVE);
    const env = {
      ...process.env,
      ...opts.env ?? {},
      CODEX_HOME: alias
    };
    const executable = resolveCommand(opts.command);
    const started2 = await runCodexDaemonCommand(
      executable,
      ["app-server", "daemon", "start"],
      env
    );
    if (!started2.ok) {
      console.warn("[codex-remote] daemon start failed; starting local TUI:", started2.error);
      return false;
    }
    const enabled = await runCodexDaemonCommand(
      executable,
      ["app-server", "daemon", "enable-remote-control"],
      env
    );
    if (!enabled.ok) {
      console.warn("[codex-remote] enable failed; starting local TUI:", enabled.error);
      return false;
    }
    if (!fs.existsSync(socket)) {
      console.warn("[codex-remote] daemon returned without a control socket; starting local TUI");
      return false;
    }
    opts.env = { ...opts.env ?? {}, CODEX_HOME: alias };
    opts.args = withCodexRemoteArgs(opts.args ?? [], codexRemoteEndpoint(alias));
    return true;
  } catch (e) {
    console.warn(
      "[codex-remote] setup failed; starting local TUI:",
      e instanceof Error ? e.message : e
    );
    return false;
  }
}

/**
 * Which sibling agent's CODEX_HOME owns `sessionId`'s rollout? A codex agent
 * gets its own CODEX_HOME under <agentsRoot>/<id>/.codex; when a session is
 * resumed under a DIFFERENT agent the rollout (and the state_5 index entry)
 * still lives in the original home — find it so the resume can point
 * CODEX_HOME back at the owner.
 */
function findCodexHomeForSession(sessionId, siblingsRoot) {
  try {
    if (!sessionId || !/^[0-9a-fA-F][0-9a-fA-F-]{15,}$/.test(sessionId)) return null;
    let fallbackHome = null;
    let agents;
    try {
      agents = fs.readdirSync(siblingsRoot, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const home = path.join(siblingsRoot, a.name, ".codex");
      const sessions = path.join(home, "sessions");
      if (!fs.existsSync(sessions)) continue;
      const stack = [sessions];
      let hasRollout = false;
      while (stack.length && !hasRollout) {
        const d = stack.pop();
        let ents;
        try {
          ents = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of ents) {
          const pth = path.join(d, e.name);
          if (e.isDirectory()) stack.push(pth);
          else if (e.isFile() && e.name.endsWith(".jsonl") && e.name.includes(sessionId)) {
            hasRollout = true;
            break;
          }
        }
      }
      if (!hasRollout) continue;
      const idBuf = Buffer.from(sessionId);
      let indexed = false;
      for (const db of ["state_5.sqlite", "state_5.sqlite-wal"]) {
        try {
          if (fs.readFileSync(path.join(home, db)).includes(idBuf)) {
            indexed = true;
            break;
          }
        } catch {
        }
      }
      if (indexed) return home;
      if (!fallbackHome) fallbackHome = home;
    }
    return fallbackHome;
  } catch (e) {
    console.error("[resume] findCodexHomeForSession failed:", e);
    return null;
  }
}

// ─── grok theme env ──────────────────────────────────────────────────────────

const GROK_LIGHT_THEME = "grokday";
const GROK_DARK_THEME = "groknight";
function grokConfiguredTheme(configToml) {
  let inUi = false;
  for (const raw of (configToml ?? "").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (table) {
      inUi = table[1] === "ui";
      continue;
    }
    if (!inUi) continue;
    const kv = /^theme\s*=\s*(?:"([^"]*)"|'([^']*)')$/.exec(line);
    if (kv) return (kv[1] ?? kv[2] ?? "").trim().toLowerCase() || null;
  }
  return null;
}
function grokThemeEnv(appTheme, configToml, existingEnvTheme) {
  if (!appTheme) return void 0;
  if (existingEnvTheme && existingEnvTheme.trim()) return void 0;
  const chosen = grokConfiguredTheme(configToml);
  if (chosen && chosen !== "auto" && chosen !== "system") return void 0;
  return appTheme === "dark" ? GROK_DARK_THEME : GROK_LIGHT_THEME;
}
function readGrokConfigToml(env = process.env, home = os.homedir()) {
  try {
    return fs.readFileSync(path.join(env.GROK_HOME || path.join(home, ".grok"), "config.toml"), "utf8");
  } catch {
    return null;
  }
}

module.exports = {
  CODEX_REMOTE_SOCKET_RELATIVE, CODEX_REMOTE_ALIAS_ROOT, CODEX_REMOTE_SOCKET_MAX,
  codexRemoteAliasPath, codexRemoteSocketFits, codexRemoteEndpoint,
  splitCodexAddDirs, withCodexRemoteArgs, runCodexDaemonCommand,
  enableCodexRemoteForSpawn, findCodexHomeForSession,
  GROK_LIGHT_THEME, GROK_DARK_THEME, grokConfiguredTheme, grokThemeEnv, readGrokConfigToml,
};
