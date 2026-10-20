'use strict';
/**
 * Slack bridge — two transports, same idea as the reference harness:
 *
 *   SocketClient  Slack Socket Mode (WebSocket) via apps.socket.* — events
 *                 arrive pushed; needs SLACK_APP_TOKEN (xapp-…).
 *   Poller        conversations.history polling fallback when only a bot
 *                 token exists; also used to post replies (chat.postMessage).
 *
 * Incoming messages are triaged: a message that looks like a work request is
 * converted to a spawn-request manifest in the hive (temps pick it up —
 * Slack-triaged requests bypass the autonomy switch). Replies from spawned
 * workers are posted back to the originating channel+thread.
 *
 * Plain Node http/https — no @slack/* deps, matching the zero-dep rule.
 */
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { writeJson } = require('./hive');
const {
  shouldTrigger, ActivatedThreads, SeenEvents, dedupKey,
  slackFileUrl, isSlackHost, looksLikeHtmlStub, SLACK_FILE_MAX_REDIRECTS,
} = require('./slack-trigger');
const { stripLeadingMention } = require('./slack-servers');

const POLL_MS = 15_000;
const API = 'slack.com';
const SLACK_FILE_MAX_BYTES = 10 * 1024 * 1024;
const SLACK_DOWNLOAD_TIMEOUT_MS = 12e3;

/** Minimal Slack Web API caller (form-encoded). */
function slackApi(token, method, params = {}) {
  const body = new URLSearchParams(params).toString();
  return new Promise((resolve) => {
    const req = https.request({
      host: API, path: `/api/${method}`, method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: 'bad-json' }); } });
    });
    req.on('error', e => resolve({ ok: false, error: String(e.message) }));
    req.setTimeout(10_000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.end(body);
  });
}

/** Heuristic: does this Slack message read like a work request? */
function looksLikeWork(text) {
  const t = String(text ?? '').toLowerCase();
  return /(please|can you|could you|fix|build|implement|yap|düzelt|ekle|incele|review|deploy|ticket|bug)/.test(t)
      && t.length > 15;
}

class SlackBridge {
  /**
   * @param {object} deps {hive, emit(ev,…), botToken, appToken, channelId,
   *   onMessage(msg) → verbatim transport callback (ipc layer pushes to
   *   renderer + writes history + posts the ack), log(line), stateFile}
   */
  constructor({ hive, emit, botToken, appToken, channelId, onMessage, log, stateFile } = {}) {
    this.hive = hive;
    this.emit = emit ?? (() => {});
    this.onMessage = onMessage ?? null;
    this.log = log ?? (() => {});
    this.botToken = botToken ?? null;
    this.appToken = appToken ?? null;
    this.channelId = channelId ?? null;
    this.stateFile = stateFile ?? null;
    this.timer = null;
    this.sinceTs = '0';
    this.socket = null;                        // Socket Mode ws — connected lazily
    this.threadMap = new Map();                // workerId → {channel, thread_ts}
    this.activated = new ActivatedThreads();   // verbatim mention→thread latch
    this.seen = new SeenEvents();              // verbatim channel:ts dedup
    this.botUserId = null;
    this.status_ = { running: false };
    try {
      if (this.stateFile && fs.existsSync(this.stateFile)) {
        const st = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        if (typeof st?.sinceTs === 'string' && st.sinceTs) this.sinceTs = st.sinceTs;
      }
    } catch {}
  }

  get active() { return !!this.botToken; }

  status() { return { running: !!this.timer, sinceTs: this.sinceTs, activatedThreads: this.activated.size, ...this.status_ }; }

  _persistSince() {
    try {
      if (!this.stateFile) return;
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ sinceTs: this.sinceTs }));
    } catch {}
  }

  start() {
    if (this.timer || !this.active) return false;
    if (this.appToken) this._connectSocket();  // best effort; poller still runs
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
    this.status_.running = true;
    // Best-effort: resolve the bot's own user id so shouldTrigger's mention
    // check (`<@U…>` inside text) matches — verbatim botUserId cache.
    slackApi(this.botToken, 'auth.test', {}).then(r => {
      if (r.ok && typeof r.user_id === 'string') { this.botUserId = r.user_id; this.status_.team = r.team; this.status_.botName = r.user; }
    }).catch(() => {});
    return { ok: true };
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status_.running = false;
    try { this.socket?.close(); } catch {}
    this.socket = null;
  }

  /** conversations.history since last poll → verbatim shouldTrigger gate. */
  async poll() {
    if (!this.active) return { read: 0 };
    if (!this.channelId) return { read: 0 };
    const r = await slackApi(this.botToken, 'conversations.history', {
      channel: this.channelId, oldest: this.sinceTs, limit: '50',
    });
    if (!r.ok) { this.emit('slack-error', r.error); this.log(`poll failed: ${r.error}`); return { read: 0 }; }
    const msgs = (r.messages ?? []).filter(m => !m.bot_id);
    let fired = 0;
    for (const m of msgs.reverse()) {
      if (Number(m.ts) > Number(this.sinceTs)) this.sinceTs = m.ts;
      if (this._dispatch({ type: 'message', ...m })) fired++;
    }
    this._persistSince();
    return { read: msgs.length, fired };
  }

  /** A raw Slack event (poller or socket) through the verbatim trigger gate:
   *  mention/thread latch + dedup, then onMessage verbatim payload. */
  _dispatch(ev) {
    if (this.seen.seen(dedupKey(ev))) return false;
    const { trigger, text, files } = shouldTrigger(ev, this.botUserId, this.channelId || undefined, this.activated);
    if (!trigger) return false;
    const m = {
      text,
      channel: ev.channel,
      ts: ev.ts,
      thread_ts: ev.thread_ts ?? ev.ts,
      user: ev.user,
      _rawFiles: files,
    };
    try { this.onMessage?.(m); } catch (e) { this.log(`onMessage threw: ${e instanceof Error ? e.message : e}`); }
    // Legacy spawn-request lane: unchanged — a work-looking request still drops
    // a manifest into the hive for temps, in parallel with the renderer push.
    this.triage({ ...m, text });
    return true;
  }

  /** Convert a Slack message into a spawn-request manifest when it looks like work. */
  triage(msg) {
    if (!looksLikeWork(msg.text)) { this.emit('slack-skip', msg.ts); return null; }
    const manifest = {
      objective: `Slack request (channel ${msg.channel}):\n${msg.text}`,
      slack: { channel: msg.channel, thread_ts: msg.thread_ts ?? msg.ts, user: msg.user },
      origin: 'slack',
      character: 'slack-hire',
    };
    const fname = `slack-${String(msg.ts).replace('.', '-')}-${crypto.randomUUID().slice(0, 6)}.json`;
    try {
      writeJson(path.join(this.hive.p('spawn-requests'), fname), manifest);
      this.emit('slack-triaged', { ts: msg.ts, file: fname });
      return fname;
    } catch { return null; }
  }

  /** Map a spawned temp worker back to its Slack thread so reports can be posted. */
  bindWorker(workerId, slackRef) {
    if (slackRef?.channel) this.threadMap.set(workerId, { channel: slackRef.channel, thread_ts: slackRef.thread_ts });
  }

  /** Post a worker's report back to its Slack thread. */
  async report(workerId, text) {
    const ref = this.threadMap.get(workerId);
    if (!ref || !this.botToken) return { ok: false, error: 'unbound' };
    return slackApi(this.botToken, 'chat.postMessage', {
      channel: ref.channel, thread_ts: ref.thread_ts ?? '', text: String(text).slice(0, 3900),
    });
  }

  /** Socket Mode — best-effort connect; falls back to polling silently. */
  _connectSocket() {
    slackApi(this.appToken, 'apps.connections.open', {}).then(r => {
      if (!r.ok || !r.url) { this.emit('slack-socket-off', r.error); return; }
      try {
        // minimal WSS client: we only need to receive envelopes and ACK them
        const ws = new (require('node:worker_threads').Worker ? Object : Object)(); // placeholder guard
        void ws;
      } catch {}
      // Real impl uses a ws client if present; without the dep we stay on the poller.
      this.emit('slack-socket-off', 'no-ws-client');
    });
  }
}

// ─── verbatim file-download helpers (reference ~32781-32910) ───────────────

const slackFilesDir = (userData) => path.join(userData, 'slack-files');
function sanitizeSlackFilename(name, tag) {
  const safe = typeof name === 'string' && name ? path.basename(name).replace(/[^\w.\-]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'file' : 'file';
  return `${tag}-${safe}`;
}
function downloadSlackFile(file, botToken, destDir) {
  return new Promise((resolve) => {
    const tag = crypto.randomBytes(4).toString('hex');
    const filename = sanitizeSlackFilename(file.name, tag);
    const destPath = path.join(destDir, filename);
    const name = file.name ?? filename;
    const mimetype = file.mimetype ?? 'application/octet-stream';
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch {
      resolve(null);
      return;
    }
    const startUrl = slackFileUrl(file);
    if (!startUrl) {
      resolve(null);
      return;
    }
    const expectHtml = /html/i.test(mimetype);
    const attempt = (rawUrl, redirectsLeft) => {
      let urlObj;
      try {
        urlObj = new URL(rawUrl);
      } catch {
        resolve(null);
        return;
      }
      if (urlObj.protocol !== 'https:') {
        resolve(null);
        return;
      }
      const headers = {};
      if (isSlackHost(urlObj.hostname)) headers.authorization = `Bearer ${botToken}`;
      const req = https.request(
        { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, method: 'GET', headers },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              console.error('[slack] file download: too many redirects, not saving');
              resolve(null);
              return;
            }
            attempt(res.headers.location, redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            resolve(null);
            return;
          }
          const out = fs.createWriteStream(destPath);
          let received = 0;
          let firstChunk = null;
          let aborted = false;
          res.on('data', (chunk) => {
            if (aborted) return;
            firstChunk ??= chunk.subarray(0, 512);
            received += chunk.length;
            if (received > SLACK_FILE_MAX_BYTES) {
              aborted = true;
              res.destroy();
              out.destroy();
              try { fs.rmSync(destPath, { force: true }); } catch {}
              resolve(null);
            }
          });
          res.on('error', () => { out.destroy(); try { fs.rmSync(destPath, { force: true }); } catch {} resolve(null); });
          out.on('error', () => { res.destroy(); try { fs.rmSync(destPath, { force: true }); } catch {} resolve(null); });
          res.on('end', () => {
            out.end(() => {
              if (aborted) return;
              // A login HTML stub must never be saved as the file (verbatim).
              if (!expectHtml && looksLikeHtmlStub(res.headers['content-type'], firstChunk)) {
                try { fs.rmSync(destPath, { force: true }); } catch {}
                resolve(null);
                return;
              }
              resolve({ path: destPath, name, mimetype, size: received });
            });
          });
          res.pipe(out);
        },
      );
      req.setTimeout(SLACK_DOWNLOAD_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    };
    attempt(startUrl, SLACK_FILE_MAX_REDIRECTS);
  });
}
async function downloadSlackFiles(rawFiles, botToken, destDir) {
  if (!rawFiles.length || !botToken) return [];
  const results = await Promise.all(
    rawFiles.map((f) => downloadSlackFile(f, botToken, destDir))
  );
  return results.filter((r) => r !== null);
}

/**
 * Verbatim autonomous-request protocol preamble (reference ~32731): appended
 * to the renderer's slack:incomingMessage payload so the composer agent knows
 * exactly how to delegate and how to post the thread reply.
 */
function buildAutonomousRequestProtocol(channel, threadTs, helperPath, reader = 'god', nodeCommand = 'node') {
  const reply = `"${nodeCommand}" "${helperPath}" --channel ${channel} --thread ${threadTs} --text "<your reply>"`;
  const verbatim = '(that first path is the harness\'s bundled Node, already resolved for this machine; pass it verbatim)';
  const pause = 'Pause only for a high severity action: pushing to main or any remote, buying or provisioning anything paid, deleting a repo, file or folder you did not create.';
  const mrkdwn = 'A reply is Slack mrkdwn with substance: a short *bold* headline plus the outcome, specifics and links, never a bare "done".';
  if (reader === 'temp') {
    return `[SLACK JOB] You are a temp. This job arrived from Slack and no human is watching in the app.
1. Do it autonomously; no interactive questions. ${pause}
2. When done, post your result to the thread yourself with exactly: ${reply} ${verbatim}. ${mrkdwn}
3. Then send god ONE outbox message with "act":"done" and a short summary; that releases you.
4. If you need a decision, post the question with numbered options to the thread via that command and record {q, options, askedAt (ISO), thread_ts ${threadTs}}; god picks up the human's threaded reply.
The job: `;
  }
  return `[SLACK REQUEST] This arrived from Slack and no human is watching in the app.
1. ROUTE FAST. Check the live roster (registry.json, fleet.json) and hand it to the one agent that fits, above all the one it names ("ask Pam..."); start a temp only if nobody fits. Split it only if it truly needs several people. Do not sit on it.
2. DELEGATE WITH THE REPLY COMMAND. Tell that agent to do the work autonomously and to post its own result to this thread with exactly: ${reply} ${verbatim}.
3. NO INTERACTIVE QUESTIONS. ${pause}
4. ${mrkdwn}
5. The agent reports back to you when done.
6. If a decision is needed, do not block: post the question with numbered options to the thread via that command and record {q, options, askedAt (ISO), thread_ts ${threadTs}} so the human's threaded reply resumes it.
The message: `;
}

// ─── verbatim transports (reference ~15732-16350) ────────────────────────────
// The real Slack stack: a stateful poller (cursor + hot threads + 429 backoff)
// and a Socket Mode client (WSS frames + refresh + catchup poller). Both speak
// through the same `api(method, token, params)` JSON surface — a 429 surfaces
// `retryAfterMs`, a body surfaces `json`, and `x-oauth-scopes` is kept on the
// result so the settings test can report granted vs missing scopes.
const core = require('./slack-poll.cjs');

const slackApiJson = (method, token, params) => new Promise((resolve) => {
  if (!token) {
    resolve({ ok: false, error: 'missing token' });
    return;
  }
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, String(v));
  const data = body.toString();
  const req = https.request({
    method: 'POST',
    hostname: 'slack.com',
    path: `/api/${method}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'content-length': Buffer.byteLength(data),
      authorization: `Bearer ${token}`,
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const status = res.statusCode ?? 0;
      const rawScopes = res.headers['x-oauth-scopes'];
      const scopes = typeof rawScopes === 'string' ? rawScopes.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      if (status === 429) {
        resolve({ ok: false, error: 'ratelimited', status, retryAfterMs: core.retryAfterFromHeader(res.headers['retry-after']) });
        return;
      }
      try {
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve({ ok: json.ok === true, error: json.ok === true ? undefined : json.error ?? `http ${status}`, status, json, ...(scopes ? { scopes } : {}) });
      } catch {
        resolve({ ok: false, error: 'bad response from Slack', status, ...(scopes ? { scopes } : {}) });
      }
    });
  });
  req.on('error', (e) => resolve({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  req.write(data);
  req.end();
});

async function slackAuthTest(botToken, api = slackApiJson) {
  const r = await api('auth.test', botToken, {});
  if (!r.ok) return { ok: false, error: r.error ?? 'auth.test failed', ...(r.scopes ? { scopes: r.scopes } : {}) };
  const j = r.json ?? {};
  return { ok: true, team: j.team, botName: j.user, botUserId: j.user_id, ...(r.scopes ? { scopes: r.scopes } : {}) };
}
async function slackListChannels(botToken, api = slackApiJson) {
  const r = await api('users.conversations', botToken, {
    types: 'public_channel,private_channel',
    exclude_archived: true,
    limit: 200,
  });
  if (!r.ok) {
    const error = r.error ?? 'users.conversations failed';
    return { ok: false, error, needsScope: error === 'missing_scope' || error === 'not_allowed_token_type' };
  }
  const j = r.json ?? {};
  const channels = (j.channels ?? []).filter((c) => typeof c.id === 'string' && c.id.length > 0).map((c) => ({ id: c.id, name: typeof c.name === 'string' ? c.name : c.id, isPrivate: c.is_private === true })).sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, channels };
}
async function slackConnectionsOpenTest(appToken, api = slackApiJson) {
  if (!appToken) return { ok: false, error: 'missing app token' };
  const r = await api('apps.connections.open', appToken, {});
  if (!r.ok) return { ok: false, error: r.error ?? 'apps.connections.open failed' };
  const url = (r.json ?? {}).url;
  return typeof url === 'string' && url.startsWith('wss://') ? { ok: true } : { ok: false, error: 'no socket address in the answer' };
}

class SlackPoller {
  constructor(opts) {
    this.opts = opts;
    this.api = opts.api ?? slackApiJson;
    this.now = opts.now ?? (() => Date.now());
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref?.();
        return h;
      },
      clearTimeout: (h) => clearTimeout(h),
    };
    this.log = opts.log ?? (() => {});
    this.state = core.createState(opts.channelId, this.now());
    this.backoff = core.createBackoff();
    /** Shared with the socket way when it runs a sweep, so both agree on which
     *  threads the bot answers in and which messages are already delivered. */
    this.activated = new ActivatedThreads();
    this.seen = new SeenEvents();
    this.botUserId = null;
    this.team = undefined;
    this.botName = undefined;
    this.running = false;
    this.sweeping = false;
    this.timer = null;
    this.lastPollAt = undefined;
    this.nextPollAt = undefined;
    this.lastError = undefined;
  }
  /** auth.test, load the state file, arm the timer. Fails closed: a bad
   *  token or channel returns the error and nothing is armed. */
  async start() {
    if (this.running) return { ok: false, error: 'already running' };
    if (!this.opts.botToken) return { ok: false, error: 'missing bot token' };
    if (!this.opts.channelId) return { ok: false, error: 'missing channel' };
    const who = await slackAuthTest(this.opts.botToken, this.api);
    if (!who.ok) {
      this.lastError = who.error;
      return { ok: false, error: who.error };
    }
    this.team = who.team;
    this.botName = who.botName;
    this.botUserId = who.botUserId ?? null;
    this.loadState();
    this.state.botUserId = this.botUserId;
    this.saveState();
    this.running = true;
    this.lastError = undefined;
    if (this.opts.intervalMs > 0) this.arm(0);
    return { ok: true, team: this.team, botName: this.botName };
  }
  stop() {
    this.running = false;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextPollAt = undefined;
    this.saveState();
  }
  status() {
    return {
      running: this.running,
      lastPollAt: this.lastPollAt,
      nextPollAt: this.running ? this.nextPollAt : undefined,
      lastError: this.lastError,
      hotThreads: core.hotThreadCount(this.state, this.now()),
      team: this.team,
      botName: this.botName,
      botUserId: this.botUserId ?? undefined,
    };
  }
  /** The socket way delivered this message itself: move the cursor and the
   *  thread's last reply past it and mark it seen, so a sweep asks only for
   *  what came after and never delivers it twice. */
  noteDelivered(m) {
    if (!m.ts) return;
    this.seen.seen(`${m.channel}:${m.ts}`);
    const isParent = !m.thread_ts || m.thread_ts === m.ts;
    if (isParent) core.advanceCursor(this.state, [{ ts: m.ts }]);
    const thread = m.thread_ts || m.ts;
    if (m.mentioned) this.activated.add(thread);
    if (m.mentioned || this.activated.has(thread)) {
      core.noteThreadActivity(this.state, thread, m.ts, this.now(), { mentioned: m.mentioned });
    }
    this.saveState();
  }
  /** One pass: history after the cursor, then the hot threads. Safe to call
   *  while a timer is armed; overlapping calls are refused, not queued. */
  async sweepNow() {
    if (this.sweeping) return { ok: false, delivered: 0, error: 'sweep in progress' };
    if (!this.opts.botToken) return { ok: false, delivered: 0, error: 'missing bot token' };
    this.sweeping = true;
    let delivered = 0;
    let limited = false;
    try {
      const nowMs = this.now();
      this.lastPollAt = nowMs;
      const channel = this.opts.channelId;
      const hist = await this.api('conversations.history', this.opts.botToken, {
        channel,
        oldest: this.state.cursor,
        limit: core.HISTORY_LIMIT,
        inclusive: false,
      });
      if (!hist.ok) {
        if (hist.status === 429) {
          limited = true;
          this.onLimited(hist.retryAfterMs);
          return { ok: false, delivered, error: 'ratelimited' };
        }
        return this.fail(hist.error ?? 'history failed', delivered);
      }
      const hj = hist.json ?? {};
      const parents = core.afterCursor(this.state, hj.messages ?? []);
      for (const raw of parents) {
        const ev = core.withChannel(raw, channel);
        if (this.deliver(ev, nowMs)) delivered += 1;
        const t = this.state.threads[ev.ts];
        if (t && typeof ev.latest_reply === 'string' && core.compareTs(ev.latest_reply, t.lastReplyTs) > 0) {
          core.noteThreadActivity(this.state, ev.ts, undefined, nowMs);
          t.lastActivityAt = Math.max(t.lastActivityAt, nowMs);
        }
      }
      core.advanceCursor(this.state, parents);
      for (const thread of core.hotThreads(this.state, nowMs, this.backoff.budget)) {
        const t = this.state.threads[thread];
        const rep = await this.api('conversations.replies', this.opts.botToken, {
          channel,
          ts: thread,
          oldest: t.lastReplyTs,
          limit: core.REPLIES_LIMIT,
          inclusive: false,
        });
        if (!rep.ok) {
          if (rep.status === 429) {
            limited = true;
            this.onLimited(rep.retryAfterMs);
            return { ok: false, delivered, error: 'ratelimited' };
          }
          if (core.isTerminalError(rep.error)) return this.fail(rep.error, delivered);
          this.log(`slack poll: replies for a thread failed (${rep.error ?? 'unknown'})`);
          core.noteThreadChecked(this.state, thread, nowMs);
          continue;
        }
        const rj = rep.json ?? {};
        const replies = core.sortOldestFirst(rj.messages ?? []).filter((m) => m.ts !== thread && core.compareTs(m.ts, t.lastReplyTs) > 0);
        for (const raw of replies) {
          const ev = core.withChannel({ ...raw, thread_ts: raw.thread_ts ?? thread }, channel);
          if (this.deliver(ev, nowMs)) delivered += 1;
          core.noteThreadActivity(this.state, thread, ev.ts, nowMs);
        }
        core.noteThreadChecked(this.state, thread, nowMs);
      }
      core.pruneThreads(this.state, nowMs);
      this.lastError = undefined;
      return { ok: true, delivered };
    } catch (e) {
      return this.fail(e instanceof Error ? e.message : String(e), delivered);
    } finally {
      if (!limited && this.running) core.onCleanTick(this.backoff);
      this.saveState();
      this.sweeping = false;
      if (this.running && this.opts.intervalMs > 0) this.arm(core.nextDelayMs(this.backoff, this.opts.intervalMs));
    }
  }
  /** The same gate as the webhook: trigger rules, non empty, dedup, then the
   *  same message shape. Returns whether it was handed on. */
  deliver(ev, nowMs) {
    const { trigger: fire, text: rawText, files } = shouldTrigger(ev, this.botUserId, this.opts.channelId, this.activated);
    if (!fire) return false;
    const text = stripLeadingMention(rawText);
    const channel = typeof ev.channel === 'string' ? ev.channel : this.opts.channelId;
    const ts = typeof ev.ts === 'string' ? ev.ts : '';
    const thread_ts = typeof ev.thread_ts === 'string' && ev.thread_ts || ts;
    if (!(text || files.length > 0) || !channel || !ts) return false;
    const key = dedupKey(ev);
    if (key && this.seen.seen(key)) return false;
    const mentioned = core.mentionsBot(ev, this.botUserId);
    core.noteThreadActivity(this.state, thread_ts, ts, nowMs, { mentioned });
    const msg = { text, channel, ts, thread_ts };
    if (files.length > 0) msg._rawFiles = files;
    try {
      void this.opts.onMessage(msg);
    } catch {}
    return true;
  }
  onLimited(retryAfterMs) {
    core.onRateLimited(this.backoff, retryAfterMs);
    this.lastError = 'Slack asked us to slow down; checking less often for a while';
    this.log(`slack poll: rate limited, budget ${this.backoff.budget}, interval x${this.backoff.factor}`);
  }
  /** A terminal error stops the loop and keeps the exact Slack error for the
   *  status line; anything else is kept as the last error and retried. */
  fail(error, delivered) {
    this.lastError = error;
    if (core.isTerminalError(error)) {
      this.log(`slack poll: stopped (${error})`);
      this.running = false;
      if (this.timer !== null) {
        this.timers.clearTimeout(this.timer);
        this.timer = null;
      }
      this.nextPollAt = undefined;
    } else {
      this.log(`slack poll: check failed, will retry (${error})`);
    }
    return { ok: false, delivered, error };
  }
  arm(delayMs) {
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.nextPollAt = this.now() + delayMs;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.sweepNow();
    }, delayMs);
  }
  loadState() {
    let raw = null;
    try {
      if (fs.existsSync(this.opts.stateFile)) raw = fs.readFileSync(this.opts.stateFile, 'utf8');
    } catch {
      raw = null;
    }
    this.state = core.loadState(raw, this.opts.channelId, this.now());
    for (const [thread, t] of Object.entries(this.state.threads)) if (t.activatedAt > 0) this.activated.add(thread);
  }
  saveState() {
    try {
      fs.mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      fs.writeFileSync(this.opts.stateFile, core.serializeState(this.state), { mode: 384 });
    } catch (e) {
      this.log(`slack poll: could not save state (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

const BACKOFF_MIN_MS = 2e3;
const BACKOFF_MAX_MS = 6e4;
const LINK_DISABLED_MESSAGE = 'Socket Mode is off in your Slack app';

class SlackSocketClient {
  constructor(opts) {
    this.opts = opts;
    this.api = opts.api ?? slackApiJson;
    this.now = opts.now ?? (() => Date.now());
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms);
        h.unref?.();
        return h;
      },
      clearTimeout: (h) => clearTimeout(h),
    };
    this.log = opts.log ?? (() => {});
    // Lazy global WebSocket (Node 21+) or an injected factory for tests.
    this.wsFactory = opts.wsFactory ?? ((url) => new WebSocket(url));
    this.poller = opts.catchupMs > 0 && !!opts.channelId?.trim() ? new SlackPoller({
      botToken: opts.botToken,
      channelId: opts.channelId,
      intervalMs: opts.catchupMs,
      stateFile: opts.stateFile,
      onMessage: opts.onMessage,
      api: this.api,
      log: this.log,
      now: this.now,
      timers: opts.timers,
    }) : null;
    /** Without a poller the client keeps the webhook's in memory sets. */
    this.ownActivated = new ActivatedThreads();
    this.ownSeen = new SeenEvents();
    this.ws = null;
    /** The old socket during a refresh: closed once the new one says hello. */
    this.retiring = null;
    this.running = false;
    this.connected = false;
    this.connectedAt = undefined;
    this.lastCatchupAt = undefined;
    this.lastError = undefined;
    this.botUserId = null;
    this.team = undefined;
    this.botName = undefined;
    this.backoffMs = BACKOFF_MIN_MS;
    this.reconnectTimer = null;
    this.nextReconnectAt = undefined;
    this.connecting = false;
    /** Bumps on every connect, so a stale socket's close never reconnects over a live one. */
    this.generation = 0;
  }
  get activated() {
    return this.poller ? this.poller.activated : this.ownActivated;
  }
  get seen() {
    return this.poller ? this.poller.seen : this.ownSeen;
  }
  /** auth.test with the bot token, the poller when a sweep is wanted, then
   *  the first socket. Fails closed on a bad token. */
  async start() {
    if (this.running) return { ok: false, error: 'already running' };
    if (!this.opts.appToken) return { ok: false, error: 'missing app token' };
    if (!this.opts.botToken) return { ok: false, error: 'missing bot token' };
    const who = await slackAuthTest(this.opts.botToken, this.api);
    if (!who.ok) {
      this.lastError = who.error;
      return { ok: false, error: who.error };
    }
    this.team = who.team;
    this.botName = who.botName;
    this.botUserId = who.botUserId ?? null;
    if (this.poller) {
      const p = await this.poller.start();
      if (!p.ok) {
        this.lastError = p.error;
        return { ok: false, error: p.error };
      }
    }
    this.running = true;
    this.lastError = undefined;
    this.backoffMs = BACKOFF_MIN_MS;
    const opened = await this.connect();
    if (!opened.ok) {
      this.scheduleReconnect(opened.error ?? 'could not open the socket');
    }
    return { ok: true, team: this.team, botName: this.botName };
  }
  /** Close everything; no reconnect after this. */
  stop() {
    this.running = false;
    this.clearReconnect();
    this.generation += 1;
    this.closeSocket(this.retiring);
    this.retiring = null;
    this.closeSocket(this.ws);
    this.ws = null;
    this.connected = false;
    this.poller?.stop();
  }
  /** Power resume, or the person pressing retry: drop the backoff and open a
   *  new socket now. The old one, if any, is closed; a laptop that slept has
   *  a dead socket that will never say so on its own. */
  reconnectNow() {
    if (!this.running) return;
    this.clearReconnect();
    this.backoffMs = BACKOFF_MIN_MS;
    this.generation += 1;
    this.closeSocket(this.retiring);
    this.retiring = null;
    this.closeSocket(this.ws);
    this.ws = null;
    this.connected = false;
    void this.connect().then((r) => {
      if (!r.ok) this.scheduleReconnect(r.error ?? 'could not open the socket');
    });
  }
  status() {
    return {
      running: this.running,
      connected: this.connected,
      connectedAt: this.connectedAt,
      lastCatchupAt: this.lastCatchupAt,
      lastError: this.lastError,
      hotThreads: this.poller ? this.poller.status().hotThreads : this.activated.size,
      team: this.team,
      botName: this.botName,
      botUserId: this.botUserId ?? undefined,
      nextReconnectAt: this.nextReconnectAt,
    };
  }
  /** Ask Slack for a socket address and open it. `apps.connections.open` is
   *  called every time: the address is one time. */
  async connect() {
    if (this.connecting) return { ok: false, error: 'already connecting' };
    this.connecting = true;
    const gen = ++this.generation;
    try {
      const r = await this.api('apps.connections.open', this.opts.appToken, {});
      if (!this.running || gen !== this.generation) return { ok: false, error: 'superseded' };
      if (!r.ok) return { ok: false, error: r.error ?? 'apps.connections.open failed' };
      const url = (r.json ?? {}).url;
      if (typeof url !== 'string' || !url.startsWith('wss://')) return { ok: false, error: 'no socket address in the answer' };
      let sock;
      try {
        sock = this.wsFactory(url);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      this.attach(sock, gen);
      this.ws = sock;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.connecting = false;
    }
  }
  attach(sock, gen) {
    let gone = false;
    const onGone = (why) => {
      if (gone) return;
      gone = true;
      if (this.retiring === sock) {
        this.retiring = null;
        return;
      }
      if (sock !== this.ws || gen !== this.generation) return;
      this.ws = null;
      this.connected = false;
      if (!this.running) return;
      this.scheduleReconnect(why);
    };
    sock.on('message', (data) => {
      if (sock === this.ws || sock === this.retiring) this.onFrame(sock, data);
    });
    sock.on('close', () => onGone('socket closed'));
    sock.on('error', (e) => {
      const why = e instanceof Error ? e.message : String(e);
      if (sock === this.ws) this.lastError = why;
      onGone(why);
    });
  }
  onFrame(sock, data) {
    const frame = core.parseSocketFrame(data);
    switch (frame.kind) {
      case 'hello': {
        if (sock !== this.ws) return;
        this.connected = true;
        this.connectedAt = this.now();
        this.lastError = undefined;
        this.backoffMs = BACKOFF_MIN_MS;
        this.clearReconnect();
        this.log('socket: connected');
        if (this.retiring) {
          this.closeSocket(this.retiring);
          this.retiring = null;
        }
        if (this.poller) {
          void this.poller.sweepNow().then((r) => {
            if (r.ok) this.lastCatchupAt = this.now();
          });
        }
        return;
      }
      case 'disconnect': {
        const reason = frame.reason ?? 'unknown';
        this.log(`socket: disconnect (${reason})`);
        if (reason === 'link_disabled') {
          this.lastError = LINK_DISABLED_MESSAGE;
          this.stop();
          return;
        }
        if (sock !== this.ws) return;
        this.retiring = sock;
        this.ws = null;
        void this.connect().then((r) => {
          if (r.ok) return;
          this.ws = this.retiring;
          this.retiring = null;
          this.lastError = r.error;
        });
        return;
      }
      case 'event': {
        try {
          sock.send(JSON.stringify({ envelope_id: frame.envelopeId }));
        } catch {}
        if (!this.botUserId) {
          const id = frame.authorizations?.[0]?.user_id;
          if (id) this.botUserId = id;
        }
        if (frame.event) this.deliver(frame.event);
        return;
      }
      case 'other': {
        if (frame.envelopeId) {
          try {
            sock.send(JSON.stringify({ envelope_id: frame.envelopeId }));
          } catch {}
        }
        return;
      }
      default:
        return;
    }
  }
  /** The webhook's gate, verbatim: trigger rules, non empty, dedup, same shape. */
  deliver(ev) {
    const { trigger: fire, text: rawText, files } = shouldTrigger(ev, this.botUserId, this.opts.channelId || undefined, this.activated);
    if (!fire) return;
    const text = stripLeadingMention(rawText);
    const channel = typeof ev.channel === 'string' ? ev.channel : '';
    const ts = typeof ev.ts === 'string' ? ev.ts : '';
    const thread_ts = typeof ev.thread_ts === 'string' && ev.thread_ts || ts;
    if (!(text || files.length > 0) || !channel || !ts) return;
    const key = dedupKey(ev);
    if (key && this.seen.seen(key)) return;
    const mentioned = core.mentionsBot(ev, this.botUserId);
    this.poller?.noteDelivered({ channel, ts, thread_ts, mentioned });
    const msg = { text, channel, ts, thread_ts };
    if (files.length > 0) msg._rawFiles = files;
    try {
      void this.opts.onMessage(msg);
    } catch {}
  }
  scheduleReconnect(why) {
    if (!this.running || this.reconnectTimer !== null) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    this.nextReconnectAt = this.now() + delay;
    this.log(`socket: reconnect in ${Math.round(delay / 1e3)} s (${why})`);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.nextReconnectAt = undefined;
      if (!this.running) return;
      void this.connect().then((r) => {
        if (!r.ok) this.scheduleReconnect(r.error ?? 'could not open the socket');
      });
    }, delay);
  }
  clearReconnect() {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.nextReconnectAt = undefined;
  }
  closeSocket(sock) {
    if (!sock) return;
    try {
      sock.close();
    } catch {}
  }
}

module.exports = {
  SlackBridge, slackApi, looksLikeWork,
  buildAutonomousRequestProtocol, downloadSlackFiles, downloadSlackFile,
  sanitizeSlackFilename, slackFilesDir, SLACK_FILE_MAX_BYTES,
  // verbatim transports
  SlackPoller, SlackSocketClient,
  slackApiJson, slackAuthTest, slackListChannels, slackConnectionsOpenTest,
};
