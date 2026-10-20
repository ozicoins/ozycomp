'use strict';
/**
 * hive-bridge — Pi coding-agent extension. Pi loads per-agent extensions from
 * $PI_CODING_AGENT_DIR/extensions/; this one posts hive-shaped payloads over
 * HIVE_SOCK on tool_call/tool_result/agent_end and auto-approves tool calls
 * when the harness runs the agent in auto mode (HIVE_AUTO_APPROVE=1).
 */
var net = require('node:net');
var SOCK = process.env.HIVE_SOCK;
var AGENT = process.env.AGENT_ID || null;
var AUTO = process.env.HIVE_AUTO_APPROVE === '1';
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    var c = net.createConnection(SOCK, function () { try { c.end(JSON.stringify(payload) + '\n'); } catch (e) {} });
    c.on('error', function () {});
  } catch (e) {}
}
function firstDefined(primary, fallback) {
  return primary !== undefined && primary !== null ? primary : fallback;
}
function piField(ev, key) {
  try { return ev == null ? undefined : ev[key]; } catch (e) { return undefined; }
}
function piToolName(ev) {
  var tool = piField(ev, 'tool');
  return firstDefined(piField(ev, 'toolName'), firstDefined(piField(ev, 'name'), piField(tool, 'name')));
}
function piToolInput(ev) {
  return firstDefined(piField(ev, 'input'), piField(ev, 'args'));
}
function piToolPayload(hookEventName, ev) {
  return {
    hook_event_name: hookEventName,
    tool_name: piToolName(ev),
    tool_input: piToolInput(ev)
  };
}
function register(pi) {
  if (!pi || typeof pi.on !== 'function') return false;
  try {
    pi.on('tool_call', function (ev) {
      post(piToolPayload('PreToolUse', ev));
      if (AUTO) { try { if (ev && typeof ev.approve === 'function') ev.approve(); } catch (e) {} return { approve: true }; }
      return undefined;
    });
    pi.on('tool_result', function (ev) { post(piToolPayload('PostToolUse', ev)); });
    pi.on('agent_end', function () { post({ hook_event_name: 'Stop' }); });
    return true;
  } catch (e) { return false; }
}
try { if (typeof globalThis !== 'undefined' && globalThis.pi) register(globalThis.pi); } catch (e) {}
module.exports = function (pi) { return register(pi); };
module.exports.activate = function (pi) { return register(pi); };
module.exports.default = module.exports;
