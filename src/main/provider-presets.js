'use strict';
/**
 * Agent provider presets — verbatim port of the reference's routing-relevant
 * surface. Each preset says how the floor treats a CLI: whether it is
 * hive-aware (Claude-style --append-system-prompt/--settings), whether its
 * inbox drains natively, which hook bridge carries its lifecycle events, and
 * whether a proxy bridge hands its mail off in the terminal. The full spawn
 * flag catalogue stays in the reference; this port keeps the fields the
 * router and spawn paths read.
 */
const AGENT_PROVIDER_PRESETS = [
  {
    id: "claude",
    label: "Claude Code",
    defaultCommand: "claude",
    autoModeFlag: "--permission-mode bypassPermissions",
    autoFlag: "--permission-mode bypassPermissions",
    supportsModel: true,
    modelFlag: "--model",
    hiveAware: true,
    canReceiveInbox: true
  },
  {
    id: "codex",
    label: "Codex · GPT",
    defaultCommand: "codex",
    // Auto mode: never prompt (-a never) but KEEP codex's OS sandbox, scoped to the
    // workspace (-s workspace-write). The app used to spawn with
    // `--dangerously-bypass-approvals-and-sandbox` for one reason only: a hive
    // worker must write to its agent folder at <harnessHome>/hive/agents/<id>/,
    // a different path tree from cwd, which workspace-write blocked. That is a
    // path-layout problem, not a reason to drop the sandbox: the hive spawn path
    // (hive.ts, which knows the agent dir) writes those dirs into the agent's own
    // config.toml as `sandbox_workspace_write.writable_roots`, the config twin
    // of `--add-dir`, which Codex rejects outside a writable sandbox (#625).
    // So: approvals off, sandbox on, hive housekeeping still works.
    autoModeFlag: "-a never -s workspace-write",
    autoFlag: "-a never -s workspace-write",
    // Any of these on a command line means the user already chose a posture
    // (including the old full bypass) — do not stack ours on top.
    autoStanceTokens: ["-a", "--ask-for-approval", "-s", "--sandbox", "--full-auto", "--dangerously-bypass-approvals-and-sandbox"],
    // Suppresses first-run interactive prompts (directory-trust gate, installer).
    nonInteractiveEnv: { CODEX_NON_INTERACTIVE: "1" },
    supportsModel: true,
    modelFlag: "--model",
    // Codex is NOT hiveAware in the Claude-flag sense: it has no
    // `--append-system-prompt`/`--settings`. The hive protocol is injected as
    // Codex's INITIAL prompt, which it takes POSITIONALLY (`codex "<prompt>"`) —
    // hence initialPromptFlag is undefined and hive.ts appends it as a trailing arg.
    hiveAware: false,
    // …but Codex DOES expose a Claude-style hooks system (hooks.json / config.toml
    // [hooks]; PreToolUse/PostToolUse/Stop/…), so it gets full hive parity via the
    // 'codex' bridge: a per-agent CODEX_HOME/hooks.json wired to the cth-hook shim
    // (see hive.installCodexHooks). Stop→drain works natively (Codex's Stop honors
    // {decision:'block',reason} = continue-with-prompt, exactly like Claude).
    hookBridge: "codex",
    // Inbox drains via the codex-hook bridge's Stop→drain (the renderer's idle
    // inbox-wake nudge remains as a harmless fallback for an idle worker).
    canReceiveInbox: true,
    initialPromptFlag: void 0,
    positionalInitialPrompt: true,
    // `model/list` under a ChatGPT login reports this as Codex's default
    // (verified 2026-08-25, #330). gpt-5-codex made a Codex god fail its first
    // message there. gpt-6-astra leads the picker but needs codex 0.153.1 or
    // later, so an older CLI would reject it. Must stay an id in the codex list
    // of modelCatalog.json (provider-config.test.cjs checks it).
    recommendedOrchestratorModel: "gpt-5.6-sol",
    // Codex resumes via a SUBCOMMAND, not a flag: `codex resume [OPTIONS]
    // [SESSION_ID]`. A `--resume <id>` flag does not exist, which is why restarts
    // used to silently start a brand-new session instead of continuing.
    resumeFlag: void 0,
    resumeSubcommand: "resume",
    // Official OpenAI Codex CLI install (npm global). Used by the missing-CLI auto-install.
    installCommand: "npm install -g @openai/codex",
    docsUrl: "https://github.com/openai/codex"
  },
  {
    id: "grok",
    label: "Grok · xAI",
    defaultCommand: "grok",
    // Grok documents bypassPermissions as the CLI/config spelling of its
    // always-approve mode. Deny rules and lifecycle gates still take precedence.
    autoModeFlag: "--permission-mode bypassPermissions",
    autoFlag: "--permission-mode bypassPermissions",
    supportsModel: true,
    modelFlag: "--model",
    hiveAware: false,
    // Grok supports Claude-compatible lifecycle events but sends camelCase
    // payloads. The bridge normalizes them before forwarding to HookServer.
    hookBridge: "grok",
    canReceiveInbox: true,
    // `grok [PROMPT]` accepts the initial hive protocol as a positional prompt.
    positionalInitialPrompt: true,
    // Grok resumes interactively with `grok --resume <session-id-or-title>`.
    resumeFlag: "--resume",
    // xAI's own installer, a standalone binary under ~/.grok/bin, no Node (I2,
    // 23 Sep): the URLs the grok binary itself prints for an update, both
    // answering 200 on 23 Sep 2026. No npm package exists, so the native rung
    // is the only rung. Trusted, hardcoded, no double quotes (win32 is wrapped
    // verbatim in `cmd /d /s /c "…"`, hence `^|`).
    nativeInstallCommand: {
      posix: "curl -fsSL https://x.ai/cli/install.sh | bash",
      win32: "powershell -c irm https://x.ai/cli/install.ps1 ^| iex"
    },
    docsUrl: "https://x.ai/cli"
  },
  {
    id: "kimi",
    label: "Kimi Code",
    defaultCommand: "kimi",
    hiveAware: false,
    canReceiveInbox: false
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    defaultCommand: "gemini",
    hiveAware: false,
    canReceiveInbox: true
  },
  {
    id: "antigravity",
    label: "Antigravity · Gemini",
    defaultCommand: "agy",
    hiveAware: false,
    hookBridge: "agy",
    canReceiveInbox: true
  },
  {
    id: "qwen",
    label: "Qwen (local available)",
    defaultCommand: "qwen",
    hiveAware: false,
    // ('serve' inboxDelivery is reserved for a later qwen-serve HTTP push path).
    bridge: { kind: "proxy", api: "openai", baseUrlEnv: "OPENAI_BASE_URL", inboxDelivery: "terminal" },
    canReceiveInbox: true
  },
  {
    id: "opencode",
    label: "OpenCode",
    defaultCommand: "opencode",
    hiveAware: false,
    canReceiveInbox: true
  },
  {
    id: "crush",
    label: "Crush · Charm",
    defaultCommand: "crush",
    hiveAware: false,
    bridge: { kind: "proxy", api: "openai", baseUrlEnv: "CRUSH_PROXY_BASE_URL", inboxDelivery: "terminal" },
    canReceiveInbox: true
  },
  {
    id: "pi",
    label: "Pi",
    defaultCommand: "pi",
    // first, so a hookBridge:'pi' would be dead weight + force a second union widening.
    hiveAware: false,
    canReceiveInbox: true
  },
  {
    id: "copilot",
    label: "Copilot",
    defaultCommand: "copilot",
    hiveAware: false,
    canReceiveInbox: false
  },
  {
    id: "cursor",
    label: "Cursor",
    defaultCommand: "cursor-agent",
    hiveAware: false,
    canReceiveInbox: true
  },
  {
    id: "custom",
    label: "Custom",
    defaultCommand: "",
    hiveAware: false,
    canReceiveInbox: false
  }
];
const AGENT_PROVIDER_IDS = AGENT_PROVIDER_PRESETS.map((p) => p.id);
function isAgentProvider(value) {
  return typeof value === "string" && AGENT_PROVIDER_IDS.includes(value);
}
function normalizeAgentProvider(value) {
  return isAgentProvider(value) ? value : void 0;
}
function providerPreset(provider) {
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider) ?? AGENT_PROVIDER_PRESETS[0];
}
function isClaudeProvider(provider) {
  return provider === "claude";
}
function isHiveAwareProvider(provider) {
  return providerPreset(provider ?? "claude").hiveAware;
}
function canReceiveInbox(provider) {
  return providerPreset(provider ?? "claude").canReceiveInbox;
}
function commandBinary(command) {
  const first = (command ?? "").trim().split(/\s+/)[0] ?? "";
  const leaf = first.split(/[\\/]/).pop() ?? first;
  return leaf.replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
}
function inferAgentProvider(command, explicit) {
  const normalized = normalizeAgentProvider(explicit);
  if (normalized) return normalized;
  const bin = commandBinary(command);
  if (bin === "codex") return "codex";
  if (bin === "grok") return "grok";
  if (bin === "kimi") return "kimi";
  if (bin === "gemini") return "gemini";
  if (bin === "agy" || bin === "antigravity") return "antigravity";
  if (bin === "qwen") return "qwen";
  if (bin === "opencode") return "opencode";
  if (bin === "crush") return "crush";
  if (bin === "pi") return "pi";
  if (bin === "copilot") return "copilot";
  if (bin === "cursor-agent") return "cursor";
  if (bin === "agent") return "cursor";
  if (bin === "claude" || !bin) return "claude";
  return "custom";
}
function bridgeOf(provider) {
  const preset = providerPreset(provider ?? "claude");
  if (preset.bridge) return preset.bridge;
  if (preset.hookBridge) return { kind: "hooks", shim: preset.hookBridge };
  return void 0;
}
function configuredCommandServes(provider, configured) {
  const cmd = (configured ?? "").trim();
  if (!cmd) return false;
  const inferred = inferAgentProvider(cmd);
  if (inferred === provider) return true;
  return provider === "claude" && inferred === "custom";
}

module.exports = {
  AGENT_PROVIDER_PRESETS, AGENT_PROVIDER_IDS,
  isAgentProvider, normalizeAgentProvider, providerPreset,
  isClaudeProvider, isHiveAwareProvider, canReceiveInbox,
  commandBinary, inferAgentProvider, bridgeOf, configuredCommandServes,
};
