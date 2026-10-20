'use strict';
/**
 * Probes — provider health checks. Two kinds:
 *
 *   CliProbe       — is the binary on PATH? (which) + does it answer
 *                    `--version` quickly? Drives the "installed" flag.
 *   CliLoginWatcher— watches an agent's PTY scrollback for provider login /
 *                    auth prompts ("sign in", "api key", "authentication
 *                    required", …) so the UI can warn "agent is stuck at a
 *                    login screen" instead of looking dead.
 */
const { spawn } = require('node:child_process');
const { which } = require('./providers');

const LOGIN_PATTERNS = [
  /sign ?in/i, /log ?in/i, /api[_ -]?key/i, /authenticat/i,
  /authorize/i, /open .*browser/i, /device code/i, /gir(iş|̇ş)/i,
];
const LOGIN_SCAN_TAIL = 4000;   // chars of scrollback inspected
const PROBE_TIMEOUT_MS = 4000;

/** Run `bin --version` with a deadline; resolves {ok, version}. */
function probeVersion(bin) {
  const path = which(bin);
  if (!path) return Promise.resolve({ ok: false, reason: 'not-on-path' });
  return new Promise(res => {
    const cp = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { try { cp.kill(); } catch {} res({ ok: false, reason: 'timeout' }); }, PROBE_TIMEOUT_MS);
    cp.stdout.on('data', d => { out += d; });
    cp.on('error', () => { clearTimeout(t); res({ ok: false, reason: 'spawn-error' }); });
    cp.on('exit', code => {
      clearTimeout(t);
      res(code === 0 ? { ok: true, version: out.trim().split('\n')[0] ?? '' }
                     : { ok: false, reason: `exit-${code}` });
    });
  });
}

class CliLoginWatcher {
  /** deps: {pty, emit(ev, agentId, hint)} */
  constructor({ pty, emit } = {}) {
    this.pty = pty;
    this.emit = emit ?? (() => {});
    this.flagged = new Set();          // ids already reported
    this.timer = setInterval(() => this.check(), 5000);
    this.timer.unref?.();
  }
  check() {
    for (const a of this.pty.list()) {
      if (!a.alive || this.flagged.has(a.id)) continue;
      const tail = (this.pty.scrollback(a.id) ?? '').slice(-LOGIN_SCAN_TAIL);
      const hit = LOGIN_PATTERNS.find(re => re.test(tail));
      if (hit) {
        this.flagged.add(a.id);
        this.emit('login-wait', a.id, String(hit));
      }
    }
  }
  clear(id) { this.flagged.delete(id); }
  stop() { clearInterval(this.timer); }
}

module.exports = { CliLoginWatcher, probeVersion, LOGIN_PATTERNS };
