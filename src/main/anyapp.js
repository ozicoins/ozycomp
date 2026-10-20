'use strict';
/**
 * Any-app dictation — the push-to-talk loop that types into whatever app is
 * frontmost. Same architecture as the reference: a native helper (md-hotkey)
 * owns the global hotkey + microphone + CGEvent injection; we talk to it over
 * newline-delimited JSON on its stdio (LineHelper). When the helper binary is
 * absent the feature reports 'no-helper' — identical to the reference on a
 * bare dev machine.
 *
 *   {op:"arm",key,record,stream} → {keyCode,stream}
 *   events ← {event:"keydown"|"keyup"|"chunk"|"level"|"audio"|"audio-end"|"cancel"}
 *   {op:"inject",text,dryRun,restoreMs} → {posted}
 *
 * Deps injected for headless tests: {helperPath, env, transcriber, route(),
 * ignore(), onEvent, stream, restoreMs, platform, spawn}.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

class HelperError extends Error {
  constructor(code, extra = {}) { super(extra.detail ?? code); this.code = code; Object.assign(this, extra); }
}

// ── LineHelper: newline-JSON request/response over child stdio ──────────────
class LineHelper {
  constructor(binary, opts = {}) {
    this.binary = binary;
    this.opts = opts;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderrTail = '';
  }
  get running() { return this.proc !== null; }
  ensure() {
    if (this.proc) return this.proc;
    const p = (this.opts.spawn ?? spawn)(this.binary, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.opts.env ?? process.env,
    });
    p.stdin.on('error', () => {});
    this.proc = p;
    this.buffer = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', c => this._onData(c));
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', c => { this.stderrTail = (this.stderrTail + c).slice(-2000); });
    const gone = why => {
      if (this.proc !== p) return;
      this.proc = null;
      const err = new HelperError('helper-exited', { detail: why, stderr: this.stderrTail });
      for (const [, w] of this.pending) w.reject(err);
      this.pending.clear();
      this.opts.onExit?.(why);
    };
    p.on('exit', (code, signal) => gone(`exit ${code ?? ''}${signal ? ` signal ${signal}` : ''}`));
    p.on('error', e => gone(e.message));
    return p;
  }
  _onData(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let reply;
      try { reply = JSON.parse(line); } catch { continue; }
      if (typeof reply.id !== 'number') {
        if (typeof reply.event === 'string' || typeof reply.error === 'string') this.opts.onEvent?.(reply);
        continue;
      }
      const w = this.pending.get(reply.id);
      if (!w) continue;
      this.pending.delete(reply.id);
      if (reply.error) w.reject(new HelperError(String(reply.error), { detail: reply.detail }));
      else w.resolve(reply);
    }
  }
  request(op, extra = {}, waitFor) {
    const p = this.ensure();
    const id = this.nextId++;
    const msg = JSON.stringify({ id, ...op });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { p.stdin.write(msg + '\n'); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  async stop() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    try { p.stdin.end(); } catch {}
    try { p.kill('SIGTERM'); } catch {}
    for (const [, w] of this.pending) w.reject(new HelperError('helper-exited'));
    this.pending.clear();
  }
}

// ── md-hotkey helper paths + availability ───────────────────────────────────
function mdHotkeyPath(resourcesPath, platform = process.platform) {
  const target = platform === 'darwin' ? 'darwin-universal'
    : platform === 'win32' ? 'win32-x64' : 'linux-x64';
  return path.join(resourcesPath, 'transcribe', target, platform === 'win32' ? 'md-hotkey.exe' : 'md-hotkey');
}
const mdHotkeyAvailable = (resourcesPath, platform = process.platform) =>
  fs.existsSync(mdHotkeyPath(resourcesPath, platform));
const isWaylandSession = (env = process.env) =>
  env.XDG_SESSION_TYPE === 'wayland' || (!!env.WAYLAND_DISPLAY && !env.DISPLAY);
function anyAppUnavailableReason(resourcesPath, platform = process.platform, env = process.env, opts = {}) {
  if (opts.floor) return 'floor';                        // tenant floors don't take over the global hotkey
  if (platform === 'linux' && isWaylandSession(env)) return 'wayland';
  if (!mdHotkeyAvailable(resourcesPath, platform)) return 'no-helper';
  return null;
}

// ── hotkey name validation (verbatim semantics from the reference) ──────────
const MODIFIERS = new Set(['control', 'ctrl', 'option', 'alt', 'shift', 'cmd', 'command', 'meta', 'super']);
const PRINT_SCREEN = new Set(['printscreen', 'print', 'prtsc']);
const F_KEY = /^f([1-9]|1\d|20)$/;
const KEYS = new Set([
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  '=', '-', ']', '[', "'", ';', '\\', ',', '/', '.', '`',
  'return', 'enter', 'tab', 'space', 'backspace', 'delete', 'escape', 'esc',
  'home', 'end', 'pageup', 'pagedown', 'left', 'right', 'down', 'up',
  'plus', 'minus', 'comma', 'period', 'slash', 'semicolon', 'quote', 'grave',
  'printscreen', 'print', 'prtsc',
]);
const isHoldKey = name => { const k = name.trim().toLowerCase(); return k === 'option' || k === 'alt' || k === 'opt'; };
function hotkeyProblem(name, platform) {
  if (isHoldKey(name)) return platform && platform !== 'darwin' ? 'bare-modifier' : null;
  const parts = name.split('+').map(p => p.trim());
  const last = parts[parts.length - 1] ?? '';
  if (!last) return parts.length > 1 && MODIFIERS.has(parts[0]?.toLowerCase() ?? '') ? 'bare-modifier' : 'empty';
  for (const m of parts.slice(0, -1)) if (!MODIFIERS.has(m.toLowerCase())) return 'bad-modifier';
  const key = last.toLowerCase();
  if (MODIFIERS.has(key)) return 'bare-modifier';
  const isF = F_KEY.test(key);
  if (!KEYS.has(key) && !isF) return 'bad-key';
  if (PRINT_SCREEN.has(key) && platform === 'darwin') return 'bad-key';
  if (parts.length === 1 && !isF) return 'bare-key';
  return null;
}
const needsNewHelperKey = name => /(^|\+)\s*(printscreen|print|prtsc)\s*$/i.test(name);
const defaultMeetingKey = p => p === 'darwin' ? 'Shift+Command+Space' : 'Control+Shift+Space';
const meetingKeyFor = (stored, p) => String(stored ?? '').trim() || defaultMeetingKey(p);
const defaultCaptureKey = p => p === 'darwin' ? 'Control+Shift+5' : 'Control+Shift+PrintScreen';
const captureKeyFor = (stored, p) => String(stored ?? '').trim() || defaultCaptureKey(p);
const streamRefused = e => e instanceof HelperError && (e.code === 'unknown-op' || e.code === 'unsupported');

// ── AnyAppDictation: hold-to-talk → transcribe → inject ─────────────────────
class AnyAppDictation {
  /** opts: {helperPath, env, transcriber{transcribePcm16}, key, route(), ignore(), onEvent, stream, restoreMs, spawn} */
  constructor(opts) {
    this.opts = opts;
    this.helper = new LineHelper(opts.helperPath, {
      env: opts.env, spawn: opts.spawn,
      onEvent: e => this._onHelperEvent(e),
      onExit: why => { this.armedKey = null; this._endTake(); opts.onEvent?.({ type: 'helper-exited', why }); },
    });
    this.chain = Promise.resolve();
    this.armedKey = null;
    this.streamOff = false;      // helper refused streaming → file mode for the session
    this.held = null;            // {chunks:[], sampleRate, keyupAt}
    this.skipping = false;       // this take was dropped (opts.ignore at keydown)
    this.routedNow = false;      // this take goes to our own window (opts.route at keydown)
    this.takeOpen = null; this.takeDone = null;
  }
  get armed() { return this.armedKey; }
  async whenIdle() {
    for (;;) {
      const t = this.takeOpen;
      if (t) { await t; continue; }
      await this.chain;
      if (!this.takeOpen) return;
    }
  }
  _beginTake() {
    if (this.takeOpen) return;
    this.takeOpen = new Promise(res => { this.takeDone = res; });
  }
  _endTake() {
    const done = this.takeDone;
    if (!done) return;
    this.takeDone = null;
    const clear = () => { this.takeOpen = null; done(); };
    void this.chain.then(clear, clear);
  }
  _emitFor(routed, e) { this.opts.onEvent?.(routed ? { ...e, routed: true } : e); }
  get streaming() { return (this.opts.stream ?? true) && typeof this.opts.transcriber?.openStream === 'function'; }
  get streamRefused() { return this.streamOff; }

  async start() {
    const r = await this.helper.request({ op: 'arm', key: this.opts.key, record: true, stream: this.streaming });
    this.armedKey = this.opts.key;
    return { key: this.opts.key, keyCode: Number(r.keyCode), stream: r.stream === true };
  }
  async stop() {
    if (this.helper.running) {
      await this.helper.request({ op: 'disarm' }).catch(() => {});
      await this.helper.stop();
    }
    this.armedKey = null;
  }
  async permissions() {
    const r = await this.helper.request({ op: 'permissions' });
    return { mic: r.mic, accessibility: r.accessibility === true, postEvent: r.postEvent === true };
  }
  async requestMic() { const r = await this.helper.request({ op: 'requestMic' }); return r.mic; }
  async requestAccessibility() { const r = await this.helper.request({ op: 'requestAccessibility' }); return r.accessibility === true; }
  async requestPostEvent() { const r = await this.helper.request({ op: 'requestPostEvent' }); return r.postEvent === true; }
  async openSettings(pane) { const r = await this.helper.request({ op: 'openSettings', pane }); return r.ok === true; }
  /** Paste text into the frontmost app (Settings "try it" button path). */
  async inject(text, dryRun = false) {
    const r = await this.helper.request({ op: 'inject', text, dryRun, restoreMs: this.opts.restoreMs ?? 300 });
    return { posted: r.posted === true };
  }

  _onHelperEvent(e) {
    if (e.event === 'keydown') {
      this._beginTake();
      this.skipping = this.opts.ignore?.() === true;
      this.routedNow = !this.skipping && this.opts.route?.() === true;
    }
    const routed = this.routedNow;
    const emit = ev => this._emitFor(routed, ev);
    if (this.skipping) {
      if (e.event === 'audio' || e.event === 'audio-end' || e.event === 'cancel') { this.skipping = false; this._endTake(); }
      if (['keydown', 'keyup', 'chunk', 'level', 'audio', 'audio-end', 'cancel'].includes(e.event)) return;
    }
    switch (e.event) {
      case 'level':
        emit({ type: 'level', rms: Number(e.rms ?? 0), peak: Number(e.peak ?? 0) });
        break;
      case 'cancel': {
        const h = this.held; this.held = null;
        if (h) void h.open.then(st => st?.cancel());
        emit({ type: 'cancelled', why: String(e.why ?? '') });
        this._endTake();
        break;
      }
      case 'keydown':
        emit({ type: 'keydown' });
        if (this.streaming) this.held = this._openHeld();
        break;
      case 'keyup':
        emit({ type: 'keyup', heldMs: Number(e.heldMs ?? 0) });
        if (this.held) this.held.keyupAt = Date.now();
        break;
      case 'chunk': {
        const h = this.held ?? (this.held = this._openHeld());
        const buf = Buffer.from(String(e.pcm16 ?? ''), 'base64');
        h.sampleRate = Number(e.sampleRate ?? h.sampleRate);
        h.chunks.push(buf);
        if (h.stream) void h.stream.write(buf);
        break;
      }
      case 'audio': {          // whole clip in one shot (non-stream mode)
        const buf = Buffer.from(String(e.pcm16 ?? ''), 'base64');
        const sr = Number(e.sampleRate ?? 16000);
        this._place(this._transcribeClip(buf, sr), routed);
        break;
      }
      case 'audio-end': {
        const h = this.held; this.held = null;
        if (h) this._place(this._finishHeld(h), routed);
        else this._endTake();
        break;
      }
    }
  }
  _openHeld() {
    const open = this.streaming
      ? this.opts.transcriber.openStream().catch(e => { if (streamRefused(e)) { this.streamOff = true; return null; } throw e; })
      : Promise.resolve(null);
    return { chunks: [], sampleRate: 16000, keyupAt: 0, open, stream: null,
      ready: open.then(st => { this.held && (this.held.stream = st); return st; }) };
  }
  async _finishHeld(h) {
    if (h.stream) {                 // streamed: close and take final text
      const st = await h.open.catch(() => null);
      const out = st ? await st.finish() : { text: '' };
      return out?.text ?? '';
    }
    const pcm = Buffer.concat(h.chunks);
    return this._transcribeClip(pcm, h.sampleRate);
  }
  async _transcribeClip(pcm16, sampleRate) {
    const r = await this.opts.transcriber.transcribePcm16({ pcm16, sampleRate });
    return r?.text ?? '';
  }
  _place(textP, routed) {
    // serialize placement: transcribe → inject into frontmost app (or emit if routed)
    this.chain = this.chain.then(async () => {
      try {
        const text = await textP;
        if (!text) return;
        if (routed) this._emitFor(true, { type: 'text', text });
        else await this.inject(text);
      } catch (e) {
        this.opts.onEvent?.({ type: 'error', error: e instanceof Error ? e.message : String(e) });
      } finally { this._endTake(); }
    });
    return this.chain;
  }
}

module.exports = {
  AnyAppDictation, LineHelper, HelperError,
  mdHotkeyPath, mdHotkeyAvailable, isWaylandSession, anyAppUnavailableReason,
  hotkeyProblem, isHoldKey, streamRefused,
  needsNewHelperKey, meetingKeyFor, captureKeyFor, defaultMeetingKey, defaultCaptureKey,
  MODIFIERS, PRINT_SCREEN, F_KEY, KEYS,
};
