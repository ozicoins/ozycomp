'use strict';
/**
 * Memory-file rules — verbatim port of the reference. An agent's memory.md
 * has a pinned-notes region and a "## 📏 Rules (never moved)" region whose
 * lines never archive. When pinned notes pass PINNED_NOTES_CAP the oldest
 * move to memory-archive.md (a summary) and memory-archive-raw*.md (word for
 * word); the byte counters are UTF-8 exact so a cap means the same thing on
 * every floor.
 */
const RULES_HEADING = "## 📏 Rules (never moved)";
const RULES_HEADING_PREFIX = "## 📏";
const RULES_CAP_BYTES = 16 * 1024;
const PINNED_NOTES_CAP_BYTES = 48 * 1024;
const ARCHIVE_CAP_BYTES = 32 * 1024;
const MOVE_STEP_BYTES = 32 * 1024;
const RAW_PART_BYTES = 256 * 1024;
const KEPT_SECTIONS_CAP_BYTES = 40 * 1024;
const KEPT_SECTIONS_MIN = 3;
const MEMORY_NOTICE_WINDOW_MS = 864e5;
const PINNED_HEADING_PREFIX = "## 📌";
const PINNED_PLACEHOLDER = "_(none yet)_";
const ARCHIVE_FILE = "memory-archive.md";
const RAW_ARCHIVE_BASE = "memory-archive-raw";
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
  return `${a}
${b}`;
}
function regionBodyOf(text, prefix) {
  let body2 = null;
  let cur = null;
  const close = () => {
    if (cur) body2 = mergeBodies(body2, cur.join("\n").replace(/\s+$/, ""));
    cur = null;
  };
  for (const l of text.split("\n")) {
    if (/^##\s/.test(l)) {
      close();
      if (l.trim().startsWith(prefix)) cur = [];
    } else if (cur && (cur.length > 0 || l !== "")) cur.push(l);
  }
  close();
  return body2;
}
function pinnedNotesBytesOf(text) {
  const body2 = regionBodyOf(text, PINNED_HEADING_PREFIX);
  if (!body2) return 0;
  return utf8Bytes(body2.split("\n").map((l) => l.trim()).filter((l) => l && l !== PINNED_PLACEHOLDER).join("\n"));
}
function pinnedNeedsSort(text) {
  return rulesBodyOf(text) === null && pinnedNotesBytesOf(text) > PINNED_NOTES_CAP_BYTES;
}
function noticeDue(last, now, windowMs = MEMORY_NOTICE_WINDOW_MS) {
  return last === void 0 || now - last >= windowMs;
}
function rulesBytesOf(text) {
  const body2 = rulesBodyOf(text);
  return body2 ? utf8Bytes(body2) : 0;
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
const DEFAULT_GOD_NAME = "Patron";
function resolveGodName(persistedName) {
  const trimmed = persistedName?.trim();
  return trimmed ? trimmed : DEFAULT_GOD_NAME;
}
const DEFAULT_CLAUDE_OUTPUT_STYLE = "Concise";
const STYLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
function normalizeClaudeOutputStyle(value) {
  if (typeof value !== "string") return DEFAULT_CLAUDE_OUTPUT_STYLE;
  const name = value.trim();
  return STYLE_NAME.test(name) ? name : DEFAULT_CLAUDE_OUTPUT_STYLE;
}
function selectBroadcastTargets(agents, fromId) {
  return Object.keys(agents).filter((id) => {
    const agent = agents[id];
    if (!agent) return false;
    if (id === fromId) return false;
    if (agent.isAssistant) return false;
    if (agent.archived) return false;
    if (agent.onHold) return false;
    return true;
  });
}
function heldBroadcastSkips(agents, fromId) {
  return Object.keys(agents).filter((id) => {
    const agent = agents[id];
    return !!agent && id !== fromId && !agent.isAssistant && !agent.archived && !!agent.onHold;
  });
}
const TRANSIENT_ROLE_RE = /^(on\s+)?standby$|^(idle|awaiting|paused|resumed|working|thinking|archived|starting up|reconnecting…?|running the floor|a fresh harness)$/i;
function isDurableRole(text) {
  const value = (text ?? "").trim();
  if (!value) return false;
  return !TRANSIENT_ROLE_RE.test(value);
}
function preferredAgentRole(candidate, fallback, isGod = false) {
  const incoming = (candidate ?? "").trim();
  const existing = (fallback ?? "").trim();
  if (isDurableRole(incoming)) return incoming;
  if (isDurableRole(existing)) return existing;
  if (incoming) return incoming;
  if (existing) return existing;
  return isGod ? "orchestrator (god)" : "agent";
}
const ACTIVITY_RING = 200;
const MAX_DETAIL = 120;
function clip(s) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > MAX_DETAIL ? `${one.slice(0, MAX_DETAIL - 1)}…` : one;
}
function baseName$1(p) {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
}
function fileTouchedBy(input) {
  if (!input || typeof input !== "object") return void 0;
  const o = input;
  for (const k of ["file_path", "notebook_path"]) {
    const v = o[k];
    if (typeof v === "string" && v.startsWith("/") && v.length > 1) return v;
  }
  return void 0;
}
function summariseToolInput(tool, input) {
  if (!input || typeof input !== "object") return void 0;
  const o = input;
  const str2 = (k) => typeof o[k] === "string" && o[k].trim() ? o[k] : void 0;
  const file = str2("file_path") ?? str2("notebook_path");
  if (file) return clip(baseName$1(file));
  if (str2("command")) return clip(str2("command"));
  if (str2("pattern")) return clip(str2("pattern") + (str2("glob") ? ` in ${str2("glob")}` : ""));
  if (str2("path")) return clip(baseName$1(str2("path")));
  if (str2("url")) return clip(str2("url"));
  if (str2("query")) return clip(str2("query"));
  if (str2("description")) return clip(str2("description"));
  if (str2("prompt")) return clip(str2("prompt"));
  if (str2("skill")) return clip(str2("skill"));
  for (const v of Object.values(o)) if (typeof v === "string" && v.trim()) return clip(v);
  return void 0;
}
const QUIET_TOOLS = /* @__PURE__ */ new Set(["TodoWrite", "TaskOutput", "TaskStop"]);
function word(v) {
  return typeof v === "string" && v.trim() ? v : void 0;
}
function entryForHookEvent(event, p, ts) {
  switch (event) {
    case "PreToolUse": {
      const tool = word(p.tool);
      if (!tool || QUIET_TOOLS.has(tool)) return null;
      const path2 = fileTouchedBy(p.toolInput);
      return { ts, kind: "tool", tool, detail: summariseToolInput(tool, p.toolInput), ...path2 ? { path: path2 } : {} };
    }
    case "Notification": {
      const message = word(p.message);
      if (!message) return null;
      return { ts, kind: "notice", text: clip(message) };
    }
    case "PostCompact":
      return { ts, kind: "compact", text: "done" };
    case "SessionStart": {
      const source = word(p.source);
      return { ts, kind: "session", text: source ? clip(source) : void 0 };
    }
    default:
      return null;
  }
}
function entryForMessage(subject, ts) {
  const text = typeof subject === "string" ? clip(subject) : "";
  if (!text) return null;
  return { ts, kind: "message", text };
}
function sampleProvesConversation(sample) {
  if (!sample) return false;
  return sample.input + sample.output + sample.cacheRead + sample.cacheCreation > 0;
}

// ── verbatim memory index (reference ~16377-16437) ──────────────────────────
// The memory-index.md written at the hive root each time a temp spawns: every
// registered agent gets a two-line entry (identity line + absolute path), and
// the temp's spawn brief points at it. Atomic via tmp+rename so a temp never
// reads a half-written file.
const MEMORY_INDEX_FILE = 'memory-index.md';
function orderRows(rows) {
  return rows.slice().sort((a, b) => {
    if (a.empty !== b.empty) return a.empty ? 1 : -1;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const ta = a.updatedAt ?? '';
    const tb = b.updatedAt ?? '';
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function fmtWhen(iso) {
  if (!iso) return 'never written';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'unknown';
  return `updated ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}
function writeMemoryIndex(root, rows, now = new Date()) {
  const fs = require('node:fs');
  const path = require('node:path');
  const filePath = path.join(root, MEMORY_INDEX_FILE);
  const ordered = orderRows(rows);
  const withNotes = ordered.filter((r) => !r.empty).length;
  const lines = [
    '# Memory index',
    '',
    `Written ${now.toISOString()} by the harness when a temp was spawned. ${ordered.length} agent${ordered.length === 1 ? '' : 's'} have been on this floor, ${withNotes} with notes worth reading.`,
    'Each entry is one agent: id, display name, role in brackets, state, size and last update on the first line, the absolute path of its memory file on the second.',
    'Read the memory of every agent your task names and of every agent whose role matches it. An entry marked empty holds only the seed header. Read only: you write to your own memory.md alone.',
    '',
  ];
  for (const r of ordered) {
    const state = r.empty ? 'empty' : r.archived ? 'archived' : 'active';
    const role = r.role ? ` (${r.role})` : '';
    lines.push(`${r.id}  ${r.name}${role}  ${state}  ${fmtBytes(r.bytes)}  ${fmtWhen(r.updatedAt)}`);
    lines.push(`  ${r.path}`);
    lines.push('');
  }
  if (ordered.length === 0) lines.push('No agent has been registered on this floor yet.', '');
  fs.mkdirSync(root, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}
/** verbatim ~16425: the [CONTEXT] block at the head of every temp's brief —
 *  read the index, read the named/matching agents' memory.md, mempalace + kg
 *  searches when those surfaces are live, then start. */
function memoryContextBlock(root, indexPath, palace, kg) {
  const path = require('node:path');
  const steps = [
    `Read ${indexPath}. It lists every agent that has been on this floor with the absolute path of its memory file, its role, and whether it holds anything.`,
    `Read the memory.md of every agent the request names and of every agent whose role matches the request. They live under ${path.join(root, 'agents')}/<id>/memory.md. Read only: you write to your own memory.md alone.`,
  ];
  if (palace) steps.push('Run `mempalace search "<the request in a few words>"` to recall what the whole team remembers about it, across every agent.');
  if (kg && kg.trim()) steps.push(`Run ${kg.trim()} for company facts, house style and internal process that bear on the request.`);
  steps.push('Then start on the request below. Do not skip the reading: a temp that starts cold repeats work the floor already did.');
  return [
    '[CONTEXT] Before you start, gather what the team already knows.',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
  ].join('\n');
}

module.exports = {
  RULES_HEADING, RULES_HEADING_PREFIX, RULES_CAP_BYTES, PINNED_NOTES_CAP_BYTES,
  ARCHIVE_CAP_BYTES, MOVE_STEP_BYTES, RAW_PART_BYTES,
  KEPT_SECTIONS_CAP_BYTES, KEPT_SECTIONS_MIN, MEMORY_NOTICE_WINDOW_MS,
  PINNED_HEADING_PREFIX, PINNED_PLACEHOLDER, ARCHIVE_FILE, RAW_ARCHIVE_BASE,
  rawPartName, rawPartNumber, rulesBodyOf, mergeBodies, regionBodyOf,
  pinnedNotesBytesOf, pinnedNeedsSort, noticeDue, rulesBytesOf, rulesOverLimit,
  utf8Bytes, DEFAULT_GOD_NAME, resolveGodName,
  DEFAULT_CLAUDE_OUTPUT_STYLE, STYLE_NAME, normalizeClaudeOutputStyle,
  selectBroadcastTargets, heldBroadcastSkips,
  TRANSIENT_ROLE_RE, isDurableRole, preferredAgentRole,
  ACTIVITY_RING, MAX_DETAIL, clip, baseName$1, fileTouchedBy, summariseToolInput,
  QUIET_TOOLS, word, entryForHookEvent, entryForMessage, sampleProvesConversation,
  MEMORY_INDEX_FILE, orderRows, fmtBytes, fmtWhen, writeMemoryIndex, memoryContextBlock,
};
