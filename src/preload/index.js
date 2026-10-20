"use strict";
const electron = require("electron");
const api = {
  version: "0.5.5",
  // ─── Analytics ───────────────────────────────────────────────────────────
  /** Count ONE human-sent message (TELEMETRY.md → `message_sent`). Carries a
   *  surface name and nothing else — no text, no length, no agent id — and main
   *  accepts only 'terminal' and 'composer' here (steer and hive are counted in
   *  main, at their own handlers). Never awaited by callers and never allowed to
   *  throw: a telemetry hiccup must not break sending a message. */
  trackMessageSent: (surface) => electron.ipcRenderer.invoke("analytics:messageSent", surface).then(() => void 0, () => void 0),
  /** The two money-funnel events only the renderer can see: a purchase surface
   *  was drawn (`paywall_shown`) or a dead end was (`access_blocked`). See
   *  TELEMETRY.md for both. Every value is a closed enum re-checked in main,
   *  which drops the whole event rather than send an unrecognised one, so this
   *  bridge cannot widen the contract. Same never-throw rule as above: a
   *  telemetry hiccup must not break drawing the paywall. */
  trackFunnel: (event, props) => electron.ipcRenderer.invoke("analytics:funnel", event, props).then(() => void 0, () => void 0),
  // ─── PTY ─────────────────────────────────────────────────────────────────
  /** `cwd` in the result is the TILDE-EXPANDED absolute path main actually spawned
   *  into — the renderer stores that, not the raw `~/…` the user typed. */
  /** `cliMissing` (I2, 0.5.3): the engine binary is not installed, nothing was
   *  spawned, and the terminal draws the card; the agent still exists. */
  spawnPty: (opts) => electron.ipcRenderer.invoke("pty:spawn", opts),
  /** The card's button: run the install the card named in this terminal, or
   *  check again for a CLI installed by hand. The pty restarts alone. */
  installCli: (id) => electron.ipcRenderer.invoke("pty:installCli", id),
  writePty: (id, data) => electron.ipcRenderer.invoke("pty:write", id, data),
  resizePty: (id, cols, rows) => electron.ipcRenderer.invoke("pty:resize", id, cols, rows),
  redrawPty: (id) => electron.ipcRenderer.invoke("pty:redraw", id),
  /** `why` tells main who is ending it (0.5.3). Leave it out for a person
   *  stopping the agent. 'restart' and 'revive' keep the agent's worktree, since
   *  it is about to be started in it again; 'sweep' is a bulk teardown;
   *  'archive' is Pro's Archive button, which asks git so a work folder with
   *  uncommitted changes is kept. Main treats anything else as a person, so this
   *  can only make a kill safer. */
  killPty: (id, why) => electron.ipcRenderer.invoke("pty:kill", id, why),
  listPtys: () => electron.ipcRenderer.invoke("pty:list"),
  /** Type a message into an agent's terminal and submit it, through main's
   *  one serial submitter per terminal (autosend, 0.5.5). `ok: false` means the
   *  terminal is gone, never became ready, or a write failed. */
  submitToPty: (req) => electron.ipcRenderer.invoke("pty:submit", req),
  /** Main asks about one terminal while it submits: its screen (only when the
   *  terminal's grid equals the process grid `cols` by `rows`) and whether a
   *  person's draft or menu holds it. The answer goes back with the same id. */
  onTerminalProbe: (cb) => {
    const listener = (_e, req) => {
      let out = null;
      try {
        out = cb(req);
      } catch {
        out = null;
      }
      electron.ipcRenderer.send("terminal:probe:reply", { id: req.id, ...out ?? { lines: null, safe: false, pooled: true } });
    };
    electron.ipcRenderer.on("terminal:probe", listener);
    return () => electron.ipcRenderer.removeListener("terminal:probe", listener);
  },
  /** This window went off screen or came back (floor pause, 0.5.5): main sends
   *  it on minimize, restore, hide, show and focus, to this window only. */
  onWindowVisibility: (cb) => {
    const listener = (_e, v) => cb(v);
    electron.ipcRenderer.on("window:visibility", listener);
    return () => electron.ipcRenderer.removeListener("window:visibility", listener);
  },
  /** The first read of this window's visibility. Subscribe first, then ask. */
  getWindowVisibility: () => electron.ipcRenderer.invoke("window:getVisibility"),
  /** The last lines of one terminal for voice Michael (0.5.2). `rows` is what
   *  the renderer's terminal drew for this pty, or empty to let main read the
   *  pty's raw tail; main redacts and scrubs before answering. */
  voiceTerminal: (ptyId, rows, lines) => electron.ipcRenderer.invoke("voice:terminal", ptyId, rows, lines),
  /** Resolve a Claude session id to the cwd it originally ran in (Add Agent
   *  resume auto-fill), or null if the id is invalid/unknown. */
  resolveSessionCwd: (sessionId) => electron.ipcRenderer.invoke("session:resolveCwd", sessionId),
  onPtyData: (id, cb) => {
    const channel = `pty:data:${id}`;
    const listener = (_e, data) => cb(data);
    electron.ipcRenderer.on(channel, listener);
    return () => electron.ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (id, cb) => {
    const channel = `pty:exit:${id}`;
    const listener = (_e, info) => cb(info);
    electron.ipcRenderer.on(channel, listener);
    return () => electron.ipcRenderer.removeListener(channel, listener);
  },
  /** Fires when an agent is auto restart-and-continued into this SAME pty after a
   *  first-time engine-CLI install. The terminal should re-arm in place (clear the
   *  "process exited" line + re-enable input) so the relaunched CLI paints clean. */
  onPtyRelaunch: (id, cb) => {
    const channel = `pty:relaunch:${id}`;
    const listener = () => cb();
    electron.ipcRenderer.on(channel, listener);
    return () => electron.ipcRenderer.removeListener(channel, listener);
  },
  /** I2 part 2: the CLI in this pty printed its sign in prompt (a link, a
   *  code, a paste back, a key), or the sign in ended. */
  onPtyLogin: (id, cb) => {
    const channel = `pty:login:${id}`;
    const listener = (_e, e) => cb(e);
    electron.ipcRenderer.on(channel, listener);
    return () => electron.ipcRenderer.removeListener(channel, listener);
  },
  /** The modal's buttons. open-link opens the link MAIN read from the CLI,
   *  never one the renderer hands over; paste writes a code into the pty;
   *  dismiss closes the modal for this ask. */
  loginAct: (id, action, text) => electron.ipcRenderer.invoke("pty:loginAct", { id, action, text }),
  /** I2: this pty's engine CLI is not installed (or its install just failed);
   *  the terminal draws the card instead of a dead prompt. */
  onPtyCliMissing: (id, cb) => {
    const channel = `pty:cli-missing:${id}`;
    const listener = (_e, state) => cb(state);
    electron.ipcRenderer.on(channel, listener);
    return () => electron.ipcRenderer.removeListener(channel, listener);
  },
  /** F3: the push above misses a terminal that was not listening yet (an agent
   *  respawned at app start, a screen opened later). The pool asks once at
   *  acquire whether this pty is paused at the card. */
  cliMissingState: (id) => electron.ipcRenderer.invoke("pty:cliMissingState", id),
  /** Batch 2: installing, or signing in after the install. Null when setup is
   *  over (the agent started, the install failed back to the card). */
  onPtyCliSetup: (id, cb) => {
    const channel = `pty:cli-setup:${id}`;
    const listener = (_e, state) => cb(state);
    electron.ipcRenderer.on(channel, listener);
    return () => electron.ipcRenderer.removeListener(channel, listener);
  },
  cliSetupState: (id) => electron.ipcRenderer.invoke("pty:cliSetupState", id),
  /** "Setup complete, start agent": discards the login terminal and starts
   *  the agent fresh into the same pty. */
  cliSetupStart: (id, mode) => electron.ipcRenderer.invoke("pty:cliSetupStart", id, mode),
  /** "Sign in again" after a login that did not finish. */
  cliSetupLogin: (id) => electron.ipcRenderer.invoke("pty:cliSetupLogin", id),
  /** Batch 4: "Set up manually": a terminal with the agent's own environment
   *  and the provider's command in it (pty:cliSetupManual). */
  cliSetupManual: (id) => electron.ipcRenderer.invoke("pty:cliSetupManual", id),
  // ─── Dialog ──────────────────────────────────────────────────────────────
  chooseFolder: () => electron.ipcRenderer.invoke("dialog:chooseFolder"),
  // ─── Terminal.app ────────────────────────────────────────────────────────
  openTerminalAt: (cwd) => electron.ipcRenderer.invoke("terminal:openAtFolder", cwd),
  // ─── Clipboard ─────────────────────────────────────────────────────────────
  copyToClipboard: (text) => electron.ipcRenderer.invoke("app:copyToClipboard", text),
  /** Read the system clipboard as plain text ('' when empty/unreadable). */
  readClipboard: () => electron.ipcRenderer.invoke("app:readClipboard"),
  /** Clipboard text, read SYNCHRONOUSLY. Only for the terminal's paste shortcut,
   *  where an async read loses a race against dictation tools that restore the
   *  previous clipboard right after sending the paste key.
   *
   *  TRADEOFF, stated plainly because sendSync blocks the renderer until main
   *  answers: this app has a history of main-thread stalls (iCloud-evicted files
   *  wedging a spawnSync git call), and during such a stall this call freezes the
   *  paste keystroke rather than merely delaying it. Accepted because a clipboard
   *  read is a memory lookup with no I/O, and because the async alternative is
   *  measurably WRONG — it pastes the user's previous clipboard. Do not reach for
   *  sendSync elsewhere on this reasoning; it is justified by the race, not by
   *  convenience. */
  readClipboardSync: () => {
    try {
      return electron.ipcRenderer.sendSync("app:readClipboardSync") ?? "";
    } catch {
      return "";
    }
  },
  // ─── Config ──────────────────────────────────────────────────────────────
  /** Dev builds only: true when launched with `--no-god` / MD_NO_GOD=1, in
   *  which case useHive does not spawn the orchestrator. Always false packaged. */
  devNoGod: () => electron.ipcRenderer.invoke("dev:noGod"),
  getConfig: () => electron.ipcRenderer.invoke("config:get"),
  updateConfig: (patch) => electron.ipcRenderer.invoke("config:update", patch),
  /** Set or clear one per-agent token ceiling against main's latest config. */
  /** Create (no id) or update (id) one custom avatar. Main validates the
   *  recipe and merges against the config on disk; resolves to the full config. */
  saveAvatar: (input) => electron.ipcRenderer.invoke("config:saveAvatar", input),
  deleteAvatar: (id) => electron.ipcRenderer.invoke("config:deleteAvatar", id),
  setAgentTokenCap: (agentId, tokenCap) => electron.ipcRenderer.invoke("config:setAgentTokenCap", agentId, tokenCap),
  /** Grant or revoke one MCP server for one agent, or clear the row (null) so
   *  the agent follows the floor-wide default again. */
  setAgentMcp: (agentId, mcpId, enabled) => electron.ipcRenderer.invoke("config:setAgentMcp", agentId, mcpId, enabled),
  /** Tell main whether the floor is actually open or parked on the launch-time
   *  hive picker, so fleet.json / log.jsonl can say so (#595). Fire-and-forget. */
  reportFloorState: (state) => electron.ipcRenderer.send("floor:state", state),
  ensureHarnessHome: (path) => electron.ipcRenderer.invoke("config:ensureHome", path),
  /** Change the harness home folder. 'move' copies the existing hive + palace
   *  into the new folder (old kept as a safety net); 'fresh' just re-points and
   *  bootstraps an empty home. On success the app relaunches (never resolves);
   *  on failure (e.g. copy error) returns { ok: false, error }. */
  changeHome: (newHome, mode) => electron.ipcRenderer.invoke("config:changeHome", { newHome, mode }),
  // ─── Filesystem (sandboxed to cwd) ───────────────────────────────────────
  listDir: (root, rel) => electron.ipcRenderer.invoke("fs:listDir", root, rel),
  readFile: (root, rel) => electron.ipcRenderer.invoke("fs:readFile", root, rel),
  /** Raw bytes for files `readFile` refuses (images). The renderer has no way to
   *  load them off disk — the CSP allows no `file:` source and no file protocol
   *  is registered — so images travel as bytes and become a `blob:` URL in the
   *  renderer, which `img-src` already permits. Root-confined and size-capped in
   *  the main process; `mime` is derived from the extension. */
  readBinary: (root, rel) => electron.ipcRenderer.invoke("fs:readBinary", root, rel),
  writeFile: (root, rel, content) => electron.ipcRenderer.invoke("fs:writeFile", root, rel, content),
  /** v0.3.4: existence check for an absolute path (expands ~) — backs the
   *  terminal ⌘-click markdown flow. Metadata only, never contents. */
  statAbs: (p) => electron.ipcRenderer.invoke("fs:statAbs", p),
  /** Show a path in the OS file browser (Finder / Explorer / the Linux default).
   *  Backs ⌘-click on a terminal path we have no viewer for. Reveals only — main
   *  never launches a file's default application, because the path came from
   *  agent output. */
  revealPath: (p) => electron.ipcRenderer.invoke("fs:revealPath", p),
  /** Repo-wide text search (0.4.9 phase 9). Root-confined and bounded four
   *  ways in main; `truncated` says the answer is partial rather than letting
   *  a capped result read as the whole of it. */
  searchFiles: (root, query, opts) => electron.ipcRenderer.invoke("fs:search", root, query, opts ?? {}),
  /** New folder. Fails rather than succeeding silently on one that exists. */
  makeDir: (root, rel) => electron.ipcRenderer.invoke("fs:mkdir", root, rel),
  /** New empty file. Never truncates an existing one. */
  createFile: (root, rel) => electron.ipcRenderer.invoke("fs:createFile", root, rel),
  /** Rename or move inside the root. Both ends are confined, and it refuses to
   *  clobber: POSIX rename would silently replace the destination. */
  renamePath: (root, from, to) => electron.ipcRenderer.invoke("fs:rename", root, from, to),
  /** Delete to the OS bin, never permanently. Recoverable by the gesture the
   *  person already knows, because this is one row away from "open". */
  trashPath: (root, rel) => electron.ipcRenderer.invoke("fs:trash", root, rel),
  // ─── Git ─────────────────────────────────────────────────────────────────
  gitIsRepo: (cwd) => electron.ipcRenderer.invoke("git:isRepo", cwd),
  /** Absolute path of the MAIN working tree `cwd` belongs to — a linked worktree
   *  resolves to the original repo, not to itself. null when not a git repo. */
  gitMainRepo: (cwd) => electron.ipcRenderer.invoke("git:mainRepo", cwd),
  gitBranch: (cwd) => electron.ipcRenderer.invoke("git:branch", cwd),
  gitStatus: (cwd) => electron.ipcRenderer.invoke("git:status", cwd),
  gitLog: (cwd, n) => electron.ipcRenderer.invoke("git:log", cwd, n ?? 50),
  gitBranches: (cwd) => electron.ipcRenderer.invoke("git:branches", cwd),
  gitAheadBehind: (cwd) => electron.ipcRenderer.invoke("git:aheadBehind", cwd),
  /** Diff one repo-root-relative file: its HEAD content vs its working-tree content.
   *  Path-validated main-side against `cwd`; the renderer only ever gets the two
   *  text sides. Backs the IDE's git-diff (Monaco DiffEditor) view. */
  gitDiff: (cwd, relPath) => electron.ipcRenderer.invoke("git:diff", cwd, relPath),
  // ── v0.3.4: history / compare / checkout (git visualization) ──
  gitLogGraph: (cwd, n, skip) => electron.ipcRenderer.invoke("git:logGraph", cwd, n, skip ?? 0),
  gitCommitFiles: (cwd, sha) => electron.ipcRenderer.invoke("git:commitFiles", cwd, sha),
  gitShowFile: (cwd, rev, relPath) => electron.ipcRenderer.invoke("git:showFile", cwd, rev, relPath),
  gitCompareRefs: (cwd, base, head, mode) => electron.ipcRenderer.invoke("git:compareRefs", cwd, base, head, mode ?? "three"),
  gitWorktrees: (cwd) => electron.ipcRenderer.invoke("git:worktrees", cwd),
  /** 0.5.3, feature 24: every folder under the app's worktrees roots, read from
   *  the disk with no git, so it is instant. What a row holds and how big it is
   *  are asked one row at a time, so neither holds up the list. */
  listOwnedWorktrees: () => electron.ipcRenderer.invoke("worktrees:list"),
  /** Uncommitted files and unmerged commits, or null for a folder that is not a worktree. */
  worktreeWork: (path) => electron.ipcRenderer.invoke("worktrees:work", path),
  /** Bytes on disk, or null for a folder that is not in the list. */
  worktreeSize: (path) => electron.ipcRenderer.invoke("worktrees:size", path),
  /** `confirmed` only answers "it holds work, delete anyway". Main asks
   *  everything else again and refuses a running agent's folder whatever is sent. */
  removeOwnedWorktree: (path, confirmed) => electron.ipcRenderer.invoke("worktrees:remove", path, confirmed),
  gitCheckout: (cwd, ref, detach) => electron.ipcRenderer.invoke("git:checkout", cwd, ref, detach === true),
  // ─── Hive (multi-agent coordination) ─────────────────────────────────────
  hiveRegistry: () => electron.ipcRenderer.invoke("hive:registry"),
  /** Persist a hire/job role to hive registry.json + identity.md (no respawn). */
  hivePatchAgentRole: (id, role) => electron.ipcRenderer.invoke("hive:patchAgentRole", id, role),
  /** Rename an agent's display name. Its id, hive directory, and PTY are unchanged. */
  hiveRenameAgent: (id, name) => electron.ipcRenderer.invoke("hive:renameAgent", id, name),
  /** Put an agent on hold (the human has them 1:1) or take it off. Held agents
   *  keep running; Michael is told to stop routing work to them. */
  hiveSetAgentHold: (id, hold) => electron.ipcRenderer.invoke("hive:setAgentHold", id, hold),
  hiveBoard: () => electron.ipcRenderer.invoke("hive:board"),
  // ─── Dictate into any app (0.5.3, F16, macOS) ───────────────────────────
  /** What has focus in this window, for who takes a held Option (shared/dictationFocus). */
  dictationFocus: (focus) => {
    electron.ipcRenderer.send("dictation:focus", focus);
  },
  /** An in-app take's Stapler event (0.5.5 rc2, S1): main forwards it to the
   *  Stapler without sound and answers whether the sounds are on. */
  dictationInAppEvent: (e) => electron.ipcRenderer.invoke("dictation:inAppEvent", e),
  /** Whether the helper takes a held Option in this window (0.5.5 rc2, way C):
   *  armed on the Option hold, with Accessibility and the microphone. */
  dictationHelperReady: () => electron.ipcRenderer.invoke("dictation:helperReady"),
  onDictationHelperReady: (cb) => {
    const listener = (_e, ready) => cb(ready === true);
    electron.ipcRenderer.on("dictation:helperReady", listener);
    return () => electron.ipcRenderer.removeListener("dictation:helperReady", listener);
  },
  /** The window's own hold is taking the Option key now, so the helper leaves it. */
  dictationInAppHold: (on) => {
    electron.ipcRenderer.send("dictation:inAppHold", on);
  },
  /** One in-app take's timings for the hive log (rc2, S1b). Never the words. */
  dictationTake: (t) => {
    electron.ipcRenderer.send("dictation:take", t);
  },
  /** F16, every platform from 23 Sep: `reason` says why the switch is off
   *  (no-helper, wayland, floor); `transcriber` is the engine the loop would use. */
  anyAppStatus: () => electron.ipcRenderer.invoke("anyApp:status"),
  anyAppStart: (key, words) => electron.ipcRenderer.invoke("anyApp:start", key, words),
  anyAppStop: () => electron.ipcRenderer.invoke("anyApp:stop"),
  anyAppRequestMic: () => electron.ipcRenderer.invoke("anyApp:requestMic"),
  anyAppRequestAccessibility: () => electron.ipcRenderer.invoke("anyApp:requestAccessibility"),
  anyAppOpenSettings: (pane) => electron.ipcRenderer.invoke("anyApp:openSettings", pane),
  anyAppTestPaste: (text) => electron.ipcRenderer.invoke("anyApp:testPaste", text),
  onAnyAppEvent: (cb) => {
    const listener = (_e, ev) => cb(ev);
    electron.ipcRenderer.on("anyApp:event", listener);
    return () => electron.ipcRenderer.removeListener("anyApp:event", listener);
  },
  hiveTasks: () => electron.ipcRenderer.invoke("hive:tasks"),
  hiveTicketPrefix: () => electron.ipcRenderer.invoke("hive:ticketPrefix"),
  /** The archive ledger (hive/tasks-archive.json): cards the hourly hygiene
   *  sweep moved off the live ledger, newest first, each with archivedAt and
   *  archiveReason. Read only; the Archived chip on Tasks reads it. */
  hiveTasksArchive: () => electron.ipcRenderer.invoke("hive:tasksArchive"),
  hiveLog: (n) => electron.ipcRenderer.invoke("hive:log", n ?? 200),
  hiveMemory: (id) => electron.ipcRenderer.invoke("hive:memory", id),
  hiveInbox: (id) => electron.ipcRenderer.invoke("hive:inbox", id),
  /** The agent's absolute inbox directory, named in the wake nudge (#559). */
  hiveInboxPath: (id) => electron.ipcRenderer.invoke("hive:inboxPath", id),
  /** Voice read-layer: recent message CONTENT (inbox/outbox bodies), REDACTED in
   *  main. Pass { id } for one message, { agentId } to scope to one mailbox, or
   *  {} for the whole floor. Backs Realtime Michael's get_messages. The renderer
   *  never sees a raw body or a secret — stripping happens main-side. */
  hiveMessages: (opts) => electron.ipcRenderer.invoke("hive:messages", opts ?? {}),
  /** 0.5.3, F25, the Pro rail's badge: per agent, the mail it sent the person
   *  after the stamp given for it (ISO), as a count, the newest stamp and the
   *  first three texts. No stamp for an agent counts all of its mail. */
  hiveHumanMailSince: (since) => electron.ipcRenderer.invoke("hive:humanMailSince", since),
  /** The other side of the call (0.5.3, F16): whether this machine can record
   *  it, whether the grant is there, and where it would come from. The
   *  Settings row draws these; `systemAudioRequest` asks for the grant. */
  systemAudioStatus: () => electron.ipcRenderer.invoke("systemAudio:status"),
  /** Linux (PR 4): the puck tells main which monitor of the output PulseAudio
   *  or PipeWire lists, or null when none is; main answers status and the
   *  meeting's source from it. */
  systemAudioMonitor: (m) => {
    electron.ipcRenderer.send("systemAudio:monitor", m);
  },
  /** The meeting chord (0.5.3, F16): the chord in force, the platform's
   *  default, whether it is armed, and if not why (floor, not-available,
   *  no-tap, bad-key, register-failed, start-failed). */
  captureHotkeyStatus: () => electron.ipcRenderer.invoke("captureHotkey:status"),
  meetingHotkeyStatus: () => electron.ipcRenderer.invoke("meetingHotkey:status"),
  systemAudioRequest: () => electron.ipcRenderer.invoke("systemAudio:request"),
  systemAudioOpenSettings: () => electron.ipcRenderer.invoke("systemAudio:openSettings"),
  /** Consolidated per-agent directory (registry + telemetry + context), incl.
   *  archived agents. Backs Realtime Michael's get_agent_detail / list_agents. */
  hiveAgentDirectory: () => electron.ipcRenderer.invoke("hive:agentDirectory"),
  /** Item 5 (0.5.5): agent ids the PREVIOUS session left archived in the hive
   *  registry, read before the startup orphan sweep rewrote the flags. The
   *  restore gate refuses to start these. See src/shared/restoreGate.ts. */
  hiveArchivedAtBoot: () => electron.ipcRenderer.invoke("hive:archivedAtBoot"),
  // ─── Ephemeral workers (P4 — Slack-triggered isolated workers) ───────────
  /** Live ephemeral workers + worktrees preserved awaiting integration/GC. */
  listWorkers: () => electron.ipcRenderer.invoke("workers:list"),
  /** Manually stop a live ephemeral worker (safety-gated teardown; work preserved). */
  stopWorker: (workerId) => electron.ipcRenderer.invoke("workers:stop", workerId),
  /** The Temps ledger, newest first: one row per worker teardown. */
  workersHistory: () => electron.ipcRenderer.invoke("workers:history"),
  onWorkersHistoryUpdated: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("workers:historyUpdated", listener);
    return () => electron.ipcRenderer.removeListener("workers:historyUpdated", listener);
  },
  // ─── Semantic memory (MemPalace CLI) ─────────────────────────────────────
  memoryStatus: () => electron.ipcRenderer.invoke("hive:memoryStatus"),
  /** Which external tools (uv, mempalace, git, each agent engine) are actually
   *  present on this machine, with a platform-resolved install command each. */
  toolsStatus: () => electron.ipcRenderer.invoke("tools:status"),
  /** Settings hero payload — plan + sponsor, fetched from the repo and cached. */
  heroPayload: (force) => electron.ipcRenderer.invoke("hero:payload", force),
  /** The remote model catalog — the agent model presets, fetched from the repo
   *  and cached, so a new model needs a JSON edit rather than a release. A null
   *  catalog means the renderer keeps the list compiled into the build. */
  modelCatalog: (force) => electron.ipcRenderer.invoke("models:catalog", force),
  /** Skills already installed for the coding agents on this machine. */
  skillsLocal: (cwd) => electron.ipcRenderer.invoke("skills:local", cwd),
  /** The browsable skills catalog (cached; `force` re-fetches). */
  skillsCatalog: (force) => electron.ipcRenderer.invoke("skills:catalog", force),
  /** Install a catalog skill into ~/.claude/skills. `unsupported` distinguishes
   *  "there is no downloadable source" from "the download failed". */
  skillsInstall: (url, name) => electron.ipcRenderer.invoke("skills:install", url, name),
  /** Delete an installed skill. Main refuses any path outside a skills root. */
  skillsUninstall: (path) => electron.ipcRenderer.invoke("skills:uninstall", path),
  /** Show a skill's folder in the OS file manager. */
  skillsReveal: (path) => electron.ipcRenderer.invoke("skills:reveal", path),
  searchMemory: (query, wing) => electron.ipcRenderer.invoke("hive:searchMemory", query, wing),
  memoryWakeUp: (wing) => electron.ipcRenderer.invoke("hive:memoryWakeUp", wing),
  mineNow: () => electron.ipcRenderer.invoke("hive:mineNow"),
  /** Condense agent memory.md files (the janitor's missing half). With an id,
   *  condense that agent on demand; without, run a full threshold scan. Returns
   *  the per-agent outcomes ({ id, condensed, reason, oldBytes?, newBytes? }). */
  reflectNow: (id) => electron.ipcRenderer.invoke("memory:reflectNow", id),
  // ─── Enterprise Knowledge Graph (multimodal context for agents) ───────────
  kgStatus: () => electron.ipcRenderer.invoke("kg:status"),
  kgList: () => electron.ipcRenderer.invoke("kg:list"),
  kgSearch: (query, limit) => electron.ipcRenderer.invoke("kg:search", query, limit),
  kgGet: (id) => electron.ipcRenderer.invoke("kg:get", id),
  kgRemove: (id) => electron.ipcRenderer.invoke("kg:remove", id),
  /** Open an OS file picker and ingest the chosen artifacts in one round-trip. */
  kgAddFiles: () => electron.ipcRenderer.invoke("kg:addFiles"),
  /** Ingest explicit file paths (e.g. drag-and-drop). */
  kgIngestFiles: (paths, tags) => electron.ipcRenderer.invoke("kg:ingestFiles", { paths, tags }),
  // ─── Composer attachments (images + files, sent to agents by PATH) ─────────
  /** Open an OS picker for files and folders (0.5.3, I8); returns chosen
   *  absolute paths + names, a folder's name ending in "/". `want` picks the
   *  kind on Windows and Linux, which cannot mix them in one picker. */
  attachFiles: (want) => electron.ipcRenderer.invoke("dialog:attachFiles", want ?? "any"),
  /** Resolve a dropped File's absolute path (Electron 32 removed File.path). */
  pathForFile: (file) => electron.webUtils.getPathForFile(file),
  /** Write the current clipboard image to a temp PNG and return its path (paste-to-attach). */
  saveClipboardImage: () => electron.ipcRenderer.invoke("clipboard:saveImage"),
  /** Persist a dropped File that resolved to NO path — macOS file-promise
   *  sources (the Cmd Shift 5 screenshot thumbnail) can hand Chromium the
   *  bytes without a stable file on disk — so it can be attached by PATH. */
  saveDroppedFile: (name, bytes) => electron.ipcRenderer.invoke("drop:saveFile", name, bytes),
  // ─── File share (one local file, one public link, dead in an hour) ─────────
  // The cross MACHINE path for a file. `attachFiles` above hands an agent a
  // LOCAL PATH, which only works when it shares a filesystem with the sender;
  // this publishes the file on a tunnel link a teammate on another machine can
  // fetch, and the link expires one hour after it was made.
  //
  // The path travels ONE WAY and is a request, not a fact: main re-validates it
  // (absolute, a regular file, under the size cap) before anything is bound.
  // Nothing here ever returns a local path or a bare token; the token exists
  // only inside the URL, because a link without it cannot be a link.
  /** Publish one file for an hour. Refusals come back as a CODE the UI
   *  translates, never a sentence that could carry a path. */
  fileShareCreate: (filePath) => electron.ipcRenderer.invoke("fileShare:create", filePath),
  /** Live shares, newest first. Already swept, so an expired one is never in it. */
  fileShareList: () => electron.ipcRenderer.invoke("fileShare:list"),
  /** Kill one link early. Deletes NOTHING on disk: a share is a link, not a copy. */
  fileShareRevoke: (id) => electron.ipcRenderer.invoke("fileShare:revoke", id),
  // ─── Command history (SQLite — every prompt submitted to an agent) ─────────
  /** Record one submitted prompt. Fire-and-forget from the prompt-detection hook. */
  historyAdd: (entry) => electron.ipcRenderer.invoke("history:add", entry),
  /** Most-recent-first history, optionally scoped to one agent. */
  historyList: (agentId, limit) => electron.ipcRenderer.invoke("history:list", agentId, limit),
  /** Substring search over prompt text, most-recent-first. */
  historySearch: (query, limit) => electron.ipcRenderer.invoke("history:search", query, limit),
  hiveSend: (msg, from) => electron.ipcRenderer.invoke("hive:send", msg, from),
  onHiveHookEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:hookEvent", listener);
    return () => electron.ipcRenderer.removeListener("hive:hookEvent", listener);
  },
  /** v0.4.9 phase 2: the per agent activity digest main keeps from hook
   *  events (shared/activity.ts). Oldest first, at most `limit` entries. */
  agentActivity: (agentId, limit) => electron.ipcRenderer.invoke("hive:agentActivity", agentId, limit ?? 200),
  onAgentActivity: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:agentActivity", listener);
    return () => electron.ipcRenderer.removeListener("hive:agentActivity", listener);
  },
  /** Push-based context accounting from the status line: live tokens + the
   *  session's EXACT context-window size. Same pattern as onHiveHookEvent. */
  onHiveContextUpdate: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:contextUpdate", listener);
    return () => electron.ipcRenderer.removeListener("hive:contextUpdate", listener);
  },
  /** An agent's process ended on its own (0.5.3 feature 18). Floor wide, unlike
   *  `pty:exit:<id>`, which only a terminal that has been opened listens to. */
  onHiveAgentExited: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:agentExited", listener);
    return () => electron.ipcRenderer.removeListener("hive:agentExited", listener);
  },
  /** The model an agent is actually running, sent when it CHANGES (0.5.3 bug 2):
   *  read from Claude Code's status line and from Codex's hook payloads. */
  onHiveModelUpdate: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:modelUpdate", listener);
    return () => electron.ipcRenderer.removeListener("hive:modelUpdate", listener);
  },
  onHiveMessage: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:message", listener);
    return () => electron.ipcRenderer.removeListener("hive:message", listener);
  },
  /** An agent started without something it needs: its hooks cannot run on this
   *  machine, or its proxy bridge never bound (plan F, gate of #190 W2). Shown
   *  in the app by default; the native toast stays gated on notifications. */
  onHiveDegraded: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:degraded", listener);
    return () => electron.ipcRenderer.removeListener("hive:degraded", listener);
  },
  /** An agent's 1:1 hold changed, from any surface (0.5.3, F25). */
  onAgentHold: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:agentHold", listener);
    return () => electron.ipcRenderer.removeListener("hive:agentHold", listener);
  },
  /** Register a listener for hive tasks routed to non-Claude agents (e.g.
   *  Codex). Main emits this instead of bouncing; the renderer enqueues the
   *  raw text so the drain effect types it into the agent's REPL when idle. */
  onHiveEnqueue: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:enqueueToAgent", listener);
    return () => electron.ipcRenderer.removeListener("hive:enqueueToAgent", listener);
  },
  /** A MAIN-initiated agent spawn (e.g. a voice hire via rt-5) — the renderer adds
   *  the floor card from this descriptor since it didn't initiate the hire itself. */
  onHiveAgentSpawned: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:agentSpawned", listener);
    return () => electron.ipcRenderer.removeListener("hive:agentSpawned", listener);
  },
  /** A MAIN-initiated agent kill/archive (e.g. a voice kill via rt-5) — the renderer
   *  archives the floor card since it didn't initiate the kill itself. */
  onHiveAgentArchived: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:agentArchived", listener);
    return () => electron.ipcRenderer.removeListener("hive:agentArchived", listener);
  },
  /** Register a listener for terminal work-order handoffs (#53) — hive mail to a
   *  hookless provider that can't drain an inbox; the renderer types it into the
   *  agent's REPL as a work order. */
  onHiveTerminalHandoff: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("hive:terminalHandoff", listener);
    return () => electron.ipcRenderer.removeListener("hive:terminalHandoff", listener);
  },
  // ─── Shareable hires (deep link / file import) ────────────────────────────
  /** Fired when a validated hire manifest arrives via the ozycomp://
   *  deep link. The renderer opens the Add-Agent modal pre-filled — import
   *  never spawns anything by itself. */
  onHireImport: (cb) => {
    const listener = (_e, manifest) => cb(manifest);
    electron.ipcRenderer.on("hire:import", listener);
    return () => electron.ipcRenderer.removeListener("hire:import", listener);
  },
  /** Fired when a deep-linked manifest failed validation/fetch. */
  onHireError: (cb) => {
    const listener = (_e, info) => cb(info);
    electron.ipcRenderer.on("hire:error", listener);
    return () => electron.ipcRenderer.removeListener("hire:error", listener);
  },
  /** Signal readiness and pull any queued deep-linked manifests (cold-start
   *  links, links that arrived during load). Resolves the queued list. */
  drainPendingHires: () => electron.ipcRenderer.invoke("hire:drainPending"),
  /** Open a multi-file picker and validate every selected hire manifest. */
  importHireFiles: () => electron.ipcRenderer.invoke("hire:openFile"),
  // ─── Config changes ──────────────────────────────────────────────────────
  /** Fired whenever a setting is saved, with the full updated config. */
  onConfigChanged: (cb) => {
    const listener = (_e, config) => cb(config);
    electron.ipcRenderer.on("config:changed", listener);
    return () => electron.ipcRenderer.removeListener("config:changed", listener);
  },
  /** Another window (the puck) asked for Settings; App answers with the
   *  same `cth:open-settings` event the titlebar gear dispatches. */
  onOpenSettings: (cb) => {
    const listener = (_e, arg) => cb(arg ?? {});
    electron.ipcRenderer.on("settings:open", listener);
    return () => electron.ipcRenderer.removeListener("settings:open", listener);
  },
  // ─── Quit confirmation ───────────────────────────────────────────────────
  /** How many IDE files hold unsaved text, so quitting can say so. A count,
   *  never the text (review finding 15). */
  ideDirty: (unsaved) => {
    electron.ipcRenderer.send("ide:dirty", unsaved);
  },
  // ─── The detached IDE (0.5.5 rc2, Track D) ───────────────────────────────
  // One IDE window per office window, in that window's session. See
  // src/main/ideWindow.ts for the rules and shared/ideWindow.ts for the shapes.
  /** Move the IDE into its own window, with its unsaved buffers. */
  ideDetach: (handoff) => electron.ipcRenderer.invoke("ide:detach", handoff),
  /** An open while detached: the IDE window takes it and comes forward. */
  ideOpenIn: (req) => electron.ipcRenderer.invoke("ide:openIn", req),
  /** From the IDE window: move back, with the buffers. Resolves once the owner has them. */
  ideAttach: (handoff) => electron.ipcRenderer.invoke("ide:attach", handoff),
  /** The owner says it holds the buffers Attach sent; main then closes the IDE window. */
  ideAttachedAck: () => {
    electron.ipcRenderer.send("ide:attachedAck");
  },
  /** The IDE window, at boot: what came with the Detach, and its owner's agents. */
  ideHandoff: () => electron.ipcRenderer.invoke("ide:handoff"),
  /** The owner, at boot and after a reload: is its IDE in a window? */
  ideWindowState: () => electron.ipcRenderer.invoke("ide:state"),
  /** The owner locked: call its IDE window back, buffers and all. */
  ideRecall: () => electron.ipcRenderer.invoke("ide:recall"),
  /** The owner's agents, sent while detached. */
  ideAgents: (list) => {
    electron.ipcRenderer.send("ide:agents", list);
  },
  onIdeOpen: (cb) => {
    const listener = (_e, req) => cb(req);
    electron.ipcRenderer.on("ide:open", listener);
    return () => electron.ipcRenderer.removeListener("ide:open", listener);
  },
  /** The owner: the IDE came back, with its buffers, or null when the window went without them. */
  onIdeAttached: (cb) => {
    const listener = (_e, h) => cb(h);
    electron.ipcRenderer.on("ide:attached", listener);
    return () => electron.ipcRenderer.removeListener("ide:attached", listener);
  },
  /** The IDE window: its close button was pressed; hand the buffers over (Attach). */
  onIdeCollect: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("ide:collect", listener);
    return () => electron.ipcRenderer.removeListener("ide:collect", listener);
  },
  onIdeAgents: (cb) => {
    const listener = (_e, list) => cb(list);
    electron.ipcRenderer.on("ide:agents", listener);
    return () => electron.ipcRenderer.removeListener("ide:agents", listener);
  },
  onCloseRequested: (cb) => {
    const listener = (_e, info) => cb(info);
    electron.ipcRenderer.on("app:closeRequested", listener);
    return () => electron.ipcRenderer.removeListener("app:closeRequested", listener);
  },
  confirmClose: () => electron.ipcRenderer.invoke("app:confirmClose"),
  cancelClose: () => electron.ipcRenderer.invoke("app:cancelClose"),
  // ─── Power / wake (auto-revive wedged PTYs after sleep/lock) ────────────────
  /** Subscribe to the main-process power-resume signal; returns an unsubscribe
   *  fn. The main process catches up after a sleep/unlock and reports the PTY
   *  ids that wedged across it in `dead` — the renderer respawns ONLY those
   *  (empty `dead[]` = no-op). */
  onPowerResume: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("power:resume", listener);
    return () => electron.ipcRenderer.removeListener("power:resume", listener);
  },
  // ─── Multi-window floors ───────────────────────────────────────────────────
  /** New Floor (0.5.3, B21): asks main to open the picker in this window; the
   *  picker then calls floorOpen. Resolves { ok } once the ask is sent. */
  newFloor: () => electron.ipcRenderer.invoke("window:newFloor"),
  /** Main asks this window to show the New Floor picker (the File menu item,
   *  Cmd/Ctrl+Shift+N, or newFloor above). */
  onFloorPickerOpen: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("floor:pickerOpen", listener);
    return () => electron.ipcRenderer.removeListener("floor:pickerOpen", listener);
  },
  /** One word per remembered folder: free, current (this floor), held (another
   *  live floor, with its lock) or missing. */
  floorProbe: (paths) => electron.ipcRenderer.invoke("floor:probe", paths),
  /** Open a folder as a floor of its own. Refusals: current (this floor's own
   *  hive), held (another floor), same-data-dir, invalid, mkdir-failed,
   *  no-spawner (process per floor not in this build), spawn-failed. */
  floorOpen: (req) => electron.ipcRenderer.invoke("floor:open", req),
  // ─── Reset ─────────────────────────────────────────────────────────────────
  /** Wipe all hive data + the memory palace, reset config, and relaunch the app
   *  into onboarding. The process exits, so this promise never resolves. */
  resetAll: () => electron.ipcRenderer.invoke("app:resetAll"),
  // ─── Token telemetry (real usage + est. cost from CC transcripts) ──────────
  /** Sum input/output/cache tokens + estimated USD cost for an agent from its
   *  Claude Code transcripts (reconciler/fallback). Returns null for an invalid cwd. */
  agentUsage: (cwd) => electron.ipcRenderer.invoke("hive:agentUsage", cwd),
  /** Current context size (tokens) of an agent's live session, read from the
   *  last assistant message of its transcript. Null until the agent's hooks
   *  have fired at least once (the transcript path is learned from them). */
  agentContext: (agentId) => electron.ipcRenderer.invoke("hive:agentContext", agentId),
  // ─── Live telemetry (OTel collector — the usage-provider seam + spans) ──────
  /** Live cumulative usage for an agent (OTel-preferred, transcript fallback). */
  telemetryUsage: (agentId) => electron.ipcRenderer.invoke("telemetry:usage", agentId),
  /** Recent tool spans for an agent's waterfall (#7B.2). */
  telemetrySpans: (agentId) => electron.ipcRenderer.invoke("telemetry:spans", agentId),
  /** Cold-start backfill of all agents' usage + recent spans. */
  telemetrySnapshot: () => electron.ipcRenderer.invoke("telemetry:snapshot"),
  /** Subscribe to live telemetry pushes; returns an unsubscribe fn. */
  onTelemetryEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("telemetry:event", listener);
    return () => electron.ipcRenderer.removeListener("telemetry:event", listener);
  },
  // ─── Circuit breaker (Lane A #6 state → avatars/meter) ──────────────────────
  /** Subscribe to breaker-state changes; returns an unsubscribe fn. */
  onBreakerState: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("control:breakerState", listener);
    return () => electron.ipcRenderer.removeListener("control:breakerState", listener);
  },
  /** Push a breaker state to the renderer (Lane A's policy / interim glue calls this). */
  setBreakerState: (state) => electron.ipcRenderer.invoke("control:setBreakerState", state),
  // ─── Operator control over agents (#7C.1–7C.3) ──────────────────────────────
  /** Pause/unpause an agent — paused → its tool calls are denied at PreToolUse. */
  controlPause: (agentId, on) => electron.ipcRenderer.invoke("control:pause", agentId, on),
  /** Pause/resume automatic inbox and queued-message delivery for one agent. */
  controlAutoDelivery: (agentId, paused) => electron.ipcRenderer.invoke("control:autoDelivery", agentId, paused),
  /** Clear pause + halt so the agent can run again. */
  controlResume: (agentId) => electron.ipcRenderer.invoke("control:resume", agentId),
  /** Gate/ungate a specific tool for an agent (denied at PreToolUse). */
  controlGateTool: (agentId, tool, on) => electron.ipcRenderer.invoke("control:gateTool", agentId, tool, on),
  /** Queue a steer note — injected as context on the agent's next hook (#7C.2). */
  controlSteer: (agentId, text) => electron.ipcRenderer.invoke("control:steer", agentId, text),
  /** Request a graceful stop at the next hook boundary (#7C.3). */
  controlHalt: (agentId) => electron.ipcRenderer.invoke("control:halt", agentId),
  /** Cancel a pending stop-after-this-step (the #7C.3 halt is a toggle now).
   *  Clears ONLY the halt: a pause set alongside it stays set. */
  controlUnhalt: (agentId) => electron.ipcRenderer.invoke("control:unhalt", agentId),
  /** Read an agent's current control snapshot. */
  controlSnapshot: (agentId) => electron.ipcRenderer.invoke("control:snapshot", agentId),
  /** Subscribe to gate/deny events (a tool was blocked); returns unsubscribe fn. */
  onApprovalRequest: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("control:approvalRequest", listener);
    return () => electron.ipcRenderer.removeListener("control:approvalRequest", listener);
  },
  // ─── Task kanban (hive/tasks.json) ───────────────────────────────────────
  /** Atomically append one card against the latest main-process ledger. */
  hiveAddTask: (task) => electron.ipcRenderer.invoke("hive:addTask", task),
  /** Atomically patch one named card without replacing unrelated cards/fields. */
  hivePatchTask: (id, patch) => electron.ipcRenderer.invoke("hive:patchTask", id, patch),
  /** Patch many cards in one write and one commit; `applied` names the ones
   *  that were patched (a card that is gone is skipped). */
  hivePatchTasks: (patches) => electron.ipcRenderer.invoke("hive:patchTasks", patches),
  /** Atomically remove one named card from the latest main-process ledger. */
  hiveDeleteTask: (id) => electron.ipcRenderer.invoke("hive:deleteTask", id),
  // ─── Scheduled missions (recurring auto-dispatch) ──────────────────────────
  listMissions: () => electron.ipcRenderer.invoke("missions:list"),
  saveMissions: (missions) => electron.ipcRenderer.invoke("missions:save", missions),
  /** Fires when the scheduler stamps a mission's lastFiredAt (a beat/dispatch),
   *  so the SCHEDULES panel can refresh "last fired" without a reload. */
  onMissionsUpdated: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("missions:updated", listener);
    return () => electron.ipcRenderer.removeListener("missions:updated", listener);
  },
  /** Fires when an autoCompact mission ticks — the renderer queues a /compact
   *  per agent (deduped) and delivers it when each agent is idle. */
  onAutoCompact: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("mission:autoCompact", listener);
    return () => electron.ipcRenderer.removeListener("mission:autoCompact", listener);
  },
  // ─── Full-text search across hive files (board, tasks, memory) ─────────────
  textSearch: (q) => electron.ipcRenderer.invoke("hive:textSearch", q),
  // ─── GitHub issue ingestion (gh CLI) ───────────────────────────────────────
  /** List up to 30 open issues in the repo at `cwd` via the `gh` CLI. Returns
   *  `{ ok: false, error }` if `gh` is missing/unauthenticated or `cwd` isn't a repo. */
  githubIssues: (cwd) => electron.ipcRenderer.invoke("github:issues", cwd),
  // ─── GitHub CI status watcher (gh CLI) ─────────────────────────────────────
  /** List up to 5 recent CI (GitHub Actions) runs in the repo at `cwd` via the
   *  `gh` CLI. Returns `{ ok: false, error }` if `gh` is missing/unauthenticated,
   *  `cwd` isn't a repo, or the repo has no Actions. */
  githubCIRuns: (cwd) => electron.ipcRenderer.invoke("github:ciRuns", cwd),
  // ─── Desktop notifications ───────────────────────────────────────────────────
  /** Toggle native desktop notifications for agent lifecycle events. */
  setNotifications: (v) => electron.ipcRenderer.invoke("app:setNotifications", v),
  // ─── Reliability / OS integration (onboarding permissions step) ──────────────
  /** Open a System Settings deep-link (or https URL) in the OS handler. Main
   *  restricts the scheme; the renderer just points at the pane. */
  openExternal: (url) => electron.ipcRenderer.invoke("app:openExternal", url),
  /** Toggle macOS "Open at Login". Resolves to the resulting state (no prompt). */
  setLoginItem: (enabled) => electron.ipcRenderer.invoke("app:setLoginItem", enabled),
  // ─── Agent lifecycle (archival) ─────────────────────────────────────────────
  /** Archive/unarchive a hive agent in the registry. Closing a terminal tab
   *  archives it automatically via pty:kill; this is the explicit primitive. */
  hiveSetArchived: (id, archived) => electron.ipcRenderer.invoke("hive:setArchived", id, archived),
  // ─── Slack integration (Slack message → Michael's queue) ─────────────────────
  /** Register a listener for inbound Slack messages; returns an unsubscribe fn.
   *  The message carries the thread coordinates needed to reply in-thread. */
  onSlackMessage: (cb) => {
    const listener = (_e, msg) => cb(msg);
    electron.ipcRenderer.on("slack:incomingMessage", listener);
    return () => electron.ipcRenderer.removeListener("slack:incomingMessage", listener);
  },
  /** Start the Slack webhook server; returns the public tunnel URL to paste into
   *  the Slack app's Event Subscriptions → Request URL. */
  slackStart: () => electron.ipcRenderer.invoke("slack:start"),
  /** Stop the Slack webhook server + tunnel. */
  slackStop: () => electron.ipcRenderer.invoke("slack:stop"),
  /** Current connection state + last Request URL (so Settings can hydrate the
   *  "Connected" badge and re-show the persisted tunnel URL on reopen). */
  slackStatus: () => electron.ipcRenderer.invoke("slack:status"),
  /** Test the saved tokens without starting anything: `auth.test` with the bot
   *  token, and in socket mode `apps.connections.open` with the app token too.
   *
   *  `draft` is what the form has on screen, so a person can test the token they
   *  just pasted without saving it first. Tokens still only ever travel INTO
   *  main; nothing about one comes back, only the team, the bot's handle, the
   *  channels it is in, and what is still missing. */
  slackTest: (draft) => electron.ipcRenderer.invoke("slack:test", draft ?? {}),
  /** The Slack ledger, newest first: inbound thread messages and our posts. */
  slackHistory: () => electron.ipcRenderer.invoke("slack:history"),
  onSlackHistoryUpdated: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("slack:historyUpdated", listener);
    return () => electron.ipcRenderer.removeListener("slack:historyUpdated", listener);
  },
  /** Post a reply into a Slack thread (the bot token stays in main). Used for the
   *  renderer's immediate "queued" ack. */
  slackReply: (m) => electron.ipcRenderer.invoke("slack:reply", m),
  /** Absolute path to the bundled reply helper, for the office worker's
   *  end-of-run "post your summary back to Slack" instruction. */
  slackReplyScriptPath: () => electron.ipcRenderer.invoke("slack:replyScriptPath"),
  /** Persist Slack settings. Disabling, clearing the way's token, or changing
   *  the way (0.4.11: one at a time) stops whatever transport is running. */
  slackSetConfig: (patch) => electron.ipcRenderer.invoke("slack:setConfig", patch),
  // ─── Generic webhook + status API (POST → work, GET → status) ────────────────
  /** Start the generic webhook server; returns the public endpoint URL callers
   *  POST to (secret-gated) and GET a token's status from. */
  webhookStart: () => electron.ipcRenderer.invoke("webhook:start"),
  /** Stop the generic webhook server + tunnel. */
  webhookStop: () => electron.ipcRenderer.invoke("webhook:stop"),
  /** Current state + last endpoint URL (so Settings can hydrate the badge/URL). */
  webhookStatus: () => electron.ipcRenderer.invoke("webhook:status"),
  /** Mint + persist a fresh secret and return it for the user to copy. */
  webhookGenerateSecret: () => electron.ipcRenderer.invoke("webhook:generateSecret"),
  /** Persist webhook settings (and stop the server if disabled / secret cleared). */
  webhookSetConfig: (patch) => electron.ipcRenderer.invoke("webhook:setConfig", patch),
  // ─── Triggers: context (auto-compact / auto-clear) ──────────────────────────
  /** The two context rules (cadence + pressure gate + message), deep-filled. */
  getContextTrigger: () => electron.ipcRenderer.invoke("triggers:getContext"),
  /** Persist both rules and RE-ARM main's timers; resolves to what was stored
   *  (main clamps the cadence/percentages, so the echo is authoritative). */
  setContextTrigger: (cfg) => electron.ipcRenderer.invoke("triggers:setContext", cfg),
  /** Fires when a context rule comes due. `rule` rides along because main owns
   *  only the CADENCE — the renderer applies the per-agent pressure gate and
   *  queues the command for each agent that qualifies. */
  onContextTrigger: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("trigger:context", listener);
    return () => electron.ipcRenderer.removeListener("trigger:context", listener);
  },
  // ─── Triggers: webhook endpoints (many endpoints, one server + tunnel) ──────
  /** Every configured endpoint, enabled or not. */
  listWebhooks: () => electron.ipcRenderer.invoke("webhooks:list"),
  /** Replace the whole list; main normalises each row (a blank secret keeps the
   *  stored one, an unknown mode keeps the stored one) and hot-swaps the running
   *  server's endpoints WITHOUT a restart, so no other caller's URL changes. */
  saveWebhooks: (list) => electron.ipcRenderer.invoke("webhooks:save", list),
  /** Revoke one endpoint; resolves to the remaining list. */
  deleteWebhook: (id) => electron.ipcRenderer.invoke("webhooks:delete", id),
  /** Mint a 256-bit secret for the operator to paste into their caller. Not
   *  persisted until the endpoint carrying it is saved. */
  generateWebhookSecret: () => electron.ipcRenderer.invoke("webhooks:generateSecret"),
  /** 0.5.3 batch 3: an agent changed the webhook list (connection request). */
  onWebhooksChanged: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("webhooks:changed", listener);
    return () => electron.ipcRenderer.removeListener("webhooks:changed", listener);
  },
  /** 0.5.3: register a Telegram bot's webhook on one Telegram endpoint. The
   *  token is used once and not stored. */
  telegramSetWebhook: (id, botToken) => electron.ipcRenderer.invoke("telegram:setWebhook", { id, botToken }),
  /** Server state, the tunnel root, and each endpoint's full public URL (`url` is
   *  '' until a tunnel has come up). */
  webhooksStatus: () => electron.ipcRenderer.invoke("webhooks:status"),
  /** Start the webhook server again after a failed start (0.5.3). */
  webhooksRetry: () => electron.ipcRenderer.invoke("webhooks:retry"),
  // ─── Triggers: history ledger + approval gate ───────────────────────────────
  /** The whole ledger, newest first (both directions, both sources). */
  listTriggerHistory: () => electron.ipcRenderer.invoke("triggerHistory:list"),
  /** Answer a held message. 'approved' RELEASES it to the hive (card + god
   *  request, the same path an auto-allowed message takes); 'rejected' only flips
   *  the verdict. Deciding an already-decided entry is a no-op, never a second
   *  dispatch. Resolves to the updated row, or null when the id is gone. */
  decideTriggerHistory: (arg) => electron.ipcRenderer.invoke("triggerHistory:decide", arg),
  /** Wipe the ledger, or just one source's half of it. */
  clearTriggerHistory: (source) => electron.ipcRenderer.invoke("triggerHistory:clear", source),
  /** Fires whenever the ledger changes (an inbound arrived, a verdict landed, a
   *  reply was paired), so the history tab live-refreshes. */
  onTriggerHistoryUpdated: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("triggerHistory:updated", listener);
    return () => electron.ipcRenderer.removeListener("triggerHistory:updated", listener);
  },
  // ─── Free Flow (voice dictation → message queue) ─────────────────────────────
  /** Persist Free Flow settings (flag / Groq key / model). The Groq key is stored
   *  in main config; entry point B (hold-Option) is renderer-side, no hotkey here. */
  freeflowSetConfig: (patch) => electron.ipcRenderer.invoke("freeflow:setConfig", patch),
  /** Transcribe one captured audio clip via Groq (the key stays in main; only the
   *  audio bytes go in and the transcript comes back). Gated on the flag + a key. */
  freeflowTranscribe: (arg) => electron.ipcRenderer.invoke("freeflow:transcribe", arg),
  // ─── Dictation and meetings (0.5.3, F16): the local engines and their settings ──
  /** What can transcribe on this machine, which engine each mode gets, the
   *  whisper models on disk, and how many words reach each engine. */
  transcribeStatus: () => electron.ipcRenderer.invoke("transcribe:status"),
  /** Save part of the dictation block; main re-arms or disarms the any app key at once. */
  transcribeSetConfig: (patch) => electron.ipcRenderer.invoke("transcribe:setConfig", patch),
  /** Fetch a downloadable model (small 190 MB, turbo 574 MB) into userData; progress arrives on onTranscribeDownloadProgress. */
  transcribeDownloadModel: (id) => electron.ipcRenderer.invoke("transcribe:downloadModel", id),
  /** Stop the running model download; the part file stays for the next press. */
  transcribeCancelDownload: () => electron.ipcRenderer.invoke("transcribe:cancelDownload"),
  onTranscribeDownloadProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    electron.ipcRenderer.on("transcribe:downloadProgress", listener);
    return () => electron.ipcRenderer.removeListener("transcribe:downloadProgress", listener);
  },
  // ─── Integrations registry (Phase 2 — labeled REST endpoints via the secret broker) ──
  // Bridges the §6 IPC surface for the Settings UI. WRITE-ONLY secret contract end to
  // end: `integrationsList` returns records with secretRef redacted to `hasSecret`;
  // `integrationsSetSecret` takes a secret ONE WAY (never echoed); NO method ever
  // returns a secret value to the renderer. Method names match registryClient's
  // feature-detection (camelCase ↔ colon-channel), so its real path activates as-is.
  // Custom secrets (Keys & Secrets): names out, values in, never a value out.
  customSecretList: () => electron.ipcRenderer.invoke("customSecret:list"),
  customSecretSet: (req) => electron.ipcRenderer.invoke("customSecret:set", req),
  customSecretRemove: (name) => electron.ipcRenderer.invoke("customSecret:remove", name),
  integrationsList: () => electron.ipcRenderer.invoke("integrations:list"),
  integrationsTemplates: () => electron.ipcRenderer.invoke("integrations:templates"),
  integrationsUpsert: (record) => electron.ipcRenderer.invoke("integrations:upsert", record),
  integrationsSetSecret: (req) => electron.ipcRenderer.invoke("integrations:setSecret", req),
  integrationsRemove: (req) => electron.ipcRenderer.invoke("integrations:remove", req),
  integrationsTest: (req) => electron.ipcRenderer.invoke("integrations:test", req),
  // Per-CLI-provider BYOK keys — WRITE-ONLY. `providerKeySet` stores a backend key one
  // way (never echoed); `providerKeyHas` returns only a boolean; no method ever returns
  // the plaintext. Keys are materialized MAIN-ONLY at spawn.
  providerKeySet: (req) => electron.ipcRenderer.invoke("providerKey:set", req),
  providerKeyHas: (backend) => electron.ipcRenderer.invoke("providerKey:has", backend),
  providerKeyClear: (backend) => electron.ipcRenderer.invoke("providerKey:clear", backend),
  // Realtime Michael (voice orchestrator) — MAIN mints a short-lived EPHEMERAL token
  // from the BYOK OpenAI key; the real key NEVER crosses IPC. `realtimeHasOpenAiKey`
  // is a presence boolean only (gates the voice toggle, like providerKeyHas).
  realtimeHasOpenAiKey: () => electron.ipcRenderer.invoke("realtime:hasKey"),
  realtimeMintToken: (req) => electron.ipcRenderer.invoke("realtime:mintToken", req ?? {}),
  // rt-5 voice ACTIONS — the renderer holds NO policy; main (realtimeActions.ts) owns
  // the tiering, two-step verbal confirm, hard allowlist, and michael-voice
  // attribution. These just forward {verb,...args} and speak back `spoken`.
  realtimeAction: (payload) => electron.ipcRenderer.invoke("realtime:action", payload),
  realtimeActionConfirm: (req) => electron.ipcRenderer.invoke("realtime:action:confirm", req),
  realtimeActionCancel: () => electron.ipcRenderer.invoke("realtime:action:cancel"),
  // rt-12 completion seam — a voice-dispatched task finished. `summary` is the
  // human-speakable line Michael relays; the rest is context for a toast/log.
  onRealtimeCompletion: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("realtime:completion", listener);
    return () => electron.ipcRenderer.removeListener("realtime:completion", listener);
  },
  /** Tell main whether a live voice session is open (drives queue-vs-push for completions). */
  realtimeSetSessionLive: (live) => electron.ipcRenderer.invoke("realtime:setSessionLive", live),
  /** Drain completions that arrived while no session was open (warm-start catch-up). */
  realtimeDrainCompletions: () => electron.ipcRenderer.invoke("realtime:drainCompletions"),
  /** Block until a tracked task completes (or times out) — backs the wait_for tool. */
  realtimeWaitFor: (taskId, timeoutMs) => electron.ipcRenderer.invoke("realtime:waitFor", taskId, timeoutMs),
  /** v0.3.4: coalesced floor deltas pushed while a voice session is live — the
   *  renderer injects them into the conversation as silent items. */
  onRealtimeFloorDelta: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("realtime:floorDelta", listener);
    return () => electron.ipcRenderer.removeListener("realtime:floorDelta", listener);
  },
  /** v0.3.4: main-staged queue insertions (voice clear_context) — the renderer
   *  enqueues so delivery rides every existing safety gate. */
  onRealtimeEnqueue: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("realtime:enqueue", listener);
    return () => electron.ipcRenderer.removeListener("realtime:enqueue", listener);
  },
  /** v0.3.4: app self-knowledge — version + newest changelog sections. */
  appInfo: () => electron.ipcRenderer.invoke("app:info"),
  // ─── Roster mirror (agents + notes + queues, shared dev ↔ packaged) ─────────
  /** Read the roster file beside the hive. SYNCHRONOUS on purpose: the zustand
   *  store is created at module load, so an async read would arrive after the
   *  first render and the floor would flash empty. One blocking round trip at
   *  boot. `null` = no file (or unreadable) — the caller then uses localStorage. */
  rosterReadSync: () => {
    try {
      return electron.ipcRenderer.sendSync("roster:readSync") ?? null;
    } catch {
      return null;
    }
  },
  /** Which hive is open, synchronously — same boot-time constraint as
   *  `rosterReadSync`, and read in the same breath: the store has to know which
   *  hive its localStorage keys belong to before it decides to trust them. */
  harnessHomeSync: () => {
    try {
      return electron.ipcRenderer.sendSync("config:homeSync") ?? null;
    } catch {
      return null;
    }
  },
  /** Mirror the roster to disk. Debounced by the caller; main keeps the previous
   *  contents as a backup and refuses a first write that would empty a full file. */
  rosterWrite: (snap) => electron.ipcRenderer.invoke("roster:write", snap),
  // ─── Auto-update (v0.3.4; full state model v0.3.7) ──────────────────────────
  /** Push channel from main's updater — every stage of the pipeline, so the
   *  toolbar badge can show "checking", download progress, and the staged
   *  "restart to update" rather than only the terminal states. */
  onUpdateStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    electron.ipcRenderer.on("update:status", listener);
    return () => electron.ipcRenderer.removeListener("update:status", listener);
  },
  /** The last known status — a reloaded window subscribes AFTER main may have
   *  already emitted, so it pulls the current state instead of waiting 6h. */
  updateCurrent: () => electron.ipcRenderer.invoke("update:current"),
  /** Quit and install the downloaded update — only ever called from an explicit
   *  "restart to update" click. */
  updateRestartAndInstall: () => electron.ipcRenderer.invoke("update:restartAndInstall"),
  /** Manual re-check. */
  updateCheckNow: () => electron.ipcRenderer.invoke("update:checkNow"),
  /** Start the download for an already-detected update (autoDownload normally
   *  beats the user to it; this is the explicit one-click path). */
  updateDownload: () => electron.ipcRenderer.invoke("update:download"),
  /** Open the project's releases page for a notify-only update. */
  updateOpenRelease: (url) => electron.ipcRenderer.invoke("update:openRelease", url),
  /** Which OS this window runs on, for platform-specific copy. */
  platform: process.platform,
  arch: process.arch,
  /** DEV ONLY — fabricate an update status so the toast can be inspected without
   *  cutting a release. Refused (`{ok:false}`) in a packaged build; see the
   *  handler in updater.ts. Call it from the devtools console:
   *    await window.cth.updateSimulate()                       // notify-only digest toast
   *    await window.cth.updateSimulate({ state: 'downloaded' }) // restart-to-update toast
   *    await window.cth.updateSimulate({ drop: true })          // the centered release page
   *    await window.cth.updateSimulate({ notes: '<!-- drop -->…' }) // your own drop */
  updateSimulate: (opts) => electron.ipcRenderer.invoke("update:simulate", opts),
  // ─── Teams: device identity ──────────────────────────────────────────────
  /* Only the PUBLIC half of the identity ever crosses this bridge. The Ed25519
     secret key stays in main, encrypted at rest, and there is deliberately no
     channel that returns it. Sealing and opening happen in main for the same
     reason. */
  /** Whether this machine has enrolled. Safe on the solo path: it reads the
   *  filesystem and does not generate anything. */
  teamsHasIdentity: () => electron.ipcRenderer.invoke("teams:identity:has"),
  /** Forget this machine's identity AND its membership (D14, or signing out).
   *  The next enrolment gets a new key and a new fingerprint, which is what
   *  D13 explains. */
  teamsForgetIdentity: () => electron.ipcRenderer.invoke("teams:identity:forget"),
  /** Item 5, team back to individual. Guarded in main: allowed only when the
   *  relay says the org has exactly one member. `has-teammates` carries how
   *  many others there are so the screen can say why rather than just no;
   *  `unreachable` means the check could not be made, never that nobody is
   *  there. */
  /** Item 2: the paywall hand-off. Mints a state in main and opens the
   *  console's solo checkout in the real browser, where the person's session
   *  from step one already lives. */
  proCheckoutBegin: () => electron.ipcRenderer.invoke("pro:checkout:begin"),
  /** The price for the buyer's country (0.5.5): a regional quote when the
   *  server places this machine in one of the nine regional countries, else
   *  null. Asked once a session in main; never rejects. */
  proPricing: () => electron.ipcRenderer.invoke("pro:pricing"),
  /**
   * The return link's OUTCOME. Main checks the state, spends the grant and
   * redeems the key before this fires, so the renderer never handles either
   * credential; it is told what happened, not what was used.
   *
   * `recoverable` is the one field to branch on when `ok` is false. Kevin's
   * rule: `unauthorized` is what a SECOND deep link looks like once the grant
   * is spent, so a recoverable refusal must read as "finish with your licence
   * key", never as a failure shown to somebody who has just paid. It is also
   * how the not-yet-built endpoint (`unavailable`, a 404 today) degrades to
   * exactly the paste path the paywall already offers.
   */
  onProCheckoutReturn: (fn) => {
    const listener = (_e, r) => fn(r);
    electron.ipcRenderer.on("pro:checkout:return", listener);
    return () => electron.ipcRenderer.removeListener("pro:checkout:return", listener);
  },
  teamsLeave: () => electron.ipcRenderer.invoke("teams:leave"),
  // ─── Teams: the gate and the join ────────────────────────────────────────
  /* There is no `ensureIdentity` any more. A key exists only because a relay
     accepted it: `teamsEnrol` below is the one path, and it writes nothing
     until the relay has said yes and the fingerprint checks out. */
  /** The gate's answer (plan section 5). Read once at mount, then subscribe. */
  teamsMode: () => electron.ipcRenderer.invoke("teams:mode"),
  onTeamsMode: (cb) => {
    const listener = (_e, mode) => cb(mode);
    electron.ipcRenderer.on("teams:mode", listener);
    return () => electron.ipcRenderer.removeListener("teams:mode", listener);
  },
  /** Org and ids for the screens. Never key material. */
  teamsMembership: () => electron.ipcRenderer.invoke("teams:membership"),
  /* ---- the solo licence bridge (SoloProBridge in @shared/soloPro) --------
     Main owns the record and the redemption round trip; these are the three
     doors the licence step reads defensively off window.cth. */
  soloLicense: () => electron.ipcRenderer.invoke("solo:license"),
  soloRedeemLicense: (key) => electron.ipcRenderer.invoke("solo:license:redeem", key),
  onSoloLicense: (cb) => {
    const listener = (_e, view) => cb(view);
    electron.ipcRenderer.on("solo:license", listener);
    return () => electron.ipcRenderer.removeListener("solo:license", listener);
  },
  /* ---- the free door (5 Sep 2026, shared/freeTier.ts) --------------------
     Same shape as the solo licence bridge: main owns free.json and the
     sign-in round trip, the renderer reads the record and hears changes. */
  freeAccount: () => electron.ipcRenderer.invoke("free:account"),
  onFreeAccount: (cb) => {
    const listener = (_e, view) => cb(view);
    electron.ipcRenderer.on("free:account", listener);
    return () => electron.ipcRenderer.removeListener("free:account", listener);
  },
  freeSignInBegin: () => electron.ipcRenderer.invoke("free:signin:begin"),
  freeSignInPaste: (pasted) => electron.ipcRenderer.invoke("free:signin:paste", pasted),
  freeSignInCancel: () => electron.ipcRenderer.invoke("free:signin:cancel"),
  onFreeGrant: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("free:signin:grant", listener);
    return () => electron.ipcRenderer.removeListener("free:signin:grant", listener);
  },
  freeRegister: () => electron.ipcRenderer.invoke("free:register"),
  /** Sign out: forget the account and any licence on this machine. */
  freeSignOut: () => electron.ipcRenderer.invoke("free:signout"),
  /**
   * 0.4.9: name this machine's orchestrator. The word is claimed on the relay
   * first, because uniqueness belongs to the org, and only an accepted claim
   * renames the agent here. `conflict` means someone else holds it and nothing
   * was renamed; `unsupported` and `offline` mean the machine kept the name
   * but the org has not been told yet.
   */
  teamsSetBossName: (name) => electron.ipcRenderer.invoke("teams:bossName:set", name),
  /**
   * 0.5.2: the PERSON's display name, the one teammates see beside messages
   * and on their roster. Lives on the relay only, so there is no local half:
   * `unsupported` is a relay without the field, `offline` a relay that could
   * not be reached, and neither saved anything. `null` or '' clears it.
   */
  teamsSetName: (name) => electron.ipcRenderer.invoke("teams:name:set", name),
  /** The socket's state (plan 4.3). Main is the only writer: read once, then subscribe. */
  teamsConnection: () => electron.ipcRenderer.invoke("teams:connection"),
  onTeamsConnection: (cb) => {
    const listener = (_e, v) => cb(v);
    electron.ipcRenderer.on("teams:connection", listener);
    return () => electron.ipcRenderer.removeListener("teams:connection", listener);
  },
  /** A presence frame arrived. The roster re-reads itself; the payload is not
   *  forwarded, so nothing in the renderer can draw a dot the relay did not. */
  onTeamsPresence: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("teams:presence", listener);
    return () => electron.ipcRenderer.removeListener("teams:presence", listener);
  },
  /** Why the gate says `locked` (plan 4.5, 5). Null whenever it does not. */
  teamsLockInfo: () => electron.ipcRenderer.invoke("teams:lock"),
  /** The takeover's Reconnect. Tries now, from a fresh nonce. */
  teamsReconnect: () => electron.ipcRenderer.invoke("teams:reconnect"),
  /** D11: the thread with one teammate, from this machine's own store. */
  teamsThread: (memberId) => electron.ipcRenderer.invoke("teams:thread", memberId),
  onTeamsThread: (cb) => {
    const listener = (_e, memberId) => cb(memberId);
    electron.ipcRenderer.on("teams:thread", listener);
    return () => electron.ipcRenderer.removeListener("teams:thread", listener);
  },
  /**
   * D11's send box. Resolves once the relay has answered.
   *
   * 0.4.10: the WHOLE DRAFT crosses, not a flattened string. It used to be
   * `(memberId, body)` with the subject folded into the first line, which is
   * how one string ended up carrying two things. Main re-checks the draft
   * against `@shared/teamMessage` (shape, length, turn budget, hourly rate)
   * before anything leaves the machine, so this door carries no contract of its
   * own: a check that lives only in the UI is not a contract.
   */
  teamsSend: (memberId, draft) => electron.ipcRenderer.invoke("teams:send", memberId, draft),
  /**
   * 0.4.11: start a fresh thread with one teammate. The spent thread's file is
   * archived (renamed aside, never deleted) and the turn budget is whole
   * again. Main pushes `teams:thread` after the rotation, so the open thread
   * view reloads itself. This is the PERSON'S door out of a spent thread;
   * agents are never handed it and still get `ASK_THE_HUMAN`.
   */
  teamsThreadNew: (memberId) => electron.ipcRenderer.invoke("teams:thread:new", memberId),
  /* ---- 0.4.10: your status, and what your clones allow -------------------
     One read for the whole policy store and one push when it moves. It is
     SEPARATE from `teamsRoster` on purpose: the roster is a relay round trip
     and the policy is a local file, so joining them would hide a status change
     behind the network. `memberIds` asks for the overrides that matter to the
     screen doing the asking; main never sends the whole map unasked. */
  teamsPolicy: (memberIds) => electron.ipcRenderer.invoke("teams:policy", memberIds),
  onTeamsPolicy: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("teams:policy", listener);
    return () => electron.ipcRenderer.removeListener("teams:policy", listener);
  },
  /** Your status. The one control that writes this lives in the right sidebar
   *  of Team and nowhere else. */
  teamsSetStatus: (policy) => electron.ipcRenderer.invoke("teams:setStatus", policy),
  /** When to be on what status. Main normalises it and applies it on a timer
   *  AND on every send, so a machine asleep through a boundary cannot act on a
   *  stale status. */
  teamsSetSchedule: (schedule) => electron.ipcRenderer.invoke("teams:setSchedule", schedule),
  /** What you allow ONE teammate. `null` puts them back on your default, which
   *  is a different thing from setting them to off. */
  teamsSetPolicy: (memberId, policy) => electron.ipcRenderer.invoke("teams:setPolicy", memberId, policy),
  /** What you allow a teammate with no setting of their own. `null` follows the
   *  org default the relay reports again. */
  teamsSetPolicyDefault: (policy) => electron.ipcRenderer.invoke("teams:setPolicyDefault", policy),
  /** D10: what is waiting for this person's decision. */
  teamsRequests: () => electron.ipcRenderer.invoke("teams:requests"),
  onTeamsRequests: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("teams:requests", listener);
    return () => electron.ipcRenderer.removeListener("teams:requests", listener);
  },
  teamsRequestDecide: (id, decision) => electron.ipcRenderer.invoke("teams:request:decide", id, decision),
  /** S1: what the org has told this machine (plan 4.4). Read once, then subscribe. */
  teamsOrg: () => electron.ipcRenderer.invoke("teams:org"),
  onTeamsOrg: (cb) => {
    const listener = (_e, v) => cb(v);
    electron.ipcRenderer.on("teams:org", listener);
    return () => electron.ipcRenderer.removeListener("teams:org", listener);
  },
  /** S1's Verify: a person read the six groups to their admin. The only path to true. */
  teamsOrgVerify: () => electron.ipcRenderer.invoke("teams:org:verify"),
  /** The admin's billing view (PRO phase 5). Main refuses a non-admin before
   *  the network; the relay refuses again. Never cached here. */
  billingSummary: () => electron.ipcRenderer.invoke("billing:summary"),
  teamsOrgRefresh: () => electron.ipcRenderer.invoke("teams:org:refresh"),
  /** D2's Continue: opens the system browser at the sign-in page with a fresh
   *  `state`. `skipped` is true only under the dev switch, when no page exists
   *  to open and the enrol goes without a grant. */
  teamsSignInBegin: () => electron.ipcRenderer.invoke("teams:signin:begin"),
  /** The paste fallback beside the "waiting for your browser" state. */
  teamsSignInPaste: (pasted) => electron.ipcRenderer.invoke("teams:signin:paste", pasted),
  teamsSignInCancel: () => electron.ipcRenderer.invoke("teams:signin:cancel"),
  /** Fires when the grant arrived by either route; the screen moves to D3. */
  onTeamsGrant: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("teams:signin:grant", listener);
    return () => electron.ipcRenderer.removeListener("teams:signin:grant", listener);
  },
  /** D3. Main generates the key, registers it, verifies the fingerprint, and
   *  writes the key and membership only then. Every refusal is a VALUE with a
   *  `CodeError` to branch on and the relay's sentence to show. */
  teamsEnrol: (input) => electron.ipcRenderer.invoke("teams:enrol", input),
  /** D3's three rows, as each starts. */
  onTeamsEnrolProgress: (cb) => {
    const listener = (_e, step) => cb(step);
    electron.ipcRenderer.on("teams:enrol:progress", listener);
    return () => electron.ipcRenderer.removeListener("teams:enrol:progress", listener);
  },
  /** The roster for D7/D8/D9, already joined with this machine's trust pins and
   *  personal overrides. Failures come back as VALUES so the screen can render
   *  the reason instead of a blank pane. */
  teamsRoster: () => electron.ipcRenderer.invoke("teams:roster"),
  /** D13's accept. The ONLY way a key becomes verified, and it is a human
   *  saying so out of band — never anything the relay told us. */
  teamsVerifyDevice: (deviceId, fingerprint) => electron.ipcRenderer.invoke("teams:verify", deviceId, fingerprint),
  /** D9's per-person override. Stays on this machine, per contract 0.3. */
  teamsSetYouAllow: (memberId, level) => electron.ipcRenderer.invoke("teams:setYouAllow", memberId, level),
  /** D8/D9's default for everyone without an override (the self row's select
   *  and the Network section's top card). Null follows the org default. */
  teamsSetYouAllowDefault: (level) => electron.ipcRenderer.invoke("teams:setYouAllowDefault", level),
  // ─── The puck (Pro, 7 Sep 2026; src/main/puck.ts) ─────────────────────────
  // Two callers share these: the puck's own window (src/renderer/src/puck) and
  // the Puck screen in the Pro shell. Main is the only holder of state; both
  // read it with puckState and follow it with onPuckState.
  /** The Pro shell says whether it is on screen. No shell, no puck. */
  puckAdmit: (on) => electron.ipcRenderer.invoke("puck:admit", on),
  puckState: () => electron.ipcRenderer.invoke("puck:state"),
  puckConfig: () => electron.ipcRenderer.invoke("puck:config"),
  onPuckState: (cb) => {
    const listener = (_e, s) => cb(s);
    electron.ipcRenderer.on("puck:state", listener);
    return () => electron.ipcRenderer.removeListener("puck:state", listener);
  },
  /** The meeting chord was pressed (0.5.3, F16): the puck starts a meeting
   *  as a click would, or stops the one running. */
  onPuckMeetingToggle: (cb) => {
    const listener = (_e, p) => cb(p);
    electron.ipcRenderer.on("puck:meetingToggle", listener);
    return () => electron.ipcRenderer.removeListener("puck:meetingToggle", listener);
  },
  /** Dictation from anywhere (0.5.3): main's any app events for the
   *  Stapler's eyes, live level and sounds. `sounds` is the Settings switch. */
  onPuckDictation: (cb) => {
    const listener = (_e, e) => cb(e);
    electron.ipcRenderer.on("puck:dictation", listener);
    return () => electron.ipcRenderer.removeListener("puck:dictation", listener);
  },
  onPuckConfig: (cb) => {
    const listener = (_e, c) => cb(c);
    electron.ipcRenderer.on("puck:config", listener);
    return () => electron.ipcRenderer.removeListener("puck:config", listener);
  },
  /** The system pointer, in the Stapler page's own coordinates, while its
   *  eyes follow the cursor (0.5.5). Sent by main only when it moved. */
  onPuckCursor: (cb) => {
    const listener = (_e, p) => cb(p);
    electron.ipcRenderer.on("puck:cursor", listener);
    return () => electron.ipcRenderer.removeListener("puck:cursor", listener);
  },
  /** A drag begins: where on the disc it was grabbed, px from its centre.
   *  Main moves the window under the system pointer from here to dragEnd. */
  puckDragStart: (at) => electron.ipcRenderer.invoke("puck:dragStart", at),
  /** The pointer moved during a drag: its own motion (movementX/Y) since the
   *  last call. A sign of life, and the drive where the pointer is unreadable. */
  puckDrag: (delta) => electron.ipcRenderer.invoke("puck:drag", delta),
  /** The hand let go: snap if configured, save the position. */
  puckDragEnd: () => electron.ipcRenderer.invoke("puck:dragEnd"),
  puckResetPosition: () => electron.ipcRenderer.invoke("puck:resetPosition"),
  puckMenu: (open) => electron.ipcRenderer.invoke("puck:menu", open),
  /** Click through the transparent part of the window, or not. */
  puckIgnoreMouse: (ignore) => electron.ipcRenderer.invoke("puck:ignoreMouse", ignore),
  /** Content protection by hand: hidden from every screen share and capture. */
  puckInvisible: (on) => electron.ipcRenderer.invoke("puck:invisible", on),
  puckCaptureStart: () => electron.ipcRenderer.invoke("puck:captureStart"),
  puckCaptureConfirm: (rect) => electron.ipcRenderer.invoke("puck:captureConfirm", rect),
  puckCaptureCancel: () => electron.ipcRenderer.invoke("puck:captureCancel"),
  /** The Stapler's Capture button (0.5.2): main relays it to the overlay,
   *  which confirms with the box it holds. */
  puckCaptureRequest: () => electron.ipcRenderer.invoke("puck:captureRequest"),
  onPuckCaptureRequest: (cb) => {
    const listener = () => cb();
    electron.ipcRenderer.on("puck:captureRequest", listener);
    return () => electron.ipcRenderer.removeListener("puck:captureRequest", listener);
  },
  onPuckCaptureInit: (cb) => {
    const listener = (_e, init) => cb(init);
    electron.ipcRenderer.on("puck:captureInit", listener);
    return () => electron.ipcRenderer.removeListener("puck:captureInit", listener);
  },
  /** The puck window hears about a capture the overlay confirmed. */
  onPuckCaptured: (cb) => {
    const listener = (_e, shot) => cb(shot);
    electron.ipcRenderer.on("puck:captured", listener);
    return () => electron.ipcRenderer.removeListener("puck:captured", listener);
  },
  /** ...and about one that failed: the overlay that asked is gone by then. */
  onPuckCaptureFailed: (cb) => {
    const listener = (_e, e) => cb(e);
    electron.ipcRenderer.on("puck:captureFailed", listener);
    return () => electron.ipcRenderer.removeListener("puck:captureFailed", listener);
  },
  puckOpenScreenAccess: () => electron.ipcRenderer.invoke("puck:openScreenAccess"),
  /** To the orchestrator, through the hive's own door (a human request). A
   *  screenshot or transcript travels as its PATH, never as bytes. */
  puckSend: (arg) => electron.ipcRenderer.invoke("puck:send", arg),
  /** The send card's picker (0.5.3, I5): who captures go to from now on. */
  puckSendTo: (id) => electron.ipcRenderer.invoke("puck:sendTo", id),
  /** `systemAudio` says where the other side of the call comes from on this
   *  machine for this meeting: a helper feeding main, a stream the renderer
   *  opens, or null for the microphone alone (0.5.3, F16). */
  puckMeetingStart: () => electron.ipcRenderer.invoke("puck:meetingStart"),
  puckMeetingSegment: (arg) => electron.ipcRenderer.invoke("puck:meetingSegment", arg),
  puckMeetingStop: (arg) => electron.ipcRenderer.invoke("puck:meetingStop", arg),
  puckMeetings: (filter) => electron.ipcRenderer.invoke("puck:meetings", filter ?? {}),
  puckMeetingRename: (arg) => electron.ipcRenderer.invoke("puck:meetingRename", arg),
  puckMeetingTranscript: (arg) => electron.ipcRenderer.invoke("puck:meetingTranscript", arg),
  puckMeetingSave: (arg) => electron.ipcRenderer.invoke("puck:meetingSave", arg),
  puckMeetingSendTo: (arg) => electron.ipcRenderer.invoke("puck:meetingSendTo", arg),
  puckMeetingTranscribe: (arg) => electron.ipcRenderer.invoke("puck:meetingTranscribe", arg),
  puckMeetingDelete: (arg) => electron.ipcRenderer.invoke("puck:meetingDelete", arg),
  onPuckMeetingsChanged: (cb) => {
    const listener = (_e, e) => cb(e);
    electron.ipcRenderer.on("puck:meetingsChanged", listener);
    return () => electron.ipcRenderer.removeListener("puck:meetingsChanged", listener);
  },
  puckMessageStart: () => electron.ipcRenderer.invoke("puck:messageStart"),
  /** The app's window forward, on a Settings section when named ('Voice' for the Groq key). */
  puckOpenSettings: (section) => electron.ipcRenderer.invoke("puck:openSettings", section),
  /** macOS: the Microphone pane of System Settings. */
  puckOpenMicAccess: () => electron.ipcRenderer.invoke("puck:openMicAccess"),
  /** A part of a message still being spoken: its words, and the recording goes on. */
  puckMessageSegment: (arg) => electron.ipcRenderer.invoke("puck:messageSegment", arg),
  puckMessageStop: (arg) => electron.ipcRenderer.invoke("puck:messageStop", arg),
  puckScreenshots: () => electron.ipcRenderer.invoke("puck:screenshots"),
  puckScreenshotDelete: (path) => electron.ipcRenderer.invoke("puck:screenshotDelete", path),
  puckReveal: (path) => electron.ipcRenderer.invoke("puck:reveal", path)
};
electron.contextBridge.exposeInMainWorld("cth", api);
