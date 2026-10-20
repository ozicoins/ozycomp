#!/usr/bin/env node
'use strict';
/**
 * hook-shim — generic event reporter for non-Claude providers. Where Claude
 * Code has native hooks wired through .claude/settings.local.json, other CLIs
 * (codex, gemini, grok, opencode, pi, agy…) get a shim placed on their PATH
 * or referenced by their own hook/config mechanism. Whatever the transport,
 * the payload contract is identical:
 *
 *   stdin (or argv[2]) ← JSON {agentId?, hook, payload}
 *   → POST to OZYC_HOOK_SOCK (UDS) or OZYC_HOOK_URL (Bearer token)
 *   → always exit 0 — hook transport must never break the agent
 *
 * Subcommands for shims that can't pipe stdin:
 *   hook-shim.cjs tool <name> [ok]        → PostToolUse {tool_name, ok}
 *   hook-shim.cjs session                 → SessionStart
 *   hook-shim.cjs stop [questionId]       → Stop
 *   hook-shim.cjs notify <text>           → Notification {text}
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const shim = process.env.OZYC_HOOK_SHIM ?? '';

function payloadFromArgv(argv) {
  const [sub, a, b] = argv;
  switch (sub) {
    case 'tool':    return { hook: 'PostToolUse', payload: { tool_name: a ?? 'unknown', ok: b !== 'false' } };
    case 'session': return { hook: 'SessionStart', payload: {} };
    case 'stop':    return { hook: 'Stop', payload: a ? { questionId: a } : {} };
    case 'notify':  return { hook: 'Notification', payload: { text: a ?? '' } };
    default:        return null;
  }
}

function post(msg) {
  const body = JSON.stringify({ agentId: process.env.OZYC_AGENT_ID ?? msg.agentId ?? 'unknown', ...msg });
  const done = () => process.exit(0);
  const deadline = setTimeout(done, 2000);
  deadline.unref?.();

  const sock = process.env.OZYC_HOOK_SOCK;
  const url = process.env.OZYC_HOOK_URL;
  if (sock && fs.existsSync(sock)) {
    const c = net.createConnection(sock, () => { c.end(body); });
    c.on('error', done);
    c.on('close', done);
    return;
  }
  if (url) {
    try {
      const u = new URL(url);
      const req = http.request({
        hostname: u.hostname, port: u.port, path: '/hook', method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${process.env.OZYC_HOOK_TOKEN ?? ''}`,
          'content-length': Buffer.byteLength(body),
        },
      }, res => res.on('end', done).resume());
      req.on('error', done);
      req.end(body);
      return;
    } catch {}
  }
  done();
}

const fromArgv = payloadFromArgv(process.argv.slice(2));
if (fromArgv) {
  post(fromArgv);
} else {
  let buf = '';
  process.stdin.on('data', d => { buf += d; });
  process.stdin.on('end', () => {
    try { post(JSON.parse(buf)); } catch { process.exit(0); }
  });
  if (process.stdin.isTTY) process.exit(0);
}
