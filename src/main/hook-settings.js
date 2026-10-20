'use strict';
/**
 * hookSettings — the per-session .claude/settings.json the harness writes for
 * every hive-aware spawn, verbatim port of the reference. The settings file is
 * per agent dir, so a person's own `claude` outside the app keeps its theme,
 * output style and MCP servers untouched. Deps carry the launcher pieces so
 * the module stays headless: `launcher` is a NodeLauncher-shaped object
 * ({nodeRun,nodeRunSh}) and `mcpCatalog` defaults to the ported catalog.
 */
const { normalizeClaudeOutputStyle } = require('./memory-rules');
const { MCP_CATALOG } = require('./mcp-catalog');

function sandboxWritableDirs(meta, dir, root, extra) {
  const out = [meta.cwd, dir, root, ...extra ?? []].filter((d) => typeof d === "string" && d.length > 0);
  return Array.from(new Set(out));
}

/**
 * W3 — build the per-agent `mcpServers` map from the default catalog. Includes a
 * server only when it's enabled (catalog ∩ consent), scopes filesystem/git to the
 * agent cwd (never whole-disk), and namespaces every id `ozycomp-<id>` so a server
 * of the same name in the user's own ~/.claude is never clobbered. A write/secret
 * server is included ONLY on an explicit `enabled:true` consent — never via a
 * default — so a malformed/partial config can't silently arm a keyed server.
 *
 * The ported catalog keeps `command`/`args(ctx)`/`env(secrets)` at the top level
 * (not reference's `spec`), so entries are normalised here: `e.spec ?? e`, args
 * resolved as a function of cwd or with "<cwd>" placeholders, env resolved as a
 * function when callable.
 */
function buildDefaultMcpServers(cwd, cfg, catalog = MCP_CATALOG) {
  const out = {};
  for (const e of catalog) {
    const consented = cfg?.[e.id]?.enabled;
    const enabled = consented ?? e.defaultEnabled;
    if (!enabled) continue;
    if (e.tier !== "safe-readonly" && consented !== true) continue;
    const spec = e.spec ?? e;
    const args = (typeof spec.args === "function" ? spec.args({ cwd }) : spec.args ?? [])
      .map((a) => a === "<cwd>" ? cwd : a);
    const env = typeof spec.env === "function" ? spec.env({}) : spec.env;
    out[`ozycomp-${e.id}`] = {
      command: spec.command,
      args,
      ...env ? { env } : {}
    };
  }
  return out;
}

function hookSettings(launcher, shim, cwd, cfg, theme, writableDirs = [], outputStyle, httpHook, catalog = MCP_CATALOG) {
  const cmd = process.platform === "win32" ? launcher.nodeRunSh(shim) : launcher.nodeRun(shim);
  const entry = (matcher, commandOnly = false) => ({
    ...matcher ? { matcher } : {},
    hooks: [httpHook && !commandOnly ? httpHook : { type: "command", command: cmd }]
  });
  const mcpServers = buildDefaultMcpServers(cwd, cfg, catalog);
  return {
    // Match the TUI's truecolor palette to the harness terminal theme —
    // PER SESSION, so the user's global Claude theme (their own terminals
    // outside the app) is never touched.
    //
    // 'auto', not the literal light/dark. Pinning the value matched the theme at
    // SPAWN and then ignored every change: Claude Code supports DEC 2031 theme
    // notifications, but a pinned theme has nothing to reconsider, so flipping
    // the app left a running agent painting its message blocks in the old
    // palette (black highlight on a cream terminal). 'auto' is the value that
    // listens. The terminal reports the current theme the moment the CLI enables
    // 2031, so startup still matches without pinning anything.
    ...theme ? { theme: "auto" } : {},
    // 0.5.3 feature 19: Claude Code's own output style, Concise unless the user
    // chose another (shared/outputStyle.ts). Per session settings only, so a
    // person's own `claude` outside the app keeps whatever style they set.
    outputStyle: normalizeClaudeOutputStyle(outputStyle),
    // W3 — default skills/MCP bundle. Written into the PER-SESSION settings file
    // only (never ~/.claude), so the user's own MCP servers are never clobbered;
    // Claude merges this additively. Omitted entirely when empty so a settings
    // file with no enabled servers is unchanged from before.
    ...Object.keys(mcpServers).length ? { mcpServers } : {},
    // The status line gets the session status JSON after every response —
    // including context_window.{total_input_tokens,context_window_size},
    // the only clean programmatic source for the session's REAL context
    // window. The shim prints a compact in-terminal gauge and forwards the
    // payload to the harness (agent-card context gauge, exact limit).
    statusLine: { type: "command", command: `${cmd} --status`, padding: 0 },
    // Native OS sandbox for Bash subprocesses (macOS Seatbelt / Linux bubblewrap).
    // Auto mode spawns with `--permission-mode bypassPermissions`, which only
    // silences PROMPTS; the sandbox is a separate, opt-in layer that was never
    // switched on. Verified live (claude 2.1.239): with this block, bypass mode
    // still writes cwd and the listed dirs but `touch $HOME/x` fails with
    // "Operation not permitted". Two layers are needed: `sandbox.filesystem`
    // governs Bash children, `permissions.additionalDirectories` governs the
    // Edit/Write tools; with only one the agent deadlocks on its own inbox.
    // failIfUnavailable stays false: a platform without a sandbox (Windows)
    // runs as before rather than refusing to spawn.
    ...writableDirs.length ? {
      sandbox: { enabled: true, filesystem: { allowWrite: writableDirs } },
      permissions: { additionalDirectories: writableDirs }
    } : {},
    hooks: {
      Stop: [entry()],
      SubagentStop: [entry()],
      PreToolUse: [entry("*")],
      PostToolUse: [entry("*")],
      UserPromptSubmit: [entry()],
      Notification: [entry()],
      SessionStart: [entry(void 0, true)],
      // #5C: surface mid-`/compact` so an agent boxing up its context reads as
      // 'compacting' on the floor instead of looking frozen.
      PreCompact: [entry()],
      PostCompact: [entry()]
    }
  };
}

/**
 * W3 — refresh an agent's bundled skills from the app-resources `skills/` dir.
 * Mirrors `identity.md`: overwritten every spawn so the shipped safe set tracks
 * the app. Best-effort and fully tolerant — a missing/empty source dir is a no-op
 * (Kevin populates the resource dir in lp-manifest), and any IO error is swallowed
 * so skill provisioning can never block a spawn.
 */
function copyBundledSkills(fs, path, srcDir, destDir) {
  try {
    if (!fs.existsSync(srcDir)) return;
    const copyTree = (from, to) => {
      const entries = fs.readdirSync(from, { withFileTypes: true });
      if (!entries.length) return;
      fs.mkdirSync(to, { recursive: true });
      for (const ent of entries) {
        const s = path.join(from, ent.name);
        const d = path.join(to, ent.name);
        if (ent.isDirectory()) copyTree(s, d);
        else if (ent.isFile()) fs.copyFileSync(s, d);
      }
    };
    copyTree(srcDir, destDir);
  } catch (e) {
    console.error("[hive] copyBundledSkills failed:", e);
  }
}

module.exports = { sandboxWritableDirs, buildDefaultMcpServers, hookSettings, copyBundledSkills };
