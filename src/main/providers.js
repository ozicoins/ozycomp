'use strict';
/**
 * Provider presets — how to launch each CLI coding agent. The harness never
 * calls model APIs itself: it runs the vendor's own CLI in a PTY and steers it
 * through the hive filesystem + hook plane.
 *
 * Preset fields (same vocabulary as the reference harness):
 *   defaultCommand          binary on PATH
 *   autoFlag                "always approve" stance, used when Auto Mode is on
 *   modelFlag               flag that selects a model
 *   initialPromptFlag       flag carrying the seed prompt (e.g. `-i`)
 *   positionalInitialPrompt seed prompt goes as a bare trailing arg
 *   seedDelivery            'type-into-tui' → no flag; harness types it after boot
 *   resumeFlag / resumeSubcommand
 *   hiveAware               reads the injected hive protocol natively
 *   canReceiveInbox         harness may type inbox digests into it
 *   bridge                  {kind:'hooks'|'proxy', …} non-Claude hook transport
 *   installCommand          shown in the UI when the binary is missing
 */
const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = {
  claude: {
    id: 'claude', label: 'Claude Code', defaultCommand: 'claude',
    autoFlag: '--permission-mode bypassPermissions', modelFlag: '--model',
    positionalInitialPrompt: true, resumeFlag: '--resume',
    hiveAware: true, canReceiveInbox: true, supportsOtel: true,
    recommendedOrchestratorModel: 'claude-opus-5-5',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    nativeInstallCommand: { posix: 'curl -fsSL https://claude.ai/install.sh | bash', win32: 'powershell -c irm https://claude.ai/install.ps1 | iex' },
    docsUrl: 'https://docs.claude.com/en/docs/claude-code',
  },
  codex: {
    id: 'codex', label: 'Codex · GPT', defaultCommand: 'codex',
    autoFlag: '-a never -s workspace-write', modelFlag: '--model',
    positionalInitialPrompt: true, resumeSubcommand: 'resume',
    autoStanceTokens: ['-a', '--ask-for-approval', '-s', '--sandbox', '--full-auto', '--dangerously-bypass-approvals-and-sandbox'],
    nonInteractiveEnv: { CODEX_NON_INTERACTIVE: '1' },
    canReceiveInbox: true, bridge: { kind: 'hooks', shim: 'codex' },
    recommendedOrchestratorModel: 'gpt-5.6-sol',
    installCommand: 'npm install -g @openai/codex',
    docsUrl: 'https://github.com/openai/codex',
  },
  grok: {
    id: 'grok', label: 'Grok · xAI', defaultCommand: 'grok',
    autoFlag: '--permission-mode bypassPermissions', modelFlag: '--model',
    positionalInitialPrompt: true, resumeFlag: '--resume',
    canReceiveInbox: true, bridge: { kind: 'hooks', shim: 'grok' },
    nativeInstallCommand: { posix: 'curl -fsSL https://x.ai/cli/install.sh | bash', win32: 'powershell -c irm https://x.ai/cli/install.ps1 | iex' },
    docsUrl: 'https://x.ai/cli',
  },
  kimi: {
    id: 'kimi', label: 'Kimi Code', defaultCommand: 'kimi',
    autoFlag: '--auto', modelFlag: '--model', resumeFlag: '--session',
    canReceiveInbox: false,
    nativeInstallCommand: { posix: 'curl -fsSL https://cdn.kimi.com/kimi-code/install.sh | bash', win32: 'powershell -c irm https://cdn.kimi.com/kimi-code/install.ps1 | iex' },
    docsUrl: 'https://www.kimi.com/code/docs/en/',
  },
  gemini: {
    id: 'gemini', label: 'Gemini CLI', defaultCommand: 'gemini',
    autoFlag: '--approval-mode=yolo', modelFlag: '--model',
    initialPromptFlag: '-i', resumeFlag: '--resume',
    autoStanceTokens: ['--yolo', '-y'],
    canReceiveInbox: true, bridge: { kind: 'hooks', shim: 'gemini' },
    recommendedOrchestratorModel: 'pro',
    installCommand: 'npm install -g @google/gemini-cli',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  antigravity: {
    id: 'antigravity', label: 'Antigravity · Gemini', defaultCommand: 'agy',
    autoFlag: '--dangerously-skip-permissions', modelFlag: '--model',
    initialPromptFlag: '-i', resumeFlag: '--conversation',
    canReceiveInbox: true, bridge: { kind: 'hooks', shim: 'agy' },
    recommendedOrchestratorModel: 'Gemini 3.1 Pro (High)',
    nativeInstallCommand: { posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', win32: 'powershell -c irm https://antigravity.google/cli/install.ps1 | iex' },
    docsUrl: 'https://antigravity.google/docs/cli',
  },
  qwen: {
    id: 'qwen', label: 'Qwen (local available)', defaultCommand: 'qwen',
    autoFlag: '--yolo', modelFlag: '--model', initialPromptFlag: '-i', resumeFlag: '--resume',
    canReceiveInbox: true, bridge: { kind: 'proxy', api: 'openai', baseUrlEnv: 'OPENAI_BASE_URL', inboxDelivery: 'terminal' },
    recommendedOrchestratorModel: 'qwen3-coder-plus',
    installCommand: 'npm install -g @qwen-code/qwen-code@latest',
    docsUrl: 'https://github.com/QwenLM/qwen-code',
  },
  opencode: {
    id: 'opencode', label: 'OpenCode', defaultCommand: 'opencode',
    autoFlag: '', modelFlag: '--model', initialPromptFlag: '--prompt', resumeFlag: '--session',
    canReceiveInbox: true, bridge: { kind: 'hooks', shim: 'opencode' },
    nativeInstallCommand: { posix: 'curl -fsSL https://opencode.ai/install | bash', win32: 'choco install opencode -y' },
    installCommand: 'npm install -g opencode-ai@latest',
    docsUrl: 'https://opencode.ai/docs',
  },
  crush: {
    id: 'crush', label: 'Crush · Charm', defaultCommand: 'crush',
    autoFlag: '--yolo', modelFlag: '--model', seedDelivery: 'type-into-tui', resumeFlag: '--session',
    canReceiveInbox: true, bridge: { kind: 'proxy', api: 'openai', baseUrlEnv: 'CRUSH_PROXY_BASE_URL', inboxDelivery: 'terminal' },
    recommendedOrchestratorModel: 'openai/gpt-4o',
    installCommand: 'npm install -g @charmland/crush',
    docsUrl: 'https://github.com/charmbracelet/crush',
  },
  pi: {
    id: 'pi', label: 'Pi', defaultCommand: 'pi',
    autoFlag: '--approve', modelFlag: '--model', positionalInitialPrompt: true, resumeFlag: '--session',
    nonInteractiveEnv: { PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
    canReceiveInbox: true, bridge: { kind: 'hooks', shim: 'pi' },
    recommendedOrchestratorModel: 'anthropic/claude-sonnet-4-5',
    installCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
    docsUrl: 'https://pi.dev/docs/latest',
  },
  copilot: {
    id: 'copilot', label: 'Copilot', defaultCommand: 'copilot',
    autoFlag: '--allow-all-tools --no-ask-user', modelFlag: '--model',
    initialPromptFlag: '-i', resumeFlag: '--resume', canReceiveInbox: false,
    recommendedOrchestratorModel: 'claude-sonnet-4.5',
    installCommand: 'npm install -g @github/copilot',
    docsUrl: 'https://docs.github.com/copilot/concepts/agents/about-copilot-cli',
  },
  cursor: {
    id: 'cursor', label: 'Cursor', defaultCommand: 'cursor-agent',
    autoFlag: '--force --trust', modelFlag: '--model', seedDelivery: 'type-into-tui',
    resumeFlag: '--resume', canReceiveInbox: true,
    recommendedOrchestratorModel: 'gpt-5.6-luna-high',
    nativeInstallCommand: { posix: 'curl https://cursor.com/install -fsS | bash', win32: 'irm https://cursor.com/install?win32=true | iex' },
    docsUrl: 'https://cursor.com/docs/cli/install',
  },
  devin: {
    id: 'devin', label: 'Devin', defaultCommand: 'devin',
    autoFlag: '--permission-mode bypassPermissions', modelFlag: '--model',
    positionalInitialPrompt: true, resumeFlag: '--resume',
    canReceiveInbox: false, seedDelivery: 'type-into-tui',
    installCommand: 'uv tool install devin || pipx install devin',
    nativeInstallCommand: { posix: 'curl -fsSL https://cli.devin.ai/install.sh | bash', win32: 'powershell -c irm https://cli.devin.ai/install.ps1 | iex' },
    docsUrl: 'https://docs.devin.ai/cli',
  },
  // a bare login shell — the god console fallback and the test harness's agent
  shell: {
    id: 'shell', label: 'Shell', defaultCommand: process.env.SHELL || '/bin/zsh',
    baseArgs: ['-l'], autoFlag: '', canReceiveInbox: true, hiveAware: true,
  },
  custom: {
    id: 'custom', label: 'Custom', defaultCommand: '', autoFlag: '', canReceiveInbox: false,
  },
};

const BIN_ALIASES = { agy: 'antigravity', antigravity: 'antigravity', 'cursor-agent': 'cursor', agent: 'cursor' };

function providerFor(id) { return PROVIDERS[id] ?? PROVIDERS.custom; }

/** Infer a provider from a free-form command line (`/usr/local/bin/codex --x` → codex). */
function providerFromCommand(command) {
  const bin = path.basename(String(command ?? '').trim().split(/\s+/)[0] ?? '');
  if (!bin) return 'claude';
  if (BIN_ALIASES[bin]) return BIN_ALIASES[bin];
  return PROVIDERS[bin] && bin !== 'custom' ? bin : 'custom';
}

/** Split a flag string like "-a never -s workspace-write" into argv. */
const splitFlags = s => String(s ?? '').trim().split(/\s+/).filter(Boolean);

/** Locate a binary on PATH without spawning. */
function which(bin, envPath = process.env.PATH ?? '') {
  if (!bin) return null;
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  const extra = [`${process.env.HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of [...envPath.split(path.delimiter), ...extra]) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

/**
 * Build the launch line for an agent.
 * ctx: {model, auto, prompt, resume, systemPrompt, otelEndpoint, agentId, agentName, command, extraArgs}
 * → {command, args, env, seedPrompt?}
 */
function buildLaunch(preset, ctx = {}) {
  const command = ctx.command || preset.defaultCommand;
  const args = [...(preset.baseArgs ?? [])];
  const env = { ...(preset.nonInteractiveEnv ?? {}) };

  if (preset.resumeSubcommand && ctx.resume) args.push(preset.resumeSubcommand, ctx.resume);
  if (preset.resumeFlag && ctx.resume) args.push(preset.resumeFlag, ctx.resume);
  if (ctx.model && preset.modelFlag) args.push(preset.modelFlag, ctx.model);
  if (ctx.auto && preset.autoFlag) args.push(...splitFlags(preset.autoFlag));

  if (preset.id === 'claude') {
    if (ctx.systemPrompt) args.push('--append-system-prompt', ctx.systemPrompt);
    if (ctx.otelEndpoint) {
      Object.assign(env, {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_ENDPOINT: ctx.otelEndpoint,
        OTEL_METRIC_EXPORT_INTERVAL: '5000',
        OTEL_LOGS_EXPORT_INTERVAL: '2000',
        OTEL_RESOURCE_ATTRIBUTES: `agent.id=${ctx.agentId},agent.name=${ctx.agentName ?? ctx.agentId}`,
      });
    }
  }
  args.push(...(ctx.extraArgs ?? []));

  let seedPrompt;
  if (ctx.prompt) {
    if (preset.seedDelivery === 'type-into-tui' || preset.id === 'shell') seedPrompt = ctx.prompt;
    else if (preset.initialPromptFlag) args.push(preset.initialPromptFlag, ctx.prompt);
    else if (preset.positionalInitialPrompt) args.push(ctx.prompt);
    else seedPrompt = ctx.prompt;
  }
  return { command, args, env, seedPrompt };
}

function listProviders() {
  return Object.values(PROVIDERS).map(p => ({
    id: p.id, label: p.label, command: p.defaultCommand,
    installed: !!which(p.defaultCommand), installCommand: p.installCommand ?? null,
    nativeInstallCommand: p.nativeInstallCommand?.[process.platform === 'win32' ? 'win32' : 'posix'] ?? null,
    docsUrl: p.docsUrl ?? null,
    canReceiveInbox: !!p.canReceiveInbox, hiveAware: !!p.hiveAware,
    recommendedOrchestratorModel: p.recommendedOrchestratorModel ?? null,
  }));
}

module.exports = { PROVIDERS, providerFor, providerFromCommand, buildLaunch, listProviders, which, splitFlags };
