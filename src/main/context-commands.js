'use strict';
/**
 * Context commands — per-provider compact/clear verbs, verbatim from the
 * reference. Each entry records the exact slash the provider's OWN command
 * surface documents (checked against shipped binaries / official docs, see
 * the per-provider notes), plus whether /compact accepts a free-text focus.
 * Providers with no safe, verified verb get NO_CONTEXT_COMMANDS: typing a
 * guessed slash into a live TUI is worse than no auto-compact.
 */
const NO_CONTEXT_COMMANDS = {
  compact: null,
  clear: null,
  compactTakesFocus: false
};
const CONTEXT_COMMANDS = {
  // claudeCommands.ts:34,37 (this repo's own catalog): `/compact` takes a focus
  // ("usage: /compact keep the auth decisions"), `/clear` starts a fresh
  // conversation and reclaims the window.
  claude: { compact: "/compact", clear: "/clear", compactTakesFocus: true },
  // Codex 0.137.0 binary, TUI slash-command description table:
  //   "summarize conversation to prevent hitting the context limit"  → /compact
  //   "clear the terminal and start a new chat"                      → /clear
  // NOTE this contradicts codexCommands.ts, which lists /clear but NOT /compact.
  // The binary is right and that catalog is incomplete (see report).
  // compactTakesFocus stays FALSE: codex's own `Usage: /…` strings spell out an
  // argument for every command that takes one (/goal, /raw, /mcp, /keymap,
  // /ide, /sandbox-add-read-dir) and /compact has none.
  codex: { compact: "/compact", clear: "/clear", compactTakesFocus: false },
  // Grok binary ships its own docs inline (04-slash-commands.md):
  //   "/compact [context] — Compress conversation history… Optionally specify
  //    what to preserve", example `/compact keep the auth implementation details`
  //   "/new — Start a new session, clearing the current conversation.
  //    Aliases: /clear"
  // `/new` is the documented spelling (and what grokCommands.ts:13 already
  // records), so prefer it over the alias.
  grok: { compact: "/compact", clear: "/new", compactTakesFocus: true },
  // Moonshot kimi-cli slash-command reference: `/compact` accepts appended
  // custom instructions ("/compact preserve database-related discussions");
  // `/clear` (alias /reset) "Clear the current session's context and start a
  // new conversation". NB `/new` there forks a session rather than discarding.
  kimi: { compact: "/compact", clear: "/clear", compactTakesFocus: true },
  // antigravity.google/docs/cli/reference (Google's own command table):
  //   "/clear  (/new)  — Clear the terminal and reset active conversation
  //    contexts."     ← a REAL context reset, and
  //   "Ctrl+L  cli.clear_screen — Refreshes and clears the visual terminal
  //    buffer."       ← the screen-only one. The two are different things, so
  // the "agy /clear only clears the screen" worry does not hold.
  // That reference lists NO compaction verb at all (zero hits for compact /
  // compress / summarize), and the shipped `agy` binary has no such literal
  // either — agy compacts AUTOMATICALLY when the window fills ("# Resuming from
  // a compaction"). Nothing to type, so: null.
  antigravity: { compact: null, clear: "/clear", compactTakesFocus: false },
  // Google Gemini CLI's command reference documents `/compress` as replacing
  // the chat context with a summary and `/clear` as starting a clean context.
  // `/compress` has no focus-argument contract, so never append user prose.
  gemini: { compact: "/compress", clear: "/clear", compactTakesFocus: false },
  // qwen-code's bundled cli.js, verbatim:
  //   compressCommand = { name:"compress", altNames:["summarize"],
  //     description "Compresses the context by replacing it with a summary." }
  //   and its action reads `context.invocation?.args` as `customInstructions`
  //   (capped at 2000 chars) → it genuinely takes a focus.
  //   clearCommand    = { name:"clear", altNames:["reset","new"],
  //     description "Clear conversation history and free up context." }
  // It is `/compress`, NOT `/compact`: qwen dropped upstream gemini-cli's
  // `compact` altName, so `/compact` would land as plain text here.
  qwen: { compact: "/compress", clear: "/clear", compactTakesFocus: true },
  // opencode binary's command registry, verbatim:
  //   { title:"Compact session", value:"session.compact",
  //     slash:{ name:"compact", aliases:["summarize"] }, run: … }
  // and its own tip text "Run /compact to summarize long sessions near context
  // limits". That `run()` calls session.summarize({sessionID,model}) and never
  // looks at the invocation args → the focus would be silently dropped, so
  // compactTakesFocus is false.
  // `/clear` does NOT exist in the binary (zero literals); the fresh-session
  // verb is `/new` — matched exactly (`t.trim().toLowerCase()==="/new"`).
  opencode: { compact: "/compact", clear: "/new", compactTakesFocus: false },
  // Crush has NO typed slash commands at all. Its own binary strings show
  // "Summarize Session" / "New Session" as ctrl+p COMMAND-PALETTE rows, and the
  // hint "/ or ctrl+p" means a leading `/` OPENS that palette rather than
  // submitting a command. Typing "/compact" would filter a modal and leave it
  // open, swallowing everything queued behind it. Nothing safe to type: null.
  // (Crush's compact/clear are reachable only over its HTTP API.)
  crush: NO_CONTEXT_COMMANDS,
  // pi's dist/core/slash-commands.js, verbatim:
  //   { name:"compact", description:"Manually compact the session context" }
  //   { name:"new",     description:"Start a new session" }
  // and docs/compaction.md: "trigger manually with `/compact [instructions]`,
  // where optional instructions focus the summary". There is no `/clear`.
  pi: { compact: "/compact", clear: "/new", compactTakesFocus: true },
  // Copilot's interactive mode has `/compact [FOCUS-INSTRUCTIONS]` and
  // `/clear`, and since 0.5.3 the preset runs it interactively (`-i`). They
  // stay null until they are checked against a live 1.0.88 session: a wrong
  // slash typed into a live TUI is worse than no auto-compact.
  copilot: NO_CONTEXT_COMMANDS,
  // Cursor Agent CLI (`agent`) is interactive in this preset, but its slash /
  // command surface is not yet verified against a frozen binary catalog in-repo.
  // Prefer null over guessing — wrong slashes into a live TUI are worse than no
  // auto-compact. Revisit when a shipped command table is transcribed.
  cursor: NO_CONTEXT_COMMANDS,
  // An arbitrary user binary. We cannot know its command surface, and guessing
  // means typing slashes into someone's unknown REPL.
  custom: NO_CONTEXT_COMMANDS
};
function contextCommandsForProvider(provider) {
  return CONTEXT_COMMANDS[provider] ?? NO_CONTEXT_COMMANDS;
}
const KNOWN_COMPACT_VERBS = new Set(
  Object.values(CONTEXT_COMMANDS).map((c) => c.compact).filter((c) => typeof c === "string" && c.length > 0)
);
function clearCommandForProvider(provider, message = "") {
  const override = message.trim();
  if (override) return override;
  return contextCommandsForProvider(provider).clear;
}
/** The compact verb for `provider`, optionally carrying a focus where the
 *  provider's command contract supports one. null when it has none. */
function compactCommandForProvider(provider, focus = "") {
  const spec = contextCommandsForProvider(provider);
  if (!spec.compact) return null;
  const f = (focus ?? "").trim();
  return spec.compactTakesFocus && f ? `${spec.compact} ${f}` : spec.compact;
}

module.exports = {
  NO_CONTEXT_COMMANDS, CONTEXT_COMMANDS, KNOWN_COMPACT_VERBS,
  contextCommandsForProvider, clearCommandForProvider, compactCommandForProvider,
};
