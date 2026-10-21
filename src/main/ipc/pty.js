'use strict';
/**
 * pty:* + terminal:probe:* IPC surface — verbatim port of the reference
 * index.js blocks ~34425-34905 plus the helper stack they close over:
 *
 *   pty:spawn → spawnAgentCore  (the one true spawn path: missing-CLI card,
 *     guided setup, worktree isolation, hive ensureAgent, claude/codex resume,
 *     provider env, integration-broker grants, telemetry + analytics)
 *   pty:loginAct / pty:installCli / pty:cliMissingState / pty:cliSetupState /
 *   pty:cliSetupStart / pty:cliSetupManual / pty:cliSetupLogin /
 *   pty:write / pty:resize / pty:redraw / pty:kill / pty:list / pty:submit
 *   terminal:probe:reply
 *
 * State the reference keeps as module globals lives on ctx (shared with the
 * other ipc groups): ctx.ptyOwners, ctx.ptyToAgent, ctx.pendingCliMissing,
 * ctx.pendingCliSetup, ctx.pendingInstallRelaunch, ctx.agentRuns,
 * ctx.liveWorkers, ctx.preservedWorktrees, ctx.worktreePaths,
 * ctx.worktreeOrigins, ctx.worktreeBases, ctx.worktreeFinalizing,
 * ctx.loginWatcher, ctx.terminalProbes, ctx.ptySubmitter.
 *
 * The PTY manager itself is the verbatim reference one (sessions/wanted/env
 * build/shim decode/output coalescing/reaper); see ./pty-manager.js for the
 * pre-existing thinner clone — this file installs the verbatim behaviour via
 * the same `ctx.harness.pty` object the rest of the app already holds, adding
 * only the methods that manager lacks.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

const { expandTilde, effectiveMcp, sanitizeAgentMcp } = require('../config');
const {
  isSafeCommandName, commonBinDirs, windowsFallbackCandidates,
  findCommandOnPath, userShellPath, forgetShellLookups, shellPathGeneration,
  shellPathReady, resolveCommand, withHiveRuntimeFallback,
} = require('../command-resolver');
const {
  providerPreset, isClaudeProvider, inferAgentProvider,
} = require('../provider-presets');
const {
  pickResumableSession, providerSessionStore, chooseResumeSession,
} = require('../session-resume');
const {
  enableCodexRemoteForSpawn, findCodexHomeForSession,
} = require('../codex-remote');
const { linkWorktreeDeps, unlinkWorktreeDeps } = require('../worktree-deps');
const {
  getBranch, isRepo, addWorktree, removeWorktree, worktreeHasUnintegratedWork,
} = require('./git');
const {
  PtySubmitter, TerminalProbes, initialWindowVisibility,
} = require('../pty-submit');
const { slowSpawnDelayMs } = require('../terminal-text');
const ib = require('../integration-broker');

// ── verbatim constants ────────────────────────────────────────────────────
const TAIL_MAX = 64 * 1024;
const OUTPUT_FLUSH_MS = 16;
const OUTPUT_FLUSH_BYTES = 64 * 1024;
const REDRAW_STEP_MS = 80;
const KILL_GRACE_MS = 4e3;
const NODE_FLOOR_MAJOR = 18;
const DIST = 'https://nodejs.org/dist';
const SIGNIN_POLL_MS = 3e3;
const SIGNIN_CHECK_TIMEOUT_MS = 1e4;
const EARLY_EXIT_MS = 6e4;
const WATCH_MS = 5 * 60 * 1e3;
const RESPAWNING = ['restart', 'revive'];
const SUBMIT_SOURCES = new Set(['queue', 'seed', 'god-boot', 'remote-control']);
const CLAUDE_MARKER_RE = /^(CLAUDE_|ANTHROPIC_|OZYC_)/;
const CLAUDE_CONFIG_KEEP = new Set(['CLAUDE_CONFIG_DIR']);
const VALID_SESSION_ID = /^[0-9a-f-]{8,}$/i;

const STATUS_ARGS = {
  claude: ['auth', 'status'],
  codex: ['login', 'status'],
  cursor: ['status'],
};
const LOGIN_ARGS = {
  claude: ['auth', 'login'],
  codex: ['login'],
  copilot: ['login'],
  grok: ['login'],
  kimi: ['login'],
  cursor: ['login'],
  opencode: ['auth', 'login'],
};
const LOGIN_HOSTS = {
  claude: ['claude.ai', 'console.anthropic.com', 'platform.claude.com'],
  codex: ['auth.openai.com', 'chatgpt.com', 'platform.openai.com'],
  grok: ['accounts.x.ai', 'auth.x.ai', 'x.ai'],
  kimi: ['kimi.ai', 'kimi.com'],
  gemini: ['accounts.google.com'],
  antigravity: ['accounts.google.com', 'antigravity.google'],
  qwen: ['chat.qwen.ai', 'qwen.ai'],
  opencode: ['claude.ai', 'console.anthropic.com', 'github.com', 'opencode.ai'],
  crush: ['github.com', 'charm.land'],
  pi: ['claude.ai', 'auth.openai.com', 'github.com', 'accounts.google.com'],
  copilot: ['github.com'],
  cursor: ['cursor.com', 'authenticator.cursor.sh'],
  custom: [],
};
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/g;
const LOGIN_CONTEXT = /\b(sign in|signin|log in|login|logged in|authoriz|authent|device code|one[- ]time code|user_code|api key|paste (the|this) code|enter (the |this )?code)\b/i;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_RE = new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]|' + ESC + '\\][^' + BEL + ']*' + BEL, 'g');
const AUTH_FAILURE_RES = [
  /no authentication information found/i,
  /\bnot (logged|signed) in\b/i,
  /\bplease (log ?in|sign ?in|login|authenticate)\b/i,
  /\b(run|use|try) [`'"]?[\w./-]+ (auth )?(login|signin)\b/i,
  /\bnot authenticated\b/i,
  /\bauthentication (is )?required\b/i,
  /\b401\b.*unauthori[sz]ed|unauthori[sz]ed.*\b401\b/i,
  /\b(invalid|missing|no) (api[ _-]?key|auth(entication)? token)\b/i,
  /\bapi[ _-]?key (is )?(not set|required|missing)\b/i,
];
const SUCCESS = /\b(logged in|login successful|successfully (logged|signed) in|signed in as|authentication (complete|successful)|authenticated as|login complete|you are now logged in|you're all set|welcome back)\b/i;
const FAILURE = /\b(login failed|authentication failed|authorization failed|code (has )?expired|token expired|access denied|login (was )?cancell?ed|could not (log|sign) in|not authorized|invalid (code|token|api key))\b/i;
const SAFE_BIN_RE = /[^A-Za-z0-9._-]/g;

// ── verbatim helpers ──────────────────────────────────────────────────────
function stripAnsi(s) { return s.replace(ANSI_RE, '').replace(/\r/g, '\n'); }
function validCell(n) { return typeof n === 'number' && Number.isInteger(n) && n >= 2 ? n : undefined; }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function forceClosePty(proc, platform = process.platform) {
  if (platform === 'win32') return;
  try { proc.destroy?.(); } catch {}
}
function hardKillTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 1e4 }); } catch {}
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); }
  catch { try { process.kill(pid, 'SIGKILL'); } catch {} }
}
function groupMembers(pgid) {
  try {
    const r = spawnSync('ps', ['-axo', 'pid=,pgid=,lstart='], { timeout: 2e3 });
    if (r.error || r.status !== 0) return null;
    const out = new Map();
    for (const line of String(r.stdout ?? '').split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+\S)\s*$/);
      if (m && Number(m[2]) === pgid) out.set(Number(m[1]), m[3]);
    }
    return out;
  } catch { return null; }
}
function shouldSweep(before, after) {
  if (before === null || after === null) return true;
  if (after.size === 0) return false;
  for (const [pid, started] of after) {
    if (before.get(pid) === started) return true;
  }
  return false;
}
function ensureKilled(pid, graceMs = KILL_GRACE_MS) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const t = setTimeout(() => hardKillTree(pid), graceMs);
    t.unref?.();
    return;
  }
  const before = groupMembers(pid);
  const t = setTimeout(() => { if (shouldSweep(before, groupMembers(pid))) hardKillTree(pid); }, graceMs);
  t.unref?.();
}
function buildPtyEnv(parentEnv, userPath, agentEnv, platform = process.platform) {
  const inherited = {};
  const fromNpmRun = typeof parentEnv.npm_lifecycle_event === 'string';
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined) continue;
    if (CLAUDE_MARKER_RE.test(k) && !CLAUDE_CONFIG_KEEP.has(k)) continue;
    if (fromNpmRun && (/^npm_/.test(k) || k === 'INIT_CWD')) continue;
    if (platform === 'win32' && k.toLowerCase() === 'path') continue;
    inherited[k] = v;
  }
  return {
    ...inherited,
    PATH: userPath,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
    ...platform === 'win32' ? {} : {
      LANG: parentEnv.LANG ?? 'en_US.UTF-8',
      LC_CTYPE: parentEnv.LC_ALL ?? parentEnv.LC_CTYPE ?? parentEnv.LANG ?? 'en_US.UTF-8',
    },
    ...agentEnv ?? {},
  };
}
function buildCmdCommandLine(resolved, args) {
  const quoteToken = (s) => {
    const escaped = s.replace(/"/g, '\\"');
    return /[ \t"&|^<>()%!]/.test(s) ? `"${escaped}"` : escaped;
  };
  const inner = [resolved, ...args].map(quoteToken).join(' ');
  return `/d /s /c "${inner}"`;
}
const SHIM_INTERPRETERS = new Set(['node', 'bun', 'deno']);
const SHIM_SCRIPT_EXT = /\.(?:c|m)?js$/i;
function parseNpmCmdShim(shimPath, content) {
  if (typeof shimPath !== 'string' || typeof content !== 'string') return null;
  if (!shimPath || !content) return null;
  if (content.length > 8192 || content.includes('')) return null;
  const dir = path.win32.dirname(shimPath);
  if (!dir || dir === '.') return null;
  const expand = (raw) => {
    let s = raw.replace(/%~dp0%?|%dp0%/gi, `${dir}\\`);
    if (s.includes('%')) return null;
    if (!s.trim()) return null;
    const unc = /^[\\/]{2}/.test(s);
    s = s.replace(/[\\/]+/g, '\\');
    if (unc) s = `\\${s}`;
    if (!path.win32.isAbsolute(s)) return null;
    return path.win32.normalize(s);
  };
  const progValues = [];
  for (const m of content.matchAll(/^\s*@?SET\s+"?_prog=([^"\r\n]*)"?/gim)) progValues.push(m[1]);
  const lines = content.split(/\r?\n/);
  let execLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('%*')) { execLine = lines[i]; break; }
  }
  if (!execLine) return null;
  const head = execLine.slice(0, execLine.lastIndexOf('%*'));
  const quoted = [...head.matchAll(/"([^"]*)"/g)].map((m) => ({ text: m[1], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  if (quoted.length === 0) return null;
  const scriptTok = quoted[quoted.length - 1];
  let progRaw;
  if (quoted.length >= 2) {
    const progTok = quoted[quoted.length - 2];
    if (head.slice(progTok.end, scriptTok.start).trim() !== '') return null;
    progRaw = progTok.text;
  } else {
    const before = head.slice(0, scriptTok.start).trim().replace(/^@/, '').trim();
    if (before === '') {
      const exe = expand(scriptTok.text);
      if (!exe || !/\.(exe|com)$/i.test(exe)) return null;
      return { interpreter: null, scriptPath: exe };
    }
    const word = before.split(/\s+/).filter(Boolean).pop();
    if (!word || word !== before) return null;
    progRaw = word;
  }
  if (/^%_prog%$/i.test(progRaw)) {
    if (progValues.length === 0) return null;
    progRaw = progValues.find((v) => !/[%\\/]/.test(v)) ?? progValues[progValues.length - 1];
  }
  const interpreter = (progRaw.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '').toLowerCase();
  if (!SHIM_INTERPRETERS.has(interpreter)) return null;
  const scriptPath = expand(scriptTok.text);
  if (!scriptPath || !SHIM_SCRIPT_EXT.test(scriptPath)) return null;
  return { interpreter, scriptPath };
}

// ── node-installer helpers (verbatim ~5531-5640) ─────────────────────────
function nodeMajor(version) {
  if (typeof version !== 'string') return null;
  const m = /^v?(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : null;
}
function nodeIsUsable(version) {
  const major = nodeMajor(version);
  return major !== null && major >= NODE_FLOOR_MAJOR;
}
const execNodeVersion = (nodePath) => execFileSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 5e3, stdio: ['ignore', 'pipe', 'ignore'] });
function detectNodeVersion(nodePath, probe = execNodeVersion) {
  if (!nodePath) return null;
  try {
    const out = (probe(nodePath) || '').trim();
    return /^v?\d+\./.test(out) ? out : null;
  } catch { return null; }
}
function pickLatestLts(index) { return index.find((e) => e && e.lts) ?? null; }
function nodeArtifactFor(version, platform, arch) {
  if (platform === 'darwin') return { file: `node-${version}.pkg`, kind: 'pkg' };
  if (platform === 'win32') {
    const a = arch === 'arm64' ? 'arm64' : 'x64';
    return { file: `node-${version}-${a}.msi`, kind: 'msi' };
  }
  if (platform === 'linux') {
    const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
    if (!a) return null;
    return { file: `node-${version}-linux-${a}.tar.xz`, kind: 'tar' };
  }
  return null;
}
function shaFor(shasums, file) {
  for (const line of shasums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === file) return m[1];
  }
  return null;
}
const distUrl = (version, file) => `${DIST}/${version}/${file}`;
const timedFetch = (url) => fetch(url, { signal: AbortSignal.timeout(6e3) });
async function resolveNodeInstaller(platform = process.platform, arch = process.arch, fetchImpl = timedFetch) {
  try {
    const indexRes = await fetchImpl(`${DIST}/index.json`);
    if (!indexRes.ok) return null;
    const index = JSON.parse(await indexRes.text());
    const lts = pickLatestLts(index);
    if (!lts) return null;
    const artifact = nodeArtifactFor(lts.version, platform, arch);
    if (!artifact) return null;
    const shaRes = await fetchImpl(`${DIST}/${lts.version}/SHASUMS256.txt`);
    if (!shaRes.ok) return null;
    const sha256 = shaFor(await shaRes.text(), artifact.file);
    if (!sha256) return null;
    return { version: lts.version, npmVersion: lts.npm, file: artifact.file, url: distUrl(lts.version, artifact.file), sha256, kind: artifact.kind };
  } catch { return null; }
}
function buildNodeInstallScript(installer, platform) {
  const { version, url, sha256, file } = installer;
  if (platform === 'win32') {
    const f = `%TEMP%\\${file}`;
    return [
      `echo   Downloading Node.js ${version} ^(official installer^)...`,
      `curl -fSL ${url} -o ${f}`,
      `if errorlevel 1 exit /b 1`,
      `echo   Verifying checksum...`,
      `certutil -hashfile ${f} SHA256 | findstr /i /c:${sha256} >nul`,
      `if errorlevel 1 (echo   [x] CHECKSUM MISMATCH - refusing to install ^& exit /b 1)`,
      `echo   Installing - approve the Windows prompt if it appears...`,
      `msiexec /i ${f} /passive /norestart`,
      `if errorlevel 1 exit /b 1`,
      `set PATH=%ProgramFiles%\\nodejs;%PATH%`,
    ];
  }
  const verify = platform === 'darwin' ? `echo "${sha256}  $__f" | shasum -a 256 -c - >/dev/null` : `echo "${sha256}  $__f" | sha256sum -c - >/dev/null`;
  const install = platform === 'darwin' ? `sudo installer -pkg "$__f" -target /` : `sudo tar -xJf "$__f" -C /usr/local --strip-components=1`;
  return [
    `echo '  Downloading Node.js ${version} (official installer)...'`,
    `__tmp=$(mktemp -d)`,
    `__f=$__tmp/${file}`,
    `curl -fSL --progress-bar ${url} -o "$__f" || { echo '  [x] Download failed.'; exit 1; }`,
    `echo '  Verifying checksum...'`,
    `${verify} || { echo '  [x] CHECKSUM MISMATCH - refusing to install.'; rm -rf "$__tmp"; exit 1; }`,
    `echo ''`,
    `echo '  Installing Node.js. Enter your password if prompted -'`,
    `echo '  the official installer writes outside your home directory.'`,
    `echo ''`,
    `${install} || { echo '  [x] Node install failed.'; rm -rf "$__tmp"; exit 1; }`,
    `rm -rf "$__tmp"`,
    `PATH=/usr/local/bin:$PATH`,
    `export PATH`,
  ];
}

// ── missing-CLI helpers (verbatim ~29388-29670) ──────────────────────────
function installInfoForProvider(provider, platform = process.platform) {
  const p = providerPreset(provider);
  const native = p.nativeInstallCommand;
  return {
    command: p.installCommand,
    nativeCommand: native ? (platform === 'win32' ? native.win32 : native.posix) : undefined,
    label: p.label,
    docsUrl: p.docsUrl,
  };
}
function chooseInstallRung(info, npmAvailable, nodeInstaller) {
  if (info.command && npmAvailable) return { command: info.command, kind: 'npm', nodeMissing: false };
  if (info.command && nodeInstaller) return { command: info.command, kind: 'node-then-npm', nodeMissing: true };
  if (info.nativeCommand) return { command: info.nativeCommand, kind: 'native', nodeMissing: !npmAvailable };
  return { kind: 'manual', nodeMissing: !npmAvailable };
}
function describeMissingCli(provider, bin, npmAvailable, platform = process.platform, nodeInstaller) {
  const info = installInfoForProvider(provider, platform);
  const rung = chooseInstallRung(info, npmAvailable, nodeInstaller);
  const safeBin = (bin || provider).replace(SAFE_BIN_RE, '') || provider;
  return {
    provider, label: info.label, bin: safeBin, rung: rung.kind,
    command: rung.command ?? null,
    manualCommand: rung.kind === 'manual' ? info.command ?? null : null,
    nodeMissing: rung.nodeMissing,
    ...rung.kind === 'node-then-npm' && nodeInstaller ? { nodeVersion: nodeInstaller.version } : {},
    ...info.docsUrl ? { docsUrl: info.docsUrl } : {},
  };
}
function buildMissingCliScript(bin, provider, npmAvailable, platform = process.platform, nodeInstaller) {
  const info = installInfoForProvider(provider, platform);
  const safeBin = (bin || provider).replace(SAFE_BIN_RE, '') || provider;
  const rung = chooseInstallRung(info, npmAvailable, nodeInstaller);
  const nodeSteps = rung.kind === 'node-then-npm' && nodeInstaller ? buildNodeInstallScript(nodeInstaller, platform) : null;
  const cmd = rung.command;
  const label = info.label;
  const docs = info.docsUrl;
  const rule = '------------------------------------------------------------';
  if (platform === 'win32') {
    const parts = ['echo.', `echo ${rule}`, `echo   Engine CLI not found:  ${safeBin}`, 'echo.'];
    if (nodeSteps && nodeInstaller) {
      parts.push(
        'echo   Node.js is not installed on this machine, so the usual npm',
        `echo   installer cannot run yet. Installing Node ${nodeInstaller.version} ^(+ npm^) first,`,
        'echo   straight from nodejs.org, checksum-verified.',
        'echo.',
        ...nodeSteps,
        'echo.',
      );
    } else if (rung.nodeMissing) {
      parts.push('echo   Node.js is not installed on this machine, so the usual', 'echo   npm installer cannot run here.', 'echo.');
    }
    if (cmd) {
      if (rung.kind === 'native') parts.push(`echo   Using the self-contained ${label} installer instead ^(no Node needed^):`);
      else parts.push(`echo   Installing the ${label} CLI now so you can watch:`);
      parts.push(
        'echo.', `echo     ${cmd}`, `echo ${rule}`, 'echo.', cmd, 'echo.',
        'echo   [done] If it succeeded, the next step shows above the message box.',
        'echo   If it failed, run the command above by hand, then press Check again on the card.',
      );
    } else {
      if (rung.nodeMissing) {
        parts.push(
          `echo   Install Node.js ^(nodejs.org^), then the ${label} CLI:`,
          `echo     ${info.command ?? ''}`,
          'echo   …or install the CLI by whatever method its docs recommend.',
        );
      } else {
        parts.push(
          `echo   No bundled installer for the ${label} provider.`,
          'echo   Install it manually, then restart the agent to launch it.',
        );
      }
      if (docs) parts.push(`echo   Docs: ${docs}`);
      parts.push(`echo ${rule}`);
    }
    return parts.join(' & ');
  }
  const lines = [
    `echo ''`, `echo '${rule}'`, `echo '  Engine CLI not found:  ${safeBin}'`, `echo ''`,
  ];
  if (nodeSteps && nodeInstaller) {
    lines.push(
      `echo '  Node.js is not installed on this machine, so the usual npm'`,
      `echo '  installer cannot run yet. Installing Node ${nodeInstaller.version} (+ npm) first,'`,
      `echo '  straight from nodejs.org, checksum-verified.'`,
      `echo ''`, ...nodeSteps, `echo ''`,
    );
  } else if (rung.nodeMissing) {
    lines.push(
      `echo '  Node.js is not installed on this machine, so the usual npm'`,
      `echo '  installer cannot run here.'`, `echo ''`,
    );
  }
  if (cmd) {
    lines.push(
      ...rung.kind === 'native' ? [
        `echo '  Using the self-contained ${label} installer instead (no Node needed) —'`,
        `echo '  finish any sign-in it prompts for, then come back to this terminal.'`,
      ] : [
        `echo '  Installing the ${label} CLI now so you can watch — finish any'`,
        `echo '  sign-in it prompts for, then come back to this terminal.'`,
      ],
      `echo ''`, `echo '    ${cmd}'`, `echo '${rule}'`, `echo ''`, cmd,
      `__clirc=$?`, `echo ''`,
      `if [ $__clirc -eq 0 ]; then`,
      `  echo '  [done] Installed. The next step shows above the message box.'`,
      `else`,
      `  echo "  [x] Install exited with code $__clirc. Press Set up manually on the card, or run:"`,
      `  echo '    ${cmd}'`,
      ...docs ? [`  echo '    Docs: ${docs}'`] : [],
      `  echo '  Then press Setup complete, start agent above the message box.'`,
      `fi`,
      `exit $__clirc`,
    );
  } else if (rung.nodeMissing) {
    lines.push(
      `echo '  Install Node.js (nodejs.org), then the ${label} CLI:'`,
      ...info.command ? [`echo '    ${info.command}'`] : [],
      `echo '  …or install the CLI by whatever method its docs recommend.'`,
      ...docs ? [`echo '  Docs: ${docs}'`] : [],
      `echo '${rule}'`,
    );
  } else {
    lines.push(
      `echo '  No bundled installer for the ${label} provider.'`,
      `echo '  Install it manually, then restart the agent to launch it.'`,
      ...docs ? [`echo '  Docs: ${docs}'`] : [],
      `echo '${rule}'`,
    );
  }
  return lines.join('\n');
}
function buildLoginScript(binPath, args, label, platform = process.platform) {
  const rule = '------------------------------------------------------------';
  const safeArgs = args.map((a) => a.replace(SAFE_BIN_RE, '')).filter(Boolean);
  if (platform === 'win32') {
    const name = (binPath.split(/[\\/]/).pop() || binPath).replace(SAFE_BIN_RE, '');
    return [
      'echo.', `echo ${rule}`,
      `echo   Sign in to ${label}. When it says you are signed in,`,
      'echo   press Setup complete, start agent above the message box.',
      `echo ${rule}`, 'echo.', [name, ...safeArgs].join(' '),
    ].join(' & ');
  }
  const quoted = `'${binPath.replace(/'/g, `'\\''`)}'`;
  return [
    `echo ''`, `echo '${rule}'`,
    `echo '  Sign in to ${label}. When it says you are signed in,'`,
    `echo '  press Setup complete, start agent above the message box.'`,
    `echo '${rule}'`, `echo ''`, [quoted, ...safeArgs].join(' '),
  ].join('\n');
}
function buildManualSetupScript(o, platform = process.platform) {
  const rule = '------------------------------------------------------------';
  const plain = (v) => v.replace(/[^A-Za-z0-9 ._@/:+=|^·-]/g, '');
  const label = plain(o.label);
  const bin = plain(o.binName);
  const shown = plain(o.shown);
  if (platform === 'win32') {
    return [
      'echo.', `echo ${rule}`,
      `echo   Set up ${label} by hand. This terminal has the agent settings.`,
      `echo   It runs:  ${shown}`,
      ...o.reason === 'install' ? [`echo   When the install ends, run ${bin} here and sign in.`] : ['echo   Sign in inside it.'],
      'echo   Once the agent works here, press Setup complete, start agent',
      'echo   above the message box.',
      `echo ${rule}`, 'echo.', o.exec, 'echo.', 'cmd',
    ].join(' & ');
  }
  const run = o.reason === 'install' ? o.exec : `'${o.exec.replace(/'/g, `'\\''`)}'`;
  return [
    `echo ''`, `echo '${rule}'`,
    `echo '  Set up ${label} by hand. This terminal has the agent settings.'`,
    `echo '  It runs:  ${shown}'`,
    o.reason === 'install' ? `echo '  When the install ends, run ${bin} here and sign in.'` : `echo '  Sign in inside it.'`,
    `echo '  Once the agent works here, press Setup complete, start agent'`,
    `echo '  above the message box.'`,
    `echo '${rule}'`, `echo ''`, run, `echo ''`,
    `echo '  Your shell. Run it again, or check ${bin} works, then press'`,
    `echo '  Setup complete, start agent above the message box.'`,
    `exec "\${SHELL:-/bin/sh}" -il`,
  ].join('\n');
}
function installerTail(tail, keep = 8) {
  if (!tail) return '';
  const lines = tail.replace(ANSI_RE, '').split(/\r?\n|\r/).map((l) => l.trimEnd()).filter((l) => l.trim());
  return lines.slice(-keep).join('\n');
}
function installEndStillWanted(a) {
  if (a.armed === undefined || a.armedNow !== a.armed) return false;
  if (a.guided && a.setupPhase !== 'installing') return false;
  return true;
}
function runEndReason(exitCode, signal) {
  if (typeof signal === 'number' && signal > 0) return 'stopped';
  if (exitCode === 0) return 'completed';
  if (typeof exitCode === 'number') return 'error';
  return 'unknown';
}
function runDurationBucket(ms) {
  const s = Number.isFinite(ms) && ms > 0 ? ms / 1e3 : 0;
  if (s < 30) return '<30s';
  if (s < 120) return '30s-2m';
  if (s < 600) return '2-10m';
  if (s < 1800) return '10-30m';
  if (s < 7200) return '30m-2h';
  return '2h+';
}
function offerSignInAfterExit(e) {
  if (e.provider === 'custom') return { offer: false, line: null };
  const line = authFailureLine(e.tail);
  const early = e.ranMs >= 0 && e.ranMs < EARLY_EXIT_MS;
  const killed = typeof e.signal === 'number' && e.signal !== 0;
  if (killed) return { offer: !!line && early, line };
  if (e.exitCode !== 0) return { offer: early || !!line, line };
  return { offer: early && !!line, line };
}
function setupCanStart(s) {
  if (s?.phase === 'manual') return true;
  if (!s || s.phase !== 'signin') return false;
  if (s.loginCommand === null) return true;
  return s.login === 'done' || !!s.signedIn;
}
function setupCanStartAnyway(s) { return !!s && s.phase === 'signin' && s.login === 'failed' && !s.signedIn; }
function setupCanGoManual(s) { return !!s && s.phase === 'signin' && s.login !== 'done' && !s.signedIn; }
function providerLoginArgs(provider) { return LOGIN_ARGS[provider] ?? null; }
function loginCommandLine(bin, provider) {
  const args = providerLoginArgs(provider);
  if (!args) return null;
  const name = bin.split('/').pop() || bin;
  return [name, ...args].join(' ');
}
function authFailureLine(tail, lines = 15) {
  const last = tail.replace(ANSI_RE, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-lines);
  for (let i = last.length - 1; i >= 0; i--) {
    if (AUTH_FAILURE_RES.some((re) => re.test(last[i]))) return last[i].slice(0, 200);
  }
  return null;
}
function isPrintModeRun(provider, args) {
  if (provider === 'codex' && args[0] === 'exec') return true;
  return args.some((a) => a === '-p' || a === '--print' || a === '--prompt' || a.startsWith('--prompt=') || a.startsWith('--print='));
}
function hasSignInCheck(provider) { return !!STATUS_ARGS[provider]; }
function readSignInStatus(provider, exitCode, stdout, stderr) {
  const out = stdout.replace(ANSI_RE, '');
  const all = (out + '\n' + stderr.replace(ANSI_RE, '')).trim();
  switch (provider) {
    case 'claude': {
      if (exitCode === 0) return 'signed-in';
      if (exitCode !== 1) return 'unknown';
      try { const j = JSON.parse(out); return j.loggedIn === false ? 'signed-out' : 'unknown'; }
      catch { return 'unknown'; }
    }
    case 'codex': {
      if (exitCode === 0) return 'signed-in';
      if (exitCode === 1 && all.split(/\r?\n/).some((l) => l.trim() === 'Not logged in')) return 'signed-out';
      return 'unknown';
    }
    case 'cursor': {
      if (exitCode !== 0) return 'unknown';
      const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length === 1 && lines[0] === 'Not logged in') return 'signed-out';
      if (lines.some((l) => /^(\S+\s+)?Logged in as \S/.test(l))) return 'signed-in';
      return 'unknown';
    }
    default: return 'unknown';
  }
}
function checkSignedIn(provider, binPath, env, cwd, timeoutMs = SIGNIN_CHECK_TIMEOUT_MS) {
  const args = STATUS_ARGS[provider];
  if (!args) return Promise.resolve('unknown');
  return new Promise((resolve) => {
    let settled = false;
    const done = (s) => { if (!settled) { settled = true; resolve(s); } };
    let child;
    try {
      child = spawn(binPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch { done('unknown'); return; }
    let stdout = '', stderr = '';
    const cap = 64 * 1024;
    child.stdout?.on('data', (d) => { if (stdout.length < cap) stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { if (stderr.length < cap) stderr += d.toString('utf8'); });
    const timer = setTimeout(() => {
      if (child.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
      done('unknown');
    }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); done('unknown'); });
    child.on('close', (code) => { clearTimeout(timer); done(readSignInStatus(provider, code, stdout, stderr)); });
  });
}
function loginHostAllowed(provider, url) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return u.protocol === 'http:' || u.protocol === 'https:';
  if (u.protocol !== 'https:') return false;
  return (LOGIN_HOSTS[provider] ?? []).some((h) => host === h || host.endsWith('.' + h));
}
const lastUrl = (t) => { const m = t.match(URL_RE); return m ? m[m.length - 1] : undefined; };
const lastCode = (t) => { const m = t.match(CODE_RE); return m ? m[m.length - 1] : undefined; };
function contextLine(t) {
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l && !/^https?:\/\/\S+$/.test(l));
  for (let i = lines.length - 1; i >= 0; i--) if (LOGIN_CONTEXT.test(lines[i])) return lines[i].slice(0, 200);
  return lines[lines.length - 1]?.slice(0, 200) ?? '';
}
const RECIPES = {
  codex: (t) => {
    if (/auth\.openai\.com\/codex\/device/.test(t)) {
      const code = lastCode(t);
      return code ? { kind: 'device-code', url: 'https://auth.openai.com/codex/device', code, line: contextLine(t) } : null;
    }
    const u = lastUrl(t);
    if (u && /auth\.openai\.com/.test(u)) return { kind: 'browser', url: u, line: contextLine(t) };
    return null;
  },
  grok: (t) => {
    const u = lastUrl(t);
    if (u && /accounts\.x\.ai/.test(u)) {
      const code = lastCode(t);
      return code ? { kind: 'device-code', url: u, code, line: contextLine(t) } : { kind: 'browser', url: u, line: contextLine(t) };
    }
    return null;
  },
  kimi: (t) => {
    const u = lastUrl(t);
    if (u && /kimi\.(ai|com)\/code\/authorize_device/.test(u)) {
      const code = lastCode(t);
      return code ? { kind: 'device-code', url: u, code, line: contextLine(t) } : null;
    }
    return null;
  },
  cursor: (t) => {
    const u = lastUrl(t);
    if (u && /cursor\.com\/loginDeepControl/.test(u)) return { kind: 'browser', url: u, line: contextLine(t) };
    return null;
  },
  copilot: (t) => {
    if (/github\.com\/login\/device/.test(t)) {
      const code = lastCode(t);
      return code ? { kind: 'device-code', url: 'https://github.com/login/device', code, line: contextLine(t) } : null;
    }
    const u = lastUrl(t);
    if (u && /^https:\/\/github\.com\/login\/oauth\/authorize\?/.test(u)) return { kind: 'browser', url: u, line: contextLine(t) };
    return null;
  },
  claude: (t) => {
    if (/paste code here/i.test(t)) return { kind: 'paste-code', url: lastUrl(t), line: contextLine(t) };
    return null;
  },
};
function generic(t) {
  if (!LOGIN_CONTEXT.test(t)) return null;
  const url = lastUrl(t);
  const code = lastCode(t);
  if (/paste (the |this )?code (here|below|into)|enter (the |this )?code (here|below|into)/i.test(t)) return { kind: 'paste-code', url, line: contextLine(t) };
  if (url && code) return { kind: 'device-code', url, code, line: contextLine(t) };
  if (url) return { kind: 'browser', url, line: contextLine(t) };
  if (/api key/i.test(t) && /[:>]\s*$/.test(t.trimEnd())) return { kind: 'api-key', line: contextLine(t) };
  return null;
}
function detectLoginPrompt(provider, text) {
  const t = stripAnsi(text);
  const own = RECIPES[provider]?.(t);
  if (own) return { provider, recipe: 'provider', trusted: loginHostAllowed(provider, own.url), ...own };
  const g = generic(t);
  return g ? { provider, recipe: 'generic', trusted: false, ...g } : null;
}
function detectLoginOutcome(text) {
  const lines = stripAnsi(text).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SUCCESS.test(lines[i])) return { outcome: 'success', line: lines[i].slice(0, 200) };
    if (FAILURE.test(lines[i])) return { outcome: 'failure', line: lines[i].slice(0, 200) };
  }
  return null;
}
function sameLoginPrompt(a, b) {
  if (!a || !b) return a === b;
  return a.kind === b.kind && a.url === b.url && a.code === b.code;
}

/** verbatim CliLoginWatcher (ref ~29899) */
class CliLoginWatcher {
  constructor(emit, now = Date.now) { this.emit = emit; this.now = now; this.ptys = new Map(); }
  track(id, provider) { this.ptys.set(id, { provider, since: this.now(), window: '', prompt: null, after: '', ended: false }); }
  forget(id) { this.ptys.delete(id); }
  current(id) { return this.ptys.get(id)?.prompt ?? null; }
  dismiss(id) { const w = this.ptys.get(id); if (w) { w.prompt = null; w.ended = true; } }
  pastLogin(id) { const w = this.ptys.get(id); if (w && !w.prompt) w.ended = true; }
  watching(id) { const w = this.ptys.get(id); return !!w && !w.ended; }
  observe(id, data) {
    const w = this.ptys.get(id);
    if (!w || w.ended) return;
    if (this.now() - w.since > WATCH_MS) { this.ptys.delete(id); return; }
    const plain = stripAnsi(data);
    w.window = (w.window + plain).slice(-6e3);
    if (w.prompt) {
      w.after = (w.after + plain).slice(-6e3);
      const done = detectLoginOutcome(w.after);
      if (done) {
        w.prompt = null;
        w.ended = done.outcome === 'success';
        w.after = '';
        this.emit(id, { done });
      }
      return;
    }
    if (!plain.includes('\n')) return;
    const p = detectLoginPrompt(w.provider, w.window);
    if (p && !sameLoginPrompt(p, w.prompt)) {
      w.prompt = p;
      w.after = '';
      this.emit(id, { prompt: p });
    }
  }
}

// ── misc verbatim ─────────────────────────────────────────────────────────
function reasonFromRenderer(value) {
  return value === 'restart' || value === 'revive' || value === 'sweep' || value === 'archive' ? value : 'person';
}
function spawnFailReason(error) {
  if (error?.startsWith('cwd does not exist')) return 'cwd_missing';
  if (error?.includes('already exists')) return 'already_running';
  return 'spawn_error';
}
function nonInteractiveEnvForProvider(provider) {
  const p = providerPreset(provider);
  return p.nonInteractiveEnv ?? {};
}
function argsWithAutoModeFlag(args, autoMode, provider) {
  const p = providerPreset(provider);
  // autoModeFlag may carry a value ("--permission-mode bypassPermissions") —
  // it must be split into separate argv tokens, else claude exits 1 with
  // "unknown option '--permission-mode bypassPermissions'". Mirror the
  // splitFlags() handling providers.buildLaunch already uses for autoFlag.
  if (autoMode && p.autoModeFlag) {
    const tokens = String(p.autoModeFlag).trim().split(/\s+/).filter(Boolean);
    if (tokens.length && !tokens.every((t) => args.includes(t))) return [...args, ...tokens];
  }
  return args;
}
function modelForRole(meta, config) {
  const MODEL_GOD = 'claude-opus-4-5', MODEL_HELPER = 'claude-haiku-4-5', MODEL_WORKER = 'claude-sonnet-4-5';
  if (meta.isGod) {
    const preset = providerPreset(config?.godProvider ?? 'claude');
    return config?.godModel ?? preset.recommendedOrchestratorModel ?? MODEL_GOD;
  }
  const hay = `${meta.role ?? ''} ${(meta.capabilities ?? []).join(' ')}`.toLowerCase();
  if (/\b(triage|rout|verif|lint|format|summar|classif|label)/.test(hay)) return MODEL_HELPER;
  return MODEL_WORKER;
}
function projectDir(cwd) {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}
function seedSessionTranscript(cwd, sessionId) {
  try {
    if (!sessionId || !VALID_SESSION_ID.test(sessionId)) return false;
    const target = path.join(projectDir(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(target)) return true;
    const projectsRoot = path.join(os.homedir(), '.claude/projects');
    if (!fs.existsSync(projectsRoot)) return false;
    for (const dir of fs.readdirSync(projectsRoot)) {
      const candidate = path.join(projectsRoot, dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(candidate, target);
        return true;
      }
    }
    return false;
  } catch { return false; }
}
function findSessionHolders(sessionId, claudeDir, selfPid = process.pid) {
  const out = [];
  try {
    const sessDir = path.join(claudeDir, 'sessions');
    if (fs.existsSync(sessDir)) {
      for (const f of fs.readdirSync(sessDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(sessDir, f), 'utf8'));
          if (rec?.sessionId === sessionId && Number.isInteger(rec?.pid) && rec.pid !== selfPid) {
            out.push({ kind: 'session', pid: rec.pid, procStart: rec.startedAt });
          }
        } catch {}
      }
    }
  } catch {}
  return out;
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sameProcess(pid, procStart) {
  if (procStart === undefined || procStart === null) return true;
  return true; // no /proc on macOS; treat recorded holders as verifiable
}
async function runCmd(file, args, timeoutMs) {
  return new Promise((resolve) => {
    try {
      const cp = spawn(file, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      const t = setTimeout(() => { try { cp.kill(); } catch {} resolve({ ok: false }); }, timeoutMs);
      cp.on('error', () => { clearTimeout(t); resolve({ ok: false }); });
      cp.on('exit', (c) => { clearTimeout(t); resolve({ ok: c === 0 }); });
    } catch { resolve({ ok: false }); }
  });
}
async function releaseClaudeSession(sessionId, claudeDir, claudeExe, waitMs = 3e3) {
  const done = [];
  for (const h of findSessionHolders(sessionId, claudeDir)) {
    if (h.kind === 'background' && h.shortId) {
      const r = await runCmd(claudeExe, ['stop', h.shortId], 15e3);
      done.push(`stop ${h.shortId} ${r.ok ? 'ok' : 'failed'}`);
      continue;
    }
    const pid = h.pid;
    if (!pid || !alive(pid)) continue;
    if (!await sameProcess(pid, h.procStart)) { done.push(`skip ${pid} (not verifiable)`); continue; }
    try { process.kill(pid, 'SIGTERM'); } catch {}
    const until = Date.now() + waitMs;
    while (alive(pid) && Date.now() < until) await sleep(100);
    if (alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await sleep(200);
    }
    done.push(`term ${pid} ${alive(pid) ? 'still alive' : 'ok'}`);
  }
  return done;
}
function ensureClaudePermissionsAccepted(cwd) {
  let home;
  try { home = os.homedir(); } catch { return; }
  try {
    const dir = path.join(home, '.claude');
    const p = path.join(dir, 'settings.json');
    let s = {};
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      s = parsed;
    }
    if (s.skipDangerousModePermissionPrompt !== true || s.skipAutoPermissionPrompt !== true) {
      s.skipDangerousModePermissionPrompt = true;
      s.skipAutoPermissionPrompt = true;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
    }
    const cp = path.join(home, '.claude.json');
    let c = {};
    if (fs.existsSync(cp)) {
      const parsed = JSON.parse(fs.readFileSync(cp, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      c = parsed;
    }
    const keys = [...new Set([cwd.replace(/\\/g, '/'), cwd])];
    if (keys.some((k) => c.projects?.[k]?.hasTrustDialogAccepted !== true)) {
      c.projects = c.projects ?? {};
      for (const k of keys) c.projects[k] = { ...c.projects[k] ?? {}, hasTrustDialogAccepted: true };
      fs.writeFileSync(cp, JSON.stringify(c, null, 2), 'utf8');
    }
  } catch {}
}

// ── verbatim PtyManager behaviour layer ──────────────────────────────────
// The clone's PtyManager (../pty-manager.js) owns spawn + write + resize +
// kill over node-pty; this layer adds the reference's missing-CLI lookup,
// childEnv, output routing, owner tracking, and the verbatim return shapes.
function verbatimPtyLayer(ctx) {
  const mgr = ctx.harness?.pty;
  if (!mgr || mgr.__verbatimLayered) return mgr;
  mgr.__verbatimLayered = true;
  mgr.sessions = mgr.sessions ?? mgr.agents;
  mgr.wanted = mgr.wanted ?? new Map();
  mgr.resolvedCommands = new Map();
  mgr.webContents = null;
  mgr.ledger = null;
  mgr.dataHook = null;
  mgr.exitHandler = null;

  mgr.attachWebContents = (wc) => { mgr.webContents = wc; };
  mgr.setLedger = (l) => { mgr.ledger = l; };
  mgr.forgetPid = (pid) => { try { mgr.ledger?.remove(pid); } catch {} };
  mgr.setDataHook = (h) => { mgr.dataHook = h; };
  mgr.setExitHandler = (h) => { mgr.exitHandler = h; };
  mgr.childEnv = (agentEnv) => buildPtyEnv(process.env,
    process.platform === 'win32' ? process.env.PATH || '' : userShellPath(),
    agentEnv);
  mgr.forgetLookups = () => { forgetShellLookups(); mgr.resolvedCommands.clear(); };
  mgr.resolveCommand = (command) => {
    const cached = mgr.resolvedCommands.get(command);
    const gen = shellPathGeneration();
    if (cached && cached.gen === gen && fs.existsSync(cached.path)) return cached;
    const res = mgr.resolveCommandUncached(command);
    if (res.found) mgr.resolvedCommands.set(command, { ...res, gen });
    else mgr.resolvedCommands.delete(command);
    return res;
  };
  mgr.resolveCommandUncached = (command) => {
    if (command.includes('/') || command.includes('\\')) return { path: command, found: fs.existsSync(command) };
    if (!isSafeCommandName(command)) return { path: command, found: false };
    if (process.platform === 'win32') {
      try {
        const res = spawnSync('where', [command], { encoding: 'utf8', timeout: 3e3 });
        const lines = (res.stdout ?? '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const pathExts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim().toUpperCase()).filter(Boolean);
        const isExecutable = (p) => {
          const dot = p.lastIndexOf('.');
          const sep = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
          if (dot <= sep) return false;
          return pathExts.includes(p.slice(dot).toUpperCase());
        };
        const exe = lines.find((p) => isExecutable(p) && fs.existsSync(p));
        if (exe) return { path: exe, found: true };
      } catch {}
      for (const c of windowsFallbackCandidates(command)) if (fs.existsSync(c)) return { path: c, found: true };
      return { path: command, found: false };
    }
    const onPath = findCommandOnPath(command, userShellPath());
    if (onPath) return { path: onPath, found: true };
    for (const d of commonBinDirs(process.env.HOME ?? '')) {
      const c = `${d}/${command}`;
      if (fs.existsSync(c)) return { path: c, found: true };
    }
    return { path: command, found: false };
  };
  mgr.isCommandAvailable = (command) => mgr.resolveCommand(command).found;
  mgr.commandPath = (command) => { const r = mgr.resolveCommand(command); return r.found ? r.path : null; };
  mgr.safeSend = (channel, payload, target) => {
    const wc = target ?? mgr.webContents;
    if (!wc || wc.isDestroyed()) return;
    try { wc.send(channel, payload); } catch {}
  };
  mgr.sendToOwner = (id, channel, payload) => {
    const rec = mgr.agents.get(id);
    const wc = rec?.owner ?? mgr.webContents;
    if (!wc || wc.isDestroyed()) return false;
    try { wc.send(channel, payload); return true; } catch { return false; }
  };
  mgr.tail = (id) => mgr.scrollback(id).slice(-TAIL_MAX);
  mgr.lastOutputAt = (id) => mgr.agents.get(id)?.lastOutputAt;
  mgr.info = (id) => {
    const a = mgr.agents.get(id);
    if (!a) return null;
    return { pid: a.pid, cols: a.proc?.cols ?? 0, rows: a.proc?.rows ?? 0, hasOutput: !!a.scrollback, startedAt: a.spawnedAt, command: a.spec?.command ?? a.command };
  };
  // Verbatim spawn signature: spawn(opts, owner) → {ok,...}
  const origSpawn = mgr.spawn.bind(mgr);
  mgr.spawn = (opts, owner = null) => {
    // harness.spawnAgent calls the native PtyManager signature spawn(id, spec)
    // — a STRING id in `opts` + the spec in `owner`. Route that back to the
    // original before it trips the verbatim opts-object checks below (which
    // would read opts.id/opts.cwd off a string and throw → spawn never ran).
    if (typeof opts === 'string') return origSpawn(opts, owner);
    if (mgr.agents.has(opts.id)) return { ok: false, error: `pty already exists for id ${opts.id}` };
    opts = { ...opts, cwd: expandTilde(opts.cwd) };
    if (!fs.existsSync(opts.cwd)) return { ok: false, error: `cwd does not exist: ${opts.cwd}` };
    try {
      const resolved = mgr.resolveCommand(opts.command).path;
      const userPath = withHiveRuntimeFallback(
        process.platform === 'win32' ? process.env.PATH || '' : userShellPath(), opts.env?.HIVE_ROOT);
      const isWin = process.platform === 'win32';
      const lower = resolved.toLowerCase();
      const directExe = lower.endsWith('.exe') || lower.endsWith('.com');
      const needsCmd = isWin && !directExe;
      let file, spawnArgs;
      if (typeof opts.shellScript === 'string') {
        if (isWin) { file = process.env.ComSpec || 'cmd.exe'; spawnArgs = `/d /s /c "${opts.shellScript}"`; }
        else { file = process.env.SHELL || '/bin/sh'; spawnArgs = ['-lc', opts.shellScript]; }
      } else {
        file = needsCmd ? process.env.ComSpec || 'cmd.exe' : resolved;
        spawnArgs = needsCmd ? buildCmdCommandLine(resolved, opts.args ?? []) : opts.args ?? [];
      }
      const want = mgr.wanted.get(opts.id);
      const cols = validCell(opts.cols) ?? want?.cols ?? 100;
      const rows = validCell(opts.rows) ?? want?.rows ?? 30;
      const a = origSpawn(opts.id, {
        command: file, args: Array.isArray(spawnArgs) ? spawnArgs : undefined,
        cwd: opts.cwd, env: buildPtyEnv(process.env, userPath, opts.env),
        cols, rows, provider: opts.provider,
      });
      a.owner = owner;
      a.spec = opts;
      a.command = resolved;
      try { void mgr.ledger?.add(opts.id, a.pid); } catch {}
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
  mgr.write = (id, data) => {
    const a = mgr.agents.get(id);
    if (!a) return { ok: false, error: `no pty: ${id}` };
    try { a.write(data); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
  mgr.resize = (id, cols, rows) => {
    const c = validCell(cols), r = validCell(rows);
    if (c === undefined || r === undefined) return { ok: false, error: `bad grid: ${cols}x${rows}` };
    mgr.wanted.set(id, { cols: c, rows: r });
    const a = mgr.agents.get(id);
    if (!a) return { ok: true, pending: true };
    try { a.resize(c, r); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
  mgr.redraw = async (id) => {
    const a = mgr.agents.get(id);
    if (!a) return { ok: false, error: `no pty: ${id}` };
    try {
      const { cols, rows } = a.proc ?? { cols: 0, rows: 0 };
      if (!cols) return { ok: true };
      const step = rows > 1 ? rows - 1 : rows + 1;
      a.proc.resize(cols, step);
      await new Promise((r) => setTimeout(r, REDRAW_STEP_MS));
      if (mgr.agents.get(id) !== a) return { ok: false, error: `pty replaced during redraw: ${id}` };
      a.proc.resize(cols, rows);
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
  const origKill = mgr.kill.bind(mgr);
  mgr.kill = (id) => {
    const a = mgr.agents.get(id);
    if (!a) return { ok: false, error: `no pty: ${id}` };
    try {
      const pid = a.pid;
      origKill(id);
      if (pid) ensureKilled(pid);
      if (a.proc) forceClosePty(a.proc);
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
  // Fan output + exit events to the verbatim per-id push channels.
  mgr.on('data', (id, chunk) => {
    const a = mgr.agents.get(id);
    mgr.safeSend(`pty:data:${id}`, chunk, a?.owner);
    if (mgr.dataHook) { try { mgr.dataHook(id, chunk); } catch (e) { console.error('[pty] data hook:', e); } }
  });
  mgr.on('exit', (id, code) => {
    const a = mgr.agents.get(id);
    mgr.safeSend(`pty:exit:${id}`, { exitCode: code, signal: undefined }, a?.owner);
    try { mgr.exitHandler?.(id, code, { startedAt: a?.spawnedAt, tail: a?.scrollback ?? '', command: a?.command, cwd: a?.cwd }); } catch {}
  });
  mgr.countByOwner = (wc) => { let n = 0; for (const a of mgr.agents.values()) if (a.owner === wc) n++; return n; };
  /** verbatim ~970: kill every PTY owned by a window when it closes so its
   *  terminals don't linger as orphans writing to a dead webContents. */
  mgr.killByOwner = (wc) => {
    for (const [id, a] of [...mgr.agents.entries()]) {
      if (a.owner !== wc) continue;
      try { a.kill(); if (a.pid) ensureKilled(a.pid); if (a.proc) forceClosePty(a.proc); } catch {}
    }
  };
  /** verbatim ~1338: the renderer's last fitted grid for a pty, or null. */
  mgr.wantedGrid = (id) => mgr.wanted.get(id) ?? null;
  /** verbatim ~1332: the grid a spawn should adopt — the wanted fit, else sane default. */
  mgr.gridFor = (opts) => mgr.wanted.get(opts.id) ?? { cols: validCell(opts.cols) ?? 100, rows: validCell(opts.rows) ?? 30 };
  return mgr;
}

// ── register ──────────────────────────────────────────────────────────────
function register(ctx) {
  const { ipcMain, app, shell, BrowserWindow } = ctx;
  const ptyManager = verbatimPtyLayer(ctx);
  const liveWebContents = () => {
    const wc = ctx.win()?.webContents;
    if (wc && !wc.isDestroyed()) return wc;
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && !w.webContents.isDestroyed()) return w.webContents;
    }
    return null;
  };
  const readConfig = ctx.readConfig;
  const analytics = ctx.analytics ?? { track: () => {}, trackFunnel: () => {}, trackMessageSent: () => {} };
  const hive = () => ctx.harness?.hive;
  const memory = () => ctx.harness?.memory;
  const knowledge = () => ctx.harness?.kg;
  const telemetry = () => ctx.harness?.telemetry;
  const breaker = () => ctx.harness?.breaker;
  const restoreGate = () => ctx.harness?.restoreGate;
  const workerWake = () => ctx.harness?.workerWake;
  const codexUsage = () => ctx.harness?.codexUsage;
  const activity = () => ctx.harness?.activity;
  const ledgerGate = () => ctx.harness?.ledgerGate;
  const brokerGrants = () => ctx.brokerGrants;

  // ── verbatim state ────────────────────────────────────────────────────────
  const ptyOwners = ctx.ptyOwners ??= new Map();
  const ptyToAgent = ctx.ptyToAgent ??= new Map();
  const pendingCliMissing = ctx.pendingCliMissing ??= new Map();
  const pendingCliSetup = ctx.pendingCliSetup ??= new Map();
  const pendingInstallRelaunch = ctx.pendingInstallRelaunch ??= new Map();
  const agentRuns = ctx.agentRuns ??= new Map();
  const liveWorkers = ctx.liveWorkers ??= new Map();
  const worktreePaths = ctx.worktreePaths ??= new Map();
  const worktreeOrigins = ctx.worktreeOrigins ??= new Map();
  const worktreeBases = ctx.worktreeBases ??= new Map();
  const worktreeFinalizing = ctx.worktreeFinalizing ??= new Map();
  let launcherGeneration = ctx.launcherGeneration ??= -1;
  let restoreSlowSeq = ctx.restoreSlowSeq ??= 0;

  const loginWatcher = ctx.loginWatcher ??= new CliLoginWatcher((id, e) => {
    const owner = ptyOwners.get(id);
    const wc = owner && !owner.isDestroyed() ? owner : liveWebContents();
    try { wc?.send(`pty:login:${id}`, e); } catch {}
  });
  const terminalProbes = ctx.terminalProbes ??= new TerminalProbes();

  function sendToOwnerOrLive(id, channel, payload, owner) {
    const wc = owner && !owner.isDestroyed() ? owner : liveWebContents();
    try { wc?.send(channel, payload); } catch {}
  }
  const sendCliMissing = (id, owner, state) => sendToOwnerOrLive(id, `pty:cli-missing:${id}`, state, owner);
  const sendCliSetup = (id, owner, state) => sendToOwnerOrLive(id, `pty:cli-setup:${id}`, state, owner);
  const closeLoginModal = (id, owner, outcome) => sendToOwnerOrLive(id, `pty:login:${id}`, { done: { outcome, line: '' } }, owner);

  async function launchEnvReady() {
    await shellPathReady();
    const gen = shellPathGeneration();
    if (launcherGeneration === gen) return;
    launcherGeneration = gen;
    ctx.launcherGeneration = gen;
    try { hive()?.refreshNodeLauncher?.(); } catch (e) { console.error('[hive] node launcher refresh failed:', e); }
  }

  function watchSignIn(id, provider, binPath, env, cwd) {
    const entry = pendingCliSetup.get(id);
    if (!entry || !hasSignInCheck(provider)) return;
    let running = false;
    entry.poll = setInterval(() => {
      const cur = pendingCliSetup.get(id);
      if (cur !== entry || cur.state.phase !== 'signin' || cur.state.signedIn) { clearInterval(entry.poll); return; }
      if (running) return;
      running = true;
      void checkSignedIn(provider, binPath, env, cwd).then((st) => {
        running = false;
        if (st !== 'signed-in' || pendingCliSetup.get(id) !== entry) return;
        entry.state = { ...entry.state, signedIn: true };
        sendCliSetup(id, entry.owner, entry.state);
        clearInterval(entry.poll);
      });
    }, SIGNIN_POLL_MS);
    entry.poll.unref?.();
  }
  function endCliSetup(id) {
    const entry = pendingCliSetup.get(id);
    if (!entry) return undefined;
    if (entry.poll) clearInterval(entry.poll);
    pendingCliSetup.delete(id);
    return entry;
  }

  function syncKeepAwake() {
    const live = ptyManager.list().length > 0;
    const desired = live ? (readConfig().strongKeepalive ? 'prevent-display-sleep' : 'prevent-app-suspension') : null;
    if (desired === ctx.keepAwakeMode) return;
    if (ctx.keepAwakeId != null) {
      try { const { powerSaveBlocker } = require('electron'); if (powerSaveBlocker.isStarted(ctx.keepAwakeId)) powerSaveBlocker.stop(ctx.keepAwakeId); } catch {}
      ctx.keepAwakeId = null;
    }
    ctx.keepAwakeMode = desired;
    if (desired) {
      try { ctx.keepAwakeId = require('electron').powerSaveBlocker.start(desired); } catch {}
      console.log(`[power] keep-awake ON (${desired}) — agents running`);
    } else {
      console.log('[power] keep-awake off — no agents');
    }
  }

  function teardownPty(id, reason) {
    loginWatcher.forget(id);
    ptyOwners.delete(id);
    const workerRec = liveWorkers.get(id);
    if (workerRec) ctx.recordWorkerTeardown?.(workerRec);
    try { brokerGrants()?.release(id); } catch {}
    const agentId = ptyToAgent.get(id);
    if (agentId) {
      ptyToAgent.delete(id);
      try { workerWake()?.forget?.(agentId, id); } catch {}
      try { breaker()?.forget?.(agentId); } catch {}
      try { telemetry()?.forgetAgent?.(agentId); } catch {}
      try { codexUsage()?.forget?.(agentId); } catch {}
      try { activity()?.forget?.(agentId); } catch {}
      try { ledgerGate()?.forget?.(agentId); } catch {}
      try { hive()?.stopProxyBridge?.(agentId); } catch (e) { console.error('[hive] stopProxyBridge failed:', e); }
      if (hive()?.enabled?.()) {
        try { hive().setArchived?.(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
        if (!RESPAWNING.includes(reason) && reason !== 'worker' && !workerRec) {
          try { restoreGate()?.hold?.(agentId); } catch (e) { console.error('[restore-gate] hold failed:', e); }
        }
      }
    }
    const wtPath = worktreePaths.get(id);
    if (wtPath) {
      const origCwd = worktreeOrigins.get(id) ?? wtPath;
      const respawning = RESPAWNING.includes(reason);
      if (!respawning) { worktreePaths.delete(id); worktreeOrigins.delete(id); }
      const worker = liveWorkers.get(id);
      if (worker) {
        liveWorkers.delete(id);
        void ctx.finalizeWorkerWorktree?.(wtPath, origCwd, worker);
      } else {
        const base = worktreeBases.get(id) ?? 'main';
        if (!respawning) worktreeBases.delete(id);
        const finalizing = finalizeAgentWorktree(wtPath, origCwd, base, reason);
        worktreeFinalizing.set(wtPath, finalizing);
        void finalizing.finally(() => worktreeFinalizing.delete(wtPath));
      }
    } else if (workerRec) {
      liveWorkers.delete(id);
    }
  }
  ctx.teardownPty = teardownPty;

  function fateWithoutGit(reason) {
    if (reason === 'restart' || reason === 'revive' || reason === 'worker') return 'keep';
    return null;
  }
  function normalAgentWorktreeFate(reason, work) {
    const fixed = fateWithoutGit(reason);
    if (fixed) return fixed;
    if (!work.known) return 'keep';
    return work.dirty ? 'keep' : 'remove';
  }
  async function finalizeAgentWorktree(wtPath, origCwd, baseBranch, reason) {
    const fixed = fateWithoutGit(reason);
    if (fixed === 'keep') return { fate: 'kept', detail: `kept for the ${reason}` };
    const unlinked = await unlinkWorktreeDeps(origCwd, wtPath);
    const work = await worktreeHasUnintegratedWork(wtPath, baseBranch);
    if (normalAgentWorktreeFate(reason, { dirty: work.dirty, known: work.dirtyKnown }) === 'keep') {
      if (unlinked.ok && unlinked.removed) await linkWorktreeDeps(origCwd, wtPath);
      return { fate: 'kept', detail: work.detail, branch: work.branch };
    }
    const r = await removeWorktree(origCwd, wtPath);
    return r.ok ? { fate: 'removed', detail: work.detail, branch: work.branch } : { fate: 'remove-failed', detail: r.error ?? 'unknown' };
  }

  // ── verbatim hook-transport chooser (ref ~6950-7022) ──────────────────────
  const MIN_HTTP_HOOK_VERSION = [2, 1, 63];
  const ALLOWLIST_KEYS = ['allowedHttpHookUrls', 'httpHookAllowedEnvVars'];

  function parseClaudeVersion(text) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function versionAtLeast(v, min) {
    for (let i = 0; i < min.length; i++) {
      if ((v[i] ?? 0) !== min[i]) return (v[i] ?? 0) > min[i];
    }
    return true;
  }
  function managedSettingsPath(platform = process.platform) {
    if (platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
    if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
    return '/etc/claude-code/managed-settings.json';
  }
  function settingsScopes(cwd, opts = {}) {
    const userDir = opts.configDir || path.join(opts.home ?? os.homedir(), '.claude');
    const managed = opts.managedPath ?? managedSettingsPath();
    const out = [
      { scope: 'user', file: path.join(userDir, 'settings.json') },
      { scope: 'project', file: path.join(cwd, '.claude', 'settings.json') },
      { scope: 'local', file: path.join(cwd, '.claude', 'settings.local.json') },
      { scope: 'managed', file: managed },
    ];
    const dropIn = managed.replace(/\.json$/, '.d');
    try {
      for (const name of fs.readdirSync(dropIn).sort()) {
        if (name.endsWith('.json')) out.push({ scope: 'managed', file: path.join(dropIn, name) });
      }
    } catch {}
    return out;
  }
  function httpHookAllowlistReason(cwd, opts = {}) {
    for (const { scope, file } of settingsScopes(cwd, opts)) {
      let text;
      try {
        if (!fs.existsSync(file)) continue;
        text = fs.readFileSync(file, 'utf8');
      } catch { continue; }
      for (const key of ALLOWLIST_KEYS) {
        if (text.includes(`"${key}"`)) return `${key} in ${scope} settings`;
      }
    }
    return null;
  }
  function chooseHookTransport(input) {
    if (!input.endpoint) return { path: 'command', reason: 'hook listener not bound yet' };
    if (!input.version) return { path: 'command', reason: 'claude version unknown' };
    if (!versionAtLeast(input.version, MIN_HTTP_HOOK_VERSION)) {
      return { path: 'command', reason: `claude ${input.version.join('.')} is older than ${MIN_HTTP_HOOK_VERSION.join('.')}` };
    }
    if (input.allowlistReason) return { path: 'command', reason: input.allowlistReason };
    return { path: 'http', port: input.endpoint.port, token: input.endpoint.token };
  }

  async function claudeHookTransport(command, cwd) {
    await launchEnvReady();
    const endpoint = ctx.harness?.hooks?.httpEndpoint?.() ?? null;
    if (!endpoint) return chooseHookTransport({ endpoint, version: null, allowlistReason: null });
    const bin = command.trim().split(/\s+/)[0] || command;
    const binPath = ptyManager.commandPath(bin);
    const version = binPath ? parseClaudeVersion(await ctx.claudeVersionOnce?.(binPath, ptyManager.childEnv())) : null;
    return chooseHookTransport({
      endpoint,
      version,
      allowlistReason: httpHookAllowlistReason(cwd, { configDir: process.env.CLAUDE_CONFIG_DIR }),
    });
  }

  async function spawnAgentCore(opts, owner) {
    await launchEnvReady();
    opts.cwd = expandTilde(opts.cwd);
    if (opts.hive) opts.hive = { ...opts.hive, cwd: expandTilde(opts.hive.cwd) };
    const asGiven = { ...opts };
    try {
      const here = path.resolve(opts.cwd);
      for (const [wt, pending] of worktreeFinalizing) {
        if (here === path.resolve(wt) || here.startsWith(path.resolve(wt) + path.sep)) await pending.catch(() => undefined);
      }
    } catch {}
    const provider = inferAgentProvider(opts.command, opts.provider ?? opts.hive?.provider);
    const claudeProvider = isClaudeProvider(provider);
    opts.provider = provider;
    if (opts.hive) opts.hive = { ...opts.hive, provider };
    if (!opts.noAutoInstall) analytics.track('agent_spawn_attempted', { provider });
    {
      const bin = opts.command.trim().split(/\s+/)[0] || opts.command;
      if (opts.loginScript === undefined && !opts.installNow && pendingCliSetup.has(opts.id)) {
        const ended = endCliSetup(opts.id);
        sendCliSetup(opts.id, ended?.owner ?? owner, null);
      }
      if (!bin || opts.noAutoInstall || ptyManager.isCommandAvailable(bin)) pendingCliMissing.delete(opts.id);
      if (bin && !opts.noAutoInstall && !ptyManager.isCommandAvailable(bin)) {
        const npmAvailable = ptyManager.isCommandAvailable('npm') && nodeIsUsable(detectNodeVersion(ptyManager.commandPath('node')));
        const nodeInstaller = npmAvailable ? null : await resolveNodeInstaller();
        const rung = chooseInstallRung(installInfoForProvider(provider), npmAvailable, nodeInstaller);
        if (!opts.installNow) {
          const state = describeMissingCli(provider, bin, npmAvailable, process.platform, nodeInstaller);
          pendingCliMissing.set(opts.id, { opts, owner, state });
          sendCliMissing(opts.id, owner, state);
          if (rung.kind === 'manual') analytics.track('agent_spawn_failed', { provider, reason: 'cli_missing' });
          return { ok: true, cwd: opts.cwd, cliMissing: state };
        }
        const res = ptyManager.spawn(
          { id: opts.id, cwd: opts.cwd, command: bin, cols: opts.cols, rows: opts.rows, shellScript: buildMissingCliScript(bin, provider, npmAvailable, process.platform, nodeInstaller) },
          owner);
        if (res.ok && rung.command) {
          pendingInstallRelaunch.set(opts.id, { opts, owner, bin, rung: rung.kind });
          if (opts.guidedSetup) {
            const setup = { phase: 'installing', provider, label: installInfoForProvider(provider).label, loginCommand: null };
            pendingCliSetup.set(opts.id, { opts, owner, state: setup });
            sendCliSetup(opts.id, owner, setup);
          }
          analytics.track('agent_install_started', { provider, rung: rung.kind });
        } else if (res.ok) {
          analytics.track('agent_spawn_failed', { provider, reason: 'cli_missing' });
        } else {
          analytics.track('agent_spawn_failed', { provider, reason: spawnFailReason(res.error) });
        }
        syncKeepAwake();
        return res;
      }
    }
    if (opts.isolate === true && await isRepo(opts.cwd)) {
      try {
        const origCwd = opts.cwd;
        const wtRoot = path.join(readConfig().harnessHome ?? origCwd, 'worktrees');
        const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
        const wtPath = path.join(wtRoot, seg);
        if (!path.resolve(wtPath).startsWith(path.resolve(wtRoot) + path.sep)) {
          console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
        } else {
          const br = await getBranch(origCwd);
          const baseBranch = 'current' in br && br.current ? br.current : 'main';
          const wt = await addWorktree(origCwd, wtPath, baseBranch);
          if (wt.ok) {
            opts.cwd = wtPath;
            worktreePaths.set(opts.id, wtPath);
            worktreeOrigins.set(opts.id, origCwd);
            worktreeBases.set(opts.id, baseBranch);
            const deps = await linkWorktreeDeps(origCwd, wtPath);
            if (!deps.ok) console.error('[worktree] dependency link failed:', deps.error);
          } else {
            console.error('[worktree] addWorktree failed:', wt.error);
          }
        }
      } catch (e) { console.error('[worktree] isolation failed:', e); }
    }
    if (opts.hive && (provider === 'crush' || provider === 'qwen')) {
      const bridge = providerPreset(provider).bridge;
      const baseUrl = readConfig().providerBaseUrls?.[provider];
      if (bridge && bridge.kind === 'proxy' && baseUrl) process.env[bridge.baseUrlEnv] = baseUrl;
    }
    if (opts.hive) opts.args = argsWithAutoModeFlag(opts.args ?? [], readConfig().autoMode === true, provider);
    let seedPrompt;
    if (opts.hive && hive()?.enabled?.()) {
      try {
        const hookTransport = claudeProvider ? await claudeHookTransport(opts.command, opts.cwd) : undefined;
        const inj = await hive().ensureAgent(
          { ...opts.hive, cwd: opts.cwd, provider },
          {
            semanticMemory: memory()?.active?.(),
            mempalaceBin: memory()?.bin?.(),
            knowledgeGraph: knowledge()?.active?.(),
            kgCliPath: knowledge()?.env?.().KG_CLI,
            theme: readConfig().terminalTheme ?? 'light',
            outputStyle: readConfig().claudeOutputStyle,
            mcpDefaults: effectiveMcp(readConfig().mcpDefaults, sanitizeAgentMcp(readConfig().agentMcp), opts.hive.id),
            skillsDir: ctx.skillsResourceDir?.(),
            extraWritableDirs: [memory()?.env?.().MEMPALACE_PALACE_PATH].filter((p) => !!p),
            hookTransport,
          });
        opts.args = [...opts.args ?? [], ...inj.args];
        seedPrompt = inj.seedPrompt;
        if (inj.degraded) ctx.breakerToast?.('An agent needs a fix', inj.degraded);
        opts.env = { ...opts.env ?? {}, ...inj.env, ...memory()?.env?.(), ...knowledge()?.env?.() };
      } catch (e) { console.error('[hive] ensureAgent failed:', e); }
    }
    if (opts.loginScript !== undefined) {
      const bin = opts.command.trim().split(/\s+/)[0] || opts.command;
      const binPath = ptyManager.commandPath(bin) ?? bin;
      const checkEnv = ptyManager.childEnv(opts.env);
      if (!opts.manualSetup && hasSignInCheck(provider) && await checkSignedIn(provider, binPath, checkEnv, opts.cwd) === 'signed-in') {
        return { ok: true, cwd: opts.cwd, signedIn: true };
      }
      if (!opts.loginScript) return { ok: true, cwd: opts.cwd };
      const res = ptyManager.spawn({ id: opts.id, cwd: opts.cwd, command: bin, cols: opts.cols, rows: opts.rows, env: opts.env, shellScript: opts.loginScript }, owner);
      if (res.ok && opts.manualSetup) ptyOwners.set(opts.id, owner);
      else if (res.ok) {
        loginWatcher.track(opts.id, provider);
        ptyOwners.set(opts.id, owner);
        watchSignIn(opts.id, provider, binPath, checkEnv, opts.cwd);
      }
      return { ...res, cwd: opts.cwd };
    }
    let resumeNotFound = false;
    let didResume = false;
    if (opts.hive && claudeProvider) {
      const cfg = readConfig();
      const args = [...opts.args ?? []];
      if (!args.includes('--model')) {
        const m = opts.hive.isGod ? modelForRole(opts.hive, cfg) : cfg.defaultModel ?? modelForRole(opts.hive, cfg);
        if (m) args.push('--model', m);
      }
      if (!args.includes('--remote-control-session-name-prefix')) {
        const label = (opts.hive.name || opts.hive.id || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
        if (label) args.push('--remote-control-session-name-prefix', label);
      }
      if (typeof cfg.maxTurns === 'number' && cfg.maxTurns > 0 && !args.includes('--max-turns')) {
        args.push('--max-turns', String(cfg.maxTurns));
      }
      const explicitSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
      const candidates = [explicitSid || undefined, ...opts.resume === true ? hive().resumeCandidates(opts.hive.id) : []];
      if (!args.includes('--resume') && candidates.some(Boolean)) {
        const cwd = opts.cwd;
        const sid = pickResumableSession(candidates, (s) => seedSessionTranscript(cwd, s));
        if (sid) {
          if (sid !== candidates.find(Boolean)) console.warn(`[resume] ${opts.hive.id}: recorded session has no transcript, resuming the earlier session "${sid}"`);
          args.push('--resume', sid);
          didResume = true;
          const claudeDir = opts.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
          const released = await releaseClaudeSession(sid, claudeDir, resolveCommand(opts.command || 'claude'));
          if (released.length > 0) console.warn(`[resume] ${opts.hive.id}: freed session ${sid}: ${released.join(', ')}`);
        } else {
          console.warn(`[resume] ${opts.hive.id}: no recorded session has a transcript in any Claude project dir — starting a fresh session`);
          resumeNotFound = true;
        }
      }
      opts.args = args;
    }
    if (opts.hive && !claudeProvider) {
      const preset = providerPreset(provider);
      const rf = preset.resumeFlag;
      const rsub = preset.resumeSubcommand;
      const typedSid = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId.trim() : '';
      const walked = typedSid ? [typedSid] : opts.resume === true ? hive().resumeCandidates(opts.hive.id) : [];
      const listDir = (d) => { try { return fs.readdirSync(d); } catch { return null; } };
      let sid = walked.find(Boolean);
      if (sid && rf) {
        const storeCtx = {
          env: { ...process.env, ...opts.env ?? {} }, home: os.homedir(), cwd: opts.cwd,
          readText: (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } },
        };
        const picked = chooseResumeSession(walked, providerSessionStore(provider, storeCtx), listDir);
        if (picked.checked && picked.sid && picked.sid !== sid) {
          console.warn(`[resume] ${opts.hive.id}: recorded ${provider} session is not in its store, resuming the earlier session "${picked.sid}"`);
        }
        sid = picked.sid;
        if (!sid) {
          console.warn(`[resume] ${opts.hive.id}: no recorded ${provider} session exists in its store - starting a fresh session`);
          resumeNotFound = true;
        } else {
          const args = opts.args ?? [];
          if (!args.includes(rf)) { args.push(rf, sid); opts.args = args; didResume = true; }
        }
      } else if (sid && rsub) {
        const myHome = (opts.env ?? {}).CODEX_HOME;
        const agentsRoot = myHome ? path.dirname(path.dirname(myHome)) : '';
        sid = agentsRoot ? pickResumableSession(walked, (s) => !!findCodexHomeForSession(s, agentsRoot)) : sid;
        const ownerHome = agentsRoot && sid ? findCodexHomeForSession(sid, agentsRoot) : null;
        if (!ownerHome || !sid) {
          console.warn('[resume] no recorded codex session found in any agent CODEX_HOME - starting fresh');
          resumeNotFound = true;
        } else {
          if (ownerHome !== myHome) opts.env = { ...opts.env ?? {}, CODEX_HOME: ownerHome };
          const args = opts.args ?? [];
          if (args[0] !== rsub) { opts.args = [rsub, sid, ...args]; didResume = true; }
          console.log('[resume] codex resume', sid, 'in', ownerHome);
        }
      }
    }
    if (opts.requireResume === true && !didResume) {
      return { ok: false, error: 'Existing session could not be resumed; no replacement process was started.', ...resumeNotFound ? { resumeNotFound: true } : {} };
    }
    if (opts.hive?.id) {
      ptyToAgent.set(opts.id, opts.hive.id);
      try { restoreGate()?.release?.(opts.hive.id); } catch (e) { console.error('[restore-gate] release failed:', e); }
      workerWake()?.noteSpawn?.(opts.id);
    }
    if (claudeProvider) { try { ensureClaudePermissionsAccepted(opts.cwd); } catch {} }
    const nonInteractiveEnv = nonInteractiveEnvForProvider(provider);
    if (Object.keys(nonInteractiveEnv).length > 0) opts.env = { ...opts.env ?? {}, ...nonInteractiveEnv };
    if (opts.hive && (provider === 'opencode' || provider === 'crush' || provider === 'pi' || provider === 'qwen')) {
      const cfg = readConfig();
      const extra = {};
      const modelIdx = (opts.args ?? []).indexOf('--model');
      const modelSlug = modelIdx >= 0 ? opts.args?.[modelIdx + 1] ?? '' : '';
      const prefix = modelSlug.includes('/') ? modelSlug.split('/')[0].toLowerCase() : '';
      const PREFIX_BACKEND = { anthropic: 'anthropic', openai: 'openai', google: 'google', gemini: 'google', groq: 'groq', openrouter: 'openrouter' };
      const scoped = PREFIX_BACKEND[prefix];
      const backends = scoped ? [scoped] : Object.keys(ib.BACKEND_KEY_ENV);
      for (const backend of backends) {
        const key = ib.getSecret(ib.providerKeyRef(backend));
        if (!key) continue;
        extra[ib.BACKEND_KEY_ENV[backend]] = key;
        if (backend === 'google') extra.GOOGLE_GENERATIVE_AI_API_KEY = key;
      }
      extra.HIVE_AUTO_APPROVE = cfg.autoMode ? '1' : '0';
      if (provider === 'opencode') {
        const oc = { autoupdate: false };
        if (cfg.autoMode) oc.permission = { edit: 'allow', bash: 'allow', webfetch: 'allow' };
        const baseUrl = cfg.providerBaseUrls?.opencode;
        if (baseUrl) {
          const localModel = (prefix === 'local' && modelSlug.slice(6)) || 'local';
          oc.provider = { local: { npm: '@ai-sdk/openai-compatible', name: 'Local (self-hosted)', options: { baseURL: baseUrl }, models: { [localModel]: { name: localModel } } } };
        }
        extra.OPENCODE_CONFIG_CONTENT = JSON.stringify(oc);
      }
      opts.env = { ...opts.env ?? {}, ...extra };
    }
    if (opts.hive) {
      const custom = ib.customSecretEnv(ib.customSecretNames(ib.listSecretRefs()), ib.getSecret, opts.env ?? {});
      if (Object.keys(custom).length > 0) opts.env = { ...opts.env ?? {}, ...custom };
    }
    if (provider === 'codex' && opts.hive?.id) await enableCodexRemoteForSpawn(opts, opts.hive.id);
    const wait = slowSpawnDelayMs(process.env.MD_RESTORE_SLOW_MS, ++restoreSlowSeq, app.isPackaged);
    ctx.restoreSlowSeq = restoreSlowSeq;
    if (wait > 0) {
      console.log(`[dev] MD_RESTORE_SLOW_MS: spawn ${opts.id} waits ${wait} ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (opts.hive) opts.env = { ...opts.env ?? {}, ...brokerGrants()?.grant(opts.id, opts.env?.AGENT_DIR) };
    const res = ptyManager.spawn(opts, owner);
    if (!res.ok && opts.hive) brokerGrants()?.release(opts.id);
    if (res.ok) analytics.track('agent_spawned', { provider });
    else analytics.track('agent_spawn_failed', { provider, reason: spawnFailReason(res.error) });
    if (res.ok) { loginWatcher.track(opts.id, provider); ptyOwners.set(opts.id, owner); }
    if (res.ok) {
      const wt = worktreePaths.get(opts.id);
      agentRuns.set(opts.id, {
        opts: { ...asGiven, ...wt ? { cwd: wt, isolate: false } : {}, installNow: undefined, guidedSetup: undefined },
        owner, provider, printMode: isPrintModeRun(provider, opts.args ?? []), startedAt: Date.now(),
      });
    } else agentRuns.delete(opts.id);
    syncKeepAwake();
    const worktreePath = worktreePaths.get(opts.id);
    return { ...res, cwd: opts.cwd, ...worktreePath ? { worktreePath } : {}, ...resumeNotFound ? { resumeNotFound: true } : {}, ...didResume ? { resumed: true } : {}, ...seedPrompt ? { seedPrompt } : {} };
  }
  ctx.spawnAgentCore = spawnAgentCore;
  ctx.ptyForAgent = (agentId) => { for (const [ptyId, aid] of ptyToAgent) if (aid === agentId) return ptyId; return null; };

  // verbatim natural-exit teardown (ref ~32093)
  ptyManager.setExitHandler?.((id, exitCode, info) => {
    try {
      const dyingAgent = ptyToAgent.get(id);
      if (dyingAgent) {
        hive()?.recordAgentExit?.(dyingAgent, { exitCode, signal: info?.signal, tail: info?.tail, command: info?.command });
      }
    } catch (e) { console.error('[pty] recordAgentExit failed:', e); }
    const inSetup = pendingCliSetup.get(id);
    if (inSetup && inSetup.state.phase === 'manual') return;
    if (inSetup && inSetup.state.phase === 'signin' && inSetup.state.login === 'running') {
      inSetup.state = { ...inSetup.state, login: exitCode === 0 ? 'done' : 'failed' };
      sendCliSetup(id, inSetup.owner, inSetup.state);
      loginWatcher.forget(id);
      closeLoginModal(id, inSetup.owner, exitCode === 0 ? 'success' : 'failure');
      return;
    }
    const pending = pendingInstallRelaunch.get(id);
    if (pending) {
      void (async () => {
        const provider = pending.opts.provider ?? inferAgentProvider(pending.opts.command, undefined);
        if (exitCode === 0) { ptyManager.forgetLookups(); await launchEnvReady(); }
        if (!installEndStillWanted({ armed: pending, armedNow: pendingInstallRelaunch.get(id), guided: !!pending.opts.guidedSetup, setupPhase: pendingCliSetup.get(id)?.state.phase })) return;
        pendingInstallRelaunch.delete(id);
        if (exitCode === 0 && ptyManager.isCommandAvailable(pending.bin)) {
          analytics.track('agent_install_finished', { provider, rung: pending.rung, outcome: 'agent_launched' });
          pendingCliMissing.delete(id);
          if (!pending.opts.guidedSetup) {
            sendToOwnerOrLive(id, `pty:relaunch:${id}`, undefined, pending.owner);
            void spawnAgentCore({ ...pending.opts, noAutoInstall: true }, pending.owner);
            return;
          }
          const state = { phase: 'signin', provider, label: installInfoForProvider(provider).label, loginCommand: loginCommandLine(pending.bin, provider) };
          pendingCliSetup.set(id, { opts: pending.opts, owner: pending.owner, state });
          sendCliSetup(id, pending.owner, state);
          runLoginStep(id);
          return;
        }
        analytics.track('agent_install_finished', { provider, rung: pending.rung, outcome: 'install_failed' });
        endCliSetup(id);
        sendCliSetup(id, pending.owner, null);
        const paused = pendingCliMissing.get(id);
        if (paused) {
          paused.state = { ...paused.state, failed: { exitCode: exitCode || 1, tail: installerTail(info?.tail) } };
          sendCliMissing(id, pending.owner, paused.state);
        }
      })().catch((e) => console.error('[pty] install end failed:', e));
      return;
    }
    const run = agentRuns.get(id);
    agentRuns.delete(id);
    let signInOffer = null;
    if (run && ptyToAgent.has(id) && !run.opts.hive?.isGod && !liveWorkers.has(id)) {
      const o = offerSignInAfterExit({ provider: run.provider, exitCode: exitCode ?? 0, signal: info?.signal, ranMs: Date.now() - run.startedAt, tail: info?.tail ?? '' });
      if (o.offer) signInOffer = { line: o.line };
    }
    try {
      const goneAgent = ptyToAgent.get(id);
      if (goneAgent) liveWebContents()?.send('hive:agentExited', { agentId: goneAgent, exitCode, signal: info?.signal, ...run?.printMode ? { printMode: true } : {} });
    } catch {}
    try {
      const endedAgent = ptyToAgent.get(id);
      const startedAt = info?.startedAt;
      if (endedAgent && typeof startedAt === 'number') {
        const provider = inferAgentProvider(undefined, hive()?.registry?.().agents[endedAgent]?.provider);
        analytics.track('agent_run_ended', { provider, duration_bucket: runDurationBucket(Date.now() - startedAt), ended_reason: runEndReason(exitCode, info?.signal) });
      }
    } catch (e) { console.error('[pty] agent_run_ended failed:', e); }
    if (signInOffer) teardownPty(id, 'revive');
    else teardownPty(id, 'exit');
    if (signInOffer && run) {
      const bin = run.opts.command.trim().split(/\s+/)[0] || run.opts.command;
      const state = { phase: 'signin', provider: run.provider, label: installInfoForProvider(run.provider).label, loginCommand: loginCommandLine(bin, run.provider), cause: 'exit', ...signInOffer.line ? { authLine: signInOffer.line } : {} };
      pendingCliSetup.set(id, { opts: run.opts, owner: run.owner, state });
      sendCliSetup(id, run.owner, state);
    }
  });

  function runLoginStep(id) {
    const entry = pendingCliSetup.get(id);
    if (!entry) return;
    const bin = entry.opts.command.trim().split(/\s+/)[0] || entry.opts.command;
    const binPath = ptyManager.commandPath(bin) ?? bin;
    const loginArgs = providerLoginArgs(entry.state.provider);
    if (loginArgs) {
      entry.state = { ...entry.state, login: 'running' };
      sendCliSetup(id, entry.owner, entry.state);
    }
    void spawnAgentCore({
      ...entry.opts, noAutoInstall: true, isolate: false, resume: false,
      loginScript: loginArgs ? buildLoginScript(binPath, loginArgs, entry.state.label, process.platform) : '',
    }, entry.owner).then((r) => {
      if (r.signedIn) { void startAgentAfterSetup(id); return; }
      const cur = pendingCliSetup.get(id);
      if (cur !== entry || !loginArgs || r.ok) return;
      cur.state = { ...cur.state, login: 'failed' };
      sendCliSetup(id, cur.owner, cur.state);
    });
  }
  function startAgentAfterSetup(id) {
    const setup = endCliSetup(id);
    if (!setup) return { ok: false, error: 'nothing-to-start' };
    loginWatcher.forget(id);
    ptyManager.kill(id);
    if (setup.state.login === 'running') closeLoginModal(id, setup.owner, 'failure');
    sendCliSetup(id, setup.owner, null);
    sendToOwnerOrLive(id, `pty:relaunch:${id}`, undefined, setup.owner);
    const { installNow: _i, guidedSetup: _g, loginScript: _l, manualSetup: _m, ...opts } = setup.opts;
    if (setup.state.phase === 'manual') {
      ptyManager.forgetLookups();
      return spawnAgentCore({ ...opts, noAutoInstall: false }, setup.owner);
    }
    return spawnAgentCore({ ...opts, noAutoInstall: true }, setup.owner);
  }
  function openManualSetup(id) {
    const setup = pendingCliSetup.get(id);
    const missing = pendingCliMissing.get(id);
    let opts, owner, state;
    if (setup && setupCanGoManual(setup.state)) {
      const bin = setup.opts.command.trim().split(/\s+/)[0] || setup.opts.command;
      const binPath = ptyManager.commandPath(bin) ?? bin;
      const binName = bin.split('/').pop() || bin;
      endCliSetup(id);
      ({ opts, owner } = setup);
      state = { phase: 'manual', provider: setup.state.provider, label: setup.state.label, loginCommand: null, manual: { reason: 'signin', command: binName } };
      opts = { ...opts, loginScript: buildManualSetupScript({ reason: 'signin', label: state.label, binName, shown: binName, exec: binPath }, process.platform) };
    } else if (missing && !pendingCliSetup.has(id) && missing.state.provider !== 'custom' && (missing.state.command ?? missing.state.manualCommand)) {
      const command = missing.state.command ?? missing.state.manualCommand;
      pendingCliMissing.delete(id);
      ({ opts, owner } = missing);
      state = { phase: 'manual', provider: missing.state.provider, label: missing.state.label, loginCommand: null, manual: { reason: 'install', command } };
      opts = { ...opts, loginScript: buildManualSetupScript({ reason: 'install', label: state.label, binName: missing.state.bin, shown: command, exec: command }, process.platform) };
    } else {
      return { ok: false, error: 'nothing-to-set-up' };
    }
    loginWatcher.forget(id);
    ptyManager.kill(id);
    pendingInstallRelaunch.delete(id);
    if (setup?.state.login === 'running') closeLoginModal(id, owner, 'failure');
    sendToOwnerOrLive(id, `pty:relaunch:${id}`, undefined, owner);
    pendingCliSetup.set(id, { opts: { ...opts, manualSetup: true }, owner, state });
    sendCliSetup(id, owner, state);
    void spawnAgentCore({ ...opts, manualSetup: true, noAutoInstall: true, isolate: false, resume: false }, owner).then((r) => {
      if (!r.ok) console.error('[cli-setup] manual terminal did not start:', r.error);
    });
    return { ok: true };
  }

  // ── handlers ────────────────────────────────────────────────────────────
  ipcMain.handle('pty:spawn', async (evt, opts) => {
    if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
      return { ok: false, error: 'invalid SpawnOptions' };
    }
    const owner = BrowserWindow.fromWebContents(evt.sender)?.webContents ?? null;
    return spawnAgentCore(opts, owner);
  });
  ipcMain.handle('pty:loginAct', async (_evt, payload) => {
    const p = payload ?? {};
    if (typeof p.id !== 'string') return { ok: false, error: 'invalid id' };
    const prompt = loginWatcher.current(p.id);
    if (p.action === 'dismiss') { loginWatcher.dismiss(p.id); return { ok: true }; }
    if (!prompt) return { ok: false, error: 'no-prompt' };
    if (p.action === 'open-link') {
      if (!prompt.trusted || prompt.recipe !== 'provider' || !loginHostAllowed(prompt.provider, prompt.url)) return { ok: false, error: 'link-not-vouched' };
      await shell.openExternal(prompt.url);
      return { ok: true };
    }
    if (p.action === 'paste') {
      if (typeof p.text !== 'string' || !p.text.trim()) return { ok: false, error: 'text required' };
      const code = p.text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      return ptyManager.write(p.id, code + '\r');
    }
    return { ok: false, error: 'unknown action' };
  });
  ipcMain.handle('pty:installCli', async (_evt, id) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    const paused = pendingCliMissing.get(id);
    if (!paused) return { ok: false, error: 'nothing-to-install' };
    const bin = paused.opts.command.trim().split(/\s+/)[0] || paused.opts.command;
    await launchEnvReady();
    if (ptyManager.isCommandAvailable(bin)) {
      pendingCliMissing.delete(id);
      sendToOwnerOrLive(id, `pty:relaunch:${id}`, undefined, paused.owner);
      return spawnAgentCore({ ...paused.opts, noAutoInstall: true }, paused.owner);
    }
    if (paused.state.rung === 'manual') {
      sendCliMissing(id, paused.owner, paused.state);
      return { ok: true, cwd: paused.opts.cwd, cliMissing: paused.state };
    }
    return spawnAgentCore({ ...paused.opts, installNow: true, guidedSetup: true }, paused.owner);
  });
  ipcMain.handle('pty:cliMissingState', (_evt, id) => typeof id === 'string' ? pendingCliMissing.get(id)?.state ?? null : null);
  ipcMain.handle('pty:cliSetupState', (_evt, id) => typeof id === 'string' ? pendingCliSetup.get(id)?.state ?? null : null);
  ipcMain.handle('pty:cliSetupStart', async (_evt, id, opts) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    const setup = pendingCliSetup.get(id);
    if (!setup) return { ok: false, error: 'nothing-to-start' };
    if (setup.state.phase === 'installing') return { ok: false, error: 'still-installing' };
    const anyway = opts === 'anyway';
    if (!setupCanStart(setup.state) && !(anyway && setupCanStartAnyway(setup.state))) return { ok: false, error: 'not-signed-in' };
    return startAgentAfterSetup(id);
  });
  ipcMain.handle('pty:cliSetupManual', (_evt, id) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    return openManualSetup(id);
  });
  ipcMain.handle('pty:cliSetupLogin', (_evt, id) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    const setup = pendingCliSetup.get(id);
    if (!setup || setup.state.phase !== 'signin' || setup.state.login === 'running' || !setup.state.loginCommand) return { ok: false, error: 'nothing-to-run' };
    runLoginStep(id);
    return { ok: true };
  });
  ipcMain.handle('pty:write', (_evt, id, data) => {
    if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
    if (/[\r\n]/.test(data)) loginWatcher.pastLogin(id);
    return ptyManager.write(id, data);
  });
  ipcMain.handle('pty:resize', (_evt, id, cols, rows) => {
    if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
    return ptyManager.resize(id, cols, rows);
  });
  ipcMain.handle('pty:redraw', (_evt, id) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    return ptyManager.redraw(id);
  });
  ipcMain.handle('pty:kill', (_evt, id, why) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
    const reason = reasonFromRenderer(why);
    const res = ptyManager.kill(id);
    teardownPty(id, reason);
    pendingInstallRelaunch.delete(id);
    endCliSetup(id);
    agentRuns.delete(id);
    return res;
  });
  ipcMain.handle('pty:list', () => ptyManager.list());
  ipcMain.on('terminal:probe:reply', (_evt, msg) => terminalProbes.reply(msg?.id, msg));

  const ptySubmitter = ctx.ptySubmitter ??= new PtySubmitter({
    write: (id, data) => {
      if (/[\r\n]|\u001b\[13u/.test(data)) loginWatcher.pastLogin(id);
      return ptyManager.write(id, data);
    },
    info: (id) => ptyManager.info(id),
    probe: (id, grid) => terminalProbes.request((rid) => ptyManager.sendToOwner(id, 'terminal:probe', { id: rid, ptyId: id, cols: grid.cols, rows: grid.rows })),
    proof: ctx.harness?.hooks?.proof,
    inputHeld: (agentId) => !!agentId && !!workerWake()?.holdsInput?.(agentId),
    claudeVersion: async (id) => {
      const bin = ptyManager.info(id)?.command;
      return bin ? ctx.claudeVersionOnce?.(bin, ptyManager.childEnv()) ?? null : null;
    },
    log: (e) => { try { hive()?.appendLog?.(e); } catch {} },
  });
  ipcMain.handle('pty:submit', async (_evt, req) => {
    const r = req ?? {};
    if (typeof r.ptyId !== 'string' || typeof r.text !== 'string' || typeof r.provider !== 'string' || typeof r.source !== 'string' || !SUBMIT_SOURCES.has(r.source)) {
      return { ok: false, error: 'invalid args' };
    }
    try {
      const result = await ptySubmitter.submit({
        ptyId: r.ptyId,
        agentId: ptyToAgent.get(r.ptyId) ?? (typeof r.agentId === 'string' ? r.agentId : undefined),
        provider: r.provider, text: r.text, source: r.source,
        settleMs: typeof r.settleMs === 'number' && r.settleMs >= 0 ? Math.min(r.settleMs, 1e4) : undefined,
        pressOnly: r.pressOnly === true,
        idle: r.idle !== false,
      });
      return { ok: true, result };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
}

module.exports = { register };
