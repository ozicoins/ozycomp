'use strict';
/**
 * WebhookServer — inbound HTTP triggers, loopback-only by default.
 *
 *   POST /spawn   {"objective":"…","provider":"claude","model":"…",…}
 *                 → writes a spawn-request manifest into the hive (temps pick
 *                   it up). Requires `Authorization: Bearer <token>`.
 *   POST /message {"agent":"<id>","text":"…"}
 *                 → envelope from 'webhook' to the agent's inbox.
 *   GET  /health  → {ok:true}
 *
 * The bearer token lives in <home>/.webhook-token (0600), generated on first
 * start — same pattern as the hook plane's token.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertAgentId, writeJson } = require('./hive');

const MAX_BODY = 1e6;

function loadOrCreateToken(home) {
  const f = path.join(home, '.webhook-token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

class WebhookServer {
  constructor({ hive, home, host = '127.0.0.1', port = 0, emit } = {}) {
    this.hive = hive;
    this.home = home;
    this.host = host;
    this.port = port;
    this.emit = emit ?? (() => {});
    this.token = null;
    this.server = null;
    this.boundPort = null;
  }

  async start() {
    if (this.server) return this.boundPort;
    this.token = loadOrCreateToken(this.home);
    this.server = http.createServer((req, res) => this._handle(req, res));
    await new Promise((ok, bad) => this.server.listen(this.port, this.host, e => e ? bad(e) : ok()));
    this.boundPort = this.server.address().port;
    return this.boundPort;
  }
  stop() { try { this.server?.close(); } catch {} this.server = null; }

  _authed(req) {
    const h = req.headers.authorization ?? '';
    return h === `Bearer ${this.token}`;
  }

  _handle(req, res) {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      const reply = (code, obj) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
      if (req.method !== 'POST') return reply(405, { ok: false });
      if (!this._authed(req)) return reply(401, { ok: false, error: 'unauthorized' });
      let body;
      try { body = JSON.parse(buf || '{}'); } catch { return reply(400, { ok: false, error: 'bad-json' }); }

      if (req.url === '/spawn') {
        const objective = String(body.objective ?? '').trim();
        if (!objective) return reply(400, { ok: false, error: 'missing-objective' });
        const fname = `webhook-${Date.now()}-${crypto.randomUUID().slice(0, 6)}.json`;
        writeJson(path.join(this.hive.p('spawn-requests'), fname), { ...body, objective });
        this.emit('webhook-spawn', fname);
        return reply(200, { ok: true, file: fname });
      }
      if (req.url === '/message') {
        try { assertAgentId(body.agent); } catch { return reply(400, { ok: false, error: 'bad-agent' }); }
        const msg = this.hive.send({ to: body.agent, act: 'webhook', body: String(body.text ?? '') }, 'webhook');
        return reply(200, { ok: true, id: msg.id });
      }
      return reply(404, { ok: false });
    });
  }
}

module.exports = { WebhookServer, loadOrCreateToken };
