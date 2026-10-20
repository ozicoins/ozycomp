'use strict';
/**
 * Terminal text helpers — verbatim port of the reference. The floor nudge
 * line, the spawn-delay back-off, the scrollback tail (voice/status readers
 * share it) and the control-sequence/hostility scrubbers that keep terminal
 * text safe to speak aloud or feed back into a prompt.
 */
const NUDGE_HEAD = "You have new hive inbox message(s)";
function inboxNudgeText(ids, inboxPath) {
  const named = ids.length ? ` — at least: ${ids.join(", ")}` : "";
  const where = inboxPath ? ` Your inbox is ${inboxPath}. Read it,` : " Read your inbox,";
  return `${NUDGE_HEAD}${named}.${where} act on what is pending there, and move handled ones to inbox/.done/. Your inbox directory is authoritative: work everything still pending in it, and if a named id is already in inbox/.done/ you handled it on an earlier turn and can ignore that one. Act autonomously; only message god if you genuinely need a decision.`;
}
function slowSpawnDelayMs(envValue, seq, packaged) {
  if (packaged) return 0;
  if (!Number.isInteger(seq) || seq < 1) return 0;
  const raw = (envValue ?? "").trim();
  if (!/^\d+$/.test(raw)) return 0;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return value * seq;
}
const TAIL_LINES = 3;
const TAIL_SCAN_ROWS = 80;
const TAIL_LINE_MAX = 140;
const HAS_CONTENT = /[\p{L}\p{N}]/u;
function terminalTail(rows, limit = TAIL_LINES, maxLen = TAIL_LINE_MAX) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const want = Math.floor(limit);
  if (!Number.isFinite(want) || want <= 0 || maxLen <= 1) return [];
  const out = [];
  const stop2 = Math.max(0, rows.length - TAIL_SCAN_ROWS);
  for (let i = rows.length - 1; i >= stop2 && out.length < want; i--) {
    const raw = rows[i];
    if (typeof raw !== "string") continue;
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || !HAS_CONTENT.test(line)) continue;
    if (line === out[out.length - 1]) continue;
    out.push(line.length > maxLen ? `${line.slice(0, maxLen - 1)}…` : line);
  }
  return out.reverse();
}
const VOICE_TERMINAL_LINES = 25;
const VOICE_TERMINAL_MAX_LINES = 40;
const VOICE_TERMINAL_LINE_MAX = 160;
const VOICE_TERMINAL_MAX_CHARS = 2400;
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ESC2 = /\x1b[@-Z\\-_]/g;
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
function stripTerminalControl(s) {
  return (s || "").replace(OSC, "").replace(CSI, "").replace(ESC2, "").replace(/\r\n?/g, "\n").replace(CTRL, "");
}
function neutralizeHostile(s) {
  return (s || "").replace(/[\r\n]+/g, " ").replace(/[()]/g, "").replace(/\b(?:ignore|disregard|forget|override)\b[^.!?]*\b(?:previous|above|prior|instruction|system|prompt)\b[^.!?]*[.!?]?/gi, "").replace(/\b(?:system|assistant|developer|user)\s*:/gi, "").replace(/\bnew instructions?\b[^.!?]*[.!?]?/gi, "").replace(/\byou are (?:now )?[^.!?]*[.!?]?/gi, "").replace(/\s+/g, " ").trim();
}
function terminalForVoice(rows, opts = {}) {
  const want = Math.max(1, Math.min(VOICE_TERMINAL_MAX_LINES, Math.floor(opts.lines ?? VOICE_TERMINAL_LINES)));
  const lineMax = opts.lineMax ?? VOICE_TERMINAL_LINE_MAX;
  const maxChars = opts.maxChars ?? VOICE_TERMINAL_MAX_CHARS;
  const redact = opts.redact ?? ((l) => l);
  const tail = terminalTail(rows, want, Number.MAX_SAFE_INTEGER);
  const out = [];
  for (const raw of tail) {
    const line = neutralizeHostile(redact(raw));
    if (!line) continue;
    out.push(line.length > lineMax ? `${line.slice(0, lineMax - 1)}…` : line);
  }
  let total = out.reduce((n, l) => n + l.length, 0);
  while (out.length > 1 && total > maxChars) total -= out.shift().length;
  if (out.length === 1 && out[0].length > maxChars) out[0] = `${out[0].slice(0, maxChars - 1)}…`;
  return out;
}

module.exports = {
  NUDGE_HEAD, inboxNudgeText, slowSpawnDelayMs,
  TAIL_LINES, TAIL_SCAN_ROWS, TAIL_LINE_MAX, HAS_CONTENT, terminalTail,
  VOICE_TERMINAL_LINES, VOICE_TERMINAL_MAX_LINES, VOICE_TERMINAL_LINE_MAX, VOICE_TERMINAL_MAX_CHARS,
  CSI, OSC, ESC2, CTRL, stripTerminalControl, neutralizeHostile, terminalForVoice,
};
