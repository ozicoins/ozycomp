'use strict';
/**
 * Relay — cross-device floor-to-floor link (the reference's "teams" plane).
 * A relay server relays envelopes between floors over WebSocket-ish JSON
 * lines; trust is TOFU: the first relay we talk to gets pinned in
 * <home>/trust.json (0600) and a key change later is loud, not silent.
 *
 *   relay.harnessmd.com           production relay
 *   127.0.0.1:4312                dev relay (when OZYC_RELAY_DEV=1)
 *
 * The client is deliberately minimal: newline-delimited JSON over TCP with a
 * token handshake — no ws dep, matching the zero-dep rule. Messages that
 * arrive get dropped into the hive as 'relay' envelopes; outgoing
 * {to:"floor:<name>"} envelopes in god's outbox get forwarded upstream.
 */
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readJson, writeJson } = require('./hive');

const PROD_HOST = 'relay.harnessmd.com';
const PROD_PORT = 4430;
const DEV_HOST = '127.0.0.1';
const DEV_PORT = 4312;
const TRUST_FILE = 'trust.json';
const RECONNECT_MS = 15_000;

class TrustStore {
  constructor(home) { this.file = path.join(home, TRUST_FILE); }
  read() { return readJson(this.file, {}); }
  /** TOFU: pin the first key seen; flag a mismatch on later connects. */
  pin(host, key) {
    const t = this.read();
    if (!t[host]) {
      t[host] = { key, pinnedAt: new Date().toISOString() };
      writeJson(this.file, t, { mode: 0o600 });
      return { pinned: true, changed: false };
    }
    return { pinned: false, changed: t[host].key !== key };
  }
}

class RelayClient {
  /** deps: {hive, home, emit, floorId, token} */
  constructor({ hive, home, emit, floorId, token } = {}) {
    this.hive = hive;
    this.emit = emit ?? (() => {});
    this.floorId = floorId ?? 'floor';
    this.token = token ?? crypto.randomBytes(12).toString('hex');
    this.trust = new TrustStore(home);
    this.sock = null;
    this.timer = null;
    this.connected = false;
    const dev = process.env.OZYC_RELAY_DEV === '1';
    this.host = dev ? DEV_HOST : PROD_HOST;
    this.port = dev ? DEV_PORT : PROD_PORT;
  }

  start() {
    if (this.timer) return;
    this._connect();
    this.timer = setInterval(() => {
      if (!this.connected) this._connect();
      else this.drainOutbox();
    }, RECONNECT_MS);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.sock?.destroy(); } catch {}
    this.sock = null; this.connected = false;
  }

  _connect() {
    const sock = net.createConnection({ host: this.host, port: this.port, timeout: 5000 }, () => {
      this.connected = true;
      this.sock = sock;
      // handshake: identify floor + trust key
      const key = crypto.createHash('sha256').update(`${this.floorId}:${this.token}`).digest('hex');
      const pin = this.trust.pin(this.host, key);
      if (pin.changed) this.emit('relay-trust-changed', { host: this.host });
      sock.write(JSON.stringify({ hello: this.floorId, token: this.token }) + '\n');
      this.emit('relay-up', { host: this.host, pinned: pin.pinned });
    });
    let buf = '';
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try { this._onLine(JSON.parse(line)); } catch {}
      }
    });
    const drop = () => { this.connected = false; this.sock = null; this.emit('relay-down', {}); this._onDrop?.(); };
    sock.on('error', drop);
    sock.on('close', drop);
    sock.on('timeout', () => { try { sock.destroy(); } catch {} drop(); });
  }

  _onLine(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.from && msg.to) {
      // an envelope for a local agent → route it through the hive (verbatim send)
      this.hive.send({ to: msg.to, act: msg.act ?? 'relay', body: msg.body ?? '', relayed: true }, `floor:${msg.floor ?? this.host}`);
    }
    this.emit('relay-msg', msg);
  }

  /** Forward an envelope to another floor through the relay. */
  sendToFloor(floorId, to, act, body) {
    if (!this.connected || !this.sock) return false;
    this.sock.write(JSON.stringify({ floor: this.floorId, destFloor: floorId, to, act, body }) + '\n');
    this.hive.log({ kind: 'relay-send', floor: floorId, to, act });
    return true;
  }

  /**
   * Drain hive/relay-outbox/: the router parks every envelope addressed
   * `to: "floor:<name>"` there; we forward each upstream and delete it.
   */
  drainOutbox() {
    const dir = this.hive.p('relay-outbox');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return 0; }
    let n = 0;
    for (const f of files) {
      const full = path.join(dir, f);
      const m = readJson(full, null);
      if (!m) { try { fs.rmSync(full, { force: true }); } catch {} continue; }
      const dest = String(m.to).slice('floor:'.length);
      if (this.sendToFloor(dest, m.from, m.act ?? 'relay', m.body ?? '')) {
        try { fs.rmSync(full, { force: true }); } catch {}
        n++;
      }
    }
    return n;
  }
}

module.exports = { RelayClient, TrustStore, PROD_HOST, PROD_PORT, DEV_HOST, DEV_PORT };
