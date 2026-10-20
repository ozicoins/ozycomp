'use strict';
/**
 * Auto-updater — verbatim port of the reference updater block
 * (index.js ~4301-4704). electron-updater is optional: packaged builds use it
 * when installed, everything else falls back to a notify-only check against
 * the releases site's channel yamls. Status is a reduced state machine —
 * a higher rank never gets stomped by a lower one unless the version moved.
 *
 * Electron seams (app, ipcMain, shell) are injected so the module is testable
 * outside Electron; loadAutoUpdater takes an optional importer override for
 * the same reason.
 */
const node_fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
// lazy seam — require('electron') throws outside Electron (unit tests),
// so the module binds lazily and tests inject a fake via _setElectron.
let electron = null;
function bindElectron() {
  if (!electron) electron = require('electron');
}

const SITE_URL = "https://app.harnessmd.com";
const RELEASES_URL = `${SITE_URL}/releases`;
const RELEASES_PAGE_URL = `${SITE_URL}/download`;
function installerUrl(version, platform, arch) {
  const v = version.replace(/^v/, "");
  const file = platform === "darwin" ? `OzyComp-${v}-mac-universal.dmg` : platform === "win32" ? `OzyComp-${v}-win-x64-setup.exe` : `OzyComp-${v}-linux-x86_64.AppImage`;
  return `${RELEASES_URL}/${file}`;
}
function releaseNotesUrl(version) {
  return `${RELEASES_URL}/notes-v${version.replace(/^v/, "")}.md`;
}
function channelFile(platform) {
  return platform === "darwin" ? "latest-mac.yml" : platform === "win32" ? "latest.yml" : "latest-linux.yml";
}
function channelVersion(yaml) {
  const m = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(yaml);
  return m ? m[1] : null;
}
function parseVersion(v) {
  const m = String(v ?? "").trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function isNewer(candidate, current2) {
  const a = parseVersion(candidate);
  const b = parseVersion(current2);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}
function shouldShowReleaseDrop(previous, current2) {
  if (previous === current2) return false;
  if (previous === null) return true;
  return !isNewer(previous, current2);
}
function clampPercent(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}
function rank(s) {
  switch (s.state) {
    case "idle":
      return 0;
    case "checking":
      return 1;
    case "not-available":
      return 1;
    case "error":
      return 1;
    case "just-updated":
      return 1;
    case "available-manual":
      return 2;
    case "available":
      return 3;
    case "downloading":
      return 4;
    case "downloaded":
      return 5;
  }
}
function versionOf(s) {
  return "version" in s ? s.version : null;
}
function reduceStatus(prev, next) {
  if (!prev) return next;
  const pv = versionOf(prev);
  const nv = versionOf(next);
  if (pv && nv && isNewer(nv, pv)) return next;
  if (pv && nv && pv !== nv) return next;
  return rank(next) >= rank(prev) ? next : prev;
}
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1e3;
const FALLBACK_CACHE_MS = 60 * 60 * 1e3;
let sendTo = null;
let started = false;
let lastFallbackCheck = 0;
let lastStatus = null;
let pendingRestart = null;
function abortPendingRestart() {
  if (!pendingRestart) return;
  const resolve = pendingRestart;
  pendingRestart = null;
  logLine("quitAndInstall cancelled by the user at the quit warning");
  resolve({ ok: false, error: "cancelled" });
}
function failPendingRestart(error) {
  if (!pendingRestart) return;
  const resolve = pendingRestart;
  pendingRestart = null;
  resolve({ ok: false, error });
}
function logLine(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${msg}
`;
  console.log("[updater]", msg);
  try {
    const dir = electron.app.getPath("userData");
    node_fs.mkdirSync(dir, { recursive: true });
    node_fs.appendFileSync(path.join(dir, "updater.log"), line);
  } catch {
  }
}
function emit(status) {
  lastStatus = reduceStatus(lastStatus, status);
  try {
    sendTo?.()?.send("update:status", lastStatus);
  } catch {
  }
}
function autoUpdateEnabled() {
  try {
    return require('./config').readConfig().autoUpdate !== false;
  } catch {
    return true;
  }
}
let autoUpdaterPromise = null;
let importElectronUpdater = (ns) => import(ns ?? "electron-updater");
async function loadAutoUpdater() {
  autoUpdaterPromise ??= (async () => {
    const ns = await importElectronUpdater();
    const found = ns.autoUpdater ?? ns.default?.autoUpdater;
    if (!found) throw new Error("electron-updater loaded but exposes no `autoUpdater` export");
    return found;
  })();
  try {
    return await autoUpdaterPromise;
  } catch (e) {
    autoUpdaterPromise = null;
    throw e;
  }
}
function errText(e) {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 300 ? `${m.slice(0, 300)}…` : m;
}
const fetchServerTextReal = (url, done) => {
  let settled = false;
  const finish2 = (text) => {
    if (!settled) {
      settled = true;
      done(text);
    }
  };
  try {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": "ozycomp-updater", Accept: "text/plain, text/markdown, application/x-yaml" },
        timeout: 1e4
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          res.resume();
          finish2(void 0);
          return;
        }
        let body2 = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          body2 += d;
          if (body2.length > 262144) {
            req.destroy();
            finish2(void 0);
          }
        });
        res.on("end", () => finish2(body2));
      }
    );
    req.on("error", () => finish2(void 0));
    req.on("timeout", () => {
      req.destroy();
      finish2(void 0);
    });
    req.end();
  } catch {
    finish2(void 0);
  }
};
let fetchServerText = fetchServerTextReal;
function fetchReleaseBody(version, done) {
  fetchServerText(releaseNotesUrl(version), done);
}
function fallbackCheck(reason, force = false) {
  const now = Date.now();
  if (!force && now - lastFallbackCheck < FALLBACK_CACHE_MS) return;
  lastFallbackCheck = now;
  fetchServerText(`${RELEASES_URL}/${channelFile(process.platform)}`, (yaml) => {
    const version = yaml ? channelVersion(yaml) : null;
    if (!version || !isNewer(version, electron.app.getVersion())) return;
    fetchReleaseBody(version, (notes) => {
      emit({
        state: "available-manual",
        version,
        url: RELEASES_PAGE_URL,
        reason,
        downloadUrl: installerUrl(version, process.platform, process.arch),
        notes
      });
    });
  });
}
const CHECK_TIMEOUT_MS = 3e4;
function withTimeout(p, ms2, label) {
  return new Promise((resolve, reject) => {
    const timer2 = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms2 / 1e3)}s`)), ms2);
    p.then(
      (v) => {
        clearTimeout(timer2);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer2);
        reject(e);
      }
    );
  });
}
async function runCheck() {
  emit({ state: "checking" });
  try {
    const result = await withTimeout(
      loadAutoUpdater().then((autoUpdater) => autoUpdater.checkForUpdates()),
      CHECK_TIMEOUT_MS,
      "update check"
    );
    if (!result || !isNewer(result.updateInfo.version, electron.app.getVersion())) {
      emit({ state: "not-available" });
    }
    return { ok: true };
  } catch (e) {
    const message = errText(e);
    logLine(`native check failed: ${message}`);
    emit({ state: "error", message });
    fallbackCheck(message);
    return { ok: false, error: message };
  }
}
async function runDownload() {
  try {
    const autoUpdater = await loadAutoUpdater();
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (e) {
    const message = errText(e);
    logLine(`download failed: ${message}`);
    emit({ state: "error", message });
    fallbackCheck(message);
    return { ok: false, error: message };
  }
}
const DEFAULT_DROP_HTML = `<style>
  html, body { height: 100%; }
  body { overflow: hidden; }
  .stage { height: 100%; }
  .pg { position: absolute; opacity: 0; pointer-events: none; }

  .page { display: none; height: 100%; flex-direction: column;
          padding: clamp(24px, 4vw, 46px); }
  #pg1:checked ~ .stage .p1,
  #pg2:checked ~ .stage .p2,
  #pg3:checked ~ .stage .p3,
  #pg4:checked ~ .stage .p4,
  #pg5:checked ~ .stage .p5,
  #pg6:checked ~ .stage .p6 { display: flex; animation: rise .34s cubic-bezier(.2,.7,.3,1) both; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  .content { flex: 1; min-height: 0; overflow-y: auto; }
  .center { display: flex; flex-direction: column; justify-content: center; }
  .nav { flex-shrink: 0; display: flex; align-items: center; gap: 12px;
         padding-top: 16px; margin-top: 12px; border-top: 1px solid var(--line); }
  .dots { display: flex; gap: 7px; flex: 1; }
  .dot { width: 7px; height: 7px; border-radius: 999px; background: rgba(20,19,26,.16);
         cursor: pointer; transition: background .2s, transform .2s; }
  .dot:hover { background: rgba(20,19,26,.34); }
  .dot.on { background: var(--accent); transform: scale(1.25); }
  .btn { cursor: pointer; border-radius: 999px; font-size: 13.5px; font-weight: 600;
         padding: 9px 18px; border: 1px solid var(--line); color: var(--ink-soft);
         user-select: none; transition: background .16s, color .16s; }
  .btn:hover { background: rgba(20,19,26,.04); }
  .btn.primary { background: var(--ink); border-color: var(--ink); color: #FBFAF8; }
  .btn.primary:hover { background: #2a2733; }

  .kicker { font-size: 11.5px; font-weight: 700; letter-spacing: .14em;
            text-transform: uppercase; color: var(--accent); margin: 0 0 14px; }
  h1 { font-size: clamp(1.8rem, 4.4vw, 2.7rem); }
  .lede { margin-bottom: 1.4em; }
  .big { font-size: clamp(3.2rem, 10vw, 5.4rem); line-height: .92; letter-spacing: -.045em;
         font-weight: 700; margin: 0 0 .1em;
         background: linear-gradient(135deg, #14131A 20%, #1B7F5A 115%);
         -webkit-background-clip: text; background-clip: text; color: transparent; }
  .stat { display: flex; gap: 24px; flex-wrap: wrap; margin-top: 24px;
          padding-top: 18px; border-top: 1px solid var(--line); }
  .stat b { display: block; font-size: 1.5rem; letter-spacing: -.03em; font-weight: 680; }
  .stat span { font-size: 12px; color: var(--ink-soft); }

  .tag { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .1em;
         text-transform: uppercase; color: var(--accent);
         background: rgba(27,127,90,.09); padding: 4px 9px; border-radius: 999px; }
  .quote { border-left: 2px solid var(--accent); padding-left: 15px; margin: 18px 0 0;
           color: var(--ink-soft); font-size: 14.5px; }
  .rows { list-style: none; padding: 0; margin: 0; }
  .rows li { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: baseline;
             padding: 7px 0; border-bottom: 1px solid var(--line); font-size: 13.5px; }
  .rows i { font-style: normal; font-size: 10px; font-weight: 700; letter-spacing: .09em;
            text-transform: uppercase; color: var(--ink-soft); }
  .rows b { font-weight: 620; }
  .rows p { margin: 1px 0 0; color: var(--ink-soft); font-size: 12.5px; }
  .card { border: 1px solid var(--line); border-radius: var(--radius); padding: 16px 18px; }
  .card h2 { margin: 10px 0 .2em; font-size: 1.15rem; }
  .card p { margin: 0; color: var(--ink-soft); font-size: 13.5px; }
  .split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  /* 16:10, not 4:3 — the taller ratio pushed the second row past the fold, and a
     drop page that scrolls cuts a sentence in half at the boundary. */
  .split .placeholder { aspect-ratio: 16 / 10; }
</style>

<input class="pg" type="radio" name="pg" id="pg1" checked>
<input class="pg" type="radio" name="pg" id="pg2">
<input class="pg" type="radio" name="pg" id="pg3">
<input class="pg" type="radio" name="pg" id="pg4">
<input class="pg" type="radio" name="pg" id="pg5">
<input class="pg" type="radio" name="pg" id="pg6">

<div class="stage">

  <section class="page p1">
    <div class="content center">
      <p class="kicker">OzyComp</p>
      <h1 class="big">0.4.4</h1>
      <p class="lede" style="font-size:clamp(1.05rem,2.1vw,1.3rem);margin-top:.5em">
        The release where Windows finally joined the floor — and the first run
        stopped quietly failing.
      </p>
      <div class="stat">
        <div><b>27</b><span>fixes</span></div>
        <div><b>4</b><span>new surfaces</span></div>
        <div><b>1</b><span>platform unbroken</span></div>
      </div>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot on" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn primary" for="pg2">Start &rarr;</label>
    </div>
  </section>

  <section class="page p2">
    <div class="content">
      <p class="kicker">The headline</p>
      <h1>Agents can talk to each other on Windows.</h1>
      <p class="lede">Roughly half of all downloads run on Windows, where
      agent-to-agent messaging had never worked at all.</p>
      <div class="placeholder" data-label="Two agents messaging" style="aspect-ratio:24/9"></div>
      <p class="quote">Every agent booted, rendered, and looked completely healthy.
      None of them had been told they had an inbox.</p>
      <p style="margin-top:16px;color:var(--ink-soft);font-size:14px">Any CLI that is
      not an .exe was launched through cmd.exe, which cuts a multi-line argument at
      its first newline — taking the protocol block with it. Spawns now launch the
      real interpreter with an argument array, so the whole prompt survives.</p>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot on" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg1">&larr; Back</label>
      <label class="btn primary" for="pg3">Next &rarr;</label>
    </div>
  </section>

  <section class="page p3">
    <div class="content">
      <p class="kicker">The first five minutes</p>
      <h1>Setup finishes. The floor wakes up.</h1>
      <p class="lede">Four separate bugs sat on the very first thing a new user does.</p>
      <ul class="rows">
        <li><i>Wizard</i><div><b>The suggested folder works</b>
          <p>Accepting ~/HarnessAgents stored a literal tilde and died on ENOENT.
          It now resolves to a real path — and the field actually suggests it.</p></div></li>
        <li><i>Wizard</i><div><b>It tells you at step one</b>
          <p>An empty folder used to walk you through all four steps before bouncing
          you back. The panel no longer overflows a short screen either.</p></div></li>
        <li><i>Hive</i><div><b>Services start at setup, not next launch</b>
          <p>On a fresh install the message router, hooks and telemetry stayed dead
          until you restarted — so mail never moved and agents never reported.</p></div></li>
        <li><i>Agents</i><div><b>Restart &amp; Continue has something to resume</b>
          <p>The live session id is recorded from a second source, so continuing
          works even when a hook never lands.</p></div></li>
      </ul>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot on" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg2">&larr; Back</label>
      <label class="btn primary" for="pg4">Next &rarr;</label>
    </div>
  </section>

  <section class="page p4">
    <div class="content">
      <p class="kicker">New</p>
      <h1>Four things that were not here before.</h1>
      <div class="split">
        <div class="card">
          <span class="tag">Skills</span>
          <h2>Every skill your agents can use</h2>
          <p>What is installed across Claude Code, OpenCode and Codex — and a
          browsable catalog of 227 more, with search, filters, install and
          uninstall.</p>
        </div>
        <div class="card">
          <span class="tag">Prerequisites</span>
          <h2>Whether you actually have the tools</h2>
          <p>MemPalace, uv, git and every agent engine, with live status and where
          each one sits on disk. One button asks Michael to fill in the gaps.</p>
        </div>
        <div class="card">
          <span class="tag">Release drops</span>
          <h2>This page</h2>
          <p>Update notes used to be three clipped bullets in the corner. A release
          can now carry its own designed page, and you are reading the first one.</p>
        </div>
        <div class="card">
          <span class="tag">Dark mode</span>
          <h2>Rebuilt for reading</h2>
          <p>Every control border measured under 2:1 against its background, so the
          edges defining them were invisible. Re-tuned and measured, not eyeballed.</p>
        </div>
      </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot on" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg3">&larr; Back</label>
      <label class="btn primary" for="pg5">Next &rarr;</label>
    </div>
  </section>

  <section class="page p5">
    <div class="content">
      <p class="kicker">Everything else</p>
      <h1>The rest of the list.</h1>
      <ul class="rows">
        <li><i>Terminal</i><div><b>Copy comes back clean</b>
          <p>The quote rail is stripped and terminals run in UTF-8, so an em dash
          survives the trip to another app.</p></div></li>
        <li><i>Terminal</i><div><b>Dictation pastes what you just said</b></div></li>
        <li><i>IDE</i><div><b>Images open as images</b>
          <p>PNG, SVG and embedded screenshots render. The title names the agent.</p></div></li>
        <li><i>Agents</i><div><b>Restart &amp; Continue revives a dead agent</b></div></li>
        <li><i>Agents</i><div><b>Grok 4.6 in the model picker</b></div></li>
        <li><i>Agents</i><div><b>OpenCode runs the model you actually have</b></div></li>
        <li><i>Board</i><div><b>Task cards stop going missing</b></div></li>
        <li><i>Hive</i><div><b>A wake nudge survives an odd message id</b></div></li>
        <li><i>Hive</i><div><b>Compact fires once, not every hour</b></div></li>
        <li><i>Hive</i><div><b>The cost ledger is out of your git history</b></div></li>
        <li><i>Office</i><div><b>The floor stops rendering when nobody is looking</b></div></li>
        <li><i>Layout</i><div><b>Michael sits first on the dock again</b></div></li>
      </ul>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot on" for="pg5"></label><label class="dot" for="pg6"></label>
      </div>
      <label class="btn" for="pg4">&larr; Back</label>
      <label class="btn primary" for="pg6">Next &rarr;</label>
    </div>
  </section>

  <section class="page p6">
    <div class="content center">
      <p class="kicker">One last thing</p>
      <h1 style="font-size:clamp(1.9rem,4.6vw,2.9rem)">Thank you for running this
      on your own machine.</h1>
      <p class="lede" style="margin-top:.4em">Every agent here starts on your
      hardware, in your folders, under your keys. Nothing about that changes.</p>
      <p class="quote">If it has been useful, a star is the entire marketing budget.
      The button is just below this page.</p>
    </div>
    <div class="nav">
      <div class="dots">
        <label class="dot" for="pg1"></label><label class="dot" for="pg2"></label>
        <label class="dot" for="pg3"></label><label class="dot" for="pg4"></label>
        <label class="dot" for="pg5"></label><label class="dot on" for="pg6"></label>
      </div>
      <label class="btn" for="pg5">&larr; Back</label>
      <label class="btn" for="pg1">Start over</label>
    </div>
  </section>

</div>`;


const SIMULATED_NOTES = `# OzyComp v9.9.9

**A local hive of Claude Code, Antigravity, Codex, Grok & Copilot agents that run themselves** —
messaging, routing, and remembering, coordinated by your clone, Michael, who you talk to.

---

## What's new in 9.9.9 — *simulated release*

**On Windows, agents were never told they could message each other.** They started, rendered, and
looked perfectly healthy — but a multi-line prompt handed to a CLI through \`cmd.exe\` is cut off at
its first newline.

- **Agent-to-agent messaging works on Windows.** Prompt-carrying spawns now run the CLI's real
  interpreter directly instead of routing through \`cmd.exe\`, so the whole protocol survives.
- **Setup can finish again.** Accepting the suggested \`~/HarnessAgents\` folder wrote a literal
  \`~\`, and the wizard then died on \`ENOENT: mkdir '~/HarnessAgents'\`.
- **Copying from a terminal is clean.** The Edit menu was intercepting ⌘C before the terminal saw it.
- **Agent terminals are UTF-8.** They ran with no locale at all.`;
function initAutoUpdater(getWebContents) {
  bindElectron();
  sendTo = getWebContents;
  electron.ipcMain.handle("update:restartAndInstall", async () => {
    if (pendingRestart) return { ok: false, error: "a restart is already in progress" };
    try {
      const autoUpdater = await loadAutoUpdater();
      logLine("quitAndInstall requested by the user");
      const cancelled = new Promise((resolve) => {
        pendingRestart = resolve;
      });
      autoUpdater.quitAndInstall();
      return await cancelled;
    } catch (e) {
      pendingRestart = null;
      const error = errText(e);
      logLine(`quitAndInstall failed: ${error}`);
      emit({ state: "error", message: error });
      return { ok: false, error };
    }
  });
  electron.ipcMain.handle("update:checkNow", async () => {
    if (!electron.app.isPackaged) return { ok: false, error: "dev build — updates are only checked in packaged apps" };
    return runCheck();
  });
  electron.ipcMain.handle("update:download", async () => {
    if (!electron.app.isPackaged) return { ok: false, error: "dev build — updates are only downloaded in packaged apps" };
    return runDownload();
  });
  electron.ipcMain.handle("update:current", () => lastStatus ?? { state: "idle" });
  electron.ipcMain.handle("update:simulate", (_evt, opts) => {
    if (electron.app.isPackaged) return { ok: false, error: "simulate is dev-only" };
    const o = opts ?? {};
    const version = typeof o.version === "string" && o.version ? o.version : "9.9.9";
    const notes = typeof o.notes === "string" ? o.notes : o.drop === true ? `<!-- drop -->
${DEFAULT_DROP_HTML}
<!-- /drop -->` : SIMULATED_NOTES;
    emit(o.state === "downloaded" ? { state: "downloaded", version, notes } : { state: "available-manual", version, notes, url: RELEASES_PAGE_URL, downloadUrl: installerUrl(version, process.platform, process.arch) });
    logLine(`SIMULATED ${o.state === "downloaded" ? "downloaded" : "available-manual"} ${version} (dev only)`);
    return { ok: true };
  });
  const previewPath = process.env.MD_DROP_PREVIEW;
  if (!electron.app.isPackaged && previewPath) {
    try {
      const notes = node_fs.readFileSync(previewPath, "utf8");
      const m = notes.match(/what[’']?s\s+new\s+in\s+v?(\d+\.\d+\.\d+)/i) ?? notes.match(/\bv(\d+\.\d+\.\d+)\b/);
      const version = m?.[1] ?? "9.9.9";
      emit({ state: "available-manual", version, notes, url: RELEASES_PAGE_URL, downloadUrl: installerUrl(version, process.platform, process.arch) });
      logLine(`SIMULATED available-manual ${version} from MD_DROP_PREVIEW=${previewPath} (dev only)`);
    } catch (e) {
      logLine(`MD_DROP_PREVIEW unreadable: ${errText(e)}`);
    }
  }
  if (!previewPath) {
    try {
      const stampFile = path.join(electron.app.getPath("userData"), "last-run-version");
      let previous = null;
      try {
        previous = node_fs.readFileSync(stampFile, "utf8").trim() || null;
      } catch {
      }
      const current2 = electron.app.getVersion();
      let stamped = false;
      if (previous !== current2) {
        try {
          node_fs.mkdirSync(electron.app.getPath("userData"), { recursive: true });
          node_fs.writeFileSync(stampFile, current2 + "\n", "utf8");
          stamped = true;
        } catch (e) {
          logLine(`last-run-version stamp failed: ${errText(e)}`);
        }
      }
      if (stamped && shouldShowReleaseDrop(previous, current2)) {
        logLine(`first run of ${current2} (previous ${previous ?? "none"}); fetching its release page`);
        fetchReleaseBody(current2, (notes) => {
          emit({ state: "just-updated", version: current2, notes });
          logLine(`just-updated ${current2} ${notes ? "with" : "without"} release notes`);
        });
      }
    } catch (e) {
      logLine(`post-update check failed: ${errText(e)}`);
    }
  }
  electron.ipcMain.handle("update:openRelease", (_evt, url) => {
    const href = typeof url === "string" ? url : RELEASES_PAGE_URL;
    if (!href.startsWith(`${SITE_URL}/`)) return { ok: false };
    const asset = /\/releases\/OzyComp-([0-9][^/]*?)-(?:mac|win|linux)[^/]*$/.exec(href);
    if (asset) logLine(`manual download opened: ${asset[1]}`);
    void electron.shell.openExternal(href);
    return { ok: true };
  });
  if (!electron.app.isPackaged) return;
  if (started) return;
  started = true;
  void (async () => {
    try {
      const autoUpdater = await loadAutoUpdater();
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.on("update-available", (info) => {
        logLine(`update available: ${info.version}`);
        emit({ state: "available", version: info.version, notes: typeof info.releaseNotes === "string" ? info.releaseNotes : void 0 });
      });
      autoUpdater.on("download-progress", (p) => {
        const version = lastStatus && "version" in lastStatus ? lastStatus.version : electron.app.getVersion();
        emit({ state: "downloading", version, percent: clampPercent(p.percent) });
      });
      autoUpdater.on("update-downloaded", (info) => {
        logLine(`update downloaded: ${info.version} — waiting for the user to restart`);
        emit({ state: "downloaded", version: info.version, notes: typeof info.releaseNotes === "string" ? info.releaseNotes : void 0 });
      });
      autoUpdater.on("error", (err) => {
        const message = errText(err);
        logLine(`native updater error: ${message}`);
        emit({ state: "error", message });
        failPendingRestart(message);
        fallbackCheck(message);
      });
      logLine(`native updater ready (current v${electron.app.getVersion()})`);
    } catch (e) {
      const message = errText(e);
      logLine(`electron-updater unavailable; notify-only mode: ${message}`);
      emit({ state: "error", message });
    }
    const tick = () => {
      if (autoUpdateEnabled()) void runCheck();
    };
    setTimeout(tick, 3e4);
    setInterval(tick, CHECK_INTERVAL_MS);
  })();
}

module.exports = {
  SITE_URL, RELEASES_URL, RELEASES_PAGE_URL,
  installerUrl, releaseNotesUrl, channelFile, channelVersion,
  parseVersion, isNewer, shouldShowReleaseDrop, clampPercent,
  reduceStatus, errText, fetchServerText, fetchReleaseBody,
  fallbackCheck, runCheck, runDownload, initAutoUpdater,
  abortPendingRestart, failPendingRestart, autoUpdateEnabled,
  CHECK_INTERVAL_MS, FALLBACK_CACHE_MS, CHECK_TIMEOUT_MS,
  SIMULATED_NOTES, DEFAULT_DROP_HTML,
  // test seams — the reference has none; ours swap the two untestable edges.
  _setElectron(ns) { electron = ns; },
  _setImporter(fn) { importElectronUpdater = fn ?? ((ns) => import(ns ?? "electron-updater")); },
  _setFetcher(fn) { fetchServerText = fn ?? fetchServerTextReal; },
  _reset() { sendTo = null; started = false; lastStatus = null; pendingRestart = null; lastFallbackCheck = 0; autoUpdaterPromise = null; importElectronUpdater = (ns) => import(ns ?? "electron-updater"); fetchServerText = fetchServerTextReal; electron = null; },
  _state() { return { lastStatus, started, pendingRestart: pendingRestart !== null }; },
};
