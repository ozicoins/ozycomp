'use strict';
/**
 * PtyManager — the terminal plane. Each agent is a real CLI process (claude,
 * codex, gemini…) running inside node-pty. This manager owns the lifecycle:
 * spawn, write, resize, kill, plus output coalescing (PTYs emit many tiny
 * chunks; UI wants batched frames), a bounded scrollback ring per agent so a
 * renderer that attaches late can repaint, and a reaper that notices exits.
 *
 * Plain Node — Electron-free — so it is headless-testable. node-pty is loaded
 * lazily so the module still imports on machines without the native build.
 */
const { EventEmitter } = require('node:events');

const FLUSH_MS = 40;               // output coalescing window
const SCROLLBACK_CAP = 200 * 1024; // bytes kept per agent
const REAPER_MS = 2000;

let pty = null;
function loadPty() {
  if (pty) return pty;
  try { pty = require('node-pty'); fixSpawnHelper(); }
  catch (e) { pty = { __unavailable: e }; }
  return pty;
}

/**
 * node-pty's prebuilt spawn-helper ships without the exec bit when npm skips
 * install scripts → every spawn dies with "posix_spawnp failed". Restore it.
 */
function fixSpawnHelper() {
  if (process.platform === 'win32') return;
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const rel of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const f = path.join(root, rel.replace(/\//g, path.sep));
    try { const st = fs.statSync(f); if (!(st.mode & 0o111)) fs.chmodSync(f, st.mode | 0o755); } catch {}
  }
}

class AgentPty {
  constructor(id, proc, opts) {
    this.id = id;
    this.proc = proc;
    this.pid = proc?.pid ?? null;
    this.cwd = opts.cwd;
    this.provider = opts.provider;
    this.command = opts.command;
    this.spawnedAt = Date.now();
    this.alive = proc != null;
    this.exitCode = null;
    this.scrollback = '';
    this._pending = '';
    this._flushTimer = null;
    this._subs = new Set();
    this.lastOutputAt = Date.now();
    this.lastInputAt = 0;
    if (proc) {
      proc.onData(d => this._onData(d));
      proc.onExit(({ exitCode }) => {
        this.alive = false;
        this.exitCode = exitCode;
        this._flush();
        this._emit(`\r\n\x1b[90m[process exited ${exitCode}]\x1b[0m\r\n`);
        // Release the pty master fd — a killed child whose slave fd stays open
        // keeps the process's event loop alive past dispose(). destroy() closes
        // the ptmx read side and the controlling fds.
        try { this.proc.destroy?.(); } catch {}
      });
    }
  }
  _onData(d) {
    this.lastOutputAt = Date.now();
    this._pending += d;
    if (!this._flushTimer)
      this._flushTimer = setTimeout(() => this._flush(), FLUSH_MS);
  }
  _flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (!this._pending) return;
    const chunk = this._pending;
    this._pending = '';
    this.scrollback += chunk;
    if (this.scrollback.length > SCROLLBACK_CAP)
      this.scrollback = this.scrollback.slice(-SCROLLBACK_CAP);
    this._emit(chunk);
  }
  _emit(chunk) { for (const fn of this._subs) { try { fn(chunk, this.id); } catch {} } }
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  write(data) { if (!this.alive) return false; this.lastInputAt = Date.now(); this.proc.write(data); return true; }
  resize(cols, rows) { try { this.proc?.resize(cols, rows); } catch {} }
  kill(sig = 'SIGTERM') {
    if (!this.alive) { try { this.proc.destroy?.(); } catch {} return; }
    try { this.proc.kill(sig); } catch {}
    // hard-stop if the shell ignores TERM — and release the pty master fd
    // either way so a slow exit never holds the caller's event loop.
    const hardKill = setTimeout(() => {
      if (this.alive) { try { this.proc.kill('SIGKILL'); } catch {} }
      try { this.proc.destroy?.(); } catch {}
    }, 3000);
    hardKill.unref?.();
  }
}

class PtyManager extends EventEmitter {
  constructor() {
    super();
    this.agents = new Map();       // id → AgentPty
    this.ledger = null;            // AgentLedger — set at boot via setLedger()
    this._reaper = setInterval(() => this._reap(), REAPER_MS);
    this._reaper.unref?.();
  }

  /** Attach the stale agent ledger. Set once at startup, after the previous
   *  run's ledger was taken off disk (verbatim ~951). */
  setLedger(ledger) { this.ledger = ledger; }
  /** Drop a pid from the ledger when its PTY exits or is killed (verbatim ~954). */
  forgetPid(pid) {
    try { this.ledger?.remove(pid); } catch {}
  }

  has(id) { return this.agents.has(id); }
  get(id) { return this.agents.get(id) ?? null; }
  idleFor(id) {
    const s = this.agents.get(id);
    return s ? Date.now() - s.lastOutputAt : void 0;
  }
  list() {
    return [...this.agents.values()].map(a => ({
      id: a.id, pid: a.pid, provider: a.provider, cwd: a.cwd,
      alive: a.alive, exitCode: a.exitCode, spawnedAt: a.spawnedAt,
      lastOutputAt: a.lastOutputAt, lastInputAt: a.lastInputAt,
    }));
  }

  /**
   * Spawn (or return existing) PTY for an agent.
   * spec: {command, args, cwd, env, cols, rows, provider}
   */
  spawn(id, spec) {
    const existing = this.agents.get(id);
    if (existing?.alive) return existing;
    const mod = loadPty();
    let proc = null;
    if (!mod.__unavailable) {
      proc = mod.spawn(spec.command, spec.args ?? [], {
        name: 'xterm-256color',
        cols: spec.cols ?? 120,
        rows: spec.rows ?? 32,
        cwd: spec.cwd ?? process.cwd(),
        env: { ...process.env, ...(spec.env ?? {}), OZYC_AGENT_ID: id, AGENT_ID: id },
      });
    } else {
      // no node-pty: keep a dead placeholder so the rest of the stack runs
      this.emit('pty-unavailable', mod.__unavailable);
    }
    const a = new AgentPty(id, proc, spec);
    a.subscribe((chunk, aid) => this.emit('data', aid, chunk));
    this.agents.set(id, a);
    // verbatim ~1276: record the pid in the stale-agent ledger so the next run
    // can sweep it if it outlives us.
    try { void this.ledger?.add(id, proc?.pid); } catch {}
    this.emit('spawned', id, a.pid);
    return a;
  }

  write(id, data) { return this.get(id)?.write(data) ?? false; }
  resize(id, cols, rows) { this.get(id)?.resize(cols, rows); }
  kill(id) {
    const a = this.get(id);
    if (!a) return;
    a.kill();
    this.forgetPid(a.pid);
    // verbatim ~1392-1404: a killed pty leaves the session map at once — a
    // re-fired before-quit or quit poll must not count it as live, or the
    // quit warning re-prompts on a process that is already dying.
    this.agents.delete(id);
    this.emit('killed', id);
  }
  killAll() {
    for (const a of this.agents.values()) {
      a.kill();
      // Dispose path cannot wait on a login shell to honor TERM — release the
      // pty master fd now; the child's own exit still fires onExit harmlessly.
      try { a.proc?.destroy?.(); } catch {}
      this.forgetPid(a.pid);
    }
    this.agents.clear();
  }

  scrollback(id) { return this.get(id)?.scrollback ?? ''; }
  subscribe(id, fn) { return this.get(id)?.subscribe(fn) ?? (() => {}); }

  /**
   * Proof-based submit (typeAndSubmit): write the text, let the TTY drain,
   * then send CR. Returns a submit-proof record — the caller can correlate the
   * proof with a later PostToolUse/Stop hook to know the submit actually ran.
   */
  async typeAndSubmit(id, text, opts = {}) {
    const a = this.get(id);
    if (!a?.alive) return { ok: false, reason: 'no-live-pty', agentId: id };
    const before = { outAt: a.lastOutputAt, scrollLen: a.scrollback.length };
    a.write(String(text));
    await sleep(opts.typeDelayMs ?? 120);
    a.write('\r');
    const proof = {
      ok: true, agentId: id, bytes: String(text).length,
      submittedAt: new Date().toISOString(), before,
    };
    this.emit('submitted', proof);
    return proof;
  }

  _reap() {
    for (const a of this.agents.values()) {
      if (!a.alive && !a._reaped) {
        a._reaped = true;
        this.forgetPid(a.pid);
        this.emit('exit', a.id, a.exitCode);
      }
    }
  }
  dispose() { clearInterval(this._reaper); this.killAll(); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { PtyManager, AgentPty, FLUSH_MS, SCROLLBACK_CAP };
