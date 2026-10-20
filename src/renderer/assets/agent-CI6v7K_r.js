import { C as Capability, r as requireBoundSession, U as UserError, t as tool, o as object, s as string, c as applyPatchTool, h as withSandboxSpan, i as isRecord, f as encodeUint8ArrayToBase64, a as ApplyPatchOperation, g as number, d as boolean, p as prompt, A as Agent, S as SANDBOX_AGENT_BRAND, e as cloneManifest, M as Manifest, n as normalizeUser } from "./index-CYoBaPLy.js";
import "./index-CsK_GEYj.js";
import "./global-eDtrx50m.js";
import "./PuckFace-CCZUmqjS.js";
import "./puck-HlPOn73L.js";
import "./portraitArt-Bz9wz1UV.js";
function supportsResponsesCompactionTransport(modelInstance) {
  if (!modelInstance) {
    return true;
  }
  const constructorName = typeof modelInstance === "object" && modelInstance && "constructor" in modelInstance && typeof modelInstance.constructor === "function" ? modelInstance.constructor.name : "";
  return !constructorName.includes("ChatCompletions");
}
function supportsApplyPatchTransport(modelInstance) {
  return supportsStructuredToolOutputTransport(modelInstance);
}
function supportsStructuredToolOutputTransport(modelInstance) {
  if (!modelInstance) {
    return false;
  }
  const constructorName = typeof modelInstance === "object" && modelInstance && "constructor" in modelInstance && typeof modelInstance.constructor === "function" ? modelInstance.constructor.name : "";
  return !constructorName.includes("ChatCompletions");
}
class CompactionPolicy {
}
class DynamicCompactionPolicy extends CompactionPolicy {
  thresholdRatio;
  fallbackThreshold;
  constructor(thresholdRatio = 0.9, fallbackThreshold = 24e4) {
    super();
    this.thresholdRatio = thresholdRatio;
    this.fallbackThreshold = fallbackThreshold;
  }
  compactThreshold(model) {
    if (!model) {
      return this.fallbackThreshold;
    }
    const modelInfo = CompactionModelInfo.forModel(model);
    if (!modelInfo) {
      return this.fallbackThreshold;
    }
    return Math.floor(modelInfo.contextWindow * this.thresholdRatio);
  }
}
class CompactionModelInfo {
  contextWindow;
  constructor(contextWindow) {
    this.contextWindow = contextWindow;
  }
  static forModel(model) {
    for (const candidate of getSandboxCompactionModelCandidates(model)) {
      if (SANDBOX_CONTEXT_WINDOWS_1M.has(candidate)) {
        return new CompactionModelInfo(1047576);
      }
      if (SANDBOX_CONTEXT_WINDOWS_400K.has(candidate)) {
        return new CompactionModelInfo(4e5);
      }
      if (SANDBOX_CONTEXT_WINDOWS_200K.has(candidate)) {
        return new CompactionModelInfo(2e5);
      }
      if (SANDBOX_CONTEXT_WINDOWS_128K.has(candidate)) {
        return new CompactionModelInfo(128e3);
      }
    }
    return void 0;
  }
}
class CompactionCapability extends Capability {
  type = "compaction";
  policy;
  constructor(policy = new DynamicCompactionPolicy()) {
    super();
    this.policy = policy;
  }
  samplingParams(samplingParams) {
    if (samplingParams.modelInstance && !supportsResponsesCompactionTransport(samplingParams.modelInstance)) {
      return {};
    }
    const model = typeof samplingParams.model === "string" ? samplingParams.model : void 0;
    return {
      context_management: [
        {
          type: "compaction",
          compact_threshold: this.policy.compactThreshold(model)
        }
      ]
    };
  }
  processContext(context) {
    let lastCompactionIndex = -1;
    for (let index = 0; index < context.length; index += 1) {
      if (context[index].type === "compaction") {
        lastCompactionIndex = index;
      }
    }
    if (lastCompactionIndex === -1) {
      return context;
    }
    return context.slice(lastCompactionIndex);
  }
}
function compaction(args = {}) {
  return new CompactionCapability(args.policy);
}
function getSandboxCompactionModelCandidates(model) {
  const trimmed = model.trim();
  if (!trimmed) {
    return [];
  }
  const withoutProviderPrefix = trimmed.includes("/") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const normalized = withoutProviderPrefix.toLowerCase();
  const withoutPinnedDate = normalized.replace(/-\d{4}-\d{2}-\d{2}$/u, "");
  return [.../* @__PURE__ */ new Set([normalized, withoutPinnedDate])];
}
const SANDBOX_CONTEXT_WINDOWS_1M = /* @__PURE__ */ new Set([
  "gpt-5.4",
  "gpt-5.4-2026-03-05",
  "gpt-5.4-pro",
  "gpt-5.4-pro-2026-03-05",
  "gpt-4.1",
  "gpt-4.1-2025-04-14",
  "gpt-4.1-mini",
  "gpt-4.1-mini-2025-04-14",
  "gpt-4.1-nano",
  "gpt-4.1-nano-2025-04-14"
]);
const SANDBOX_CONTEXT_WINDOWS_400K = /* @__PURE__ */ new Set([
  "gpt-5",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-codex-cyber",
  "gpt-5.2-pro",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4-mini",
  "gpt-5.4-nano"
]);
const SANDBOX_CONTEXT_WINDOWS_200K = /* @__PURE__ */ new Set([
  "codex-mini-latest",
  "o1",
  "o1-2024-12-17",
  "o1-pro",
  "o3",
  "o3-2025-04-16",
  "o3-mini",
  "o3-pro",
  "o3-deep-research",
  "o4-mini",
  "o4-mini-2025-04-16",
  "o4-mini-deep-research"
]);
const SANDBOX_CONTEXT_WINDOWS_128K = /* @__PURE__ */ new Set([
  "gpt-4o",
  "gpt-4o-2024-08-06",
  "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18",
  "gpt-5-chat-latest",
  "gpt-5.1-chat-latest",
  "gpt-5.2-chat-latest",
  "gpt-5.3-chat-latest"
]);
const applyPatchFunctionParameters = {
  type: "object",
  properties: {
    patch: {
      type: "string",
      description: "A freeform apply_patch payload wrapped in *** Begin Patch and *** End Patch."
    },
    operation: {
      type: "object",
      description: "A single structured apply_patch operation."
    },
    operations: {
      type: "array",
      items: { type: "object" },
      description: "Structured apply_patch operations to apply in order."
    },
    command: {
      type: "array",
      description: 'Optional ["apply_patch", patch] command tuple form.'
    },
    type: {
      type: "string",
      enum: ["create_file", "update_file", "delete_file"],
      description: "The patch operation to apply."
    },
    path: {
      type: "string",
      description: "The sandbox file path to patch."
    },
    diff: {
      type: "string",
      description: "The V4A patch diff for create_file and update_file operations."
    },
    moveTo: {
      type: "string",
      description: "Optional destination path for update_file move operations."
    }
  },
  required: [],
  additionalProperties: true
};
const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message || error.toString();
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
function renderImageForTextTransport(output) {
  if (typeof output === "string") {
    return output;
  }
  const image = output.image;
  if (typeof image === "string") {
    return image;
  }
  if (!isRecord(image)) {
    return "No image data was returned by the sandbox session.";
  }
  const imageRecord = image;
  if (typeof imageRecord.url === "string") {
    return imageRecord.url;
  }
  if (typeof imageRecord.fileId === "string") {
    return `OpenAI file reference: ${imageRecord.fileId}`;
  }
  if (typeof imageRecord.data === "string") {
    const mediaType = typeof imageRecord.mediaType === "string" ? imageRecord.mediaType : "application/octet-stream";
    return `data:${mediaType};base64,${imageRecord.data}`;
  }
  if (imageRecord.data instanceof Uint8Array) {
    const mediaType = typeof imageRecord.mediaType === "string" ? imageRecord.mediaType : "application/octet-stream";
    return `data:${mediaType};base64,${encodeUint8ArrayToBase64(imageRecord.data)}`;
  }
  return "No image data was returned by the sandbox session.";
}
function renderViewImageError(path, error) {
  const message = toErrorMessage(error);
  if (/not found/iu.test(message)) {
    return `image path \`${path}\` was not found`;
  }
  if (/not a file/iu.test(message)) {
    return `image path \`${path}\` is not a file`;
  }
  if (/exceeds the 10 MB limit|exceeded the allowed size/iu.test(message)) {
    return `image path \`${path}\` exceeded the allowed size of 10MB; resize or compress the image and try again`;
  }
  if (/unsupported image format|not a supported image/iu.test(message)) {
    return `image path \`${path}\` is not a supported image file`;
  }
  const name = error instanceof Error ? error.name : typeof error;
  return `unable to read image at \`${path}\`: ${name}`;
}
function parseApplyPatchInput(rawInput) {
  const trimmedInput = rawInput.trimStart();
  if (trimmedInput.startsWith(BEGIN_PATCH)) {
    return parseFreeformPatch(trimmedInput);
  }
  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid apply_patch JSON: ${toErrorMessage(error)}`
    };
  }
  return parseApplyPatchPayload(payload);
}
function parseApplyPatchPayload(payload) {
  if (typeof payload === "string") {
    return parseFreeformPatch(payload);
  }
  if (Array.isArray(payload)) {
    return parseStructuredOperations(payload);
  }
  if (!isRecord(payload)) {
    return {
      ok: false,
      error: "apply_patch input must be an object or array."
    };
  }
  if (typeof payload.patch === "string") {
    return parseFreeformPatch(payload.patch);
  }
  if (Array.isArray(payload.command)) {
    const [commandName, patch] = payload.command;
    if (commandName === "apply_patch" && typeof patch === "string") {
      return parseFreeformPatch(patch);
    }
  }
  if (Array.isArray(payload.operations)) {
    return parseStructuredOperations(payload.operations);
  }
  if (payload.operation !== void 0) {
    return parseStructuredOperations([payload.operation]);
  }
  return parseStructuredOperations([payload]);
}
function parseStructuredOperations(payloads) {
  const operations = [];
  for (const payload of payloads) {
    const parsed = ApplyPatchOperation.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid apply_patch operation: ${parsed.error.message}`
      };
    }
    operations.push(parsed.data);
  }
  if (operations.length === 0) {
    return { ok: false, error: "apply_patch input must include an operation." };
  }
  return { ok: true, operations };
}
function parseFreeformPatch(rawPatch) {
  const lines = rawPatch.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines[0] !== BEGIN_PATCH) {
    return {
      ok: false,
      error: `apply_patch input must start with "${BEGIN_PATCH}".`
    };
  }
  if (lines.length < 2 || lines.at(-1) !== END_PATCH) {
    return {
      ok: false,
      error: `apply_patch input must end with "${END_PATCH}".`
    };
  }
  const operations = [];
  let index = 1;
  while (index < lines.length - 1) {
    const line = lines[index];
    let parsed;
    if (line.startsWith(ADD_FILE)) {
      parsed = parseAddFilePatch(lines, index);
    } else if (line.startsWith(DELETE_FILE)) {
      parsed = parseDeleteFilePatch(lines, index);
    } else if (line.startsWith(UPDATE_FILE)) {
      parsed = parseUpdateFilePatch(lines, index);
    } else {
      return {
        ok: false,
        error: `Invalid apply_patch file operation header: ${line}`
      };
    }
    if ("error" in parsed) {
      return { ok: false, error: parsed.error };
    }
    operations.push(parsed.operation);
    index = parsed.nextIndex;
  }
  if (operations.length === 0) {
    return {
      ok: false,
      error: "apply_patch input must include at least one file operation."
    };
  }
  return { ok: true, operations };
}
function parseAddFilePatch(lines, index) {
  const path = parsePatchHeader(lines[index], ADD_FILE);
  if (!path) {
    return { error: `Missing path in apply_patch header: ${lines[index]}` };
  }
  index += 1;
  const diffLines = [];
  while (index < lines.length - 1 && !isFileOperationHeader(lines[index])) {
    const line = lines[index];
    if (!line.startsWith("+")) {
      return { error: `Invalid Add File line: ${line}` };
    }
    diffLines.push(line);
    index += 1;
  }
  if (diffLines.length === 0) {
    return {
      error: `Add File patch for ${path} must include at least one + line.`
    };
  }
  return {
    operation: {
      type: "create_file",
      path,
      diff: joinDiff(diffLines)
    },
    nextIndex: index
  };
}
function parseDeleteFilePatch(lines, index) {
  const path = parsePatchHeader(lines[index], DELETE_FILE);
  if (!path) {
    return { error: `Missing path in apply_patch header: ${lines[index]}` };
  }
  index += 1;
  if (index < lines.length - 1 && !isFileOperationHeader(lines[index])) {
    return { error: `Delete File patch for ${path} must not include a diff.` };
  }
  return {
    operation: {
      type: "delete_file",
      path
    },
    nextIndex: index
  };
}
function parseUpdateFilePatch(lines, index) {
  const path = parsePatchHeader(lines[index], UPDATE_FILE);
  if (!path) {
    return { error: `Missing path in apply_patch header: ${lines[index]}` };
  }
  index += 1;
  let moveTo;
  if (index < lines.length - 1 && lines[index].startsWith(MOVE_TO)) {
    const parsedMoveTo = parsePatchHeader(lines[index], MOVE_TO);
    if (!parsedMoveTo) {
      return { error: `Missing path in apply_patch header: ${lines[index]}` };
    }
    moveTo = parsedMoveTo;
    index += 1;
  }
  const diffLines = [];
  while (index < lines.length - 1 && !isFileOperationHeader(lines[index])) {
    diffLines.push(lines[index]);
    index += 1;
  }
  if (diffLines.length === 0 && !moveTo) {
    return { error: `Update File patch for ${path} must include a hunk.` };
  }
  return {
    operation: {
      type: "update_file",
      path,
      diff: diffLines.length > 0 ? joinDiff(diffLines) : "",
      ...moveTo ? { moveTo } : {}
    },
    nextIndex: index
  };
}
function parsePatchHeader(line, prefix) {
  const path = line.slice(prefix.length).trim();
  return path ? path : null;
}
function isFileOperationHeader(line) {
  return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}
function joinDiff(lines) {
  return `${lines.join("\n")}
`;
}
async function applyPatchOperation(editor, operation, runContext) {
  let result;
  try {
    switch (operation.type) {
      case "create_file":
        result = await editor.createFile(operation, { runContext });
        break;
      case "update_file":
        result = await editor.updateFile(operation, { runContext });
        break;
      case "delete_file":
        result = await editor.deleteFile(operation, { runContext });
        break;
      default:
        return "Unsupported apply_patch operation.";
    }
  } catch (error) {
    return `Failed to apply patch: ${toErrorMessage(error)}`;
  }
  if (result?.status === "failed") {
    return result.output ? `Patch failed: ${result.output}` : "Patch failed.";
  }
  return result?.output ?? "Patch applied.";
}
async function applyPatchOperations(editor, operations, runContext) {
  const outputs = [];
  for (const operation of operations) {
    const output = await applyPatchOperation(editor, operation, runContext);
    if (output) {
      outputs.push(output);
    }
  }
  return outputs.join("\n") || "Patch applied.";
}
function applyPatchFunctionTool(editor) {
  const fallbackTool = {
    type: "function",
    name: "apply_patch",
    description: "Applies a create, update, move, or delete file patch in the sandbox workspace. Accepts a freeform patch string or structured apply_patch operations.",
    parameters: applyPatchFunctionParameters,
    strict: false,
    deferLoading: false,
    needsApproval: async () => false,
    isEnabled: async () => true,
    invoke: async (runContext, input) => {
      const parsed = parseApplyPatchInput(input);
      if (!parsed.ok) {
        return parsed.error;
      }
      return await applyPatchOperations(editor, parsed.operations, runContext);
    }
  };
  return fallbackTool;
}
class FilesystemCapability extends Capability {
  type = "filesystem";
  configureTools;
  constructor(args = {}) {
    super();
    this.configureTools = args.configureTools;
  }
  tools() {
    const session = requireBoundSession(this.type, this._session);
    const editor = session.createEditor?.(this._runAs);
    if (!editor) {
      throw new UserError("Filesystem sandbox sessions must provide createEditor().");
    }
    const tools = [];
    const viewImage = async (path) => {
      if (!session.viewImage) {
        throw new UserError("Filesystem sandbox sessions must provide viewImage().");
      }
      try {
        return await withSandboxSpan("sandbox.view_image", {
          path,
          run_as: this._runAs
        }, async () => await session.viewImage({
          path,
          runAs: this._runAs
        }));
      } catch (error) {
        return renderViewImageError(path, error);
      }
    };
    if (supportsStructuredToolOutputTransport(this._modelInstance)) {
      tools.push(tool({
        name: "view_image",
        description: "Returns an image output from a local path in the sandbox workspace.",
        parameters: object({
          path: string().describe("Local filesystem path to an image file")
        }),
        execute: async ({ path }) => await viewImage(path)
      }));
    } else {
      tools.push(tool({
        name: "view_image",
        description: "Returns an image from a local path in the sandbox workspace as a data URL or reference string.",
        parameters: object({
          path: string().describe("Local filesystem path to an image file")
        }),
        execute: async ({ path }) => renderImageForTextTransport(await viewImage(path))
      }));
    }
    if (supportsApplyPatchTransport(this._modelInstance)) {
      tools.push(applyPatchTool({
        name: "apply_patch",
        editor
      }));
    } else {
      tools.push(applyPatchFunctionTool(editor));
    }
    return this.configureTools ? this.configureTools([...tools]) : tools;
  }
}
function filesystem(args = {}) {
  return new FilesystemCapability(args);
}
const DEFAULT_EXEC_YIELD_TIME_MS = 1e4;
const DEFAULT_WRITE_STDIN_YIELD_TIME_MS = 250;
const SHELL_INSTRUCTIONS = [
  "When using the shell:",
  "- Use `exec_command` for shell execution.",
  "- If available, use `write_stdin` to interact with or poll running sessions.",
  "- To interrupt a long-running process via `write_stdin`, start it with `tty=true` and send Ctrl-C (`\\u0003`).",
  "- Prefer `rg` and `rg --files` for text/file discovery when available.",
  "- Avoid using Python scripts just to print large file chunks."
].join("\n");
class ShellCapability extends Capability {
  type = "shell";
  configureTools;
  constructor(args = {}) {
    super();
    this.configureTools = args.configureTools;
  }
  tools() {
    const session = requireBoundSession(this.type, this._session);
    if (!session.execCommand) {
      throw new UserError("Shell sandbox sessions must provide execCommand().");
    }
    const tools = [
      tool({
        name: "exec_command",
        description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
        parameters: object({
          cmd: string().min(1).describe("Shell command to execute."),
          workdir: string().optional().describe("Optional working directory to run the command in; defaults to the turn cwd."),
          shell: string().optional().describe("Shell binary to launch. Defaults to the user's default shell."),
          login: boolean().default(true).describe("Whether to run the shell with -l/-i semantics. Defaults to true."),
          tty: boolean().default(false).describe("Whether to allocate a TTY for the command. Defaults to false (plain pipes); set to true to open a PTY and access TTY process."),
          yield_time_ms: number().int().min(0).default(DEFAULT_EXEC_YIELD_TIME_MS).describe("How long to wait (in milliseconds) for output before yielding."),
          max_output_tokens: number().int().min(1).optional().describe("Maximum number of tokens to return. Excess output will be truncated.")
        }),
        execute: async ({ cmd, workdir, shell: shell2, login, tty, yield_time_ms, max_output_tokens }) => await withSandboxSpan("sandbox.exec", {
          cmd,
          workdir,
          shell: shell2,
          login,
          tty,
          run_as: this._runAs
        }, async () => await session.execCommand({
          cmd,
          workdir,
          shell: shell2,
          login,
          tty,
          yieldTimeMs: yield_time_ms,
          maxOutputTokens: max_output_tokens,
          runAs: this._runAs
        }))
      })
    ];
    if (session.supportsPty?.() && session.writeStdin) {
      tools.push(tool({
        name: "write_stdin",
        description: "Writes characters to an existing unified exec session and returns recent output.",
        parameters: object({
          session_id: number().int().describe("Identifier of the running unified exec session."),
          chars: string().default("").describe("Bytes to write to stdin (may be empty to poll)."),
          yield_time_ms: number().int().min(0).default(DEFAULT_WRITE_STDIN_YIELD_TIME_MS).describe("How long to wait (in milliseconds) for output before yielding."),
          max_output_tokens: number().int().min(1).optional().describe("Maximum number of tokens to return. Excess output will be truncated.")
        }),
        execute: async ({ session_id, chars, yield_time_ms, max_output_tokens }) => await withSandboxSpan("sandbox.write_stdin", {
          session_id
        }, async () => await session.writeStdin({
          sessionId: session_id,
          chars,
          yieldTimeMs: yield_time_ms,
          maxOutputTokens: max_output_tokens
        }))
      }));
    }
    return this.configureTools ? this.configureTools([...tools]) : tools;
  }
  instructions() {
    return SHELL_INSTRUCTIONS;
  }
}
function shell(args = {}) {
  return new ShellCapability(args);
}
prompt`
A skill is a set of local instructions to follow that is stored in a \`SKILL.md\` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.
`;
prompt`
### How to use skills
- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its \`SKILL.md\`. Read only enough to follow the workflow.
  2) If \`SKILL.md\` points to extra folders such as \`references/\`, load only the specific files needed for the request; don't bulk-load everything.
  3) If \`scripts/\` exist, prefer running or patching them instead of retyping large code blocks.
  4) If \`assets/\` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from \`SKILL.md\` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
`;
prompt`
### How to use skills
- Discovery: The list above is the skill index available in this session (name + description + workspace path). In lazy mode, those paths are loaded on demand instead of being present up front.
- Trigger rules: If the user names a skill (with \`$SkillName\` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a lazy skill, call \`load_skill\` for that skill first, then open its \`SKILL.md\`.
  2) If \`SKILL.md\` points to extra folders such as \`references/\`, load only the specific files needed for the request; don't bulk-load everything.
  3) If \`scripts/\` exist, prefer running or patching them instead of retyping large code blocks.
  4) If \`assets/\` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from \`SKILL.md\` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
`;
function defaultCapabilities() {
  return [filesystem(), shell(), compaction()];
}
const Capabilities = {
  default: defaultCapabilities
};
class SandboxAgent extends Agent {
  [SANDBOX_AGENT_BRAND] = true;
  defaultManifest;
  baseInstructions;
  capabilities;
  runAs;
  runtimeManifest;
  constructor(config) {
    super(config);
    if (config.baseInstructions !== void 0 && typeof config.baseInstructions !== "string" && typeof config.baseInstructions !== "function") {
      throw new TypeError("SandboxAgent baseInstructions must be a string or function.");
    }
    this.defaultManifest = config.defaultManifest ? cloneManifest(config.defaultManifest) : void 0;
    this.baseInstructions = config.baseInstructions;
    this.capabilities = config.capabilities ?? Capabilities.default();
    this.runAs = normalizeRunAs(config.runAs);
    this.runtimeManifest = this.defaultManifest ?? new Manifest();
  }
  clone(config) {
    return new SandboxAgent({
      name: config.name ?? this.name,
      instructions: config.instructions ?? this.instructions,
      prompt: config.prompt ?? this.prompt,
      handoffDescription: config.handoffDescription ?? this.handoffDescription,
      handoffs: config.handoffs ?? this.handoffs,
      model: config.model ?? this.model,
      modelSettings: config.modelSettings ?? this.modelSettings,
      tools: config.tools ?? this.tools,
      mcpServers: config.mcpServers ?? this.mcpServers,
      mcpConfig: config.mcpConfig ?? this.mcpConfig,
      inputGuardrails: config.inputGuardrails ?? this.inputGuardrails,
      outputGuardrails: config.outputGuardrails ?? this.outputGuardrails,
      outputType: config.outputType ?? this.outputType,
      toolUseBehavior: config.toolUseBehavior ?? this.toolUseBehavior,
      resetToolChoice: config.resetToolChoice ?? this.resetToolChoice,
      defaultManifest: config.defaultManifest ?? this.defaultManifest,
      baseInstructions: config.baseInstructions ?? this.baseInstructions,
      capabilities: config.capabilities ?? this.capabilities,
      runAs: config.runAs ?? this.runAs
    });
  }
}
function normalizeRunAs(runAs) {
  if (runAs === void 0) {
    return void 0;
  }
  if (typeof runAs === "string") {
    const trimmed = runAs.trim();
    if (!trimmed) {
      throw new TypeError("SandboxAgent runAs must be non-empty.");
    }
    return trimmed;
  }
  return normalizeUser(runAs);
}
export {
  SandboxAgent
};
