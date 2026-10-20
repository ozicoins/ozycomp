'use strict';
/**
 * Hive — the coordination brain. A <home>/hive directory is the single source
 * of truth: registry.json (agents), tasks.json (kanban), agents/<id>/{inbox,
 * outbox,memory.md}, board.md (freeform plan, god-only scribe), log.jsonl,
 * cost-ledger.jsonl. Agents communicate by dropping JSON envelopes into each
 * other's outbox; this module routes outbox→inbox on a tick.
 *
 * Plain Node — no Electron — so the harness core can be tested headless.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pushSessionHistory } = require('./session-resume');
const { canReceiveInbox, bridgeOf, providerPreset, isClaudeProvider, isHiveAwareProvider } = require('./provider-presets');
const { selectBroadcastTargets, heldBroadcastSkips, entryForMessage, preferredAgentRole, resolveGodName } = require('./memory-rules');
const { runToEnd, runInSlices } = require('./pty-submit');
const { injectedPrompt, identityText, memoryNoticeDue } = require('./injected-prompt');
const { hookSettings, sandboxWritableDirs, copyBundledSkills } = require('./hook-settings');
const { grokThemeEnv, readGrokConfigToml } = require('./codex-remote');
const { expandTilde } = require('./config');
const { spawn, spawnSync } = require('node:child_process');
const { HOOK_SHIM, PROXY_BRIDGE_SHIM } = require('./hook-shims');
const HIVE_COMPACT_SCRIPT = require('./hive-compact');

const ROUTE_TICK_MS = 1500;          // outbox → inbox drain interval
const BOARD_FILE = 'board.md';
const TASKS_FILE = 'tasks.json';
const REGISTRY_FILE = 'registry.json';
const LOG_FILE = 'log.jsonl';
const LEDGER_FILE = 'cost-ledger.jsonl';

/** Docs generated into the hive so agents can read the wire protocol.
 *  verbatim ~10327-10519: PROTOCOL.md + COMMANDS.md rewritten at every boot
 *  (a stale copy teaches an old protocol to new agents). */
const GENERATED_DOC_NOTICE = '<!-- Generated and managed by OzyComp. Local edits are replaced when the app starts. -->';
function renderCommandsMd() {
  const { COMMAND_GROUPS } = require('./capabilities');
  const lines = [
    GENERATED_DOC_NOTICE,
    '',
    '# Claude Code commands',
    '',
    'Reference of the Claude Code commands available to you. Two kinds:',
    "- **slash** commands act ONLY on your own session — you CANNOT run them on another agent's terminal.",
    '- **cli** commands run in your shell (Bash) and can target the fleet, spawn, or query.',
    '',
    'To MONITOR the other agents in this hive, read `fleet.json` in the hive root (live per-agent tokens, cost, status, last tool, breaker level, inbox backlog) plus `registry.json` — `claude agents` does NOT list your hive siblings. Use `claude -p "..." --output-format json` for a one-off headless query.',
    '',
  ];
  for (const g of COMMAND_GROUPS) {
    lines.push(`## ${g.title}`, '');
    for (const it of g.items) {
      lines.push(`- \`${it.cmd.trim()}\` _(${it.kind})_ — ${it.desc}${it.usage ? ` e.g. \`${it.usage}\`` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
const PROTOCOL_MD = `${GENERATED_DOC_NOTICE}

# Hive protocol

You are one of several Claude agents sharing this hive. Coordination is entirely
file-based; the harness (main process) is the only thing that runs git and the
only thing that moves messages between agents.

**Words.** An *agent* is a member of this office with a lasting session. A *temp* is a short lived agent
the orchestrator starts for one job; it does the job, reports done, and is torn down. The orchestrator's
address is \`god\`.

## Your workspace — \`agents/<your-id>/\`
- \`identity.md\`  — who you are (read-only; the harness writes it).
- \`memory.md\`    — your long-term memory. Read at the start of a task; append to it as you learn.
  Put what you must always or never do under \`## 📏 Rules (never moved)\`; nothing there ever moves.
- \`memory-archive.md\` — a summary of old pinned notes the harness moved out of memory.md. Not read at start.
- \`memory-archive-raw*.md\` — the same notes word for word, and older sections the condenser dropped for size, never trimmed. Search them, or open one when you need an old fact.
- \`inbox/\`       — messages addressed to you. Read them at the start of a task.
- \`inbox/.done/\` — move a message here once you've handled it.
- \`outbox/\`      — drop messages here to send them. The harness delivers them.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
orchestrator routes it. This keeps every file single-writer.

## Sending a message
Write one JSON file into \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast | member:<memberId> (a teammate on another machine; Teams only, ids come from the roster line)",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)"
}
\`\`\`

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

## Rules of the road
- Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal —
  don't reply to them, or two agents will loop forever.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`god\` — the
  god agent clarifies answers for you so you rarely need the human directly.
- There is NO separate human-approval queue. Human-in-the-loop is native to Claude
  Code: a tool you run that needs permission prompts in your own session (the human
  can approve it remotely from their phone via \`/remote-control\`). If you genuinely
  need a human decision, raise it with \`god\` (a message \`"to": "human"\` is routed to
  the god/orchestrator, the human's proxy on the floor).
- \`board.md\` is the shared plan. Don't edit it directly — \`propose\` changes to \`god\`,
  who is its sole scribe.
- Re-reading a message you already moved to \`.done/\` is a no-op. Don't reprocess.

## The work: board.md vs tasks.json
There are two shared surfaces, both in the hive root:
- \`board.md\` — the freeform narrative plan. The god agent is its sole scribe; others \`propose\` edits.
- \`tasks.json\` — the structured task ledger (a kanban: \`todo / doing / blocked / done\`, with title,
  assignee, priority, deps). Keep the task you're working reflected in its status.
  Leave \`id\` out; the harness assigns the ticket key (e.g. V53-299). Refer to cards by that key.

## Asking the human (the ASK ME card)
When a card can only move with the human — a question to answer, or an action only they can do
(create an account, approve a spend, hand over credentials, test on their device) — the god sets the
card \`"status": "blocked"\` and appends the ask to its \`humanQA\` array:

\`\`\`json
{ "q": "the ask, in markdown", "askedAt": "<iso timestamp>", "from": "<agent id>" }
\`\`\`

\`"from"\` is the agent whose question it is: the ask shows on that agent's own tab. Leave it out for a
floor wide question; that one shows on the orchestrator's tab.

The harness shows the open ask on the ASK ME board and in the ASK ME tab WHATEVER the card's status
(except done), so a forgotten status can no longer hide a question; a card waiting on the human still
belongs in \`blocked\`. The human's reply lands in the same entry as \`"a"\` plus an inbox message to
god. Every past entry stays on the card — that trail is the decision history.

**Write the ask short, and in markdown.** The card renders it, so plain-text asterisks and backticks
show up literally, and a card is not a terminal — an ask longer than a short paragraph plus its
options (roughly 700 characters) is a report, not a question. Cut the narrative and keep the decision:
- open with ONE **bold** sentence saying exactly what you need from them;
- \`backticks\` for paths, commands, values, and identifiers;
- \`-\` bullets or \`1.\` numbering for every option or step;
- a blank line between paragraphs; a single newline is rendered as a line break, so each option
  stays on its own line.

When the ask originates in another agent's report, REWRITE it into that shape. Never paste the report
body in as the question, and never make the human read the investigation to find the decision. Do NOT park human questions in separate files (no \`HumanQuestion.md\`),
and never sit idle waiting for a reply — move on to other work and pick the answer up when it arrives.

## Guardrails: circuit breaker & token budgets
A circuit breaker watches every agent for runaway behavior (looping on the same tool, error storms,
overspending). It escalates gently: \`steer\` → \`constrain\` → \`stop\`. If a \`Circuit breaker: steer\`
or \`Circuit breaker: constrain\` message lands in your inbox, you ARE the problem it caught — stop
repeating, summarize what you've tried, and do exactly what the message says (constrain = go read-only
and get god's sign-off before more tool calls). Be **token-frugal**: the floor has a token budget and
each agent can have its own token limit; crossing it trips the breaker. Prefer references over pasted
content, and \`/compact\` your own session when context gets heavy.

## Fleet monitoring (orchestrator)
You (god) are responsible for situational awareness. To see the live state of every agent, read
\`fleet.json\` in the hive root — it is refreshed continuously with each agent's tokens, cost, status,
breaker level, last tool, last-active time, and inbox backlog. Pair it with \`registry.json\` (the roster)
and \`log.jsonl\` (the event feed). IMPORTANT: \`claude agents\` will NOT show your hive's sibling
sessions (they're spawned independently) — \`fleet.json\` is your source of truth for them. For a deeper
look at one agent, read its \`agents/<id>/memory.md\` and \`inbox/\`, or send it a \`query\`. A full
Claude Code command reference (slash = your own session only; CLI = your shell, can target the fleet)
is in \`COMMANDS.md\` in the hive root.

## Starting a temp (orchestrator)
You can start a temp yourself. Write ONE JSON file into \`spawn-requests/<id>.json\` in the hive root:

\`\`\`json
{
  "objective": "the job (required)",
  "cwd": "/absolute/path/to/the/repo (required)",
  "name": "display name (optional)",
  "command": "engine CLI (optional; overrides the provider default)",
  "provider": "claude | codex | cursor | antigravity | … (optional; picks its CLI when command is omitted)",
  "model": "model override (optional)",
  "isolate": true,
  "tokenCap": 0,
  "slack": { "channel": "C…", "thread_ts": "…" },
  "character": "meredith",
  "accent": "coral"
}
\`\`\`

The harness polls that directory, starts the temp with id \`worker-<id>\`, briefs it with the objective,
the memory index and its capabilities, and moves the request to \`spawn-requests/.done/\` once it starts
or to \`spawn-requests/.failed/\` with a reason. \`isolate\` defaults to true, giving the temp its own git
worktree. \`slack\` sends its replies and failures to that thread. \`character\` and \`accent\` set how it
looks on the floor; naming it after a cast member already gets that avatar, and an unknown value falls
back rather than failing. This is the only way you can start anyone: a hire manifest under
\`research/hires/\` needs the human to confirm it in the UI.

**The switch.** The human allows temps under Settings, Autonomy & Budgets. It is ON by default (0.5.3); the
human can turn it off, and it caps how many run at once. While it is off your request
is neither failed nor deleted: it waits in \`spawn-requests/\` and runs when the switch is turned on. A
request that has not moved means the switch is off; raise it with the human instead of retrying. When
Slack triage is set to temps, the harness starts those temps itself, switch or not. Route work to an
agent already on the floor first either way.

## Capabilities
Your skills are copied into \`agents/<your-id>/.claude/skills/\` when you start. Read
\`capabilities/SKILL.md\` there once (or run \`/capabilities\`): it lists the date skills (\`/today\`,
\`/lastWeek\`, \`/last30Days\`, \`/lastQuarter\` and more), which resolve any time window so you never
compute dates by hand, and the integrations reached through the loopback broker. Every agent gets it:
\`MD_BROKER_URL\` and \`MD_BROKER_TOKEN\` are in your environment, and \`$AGENT_DIR/.broker\` holds the
current pair after an app restart. Without either, ask \`god\`. \`GET $MD_BROKER_URL/i\` with your token
answers \`{"ids":[...]}\`, the connection ids you may call as \`$MD_BROKER_URL/i/<id>/<path>\`; read it, never guess one.

## Semantic memory (optional — when \`mempalace\` is installed)
When \`MEMPALACE_PALACE_PATH\` is set in your environment, the hive shares a
searchable MemPalace and you have the \`mempalace\` CLI:
- \`mempalace search "<query>"\` — recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add \`--wing <agent-id>\` to scope to one
  agent, \`--results N\` to widen.
- \`mempalace wake-up\` — a short digest of what matters, good at the start of a task.

Your \`memory.md\` is mined into the palace automatically, so the durable facts you
write there become searchable by every agent. You don't run \`mine\` yourself.
`;
const GENERATED_HIVE_DOCS = {
  'PROTOCOL.md': PROTOCOL_MD,
  'COMMANDS.md': renderCommandsMd(),
};

function isStr(v) { return typeof v === 'string' && v.trim() !== ''; }

const CHUNK = 64 * 1024;
/** Read the last `n` non-empty lines of a file without loading it whole —
 *  scans backwards in 64KB chunks (verbatim from the reference). */
function tailLines(path2, n) {
  if (!(n > 0)) return [];
  let fd;
  try {
    fd = fs.openSync(path2, "r");
  } catch {
    return [];
  }
  try {
    const size = fs.fstatSync(fd).size;
    let pos = size;
    let parts = [];
    let newlines = 0;
    while (pos > 0 && newlines <= n + 1) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      for (let i = 0; i < len; i++) if (buf[i] === 10) newlines++;
      parts = [buf, ...parts];
    }
    let text = Buffer.concat(parts).toString("utf8");
    if (pos > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter((l) => l.trim().length > 0).slice(-n);
  } catch {
    return [];
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

const HOP_CAP = 12;
// verbatim ~5726-5734: the ticket key/prefix grammar shared with the ipc
// layer's ticketMeta.
const TICKET_KEY_RE = /^[A-Z][A-Z0-9]{2}-\d+$/;
const TICKET_PREFIX_RE = /^[A-Z][A-Z0-9]{2}$/;
function isTicketKey(id) {
  return typeof id === "string" && TICKET_KEY_RE.test(id);
}
function isTicketPrefix(p) {
  return typeof p === "string" && TICKET_PREFIX_RE.test(p);
}
function stamp() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
}
function shortRand() {
  return crypto.randomBytes(3).toString("hex");
}
const SAFE_MESSAGE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
function isSafeMessageId(id) {
  return typeof id === "string" && SAFE_MESSAGE_ID.test(id);
}

// ── verbatim spawn-injection helpers (ref ~6950-7065) ──────────────────────
const HOOK_TOKEN_ENV = 'HIVE_HOOK_TOKEN';
const PROXY_BIND_ATTEMPTS = 3;
/** Every env var a loopback-destined HTTP request must skip the proxy for. */
function withLoopbackNoProxy(existing) {
  const parts = (existing ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost']) if (!parts.includes(host)) parts.push(host);
  return parts.join(',');
}
/** The `{type:"http"}` hook entry Claude Code POSTs to when the hook transport
 *  is the loopback listener instead of a command shim (ref ~7017). */
function httpHookEntry(port, agentId) {
  return {
    type: 'http',
    url: `http://127.0.0.1:${port}/hook/${encodeURIComponent(agentId)}`,
    headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV}` },
    allowedEnvVars: [HOOK_TOKEN_ENV],
    timeout: 5,
  };
}
/** Hive-root files that must never enter the hive git history (ref ~6173). */
const HIVE_IGNORE_LINES = [
  'fleet.json',
  'hooks.sock',
  // live state like hooks.sock: a committed copy would claim a pid forever.
  '.floor-lock',
  'cost-ledger.jsonl',
  'log.jsonl',
  '.DS_Store',
  'crashes/',
  'node_modules/',
  '.npm-cache/',
  '.yarn/cache/',
  '.pnpm-store/',
  '.venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.turbo/',
  '.next/',
  '.gradle/',
  '.remotion/',
  '/agents/*/memory.md',
  '/agents/*/memory-archive.md',
  '/agents/*/memory-archive-raw*.md',
  '/backups/',
  '/bin/runtime/md-hook-*.cmd',
  'facts.db-shm',
  'facts.db-wal',
  '/mtime-test-*/',
];
/** Agent-private files that must never enter the hive git history (ref ~6217). */
const AGENT_IGNORE_LINES = [
  'settings.json',
  'cursor.json',
  'inbox/',
  'outbox/',
  '.codex/',
  '.broker',
];
function mergeIgnoreLines(existing, want) {
  const have = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = want.filter((w) => !have.has(w));
  if (missing.length === 0) return null;
  const prefix = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  return prefix + missing.join('\n') + '\n';
}
/** Merge AGENT_IGNORE_LINES into the agent dir's .gitignore (ref ~7057). */
function ensureMineIgnore(agentDir) {
  const p = path.join(agentDir, '.gitignore');
  let existing = '';
  try {
    if (fs.existsSync(p)) existing = fs.readFileSync(p, 'utf8');
  } catch {
    return;
  }
  const merged = mergeIgnoreLines(existing, AGENT_IGNORE_LINES);
  if (merged === null) return;
  try { fs.writeFileSync(p, merged, 'utf8'); } catch {}
}

// ── verbatim hive git-commit queue (ref ~6226-6735) ─────────────────────────
// `commit()` only marks the hive changed; the git work runs one job at a time
// off the main thread's critical path, at most one scan per window, so the
// main process never waits for git. `gc.autoDetach=false` stays in every call
// — a background gc would outlive the job that started it and race the next
// thing that touches the hive. A flush/drop/quit that runs out of time stops
// the whole git tree and waits for it.
const OVERSIZE_CAP_BYTES = 10 * 1024 * 1024;
const UNTRACK_TIMEOUT_MS = 12e4;
const REPO_SIZE_WARN_BYTES = 2 * 1024 * 1024 * 1024;
const UNTRACKED_CACHE_TEST_TIMEOUT_MS = 6e4;
const HIVE_COMMIT_WINDOW_MS = 5 * 60 * 1e3;
const GIT_STEP_TIMEOUT_MS = 8e3;
const GIT_GC_TIMEOUT_MS = 30 * 60 * 1e3;
const QUIT_DRAIN_MS = 5e3;
const FLUSH_MS = 1e4;
const LOCK_TRIES = 5;
const BODY_LINES = 20;
const GIT_KILL_GRACE_MS = 2e3;
const GROUP_POLL_MS = 50;
const STOP_WAIT_MS = GIT_KILL_GRACE_MS + 500;

const liveCommitQueues = new Set();
/** Drop every live commit queue — quit/test teardown. Each drop() closes its
 *  own queue, aborts its git step and waits at most `ms` for the chain, so a
 *  child git never outlives the harness that spawned it. */
async function dropAllCommitQueues(ms = QUIT_DRAIN_MS) {
  const queues = [...liveCommitQueues];
  await Promise.all(queues.map((q) => q.drop(ms).catch(() => {})));
}

function ignoreLineFor(relPath) {
  let out = '';
  for (const ch of relPath.replace(/^\/+/, '')) {
    out += ch === '\\' || ch === '*' || ch === '?' || ch === '[' || ch === ']' ? '\\' + ch : ch;
  }
  if (out.startsWith('#') || out.startsWith('!')) out = '\\' + out;
  if (out.endsWith(' ')) out = out.slice(0, -1) + '\\ ';
  return '/' + out;
}
function nulList(out) { return out.split('\0').filter((s) => s.length > 0); }

/** Drop from the index every tracked file the ignore rules cover (verbatim
 *  ~6247): git keeps recording a tracked file however many .gitignore lines
 *  name it, so the ignore line alone reads as a fix while the repo grows.
 *  `rm --cached` only touches the index — nothing leaves the disk. */
async function untrackIgnored(run) {
  const listed = await run(
    ['-c', 'core.excludesFile=', 'ls-files', '-z', '--cached', '--ignored', '--exclude-standard'],
    { timeoutMs: UNTRACK_TIMEOUT_MS });
  if (!listed.ok) return { paths: [], ok: false };
  const paths = nulList(listed.out);
  if (paths.length === 0) return { paths: [], ok: true };
  const input = paths.map((p) => ':(literal)' + p).join('\0') + '\0';
  const removed = await run(
    ['rm', '--cached', '-q', '--ignore-unmatch', '-r', '--pathspec-from-file=-', '--pathspec-file-nul'],
    { timeoutMs: UNTRACK_TIMEOUT_MS, input });
  return { paths, ok: removed.ok };
}
/** Add .gitignore lines for untracked files over the cap (verbatim ~6262). */
async function ignoreOversized(run, fsx, root, join, cap = OVERSIZE_CAP_BYTES) {
  const listed = await run(['ls-files', '-z', '--others', '--exclude-standard']);
  if (!listed.ok) return [];
  const over = [];
  for (const rel of nulList(listed.out)) {
    const size = fsx.sizeOf(join(root, rel));
    if (size !== null && size > cap) over.push(rel);
  }
  if (over.length === 0) return [];
  const f = join(root, '.gitignore');
  const merged = mergeIgnoreLines(fsx.read(f) ?? '', over.map(ignoreLineFor));
  if (merged === null) return [];
  fsx.write(f, merged);
  return over;
}
async function packedBytes(run) {
  const res = await run(['count-objects', '-v']);
  if (!res.ok) return null;
  let total = 0, sawOne = false;
  for (const line of res.out.split('\n')) {
    const m = /^(size|size-pack|size-garbage): (\d+)$/.exec(line.trim());
    if (m) { total += Number(m[2]) * 1024; sawOne = true; }
  }
  return sawOne ? total : null;
}
async function boundGcMemory(run) {
  await run(['config', '--replace-all', 'pack.windowMemory', '128m']);
  await run(['config', '--replace-all', 'pack.packSizeLimit', '1g']);
  await run(['config', '--replace-all', 'pack.threads', '1']);
}
async function setUntrackedCache(run) {
  const test = await run(['update-index', '--test-untracked-cache'], { timeoutMs: UNTRACKED_CACHE_TEST_TIMEOUT_MS });
  const on = test.ok;
  const set = await run(['config', '--local', 'core.untrackedCache', on ? 'true' : 'false']);
  return set.ok ? on : null;
}

function stopBudget(ms) {
  const first = Math.max(0, ms - STOP_WAIT_MS);
  return { first, second: Math.max(0, Math.min(STOP_WAIT_MS, ms - first)) };
}
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}
function signalTree(pid, sig) {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch {}
    return;
  }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}
/** The queue's git runner (verbatim ~6345): one spawn per step, its own
 *  process group so a stop reaches every child, bounded by timeoutMs, killed
 *  on abort, resolved {ok,out,err,timedOut?}. */
function spawnHiveGit(baseArgs) {
  return (root, args, opts) => new Promise((resolve) => {
    if (opts?.signal?.aborted) { resolve({ ok: false, out: '', err: 'aborted' }); return; }
    let out = '', err = '', timedOut = false, stopped = false, exited = false, exitCode = null, settled = false, child;
    try {
      child = spawn('git', [...baseArgs, ...args], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) { resolve({ ok: false, out: '', err: e instanceof Error ? e.message : String(e) }); return; }
    const pid = child.pid;
    // The git child's own handle must not hold the event loop open on quit —
    // the settle path resolves through 'close'/abort/timeout, never through
    // the process lingering past the caller's teardown.
    child.unref?.();
    const timers = [];
    const settle = (extraErr = '') => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts?.signal?.removeEventListener('abort', onAbort);
      const ok = exitCode === 0 && !timedOut && !stopped;
      resolve({ ok, out, err: err + extraErr + (stopped && !timedOut ? (err ? '\n' : '') + 'aborted' : ''), ...(timedOut ? { timedOut: true } : {}) });
    };
    const settleWhenGone = () => {
      if (!exited) return;
      if (!stopped || pid === undefined || process.platform === 'win32' || !groupAlive(pid)) { settle(); return; }
      timers.push(setTimeout(settleWhenGone, GROUP_POLL_MS));
    };
    const stop = () => {
      if (stopped || pid === undefined) return;
      stopped = true;
      signalTree(pid, 'SIGTERM');
      timers.push(setTimeout(() => { signalTree(pid, 'SIGKILL'); }, GIT_KILL_GRACE_MS));
      settleWhenGone();
    };
    const onAbort = () => stop();
    opts?.signal?.addEventListener('abort', onAbort, { once: true });
    timers.push(setTimeout(() => { timedOut = true; stop(); }, opts?.timeoutMs ?? GIT_STEP_TIMEOUT_MS));
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (pid === undefined) { exited = true; settle(e.message); } else err += e.message; });
    // 'exit' fires as soon as the process dies (stdio may still be open);
    // 'close' waits for the stdio pipes too. A detached git process-group can
    // leave a pipe held past death — without 'exit' settleWhenGone never runs
    // and the chain stays pending forever (the test-timeout hang).
    child.on('exit', (code) => { exited = true; exitCode = code ?? exitCode; settleWhenGone(); });
    child.on('close', (code) => { exited = true; exitCode = code ?? exitCode; settleWhenGone(); });
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts?.input ?? '');
  });
}
function batchMessage(messages, kind = 'batch') {
  if (messages.length === 0) return kind === 'start' ? 'hive: changes found at start' : kind === 'quit' ? 'hive: changes at quit' : 'hive: changes';
  if (messages.length === 1) return messages[0];
  const shown = messages.slice(0, BODY_LINES);
  const more = messages.length - shown.length;
  return `hive: ${messages.length} events\n\n${shown.join('\n')}${more > 0 ? `\n(and ${more} more)` : ''}`;
}

/**
 * VERBATIM HiveCommitQueue (ref ~6438): marked events batch on a 5-minute
 * window; jobs run one at a time on a promise chain; a running git step can be
 * stopped as a tree; a flush waits for git inside a bounded budget and holds
 * new git steps until its chain ends.
 */
class HiveCommitQueue {
  root = null;
  pending = [];          // [seq, message] — merge order across stopped jobs
  seq = 0;
  dirty = false;
  lastScanAt = Number.NEGATIVE_INFINITY;
  timer = null;
  chain = Promise.resolve();  // jobs run one after another here
  jobs = 0;
  gitRunning = false;
  stepAbort = null;      // the running git step's own stop
  gcRunning = false;
  flushing = 0;          // while a flush waits, jobs skip their gc step
  held = 0;              // >0: no git step starts (a flush ran out of time, F3b)
  closed = false;
  abort = new AbortController();  // stops the running git step on quit/erase
  prepared = new Set();
  scannedOnce = new Set();

  constructor(deps) {
    liveCommitQueues.add(this);
    this.d = {
      warn: (m) => console.warn(m),
      now: Date.now,
      setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
      clearTimer: (h) => clearTimeout(h),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      windowMs: HIVE_COMMIT_WINDOW_MS,
      ...deps,
    };
  }
  /** A hive event: remember it and return at once. Git never runs here. */
  mark(root, message) {
    if (this.closed) return;
    if (this.root !== null && this.root !== root && this.dirty) this.startScan('batch');
    this.root = root;
    this.dirty = true;
    this.pending.push([this.seq++, message]);
    this.schedule();
  }
  isGitRunning() { return this.gitRunning; }
  /** Anything marked and not yet committed, or a job running? */
  isIdle() { return !this.dirty && this.jobs === 0; }
  /** Wait for the jobs already started, without starting one. */
  whenIdle() { return this.chain; }
  /** Commit what is marked now, ignoring the window, waiting at most `ms`
   *  (verbatim ~6518). Past the bound the queue is held so no git step starts
   *  between the flush returning and the caller copying the hive. */
  async flush(ms = FLUSH_MS) {
    this.flushing++;
    try {
      if (this.gcRunning) this.stepAbort?.abort();
      if (this.dirty) this.startScan('flush');
      const { first, second } = stopBudget(ms);
      const drained = await this.waitChain(first);
      if (drained) return true;
      this.held++;
      void this.chain.then(() => { this.held--; });
      this.stepAbort?.abort();
      await this.waitChain(second);
      return false;
    } finally { this.flushing--; }
  }
  /** Wait for the chain at most `ms`; true when it finished. */
  async waitChain(ms) {
    let timer = null;
    const done = await Promise.race([
      this.chain.then(() => true),
      new Promise((r) => { timer = this.d.setTimer(() => r(false), ms); }),
    ]);
    this.d.clearTimer(timer);
    return done;
  }
  /** A whole scan of `root` with the untracked cache off (the app start). */
  scanAtStart(root) {
    if (this.closed) return this.chain;
    if (this.root !== null && this.root !== root && this.dirty) this.startScan('batch');
    this.root = root;
    this.startScan('start');
    return this.chain;
  }
  /** Quit: one last whole scan (untracked cache off), waiting at most `ms`.
   *  Nothing new starts after it (verbatim ~6559). */
  async drainForQuit(root, ms = QUIT_DRAIN_MS) {
    if (this.closed) return this.isIdle();
    if (root) {
      if (this.root !== null && this.root !== root && this.dirty) this.startScan('batch');
      this.root = root;
      this.startScan('quit');
    } else if (this.dirty) this.startScan('batch');
    this.closed = true;
    liveCommitQueues.delete(this);
    const { first, second } = stopBudget(ms);
    const drained = await this.waitChain(first);
    if (drained) return true;
    this.abort.abort();
    await this.waitChain(second);
    return false;
  }
  /** The hive is going away (reset): forget what is marked, start nothing
   *  more, wait for a running job to end, at most `ms` (verbatim ~6579). */
  async drop(ms = QUIT_DRAIN_MS) {
    this.closed = true;
    liveCommitQueues.delete(this);
    this.dirty = false;
    this.pending = [];
    if (this.timer !== null) { this.d.clearTimer(this.timer); this.timer = null; }
    this.abort.abort();
    await this.waitChain(ms);
  }
  schedule() {
    if (this.closed || !this.dirty || this.timer !== null || this.jobs > 0) return;
    const wait = Math.max(0, this.lastScanAt + this.d.windowMs - this.d.now());
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      if (this.dirty && this.jobs === 0) this.startScan('batch');
    }, wait);
  }
  /** Take the pending batch and put a job for it on the chain. */
  startScan(kind) {
    const root = this.root;
    if (!root) return;
    if (this.timer !== null) { this.d.clearTimer(this.timer); this.timer = null; }
    const batch = this.pending;
    const messages = batch.map(([, m]) => m);
    this.pending = [];
    this.dirty = false;
    this.lastScanAt = this.d.now();
    this.jobs++;
    this.chain = this.chain.then(async () => {
      let result = 'done';
      try {
        result = await this.job(root, messages, kind);
      } catch (e) {
        this.d.warn(`[hive] commit job failed: ${e instanceof Error ? e.message : String(e)}`);
        result = 'retry';
      }
      this.jobs--;
      if (result === 'retry' && !this.closed) {
        if (this.root === root) {
          this.pending = [...batch, ...this.pending].sort((a, b) => a[0] - b[0]);
          this.dirty = true;
        } else {
          this.d.warn(`[hive] ${messages.length} commit(s) for ${root} left to the next start: the hive changed`);
        }
      }
      this.schedule();
    });
  }
  rootGit(root) {
    return async (args, opts) => {
      if (this.stopping()) return { ok: false, out: '', err: 'aborted' };
      const step = new AbortController();
      this.stepAbort = step;
      this.gitRunning = true;
      this.gcRunning = args.includes('gc');
      try {
        return await this.d.git(root, args, { ...opts, signal: AbortSignal.any([this.abort.signal, step.signal]) });
      } finally {
        this.gitRunning = false;
        this.gcRunning = false;
        if (this.stepAbort === step) this.stepAbort = null;
      }
    };
  }
  /** Is git being stopped: quit/reset (for good), or a flush out of time
   *  (until its hold lifts)? A job that sees it ends and keeps its batch. */
  stopping() { return this.held > 0 || this.abort.signal.aborted; }
  async job(root, messages, kind) {
    if (!this.d.hasRepo(root)) return 'done';
    if (this.stopping()) return 'retry';
    const result = await this.scan(root, messages, kind);
    if (!this.scannedOnce.has(root) && !this.stopping()) {
      this.scannedOnce.add(root);
      try { await this.d.afterFirstScan?.(root, this.rootGit(root)); }
      catch (e) { this.d.warn(`[hive] repo setup after the first scan failed: ${e instanceof Error ? e.message : String(e)}`); }
      if (this.stopping()) this.scannedOnce.delete(root);
    }
    return result;
  }
  async scan(root, messages, kind) {
    const git = this.rootGit(root);
    if (!this.prepared.has(root)) {
      this.prepared.add(root);
      try { await this.d.prepare?.(root, git); }
      catch (e) { this.d.warn(`[hive] repo prepare failed: ${e instanceof Error ? e.message : String(e)}`); }
      if (this.stopping()) { this.prepared.delete(root); return 'retry'; }
    }
    const noCache = kind === 'batch' || kind === 'flush' ? [] : ['-c', 'core.untrackedCache=false'];
    const run = (args, opts) => git([...noCache, ...args], opts);
    const status = await run(['status', '--porcelain', '-z']);
    if (this.stopping()) return 'retry';
    if (!status.ok) {
      this.d.warn(`[hive] git status failed${status.timedOut ? ' (timed out)' : ''}: ${status.err.trim()}`);
      return 'retry';
    }
    if (status.out === '') return 'done';
    try { await this.d.sizeGuard?.(root, run); } catch {}
    if (this.stopping()) return 'retry';
    const message = batchMessage(messages, kind);
    let committed = false;
    for (let attempt = 0; attempt < LOCK_TRIES; attempt++) {
      this.d.clearStaleLock(root);
      const add = await run(['add', '-A']);
      if (this.stopping()) return 'retry';
      if (add.timedOut) { this.d.warn('[hive] git add timed out; next window'); return 'retry'; }
      const commit = await run(['-c', 'gc.auto=0', 'commit', '-q', '-m', message]);
      if (commit.ok) { committed = true; break; }
      if (this.stopping()) return 'retry';
      if (commit.timedOut) { this.d.warn('[hive] git commit timed out; next window'); return 'retry'; }
      if (/nothing to commit/i.test(commit.out + commit.err)) return 'done';
      if (!add.ok || /index\.lock/i.test(commit.err)) { await this.d.sleep(50 * (attempt + 1)); continue; }
      this.d.warn(`[hive] commit gave up after ${attempt + 1} attempts: ${(commit.err || commit.out).trim()}`);
      return 'done';
    }
    if (!committed) { this.d.warn(`[hive] commit still locked after ${LOCK_TRIES} attempts; next window`); return 'retry'; }
    if (kind !== 'quit' && kind !== 'flush' && this.flushing === 0) {
      const gc = await run(['gc', '--auto', '--quiet'], { timeoutMs: GIT_GC_TIMEOUT_MS });
      if (!gc.ok) this.d.warn(`[hive] git gc --auto failed${gc.timedOut ? ' (timed out)' : ''}: ${gc.err.trim()}`);
    }
    return 'done';
  }
}

/** SECURITY: every subject + body shown through IPC goes through this first,
 *  so no secret and no raw body ever crosses to the renderer (verbatim). */
function redactSecrets(text) {
  if (typeof text !== "string" || !text) return typeof text === "string" ? text : "";
  let s = text;
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[redacted]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[redacted]");
  s = s.replace(
    /(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|xox[bpaors]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{20,})/g,
    "[redacted]"
  );
  s = s.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  s = s.replace(
    /\b((?:[a-z0-9]+[_-])*(?:api[_-]?key|secret[_-]?access[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret|signing[_-]?secret|webhook[_-]?secret|auth[_-]?token|bot[_-]?token|private[_-]?key))(\s*[:=]\s*)(["']?)[^\s"',}]{6,}\3/gi,
    (_m, k) => `${k}=[redacted]`
  );
  return s;
}

/** Agent ids become directory names — reject anything that could escape the hive. */
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function assertAgentId(id) {
  if (typeof id !== 'string' || !AGENT_ID_RE.test(id)) throw new Error(`invalid agent id: ${JSON.stringify(id)}`);
  return id;
}

/** Read a JSON file, tolerating absence/corruption. */
function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}
/** Atomic-ish write: tmp + rename so a crashed reader never sees a half file. */
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n', 'utf8');
}

/** Verbatim (ref ~7088): agent-authored outbox JSON sometimes arrives with a
 *  literal line break inside a string — repair it before giving up on the file. */
function repairLiteralLineBreaksInJsonStrings(raw) {
  let text = "";
  let inString = false;
  let escaped = false;
  let changed = false;
  for (const ch of raw) {
    if (!inString) {
      text += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escaped) {
      text += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      text += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      text += ch;
      inString = false;
      continue;
    }
    if (ch === "\n") {
      text += "\\n";
      changed = true;
      continue;
    }
    if (ch === "\r") {
      text += "\\r";
      changed = true;
      continue;
    }
    text += ch;
  }
  return { text, changed };
}

class HiveManager {
  /**
   * Verbatim (ref ~7202): the hive root is resolved lazily so a config change to
   * harnessHome moves the hive without a restart. `hiveRoot` may be a string
   * (fixed at boot, the clone's harness passes it that way) or a resolver
   * function returning the root. `root()`/`enabled()` are METHODS — every
   * consumer calls `hive.root()`, and the verbatim IPC shim layer depends on it.
   */
  constructor(hiveRoot) {
    this._resolveRoot = typeof hiveRoot === 'function' ? hiveRoot : () => hiveRoot;
    this._routeTimer = null;
    // verbatim ~7210: a god name accepted before the hive had a root is held
    // here until `ensure` has somewhere to write it. See `presetGodName`.
    this.pendingGodName = null;
    // verbatim spawn-time state (ref ~7722-7788): the OTLP endpoint, the live
    // runtime banner, the autonomy switch and the per-agent memory-notice clock
    // all live on the manager; the hook bridge + launcher + sock path are wired
    // in by the harness after boot (it owns HookServer/ProxyBridges/NodeLauncher).
    this._otelEndpoint = null;
    this._runtime = null;
    this._maySpawn = true;
    this.memoryNoticeAt = new Map();
    this.nodeLauncher = null;      // NodeLauncher — set by harness
    this.hooksSockPath = null;     // () => string — set by harness (its HookServer)
    this.proxyBridges = null;      // ProxyBridges — set by harness
    this._installers = null;       // provider-bridges module — set by harness
    // Bundled company resources dir (roster/organization seed) — () => string.
    // In dev this resolves to the repo `company/`; packaged it's the app's
    // `resources/company/` — wired by the harness after boot.
    this.companyResourceDir = null;
    // verbatim ~10186: the single background committer — one job at a time,
    // with spawn, at most one scan per window, so the main thread never waits
    // for git. gc.autoDetach=false keeps the cleanup step in the foreground.
    this.commits = new HiveCommitQueue({
      git: spawnHiveGit(HiveManager.GIT_BASE_ARGS),
      hasRepo: (root) => fs.existsSync(path.join(root, '.git')),
      clearStaleLock: (root) => this.clearStaleLock(root),
      prepare: (root, git) => this.prepareRepo(root, git),
      afterFirstScan: async (_root, git) => {
        const cache = await setUntrackedCache(git);
        if (cache === null) console.warn('[hive] could not set core.untrackedCache for the hive repo');
      },
      sizeGuard: async (root, git) => {
        const oversized = await ignoreOversized(git, HiveManager.repoFs, root, path.join);
        if (oversized.length) console.warn(`[hive] too big for the hive repo, ignored (left on disk): ${oversized.join(', ')}`);
      },
    });
  }
  /** verbatim ~7217: point newly-spawned agents at the live telemetry collector. */
  setOtelEndpoint(url) { this._otelEndpoint = url; }
  otelEndpoint() { return this._otelEndpoint; }
  /** verbatim ~7235: which build is running this hive (version/packaged/appPath). */
  setRuntimeInfo(info) { this._runtime = info; }
  runtimeInfo() { return this._runtime; }
  /** verbatim ~7246: config.orchestratorMaySpawn mirrored for the prompt builder. */
  setOrchestratorMaySpawn(on) { this._maySpawn = on; }
  orchestratorMaySpawn() { return this._maySpawn; }
  /** verbatim ~7255-7258: a prefix picked in config wins over tasks.json's
   *  own until config is cleared (the verbatim _ticketPrefix slot; the
   *  renderer's ticketMeta closure consults it). */
  _ticketPrefix = null;
  setTicketPrefix(prefix) {
    this._ticketPrefix = isTicketPrefix(prefix) ? prefix : null;
  }
  /** verbatim ~8302-8332: name the orchestrator whether or not it has spawned
   *  yet. Registered → renameAgent. Not yet registered → write the god row
   *  with this name and nothing else, which is exactly what the renderer's
   *  spawn effect reads back (`resolveGodName(reg.agents.god.name)`) before
   *  its first ensureAgent. A name claimed before the hive has a root is held
   *  in pendingGodName and applied by the next ensure(). */
  presetGodName(name) {
    const nextName = name.trim();
    if (!nextName) return { ok: false, error: 'Name is required' };
    const root = this.root();
    if (!root) {
      this.pendingGodName = nextName;
      return { ok: true, name: nextName, deferred: true };
    }
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    if (reg.agents[godId]) return this.renameAgent?.(godId, nextName) ?? { ok: false, error: 'Could not name the orchestrator' };
    try {
      this.ensure();
      reg.godId = godId;
      reg.agents[godId] = {
        id: godId, name: nextName, cwd: this.getHome?.() ?? '',
        isGod: true, status: 'idle', lastSeen: Date.now(),
      };
      writeJson(path.join(root, REGISTRY_FILE), reg);
      this.log({ kind: 'rename', agentId: godId, previousName: null, name: nextName });
      return { ok: true, name: nextName };
    } catch {
      return { ok: false, error: 'Could not name the orchestrator' };
    }
  }
  /** verbatim ~7851: rewrite the generated docs every boot — a hive created
   *  once never saw a protocol change again when this only ran on creation,
   *  and a stale copy is worse than a rewrite. */
  refreshGeneratedDocs() {
    const root = this.root();
    if (!root) return;
    for (const [name, body] of Object.entries(GENERATED_HIVE_DOCS))
      fs.writeFileSync(path.join(root, name), body, 'utf8');
  }
  root() {
    const r = this._resolveRoot();
    return typeof r === 'string' && r ? r : null;
  }
  enabled() { return this.root() !== null; }
  p(...segs) { return path.join(this.root(), ...segs); }
  agentDir(id) { return this.p('agents', assertAgentId(id)); }

  /** Create the hive skeleton idempotently. */
  ensure() {
    fs.mkdirSync(this.p('agents'), { recursive: true });
    for (const d of ['inbox', 'outbox', 'spawn-requests', 'spawn-requests/.done', 'spawn-requests/.failed', 'relay-outbox'])
      fs.mkdirSync(this.p(d), { recursive: true });
    if (!fs.existsSync(this.p(REGISTRY_FILE))) {
      // Seed the Patron company roster on first boot (316 people: 1 god + 315
      // archived). company/roster.json is bundled at build time; paths use
      // {{companyRoot}} (the installed app resources dir) and {{claudeHome}}
      // (the user's ~/.claude) so the seed is portable across machines.
      const seeded = this._seedCompanyRoster?.();
      if (!seeded) writeJson(this.p(REGISTRY_FILE), { godId: 'god', agents: {} });
    }
    if (!fs.existsSync(this.p(TASKS_FILE))) writeJson(this.p(TASKS_FILE), { tasks: [] });
    if (!fs.existsSync(this.p(BOARD_FILE)))
      fs.writeFileSync(this.p(BOARD_FILE), '# Hive board\n\n_Shared plan. The god agent is the scribe._\n', 'utf8');
    if (!fs.existsSync(this.p(LOG_FILE))) fs.writeFileSync(this.p(LOG_FILE), '', 'utf8');
    // verbatim ~7886: merge the live-state files out of hive git history.
    const gitignore = this.p('.gitignore');
    let existingIgnore = '';
    try { if (fs.existsSync(gitignore)) existingIgnore = fs.readFileSync(gitignore, 'utf8'); } catch {}
    const mergedIgnore = mergeIgnoreLines(existingIgnore, HIVE_IGNORE_LINES);
    if (mergedIgnore !== null) fs.writeFileSync(gitignore, mergedIgnore, 'utf8');
    // verbatim ~7863: generated docs land on first creation only — refreshGeneratedDocs
    // overwrites them every boot so a stale protocol never survives an update.
    for (const [name, body] of Object.entries(GENERATED_HIVE_DOCS))
      if (!fs.existsSync(this.p(name))) fs.writeFileSync(this.p(name), body, 'utf8');
    // Codex session exposure on boot (verbatim ~7872): agents whose isolated
    // CODEX_HOME already exists get their sessions re-linked under the user's
    // standard scan roots so codex's own session browser finds the rollouts.
    const userCodexHome = path.join(os.homedir(), '.codex');
    for (const [id, agent] of Object.entries(this.registry().agents)) {
      const codexHome = path.join(this.root(), 'agents', id, '.codex');
      if (agent.provider === 'codex' && fs.existsSync(codexHome)) {
        this.exposeCodexDataDirs(codexHome, userCodexHome, id);
      }
    }
    // verbatim ~7892-7904: the bin/ dir + hook shim + proxy shim + compact
    // script + node launcher + runtime shims — all baked by ensureAgent on
    // first spawn, not by the renderer.
    fs.mkdirSync(this.p('bin'), { recursive: true });
    fs.writeFileSync(this.shimPath(), HOOK_SHIM, 'utf8');
    fs.writeFileSync(this.proxyShimPath(), PROXY_BRIDGE_SHIM, 'utf8');
    try {
      fs.writeFileSync(this.p('bin', 'hive-compact.cjs'), HIVE_COMPACT_SCRIPT, 'utf8');
      fs.chmodSync(this.p('bin', 'hive-compact.cjs'), 493);
    } catch {}
    // nodeLauncher is assigned by the harness after construction (its
    // NodeLauncher instance owns the bundled-node shims).
    this.nodeLauncher?.writeNodeLauncher?.();
    this.nodeLauncher?.writeRuntimeShims?.();
    // verbatim ~7907: a fresh hive becomes a git repo here — once in its life,
    // before anything else can use it — and the first commit marks it.
    if (!fs.existsSync(path.join(this.root(), '.git'))) {
      this.gitInitSync(this.root());
      this.commit('hive: init');
    }
    // verbatim ~7911: a god name claimed before the hive existed resolves now.
    const deferred = this.pendingGodName;
    if (deferred) {
      this.pendingGodName = null;
      this.presetGodName(deferred);
    }
  }

  // ── registry ────────────────────────────────────────────────────────────
  registry() { return readJson(this.p(REGISTRY_FILE), { godId: 'god', agents: {} }); }
  writeRegistry(reg) { writeJson(this.p(REGISTRY_FILE), reg); }

  /**
   * Seed the registry from the bundled Patron company roster
   * (company/roster.json). Returns true when the seed was written, false to
   * fall back to the empty `{godId, agents:{}}` shape.
   *
   * The bundled roster stores `agents[]` (the god row) + `archived[]` (the
   * 315 waiting specialists) — both lists land in `registry.agents` keyed by
   * id, each archived row keeping `archived: true` so the renderer renders the
   * roster state verbatim. `{{companyRoot}}` resolves to the directory that
   * holds roster.json (bundled `resources/company/` or the repo `company/` in
   * dev); `{{claudeHome}}` to the user's `~/.claude`.
   */
  _seedCompanyRoster() {
    try {
      const candidates = [];
      // Packaged: resources/company/roster.json inside app resources.
      const resDir = this.companyResourceDir?.() ?? process.env.OZYC_COMPANY_DIR;
      if (resDir) candidates.push(path.join(resDir, 'roster.json'));
      // Dev: repo-root company/ next to src/.
      candidates.push(path.join(__dirname, '..', '..', 'company', 'roster.json'));
      const seedFile = candidates.find(f => fs.existsSync(f));
      if (!seedFile) return false;
      const companyRoot = path.dirname(seedFile);
      const claudeHome = path.join(os.homedir(), '.claude');
      const resolve = s => (typeof s === 'string'
        ? s.split('{{companyRoot}}').join(companyRoot).split('{{claudeHome}}').join(claudeHome)
        : s);
      const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      const agents = {};
      for (const list of [seed.agents, seed.archived]) {
        if (!Array.isArray(list)) continue;
        for (const raw of list) {
          if (!raw || typeof raw !== 'object' || !raw.id) continue;
          const row = {};
          for (const [k, v] of Object.entries(raw)) row[k] = resolve(v);
          row.isGod = raw.isGod === true || raw.id === (seed.agents?.[0]?.id ?? 'god');
          row.archived = list === seed.archived ? true : raw.archived === true;
          agents[raw.id] = row;
        }
      }
      const godId = seed.agents?.[0]?.id ?? 'god';
      writeJson(this.p(REGISTRY_FILE), { godId, agents });
      // Seed rows need their agent dirs too — _registerAgent early-returns on
      // an existing registry row, so without this a seeded id (god included)
      // never gets agents/<id>/inbox and every deliver() to it returns false.
      for (const id of Object.keys(agents)) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) continue;
        const dir = this.agentDir(id);
        fs.mkdirSync(path.join(dir, 'inbox', '.done'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'outbox', '.sent'), { recursive: true });
        const mem = path.join(dir, 'memory.md');
        if (!fs.existsSync(mem))
          fs.writeFileSync(mem, `# ${agents[id].name ?? id} — durable memory\n`, 'utf8');
      }
      // Archive list for the renderer's roster restore path.
      if (Array.isArray(seed.archived)) {
        const arc = seed.archived.map(a => (a && typeof a === 'object' ? a.id : null)).filter(Boolean);
        writeJson(this.p('roster-archive.json'), { ids: arc });
      }
      this.appendLog?.({ kind: 'roster-seed', godId, count: Object.keys(agents).length });
      return true;
    } catch (e) {
      try { console.error('[hive] company roster seed failed:', e?.message ?? e); } catch {}
      return false;
    }
  }

  /** verbatim ~9218: the agent's memory.md contents, or "" when it was never
   *  written. The voice read-layer and temps call this directly. */
  memory(id) {
    const p = path.join(this.agentDir(id), 'memory.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
  /** verbatim ~9228: a memory.md counts once it holds more than the seed —
   *  200 trimmed bytes is the bar (the seed header alone is under it). */
  hasMemory(id) {
    const p = path.join(this.agentDir(id), 'memory.md');
    if (!fs.existsSync(p)) return false;
    try {
      return fs.readFileSync(p, 'utf8').trim().length > 200;
    } catch {
      return false;
    }
  }
  /** verbatim ~9242: one row per registered agent, active and archived alike,
   *  for the memory index a temp reads at spawn. `empty` is the hasMemory()
   *  judgement; size and time come from a stat so a file that was never
   *  written still gets a row with its would-be path. Never throws: a stat
   *  failure reads as never written. */
  memoryIndexRows() {
    const root = this.root();
    if (!root) return [];
    const reg = this.registry();
    const rows = [];
    for (const [id, agent] of Object.entries(reg.agents ?? {})) {
      const p = path.join(this.agentDir(id), 'memory.md');
      let bytes = 0;
      let updatedAt;
      try {
        const st = fs.statSync(p);
        bytes = st.size;
        updatedAt = st.mtime.toISOString();
      } catch {}
      rows.push({
        id,
        name: agent?.name || id,
        role: agent?.role,
        cwd: agent?.cwd,
        path: p,
        bytes,
        updatedAt,
        empty: !this.hasMemory(id),
        archived: !!agent?.archived,
      });
    }
    return rows;
  }

  /**
   * Dual-contract ensureAgent. VERBATIM (ref ~7935-8086) takes a meta OBJECT
   * and returns the spawn injection `{args, env, seedPrompt?, degraded?}` that
   * makes the process hive-aware — the pty spawn reads inj.args / inj.env /
   * inj.seedPrompt / inj.degraded. The clone's router/lobby/tests pass a bare
   * id STRING and expect the registry record synchronously, so dispatch on the
   * argument shape: string → _registerAgent, object → _ensureAgentSpec.
   */
  ensureAgent(meta, opts = {}) {
    // anything that isn't a meta object (string id, null, …) takes the
    // synchronous registry path — assertAgentId throws there for bad ids.
    if (meta == null || typeof meta !== 'object') return this._registerAgent(meta, opts);
    return this._ensureAgentSpec(meta, opts);
  }

  async _ensureAgentSpec(meta, opts = {}) {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensure();
    const dir = this.agentDir(meta.id);
    const nl = this.nodeLauncher;
    if (opts.semanticMemory && nl) nl.writeMempalaceShim(opts.mempalaceBin);
    fs.mkdirSync(path.join(dir, 'inbox', '.done'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'outbox', '.sent'), { recursive: true });
    const reg = this.registry();
    const prev = reg.agents[meta.id];
    if (meta.cwd) meta = { ...meta, cwd: expandTilde(meta.cwd) };
    const role = preferredAgentRole(meta.role, prev?.role, !!meta.isGod);
    meta = { ...meta, role };
    const identity = path.join(dir, 'identity.md');
    fs.writeFileSync(identity, identityText(meta), 'utf8');
    if (opts.skillsDir) copyBundledSkills(fs, path, opts.skillsDir, path.join(dir, '.claude', 'skills'));
    const memory2 = path.join(dir, 'memory.md');
    if (!fs.existsSync(memory2)) {
      fs.writeFileSync(memory2, `# Memory — ${meta.name} (${meta.id})\n\n_Append durable facts, decisions, and context below._\n`, 'utf8');
    }
    ensureMineIgnore(dir);
    const cursor = path.join(dir, 'cursor.json');
    if (!fs.existsSync(cursor)) this.atomicWriteJson(cursor, { lastProcessed: null });
    const cwd = this.cwdValidity(meta.cwd);
    reg.agents[meta.id] = {
      ...prev,
      ...meta,
      capabilities: meta.capabilities ?? prev?.capabilities ?? [],
      role,
      status: 'idle',
      cwdValid: cwd.valid,
      archived: false,
      lastSeen: Date.now(),
    };
    if (meta.isGod) reg.godId = meta.id;
    this.atomicWriteJson(path.join(root, REGISTRY_FILE), reg);
    this.log({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });
    if (!cwd.valid) this.log({ kind: 'cwd_invalid', agentId: meta.id, cwd: meta.cwd, issue: cwd.issue });
    this.commit?.(`hive: register ${meta.id}`);

    const env = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      HIVE_ROOT: root,
      AGENT_DIR: dir,
    };
    env.HIVE_NODE = nl ? nl.nodeCommand() : 'node';
    if (opts.theme) env.COLORFGBG = opts.theme === 'dark' ? '15;0' : '0;15';
    if ((meta.provider ?? 'claude') === 'grok') {
      const grokTheme = grokThemeEnv(opts.theme, readGrokConfigToml(), process.env.GROK_THEME ?? process.env.LC_GROK_THEME);
      if (grokTheme) env.GROK_THEME = grokTheme;
      delete env.COLORFGBG;
    }
    const claudeProvider = isClaudeProvider(meta.provider ?? 'claude');
    const B = this._installers;
    if (!isHiveAwareProvider(meta.provider)) {
      const preset = providerPreset(meta.provider ?? 'claude');
      const flag2 = preset.initialPromptFlag;
      const prompt = injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath, this._promptDeps());
      const preArgs = [];
      let degraded;
      const desc = bridgeOf(meta.provider);
      const sock2 = this.hooksSockPath?.() ?? null;
      if (desc && sock2) {
        env.HIVE_SOCK = sock2;
        try {
          if (desc.kind === 'hooks' && B) {
            if (desc.shim === 'agy') B.installAgyHooks(console.error, nl);
            else if (desc.shim === 'codex') {
              const codexRoots = sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs);
              const codex = B.installCodexHooks(dir, meta.id, meta.cwd, codexRoots, console.error, nl);
              this.exposeCodexDataDirs(codex.home, path.join(os.homedir(), '.codex'), meta.id);
              env.CODEX_HOME = codex.home;
              preArgs.push('--dangerously-bypass-hook-trust');
              if (!codex.rootsInConfig) for (const d of codexRoots) preArgs.push('--add-dir', d);
            } else if (desc.shim === 'pi') {
              env.PI_CODING_AGENT_DIR = B.installPiHooks(dir);
            } else if (desc.shim === 'opencode') {
              env.OPENCODE_CONFIG_DIR = B.installOpenCodePlugin(dir, opts.theme);
            } else if (desc.shim === 'gemini') {
              env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = B.installGeminiHooks(dir, console.error, nl);
            } else if (desc.shim === 'grok') B.installGrokHooks(console.error, nl);
          } else if (desc.kind === 'proxy' && this.proxyBridges) {
            const sessionId = `proxy-${meta.id}-${crypto.createHash('sha1').update(root + meta.id + String(Date.now())).digest('hex').slice(0, 12)}`;
            env.HIVE_PROXY_SESSION = sessionId;
            const upstream = process.env[desc.baseUrlEnv] || (desc.api === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1');
            const port = await this.proxyBridges.startWithRetry(meta.id, { sock: sock2, sessionId, api: desc.api, upstream });
            if (port > 0) {
              const loopback = `http://127.0.0.1:${port}`;
              if (meta.provider === 'crush') {
                const crush = B.installCrushConfig(dir, loopback, desc.api, opts.theme);
                env.CRUSH_GLOBAL_CONFIG = dir;
                env.CRUSH_GLOBAL_DATA = crush.data;
              } else {
                env[desc.baseUrlEnv] = loopback;
              }
            } else {
              degraded = `${meta.name} is running without hive events: its proxy bridge did not bind after ${PROXY_BIND_ATTEMPTS} attempts. Live status, cost and inbox wake will not work for this session. Respawn the agent to try again.`;
              console.error(`[hive] proxy bridge for ${meta.id} did not bind — spawning without hive events`);
              this.log({ kind: 'proxy-degraded', agentId: meta.id, name: meta.name, provider: meta.provider, attempts: PROXY_BIND_ATTEMPTS });
              this.emit?.('hive:degraded', { agentId: meta.id, name: meta.name, reason: 'proxy-bind', message: degraded });
            }
          }
        } catch (e) {
          console.error(`[hive] install ${desc.kind} bridge failed:`, e);
        }
      }
      // verbatim ~8046: a Windows hook line that could not be made runnable rides
      // the first spawn after it was found.
      const hookNotice = meta.provider && nl ? nl.takeHookLineNotice(meta.provider) : undefined;
      if (hookNotice) {
        degraded = degraded ? `${degraded} ${hookNotice}` : hookNotice;
        this.emit?.('hive:degraded', { agentId: meta.id, name: meta.name, reason: 'hook-command', message: hookNotice });
      }
      const deg = degraded ? { degraded } : {};
      if (preset.seedDelivery === 'type-into-tui') return { args: [...preArgs], env, seedPrompt: prompt, ...deg };
      if (flag2) return { args: [...preArgs, flag2, prompt], env, ...deg };
      if (preset.positionalInitialPrompt) return { args: [...preArgs, prompt], env, ...deg };
      return { args: preArgs, env, ...deg };
    }
    if (claudeProvider && this._otelEndpoint) {
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
      env.OTEL_METRICS_EXPORTER = 'otlp';
      env.OTEL_LOGS_EXPORTER = 'otlp';
      env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
      env.OTEL_EXPORTER_OTLP_ENDPOINT = this._otelEndpoint;
      env.OTEL_METRIC_EXPORT_INTERVAL = '5000';
      env.OTEL_LOGS_EXPORT_INTERVAL = '2000';
      env.OTEL_RESOURCE_ATTRIBUTES = `agent.id=${meta.id},agent.name=${meta.name}`;
    }
    const args = [];
    if (!claudeProvider) return { args, env };
    args.push('--append-system-prompt', injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledgeGraph ?? false, opts.kgCliPath, this._promptDeps()));
    const sock = this.hooksSockPath?.() ?? null;
    const shim = this.shimPath();
    if (sock && shim) {
      env.HIVE_SOCK = sock;
      const noProxy = withLoopbackNoProxy(process.env.NO_PROXY ?? process.env.no_proxy);
      env.NO_PROXY = noProxy;
      env.no_proxy = noProxy;
      const transport = opts.hookTransport;
      const httpHook = transport?.path === 'http' ? httpHookEntry(transport.port, meta.id) : undefined;
      if (transport?.path === 'http') env[HOOK_TOKEN_ENV] = transport.token;
      if (transport?.path === 'command') {
        this.log({ kind: 'hook-transport', agentId: meta.id, path: 'command', reason: transport.reason });
      }
      const settingsPath = path.join(dir, 'settings.json');
      this.atomicWriteJson(settingsPath, hookSettings(
        { nodeRun: (s, ...a) => nl ? nl.nodeRun(s, ...a) : `node "${s}" ${a.join(' ')}`.trim(),
          nodeRunSh: (s, ...a) => nl ? nl.nodeRunSh(s, ...a) : `node "${s}" ${a.join(' ')}`.trim() },
        shim, meta.cwd, opts.mcpDefaults, opts.theme,
        sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs), opts.outputStyle, httpHook));
      args.push('--settings', settingsPath);
    }
    return { args, env };
  }

  /** The verbatim deps injectedPrompt reads back (ref ~8661 — this.<helper>). */
  _promptDeps() {
    return {
      registry: () => this.registry(),
      nodeCommand: () => (this.nodeLauncher ? this.nodeLauncher.nodeCommand() : 'node'),
      runtimeInfo: () => this._runtime,
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      memoryNoticeDue: (key) => memoryNoticeDue(this.memoryNoticeAt, key),
    };
  }

  /** `<root>/bin/hive-hook.cjs` — the hook shim Claude Code spawns (ref ~7373). */
  shimPath() {
    const root = this.root();
    return root ? path.join(root, 'bin', 'hive-hook.cjs') : null;
  }
  /** `<root>/bin/hive-proxy.cjs` — the proxy sidecar script (ref ~7380). */
  proxyShimPath() {
    const root = this.root();
    return root ? path.join(root, 'bin', 'hive-proxy.cjs') : null;
  }

  /** verbatim ~7921: is the spawn cwd a real, absolute directory. */
  cwdValidity(cwd) {
    if (!cwd || typeof cwd !== 'string') return { valid: false, issue: 'missing' };
    cwd = expandTilde(cwd);
    if (!path.isAbsolute(cwd)) return { valid: false, issue: 'not-absolute' };
    try {
      return fs.statSync(cwd).isDirectory() ? { valid: true, issue: null } : { valid: false, issue: 'not-a-directory' };
    } catch {
      return { valid: false, issue: 'missing-dir' };
    }
  }

  /** Register (or return) an agent record only — the clone's router/lobby path.
   *  The verbatim spawn-injection lives in ensureAgent above; callers that just
   *  want the registry row (router, harness.spawnAgent bookkeeping) use this. */
  _registerAgent(id, opts = {}) {
    const reg = this.registry();
    if (reg.agents[id]) return reg.agents[id];
    const dir = this.agentDir(id);
    fs.mkdirSync(path.join(dir, 'inbox', '.done'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'outbox', '.sent'), { recursive: true });
    const agent = {
      id,
      name: opts.name ?? id,
      provider: opts.provider ?? 'claude',
      isAssistant: opts.isAssistant === true,
      isGod: id === (reg.godId ?? 'god'),
      createdAt: new Date().toISOString(),
      sessionId: opts.sessionId ?? crypto.randomUUID(),
      role: opts.role ?? 'worker',
    };
    reg.agents[id] = agent;
    this.writeRegistry(reg);
    const mem = path.join(dir, 'memory.md');
    if (!fs.existsSync(mem))
      fs.writeFileSync(mem, `# ${agent.name} — durable memory\n`, 'utf8');
    appendJsonl(this.p(LOG_FILE), { kind: 'agent-registered', id, provider: agent.provider });
    return agent;
  }

  /** A "floor:<name>" sender is not a local agent — drop the envelope without registering. */
  _isFloorAddr(id) { return typeof id === 'string' && id.startsWith('floor:'); }

  // ── messaging: outbox → inbox ────────────────────────────────────────────
  /**
   * VERBATIM send — (ref ~8790): normalize + routeMessage synchronously so the
   * envelope is delivered AND emitted (hive:message) in one call. Signature is
   * send(partial, from) — `partial` is the message object {to, act, body, ...}.
   * This is THE send the IPC verbatim layer, harness, webhooks, heartbeat,
   * relay and scheduler all use.
   */
  send(partial, from = "system") {
    const msg = this.normalize(partial, from);
    this.routeMessage(msg);
    this.commit?.(`hive: msg ${msg.from}→${msg.to} (${msg.act})`);
    return msg;
  }
  // sendMessage — same verb, kept for the smoke probe + any caller naming it.
  sendMessage(partial, from = "system") { return this.send(partial, from); }
  /**
   * Drop a message into the sender's outbox for the ROUTER to pick up on the
   * next tick (does NOT route or emit now — the agent-outbox model). Renamed
   * outboxDrop so nothing confuses it with the verbatim synchronous send().
   * floor:* senders have no local dir — route the envelope straight to the
   * recipient's inbox (they ARE the remote).
   */
  outboxDrop(from, to, act, body, extra = {}) {
    const reg = this.registry();
    if (!reg.agents[from] && !this._isFloorAddr(from)) this._registerAgent(from, {});
    if (!reg.agents[to] && !this._isFloorAddr(to)) this._registerAgent(to, {});
    const msg = {
      id: crypto.randomUUID(),
      from, to, act,
      body: String(body ?? ''),
      at: new Date().toISOString(),
      ...extra,
    };
    const outDir = this._isFloorAddr(from)
      ? path.join(this.agentDir(to), 'inbox')
      : path.join(this.agentDir(from), 'outbox');
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, `${msg.id}.json`);
    writeJson(f, msg);
    return msg;
  }

  // — router: drain outboxes → inboxes —
  /** Poll-based router. Cheap and robust vs fs.watch quirks on macOS.
   *  Verbatim (ref ~8963-9045): routeOnce() reads every outbox *.json, repairs
   *  literal-line-break JSON, normalizes with harnessId, runs routeMessage (which
   *  emits hive:message / terminalHandoff / bounces), then archives the envelope
   *  under outbox/.sent (or .sent/bad- on failure). */
  routeOnce() {
    const root = this.root();
    if (!root) return 0;
    try {
      this.keyAgentTasks?.();
    } catch {
    }
    const agentsDir = path.join(root, "agents");
    if (!fs.existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of fs.readdirSync(agentsDir)) {
      const outbox = path.join(agentsDir, id, "outbox");
      if (!fs.existsSync(outbox)) continue;
      for (const f of fs.readdirSync(outbox)) {
        if (!f.endsWith(".json")) continue;
        const full = path.join(outbox, f);
        try {
          const raw = fs.readFileSync(full, "utf8");
          let partial;
          try {
            partial = JSON.parse(raw);
          } catch {
            const repaired = repairLiteralLineBreaksInJsonStrings(raw);
            if (!repaired.changed) {
              this.log({ kind: "drop", reason: "malformed-json", from: id, file: f });
              try {
                fs.renameSync(full, path.join(outbox, ".sent", `bad-${f}`));
              } catch {
              }
              continue;
            }
            try {
              partial = JSON.parse(repaired.text);
            } catch {
              this.log({ kind: "drop", reason: "malformed-json", from: id, file: f });
              try {
                fs.renameSync(full, path.join(outbox, ".sent", `bad-${f}`));
              } catch {
              }
              continue;
            }
            this.log({ kind: "outbox-repair", from: id, file: f, repair: "literal-line-break" });
          }
          const msg = this.normalize(partial, id, { harnessId: true });
          msg.from = id;
          this.routeMessage(msg);
          const sent = path.join(outbox, ".sent", f);
          fs.mkdirSync(path.dirname(sent), { recursive: true });
          fs.renameSync(full, sent);
          try {
            this.atomicWriteJson(sent, msg);
          } catch {
          }
          routed++;
        } catch {
          this.log({ kind: "drop", reason: "delivery-failed", from: id, file: f });
          try {
            fs.renameSync(full, path.join(outbox, ".sent", `bad-${f}`));
          } catch {
          }
        }
      }
    }
    if (routed > 0) this.commit?.(`hive: routed ${routed} message(s)`);
    return routed;
  }
  // Back-compat alias — older callers/tests still name the tick routeTick().
  routeTick() { return this.routeOnce(); }
  // — git (single committer, in a background queue, 0.5.5) — verbatim ~10165 —
  // `commit()` only marks the hive as changed. The git work runs in
  // HiveCommitQueue: one job at a time, with spawn, at most one scan per
  // 5-minute window, so the main thread never waits for git.
  static GIT_BASE_ARGS = ['-c', 'commit.gpgsign=false', '-c', 'gc.autoDetach=false', '-c', 'user.name=Hive', '-c', 'user.email=hive@local'];
  /** Synchronous git, for `git init` of a new hive only — once in its life,
   *  before anything else can use the repo (verbatim ~10183). */
  gitInitSync(cwd) {
    spawnSync('git', [...HiveManager.GIT_BASE_ARGS, 'init', '-q'], { cwd, encoding: 'utf8', timeout: 8e3 });
  }
  /** Real filesystem for the hygiene pass — every call swallows its error: a
   *  hygiene pass must never be the reason a hive commit fails (verbatim ~10204). */
  static repoFs = {
    read(p) {
      try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; } catch { return null; }
    },
    write(p, body) {
      try { fs.writeFileSync(p, body, 'utf8'); } catch {}
    },
    sizeOf(p) {
      try { const st = fs.statSync(p); return st.isFile() ? st.size : null; } catch { return null; }
    },
  };
  /** Once per launch, in the queue before the first scan of a root (verbatim
   *  ~10251): refresh every agent's .gitignore (a dormant agent never passes
   *  spawn), drop from the index every tracked file the ignore rules now cover,
   *  and warn when the packed repo crosses the size threshold. Nothing leaves
   *  the disk — `rm --cached` only touches the index. */
  async prepareRepo(root, git) {
    const run = git;
    try {
      for (const name of fs.readdirSync(root)) {
        if (/^mtime-test-[A-Za-z0-9]{6}$/.test(name)) fs.rmSync(path.join(root, name), { recursive: true, force: true });
      }
    } catch {}
    await boundGcMemory(run);
    const agentsDir = path.join(root, 'agents');
    if (fs.existsSync(agentsDir)) {
      try { for (const id of fs.readdirSync(agentsDir)) ensureMineIgnore(path.join(agentsDir, id)); } catch {}
    }
    const { paths, ok } = await untrackIgnored(run);
    if (!ok) {
      console.warn('[hive] could not untrack ignored files from the index');
    } else if (paths.length > 0) {
      console.warn(`[hive] untracked ${paths.length} ignored file(s) from the hive repo; they stay on disk`);
      this.appendLog?.({ kind: 'hive-repo-untracked', count: paths.length, sample: paths.slice(0, 10) });
    }
    const bytes = await packedBytes(run);
    if (bytes !== null && bytes > REPO_SIZE_WARN_BYTES) {
      const gb = (bytes / (1024 * 1024 * 1024)).toFixed(1);
      const tool = path.join(root, 'bin', 'hive-compact.cjs');
      console.warn(`[hive] the hive repo is ${gb}GB of history. With the app closed: node "${tool}"`);
      this.appendLog?.({ kind: 'hive-repo-large', bytes, compact: tool });
    }
  }
  /** Mark the hive as changed — returns at once; the queue commits within the
   *  batching window (verbatim ~10285). Callers needing it finished await
   *  `flushCommits()`. */
  commit(message) {
    const root = this.root();
    if (!root || !fs.existsSync(path.join(root, '.git'))) return;
    this.commits.mark(root, message);
  }
  /** Commit what is marked now and wait for the queue's git, at most `ms`
   *  (verbatim ~10295). True when it finished on its own. */
  flushCommits(ms) { return this.commits.flush(ms); }
  /** The whole scan at app start (untracked cache off) — does not wait. */
  scanCommitsAtStart() {
    const root = this.root();
    if (!root || !fs.existsSync(path.join(root, '.git'))) return;
    void this.commits.scanAtStart(root);
  }
  /** Quit: a last whole scan (untracked cache off), waiting at most `ms`. */
  drainCommitsForQuit(ms) {
    const root = this.root();
    return this.commits.drainForQuit(root && fs.existsSync(path.join(root, '.git')) ? root : null, ms);
  }
  /** The hive is about to be erased (reset): forget the queue, wait briefly. */
  dropCommits(ms) { return this.commits.drop(ms); }
  clearStaleLock(root) {
    if (this.commits.isGitRunning()) return;
    const STALE_THRESHOLD_MS = 1e4;
    try {
      for (const lock of ['index.lock', 'HEAD.lock']) {
        const p = path.join(root, '.git', lock);
        if (fs.existsSync(p) && Date.now() - fs.statSync(p).mtimeMs > STALE_THRESHOLD_MS) fs.rmSync(p);
      }
    } catch {}
  }

  startRouting() { this._routeTimer = setInterval(() => { try { this.routeOnce(); } catch {} }, ROUTE_TICK_MS); this._routeTimer.unref?.(); }
  stopRouting()  { if (this._routeTimer) clearInterval(this._routeTimer); this._routeTimer = null; }

  /** Read + clear an agent's inbox (oldest first). */
  drainInbox(id) {
    const dir = path.join(this.agentDir(id), 'inbox');
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
    const out = [];
    for (const f of files) {
      const full = path.join(dir, f);
      const m = readJson(full, null);
      if (m) out.push(m);
      fs.rmSync(full, { force: true });
    }
    return out;
  }

  /** Undrained inbox envelopes WITHOUT clearing them (oldest first). */
  inbox(id) {
    const dir = path.join(this.agentDir(id), 'inbox');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
      .map(f => readJson(path.join(dir, f), null)).filter(Boolean);
  }
  /** Count undrained inbox messages for an agent (cheap — for the fleet snapshot). */
  inboxBacklog(id) {
    const dir = path.join(this.agentDir(id), "inbox");
    if (!fs.existsSync(dir)) return 0;
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  /**
   * VERBATIM settleInbox (ref ~8157): when a temp worker signals done, sweep the
   * inbox messages it never read into `inbox/.done` so they stop counting as
   * backlog, and report any `request`/`query` it left unanswered (the temp loop
   * nudges the floor about dropped asks). `before` keeps messages that arrived
   * after the done signal pending.
   */
  settleInbox(id, before = Number.POSITIVE_INFINITY) {
    const out = { moved: 0, kept: 0, unanswered: [] };
    const root = this.root();
    if (!root) return out;
    const inbox = path.join(root, 'agents', id, 'inbox');
    if (!fs.existsSync(inbox)) return out;
    let files;
    try {
      files = fs.readdirSync(inbox).filter(f => f.endsWith('.json'));
    } catch { return out; }
    if (files.length === 0) return out;
    const done = path.join(inbox, '.done');
    try { fs.mkdirSync(done, { recursive: true }); } catch { return out; }
    for (const f of files) {
      const fp = path.join(inbox, f);
      let msg = {};
      try { msg = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
      let at = Date.parse(msg.created_at ?? '');
      if (!Number.isFinite(at)) {
        try { at = fs.statSync(fp).mtimeMs; } catch { at = 0; }
      }
      if (at > before) { out.kept++; continue; }
      try {
        fs.renameSync(fp, path.join(done, f));
        out.moved++;
      } catch { continue; }
      if (msg.act === 'request' || msg.act === 'query') {
        out.unanswered.push({
          id: msg.id ?? f,
          act: msg.act,
          from: msg.from ?? 'unknown',
          subject: msg.subject ?? '',
          conversation: msg.conversation ?? '',
        });
      }
    }
    if (out.moved > 0) {
      try {
        this.log({ kind: 'inbox-settled', agentId: id, count: out.moved });
        this.commit?.(`hive: settle inbox of ${id} (${out.moved} unread)`);
      } catch {}
    }
    return out;
  }

  // ── mailbox scans (verbatim from the reference) ─────────────────────────
  /** All messages across every agent's inbox/outbox (and, unless excluded,
   *  the handled subfolders inbox/.done, outbox/.sent), newest first.
   *  SECURITY: subject + body pass through redactSecrets() here, in main. */
  voiceMessages(opts = {}) {
    return runToEnd(this.voiceMessagesSteps(opts));
  }
  /** voiceMessages() for a caller that can wait (the `hive:messages` door):
   *  the same steps in short slices with the app given a turn between them. */
  voiceMessagesAsync(opts = {}) {
    return this.mailScan(`messages:${JSON.stringify(opts)}`, () => this.voiceMessagesSteps(opts));
  }
  /** Read every mailbox once, in the background, so the first screen that
   *  asks finds the parsed files ready. Started right after the window. */
  warmMailboxes() {
    return this.mailScan("warm", () => this.voiceMessagesSteps({ limit: 1 })).then(() => void 0, () => void 0);
  }
  *voiceMessagesSteps(opts) {
    const root = this.root();
    if (!root) return [];
    const agentsDir = path.join(root, "agents");
    if (!fs.existsSync(agentsDir)) return [];
    const wantId = typeof opts.id === "string" ? opts.id.trim() : "";
    const onlyAgent = typeof opts.agentId === "string" ? opts.agentId.trim() : "";
    const includeArchived = opts.includeArchived !== false;
    let owners;
    try {
      owners = onlyAgent ? [onlyAgent] : fs.readdirSync(agentsDir).filter((id) => !id.startsWith(".") && fs.existsSync(this.agentDir(id)));
    } catch {
      return [];
    }
    const seen = new Set();
    const out = [];
    for (const owner of owners) {
      const base = this.agentDir(owner);
      const folders = [
        { dir: path.join(base, "inbox"), direction: "inbox", archived: false },
        { dir: path.join(base, "outbox"), direction: "outbox", archived: false }
      ];
      if (includeArchived) {
        folders.push({ dir: path.join(base, "inbox", ".done"), direction: "inbox", archived: true });
        folders.push({ dir: path.join(base, "outbox", ".sent"), direction: "outbox", archived: true });
      }
      for (const f of folders) {
        for (const m of yield* this.listMessagesSteps(f.dir)) {
          if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
          seen.add(m.id);
          if (wantId && m.id !== wantId) continue;
          out.push({
            id: m.id,
            conversation: m.conversation,
            from: m.from,
            to: m.to,
            act: m.act,
            subject: m.subject,
            body: m.body,
            requires_reply: !!m.requires_reply,
            direction: f.direction,
            owner,
            archived: f.archived,
            created_at: m.created_at
          });
        }
      }
    }
    out.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    const lim = wantId ? 1 : typeof opts.limit === "number" && isFinite(opts.limit) ? Math.max(1, Math.min(200, Math.round(opts.limit))) : 12;
    return out.slice(0, lim).map((m) => ({ ...m, subject: redactSecrets(m.subject), body: redactSecrets(m.body) }));
  }
  /**
   * UNREAD MAIL TO THE PERSON, PER AGENT. A message an agent addressed to
   * "human" is routed to the orchestrator as the person's proxy, and the
   * sender's own copy is archived under its outbox/.sent: that archive is the
   * one durable record per sender, so it is what is counted here. `since` is
   * the renderer's per agent last-opened stamp (ISO); a sender with no stamp
   * counts every message it ever sent the person. Only the count, the stamps
   * and the first three texts travel, never whole threads.
   */
  humanMailSince(since = {}) {
    return runToEnd(this.humanMailSinceSteps(since));
  }
  /** humanMailSince() for a caller that can wait: the same steps in slices. */
  humanMailSinceAsync(since = {}) {
    return this.mailScan(`mail:${JSON.stringify(since)}`, () => this.humanMailSinceSteps(since));
  }
  *humanMailSinceSteps(since) {
    const root = this.root();
    if (!root) return {};
    const agentsDir = path.join(root, "agents");
    if (!fs.existsSync(agentsDir)) return {};
    let owners;
    try {
      owners = fs.readdirSync(agentsDir).filter((id) => !id.startsWith("."));
    } catch {
      return {};
    }
    const out = {};
    for (const owner of owners) {
      const base = path.join(agentsDir, owner, "outbox");
      const stampRaw = since[owner];
      const stamp2 = typeof stampRaw === "string" ? Date.parse(stampRaw) : NaN;
      const floor = Number.isFinite(stamp2) ? stamp2 : -Infinity;
      const hits = [];
      for (const dir of [base, path.join(base, ".sent")]) {
        for (const m of yield* this.listMessagesSteps(dir)) {
          if (m.from !== owner) continue;
          if (m.to !== "human" && m.needs_human !== true) continue;
          const at = Date.parse(m.created_at);
          if (!Number.isFinite(at) || at <= floor) continue;
          hits.push({ at, msg: m });
        }
      }
      if (hits.length === 0) continue;
      hits.sort((a, b) => b.at - a.at);
      out[owner] = {
        count: hits.length,
        latest: new Date(hits[0].at).toISOString(),
        texts: hits.slice(0, 3).map(({ at, msg }) => ({
          id: msg.id,
          at: new Date(at).toISOString(),
          subject: redactSecrets(msg.subject).slice(0, 200),
          body: redactSecrets(msg.body).replace(/\s+/g, " ").trim().slice(0, 240)
        }))
      };
    }
    return out;
  }
  /** Parsed message files per mailbox dir, keyed by file name and checked by
   *  size + mtime. Archived messages never change, so a repeat call is
   *  readdir + stat. */
  messageCache = new Map();
  listMessages(dir) {
    return runToEnd(this.listMessagesSteps(dir));
  }
  /** The scans in flight, by what was asked: callers at the same time that
   *  ask the same thing share one scan. */
  mailScans = new Map();
  /** One background scan at a time: the second finds the first one's files
   *  already parsed instead of reading them beside it. */
  mailScanTail = Promise.resolve();
  /** The last background scan: how many slices it ran in and the longest one. */
  mailScanLast = { slices: 0, longestMs: 0 };
  mailScanStats() {
    return { ...this.mailScanLast };
  }
  mailScan(key, steps) {
    const running = this.mailScans.get(key);
    if (running) return running;
    const run = this.mailScanTail.then(() => runInSlices(steps(), this.mailScanLast));
    this.mailScanTail = run.catch(() => void 0);
    this.mailScans.set(key, run);
    const done = () => {
      if (this.mailScans.get(key) === run) this.mailScans.delete(key);
    };
    run.then(done, done);
    return run;
  }
  /** listMessages() as steps: one step per file, so a background scan can
   *  give the app a turn in the middle of a folder of 500. */
  *listMessagesSteps(dir) {
    if (!fs.existsSync(dir)) {
      this.messageCache.delete(dir);
      return [];
    }
    let files;
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch {
      return [];
    }
    const prev = this.messageCache.get(dir);
    const next = new Map();
    const out = [];
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      let hit = prev?.get(f);
      if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
        let msg = null;
        try {
          msg = JSON.parse(fs.readFileSync(full, "utf8"));
        } catch {
        }
        hit = { size: st.size, mtimeMs: st.mtimeMs, msg };
      }
      next.set(f, hit);
      if (hit.msg !== null) out.push({ ...hit.msg });
      yield;
    }
    this.messageCache.set(dir, next);
    return out;
  }

  /** Last `n` log entries (newest last), parsed (raw string when unparseable). */
  logTail(n = 200) {
    if (!fs.existsSync(this.p(LOG_FILE))) return [];
    return tailLines(this.p(LOG_FILE), n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  }

  // ── sessions (verbatim from the reference) ──────────────────────────────
  recordSession(agentId, sessionId) {
    const root = this.root();
    if (!root || !sessionId) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[agentId];
      if (!agent || agent.sessionId === sessionId) return;
      agent.sessionHistory = pushSessionHistory(agent.sessionHistory, agent.sessionId);
      agent.sessionId = sessionId;
      agent.lastSeen = Date.now();
      writeJson(this.p(REGISTRY_FILE), reg);
      this.log({ kind: "session", agentId, sessionId });
    } catch {
    }
  }
  /** The last known session_id for an agent, or undefined. Used to build a
   *  `claude --resume <id>` spawn so a restarted agent resumes its thread. */
  lastSession(agentId) {
    return this.registry().agents[agentId]?.sessionId;
  }
  /** Every session a restart may try, the current key first and then the keys
   *  it displaced. The caller resumes the first one whose transcript exists. */
  resumeCandidates(agentId) {
    const agent = this.registry().agents[agentId];
    if (!agent) return [];
    return pushSessionHistory(agent.sessionHistory, agent.sessionId);
  }

  /** verbatim ~10119: one PII-free usage row per accepted sample. Lives at the
   *  hive ROOT so `mempalace mine` (which scans per-agent dirs) never ingests
   *  it. Best-effort — never throws into the beat. */
  appendCostLedger(sample) {
    const root = this.root();
    if (!root) return;
    const row = {
      agent_id: sample.agentId,
      session_id: sample.sessionId,
      ts: sample.ts,
      input: sample.input,
      output: sample.output,
      cache_read: sample.cacheRead,
      cache_creation: sample.cacheCreation,
      model: sample.model,
      usd: sample.usd,
    };
    try {
      fs.appendFileSync(path.join(root, 'cost-ledger.jsonl'), JSON.stringify(row) + '\n', 'utf8');
    } catch {
    }
  }

  // — messaging (verbatim reference pipeline) —
  /** Normalize a partial message into a full HiveMessage.
   *
   *  The id becomes the inbox filename. On the agent outbox path the harness
   *  OWNS it (`harnessId`, public #566): outbox JSON is agent authored, and a
   *  sender id used to flow straight into deliver(), so a duplicate id
   *  overwrote earlier mail, a path like id quarantined it unlogged, and `../`
   *  wrote outside the hive. Other callers (the teams bridge re-sending a
   *  stored message, the UI) keep their id when it is a plain name; an unsafe
   *  one is replaced, never used as a path. */
  normalize(partial, from, opts = {}) {
    const act = partial.act ?? "inform";
    return {
      id: !opts.harnessId && isSafeMessageId(partial.id) ? partial.id : `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? "god",
      act,
      subject: partial.subject ?? "",
      body: partial.body ?? "",
      // hops is harness owned (public #563). An agent written value is only a
      // carried count: clamp it to 0..HOP_CAP so an echoed relay keeps
      // climbing toward the cap while a copied forward `hops: 13` cannot read
      // as a runaway loop. Only a harness bounce moves it (bounceToGod).
      hops: Math.max(0, Math.min(typeof partial.hops === "number" && Number.isFinite(partial.hops) ? Math.floor(partial.hops) : 0, HOP_CAP)),
      requires_reply: partial.requires_reply ?? ["request", "query", "propose"].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  /** Atomically deliver a message into a recipient agent's inbox.
   *  Returns false when the recipient has no inbox, so the caller can bounce and
   *  log the drop rather than let the message vanish. */
  deliver(msg, toId) {
    const inbox = path.join(this.agentDir(toId), "inbox");
    if (!fs.existsSync(inbox)) return false;
    if (!isSafeMessageId(msg.id)) throw new Error(`hive: refusing an unsafe message id ${JSON.stringify(msg.id)}`);
    this.atomicWriteJson(path.join(inbox, `${msg.id}.json`), msg);
    return true;
  }
  // Every JSON write is temp file then rename (public #529, verbatim ref
  // ~10152): a crash mid write left registry.json or tasks.json torn, and
  // readJson reads a torn file as empty.
  atomicWriteJson(p, data) {
    const tmp = `${p}.tmp-${shortRand()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw e;
    }
  }
  /** One harness bounce of `msg` to god: bump the hop counter, rewrite the
   *  subject, and drop with a hop-cap log once the counter passes HOP_CAP.
   *  Agents cannot move hops past the cap (normalize clamps what they wrote),
   *  so this fuse fires only on a real relay loop, a bounced mail that keeps
   *  coming back undeliverable (public #563). */
  bounceToGod(msg, godId, subject) {
    const hops = msg.hops + 1;
    if (hops > HOP_CAP) {
      this.log({ kind: "drop", reason: "hop-cap", from: msg.from, to: msg.to, id: msg.id });
      return;
    }
    this.deliver({ ...msg, hops, to: godId, subject }, godId);
  }
  /**
   * Teams (plan 4.6). The bridge to other machines registers here; hive.ts
   * itself never imports it, so a solo build's router is the upstream one
   * plus this one branch. `send` takes a message addressed `member:<id>`;
   * `rosterLine` adds the teammates on other machines to god's roster.
   */
  remote = {};
  setRemote(remote) {
    this.remote = remote;
  }
  routeMessage(msg) {
    const reg = this.registry();
    const godId = reg.godId ?? "god";
    // floor:* envelope (clone relay) — park in relay-outbox for the RelayClient.
    // Same seam the verbatim member:/remote branch fills for teammates; here the
    // remote floor is the target, so we hand the file off instead of delivering.
    if (msg.to.startsWith("floor:")) {
      const rd = this.p("relay-outbox");
      fs.mkdirSync(rd, { recursive: true });
      try {
        this.atomicWriteJson(path.join(rd, `${msg.id}.json`), msg);
        this.log({ kind: "route", via: "relay", from: msg.from, to: msg.to, id: msg.id, act: msg.act });
      } catch (e) {
        this.log({ kind: "drop", reason: "relay-park", from: msg.from, to: msg.to, id: msg.id, error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (msg.to.startsWith("member:")) {
      if (this.remote.send) {
        this.remote.send(msg);
        this.log({ kind: "route", via: "teams", from: msg.from, to: msg.to, id: msg.id, act: msg.act });
        this.noteOutbox(msg, reg);
      } else {
        this.log({ kind: "drop", reason: "no-teams", from: msg.from, to: msg.to, id: msg.id });
        this.bounceToGod(msg, godId, `[undeliverable — "${msg.to}" is a teammate on another machine and this machine is not in a team] ${msg.subject}`);
      }
      return;
    }
    const resolveTo = (to) => to === "human" || to === "god" ? godId : to;
    const targets = msg.to === "broadcast" ? selectBroadcastTargets(reg.agents, msg.from) : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    if (msg.to === "broadcast") {
      const skipped = heldBroadcastSkips(reg.agents, msg.from);
      if (skipped.length) this.log({ kind: "broadcast-skip-held", id: msg.id, skipped });
    }
    const delivered = [];
    for (const t of targets) {
      if (reg.agents[t]?.isAssistant) {
        this.bounceToGod(msg, godId, `[bounced — "${t}" is the send-only prep assistant; route work to a real agent] ${msg.subject}`);
        continue;
      }
      if (t !== godId && reg.agents[t]?.archived) {
        if (this.deliver(msg, t)) delivered.push(t);
        this.log({ kind: "archived-recipient", from: msg.from, to: t, id: msg.id, act: msg.act });
        const sender = reg.agents[msg.from];
        if (msg.requires_reply && sender && !sender.archived) {
          this.routeMessage(this.normalize({
            to: msg.from,
            act: "inform",
            in_reply_to: msg.id,
            conversation: msg.conversation,
            hops: msg.hops + 1,
            requires_reply: false,
            subject: `[no one is there to answer — "${t}" is archived] ${msg.subject}`,
            body: `Your ${msg.act} to ${t} was filed in its inbox, but ${t} has no live terminal (archived), so it will only be read if ${t} is restored or re-hired under the same id. If you need this done now, route it to an agent on the live roster or hire one.`
          }, "system"));
        }
        continue;
      }
      if (t !== godId && !canReceiveInbox(reg.agents[t]?.provider)) {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.bounceToGod(msg, godId, `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? "a hookless CLI"} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`);
        } else delivered.push(t);
        continue;
      }
      const proxyDesc = bridgeOf(reg.agents[t]?.provider);
      if (t !== godId && proxyDesc?.kind === "proxy" && proxyDesc.inboxDelivery === "terminal") {
        if (!this.emitTerminalHandoff(msg, t)) {
          this.bounceToGod(msg, godId, `[undeliverable — "${t}" runs ${reg.agents[t]?.provider ?? "a proxy-tier CLI"} and the terminal handoff failed (renderer unavailable); relay this to it] ${msg.subject}`);
        } else delivered.push(t);
        continue;
      }
      if (this.deliver(msg, t)) {
        delivered.push(t);
        continue;
      }
      if (t !== godId && !reg.agents[t] && this.remote.resolve) {
        const found = this.remote.resolve(t);
        if (found && "memberId" in found && this.remote.send) {
          const to = `member:${found.memberId}`;
          this.remote.send({ ...msg, to });
          this.log({ kind: "route", via: "teams", from: msg.from, to, id: msg.id, act: msg.act, name: t });
          delivered.push(to);
          continue;
        }
        if (found && "ambiguous" in found) {
          this.log({ kind: "drop", reason: "ambiguous-name", from: msg.from, to: t, id: msg.id });
          this.bounceToGod(msg, godId, `[undeliverable — "${t}" matches more than one teammate: ${found.ambiguous.join("; ")}; write to one by member:<id>] ${msg.subject}`);
          continue;
        }
      }
      this.log({ kind: "drop", reason: "no-inbox", from: msg.from, to: t, id: msg.id });
      if (t !== godId) {
        this.bounceToGod(msg, godId, `[undeliverable — no agent "${t}" on this floor; check the id against the roster] ${msg.subject}`);
      }
    }
    this.log({ kind: "message", from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id, delivered });
    this.noteOutbox(msg, reg);
    this.emitMessage(msg, targets);
    try {
      this.routedObserver?.(msg, targets);
    } catch {
    }
  }
  /** Observer invoked for EVERY routed message with its resolved targets.
   *  A seam for main-process features that react to hive traffic. */
  routedObserver = null;
  setRoutedObserver(cb) {
    this.routedObserver = cb;
  }
  /** v0.4.9 phase 2 (D4): where a routed message lands in its SENDER's activity
   *  digest (main/activityDigest.ts). Set by the main process; a no-op in tests
   *  and headless runs. */
  activitySink = null;
  setActivitySink(cb) {
    this.activitySink = cb;
  }
  /** The sender's outbox line. Only an agent on the floor has a digest: a
   *  person's dispatch ('human'), system mail and an id that is not in the
   *  registry have no card to show it on. Best-effort, never breaks routing. */
  noteOutbox(msg, reg) {
    if (!this.activitySink) return;
    if (msg.from === "human" || msg.from === "system" || !reg.agents[msg.from]) return;
    const created = Date.parse(msg.created_at);
    const entry = entryForMessage(msg.subject, Number.isFinite(created) ? created : Date.now());
    if (!entry) return;
    try {
      this.activitySink(msg.from, entry);
    } catch {
    }
  }
  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the floor can fly an envelope from the sender to each one. Best-effort. */
  emitMessage(msg, targets) {
    this.emit?.("hive:message", {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Coral-tints the floor envelope for a message the agent flagged for the
      // human (now routed to the god proxy). Cosmetic only — no queue behind it.
      needsHuman: msg.to === "human"
    });
  }
  /** Non-Claude providers cannot drain hive inbox; hand direct mail to the
   *  renderer so it can queue a terminal work order for the target PTY. */
  emitTerminalHandoff(msg, targetId) {
    const delivered = this.emit?.("hive:terminalHandoff", {
      id: msg.id,
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      body: msg.body,
      requiresReply: msg.requires_reply,
      createdAt: msg.created_at
    }) === true;
    this.log({
      kind: "terminal-handoff",
      from: msg.from,
      to: targetId,
      act: msg.act,
      subject: msg.subject,
      id: msg.id,
      delivered
    });
    return delivered;
  }

  /**
   * drainForStop — a Stop-hook decision: unread inbox mail blocks the agent
   * from going idle, and the block reason is the next prompt (verbatim).
   */
  drainForStop(agentId) {
    const dir = this.agentDir(agentId);
    if (!fs.existsSync(dir)) return { block: false };
    const cursorPath = path.join(dir, "cursor.json");
    const cursor = readJson(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId).filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed).sort((a, b) => a.id < b.id ? -1 : 1);
    if (fresh.length === 0) return { block: false };
    cursor.lastProcessed = fresh[fresh.length - 1].id;
    writeJson(cursorPath, cursor);
    this.log({ kind: "drain", agentId, count: fresh.length });
    const lines = fresh.map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`).join("\n");
    const reason = [
      `You have ${fresh.length} new hive message(s) in your inbox. Address them before finishing:`,
      lines,
      // Native separators (join, not string-concatenated `/`) so a Windows agent is
      // handed a path its own shell/tools accept, not `C:\…\agents\god/inbox/`.
      `Open the files in ${path.join(dir, "inbox")} for full detail, act on each, then move handled ones to ${path.join(dir, "inbox", ".done")}. Reply via your outbox if a message requires it.`
    ].join("\n");
    return { block: true, reason };
  }

  // ── tasks.json kanban ────────────────────────────────────────────────────
  tasks() { return readJson(this.p(TASKS_FILE), { tasks: [] }); }
  addTask(t) {
    const d = this.tasks();
    const card = {
      id: crypto.randomUUID().slice(0, 8),
      title: String(t.title ?? 'untitled'),
      status: 'todo',                          // todo|doing|blocked|done
      assignee: t.assignee ?? null,
      humanQA: t.humanQA ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...t,
    };
    d.tasks.push(card);
    writeJson(this.p(TASKS_FILE), d);
    return card;
  }
  patchTask(id, patch) {
    const d = this.tasks();
    const c = d.tasks.find(x => x.id === id);
    if (!c) return null;
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    writeJson(this.p(TASKS_FILE), d);
    return c;
  }

  // ── board.md (god is the only scribe) ────────────────────────────────────
  board() { return fs.existsSync(this.p(BOARD_FILE)) ? fs.readFileSync(this.p(BOARD_FILE), 'utf8') : ''; }
  writeBoard(md, by = 'god') {
    if (by !== 'god') throw new Error('board.md is god-scribed only');
    fs.writeFileSync(this.p(BOARD_FILE), md, 'utf8');
  }

  // ── codex per-agent home exposure (verbatim from the reference) ─────────
  /** Move this agent's codex `sessions`/`archived_sessions` under the user's
   *  standard Codex scan roots (namespaced by hive id), leaving a symlink in
   *  the isolated CODEX_HOME so codex's own session browser finds rollouts. */
  exposeCodexDataDirs(home, userHome, agentId) {
    for (const kind of ["sessions", "archived_sessions"]) {
      try {
        this.exposeCodexDataDir(home, userHome, agentId, kind);
      } catch (e) {
        console.error(`[hive] exposeCodexDataDir(${kind}) failed:`, e);
      }
    }
  }
  moveCodexDataDir(from, to) {
    try {
      fs.renameSync(from, to);
    } catch (e) {
      if (e.code !== "EXDEV") throw e;
      fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  }
  exposeCodexDataDir(home, userHome, agentId, kind) {
    const root = this.root();
    if (!root) return;
    if (!agentId || path.basename(agentId) !== agentId || agentId === "." || agentId === "..") {
      throw new Error(`invalid agent id: ${agentId}`);
    }
    const source = path.join(home, kind);
    const scanRoot = path.join(userHome, kind, "ozycomp");
    const hiveId = crypto.createHash("sha1").update(root).digest("hex").slice(0, 12);
    const target = path.join(scanRoot, hiveId, agentId);
    let sourceStat = null;
    try {
      sourceStat = fs.lstatSync(source);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (sourceStat?.isSymbolicLink()) {
      let current = null;
      try {
        current = fs.realpathSync(source);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
        fs.unlinkSync(source);
        sourceStat = null;
      }
      if (current) {
        const rel = path.relative(fs.realpathSync(scanRoot), current);
        const scope = path.dirname(rel);
        if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && path.dirname(scope) === "." && path.basename(rel) === agentId) return;
        throw new Error(`${source} points outside ${scanRoot}`);
      }
    }
    if (sourceStat && !sourceStat.isDirectory()) throw new Error(`${source} is not a directory`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (sourceStat) {
      if (fs.existsSync(target)) {
        if (fs.readdirSync(target).length > 0) throw new Error(`${source} and ${target} both contain data`);
        fs.rmSync(target, { recursive: true, force: true });
      }
      this.moveCodexDataDir(source, target);
    } else if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }
    try {
      fs.symlinkSync(target, source, process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      if (!fs.existsSync(source) && fs.existsSync(target)) {
        try {
          this.moveCodexDataDir(target, source);
        } catch {
        }
      }
      throw e;
    }
  }
  /** Remove rollout directories moved under the user's standard Codex scan
   *  roots before a full hive reset removes the isolated CODEX_HOME links. */
  removeExposedCodexData() {
    const root = this.root();
    if (!root) return;
    const agents = path.join(root, "agents");
    if (!fs.existsSync(agents)) return;
    const userHome = path.join(os.homedir(), ".codex");
    for (const entry of fs.readdirSync(agents, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const kind of ["sessions", "archived_sessions"]) {
        const source = path.join(agents, entry.name, ".codex", kind);
        try {
          if (!fs.lstatSync(source).isSymbolicLink()) continue;
          const target = fs.realpathSync(source);
          const scanRoot = fs.realpathSync(path.join(userHome, kind, "ozycomp"));
          const rel = path.relative(scanRoot, target);
          const scope = path.dirname(rel);
          if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || path.dirname(scope) !== "." || path.basename(rel) !== entry.name) continue;
          fs.rmSync(target, { recursive: true, force: true });
        } catch (e) {
          if (e.code !== "ENOENT") {
            console.error("[hive] removeExposedCodexData failed:", e);
          }
        }
      }
    }
  }

  // ── cost ledger ──────────────────────────────────────────────────────────
  ledgerAppend(row) { appendJsonl(this.p(LEDGER_FILE), row); }

  log(obj) { appendJsonl(this.p(LOG_FILE), obj); }
  /** Verbatim name (ref ~10050): the hive's structured log sink. `log` is the
   *  short alias kept for internal callers; appendLog is what the verbatim
   *  layer and reflector call. */
  appendLog(obj) { this.log(obj); }
}

module.exports = { HiveManager, HiveCommitQueue, dropAllCommitQueues, assertAgentId, readJson, writeJson, appendJsonl, REGISTRY_FILE, TASKS_FILE, BOARD_FILE, LOG_FILE, LEDGER_FILE, HOP_CAP, stamp, shortRand, SAFE_MESSAGE_ID, isSafeMessageId, tailLines, redactSecrets, ensureMineIgnore, mergeIgnoreLines, AGENT_IGNORE_LINES };
