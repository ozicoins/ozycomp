'use strict';
/**
 * MemoryReflector — VERBATIM port of reference index.js:
 *   kill helpers (ensureKilled/groupMembers/shouldSweep/hardKillTree) ~61-121
 *   region/byte constants + helpers      ~6736-6804
 *   projectKey/legacyProjectKey/projectDir/lastLineMatch ~12955-13078
 *   extractLastAssistantText + runHiddenClaude (BOOT_QUIET_MS) ~13814-13956
 *   BUDGET/marker/model constants + CONDENSE/ARCHIVE prompts ~13957-14027
 *   class MemoryReflector                ~14028-14429
 *   countSections..parseArchiveSummary   ~14431-14775
 *
 * Dep mapping: node_fs→node:fs, node_crypto→node:crypto,
 * node_child_process→node:child_process, expandTilde→./config,
 * resolveCommand/shellPathReady/userShellPath→./command-resolver,
 * submitEncodingFor/PTY_SUBMIT_DELAY_MS→./pty-submit,
 * pty__namespace→node-pty (lazy require, like pty-manager).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { expandTilde } = require('./config');
const { resolveCommand, shellPathReady, userShellPath } = require('./command-resolver');
const { submitEncodingFor, PTY_SUBMIT_DELAY_MS } = require('./pty-submit');

// ── verbatim kill helpers (ref ~61-121) ──────────────────────────────────────
const KILL_GRACE_MS = 4e3;
function hardKillTree(pid) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}
function groupMembers(pgid) {
  if (process.platform === 'win32' || typeof pgid !== 'number' || pgid <= 0) return null;
  try {
    const out = spawnSync('ps', ['-axo', 'pid=,pgid=,lstart='], { encoding: 'utf8', timeout: 3e3 }).stdout ?? '';
    const members = new Map();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(-?\d+)\s+(.+)$/);
      if (m && Number.parseInt(m[2], 10) === pgid) members.set(Number(m[1]), m[3]);
    }
    return members;
  } catch { return null; }
}
function shouldSweep(before, after) {
  if (before === null || after === null) return true;
  if (after.size === 0) return false;
  for (const [pid, started] of after) if (before.get(pid) === started) return true;
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

// ── region/byte constants + helpers (verbatim ~6736-6804) ────────────────────
const RULES_HEADING = '## 📏 Rules (never moved)';
const RULES_HEADING_PREFIX = '## 📏';
const RULES_CAP_BYTES = 16 * 1024;
const PINNED_NOTES_CAP_BYTES = 48 * 1024;
const ARCHIVE_CAP_BYTES = 32 * 1024;
const MOVE_STEP_BYTES = 32 * 1024;
const RAW_PART_BYTES = 256 * 1024;
const KEPT_SECTIONS_CAP_BYTES = 40 * 1024;
const KEPT_SECTIONS_MIN = 3;
const MEMORY_NOTICE_WINDOW_MS = 864e5;
const PINNED_HEADING_PREFIX = '## 📌';
const PINNED_PLACEHOLDER = '_(none yet)_';
const ARCHIVE_FILE = 'memory-archive.md';
const RAW_ARCHIVE_BASE = 'memory-archive-raw';
function rawPartName(n) {
  return n <= 1 ? `${RAW_ARCHIVE_BASE}.md` : `${RAW_ARCHIVE_BASE}-${n}.md`;
}
function rawPartNumber(name) {
  if (name === `${RAW_ARCHIVE_BASE}.md`) return 1;
  const m = /^memory-archive-raw-(\d+)\.md$/.exec(name);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 2 ? n : null;
}
function rulesBodyOf(text) {
  return regionBodyOf(text, RULES_HEADING_PREFIX);
}
function mergeBodies(a, b) {
  if (a === null || !a.trim()) return b;
  if (!b.trim()) return a;
  return `${a}\n${b}`;
}
function regionBodyOf(text, prefix) {
  let body = null;
  let cur = null;
  const close = () => {
    if (cur) body = mergeBodies(body, cur.join('\n').replace(/\s+$/, ''));
    cur = null;
  };
  for (const l of text.split('\n')) {
    if (/^##\s/.test(l)) {
      close();
      if (l.trim().startsWith(prefix)) cur = [];
    } else if (cur && (cur.length > 0 || l !== '')) cur.push(l);
  }
  close();
  return body;
}
function pinnedNotesBytesOf(text) {
  const body = regionBodyOf(text, PINNED_HEADING_PREFIX);
  if (!body) return 0;
  return utf8Bytes(body.split('\n').map((l) => l.trim()).filter((l) => l && l !== PINNED_PLACEHOLDER).join('\n'));
}
function pinnedNeedsSort(text) {
  return rulesBodyOf(text) === null && pinnedNotesBytesOf(text) > PINNED_NOTES_CAP_BYTES;
}
function noticeDue(last, now, windowMs = MEMORY_NOTICE_WINDOW_MS) {
  return last === undefined || now - last >= windowMs;
}
function rulesBytesOf(text) {
  const body = rulesBodyOf(text);
  return body ? utf8Bytes(body) : 0;
}
function rulesOverLimit(text) {
  return rulesBytesOf(text) > RULES_CAP_BYTES;
}
function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) n += 1;
    else if (c < 2048) n += 2;
    else if (c >= 55296 && c <= 56319) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ── project dir + transcript scan (verbatim ~12955-13078) ────────────────────
function projectKey(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
function legacyProjectKey(cwd) {
  return process.platform === 'win32' ? projectKey(cwd) : cwd.replace(/^\//, '').replaceAll('/', '-');
}
function projectDir(cwd) {
  const root = path.join(os.homedir(), '.claude/projects');
  const current = path.join(root, projectKey(cwd));
  if (fs.existsSync(current)) return current;
  const legacyKey = legacyProjectKey(cwd);
  if (!legacyKey) return current;
  const legacy = path.join(root, legacyKey);
  return fs.existsSync(legacy) ? legacy : current;
}
const TAIL_FIRST_WINDOW_BYTES = 256 * 1024;
function lastLineMatch(file, pick) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    for (let win = TAIL_FIRST_WINDOW_BYTES; ; win *= 2) {
      const len = Math.min(size, win);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      const first = len < size ? 1 : 0;
      for (let i = lines.length - 1; i >= first; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        const hit = pick(trimmed);
        if (hit !== undefined) return hit;
      }
      if (len >= size) return undefined;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ── transcript answer extraction + hidden Claude call (verbatim ~13814-13956) ─
const BOOT_QUIET_MS = 1500;
function extractLastAssistantText(cwd, spawnedAt) {
  try {
    const dir = projectDir(cwd);
    if (!fs.existsSync(dir)) return null;
    const candidates = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
        if (mtime >= spawnedAt - 5e3) candidates.push({ f, mtime });
      } catch {}
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return lastLineMatch(path.join(dir, candidates[0].f), (line) => {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return undefined;
      }
      if (rec.type !== 'assistant') return undefined;
      const content = rec.message?.content;
      if (!Array.isArray(content)) return undefined;
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j];
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return block.text.trim();
        }
      }
      return undefined;
    }) ?? null;
  } catch {
    return null;
  }
}
async function runHiddenClaude(prompt, opts) {
  await shellPathReady();
  return new Promise((resolve) => {
    if (!prompt.trim()) {
      resolve({ ok: false, error: 'empty prompt' });
      return;
    }
    const cwd = opts.cwd ? expandTilde(opts.cwd) : opts.cwd;
    if (!cwd || !fs.existsSync(cwd)) {
      resolve({ ok: false, error: `cwd does not exist: ${opts.cwd}` });
      return;
    }
    opts = { ...opts, cwd };
    const binary = (opts.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const exe = resolveCommand(binary);
    const disallowed = opts.disallowedTools ?? ['Edit', 'Write', 'NotebookEdit'];
    const addDirs = (opts.addDirs ?? []).filter((d) => d && fs.existsSync(d));
    const args = [
      '--model',
      opts.model,
      '--permission-mode',
      'bypassPermissions',
      '--disallowedTools',
      ...disallowed
    ];
    for (const d of addDirs) {
      args.push('--add-dir', d);
    }
    const bootCapMs = opts.bootCapMs ?? 7e3;
    const idleMs = opts.idleMs ?? 3500;
    const timeoutMs = opts.timeoutMs ?? 18e4;
    const spawnedAt = Date.now();
    const winWrap = process.platform === 'win32' && !/\.(exe|com)$/i.test(exe);
    const spawnFile = winWrap ? process.env.ComSpec || 'cmd.exe' : exe;
    const spawnArgs = winWrap ? ['/c', exe, ...args] : args;
    let ptyProc;
    try {
      const pty = require('node-pty');
      ptyProc = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-color',
        cols: 220,
        rows: 50,
        cwd: opts.cwd,
        env: {
          ...process.env,
          PATH: userShellPath(),
          ...opts.env ?? {}
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    let settled = false;
    let promptSent = false;
    let bootTimer = null;
    let idleTimer = null;
    let bootMaxTimer;
    let globalTimer;
    const kill = () => {
      const pid = ptyProc.pid;
      try {
        ptyProc.kill();
      } catch {}
      if (process.platform !== 'win32') {
        try {
          ptyProc.destroy?.();
        } catch {}
      }
      ensureKilled(pid);
    };
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      clearTimeout(bootMaxTimer);
      clearTimeout(globalTimer);
      kill();
      resolve(r);
    };
    const captureAndFinish = () => {
      const text = extractLastAssistantText(opts.cwd, spawnedAt);
      finish(text ? { ok: true, text } : { ok: false, error: 'no assistant response found in transcript' });
    };
    const sendPrompt = () => {
      if (settled || promptSent) return;
      promptSent = true;
      if (bootTimer) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      const enc = submitEncodingFor('claude', prompt);
      ptyProc.write(enc.payload);
      setTimeout(() => {
        if (!settled) ptyProc.write(enc.key);
      }, PTY_SUBMIT_DELAY_MS);
    };
    bootMaxTimer = setTimeout(sendPrompt, bootCapMs);
    globalTimer = setTimeout(
      () => finish({ ok: false, error: 'hidden session timed out' }),
      timeoutMs
    );
    ptyProc.onData(() => {
      if (!promptSent) {
        if (bootTimer) clearTimeout(bootTimer);
        bootTimer = setTimeout(sendPrompt, BOOT_QUIET_MS);
      } else {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(captureAndFinish, idleMs);
      }
    });
    ptyProc.onExit(() => {
      if (!settled) captureAndFinish();
    });
  });
}

// ── verbatim budget/marker/model constants (~13957-13992) ────────────────────
const BUDGET_BYTES = 131072;
const CONDENSE_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 18e4;
const BACKOFF_GROW_BYTES = 16384;
const BACKOFF_WINDOW_MS = 864e5;
const BACKOFF_REASONS = new Set(['not-smaller', 'summarize-failed']);
const PINNED_WARN_WINDOW_MS = 864e5;
const RULES_WARN_WINDOW_MS = 864e5;
const MOVE_NEEDS_RULES_REGION = true;
const PINNED_HEADING = '## 📌 Durable facts (pinned — never condensed)';
const CONDENSED_HEADING = '## 🗜 Condensed history';
const RECENT_HEADING = '## Recent';
const CONDENSED_MARKER = '<<<CONDENSED>>>';
const HOIST_MARKER = '<<<HOIST>>>';
const END_MARKER = '<<<END>>>';
const HOIST_BULLET_PREFIX = '- ';
const SUMMARY_MARKERS = [CONDENSED_MARKER, HOIST_MARKER, END_MARKER];

// ── verbatim prompts (~13993-14027) ──────────────────────────────────────────
const CONDENSE_SYSTEM = [
  'You are compacting one AI agent\'s long-term memory file. You will receive:',
  '(A) the current CONDENSED summary, (B) older RECENT sections being evicted,',
  '(C) the PINNED durable-facts block (for context only — do not rewrite it).',
  'Output exactly one block in this format:',
  CONDENSED_MARKER,
  '<free-form condensed summary>',
  END_MARKER,
  'RULES:',
  '- The condensed section = a single bounded summary of (A)+(B). Re-summarize (A) together',
  '  with (B) so the result does not grow unbounded. Target <= 1500 words. Preserve',
  '  every decision, root cause, protocol, file path, commit SHA, and numeric result.',
  '  Drop routine standup chatter, resolved blockers, and superseded plans.',
  '- Write the condensed section as literal free-form text; do not JSON-encode or escape it.',
  `- ${CONDENSED_MARKER} and ${END_MARKER} must each appear exactly once on a line by itself,`,
  '  in that order. Never copy these marker strings into the section.',
  '- Output ONLY the framed block. No surrounding prose or code fence.'
].join('\n');
const ARCHIVE_MARKER = '<<<ARCHIVE>>>';
const ARCHIVE_TARGET_WORDS = 4e3;
const ARCHIVE_SYSTEM = [
  'You keep the capped archive summary of notes an AI agent moved out of its long-term memory. You will receive:',
  '(A) the current ARCHIVE summary, (B) notes being moved in now, oldest first.',
  'Output exactly one block in this format:',
  ARCHIVE_MARKER,
  '<the new archive summary>',
  END_MARKER,
  'RULES:',
  `- The summary covers (A) and (B) together, in at most ${ARCHIVE_TARGET_WORDS} words. It replaces (A).`,
  '- Keep every decision, rule, root cause, protocol, file path, commit SHA, version, date and number.',
  '  Merge duplicates. Where a later note supersedes an earlier one, keep the later one.',
  '- Group by topic under short `### ` headings. Literal text, not JSON.',
  `- ${ARCHIVE_MARKER} and ${END_MARKER} must each appear exactly once on a line by itself, in that order.`,
  '- Output ONLY the framed block. No surrounding prose or code fence.'
].join('\n');

// ── MemoryReflector (verbatim ~14028-14429) ──────────────────────────────────
class MemoryReflector {
  /**
   * @param getHome      Lazily resolve harnessHome so reflection follows config.
   * @param getCommand   The base `claude` command (only its binary name is used).
   * @param getMemoryEnv Extra env (the shared MemPalace path) merged into the call.
   * @param getSettings  Reflect tunables (interval + thresholds), read each tick.
   * @param appendLog    Sink for `condense`/`condense-abort` events (hive log.jsonl).
   */
  constructor(getHome, getCommand, getMemoryEnv, getSettings, appendLog, now = Date.now) {
    this.getHome = getHome;
    this.getCommand = getCommand;
    this.getMemoryEnv = getMemoryEnv;
    this.getSettings = getSettings;
    this.appendLog = appendLog;
    this.now = now;
  }
  timer = null;
  started = false;
  /** True while a reflectNow() pass is in flight — serializes the loop (a slow
   *  LLM pass must not overlap the next interval tick), mirroring MemoryManager. */
  reflecting = false;
  /** Per agent: the file size and time of the last run that could not help. The
   *  loop skips that agent until `backoffAllows` says something changed. */
  backoff = new Map();
  /** Per agent: when the last `pinned-over-budget` warning was logged. */
  pinnedWarnedAt = new Map();
  /** Per agent: when the last `rules-over-limit` line was logged. */
  rulesWarnedAt = new Map();
  /** Per agent: when the last `pinned-needs-sort` line was logged. */
  sortWarnedAt = new Map();
  /** Per agent: memory.md's size and time when a tick found nothing to do in
   *  it. Until the file changes (or a day passes, for the daily lines) the
   *  loop does not read it again. */
  quietAt = new Map();
  // — lifecycle (mirrors MemoryManager) —
  start() {
    if (this.started) return;
    if (!this.getSettings().enabled) return;
    if (!this.getHome()) return;
    this.started = true;
    const ms = Math.max(6e4, this.getSettings().intervalMs);
    this.timer = setInterval(() => {
      void this.reflectNow();
    }, ms);
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
  }
  // — scan —
  /** Reflect every agent whose memory crossed a threshold (or just `onlyId`),
   *  one at a time. Serialized via `reflecting` so a slow pass can't overlap the
   *  next tick. Returns the per-agent outcomes (used by the manual IPC + tests). */
  async reflectNow(onlyId) {
    const home = this.getHome();
    if (!home) return [];
    if (this.reflecting) return [];
    const agentsDir = path.join(home, 'hive', 'agents');
    if (!fs.existsSync(agentsDir)) return [];
    const settings = this.getSettings();
    let ids;
    try {
      ids = fs.readdirSync(agentsDir);
    } catch {
      return [];
    }
    if (onlyId) ids = ids.filter((id) => id === onlyId);
    this.reflecting = true;
    const results = [];
    try {
      for (const id of ids) {
        const mem = path.join(agentsDir, id, 'memory.md');
        let st;
        try {
          const s0 = fs.statSync(mem);
          st = { size: s0.size, mtimeMs: s0.mtimeMs };
        } catch {
          continue;
        }
        const size = st.size;
        if (!onlyId && size <= RULES_CAP_BYTES && size < settings.minBytes) continue;
        const q = this.quietAt.get(id);
        if (!onlyId && q && q.size === st.size && q.mtimeMs === st.mtimeMs && this.now() - q.at < MEMORY_NOTICE_WINDOW_MS) continue;
        this.quietAt.delete(id);
        const quiet = () => {
          this.quietAt.set(id, { ...st, at: this.now() });
        };
        let bytes = 0;
        let text = '';
        try {
          text = fs.readFileSync(mem, 'utf8');
          bytes = Buffer.byteLength(text, 'utf8');
        } catch {
          continue;
        }
        const rulesBytes = rulesBytesOf(text);
        if (rulesBytes > RULES_CAP_BYTES) this.warnRulesOverLimit(id, rulesBytes);
        if (MOVE_NEEDS_RULES_REGION && pinnedNeedsSort(text)) this.warnNeedsSort(id, pinnedNotesBytesOf(text));
        const moved = await this.movePinned(home, id, mem, text);
        if (moved) {
          results.push(moved);
          if (moved.reason !== 'moved') continue;
          try {
            text = fs.readFileSync(mem, 'utf8');
            bytes = Buffer.byteLength(text, 'utf8');
          } catch {
            continue;
          }
        }
        const markQuiet = moved ? () => {} : quiet;
        if (!onlyId && !shouldCondenseText(text, bytes, settings)) {
          markQuiet();
          continue;
        }
        if (!onlyId && !backoffAllows(this.backoff.get(id), bytes, this.now())) {
          markQuiet();
          continue;
        }
        const pinnedBytes = pinnedBytesOf(text);
        if (pinnedBytes + rulesBytes > BUDGET_BYTES) {
          this.warnPinnedOverBudget(id, pinnedBytes, bytes, rulesBytes);
          results.push({ id, condensed: false, reason: 'pinned-over-budget', oldBytes: bytes });
          markQuiet();
          continue;
        }
        const result = await this.condense(home, id, mem, text, settings);
        if (result.condensed) this.backoff.delete(id);
        else if (BACKOFF_REASONS.has(result.reason)) {
          this.backoff.set(id, { bytes, at: this.now(), reason: result.reason });
        }
        if (result.reason === 'nothing-to-evict' || BACKOFF_REASONS.has(result.reason)) markQuiet();
        results.push(result);
      }
    } finally {
      this.reflecting = false;
    }
    return results;
  }
  // — condense one file —
  async condense(home, id, mem, text, s) {
    const oldBytes = Buffer.byteLength(text, 'utf8');
    const parsed = parseMemory(text);
    const { keep, evict, bySize } = splitRecent(parsed.recent, Math.max(1, s.recentKeep));
    if (evict.length === 0) {
      return { id, condensed: false, reason: 'nothing-to-evict', oldBytes };
    }
    let backup;
    try {
      backup = backupCopy(mem, path.join(home, 'hive', 'backups', utcStamp(), id));
    } catch (e) {
      this.logAbort(id, 'backup-failed', String(e));
      return { id, condensed: false, reason: 'backup-failed', oldBytes };
    }
    let summary;
    try {
      summary = await this.summarize(home, parsed.condensed, evict, parsed.pinned);
    } catch (e) {
      this.logAbort(id, 'summarize-failed', String(e));
      return { id, condensed: false, reason: 'summarize-failed', oldBytes };
    }
    const oldPinnedLines = pinnedLines(parsed.pinned);
    const rebuilt = rebuild(parsed.header, oldPinnedLines, summary.condensed, keep, parsed.rules);
    const newBytes = Buffer.byteLength(rebuilt, 'utf8');
    const verdict = verify({
      rebuilt,
      newBytes,
      oldBytes,
      oldPinnedLines,
      mergedPinned: oldPinnedLines,
      condensed: summary.condensed,
      keep,
      oldRules: parsed.rules
    });
    if (!verdict.ok) {
      this.logAbort(id, verdict.reason, void 0, { oldBytes, newBytes });
      return { id, condensed: false, reason: verdict.reason, oldBytes, newBytes };
    }
    let rawPart;
    if (bySize.length) {
      const lines = bySize.map(sectionText).join('\n\n').split('\n');
      const raw = writeRawBatch(path.dirname(mem), lines, new Date(this.now()).toISOString(), 'kept sections over the size limit');
      if (!raw.ok) {
        this.logAbort(id, 'raw-write-failed', raw.error, { phase: 'condense', oldBytes, newBytes });
        return { id, condensed: false, reason: 'raw-write-failed', oldBytes, newBytes };
      }
      rawPart = path.basename(raw.part);
    }
    const swap = swapOver(mem, text, rebuilt);
    if (!swap.ok) {
      this.logAbort(id, swap.reason, swap.detail, { oldBytes, newBytes });
      return { id, condensed: false, reason: swap.reason, oldBytes, newBytes };
    }
    try {
      this.appendLog({
        kind: 'condense',
        agentId: id,
        oldBytes,
        newBytes,
        evicted: evict.length,
        kept: keep.length,
        backup,
        ...bySize.length ? { evictedBySize: bySize.length, rawPart } : {},
        ...swap.appendedBytes ? { appendedDuringRun: swap.appendedBytes } : {}
      });
    } catch {}
    return { id, condensed: true, reason: 'condensed', oldBytes, newBytes };
  }
  // — move the oldest pinned notes to the archive (0.5.5, Plan D Part 3) —
  /**
   * One step: when the pinned notes are over PINNED_NOTES_CAP_BYTES, take lines
   * from the top (oldest) until they are under it, at most MOVE_STEP_BYTES.
   * Order is what makes it lossless:
   *   1. back up memory.md (the condenser's own cold copy);
   *   2. append the lines word for word to the raw archive and read them back;
   *      only then may they leave memory.md;
   *   3. ask the AI for a new archive summary. No AI fallback (founder): when
   *      the call fails, Claude Code is absent or the answer is bad, the
   *      summary is skipped and the lines still move;
   *   4. remove the lines from memory.md, over the text this run read.
   * Returns null when there is nothing to move.
   */
  async movePinned(home, id, mem, text) {
    const plan = planPinnedMove(text, { needsRules: MOVE_NEEDS_RULES_REGION });
    if (!plan) return null;
    const oldBytes = Buffer.byteLength(text, 'utf8');
    const agentDir = path.dirname(mem);
    const fail = (reason, detail) => {
      this.logAbort(id, reason, detail, { phase: 'move', lines: plan.moved.length });
      return { id, condensed: false, reason, oldBytes };
    };
    const backupDir = path.join(home, 'hive', 'backups', utcStamp(), id);
    let backup;
    try {
      backup = backupCopy(mem, backupDir);
    } catch (e) {
      return fail('backup-failed', String(e));
    }
    const raw = writeRawBatch(agentDir, plan.moved, new Date(this.now()).toISOString());
    if (!raw.ok) return fail('raw-write-failed', raw.error);
    let summary = 'written';
    if (!claudeCommandUsable(this.getCommand())) {
      summary = 'skipped:no-claude';
    } else {
      const archivePath = path.join(agentDir, ARCHIVE_FILE);
      let current = '';
      try {
        if (fs.existsSync(archivePath)) current = fs.readFileSync(archivePath, 'utf8');
      } catch {
        current = '';
      }
      let backedUp = true;
      if (current) {
        try {
          backupCopy(archivePath, backupDir);
        } catch (e) {
          backedUp = false;
          summary = 'skipped:backup-failed';
          this.logAbort(id, 'archive-backup-failed', String(e), { phase: 'move' });
        }
      }
      if (backedUp) try {
        const next = await this.summarizeArchive(home, current, plan.moved);
        const nextBytes = Buffer.byteLength(next, 'utf8');
        if (nextBytes > ARCHIVE_CAP_BYTES) summary = 'skipped:too-large';
        else if (archiveTooSmall(Buffer.byteLength(current, 'utf8'), nextBytes)) summary = 'skipped:too-small';
        else atomicWrite(archivePath, next.replace(/\s+$/, '') + '\n');
      } catch (e) {
        summary = 'skipped:summarize-failed';
        this.logAbort(id, 'archive-summarize-failed', String(e), { phase: 'move' });
      }
    }
    const swap = swapOver(mem, text, plan.after);
    if (!swap.ok) return fail(swap.reason, swap.detail);
    const newBytes = oldBytes - Buffer.byteLength(text, 'utf8') + Buffer.byteLength(plan.after, 'utf8') + (swap.appendedBytes ?? 0);
    try {
      this.appendLog({
        kind: 'memory-move',
        agentId: id,
        lines: plan.moved.length,
        movedBytes: plan.movedBytes,
        pinnedBytesBefore: plan.pinnedBytesBefore,
        pinnedBytesAfter: plan.pinnedBytesAfter,
        summary,
        rawPart: path.basename(raw.part),
        ...raw.already ? { rawAlreadyThere: true } : {},
        oldBytes,
        newBytes,
        backup
      });
    } catch {}
    return { id, condensed: false, reason: 'moved', oldBytes, newBytes };
  }
  /** One `rules-over-limit` line per agent per RULES_WARN_WINDOW_MS. */
  warnRulesOverLimit(id, rulesBytes) {
    const now = this.now();
    const last = this.rulesWarnedAt.get(id);
    if (last !== undefined && now - last < RULES_WARN_WINDOW_MS) return;
    this.rulesWarnedAt.set(id, now);
    try {
      this.appendLog({ kind: 'rules-over-limit', agentId: id, rulesBytes, limitBytes: RULES_CAP_BYTES });
    } catch {}
  }
  /** One `pinned-needs-sort` line per agent per MEMORY_NOTICE_WINDOW_MS. */
  warnNeedsSort(id, pinnedBytes) {
    const now = this.now();
    if (!noticeDue(this.sortWarnedAt.get(id), now, MEMORY_NOTICE_WINDOW_MS)) return;
    this.sortWarnedAt.set(id, now);
    try {
      this.appendLog({ kind: 'pinned-needs-sort', agentId: id, pinnedBytes, limitBytes: PINNED_NOTES_CAP_BYTES });
    } catch {}
  }
  /** The archive summary call. A method so a test can stand in for the AI. */
  async summarizeArchive(home, current, moved) {
    const prompt = [
      ARCHIVE_SYSTEM,
      '',
      '--- INPUT ---',
      '(A) CURRENT ARCHIVE SUMMARY:',
      current.trim() || '(none yet)',
      '',
      '(B) NOTES BEING MOVED IN (oldest first):',
      moved.join('\n')
    ].join('\n');
    const result = await runHiddenClaude(prompt, {
      model: CONDENSE_MODEL,
      cwd: home,
      command: this.getCommand(),
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
      env: this.getMemoryEnv(),
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    if (!result.ok || !result.text) throw new Error(result.error ?? 'archive: hidden session returned no text');
    const parsed = parseArchiveSummary(result.text);
    if (!parsed) throw new Error('archive: response contained no parseable summary');
    return parsed;
  }
  /** One `condense-skip` line per agent per PINNED_WARN_WINDOW_MS, not per tick. */
  warnPinnedOverBudget(id, pinnedBytes, bytes, rulesBytes = 0) {
    const now = this.now();
    const last = this.pinnedWarnedAt.get(id);
    if (last !== undefined && now - last < PINNED_WARN_WINDOW_MS) return;
    this.pinnedWarnedAt.set(id, now);
    try {
      this.appendLog({
        kind: 'condense-skip',
        agentId: id,
        reason: 'pinned-over-budget',
        pinnedBytes,
        rulesBytes,
        budgetBytes: BUDGET_BYTES,
        oldBytes: bytes
      });
    } catch {}
  }
  logAbort(id, reason, detail, extra) {
    try {
      this.appendLog({ kind: 'condense-abort', agentId: id, reason, ...detail ? { detail } : {}, ...extra });
    } catch {}
  }
  // — the headless LLM call (the only non-deterministic step) —
  async summarize(home, condensed, evict, pinned) {
    const evictText = evict.map((s) => `${s.heading}\n${s.body}`).join('\n\n').trim();
    const prompt = [
      CONDENSE_SYSTEM,
      '',
      '--- INPUT ---',
      '(A) CURRENT CONDENSED SUMMARY:',
      condensed?.trim() || '(none yet)',
      '',
      '(B) OLDER SECTIONS BEING EVICTED:',
      evictText || '(none)',
      '',
      '(C) PINNED DURABLE FACTS (context only — do not rewrite):',
      pinned?.trim() || '(none)'
    ].join('\n');
    const result = await runHiddenClaude(prompt, {
      model: CONDENSE_MODEL,
      cwd: home,
      command: this.getCommand(),
      // Pure text transform — must never touch the repo or shell out.
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
      env: this.getMemoryEnv(),
      timeoutMs: DEFAULT_TIMEOUT_MS
    });
    if (!result.ok || !result.text) {
      throw new Error(result.error ?? 'condense: hidden session returned no text');
    }
    const parsed = parseSummary(result.text);
    if (!parsed) throw new Error('condense: response contained no parseable summary');
    return parsed;
  }
}

// ── verbatim pure helpers (~14431-14775) ─────────────────────────────────────
function countSections(text) {
  return (text.match(/^##\s/gm) ?? []).length;
}
function parseMemory(text) {
  const lines = text.split('\n');
  let firstSection = lines.findIndex((l) => /^##\s/.test(l));
  if (firstSection === -1) firstSection = lines.length;
  const header = lines.slice(0, firstSection).join('\n').replace(/\s+$/, '');
  const sections = [];
  let cur = null;
  for (let i = firstSection; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line, body: '' };
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line;
    }
  }
  if (cur) sections.push(cur);
  let rules = null;
  let pinned = null;
  let condensed = null;
  const recent = [];
  for (const s of sections) {
    const h = s.heading.trim();
    if (h.startsWith(RULES_HEADING_PREFIX)) rules = mergeBodies(rules, s.body.replace(/\s+$/, ''));
    else if (h.startsWith('## 📌')) pinned = mergeBodies(pinned, s.body.replace(/\s+$/, ''));
    else if (h.startsWith('## 🗜')) condensed = mergeBodies(condensed, s.body.replace(/\s+$/, ''));
    else if (h === RECENT_HEADING);
    else recent.push(s);
  }
  return { header, rules, pinned, condensed, recent };
}
function backoffAllows(entry, bytes, now) {
  if (!entry) return true;
  if (bytes - entry.bytes >= BACKOFF_GROW_BYTES) return true;
  return now - entry.at >= BACKOFF_WINDOW_MS;
}
function pinnedBytesOf(text) {
  const pinned = parseMemory(text).pinned;
  return pinned ? Buffer.byteLength(pinned, 'utf8') : 0;
}
function pinnedLines(pinned) {
  if (!pinned) return [];
  return pinned.split('\n').map((l) => l.trim()).filter((l) => l && l !== PINNED_PLACEHOLDER);
}
function rebuild(header, pinned, condensed, keep, rules = null) {
  const parts = [];
  if (header.trim()) parts.push(header.trim());
  if (rules !== null) parts.push(rules.trim() ? `${RULES_HEADING}\n${rules.replace(/\s+$/, '')}` : RULES_HEADING);
  parts.push(PINNED_HEADING);
  parts.push(pinned.length ? pinned.join('\n') : PINNED_PLACEHOLDER);
  parts.push(CONDENSED_HEADING);
  parts.push(condensed.trim());
  parts.push(RECENT_HEADING);
  for (const s of keep) parts.push(`${s.heading}\n${s.body}`.replace(/\s+$/, ''));
  return parts.join('\n\n') + '\n';
}
function verify(args) {
  const { rebuilt, newBytes, oldBytes, oldPinnedLines, mergedPinned, condensed, keep } = args;
  const re = parseMemory(rebuilt);
  if (re.pinned === null || re.condensed === null) return { ok: false, reason: 'structure-missing-region' };
  if (newBytes <= 200) return { ok: false, reason: 'too-small' };
  if (!condensed.trim()) return { ok: false, reason: 'empty-condensed' };
  if (!(newBytes < oldBytes * 0.95)) return { ok: false, reason: 'not-smaller' };
  const newPinned = new Set(pinnedLines(re.pinned));
  for (const line of oldPinnedLines) if (!newPinned.has(line)) return { ok: false, reason: 'pinned-line-dropped' };
  for (const line of mergedPinned) if (!newPinned.has(line)) return { ok: false, reason: 'pinned-merge-mismatch' };
  const oldRules = args.oldRules ?? null;
  if ((re.rules ?? null) !== (oldRules === null ? null : oldRules.replace(/\s+$/, ''))) return { ok: false, reason: 'rules-altered' };
  if (re.recent.length !== keep.length) return { ok: false, reason: 'recent-count-mismatch' };
  for (let i = 0; i < keep.length; i++) {
    const a = `${keep[i].heading}\n${keep[i].body}`.replace(/\s+$/, '');
    const b = `${re.recent[i].heading}\n${re.recent[i].body}`.replace(/\s+$/, '');
    if (a !== b) return { ok: false, reason: 'recent-section-altered' };
  }
  return { ok: true };
}
function unwrapCliEnvelope(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return raw;
    const env = parsed;
    if (typeof env.result === 'string') return env.result;
    if (typeof env.text === 'string') return env.text;
    return raw;
  } catch {
    return raw;
  }
}
function stripOuterCodeFence(text) {
  const lines = text.split('\n');
  if (!/^```[A-Za-z0-9_-]*\s*$/.test(lines[0].trim())) return text;
  if (lines.length < 2 || lines[lines.length - 1].trim() !== '```') return null;
  return lines.slice(1, -1).join('\n').trim();
}
function isMarkerLine(line, marker) {
  return line.trim() === marker;
}
function hasFramedMarker(text) {
  const lines = text.split('\n');
  return SUMMARY_MARKERS.some((marker) => lines.some((line) => isMarkerLine(line, marker)));
}
function findUniqueMarkerLine(lines, marker) {
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isMarkerLine(lines[i], marker)) continue;
    if (found !== -1) return null;
    found = i;
  }
  return found === -1 ? null : found;
}
function parseFramedSummary(text) {
  const lines = text.split('\n');
  const condensedAt = findUniqueMarkerLine(lines, CONDENSED_MARKER);
  const hoistAt = findUniqueMarkerLine(lines, HOIST_MARKER);
  const endAt = findUniqueMarkerLine(lines, END_MARKER);
  if (condensedAt === null || endAt === null) return null;
  if (condensedAt !== 0 || endAt !== lines.length - 1) return null;
  if (hoistAt === null) {
    if (lines.some((l) => isMarkerLine(l, HOIST_MARKER))) return null;
    const condensed = lines.slice(condensedAt + 1, endAt).join('\n').trim();
    return condensed ? { condensed, hoist: [] } : null;
  }
  if (!(condensedAt < hoistAt && hoistAt < endAt)) return null;
  const condensed = lines.slice(condensedAt + 1, hoistAt).join('\n').trim();
  if (!condensed) return null;
  const hoist = [];
  for (const line of lines.slice(hoistAt + 1, endAt)) {
    const bullet = line.trim();
    if (!bullet) continue;
    if (!bullet.startsWith(HOIST_BULLET_PREFIX)) return null;
    const fact = bullet.slice(HOIST_BULLET_PREFIX.length).trim();
    if (!fact) return null;
    hoist.push(fact);
  }
  return { condensed, hoist };
}
function parseLegacyJsonSummary(text) {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.condensed !== 'string' || !obj.condensed.trim()) return null;
    const hoist = Array.isArray(obj.hoist) ? obj.hoist.filter((x) => typeof x === 'string') : [];
    return { condensed: obj.condensed, hoist };
  } catch {
    return null;
  }
}
function parseSummary(stdout) {
  if (typeof stdout !== 'string') return null;
  const raw = stdout.trim();
  if (!raw) return null;
  const unwrapped = unwrapCliEnvelope(raw).replace(/\r\n?/g, '\n').trim();
  if (!unwrapped) return null;
  const inner = stripOuterCodeFence(unwrapped);
  if (!inner) return null;
  if (hasFramedMarker(inner)) return parseFramedSummary(inner);
  return parseLegacyJsonSummary(inner);
}
function backupCopy(src, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(src);
  const base = path.basename(src, ext);
  for (let n = 1; n < 1e3; n++) {
    const p = path.join(dir, n === 1 ? `${base}${ext}` : `${base}.${n}${ext}`);
    try {
      fs.copyFileSync(src, p, fs.constants.COPYFILE_EXCL);
      return p;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`no free backup name for ${path.basename(src)} in ${dir}`);
}
const ARCHIVE_SHRINK_FLOOR = 0.5;
const ARCHIVE_FLOOR_MIN_BYTES = 1024;
function archiveTooSmall(currentBytes, nextBytes) {
  return currentBytes >= ARCHIVE_FLOOR_MIN_BYTES && nextBytes < currentBytes * ARCHIVE_SHRINK_FLOOR;
}
function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function swapOver(file, read, next) {
  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'swap-failed', detail: String(e) };
  }
  let body = next;
  let appendedBytes = 0;
  if (current !== read) {
    if (!current.startsWith(read)) return { ok: false, reason: 'changed-during-condense' };
    const tail = current.slice(read.length);
    appendedBytes = Buffer.byteLength(tail, 'utf8');
    body = (next.endsWith('\n') || tail.startsWith('\n') ? next : `${next}\n`) + tail;
  }
  try {
    atomicWrite(file, body);
  } catch (e) {
    return { ok: false, reason: 'swap-failed', detail: String(e) };
  }
  return { ok: true, appendedBytes };
}
function atomicWrite(file, text) {
  const tmp = `${file}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    const fd = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  fs.renameSync(tmp, file);
}
function shouldCondenseText(text, bytes, s) {
  if (bytes < s.minBytes) return false;
  const shrinkable = bytes - rulesBytesOf(text) - pinnedBytesOf(text);
  if (shrinkable > BUDGET_BYTES * s.byteTriggerPct / 100) return true;
  return countSections(text) > s.sectionTrigger;
}
function sectionText(s) {
  return `${s.heading}\n${s.body}`.replace(/\s+$/, '');
}
function splitRecent(recent, keepCount, capBytes = KEPT_SECTIONS_CAP_BYTES, minKeep = KEPT_SECTIONS_MIN) {
  const byCount = Math.max(0, recent.length - keepCount);
  const floor = Math.min(minKeep, keepCount);
  let start = recent.length;
  let bytes = 0;
  while (start > byCount) {
    const size = Buffer.byteLength(sectionText(recent[start - 1]), 'utf8');
    if (recent.length - start >= floor && bytes + size > capBytes) break;
    bytes += size;
    start -= 1;
  }
  return { keep: recent.slice(start), evict: recent.slice(0, start), bySize: recent.slice(byCount, start) };
}
function planPinnedMove(text, opts = {}) {
  const cap = opts.cap ?? PINNED_NOTES_CAP_BYTES;
  const step = opts.step ?? MOVE_STEP_BYTES;
  if (opts.needsRules && rulesBodyOf(text) === null) return null;
  const lines = text.split('\n');
  const notes = [];
  let inPinned = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      inPinned = lines[i].trim().startsWith('## 📌');
      continue;
    }
    if (!inPinned) continue;
    const t = lines[i].trim();
    if (t && t !== PINNED_PLACEHOLDER) notes.push({ index: i, text: t });
  }
  if (notes.length === 0) return null;
  const sizeOf = (xs) => Buffer.byteLength(xs.map((x) => x.text).join('\n'), 'utf8');
  const before = sizeOf(notes);
  if (before <= cap) return null;
  const take = [];
  let movedBytes = 0;
  while (take.length < notes.length) {
    const next = notes[take.length];
    const add = Buffer.byteLength(next.text, 'utf8') + (take.length ? 1 : 0);
    if (take.length > 0 && movedBytes + add > step) break;
    take.push(next);
    movedBytes += add;
    if (sizeOf(notes.slice(take.length)) <= cap) break;
  }
  const drop = new Set(take.map((x) => x.index));
  const after = lines.filter((_, i) => !drop.has(i)).join('\n');
  return {
    moved: take.map((x) => x.text),
    movedBytes,
    after,
    pinnedBytesBefore: before,
    pinnedBytesAfter: sizeOf(notes.slice(take.length))
  };
}
function rawBatch(lines, isoTime, source) {
  const sha = crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex').slice(0, 16);
  const from = source ? `memory.md (${source})` : 'memory.md';
  const text = `<!-- moved from ${from} ${isoTime} batch ${sha} (${lines.length} lines) -->\n${lines.join('\n')}\n`;
  return { sha, text };
}
function writeRawBatch(agentDir, lines, isoTime, source) {
  try {
    const { sha, text } = rawBatch(lines, isoTime, source);
    const parts = fs.readdirSync(agentDir).map((name) => ({ name, n: rawPartNumber(name) })).filter((p) => p.n !== null).sort((a, b) => a.n - b.n);
    for (const p of parts) {
      const body = fs.readFileSync(path.join(agentDir, p.name), 'utf8');
      if (body.includes(`batch ${sha} (`)) return { ok: true, part: path.join(agentDir, p.name), already: true };
    }
    let n = parts.length ? parts[parts.length - 1].n : 1;
    let file = path.join(agentDir, rawPartName(n));
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (size > 0 && size + Buffer.byteLength(text, 'utf8') > RAW_PART_BYTES) {
      n += 1;
      file = path.join(agentDir, rawPartName(n));
    }
    const lead = fs.existsSync(file) && fs.statSync(file).size > 0 && !fs.readFileSync(file, 'utf8').endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, lead + text, 'utf8');
    try {
      const fd = fs.openSync(file, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {}
    if (!fs.readFileSync(file, 'utf8').includes(text)) return { ok: false, error: `read back of ${path.basename(file)} did not find the batch` };
    return { ok: true, part: file, already: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
function claudeCommandUsable(command) {
  const bin = (command || '').trim().split(/\s+/)[0] ?? '';
  const name = bin.replace(/^["']|["']$/g, '').split(/[\\/]/).pop() ?? '';
  return /^claude(\.exe|\.cmd)?$/i.test(name) || /^claude[-_.]/i.test(name);
}
function parseArchiveSummary(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  const unwrapped = unwrapCliEnvelope(stdout.trim()).replace(/\r\n?/g, '\n').trim();
  const inner = stripOuterCodeFence(unwrapped);
  if (!inner) return null;
  const lines = inner.split('\n');
  const a = findUniqueMarkerLine(lines, ARCHIVE_MARKER);
  const e = findUniqueMarkerLine(lines, END_MARKER);
  if (a !== 0 || e !== lines.length - 1) return null;
  const body = lines.slice(1, -1).join('\n').trim();
  return body || null;
}

module.exports = {
  MemoryReflector,
  // exported for tests + the IPC surface
  runHiddenClaude, extractLastAssistantText, projectDir, parseMemory, verify,
  RULES_HEADING, PINNED_HEADING, CONDENSED_HEADING, RECENT_HEADING,
};
