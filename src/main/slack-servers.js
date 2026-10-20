'use strict';
/**
 * Slack HTTP endpoints — verbatim port of the reference SlackReplyServer and
 * SlackWebhookServer (index.js ~15247-15656 and ~15526-15652), plus the
 * done-observer ledger (~32910-33021).
 *
 * Plain Node http/https/crypto — zero-dep, matching the clone's rule. The
 * reference wraps each in `class { field = x }`; the clone's house style moves
 * those initializers into the constructor so the file parses on every Node.
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  shouldTrigger: _shouldTrigger,
  ActivatedThreads: _ActivatedThreads,
  SeenEvents: _SeenEvents,
  dedupKey: _dedupKey,
} = require('./slack-trigger');

const MAX_BODY_BYTES = 1024 * 1024;
const REPLAY_WINDOW_SECONDS = 60 * 5;
const TUNNEL_START_TIMEOUT_MS = 1e4;
const SLACK_API_TIMEOUT_MS = 12e3;

function errMsg(e) { return e instanceof Error ? e.message : String(e); }

function isLoopback(addr) {
  const a = String(addr ?? '').replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

function stripLeadingMention(text) {
  return String(text ?? '').replace(/^\s*<@[A-Z0-9]+>\s*/i, '').trim();
}

// ─── postSlackReply (verbatim ~15482) ────────────────────────────────────────
// A single chat.postMessage call. `postSink` is the shared outbound-history
// tap set by setSlackPostSink — every post (reply endpoint, ack, done summary,
// IPC slack:reply) records into slack-history.jsonl through it.
let postSink = null;
function setSlackPostSink(sink) { postSink = sink; }

function postSlackReply(opts) {
  return new Promise((resolve) => {
    if (!opts.botToken) {
      resolve({ ok: false, error: 'missing bot token' });
      return;
    }
    if (!opts.channel?.trim() || !opts.thread_ts?.trim()) {
      resolve({ ok: false, error: 'missing explicit channel or thread_ts' });
      return;
    }
    const body = JSON.stringify({ channel: opts.channel, thread_ts: opts.thread_ts, text: opts.text });
    const req = https.request({
      method: 'POST',
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        authorization: `Bearer ${opts.botToken}`,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ ok: json.ok === true, error: json.error });
        } catch {
          resolve({ ok: false, error: 'bad response from Slack' });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: errMsg(e) }));
    req.setTimeout(SLACK_API_TIMEOUT_MS, () => req.destroy(new Error('timed out')));
    req.write(body);
    req.end();
  }).then((r) => {
    try {
      postSink?.({ channel: opts.channel, thread_ts: opts.thread_ts, text: opts.text, ok: r.ok, error: r.error });
    } catch {}
    return r;
  });
}

// ─── SlackReplyServer (verbatim ~15526) ──────────────────────────────────────
// The loopback endpoint the bundled md-slack-reply.cjs helper (and any agent
// terminal that ran it directly) posts to. Token auth + 127.0.0.1 gate + a
// single POST /reply route; on a verified post it forwards to postSlackReply
// and fires onReplied(thread_ts) so the done-observer skips that thread.
class SlackReplyServer {
  constructor(opts) {
    this.server = null;
    this.token = opts.token;
    this.getBotToken = opts.getBotToken;
    this.onReplied = opts.onReplied;
  }
  /** Bind a loopback port (0 ⇒ OS-assigned). Resolves the actual bound port. */
  start(preferredPort = 0) {
    return new Promise((resolve) => {
      if (this.server) {
        resolve({ ok: false, error: 'already running' });
        return;
      }
      const server = http.createServer((req, res) => this.handle(req, res));
      const onError = (e) => {
        server.off('listening', onListening);
        resolve({ ok: false, error: errMsg(e) });
      };
      const onListening = () => {
        server.off('error', onError);
        this.server = server;
        const addr = server.address();
        resolve({ ok: true, port: addr && typeof addr === 'object' ? addr.port : preferredPort });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(preferredPort, '127.0.0.1');
    });
  }
  /** Close the endpoint. Idempotent and best-effort. */
  stop() {
    try {
      this.server?.close();
    } catch {}
    this.server = null;
  }
  handle(req, res) {
    if (!isLoopback(req.socket.remoteAddress ?? '')) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/reply') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!this.checkToken(req.headers['x-md-reply-token'])) {
      res.writeHead(401);
      res.end();
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'bad json' }));
        return;
      }
      const botToken = this.getBotToken();
      if (!botToken) {
        res.writeHead(503);
        res.end(JSON.stringify({ ok: false, error: 'no bot token' }));
        return;
      }
      if (!parsed.channel || !parsed.thread_ts || !parsed.text) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'channel, thread, text required' }));
        return;
      }
      const thread_ts = parsed.thread_ts;
      postSlackReply({ botToken, channel: parsed.channel, thread_ts, text: parsed.text }).then((r) => {
        if (r.ok) {
          try {
            this.onReplied?.(thread_ts);
          } catch {}
        }
        res.writeHead(r.ok ? 200 : 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r));
      }).catch((e) => {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: errMsg(e) }));
      });
    });
    req.on('error', () => {
      if (!aborted) {
        try {
          res.writeHead(400);
          res.end();
        } catch {}
      }
    });
  }
  /** Constant-time match of the request's reply token against the session token. */
  checkToken(provided) {
    if (typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}

// ─── SlackWebhookServer (verbatim ~15251) ────────────────────────────────────
// The public-URL transport: local HTTP bound to a configured port, a
// tunnelmole URL on top, Slack signs each POST with the signing secret. The
// verbatim gate — HMAC + 5-minute replay window + channel filter + mention or
// activated-thread + channel:ts dedup — lives on the same _shouldTrigger the
// poller uses.
class SlackWebhookServer {
  constructor(opts) {
    this.server = null;
    this.tunnelUrl = null;
    this.port = opts.port;
    this.requestedPort = opts.port;
    this.movedFromPort = undefined;
    this.tunnelOpener = opts.openTunnel;
    this.signingSecret = opts.signingSecret;
    this.channelId = opts.channelId?.trim() || undefined;
    this.onMessage = opts.onMessage;
    this.botUserId = null;
    this.activatedThreads = new _ActivatedThreads();
    this.seenEvents = new _SeenEvents();
  }
  /**
   * Bind the local HTTP server, then open a public tunnel to it. The HTTP
   * handler (the security boundary) is live the instant `listen` resolves; the
   * tunnel is opened afterwards and is non-fatal — if it can't be established
   * (offline, loca.lt down, timed out) the server keeps running and we report
   * the tunnel error without a URL.
   */
  async start() {
    if (this.server) return { ok: false, error: 'already running' };
    if (!this.signingSecret) return { ok: false, error: 'missing signing secret' };
    let movedFrom;
    try {
      await this.listen(this.requestedPort);
    } catch (e) {
      if (e?.code !== 'EADDRINUSE') {
        this.stop();
        return { ok: false, error: `failed to bind port ${this.requestedPort}: ${errMsg(e)}` };
      }
      try {
        await this.listen(0);
        movedFrom = this.requestedPort;
        this.movedFromPort = movedFrom;
      } catch (e2) {
        this.stop();
        return { ok: false, error: `failed to bind port ${this.requestedPort} (in use) or any free port: ${errMsg(e2)}` };
      }
    }
    const bound = { port: this.port, ...(movedFrom !== undefined ? { movedFrom } : {}) };
    try {
      const url = await this.openTunnel();
      if (!url) throw new Error('tunnelmole returned empty URL');
      this.tunnelUrl = url;
      return { ok: true, url, ...bound };
    } catch (e) {
      return { ok: false, error: `tunnel unavailable: ${errMsg(e)}`, ...bound };
    }
  }
  /** Where the server really is, for Settings. Empty when it is not bound. */
  boundPort() {
    if (!this.server) return {};
    return { port: this.port, ...(this.movedFromPort !== undefined ? { movedFrom: this.movedFromPort } : {}) };
  }
  /** Close the HTTP server. Idempotent and best-effort.
   *  Note: tunnelmole has no documented close handle; teardown is best-effort. */
  stop() {
    this.movedFromPort = undefined;
    this.tunnelUrl = null;
    try {
      this.server?.close();
    } catch {}
    this.server = null;
  }
  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      const onError = (e) => reject(e);
      server.once('error', onError);
      server.listen(port, () => {
        server.off('error', onError);
        this.server = server;
        const addr = server.address();
        this.port = addr && typeof addr === 'object' ? addr.port : port;
        resolve();
      });
    });
  }
  async openTunnel() {
    if (this.tunnelOpener) return this.tunnelOpener(this.port);
    // Lazy-require so the module still loads when the optional dep is absent
    // (zero-dep rule; the verbatim import() is kept in spirit — absent module
    // resolves to the tunnel-unavailable branch, not a boot crash).
    let tunnelmole;
    try {
      ({ tunnelmole } = await import('tunnelmole'));
    } catch (e) {
      throw e;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), TUNNEL_START_TIMEOUT_MS);
      tunnelmole({ port: this.port }).then((url) => {
        clearTimeout(timer);
        resolve(url);
      }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
  /** Buffer the raw body (needed verbatim for the HMAC) under a size cap, then
   *  verify + dispatch. Only POST is accepted. */
  handleRequest(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      this.handleBody(req, res, Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (aborted) return;
      try {
        res.writeHead(400);
        res.end();
      } catch {}
    });
  }
  handleBody(req, res, rawBody) {
    if (!this.verify(req, rawBody)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }
    if (payload.type === 'event_callback' && payload.event) {
      const authUserId = payload.authorizations?.[0]?.user_id;
      if (authUserId && !this.botUserId) this.botUserId = authUserId;
      const ev = payload.event;
      const { trigger, text: rawText, files: rawFiles } = _shouldTrigger(
        ev,
        this.botUserId,
        this.channelId,
        this.activatedThreads,
      );
      if (trigger) {
        const text = stripLeadingMention(rawText);
        const channel = typeof ev.channel === 'string' ? ev.channel : '';
        const ts = typeof ev.ts === 'string' ? ev.ts : '';
        const thread_ts = typeof ev.thread_ts === 'string' && ev.thread_ts || ts;
        if ((text || rawFiles.length > 0) && channel && ts) {
          const dupKey = _dedupKey(ev);
          const isDuplicate = dupKey ? this.seenEvents.seen(dupKey) : false;
          if (!isDuplicate) {
            const msg = { text, channel, ts, thread_ts };
            if (rawFiles.length > 0) msg._rawFiles = rawFiles;
            try {
              void this.onMessage(msg);
            } catch {}
          }
        }
      }
    }
    res.writeHead(200);
    res.end();
  }
  /**
   * Verify a request is genuinely from Slack: HMAC-SHA256 of `v0:<ts>:<rawBody>`
   * with the signing secret must equal the `X-Slack-Signature` header (compared
   * in constant time), AND the timestamp must be within the replay window.
   */
  verify(req, rawBody) {
    const sig = req.headers['x-slack-signature'];
    const ts = req.headers['x-slack-request-timestamp'];
    if (typeof sig !== 'string' || typeof ts !== 'string') return false;
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;
    if (Math.abs(Date.now() / 1e3 - tsNum) > REPLAY_WINDOW_SECONDS) return false;
    const expected = 'v0=' + crypto.createHmac('sha256', this.signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex');
    const provided = Buffer.from(sig);
    const computed = Buffer.from(expected);
    if (provided.length !== computed.length) return false;
    return crypto.timingSafeEqual(provided, computed);
  }
}

// ─── Done-summary observer (verbatim ~32910-33021) ───────────────────────────
// When a hive task that carries a slack {channel, thread_ts} lands on done,
// post a ✅ summary to that thread — unless the agent already replied there
// itself (directlyRepliedThreads) or we've already notified for that task.
const TERMINAL_SLACK_ERRORS = new Set([
  'missing_scope',
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'no_permission',
  'channel_not_found',
  'not_in_channel',
  'is_archived',
  'restricted_action',
  'org_login_required',
]);

function slackDoneSummary(task) {
  const body = (task.result ?? task.description ?? '').trim();
  const head = `:white_check_mark: *${/^[A-Z][A-Z0-9]{2}-\d+$/.test(task.id) ? `${task.id} ` : ''}${task.title}*`;
  const text = body ? `${head}\n\n${body}` : head;
  return text.length > 2800 ? `${text.slice(0, 2799)}…` : text;
}

function loadSlackDoneNotified(file) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === 'string'));
  } catch {}
  return new Set();
}

function persistSlackDoneNotified(set, file) {
  try {
    fs.writeFileSync(file, JSON.stringify([...set]));
  } catch (e) {
    console.error('[slack] could not persist done-notify ledger:', e);
  }
}

/**
 * One poll pass. Deps are injected so the module stays electron-free:
 *   { tasks() → array, botToken, doneNotified (Set), doneBaseline (Set|null),
 *     directlyRepliedThreads (Set), notifiedFile }.
 * Returns { baseline } — caller stores it on first pass.
 */
async function pollSlackDoneTasks(deps) {
  const { tasks, botToken, doneNotified, doneBaseline, directlyRepliedThreads, notifiedFile } = deps;
  if (!botToken) return { delivered: 0 };
  const list = Array.isArray(tasks) ? tasks : [];
  if (doneBaseline === null) {
    return { baseline: new Set(list.filter((t) => t.status === 'done').map((t) => t.id)) };
  }
  for (const t of list) {
    if (t.status !== 'done') continue;
    if (doneBaseline.has(t.id) || doneNotified.has(t.id)) continue;
    const slack = t.slack;
    if (!slack || !slack.channel || !slack.thread_ts) continue;
    if (directlyRepliedThreads.has(slack.thread_ts)) {
      doneNotified.add(t.id);
      persistSlackDoneNotified(doneNotified, notifiedFile);
      continue;
    }
    if (!(t.result ?? t.description ?? '').trim()) {
      doneNotified.add(t.id);
      persistSlackDoneNotified(doneNotified, notifiedFile);
      continue;
    }
    const res = await postSlackReply({
      botToken,
      channel: slack.channel,
      thread_ts: slack.thread_ts,
      text: slackDoneSummary(t),
    });
    if (res.ok) {
      doneNotified.add(t.id);
      persistSlackDoneNotified(doneNotified, notifiedFile);
    } else if (res.error && TERMINAL_SLACK_ERRORS.has(res.error)) {
      doneNotified.add(t.id);
      persistSlackDoneNotified(doneNotified, notifiedFile);
      console.error(
        '[slack] done-summary post for task',
        t.id,
        '— giving up (terminal error:',
        res.error + '). Fix the Slack bot scope/permissions; later tasks post once resolved.',
      );
    } else {
      console.error('[slack] done-summary post failed for task', t.id, '-', res.error, '(will retry)');
    }
  }
  return {};
}

/**
 * The verbatim 5s observer loop. deps: { tasksFile/readTasks, botToken(),
 * doneNotifiedFile, directlyRepliedThreads }. Returns a handle with stop() and
 * the mutable sets so the caller can report them in status.
 */
function startSlackDoneObserver(deps) {
  const { readTasks, botToken, doneNotifiedFile, directlyRepliedThreads } = deps;
  const doneNotified = loadSlackDoneNotified(doneNotifiedFile);
  let baseline = null;
  let polling = false;
  const tick = async () => {
    if (polling) return;
    const token = typeof botToken === 'function' ? botToken() : botToken;
    if (!token) return;
    let tasks;
    try {
      tasks = readTasks();
    } catch {
      return;
    }
    polling = true;
    try {
      const r = await pollSlackDoneTasks({
        tasks, botToken: token, doneNotified, doneBaseline: baseline,
        directlyRepliedThreads, notifiedFile: doneNotifiedFile,
      });
      if (r.baseline) baseline = r.baseline;
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, 5e3);
  timer.unref?.();
  return {
    stop() { clearInterval(timer); baseline = null; },
    doneNotified,
    get baseline() { return baseline; },
    resetBaseline() { baseline = null; },
  };
}

module.exports = {
  SlackReplyServer, SlackWebhookServer,
  postSlackReply, setSlackPostSink,
  slackDoneSummary, pollSlackDoneTasks, startSlackDoneObserver,
  loadSlackDoneNotified, persistSlackDoneNotified,
  TERMINAL_SLACK_ERRORS, isLoopback, stripLeadingMention,
  MAX_BODY_BYTES, REPLAY_WINDOW_SECONDS, SLACK_API_TIMEOUT_MS,
};
