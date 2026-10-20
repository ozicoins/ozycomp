'use strict';
/**
 * PTY submit pipeline — verbatim port of the reference. Encodes text for the
 * provider's TTY (bracketed paste for claude, plain writes elsewhere), types it,
 * presses the submit key, then waits for PROOF the submit landed (hook event,
 * prompt echo, activity) before retrying — never blind double-presses on a
 * fresh agent. Also: TerminalProbes (renderer screen probes), removeTreeFully
 * (Windows-tolerant tree removal), fanOutHookSink (one sink → all windows).
 */
const fs = require('node:fs');

const PTY_SUBMIT_DELAY_MS = 240;
const CLAUDE_SUBMIT_KEY = "\x1B[13u";
const CLAUDE_CSI_U_FLOOR = [2, 1, 282];
const CLAUDE_PASTE_MAX_CHARS = 700;
const CLAUDE_PASTE_MAX_LINES = 3;
const PASTE_START = "\x1B[200~";
const PASTE_END = "\x1B[201~";
function stripPasteMarkers(text) {
  return text.split(PASTE_START).join("").split(PASTE_END).join("");
}
function splitPastes(text, maxChars = CLAUDE_PASTE_MAX_CHARS, maxLines = CLAUDE_PASTE_MAX_LINES) {
  const out = [];
  let cur = "";
  let newlines = 0;
  for (const cp of text) {
    const nl = cp === "\n" ? 1 : 0;
    if (cur && (cur.length + cp.length > maxChars || newlines + nl > maxLines - 1)) {
      out.push(cur);
      cur = "";
      newlines = 0;
    }
    cur += cp;
    newlines += nl;
  }
  if (cur) out.push(cur);
  return out;
}
function isSlashCommand(text) {
  const t = text.trim();
  return !t.includes("\n") && /^\/[\w:.-]+(?:\s|$)/.test(t);
}
function versionAtLeast(v, floor) {
  for (let i = 0; i < floor.length; i++) {
    const a = v[i] ?? 0;
    if (a !== floor[i]) return a > floor[i];
  }
  return true;
}
function submitEncodingFor(provider, text, claudeVersion) {
  if (provider === "claude") {
    const key = claudeVersion && !versionAtLeast(claudeVersion, CLAUDE_CSI_U_FLOOR) ? "\r" : CLAUDE_SUBMIT_KEY;
    if (isSlashCommand(text)) {
      const clean = stripPasteMarkers(text);
      return clean.length <= CLAUDE_PASTE_MAX_CHARS ? { payload: PASTE_START + clean + PASTE_END, key, bracketed: true, pastes: 1, slash: true } : { payload: clean, key, bracketed: false, pastes: 0, slash: true };
    }
    const pieces = splitPastes(stripPasteMarkers(text).replace(/\r\n?/g, "\n"));
    return { payload: pieces.map((p) => PASTE_START + p + PASTE_END).join(""), key, bracketed: pieces.length > 0, pastes: pieces.length, slash: false };
  }
  if (provider === "antigravity" || !text.includes("\n")) {
    return { payload: text, key: "\r", bracketed: false, pastes: 0, slash: isSlashCommand(text) };
  }
  return { payload: PASTE_START + stripPasteMarkers(text) + PASTE_END, key: "\r", bracketed: true, pastes: 1, slash: false };
}
function commandProofEvents(text) {
  const verb = text.trim().split(/\s+/)[0]?.toLowerCase();
  if (verb === "/clear") return ["SessionStart"];
  if (verb === "/compact") return ["PreCompact", "SessionStart"];
  return [];
}
const PROMPT_TAIL_CHARS = 48;
function promptTail(text, n = PROMPT_TAIL_CHARS) {
  return text.replace(/<\/?pasted_content[^>]*>/g, "").replace(/\s+/g, "").slice(-n);
}
function tailMatches(hookTail, ourTail) {
  return ourTail.length > 0 && hookTail.endsWith(ourTail);
}
const PTY_RETRY_AFTER_MS = 4e3;
const PTY_SUBMIT_MAX_PRESSES = 4;
const PTY_FINAL_WAIT_MS = 4e3;
const PTY_PROOF_POLL_MS = 150;
async function typeAndSubmit(io, plan) {
  const { encoding: enc, text } = plan;
  const started = io.now();
  const tail = promptTail(text);
  const events = enc.slash ? commandProofEvents(text) : [];
  let presses = 0;
  let seen = plan.pressOnly === true;
  let lastPending = null;
  let goneReads = 0;
  const result = (outcome, proof) => ({ outcome, proof, presses, ms: io.now() - started });
  if (!plan.pressOnly) {
    if (!await io.safeToType()) return result("held", "none");
    if (enc.payload) await io.write(enc.payload);
  }
  const proof = async () => {
    if (io.promptSeen(started, tail)) return "hook";
    if (events.length && io.eventSeen(started, events)) return "hook";
    if (plan.idle && io.activitySeen(started)) return "activity";
    const lines = await io.screen();
    const p = lines ? submitStillPending(lines, text) : null;
    lastPending = p;
    if (p === true) {
      seen = true;
      goneReads = 0;
      return null;
    }
    goneReads = p === false && seen ? goneReads + 1 : 0;
    return goneReads >= 2 ? "screen" : null;
  };
  const press = async () => {
    if (!await io.safeToPress()) {
      io.log?.("a person is typing or a menu is open, press skipped");
      return;
    }
    await io.write(enc.key);
    presses += 1;
  };
  if (!plan.pressOnly) await io.sleep(PTY_SUBMIT_DELAY_MS);
  await press();
  const maxAttempts = enc.slash ? 1 : PTY_SUBMIT_MAX_PRESSES;
  let attempts = 1;
  let gap = PTY_RETRY_AFTER_MS;
  let nextAt = io.now() + gap;
  let finalAt = enc.slash ? io.now() + PTY_FINAL_WAIT_MS : Infinity;
  for (; ; ) {
    const found = await proof();
    if (found) return result("submitted", found);
    const now = io.now();
    if (now >= finalAt) break;
    if (now >= nextAt && attempts < maxAttempts) {
      if (lastPending !== true && !io.hookChannel()) break;
      io.log?.("no proof of submission yet, pressing the submit key again");
      await press();
      attempts += 1;
      gap *= 2;
      nextAt = io.now() + gap;
      if (attempts >= maxAttempts) finalAt = io.now() + PTY_FINAL_WAIT_MS;
    }
    await io.sleep(PTY_PROOF_POLL_MS);
  }
  if (enc.slash) return result("unconfirmed", "none");
  if (lastPending === true) return result("stuck", "none");
  if (lastPending === null && io.hookChannel()) return result("stuck", "none");
  return result("unconfirmed", "none");
}
function isBoxRule(line) {
  const t = line.trim();
  if (t.length < 10) return false;
  if (!/^[─-╿\s]+$/.test(t)) return false;
  return (t.match(/[─━═]/g) ?? []).length >= 10;
}
const INPUT_CHROME = /[─-╿\s>❯›$#|]/g;
function inputBoxText(screen) {
  const rules = [];
  screen.forEach((line, i) => {
    if (isBoxRule(line)) rules.push(i);
  });
  if (rules.length < 2) return null;
  return screen.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]).map((l) => l.replace(/\s+$/, "")).join("\n");
}
function submitStillPending(screen, text) {
  const raw = inputBoxText(screen);
  if (raw === null) return null;
  const box = raw.replace(INPUT_CHROME, "");
  if (!box) return false;
  if (/\[Pastedtext\d+/i.test(box)) return true;
  const needle = text.replace(INPUT_CHROME, "");
  if (!needle) return false;
  return box.includes(needle.slice(-24));
}
function terminalReadySettleMs(provider) {
  switch (provider) {
    case "kimi":
      return 650;
    case "grok":
      return 500;
    case "gemini":
      return 500;
    case "codex":
      return 500;
    default:
      return 400;
  }
}
function terminalReadyToReceive(hasOutput, elapsedMs, provider) {
  if (provider === "antigravity") {
    return elapsedMs >= terminalReadySettleMs(provider);
  }
  return hasOutput !== false && elapsedMs >= terminalReadySettleMs(provider);
}

const MAIL_SLICE_MS = 8;
function runToEnd(steps) {
  for (; ; ) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}
async function runInSlices(steps, stats) {
  let slices = 1;
  let longest = 0;
  let started = performance.now();
  const close = () => {
    longest = Math.max(longest, performance.now() - started);
    if (stats) {
      stats.slices = slices;
      stats.longestMs = longest;
    }
  };
  for (; ; ) {
    const r = steps.next();
    if (r.done) {
      close();
      return r.value;
    }
    if (performance.now() - started < MAIL_SLICE_MS) continue;
    close();
    await new Promise((resolve) => setImmediate(resolve));
    slices++;
    started = performance.now();
  }
}

function fanOutHookSink(all, live) {
  return {
    send(channel, ...args) {
      if (channel === "control:approvalRequest") {
        try {
          live()?.send(channel, ...args);
        } catch {
        }
        return;
      }
      for (const sink of all()) {
        try {
          sink.send(channel, ...args);
        } catch {
        }
      }
    }
  };
}
const REMOVE_TRIES = 5;
const REMOVE_WAIT_MS = 200;
async function removeTreeFully(dir, opts = {}) {
  const tries = opts.tries ?? REMOVE_TRIES;
  const waitMs = opts.waitMs ?? REMOVE_WAIT_MS;
  let lastError = "";
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (!fs.existsSync(dir)) return { gone: true };
    await new Promise((r) => setTimeout(r, waitMs));
  }
  const aside = `${dir}.removed-${(opts.now ?? Date.now)()}`;
  try {
    fs.renameSync(dir, aside);
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
    }
    return { gone: true, movedAside: aside };
  } catch (e) {
    return { gone: false, error: `${lastError}; move aside failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
const READY_TIMEOUT_MS = 3e4;
const READY_POLL_MS = 100;
const SESSION_START_SETTLE_MS = 500;
const PROBE_TIMEOUT_MS = 300;
class PtySubmitter {
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  chains = new Map();
  readyPids = new Map();
  /** The process each terminal's last text was typed into (gate G4). */
  typedPids = new Map();
  /** The last outcome logged per terminal: a run of `held` logs once (G6). */
  lastLogged = new Map();
  now;
  sleep;
  /** Queue a delivery on this terminal's chain. Rejects when the terminal is
   *  gone, never became ready, or a write failed; otherwise resolves with what
   *  happened. A failure never stalls the chain for the next caller. */
  submit(req) {
    const prev = this.chains.get(req.ptyId) ?? Promise.resolve();
    const next = prev.catch(() => void 0).then(() => this.run(req));
    this.chains.set(req.ptyId, next);
    void next.catch(() => void 0).then(() => {
      if (this.chains.get(req.ptyId) === next) this.chains.delete(req.ptyId);
    });
    return next;
  }
  async run(req) {
    if (req.pressOnly) {
      const now = this.deps.info(req.ptyId);
      if (!now || this.typedPids.get(req.ptyId) !== now.pid) {
        this.deps.log({ kind: "pty-submit", agentId: req.agentId ?? null, ptyId: req.ptyId, provider: req.provider, source: req.source, pressOnly: true, presses: 0, proof: "none", outcome: "gone", ms: 0 });
        return { outcome: "gone", proof: "none", presses: 0, ms: 0 };
      }
    }
    const readiness = await this.waitReady(req);
    const info = this.deps.info(req.ptyId);
    if (!info) throw new Error(`pty gone: ${req.ptyId}`);
    const grid = { cols: info.cols, rows: info.rows };
    const version = req.provider === "claude" ? await this.deps.claudeVersion(req.ptyId).catch(() => null) : null;
    const encoding = submitEncodingFor(req.provider, req.text, version);
    const idle = req.idle !== false;
    const proof = this.deps.proof;
    const agentId = req.agentId;
    const probe = () => this.deps.probe(req.ptyId, grid).catch(() => null);
    const io = {
      write: async (data) => {
        const res = this.deps.write(req.ptyId, data);
        if (!res.ok) throw new Error(res.error ?? `pty write failed: ${req.ptyId}`);
      },
      screen: async () => (await probe())?.lines ?? null,
      sleep: this.sleep,
      now: this.now,
      // G2: alive only once a turn event arrived from this terminal's process.
      // A fresh agent's first message gets no blind retries: the safe side.
      hookChannel: () => proof.activitySeen(agentId, info.startedAt),
      promptSeen: (since, tail) => proof.promptSeen(agentId, since, tail),
      activitySeen: (since) => proof.activitySeen(agentId, since),
      eventSeen: (since, events) => proof.eventSeen(agentId, since, events),
      // A6. Typing waits for an answer: no answer is "not now". No window at
      // all means nobody can be typing. B5: an open question or a pending
      // decision holds it too, checked again before every press.
      safeToType: async () => {
        if (this.deps.inputHeld?.(agentId)) return false;
        const p = await probe();
        return p === void 0 ? true : p !== null && p.safe;
      },
      // A press on a busy renderer is skipped; the retry comes later.
      safeToPress: async () => {
        if (this.deps.inputHeld?.(agentId)) return false;
        const p = await probe();
        return p === void 0 ? true : p !== null && p.safe;
      }
    };
    const result = await typeAndSubmit(io, { text: req.text, encoding, idle, pressOnly: req.pressOnly });
    if (!req.pressOnly && result.outcome !== "held") this.typedPids.set(req.ptyId, info.pid);
    const repeatHeld = result.outcome === "held" && this.lastLogged.get(req.ptyId) === "held";
    this.lastLogged.set(req.ptyId, result.outcome);
    if (!repeatHeld) this.deps.log({
      kind: "pty-submit",
      agentId: agentId ?? null,
      ptyId: req.ptyId,
      provider: req.provider,
      source: req.source,
      chars: req.text.length,
      bracketed: encoding.bracketed,
      pastes: encoding.pastes,
      key: encoding.key === "\r" ? "cr" : "csi-u",
      slash: encoding.slash,
      pressOnly: req.pressOnly === true,
      idle,
      readiness,
      presses: result.presses,
      proof: result.proof,
      outcome: result.outcome,
      ms: result.ms
    });
    if (req.settleMs && result.outcome !== "held") await this.sleep(req.settleMs);
    return result;
  }
  /**
   * Wait until the terminal can take input (A9). Claude: its input box is on a
   * readable screen, or, when the screen cannot be read, SessionStart arrived
   * 500 ms ago. The bracketed paste mode switch is NOT a signal: it comes 0.3
   * to 0.5 s after start and the box 0.85 to 3.4 s. Other providers keep the
   * old rule (first output plus a settle). Known ready per process id. At the
   * 30 s limit a terminal that has printed anything is taken as ready, as
   * before this change, rather than never delivering.
   */
  async waitReady(req) {
    const started = this.now();
    for (; ; ) {
      const info = this.deps.info(req.ptyId);
      if (!info) throw new Error(`PTY exited before becoming ready: ${req.ptyId}`);
      if (this.readyPids.get(req.ptyId) === info.pid) return "known";
      const elapsed = this.now() - started;
      const why = await this.readyNow(req, info, elapsed);
      if (why) {
        this.readyPids.set(req.ptyId, info.pid);
        return why;
      }
      if (elapsed >= READY_TIMEOUT_MS) {
        if (info.hasOutput) {
          this.readyPids.set(req.ptyId, info.pid);
          return "timeout";
        }
        throw new Error(`PTY did not become ready within ${READY_TIMEOUT_MS}ms: ${req.ptyId}`);
      }
      await this.sleep(READY_POLL_MS);
    }
  }
  async readyNow(req, info, elapsed) {
    if (req.provider !== "claude") {
      return terminalReadyToReceive(info.hasOutput, elapsed, req.provider) ? "settle" : null;
    }
    const p = await this.deps.probe(req.ptyId, { cols: info.cols, rows: info.rows }).catch(() => null);
    if (p?.lines) return inputBoxText(p.lines) !== null ? "box" : null;
    const at = this.deps.proof.lastEventAt(req.agentId, "SessionStart");
    return at >= info.startedAt && this.now() - at >= SESSION_START_SETTLE_MS ? "session-start" : null;
  }
}
class TerminalProbes {
  seq = 0;
  pending = new Map();
  /** `send` delivers the request and returns false when there is no window. */
  request(send, timeoutMs = PROBE_TIMEOUT_MS) {
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      let sent = false;
      try {
        sent = send(id);
      } catch {
        sent = false;
      }
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(void 0);
      }
    });
  }
  reply(id, value) {
    if (typeof id !== "number") return;
    const done = this.pending.get(id);
    if (!done) return;
    this.pending.delete(id);
    done(validProbe(value));
  }
  size() {
    return this.pending.size;
  }
}
function validProbe(v) {
  if (!v || typeof v !== "object") return null;
  const o = v;
  const lines = Array.isArray(o.lines) && o.lines.every((l) => typeof l === "string") ? o.lines : null;
  return { lines, safe: o.safe === true, pooled: o.pooled === true };
}
const NUDGE_MAX_PRESS_ONLY = 3;
function nextNudgeAction(state, activitySince) {
  if (!state || state.outcome !== "stuck") return "type";
  if (activitySince(state.typedAt)) return "type";
  return state.pressOnlyPasses < NUDGE_MAX_PRESS_ONLY ? "press" : "wait";
}
function initialWindowVisibility(isVisible, isMinimized) {
  return { minimized: isMinimized, occluded: !isVisible && !isMinimized };
}
function nextWindowVisibility(state, event) {
  switch (event) {
    case "minimize":
      return { ...state, minimized: true };
    case "restore":
      return { ...state, minimized: false };
    case "hide":
      return { ...state, occluded: true };
    case "show":
      return { ...state, occluded: false };
    case "focus":
      return { minimized: false, occluded: false };
  }
}
function windowHidden(state) {
  return state.minimized || state.occluded;
}

module.exports = {
  PTY_SUBMIT_DELAY_MS, CLAUDE_SUBMIT_KEY, CLAUDE_CSI_U_FLOOR,
  CLAUDE_PASTE_MAX_CHARS, CLAUDE_PASTE_MAX_LINES, PASTE_START, PASTE_END,
  stripPasteMarkers, splitPastes, isSlashCommand, versionAtLeast,
  submitEncodingFor, commandProofEvents, PROMPT_TAIL_CHARS, promptTail,
  tailMatches, PTY_RETRY_AFTER_MS, PTY_SUBMIT_MAX_PRESSES, PTY_FINAL_WAIT_MS,
  PTY_PROOF_POLL_MS, typeAndSubmit, isBoxRule, INPUT_CHROME, inputBoxText,
  submitStillPending, terminalReadySettleMs, terminalReadyToReceive,
  MAIL_SLICE_MS, runToEnd, runInSlices, fanOutHookSink,
  REMOVE_TRIES, REMOVE_WAIT_MS, removeTreeFully,
  READY_TIMEOUT_MS, READY_POLL_MS, SESSION_START_SETTLE_MS, PROBE_TIMEOUT_MS,
  PtySubmitter, TerminalProbes, validProbe,
  NUDGE_MAX_PRESS_ONLY, nextNudgeAction,
  initialWindowVisibility, nextWindowVisibility, windowHidden,
};
