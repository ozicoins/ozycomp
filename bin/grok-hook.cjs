#!/usr/bin/env node
'use strict';
/**
 * grok-hook — Grok lifecycle bridge. Grok speaks the same hook events and
 * decision vocabulary as Claude Code but its stdin payload uses camelCase —
 * this adapter normalizes the keys to the hive contract and forwards over
 * HIVE_SOCK. Scoped by AGENT_ID so ordinary Grok sessions exit untouched.
 */
const net = require('net');
const agentId = process.env.AGENT_ID || null;
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const sock = process.env.HIVE_SOCK;
  if (!agentId || !sock) { process.exit(0); }
  let grok = {};
  try { grok = JSON.parse(data || '{}'); } catch (_) {}
  const names = {
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    post_tool_use_failure: 'PostToolUseFailure',
    permission_denied: 'PermissionDenied',
    stop: 'Stop',
    stop_failure: 'StopFailure',
    session_start: 'SessionStart',
    session_end: 'SessionEnd',
    user_prompt_submit: 'UserPromptSubmit',
    notification: 'Notification',
    subagent_start: 'SubagentStart',
    subagent_stop: 'SubagentStop',
    pre_compact: 'PreCompact',
    post_compact: 'PostCompact'
  };
  const payload = {
    hook_event_name: names[grok.hookEventName] || grok.hookEventName || 'Unknown',
    agent_id: agentId,
    session_id: grok.sessionId,
    cwd: grok.cwd || grok.workspaceRoot,
    tool_name: grok.toolName,
    tool_input: grok.toolInput,
    stop_hook_active: grok.stopHookActive,
    prompt: grok.prompt,
    source: grok.source,
    notification_type: grok.notificationType,
    message: grok.message
  };
  let resp = '';
  const done = () => {
    let out = null;
    try {
      const r = JSON.parse(resp || '{}');
      if (r.continue === false) out = { continue: false, stopReason: r.stopReason };
      else if (r.decision === 'block') out = { decision: 'block', reason: r.reason };
      else if (r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny') {
        out = { decision: 'deny', reason: r.hookSpecificOutput.permissionDecisionReason };
      } else if (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) {
        out = r;
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
