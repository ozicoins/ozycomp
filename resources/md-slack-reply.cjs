#!/usr/bin/env node
'use strict';
/**
 * md-slack-reply.cjs — the helper an agent terminal calls to post a reply into
 * a Slack thread. Companion to the harness's loopback SlackReplyServer: it
 * reads {port, token} from the file named by MD_SLACK_REPLY_CONFIG and POSTs
 * {channel, thread_ts, text} to http://127.0.0.1:<port>/reply with the token
 * in x-md-reply-token. The main process holds the bot token; this script never
 * sees it — which is why a reply works from inside a sandboxed temp shell.
 *
 * Usage:
 *   node md-slack-reply.cjs --channel C0123 --thread 1700000000.000100 --text "hello"
 *   echo "hello" | node md-slack-reply.cjs --channel C0123 --thread 1700000000.000100
 *
 * Exit 0 on a delivered reply; non-zero (with the error on stderr) otherwise.
 */
const http = require('node:http');
const fs = require('node:fs');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function fail(msg, code = 1) {
  console.error(`[md-slack-reply] ${msg}`);
  process.exit(code);
}

const channel = arg('channel');
const thread_ts = arg('thread') ?? arg('thread_ts');
let text = arg('text');

if (!channel || !thread_ts) fail('usage: md-slack-reply --channel C --thread TS --text "msg" (or pipe text on stdin)');

const cfgPath = process.env.MD_SLACK_REPLY_CONFIG;
if (!cfgPath) fail('MD_SLACK_REPLY_CONFIG is not set — this shell was not spawned by the harness', 2);

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
} catch (e) {
  fail(`could not read ${cfgPath}: ${e.message}`, 2);
}
if (!cfg || typeof cfg.port !== 'number' || typeof cfg.token !== 'string') {
  fail(`${cfgPath} does not hold {port, token} — the reply endpoint is not running`, 2);
}

const post = (body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const req = http.request({
    hostname: '127.0.0.1', port: cfg.port, path: '/reply', method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
      'x-md-reply-token': cfg.token,
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      resolve({ status: res.statusCode ?? 0, json });
    });
  });
  req.on('error', reject);
  req.setTimeout(15_000, () => req.destroy(new Error('timed out')));
  req.write(data);
  req.end();
});

const send = async (payload) => {
  const r = await post(payload);
  if (r.status === 200 && r.json?.ok === true) return;
  fail(`reply not delivered (http ${r.status}${r.json?.error ? `, ${r.json.error}` : ''})`, 3);
};

(async () => {
  if (text === undefined) {
    // stdin mode: read the whole pipe as the reply text.
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    text = Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString('utf8');
  }
  if (!text || !text.trim()) fail('empty reply text');
  await send({ channel, thread_ts, text });
})().catch((e) => fail(e instanceof Error ? e.message : String(e)));
