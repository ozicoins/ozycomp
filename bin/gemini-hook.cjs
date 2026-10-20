#!/usr/bin/env node
'use strict';
/**
 * gemini-hook — Gemini CLI lifecycle bridge. Gemini's hook payload is already
 * snake_case; we map its event names into the hive vocabulary (BeforeAgent →
 * UserPromptSubmit, AfterAgent → Stop…) and translate the harness reply back
 * to Gemini's decision contract. Scoped by AGENT_ID: non-hive sessions exit.
 */
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let gemini = {};
  try { gemini = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    SessionStart: 'SessionStart',
    BeforeAgent: 'UserPromptSubmit',
    BeforeTool: 'PreToolUse',
    AfterTool: 'PostToolUse',
    AfterAgent: 'Stop'
  };
  const payload = {
    ...gemini,
    hook_event_name: names[gemini.hook_event_name] || gemini.hook_event_name || 'Unknown',
    agent_id: agentId
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'deny', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = { hookSpecificOutput: { additionalContext: r.hookSpecificOutput.additionalContext } };
      }
    } catch (_) {}
    if (out) { try { process.stdout.write(JSON.stringify(out)); } catch (_) {} }
    process.exit(0);
  };
  try {
    const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\n'));
    c.setEncoding('utf8');
    c.on('data', (d) => { resp += d; });
    c.on('end', done);
    c.on('error', () => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  } catch (_) { process.exit(0); }
});
