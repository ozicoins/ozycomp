/**
 * hive-bridge — OpenCode plugin. OpenCode auto-loads *.js plugins from the
 * config dir's plugin/ folder; this one posts hive-shaped payloads over
 * HIVE_SOCK on tool.execute.before/after and maps `session.idle` to Stop —
 * the same Stop→drain semantics as the hook shims, no traffic interception.
 */
import { createConnection } from 'node:net';
const SOCK = process.env.HIVE_SOCK;
const AGENT = process.env.AGENT_ID || null;
function post(payload) {
  try {
    if (!SOCK) return;
    payload.agent_id = payload.agent_id || AGENT;
    const c = createConnection(SOCK, () => { try { c.end(JSON.stringify(payload) + '\n'); } catch (e) {} });
    c.on('error', () => {});
  } catch (e) {}
}
export const HiveBridge = async () => {
  return {
    event: async (input) => {
      try { if (input && input.event && input.event.type === 'session.idle') post({ hook_event_name: 'Stop' }); } catch (e) {}
    },
    'tool.execute.before': async (input) => {
      try { post({ hook_event_name: 'PreToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    },
    'tool.execute.after': async (input) => {
      try { post({ hook_event_name: 'PostToolUse', tool_name: input && (input.tool || input.name) }); } catch (e) {}
    }
  };
};
export default HiveBridge;
