#!/usr/bin/env node
'use strict';
/**
 * ozy-hook — legacy hook client kept for the hint-file path. Reads the
 * hook payload JSON on stdin, normalizes it onto the provider-shaped contract
 * ({hook_event_name, agent_id, …}) and forwards over the Unix socket
 * (HIVE_SOCK, falling back to loopback HTTP). Always exits 0: fail-open.
 *
 *   usage: ozy-hook <HookEventName>
 */
const net = require('node:net');
const http = require('node:http');

const hook = process.argv[2] ?? 'Unknown';
const agentId = process.env.AGENT_ID ?? process.env.OZYC_AGENT_ID ?? null;

let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(input || '{}'); } catch {}
  payload.hook_event_name = payload.hook_event_name ?? hook;
  if (!payload.agent_id) payload.agent_id = agentId;
  const body = JSON.stringify(payload) + '\n';
  const done = () => process.exit(0);
  setTimeout(done, 2000).unref();

  const sock = process.env.HIVE_SOCK ?? process.env.OZYC_HOOK_SOCK;
  if (sock) {
    const c = net.createConnection(sock, () => c.end(body));
    c.on('data', () => {});
    c.on('close', done);
    c.on('error', () => viaHttp(body, done));
  } else viaHttp(body, done);
});

function viaHttp(body, done) {
  const url = process.env.OZYC_HOOK_URL;
  if (!url) return done();
  const req = http.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OZYC_HOOK_TOKEN ?? ''}` },
  }, res => { res.resume(); res.on('end', done); });
  req.on('error', done);
  req.end(body);
}
