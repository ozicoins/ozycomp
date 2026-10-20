'use strict';
/**
 * MCP catalog — the curated list of Model Context Protocol servers a user can
 * attach to agents from Settings. Two tiers:
 *
 *   safe-readonly  no secrets needed; can be offered/enabled unconditionally
 *   secret         needs an API key/token from the secrets store before the
 *                  server is launched
 *
 * Each entry: {id, label, tier, command, args(ctx), env(secrets), hint}.
 * args(ctx) may embed the agent's working directory (ctx.cwd).
 * This mirrors the reference harness's ten-entry catalog verbatim.
 */
const MCP_CATALOG = [
  // ── safe-readonly tier ──────────────────────────────────────────────────
  {
    id: 'sequential-thinking', label: 'Sequential Thinking', tier: 'safe-readonly', defaultEnabled: true,
    command: 'npx', args: () => ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    hint: 'step-by-step reasoning scratchpad',
  },
  {
    id: 'time', label: 'Time', tier: 'safe-readonly', defaultEnabled: true,
    command: 'uvx', args: () => ['mcp-server-time'],
    hint: 'current time / timezone conversions',
  },
  {
    id: 'fetch', label: 'Fetch', tier: 'safe-readonly', defaultEnabled: true,
    command: 'uvx', args: () => ['mcp-server-fetch'],
    hint: 'read a URL as markdown',
  },
  {
    id: 'context7', label: 'Context7', tier: 'safe-readonly', defaultEnabled: true,
    command: 'npx', args: () => ['-y', '@upstash/context7-mcp'],
    hint: 'up-to-date library docs',
  },
  {
    id: 'filesystem', label: 'Filesystem', tier: 'safe-readonly', defaultEnabled: true,
    command: 'npx', args: ctx => ['-y', '@modelcontextprotocol/server-filesystem', ctx?.cwd ?? '.'],
    hint: 'read-only file access inside the workspace',
  },
  {
    id: 'git', label: 'Git', tier: 'safe-readonly', defaultEnabled: true,
    command: 'uvx', args: ctx => ['mcp-server-git', '--repository', ctx?.cwd ?? '.'],
    hint: 'repo status/log/diff tools',
  },
  // ── secret tier (needs a key from the secrets store) ────────────────────
  {
    id: 'github-token', label: 'GitHub', tier: 'secret', defaultEnabled: false,
    command: 'npx', args: () => ['-y', '@modelcontextprotocol/server-github'],
    env: s => ({ GITHUB_PERSONAL_ACCESS_TOKEN: s.GITHUB_PERSONAL_ACCESS_TOKEN }),
    secretKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    hint: 'issues, PRs, code search (token)',
  },
  {
    id: 'db', label: 'Postgres', tier: 'secret', defaultEnabled: false,
    command: 'npx', args: () => ['-y', '@modelcontextprotocol/server-postgres'],
    env: s => ({ DATABASE_URL: s.DATABASE_URL }),
    secretKeys: ['DATABASE_URL'],
    hint: 'query a database (connection string)',
  },
  {
    id: 'email-calendar', label: 'G Suite', tier: 'secret', defaultEnabled: false,
    command: 'npx', args: () => ['-y', '@modelcontextprotocol/server-gsuite'],
    env: s => ({ GOOGLE_OAUTH_TOKEN: s.GOOGLE_OAUTH_TOKEN }),
    secretKeys: ['GOOGLE_OAUTH_TOKEN'],
    hint: 'mail + calendar (OAuth token)',
  },
  {
    id: 'search-with-key', label: 'Brave Search', tier: 'secret', defaultEnabled: false,
    command: 'npx', args: () => ['-y', '@modelcontextprotocol/server-brave-search'],
    env: s => ({ BRAVE_API_KEY: s.BRAVE_API_KEY }),
    secretKeys: ['BRAVE_API_KEY'],
    hint: 'web search (API key)',
  },
];

const byId = id => MCP_CATALOG.find(m => m.id === id) ?? null;

/** Resolve an entry to a concrete launch spec for spawn-time injection. */
function resolveMcp(id, { cwd, secrets = {} } = {}) {
  const m = byId(id);
  if (!m) return null;
  if (m.tier === 'secret') {
    const missing = (m.secretKeys ?? []).filter(k => !secrets[k]);
    if (missing.length) return { error: `missing-secrets:${missing.join(',')}` };
  }
  return {
    id: m.id,
    command: m.command,
    args: typeof m.args === 'function' ? m.args({ cwd }) : m.args,
    env: typeof m.env === 'function' ? m.env(secrets) : {},
  };
}

/** Catalog view for the renderer (no secret values, just which keys it wants). */
function catalogForUi() {
  return MCP_CATALOG.map(m => ({
    id: m.id, label: m.label, tier: m.tier, hint: m.hint,
    secretKeys: m.secretKeys ?? [],
  }));
}

module.exports = { MCP_CATALOG, resolveMcp, catalogForUi };
