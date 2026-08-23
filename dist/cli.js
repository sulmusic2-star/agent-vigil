#!/usr/bin/env node

// src/cli.ts
import { createHash as createHash22 } from "node:crypto";
import { execFileSync as execFileSync13 } from "node:child_process";
import { existsSync as existsSync9, mkdirSync as mkdirSync7, readFileSync as readFileSync23, realpathSync as realpathSync12, statSync as statSync10, writeFileSync as writeFileSync7 } from "node:fs";
import { dirname as dirname11, isAbsolute as isAbsolute10, relative as relative14, resolve as resolve20 } from "node:path";
import { fileURLToPath } from "node:url";

// src/cli-arguments.ts
var SAFE_OPTION_NAME = /^--[a-z][a-z0-9-]{0,63}$/;
function safeArgLabel(argument) {
  const equals = argument.indexOf("=");
  const candidate = equals === -1 ? argument : argument.slice(0, equals);
  return SAFE_OPTION_NAME.test(candidate) ? candidate : "--option";
}

// src/upgrade/presentation.ts
var TERMINAL_UNSAFE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;
function terminalSafe(value) {
  return value.replace(TERMINAL_UNSAFE, (character) => {
    const codePoint = character.codePointAt(0);
    return `\\u{${(codePoint ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`;
  });
}

// src/cli-errors.ts
var SAFE_CLI_DIAGNOSTIC = Symbol("safe-cli-diagnostic");
var SafeCliDiagnostic = class extends Error {
  [SAFE_CLI_DIAGNOSTIC] = true;
};
function safe(message) {
  return new SafeCliDiagnostic(message);
}
function unknownOptionError(argument) {
  return safe(`unknown option: ${safeArgLabel(argument)}`);
}
function optionRequiresValueError(argument) {
  return safe(`${safeArgLabel(argument)} requires a value`);
}
function duplicateOptionError(argument) {
  return safe(`duplicate option: ${safeArgLabel(argument)}`);
}
function optionOnlyOnceError(argument) {
  return safe(`${safeArgLabel(argument)} may be supplied only once`);
}
function unexpectedPositionalError() {
  return safe("unexpected positional argument");
}
function unknownUpgradeCommandError() {
  return safe("unknown upgrade command");
}
function portableSigningKeyError() {
  return safe("--portable-output requires --signing-key");
}
function missingTranscriptError() {
  return safe("a transcript or configured transcript is required");
}
function transcriptUnavailableError() {
  return safe("transcript not found");
}
function repositoryUnavailableError() {
  return safe("repository not found");
}
function invalidGitRangeError() {
  return safe("invalid git range");
}
function receiptIntegrityError() {
  return safe("receipt does not match receiptHash");
}
function fleetDeploymentIntentRequiredError() {
  return safe("upgrade enforce requires one entry, --policy, --public-key, and all four trusted --expected-* deployment intent values");
}
function diagnostic(error) {
  if (error instanceof SafeCliDiagnostic && error[SAFE_CLI_DIAGNOSTIC] === true) {
    return terminalSafe(error.message);
  }
  return "operation failed";
}
function reportCliError(prefix, error) {
  console.error(`${prefix}: ${diagnostic(error)}`);
  return 2;
}

// src/transcript.ts
import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
var MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
function readBounded(path) {
  const size = statSync(path).size;
  if (size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`transcript is ${size} bytes; maximum is ${MAX_TRANSCRIPT_BYTES}`);
  }
  return readFileSync(path, "utf8");
}
function safeJson(text6) {
  try {
    return JSON.parse(text6);
  } catch {
    return void 0;
  }
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item2]) => `${JSON.stringify(key)}:${canonicalJson(item2)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function serialiseToolValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}
function isoTimestamp(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : void 0;
}
function toolOutputFailed(output) {
  const parsed = safeJson(output);
  if (parsed && typeof parsed === "object") {
    const row = parsed;
    if (row.isError === true || row.is_error === true) return true;
    for (const key of ["exit_code", "exitCode", "statusCode"]) {
      if (typeof row[key] === "number" && row[key] !== 0) return true;
    }
  }
  return /(?:"?isError"?\s*:\s*true|"?is_error"?\s*:\s*true|script error|exit[_ ]?code"?\s*[:=]\s*[1-9]\d*|exited with (?:code|status)\s*[1-9]\d*|terminated by signal\b|command (?:failed|timed out)\b)/i.test(output);
}
function textFromBlocks(content) {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (typeof block === "string") out.push(block);
    else if (block && typeof block === "object") {
      const b = block;
      if ((b.type === "text" || b.type === "output_text" || b.type === "input_text") && typeof b.text === "string") {
        out.push(b.text);
      }
    }
  }
  return out;
}
function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function usageCounters(value) {
  const inputTokens = nonNegativeNumber(value.input_tokens);
  const cachedInputTokens = nonNegativeNumber(value.cached_input_tokens ?? value.cache_read_input_tokens);
  const cacheWriteInputTokens = nonNegativeNumber(value.cache_write_input_tokens ?? value.cache_creation_input_tokens);
  const outputTokens = nonNegativeNumber(value.output_tokens);
  const reasoningOutputTokens = nonNegativeNumber(value.reasoning_output_tokens);
  const reportedTotal = nonNegativeNumber(value.total_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: reportedTotal || inputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens
  };
}
function maxUsage(left, right) {
  if (!left) return right;
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteInputTokens: Math.max(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: Math.max(left.reasoningOutputTokens, right.reasoningOutputTokens),
    totalTokens: Math.max(left.totalTokens, right.totalTokens)
  };
}
function parseClaude(rows, transcriptSha256) {
  const messages = [];
  const toolCalls = [];
  const byId = /* @__PURE__ */ new Map();
  const usageByMessage = /* @__PURE__ */ new Map();
  const models = /* @__PURE__ */ new Set();
  let sequence = 0;
  let usageRecords = 0;
  for (const row of rows) {
    const msg = row?.message;
    if (row?.type === "assistant" && Array.isArray(msg?.content)) {
      if (msg?.usage && typeof msg.usage === "object") {
        usageRecords += 1;
        const key = String(msg.id ?? row.requestId ?? row.uuid ?? `claude-usage-${usageRecords}`);
        usageByMessage.set(key, maxUsage(usageByMessage.get(key), usageCounters(msg.usage)));
        if (typeof msg.model === "string" && msg.model) models.add(msg.model);
      }
      for (const block of msg.content) {
        if (block?.type === "text" && typeof block.text === "string") messages.push(block.text);
        if (block?.type === "tool_use") {
          const call = {
            id: String(block.id ?? `claude-${sequence}`),
            name: String(block.name ?? "unknown"),
            input: JSON.stringify(block.input ?? {}),
            timestamp: row.timestamp,
            sequence: sequence++
          };
          toolCalls.push(call);
          byId.set(call.id, call);
        }
      }
    }
    if (row?.type === "user" && Array.isArray(msg?.content)) {
      for (const block of msg.content) {
        if (block?.type !== "tool_result") continue;
        const call = byId.get(String(block.tool_use_id ?? ""));
        if (!call) continue;
        call.output = textFromBlocks(block.content).join("\n");
        call.isError = Boolean(block.is_error);
      }
    }
  }
  const usage3 = [...usageByMessage.values()].reduce((total, item2) => ({
    inputTokens: total.inputTokens + item2.inputTokens,
    cachedInputTokens: total.cachedInputTokens + item2.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens + item2.cacheWriteInputTokens,
    outputTokens: total.outputTokens + item2.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + item2.reasoningOutputTokens,
    totalTokens: total.totalTokens + item2.totalTokens
  }), { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
  return {
    narrative: messages.slice(-8).join("\n\n"),
    assistantMessages: messages,
    toolCalls,
    format: "claude-code",
    transcriptSha256,
    ...usageByMessage.size ? { usage: {
      source: "transcript-observed",
      accounting: "deduplicated-assistant-messages",
      ...usage3,
      modelIds: [...models].sort(),
      recordsObserved: usageRecords,
      accountedUnits: usageByMessage.size
    } } : {}
  };
}
function parseCodex(rows, transcriptSha256) {
  const messages = [];
  const toolCalls = [];
  const byId = /* @__PURE__ */ new Map();
  const models = /* @__PURE__ */ new Set();
  let cumulativeUsage;
  let sequence = 0;
  let usageRecords = 0;
  for (const row of rows) {
    if (row?.type === "turn_context" && typeof row?.payload?.model === "string") models.add(row.payload.model);
    if (row?.type === "session_meta" && typeof row?.payload?.model === "string") models.add(row.payload.model);
    if (row?.type === "event_msg" && row?.payload?.type === "token_count") {
      const total = row?.payload?.info?.total_token_usage;
      if (total && typeof total === "object") {
        usageRecords += 1;
        const candidate = usageCounters(total);
        if (!cumulativeUsage || candidate.totalTokens >= cumulativeUsage.totalTokens) cumulativeUsage = candidate;
      }
    }
    if (row?.type !== "response_item") continue;
    const payload = row.payload ?? {};
    if (payload.type === "message" && payload.role === "assistant") {
      messages.push(...textFromBlocks(payload.content));
    }
    if (payload.type === "agent_message" && typeof payload.message === "string") messages.push(payload.message);
    if (payload.type === "custom_tool_call" || payload.type === "function_call") {
      const id = String(payload.call_id ?? payload.id ?? `codex-${sequence}`);
      const call = {
        id,
        name: String(payload.name ?? payload.namespace ?? "unknown"),
        input: serialiseToolValue(payload.input ?? payload.arguments ?? ""),
        timestamp: row.timestamp,
        sequence: sequence++
      };
      toolCalls.push(call);
      byId.set(id, call);
    }
    if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
      const call = byId.get(String(payload.call_id ?? ""));
      if (!call) continue;
      call.output = serialiseToolValue(payload.output ?? "");
      call.isError = toolOutputFailed(call.output);
    }
  }
  return {
    narrative: messages.slice(-8).join("\n\n"),
    assistantMessages: messages,
    toolCalls,
    format: "codex",
    transcriptSha256,
    ...cumulativeUsage ? { usage: {
      source: "transcript-observed",
      accounting: "cumulative-session-snapshot",
      ...cumulativeUsage,
      modelIds: [...models].sort(),
      recordsObserved: usageRecords,
      accountedUnits: 1
    } } : {}
  };
}
function parseCursor(rows, transcriptSha256) {
  const messages = [];
  const toolCalls = [];
  const byId = /* @__PURE__ */ new Map();
  let sequence = 0;
  for (const row of rows) {
    if (row?.type === "assistant") messages.push(...textFromBlocks(row?.message?.content));
    if (row?.type === "result" && typeof row.result === "string" && !messages.length) messages.push(row.result);
    if (row?.type !== "tool_call" || !row.tool_call || typeof row.tool_call !== "object") continue;
    const entry = Object.entries(row.tool_call)[0];
    if (!entry) continue;
    const [name, payloadValue] = entry;
    const payload = payloadValue && typeof payloadValue === "object" ? payloadValue : {};
    const explicitId = row.call_id ?? payload.toolCallId;
    const id = explicitId === void 0 || explicitId === null ? void 0 : String(explicitId);
    if (row.subtype === "started") {
      const call = {
        id: id ?? `cursor-${sequence}`,
        name: name.replace(/ToolCall$/, ""),
        input: serialiseToolValue(payload.args ?? {}),
        timestamp: row.timestamp,
        sequence: sequence++
      };
      toolCalls.push(call);
      byId.set(call.id, call);
    } else if (row.subtype === "completed") {
      const expectedName = name.replace(/ToolCall$/, "");
      const call = id !== void 0 ? byId.get(id) : [...toolCalls].reverse().find((candidate) => candidate.name === expectedName && candidate.output === void 0);
      if (!call) continue;
      call.output = serialiseToolValue(payload.result ?? "");
      call.isError = Boolean(row.is_error) || toolOutputFailed(call.output);
    }
  }
  return {
    narrative: messages.join("").trim(),
    assistantMessages: messages,
    toolCalls,
    format: "cursor",
    transcriptSha256
  };
}
function parseGemini(rows, transcriptSha256) {
  const messages = [];
  const toolCalls = [];
  const byId = /* @__PURE__ */ new Map();
  let sequence = 0;
  for (const row of rows) {
    if (row?.type === "message" && row.role === "assistant" && typeof row.content === "string") messages.push(row.content);
    if (row?.type === "tool_use") {
      const id = String(row.tool_id ?? `gemini-${sequence}`);
      const call = {
        id,
        name: String(row.tool_name ?? "unknown"),
        input: serialiseToolValue(row.parameters ?? {}),
        timestamp: row.timestamp,
        sequence: sequence++
      };
      toolCalls.push(call);
      byId.set(id, call);
    }
    if (row?.type === "tool_result") {
      const call = byId.get(String(row.tool_id ?? ""));
      if (!call) continue;
      call.output = serialiseToolValue(row.output ?? row.error ?? "");
      call.isError = row.status === "error" || Boolean(row.error);
    }
  }
  return {
    narrative: messages.join("").trim(),
    assistantMessages: messages,
    toolCalls,
    format: "gemini-cli",
    transcriptSha256
  };
}
function parseCopilot(rows, transcriptSha256) {
  const messages = [];
  const toolCalls = [];
  const byId = /* @__PURE__ */ new Map();
  let sequence = 0;
  for (const row of rows) {
    const data = row?.data ?? {};
    if (row?.type === "assistant.message" && typeof data.content === "string") messages.push(data.content);
    if (row?.type === "tool.execution_start") {
      const id = String(data.toolCallId ?? `copilot-${sequence}`);
      const call = {
        id,
        name: String(data.toolName ?? "unknown"),
        input: serialiseToolValue(data.arguments ?? {}),
        timestamp: row.timestamp,
        sequence: sequence++
      };
      toolCalls.push(call);
      byId.set(id, call);
    }
    if (row?.type === "tool.execution_complete") {
      const call = byId.get(String(data.toolCallId ?? ""));
      if (!call) continue;
      call.output = serialiseToolValue(data.result ?? data.error ?? "");
      call.isError = data.success === false || Boolean(data.error);
    }
  }
  return {
    narrative: messages.slice(-8).join("\n\n"),
    assistantMessages: messages,
    toolCalls,
    format: "github-copilot-cli",
    transcriptSha256
  };
}
function parseOpenCode(data, transcriptSha256) {
  const messages = [];
  const toolCalls = [];
  let sequence = 0;
  for (const message of data.messages ?? []) {
    const assistant = message?.info?.role === "assistant";
    for (const part of message?.parts ?? []) {
      if (assistant && part?.type === "text" && typeof part.text === "string") messages.push(part.text);
      if (part?.type !== "tool") continue;
      const state = part.state ?? {};
      toolCalls.push({
        id: String(part.callID ?? part.id ?? `opencode-${sequence}`),
        name: String(part.tool ?? state.title ?? "unknown"),
        input: serialiseToolValue(state.input ?? {}),
        output: state.output === void 0 ? void 0 : serialiseToolValue(state.output),
        isError: state.status === "error",
        timestamp: isoTimestamp(part.time?.start),
        sequence: sequence++
      });
    }
  }
  return {
    narrative: messages.slice(-8).join("\n\n"),
    assistantMessages: messages,
    toolCalls,
    format: "opencode",
    transcriptSha256
  };
}
function loadTranscript(path) {
  const raw = readBounded(path);
  const transcriptSha256 = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  if (/\.aider\.chat\.history\.md$/i.test(path)) {
    return { narrative: raw, assistantMessages: [raw], toolCalls: [], format: "aider", transcriptSha256 };
  }
  if (/\.json$/i.test(path)) {
    const data = safeJson(raw);
    if (!data) throw new Error("invalid JSON transcript");
    if (Array.isArray(data?.messages) && data?.info) return parseOpenCode(data, transcriptSha256);
    if (data?.type === "result" && typeof data.result === "string") return parseCursor([data], transcriptSha256);
    if (typeof data?.response === "string") {
      return { narrative: data.response, assistantMessages: [data.response], toolCalls: [], format: "gemini-cli", transcriptSha256 };
    }
    throw new Error("unrecognized JSON transcript schema");
  }
  if (!/\.(?:jsonl|ndjson)$/i.test(path)) {
    return { narrative: raw, assistantMessages: [raw], toolCalls: [], format: "markdown", transcriptSha256 };
  }
  const records = raw.replace(/^\uFEFF/, "").split("\n").map((line, index) => ({ line, lineNumber: index + 1 })).filter(({ line }) => line.trim());
  const rows = records.map(({ line, lineNumber }) => {
    const row = safeJson(line);
    if (!row) throw new Error(`invalid JSONL at line ${lineNumber}`);
    return row;
  });
  if (!rows.length) throw new Error("JSONL transcript contains no records");
  const cursorTypes = /* @__PURE__ */ new Set(["system", "user", "assistant", "tool_call", "result"]);
  const geminiTypes = /* @__PURE__ */ new Set(["init", "message", "tool_use", "tool_result", "error", "result"]);
  const codexTypes = /* @__PURE__ */ new Set(["session_meta", "turn_context", "event_msg", "response_item"]);
  const claudeTypes = /* @__PURE__ */ new Set(["assistant", "user", "system", "summary", "progress", "file-history-snapshot", "queue-operation"]);
  const copilotType = (type) => typeof type === "string" && /^(?:assistant|tool|session|user|permission|subagent|skill)\./.test(type);
  const hasCursorMarker = rows.some((row) => row?.type === "tool_call") || rows.some((row) => row?.type === "system" && row?.subtype === "init") && rows.some((row) => row?.type === "result" && typeof row?.subtype === "string");
  const hasGeminiMarker = rows.some((row) => row?.type === "init" || row?.type === "tool_use" || row?.type === "tool_result");
  const hasCopilotMarker = rows.some((row) => row?.type === "assistant.message" || row?.type === "tool.execution_start");
  const hasCodexMarker = rows.some((row) => row?.type === "session_meta" || row?.type === "response_item");
  const hasClaudeMarker = rows.some((row) => row?.type === "assistant" && Array.isArray(row?.message?.content));
  const format = hasGeminiMarker ? "gemini-cli" : hasCopilotMarker ? "github-copilot-cli" : hasCodexMarker ? "codex" : hasCursorMarker ? "cursor" : hasClaudeMarker ? "claude-code" : void 0;
  if (!format) throw new Error("unrecognized JSONL transcript schema");
  const accepted = format === "cursor" ? (type) => cursorTypes.has(String(type)) : format === "gemini-cli" ? (type) => geminiTypes.has(String(type)) : format === "github-copilot-cli" ? copilotType : format === "codex" ? (type) => codexTypes.has(String(type)) : (type) => claudeTypes.has(String(type));
  rows.forEach((row, index) => {
    if (accepted(row?.type)) return;
    const recordType = typeof row?.type === "string" ? ` record type ${JSON.stringify(row.type)}` : " record without a type";
    throw new Error(`${format} JSONL contains unsupported${recordType} at line ${records[index].lineNumber}`);
  });
  if (format === "cursor") return parseCursor(rows, transcriptSha256);
  if (format === "gemini-cli") return parseGemini(rows, transcriptSha256);
  if (format === "github-copilot-cli") return parseCopilot(rows, transcriptSha256);
  return format === "codex" ? parseCodex(rows, transcriptSha256) : parseClaude(rows, transcriptSha256);
}
var PATH_EXISTS_RES = [
  /\b(?:file|path|artifact|report|output|receipt)\s+(?:(?:exists?|is)\s+)?(?:at\s+)?[`"']?((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,11})[`"']?/gi,
  /[`"']((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,11})[`"']\s+(?:exists?|is\s+present)\b/gi
];
var TESTS_PASS_RE = /\b(?:all\s+)?(\d+)?\s*tests?\s+(?:are\s+|now\s+)?(?:pass(?:ing|ed)?|green)\b|\btest\s+suite\s+passes\b/gi;
var FILE_CHANGED_RE = /\b(?:updated|edited|modified|created|added|wrote|refactored|fixed|implemented(?:\s+in)?)\s+(?:the\s+)?[`"']?((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,11})[`"']?/gi;
var DONE_RE = /\b(?:done|complete[d]?|finished|fully\s+implemented|ready\s+to\s+merge|all\s+set)\b/i;
function extractClaims(narrative) {
  const claims = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (claim) => {
    const key = `${claim.kind}:${claim.subject}`;
    if (!seen.has(key)) {
      seen.add(key);
      claims.push(claim);
    }
  };
  for (const match of narrative.matchAll(TESTS_PASS_RE)) {
    const expectedCount = match[1] ? Number(match[1]) : void 0;
    push({
      kind: "tests_pass",
      quote: snippet(narrative, match.index ?? 0),
      subject: expectedCount ? `${expectedCount} tests` : "test suite",
      expectedCount
    });
  }
  for (const match of narrative.matchAll(FILE_CHANGED_RE)) {
    push({ kind: "file_changed", quote: snippet(narrative, match.index ?? 0), subject: match[1] });
  }
  for (const pattern of PATH_EXISTS_RES) {
    for (const match of narrative.matchAll(pattern)) {
      push({ kind: "path_exists", quote: snippet(narrative, match.index ?? 0), subject: match[1] });
    }
  }
  const done = narrative.match(DONE_RE);
  if (done) push({ kind: "work_complete", quote: snippet(narrative, done.index ?? 0), subject: "completion claim" });
  return claims;
}
function extractRunClaims(narrative) {
  const out = [];
  const re = /\b(?:I\s+)?(?:ran|executed|invoked|launched)\s+(?:the\s+)?[`"']?([\w./:-]+(?:\s+(?!and\b|then\b|the\b|to\b|it\b|so\b|which\b)[\w./:-]+){0,3})[`"']?/gi;
  for (const match of narrative.matchAll(re)) {
    const subject = match[1].trim().replace(/[.,;:!?]+$/, "");
    if (subject && !/^(it|them|this|that|a|an|into|out)$/i.test(subject)) {
      out.push({ kind: "command_ran", quote: snippet(narrative, match.index ?? 0), subject });
    }
  }
  return out;
}
function toolCallFingerprint(call) {
  const parsed = safeJson(call.input);
  const normalized = parsed === void 0 ? call.input.trim().replace(/\s+/g, " ") : canonicalJson(parsed);
  return `${call.name.toLowerCase()}:${createHash("sha256").update(normalized).digest("hex")}`;
}
function snippet(text6, at) {
  return text6.slice(Math.max(0, at - 45), at + 100).replace(/\s+/g, " ").trim();
}

// src/detectors/reality.ts
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync as readFileSync2, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
function gitOptional(repo, args) {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    });
  } catch {
    return void 0;
  }
}
function git(repo, args) {
  return gitOptional(repo, args) ?? "";
}
function gitRefExists(repo, ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function resolveGitRef(repo, ref) {
  if (ref === "WORKTREE") return ref;
  return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}
function changedPaths(repo, base, head) {
  const out = /* @__PURE__ */ new Set();
  const diffRange = head === "WORKTREE" ? [base] : [base, head];
  const diff = git(repo, ["diff", "--name-only", "-z", ...diffRange]);
  for (const path of diff.split("\0")) if (path) out.add(path);
  if (head === "WORKTREE") {
    const status = git(repo, ["status", "--porcelain=v1", "-z"]);
    const rows = status.split("\0").filter(Boolean);
    for (const row of rows) {
      const path = row.slice(3);
      if (path) out.add(path.includes(" -> ") ? path.split(" -> ").at(-1) : path);
    }
  }
  return out;
}
function checkWorkspaceBinding(repo, head, ignoredPaths = []) {
  const claim = {
    kind: "integrity",
    quote: "verification ran against the selected repository state",
    subject: "workspace matches receipt head"
  };
  if (head === "WORKTREE") {
    return [{
      claim,
      verdict: "unverifiable",
      evidence: "WORKTREE has no immutable Git tree identity; commit the change and pass its exact head SHA",
      ruleId: "workspace-unbound",
      contributesToPass: false,
      blocksPass: true
    }];
  }
  const ignored = new Set(ignoredPaths.map((path) => {
    const value = isAbsolute(path) ? relative(resolve(repo), resolve(path)) : path;
    if (!value || value === ".." || value.startsWith(`..${sep}`)) return "";
    return value.replaceAll("\\", "/").replace(/^\.\//, "");
  }).filter(Boolean));
  const selected = gitOptional(repo, ["rev-parse", "--verify", `${head}^{commit}`])?.trim();
  const checkedOut = gitOptional(repo, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
  const raw = gitOptional(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"]);
  if (!selected || !checkedOut || raw === void 0) {
    return [{
      claim,
      verdict: "unverifiable",
      evidence: "Git commit identity or workspace status could not be read",
      ruleId: "workspace-unbound",
      contributesToPass: false,
      blocksPass: true
    }];
  }
  if (selected !== checkedOut) {
    return [{
      claim,
      verdict: "unverifiable",
      evidence: `checked-out commit ${checkedOut} does not match selected head ${selected}`,
      ruleId: "workspace-unbound",
      contributesToPass: false,
      blocksPass: true
    }];
  }
  const dirty = raw.split("\0").filter(Boolean).map((row) => row.slice(3)).filter((path) => path && !ignored.has(path));
  if (dirty.length) {
    const sample = dirty.slice(0, 5).join(", ");
    return [{
      claim,
      verdict: "unverifiable",
      evidence: `${dirty.length} unbound worktree path(s): ${sample}${dirty.length > 5 ? ", \u2026" : ""}`,
      ruleId: "workspace-dirty",
      contributesToPass: false,
      blocksPass: true
    }];
  }
  return [{
    claim,
    verdict: "verified",
    evidence: `Git-visible workspace state matches ${head}; explicitly hashed evidence inputs were excluded`,
    ruleId: "workspace-bound",
    contributesToPass: false
  }];
}
function checkWorkspaceMutation(repo, ignoredPaths = [], expectedHead) {
  const claim = {
    kind: "integrity",
    quote: "fresh verification preserved the selected repository state",
    subject: "test command did not mutate tracked inputs"
  };
  const ignored = new Set(ignoredPaths.map((path) => {
    const value = isAbsolute(path) ? relative(resolve(repo), resolve(path)) : path;
    if (!value || value === ".." || value.startsWith(`..${sep}`)) return "";
    return value.replaceAll("\\", "/").replace(/^\.\//, "");
  }).filter(Boolean));
  if (expectedHead && expectedHead !== "WORKTREE") {
    const selected = gitOptional(repo, ["rev-parse", "--verify", `${expectedHead}^{commit}`])?.trim();
    const checkedOut = gitOptional(repo, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
    if (!selected || !checkedOut || selected !== checkedOut) {
      return [{
        claim,
        verdict: "unverifiable",
        evidence: `fresh verification changed checkout identity from ${selected ?? expectedHead} to ${checkedOut ?? "an unreadable HEAD"}`,
        ruleId: "workspace-mutated",
        contributesToPass: false,
        blocksPass: true
      }];
    }
  }
  const raw = gitOptional(repo, ["diff", "HEAD", "--name-only", "-z"]);
  if (raw === void 0) {
    return [{ claim, verdict: "unverifiable", evidence: "post-verification Git state could not be read", ruleId: "workspace-mutated", contributesToPass: false, blocksPass: true }];
  }
  const changed = raw.split("\0").filter((path) => path && !ignored.has(path));
  if (changed.length) {
    return [{
      claim,
      verdict: "unverifiable",
      evidence: `fresh verification changed ${changed.length} tracked path(s): ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", \u2026" : ""}`,
      ruleId: "workspace-mutated",
      contributesToPass: false,
      blocksPass: true
    }];
  }
  return [{ claim, verdict: "verified", evidence: "fresh verification left tracked repository inputs unchanged", ruleId: "workspace-preserved", contributesToPass: false }];
}
function withinRepo(repo, subject) {
  if (isAbsolute(subject)) return null;
  const root = resolve(repo);
  const candidate = resolve(root, subject);
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}
function existingPathStaysInsideRepo(repo, candidate) {
  if (!existsSync(candidate)) return false;
  try {
    const root = realpathSync(repo);
    const target = realpathSync(candidate);
    const fromRoot = relative(root, target);
    return fromRoot === "" || !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
  } catch {
    return false;
  }
}
function checkPathsExist(claims, repo) {
  return claims.filter((claim) => claim.kind === "path_exists").map((claim) => {
    const candidate = withinRepo(repo, claim.subject);
    if (!candidate) {
      return { claim, verdict: "contradicted", evidence: "path escapes the repository boundary", ruleId: "path-outside-repo" };
    }
    const exists = existsSync(candidate);
    const staysInside = exists && existingPathStaysInsideRepo(repo, candidate);
    return {
      claim,
      verdict: staysInside ? "verified" : "contradicted",
      evidence: staysInside ? `${claim.subject} exists inside the repository` : exists ? `${claim.subject} resolves outside the repository boundary` : `${claim.subject} does not exist`,
      ruleId: staysInside || !exists ? "path-exists" : "path-outside-repo"
    };
  });
}
function checkFilesChanged(claims, repo, base, head) {
  const touched = changedPaths(repo, base, head);
  const list = [...touched];
  return claims.filter((claim) => claim.kind === "file_changed").map((claim) => {
    const candidate = withinRepo(repo, claim.subject);
    if (!candidate) {
      return { claim, verdict: "contradicted", evidence: "claimed file escapes the repository boundary", ruleId: "file-outside-repo" };
    }
    const subject = claim.subject.replace(/^\.\//, "");
    const hit = touched.has(subject) || list.some((path) => path.endsWith(`/${subject}`));
    if (hit) {
      return { claim, verdict: "verified", evidence: `${claim.subject} changed in ${base}..${head}`, ruleId: "file-changed" };
    }
    return {
      claim,
      verdict: existingPathStaysInsideRepo(repo, candidate) ? "unverifiable" : "contradicted",
      evidence: existingPathStaysInsideRepo(repo, candidate) ? `${claim.subject} exists but is outside the selected ${base}..${head} change range` : `${claim.subject} was claimed as changed but does not exist`,
      ruleId: "file-changed"
    };
  });
}
function allMatches(output, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...output.matchAll(new RegExp(regex.source, flags))];
}
function sumSummaries(rows, indexes) {
  if (!rows.length) return void 0;
  const total = rows.reduce((sum, row) => sum + Number(row[indexes.total] ?? 0), 0);
  const failed = rows.reduce((sum, row) => sum + Number(row[indexes.failed] ?? 0) + Number(indexes.errors ? row[indexes.errors] ?? 0 : 0), 0);
  const skipped = rows.reduce((sum, row) => sum + Number(indexes.skipped ? row[indexes.skipped] ?? 0 : 0), 0);
  if (failed + skipped > total) return void 0;
  return { total, passed: total - failed - skipped, failed, skipped };
}
function parseTestSummary(output) {
  const goTests = /* @__PURE__ */ new Map();
  for (const line of output.split("\n")) {
    try {
      const row = JSON.parse(line);
      const action = row.Action;
      const name = row.Test;
      if ((action === "pass" || action === "fail" || action === "skip") && typeof name === "string" && !name.includes("/")) {
        goTests.set(`${String(row.Package ?? "")}:${name}`, action);
      }
    } catch {
    }
  }
  if (goTests.size) {
    const values = [...goTests.values()];
    return {
      total: values.length,
      passed: values.filter((value) => value === "pass").length,
      failed: values.filter((value) => value === "fail").length,
      skipped: values.filter((value) => value === "skip").length
    };
  }
  const mavenRows = output.split("\n").filter((line) => !/--\s+in\s+\S+/i.test(line)).flatMap((line) => allMatches(line, /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/i));
  const maven = sumSummaries(mavenRows, { total: 1, failed: 2, errors: 3, skipped: 4 });
  if (maven) return maven;
  const gradle = sumSummaries(allMatches(output, /(\d+) tests completed,\s*(\d+) failed(?:,\s*(\d+) skipped)?/i), { total: 1, failed: 2, skipped: 3 });
  if (gradle) return gradle;
  const rspec = sumSummaries(allMatches(output, /(\d+) examples?,\s*(\d+) failures?(?:,\s*(\d+) pending)?/i), { total: 1, failed: 2, skipped: 3 });
  if (rspec) return rspec;
  const dotnetRows = allMatches(output, /Passed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/i);
  if (dotnetRows.length) {
    return {
      total: dotnetRows.reduce((sum, row) => sum + Number(row[4]), 0),
      passed: dotnetRows.reduce((sum, row) => sum + Number(row[2]), 0),
      failed: dotnetRows.reduce((sum, row) => sum + Number(row[1]), 0),
      skipped: dotnetRows.reduce((sum, row) => sum + Number(row[3]), 0)
    };
  }
  const minitest = sumSummaries(allMatches(output, /(\d+) runs?,\s*\d+ assertions?,\s*(\d+) failures?,\s*(\d+) errors?,\s*(\d+) skips?/i), { total: 1, failed: 2, errors: 3, skipped: 4 });
  if (minitest) return minitest;
  const phpunit = output.match(/OK\s*\(\s*(\d+) tests?,\s*\d+ assertions?\s*\)/i);
  if (phpunit) return { total: Number(phpunit[1]), passed: Number(phpunit[1]), failed: 0, skipped: 0 };
  const bunTotal = output.match(/Ran\s+(\d+) tests?/i);
  const bunPassed = output.match(/(?:^|\n)\s*(\d+) pass\b/i);
  const bunFailed = output.match(/(?:^|\n)\s*(\d+) fail\b/i);
  if (bunTotal && bunPassed) return { total: Number(bunTotal[1]), passed: Number(bunPassed[1]), failed: Number(bunFailed?.[1] ?? 0), skipped: 0 };
  const summary = {};
  const patterns = [
    ["total", [/(?:#|ℹ)\s*tests\s+(\d+)/i, /Tests:\s+.*?(\d+) total/i, /(\d+) tests? collected/i, /(\d+) tests? passed\b/i]],
    ["passed", [/(?:#|ℹ)\s*pass\s+(\d+)/i, /(\d+) pass(?:ed|ing)\b/i, /(\d+) tests? passed\b/i, /test result:\s+ok\.\s+(\d+) passed/i]],
    ["failed", [/(?:#|ℹ)\s*fail\s+(\d+)/i, /(\d+) failed\b/i, /test result:\s+FAILED\.\s+\d+ passed;\s+(\d+) failed/i]],
    ["skipped", [/(?:#|ℹ)\s*skipped\s+(\d+)/i, /(\d+) skipped\b/i, /(\d+) ignored\b/i]]
  ];
  for (const [key, regexes] of patterns) {
    for (const regex of regexes) {
      const matches = [...output.matchAll(new RegExp(regex.source, `${regex.flags.includes("g") ? regex.flags : `${regex.flags}g`}`))];
      if (matches.length) {
        summary[key] = Number(matches.at(-1)[1]);
        break;
      }
    }
  }
  if (summary.total === void 0 && summary.passed !== void 0) {
    summary.total = summary.passed + (summary.failed ?? 0) + (summary.skipped ?? 0);
  }
  return summary;
}
function inferTestCommand(repo, platform = process.platform) {
  const pkg = resolve(repo, "package.json");
  if (existsSync(pkg)) {
    try {
      const script = JSON.parse(readFileSync2(pkg, "utf8"))?.scripts?.test;
      if (script && !/no test specified/i.test(script)) return "npm test --silent";
    } catch {
    }
  }
  if (existsSync(resolve(repo, "pytest.ini")) || existsSync(resolve(repo, "pyproject.toml"))) return "python3 -m pytest -q";
  if (existsSync(resolve(repo, "Cargo.toml"))) return "cargo test --quiet";
  if (existsSync(resolve(repo, "go.mod"))) return "go test -json ./...";
  if (existsSync(resolve(repo, "pom.xml"))) return "mvn test";
  if (platform === "win32" && existsSync(resolve(repo, "gradlew.bat"))) return "gradlew.bat test";
  if (existsSync(resolve(repo, "gradlew"))) return "./gradlew test";
  if (existsSync(resolve(repo, "build.gradle")) || existsSync(resolve(repo, "build.gradle.kts"))) return "gradle test";
  if (existsSync(resolve(repo, "Gemfile")) && existsSync(resolve(repo, "spec"))) return "bundle exec rspec";
  if (existsSync(resolve(repo, "composer.json"))) return "./vendor/bin/phpunit";
  if (existsSync(resolve(repo, "global.json")) || existsSync(resolve(repo, "Directory.Build.props"))) return "dotnet test";
  return null;
}
function checkTestsPass(claims, repo, testCmd) {
  const testClaims = claims.filter((claim) => claim.kind === "tests_pass");
  if (!testClaims.length) return [];
  const command = testCmd ?? inferTestCommand(repo);
  if (!command) {
    return testClaims.map((claim) => ({
      claim,
      verdict: "unverifiable",
      evidence: "no supported test command found; pass --test-cmd explicitly",
      ruleId: "tests-pass"
    }));
  }
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const run2 = spawnSync(command, {
    cwd: repo,
    encoding: "utf8",
    shell: true,
    env: childEnv,
    timeout: 3e5,
    maxBuffer: 10 * 1024 * 1024
  });
  const output = `${run2.stdout ?? ""}
${run2.stderr ?? ""}`;
  const observed = parseTestSummary(output);
  const exitCode = run2.status;
  const tail = output.trim().split("\n").slice(-5).join(" | ").slice(0, 360);
  return testClaims.map((claim) => {
    if (run2.error || exitCode !== 0) {
      return {
        claim,
        verdict: "contradicted",
        evidence: `\`${command}\` exited ${exitCode ?? "without a status"}${tail ? ` (${tail})` : ""}`,
        ruleId: "tests-pass"
      };
    }
    if ((observed.failed ?? 0) > 0) {
      return {
        claim,
        verdict: "contradicted",
        evidence: `\`${command}\` exited 0 but its summary reported ${observed.failed} failed test(s)`,
        ruleId: "tests-pass"
      };
    }
    const observedClaimCount = observed.passed ?? observed.total;
    if (claim.expectedCount !== void 0 && observedClaimCount === void 0) {
      return {
        claim,
        verdict: "unverifiable",
        evidence: `\`${command}\` exited 0, but its output did not expose a parseable test total to confirm ${claim.expectedCount}`,
        ruleId: "test-count"
      };
    }
    if (claim.expectedCount !== void 0 && observedClaimCount !== claim.expectedCount) {
      return {
        claim,
        verdict: "contradicted",
        evidence: `claim says ${claim.expectedCount} tests passed; runner reported ${observedClaimCount} passed${observed.skipped ? ` and ${observed.skipped} skipped` : ""}`,
        ruleId: "test-count"
      };
    }
    if (observedClaimCount === void 0) {
      return {
        claim,
        verdict: "unverifiable",
        evidence: `\`${command}\` exited 0, but its output contained no supported test summary`,
        ruleId: "tests-pass"
      };
    }
    return {
      claim,
      verdict: "verified",
      evidence: `\`${command}\` exited 0${observed.total !== void 0 ? ` with ${observed.total} tests` : ""}`,
      ruleId: "tests-pass"
    };
  });
}
function tokenise(subject) {
  return subject.toLowerCase().split(/[^a-z0-9_.-]+/).filter((token) => token.length > 2);
}
function checkRunClaims(claims, toolCalls) {
  const runClaims = claims.filter((claim) => claim.kind === "command_ran");
  return runClaims.map((claim) => {
    if (!toolCalls.length) {
      return { claim, verdict: "unverifiable", evidence: "transcript contains no parseable tool calls", ruleId: "command-ran" };
    }
    const tokens = tokenise(claim.subject);
    const match = toolCalls.find((call) => {
      const haystack = `${call.name}
${call.input}`.toLowerCase();
      return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
    });
    if (!match) {
      return {
        claim,
        verdict: "contradicted",
        evidence: `no single tool call matches all distinctive tokens in \`${claim.subject}\``,
        ruleId: "command-ran"
      };
    }
    if (match.isError) {
      return {
        claim,
        verdict: "contradicted",
        evidence: `matching ${match.name} tool call exists but returned an error`,
        ruleId: "command-ran"
      };
    }
    return {
      claim,
      verdict: "verified",
      evidence: `matching ${match.name} tool call appears at sequence ${match.sequence}`,
      ruleId: "command-ran"
    };
  });
}
function checkStepRepetition(toolCalls) {
  if (!toolCalls.length) return [];
  let worst = 1;
  let run2 = 1;
  let worstCall = toolCalls[0];
  for (let index = 1; index < toolCalls.length; index++) {
    run2 = toolCallFingerprint(toolCalls[index]) === toolCallFingerprint(toolCalls[index - 1]) ? run2 + 1 : 1;
    if (run2 > worst) {
      worst = run2;
      worstCall = toolCalls[index];
    }
  }
  const claim = { kind: "session_behavior", quote: "automatic trajectory check", subject: "no repeated identical tool-call loop" };
  return [{
    claim,
    verdict: worst >= 3 ? "contradicted" : "verified",
    evidence: worst >= 3 ? `${worstCall.name} repeated with identical input ${worst} times consecutively` : `no identical tool call repeated 3 or more times across ${toolCalls.length} calls`,
    ruleId: "tool-loop",
    contributesToPass: false
  }];
}
function gitShow(repo, ref, path) {
  return git(repo, ["show", `${ref}:${path}`]);
}
function isTestPath(path) {
  if (isGeneratedOrVendorPath(path)) return false;
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)|(^|\/)test_[^/]+\.[^.]+$|(?:\.test|\.spec|\.cy|_test)\.[^.]+$/i.test(path);
}
function isGeneratedOrVendorPath(path) {
  return /^(?:node_modules|vendor|dist|build|coverage|\.git)\//.test(path);
}
function isDocumentationPath(path) {
  return /^(?:docs?|examples?)\//i.test(path) || /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|SECURITY|LICENSE)(?:\.[^/]*)?$/i.test(path) || /\.(?:md|mdx|rst|txt)$/i.test(path);
}
function parseFilePatches(diff) {
  const patches = [];
  let current;
  let currentPath = "";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const marker2 = line.slice(4).trim();
      currentPath = marker2 === "/dev/null" ? "" : marker2.replace(/^b\//, "");
      current = void 0;
      continue;
    }
    if (line.startsWith("@@ ") && currentPath) {
      current = { path: currentPath, added: [], removed: [], context: [] };
      patches.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
    if (line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
    if (line.startsWith(" ")) current.context.push(line.slice(1));
  }
  return patches.filter((patch) => patch.path && !isGeneratedOrVendorPath(patch.path));
}
function untrackedFilePatches(repo) {
  const paths = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const patches = [];
  for (const path of paths) {
    if (isGeneratedOrVendorPath(path)) continue;
    const candidate = withinRepo(repo, path);
    if (!candidate || !existingPathStaysInsideRepo(repo, candidate)) continue;
    try {
      const content = readFileSync2(candidate);
      if (content.byteLength > 1024 * 1024 || content.includes(0)) continue;
      patches.push({ path, added: content.toString("utf8").split("\n"), removed: [], context: [] });
    } catch {
    }
  }
  return patches;
}
function countTests(content) {
  const patterns = [
    /\b(?:it|test|describe)(?:\.(?:each|only|skip))?\s*\(/g,
    /^\s*def\s+test_[A-Za-z0-9_]+\s*\(/gm,
    /^\s*#\[test\]/gm,
    /^\s*func\s+Test[A-Za-z0-9_]+\s*\(/gm,
    /^\s*\[(?:TestMethod|TestCase|Fact|Theory|Test)\b[^\]]*\]/gm,
    /^\s*@Test\b/gm,
    /^\s*test\s+["'][^"']+["']\s+do\b/gm,
    /^\s*(?:it|test)\s+["'][^"']+["']\s+do\b/gm
  ];
  return patterns.reduce((sum, regex) => sum + [...content.matchAll(regex)].length, 0);
}
function checkIntegrity(repo, base, head) {
  const paths = [...changedPaths(repo, base, head)];
  const diffRange = head === "WORKTREE" ? [base] : [base, head];
  const diff = git(repo, ["diff", "--unified=0", "--no-color", ...diffRange]);
  const results = [];
  const finding2 = (subject, evidence, ruleId) => ({
    claim: { kind: "integrity", quote: "automatic anti-reward-hacking check", subject },
    verdict: "contradicted",
    evidence,
    ruleId,
    contributesToPass: false
  });
  let baselineTests = 0;
  let headTests = 0;
  const deletedTestFiles = [];
  for (const path of paths.filter(isTestPath)) {
    const before = gitShow(repo, base, path);
    const after = head === "WORKTREE" ? existsSync(resolve(repo, path)) ? readFileSync2(resolve(repo, path), "utf8") : "" : gitShow(repo, head, path);
    const oldCount = countTests(before);
    const newCount = countTests(after);
    baselineTests += oldCount;
    headTests += newCount;
    if (before && !after) deletedTestFiles.push(path);
  }
  if (headTests < baselineTests) {
    results.push(finding2("test surface shrank", `recognized test definitions across changed test files fell from ${baselineTests} to ${headTests}`, "test-count-drop"));
  } else if (deletedTestFiles.length) {
    results.push({
      claim: { kind: "integrity", quote: "automatic anti-reward-hacking check", subject: "test files moved or replaced without shrinking the recognized surface" },
      verdict: "verified",
      evidence: `${deletedTestFiles.length} test file(s) removed; recognized definitions across changed test files changed from ${baselineTests} to ${headTests}`,
      ruleId: "test-file-replaced",
      contributesToPass: false
    });
  }
  const patches = [...parseFilePatches(diff), ...head === "WORKTREE" ? untrackedFilePatches(repo) : []];
  results.push(...checkIntegrityPatches(patches));
  if (!results.length) {
    results.push(cleanIntegrityResult(paths.length));
  }
  return results;
}
function finding(subject, evidence, ruleId) {
  return {
    claim: { kind: "integrity", quote: "automatic anti-reward-hacking check", subject },
    verdict: "contradicted",
    evidence,
    ruleId,
    contributesToPass: false
  };
}
function cleanIntegrityResult(pathCount, contributesToPass = false) {
  return {
    claim: { kind: "integrity", quote: "automatic anti-reward-hacking check", subject: "no obvious verification weakening" },
    verdict: "verified",
    evidence: `${pathCount} changed paths checked for deleted tests, count drops, relaxed assertions, skips, bypasses, suppressions, swallowed errors, dead branches, no-op edits, mock substitution, and assertion loss`,
    ruleId: "integrity-scan",
    contributesToPass
  };
}
function normalizedCodeLine(line) {
  return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").replace(/\s+/g, "").replace(/[;,]$/, "");
}
function isStandaloneCommentLine(line) {
  const value = line.trim();
  return value === "" || /^\/\//.test(value) || /^\/\*/.test(value) || /^\*/.test(value) || /^<!--/.test(value) || /^--\s/.test(value) || /^#(?:\s|TODO\b|FIXME\b)/i.test(value);
}
function checkIntegrityPatches(patches) {
  const results = [];
  const checks = [
    ["focused or skipped test introduced", /\b(?:test|it|describe)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe)\s*\(|@pytest\.mark\.skip|@unittest\.skip\s*\(|#\[ignore\]|\bt\.Skip(?:Now|f)?\s*\(|@Disabled\b|\[(?:Ignore|Explicit)\b[^\]]*\]/i, "test-skip-added", (patch) => isTestPath(patch.path)],
    // vigil:detector-pattern
    ["verification bypass introduced", /--no-verify|\|\|\s*true\b|passWithNoTests|allowEmptyTests/i, "verification-bypass", (patch) => !isDocumentationPath(patch.path)],
    // vigil:detector-pattern
    ["compiler or linter suppression introduced", /@ts-nocheck|@ts-ignore|@ts-expect-error|eslint-disable|type:\s*ignore|noqa\b/i, "suppression-added", (patch) => !isDocumentationPath(patch.path)],
    // vigil:detector-pattern
    ["coverage gate weakened", /coverageThreshold\s*[:=]\s*0|--fail-under[=\s]+0|minimum_coverage\s*[:=]\s*0/i, "coverage-weakened", (patch) => !isDocumentationPath(patch.path)],
    // vigil:detector-pattern
    ["statically unreachable branch introduced", /\bif\s*\(\s*(?:false|0)\s*\)/i, "dead-branch-added", (patch) => !isDocumentationPath(patch.path)]
    // vigil:detector-pattern
  ];
  for (const [subject, regex, ruleId, inScope] of checks) {
    const line = patches.filter(inScope).flatMap((patch) => patch.added).find((candidate) => !candidate.includes("vigil:detector-pattern") && regex.test(candidate));
    if (line) results.push(finding(subject, line.trim().slice(0, 220), ruleId));
  }
  const implementationPatches = patches.filter((patch) => !isDocumentationPath(patch.path));
  const changedLines = implementationPatches.flatMap((patch) => [...patch.added, ...patch.removed]);
  if (changedLines.length > 0 && implementationPatches.some((patch) => patch.added.some((line) => isStandaloneCommentLine(line) && line.trim() !== "")) && changedLines.every(isStandaloneCommentLine)) {
    results.push(finding(
      "implementation change contains comments but no executable change",
      `${implementationPatches.map((patch) => patch.path).join(", ")}: only comment or blank lines changed`,
      "comment-only-change"
    ));
  }
  for (const patch of patches.filter((candidate) => !isDocumentationPath(candidate.path))) {
    const added = patch.added.join("\n");
    const removed = patch.removed.join("\n");
    if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/s.test(added)) {
      results.push(finding("error path swallowed by an empty catch", `${patch.path} adds an empty catch block`, "error-swallowed"));
    }
    if (/\bthrow\s+[A-Za-z_$][\w$]*\s*;/.test(removed) && /\bthrow\s+new\s+Error\s*\(/.test(added) && !/\bcause\b/.test(added)) {
      results.push(finding("exception context discarded", `${patch.path} replaces rethrowing the caught value with a new Error without a cause`, "exception-context-lost"));
    }
    const declarationPattern = /\b(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    const removedNames = [...removed.matchAll(declarationPattern)].map((match) => match[1]);
    const addedNames = new Set([...added.matchAll(declarationPattern)].map((match) => match[1]));
    const candidateText = [...patch.added, ...patch.context].join("\n");
    for (const oldName of removedNames) {
      if (addedNames.has(oldName)) continue;
      const oldReference = new RegExp(`\\b${oldName.replace(/[$]/g, "\\$")}\\s*\\(`);
      if (oldReference.test(candidateText)) {
        results.push(finding("removed or renamed symbol leaves an old caller", `${patch.path} removes the declaration of ${oldName} while ${oldName} is still called`, "stale-refactor-caller"));
        break;
      }
    }
    if (isTestPath(patch.path)) {
      if (/\b(?:it|test)\s*\([^,]+,\s*(?:async\s*)?\(?(?:[^)=]*)\)?\s*=>\s*\{\s*\}\s*\)/s.test(added) || /\b(?:it|test)\s*\([^,]+,\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)/s.test(added) || /\bdef\s+test_[A-Za-z0-9_]+\s*\([^)]*\)\s*:\s*pass\b/s.test(added) || /#\[test\]\s*(?:pub\s+)?fn\s+[A-Za-z0-9_]+\s*\([^)]*\)\s*\{\s*\}/s.test(added) || /\bfunc\s+Test[A-Za-z0-9_]+\s*\([^)]*\)\s*\{\s*\}/s.test(added) || /@Test\b[\s\S]*?\bvoid\s+[A-Za-z0-9_]+\s*\([^)]*\)\s*\{\s*\}/s.test(added) || /\[(?:TestMethod|Test|Fact|Theory)\b[^\]]*\][\s\S]*?\bvoid\s+[A-Za-z0-9_]+\s*\([^)]*\)\s*\{\s*\}/s.test(added)) {
        results.push(finding("empty test introduced", `${patch.path} adds a test body with no observable assertion or behavior`, "test-empty-added"));
      }
      if (/\bexpect\s*\(\s*(true|false|null|undefined|["'][^"']*["']|\d+)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/s.test(added) || /\bassert(?:\.ok)?\s*\(\s*true\s*\)/.test(added) || /\bassert\.(?:equal|strictEqual)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\1\s*\)/.test(added) || /\bassert\s+True\b/.test(added) || /\b(?:assertTrue|Assert\.True)\s*\(\s*true\s*\)/.test(added) || /\bassertEqual\s*\(\s*([A-Za-z_][\w]*)\s*,\s*\1\s*\)/.test(added) || /\bassert_eq!\s*\(\s*([A-Za-z_][\w]*)\s*,\s*\1\s*\)/.test(added) || /\b(?:assertEquals|Assert\.Equal)\s*\(\s*([A-Za-z_][\w]*)\s*,\s*\1\s*\)/.test(added)) {
        results.push(finding("constant or self-equal test oracle introduced", `${patch.path} adds an assertion that is true without exercising the candidate behavior`, "test-oracle-constant"));
      }
      if (/\b(?:page\.)?evaluate\s*\(|\baddInitScript\s*\(|\bevaluateOnNewDocument\s*\(/.test(added) && /\b(?:document\.|window\.|localStorage\.|sessionStorage\.|Object\.defineProperty)/.test(added)) {
        results.push(finding("browser test mutates runtime state before judging behavior", `${patch.path} adds browser-side state mutation inside an evaluation hook; review whether the test repairs the application it is meant to test`, "test-runtime-patch"));
      }
      if (/\b(?:istanbul|c8)\s+ignore\b|#\s*pragma:\s*no\s*cover\b|\[ExcludeFromCodeCoverage\]/i.test(added)) {
        results.push(finding("coverage exclusion introduced", `${patch.path} adds a coverage exclusion marker`, "coverage-exclusion-added"));
      }
      const removedStrict = /\.(?:toBe|toEqual|toStrictEqual)\s*\(|\b(?:assertEqual|assertStrictEqual)\s*\(/.test(removed);
      const addedLoose = /\.(?:toBeTruthy|toBeDefined|toBeGreaterThan|toBeGreaterThanOrEqual|toContain)\s*\(|\bassert\s*\(/.test(added);
      if (removedStrict && addedLoose) {
        results.push(finding("test assertion relaxed", `${patch.path} replaces an exact assertion with a weaker predicate`, "test-assertion-relaxed"));
      }
      if (/\b(?:jest|vi)\.fn\s*\(\s*\)\s*\.mock(?:ReturnValue|Implementation)/.test(added)) {
        results.push(finding("test replaces the subject with a self-fulfilling mock", `${patch.path} adds a value-producing local mock in the assertion path`, "subject-mocked"));
      }
      const removedHunkAssertions = patch.removed.filter((line) => /\b(?:expect|assert|should)\b/i.test(line)).length;
      const addedHunkAssertions = patch.added.filter((line) => /\b(?:expect|assert|should)\b/i.test(line)).length;
      if (removedHunkAssertions > addedHunkAssertions && !results.some((result5) => result5.ruleId === "assertion-drop")) {
        results.push(finding("assertion surface shrank", `${patch.path} hunk removes ${removedHunkAssertions} assertion-like line(s) and adds ${addedHunkAssertions}`, "assertion-drop"));
      }
    }
    const removedCode = patch.removed.map(normalizedCodeLine).filter(Boolean);
    const addedCode = patch.added.map(normalizedCodeLine).filter(Boolean);
    if (removedCode.length === 1 && addedCode.length === 1 && removedCode[0] === addedCode[0] && patch.removed[0] !== patch.added[0]) {
      results.push(finding("code change is behaviorally empty after comment and whitespace normalization", `${patch.path}: ${patch.added[0].trim().slice(0, 180)}`, "no-op-code-change"));
    }
  }
  const crossFileFunctionPattern = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  const remainingChangedText = implementationPatches.flatMap((patch) => [...patch.added, ...patch.context]).join("\n");
  for (const patch of implementationPatches) {
    const removedNames = [...patch.removed.join("\n").matchAll(crossFileFunctionPattern)].map((match) => match[1]);
    const addedNames = new Set([...patch.added.join("\n").matchAll(crossFileFunctionPattern)].map((match) => match[1]));
    if (!addedNames.size) continue;
    for (const oldName of removedNames) {
      if (addedNames.has(oldName)) continue;
      const oldCall = new RegExp(`\\b${oldName.replace(/[$]/g, "\\$")}\\s*\\(`);
      if (oldCall.test(remainingChangedText) && !results.some((result5) => result5.ruleId === "stale-refactor-caller")) {
        results.push(finding("removed or renamed symbol leaves an old caller", `${patch.path} removes ${oldName} while another changed-file context still calls it`, "stale-refactor-caller"));
      }
    }
  }
  const testPatches = patches.filter((patch) => isTestPath(patch.path));
  const removedTests = testPatches.flatMap((patch) => patch.removed).filter((line) => countTests(line) > 0).length;
  const addedTests = testPatches.flatMap((patch) => patch.added).filter((line) => countTests(line) > 0).length;
  if (removedTests > addedTests) {
    results.push(finding("test surface shrank", `${removedTests} test definitions removed and ${addedTests} added in the supplied diff`, "test-count-drop"));
  }
  const removedAssertions = testPatches.flatMap((patch) => patch.removed).filter((line) => /\b(?:expect|assert|should)\b/i.test(line)).length;
  const addedAssertions = testPatches.flatMap((patch) => patch.added).filter((line) => !line.includes("vigil:detector-pattern") && /\b(?:expect|assert|should)\b/i.test(line)).length;
  if (removedAssertions > addedAssertions && !results.some((result5) => result5.ruleId === "assertion-drop")) {
    results.push(finding(
      "assertion surface shrank",
      `${removedAssertions} assertion-like lines removed and ${addedAssertions} added`,
      "assertion-drop"
    ));
  }
  if (testPatches.length === patches.length && results.some((result5) => result5.ruleId === "test-assertion-relaxed") && !results.some((result5) => result5.ruleId === "no-op-code-change")) {
    results.push(finding(
      "claimed fix changes only the test oracle",
      "all changed implementation-scoped paths are tests and an exact assertion was weakened",
      "no-op-code-change"
    ));
  }
  return results;
}
function checkIntegrityDiff(diff) {
  if (!/^diff --git /m.test(diff)) {
    return [{
      claim: { kind: "integrity", quote: "static unified-diff audit", subject: "parseable unified Git diff" },
      verdict: "unverifiable",
      evidence: "input contains no `diff --git` file header",
      ruleId: "diff-unparseable",
      contributesToPass: false,
      blocksPass: true
    }];
  }
  const patches = parseFilePatches(diff);
  if (!patches.length) {
    return [{
      claim: { kind: "integrity", quote: "static unified-diff audit", subject: "parseable changed files" },
      verdict: "unverifiable",
      evidence: "input contains no readable changed-file patches",
      ruleId: "diff-unparseable",
      contributesToPass: false,
      blocksPass: true
    }];
  }
  const results = checkIntegrityPatches(patches);
  return results.length ? results : [cleanIntegrityResult(patches.length, true)];
}
function checkCompletion(claims, repo, base, head, prior) {
  const completion = claims.filter((claim) => claim.kind === "work_complete");
  if (!completion.length) return [];
  const diffRange = head === "WORKTREE" ? [base] : [base, head];
  const diff = git(repo, ["diff", "--unified=0", "--no-color", ...diffRange]);
  const markers = diff.split("\n").filter((line) => /^\+.*\b(TODO|FIXME|XXX|HACK|NotImplementedError|not implemented)\b/i.test(line));
  const objectiveVerified = prior.filter((result5) => result5.verdict === "verified" && result5.contributesToPass !== false).length;
  return completion.map((claim) => {
    if (markers.length) {
      return { claim, verdict: "contradicted", evidence: `diff adds unfinished-work marker: ${markers[0].slice(1, 220)}`, ruleId: "completion-marker" };
    }
    if (!objectiveVerified) {
      return {
        claim,
        verdict: "unverifiable",
        evidence: "completion has no independently verified path, command, file-change, or test evidence",
        ruleId: "completion-evidence",
        contributesToPass: false
      };
    }
    return {
      claim,
      verdict: "verified",
      evidence: `completion is supported by ${objectiveVerified} objective check(s) and adds no unfinished-work markers`,
      ruleId: "completion-evidence",
      contributesToPass: false
    };
  });
}

// src/report.ts
import { createHash as createHash2 } from "node:crypto";
var VERSION = "0.15.0";
function canonical(value) {
  if (value === void 0) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item2]) => item2 !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item2]) => `${JSON.stringify(key)}:${canonical(item2)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}
function buildReport(input) {
  const policy = {
    minVerified: Math.max(1, input.policy?.minVerified ?? 1),
    strict: input.policy?.strict ?? false,
    ...input.policy?.source ? { source: input.policy.source } : {},
    sha256: input.policy?.sha256 ?? "sha256:unavailable"
  };
  const count2 = (verdict) => input.results.filter((r) => r.verdict === verdict).length;
  const contradicted = count2("contradicted");
  const unverifiable = count2("unverifiable");
  const meaningfulVerified = input.results.filter(
    (r) => r.verdict === "verified" && r.contributesToPass !== false
  ).length;
  let status;
  if (contradicted > 0) status = "FAIL";
  else if (meaningfulVerified < policy.minVerified || input.results.some((result5) => result5.verdict === "unverifiable" && result5.blocksPass) || policy.strict && unverifiable > 0) status = "INCONCLUSIVE";
  else status = "PASS";
  const summary = {
    verified: count2("verified"),
    contradicted,
    unverifiable,
    meaningfulVerified,
    status,
    pass: status === "PASS"
  };
  const advisories = input.advisories ?? [];
  const receiptPayload2 = {
    schemaVersion: "2",
    vigilVersion: VERSION,
    transcriptFormat: input.transcriptFormat,
    transcriptSha256: input.transcriptSha256 ?? "sha256:unavailable",
    base: input.base,
    head: input.head,
    repository: input.repository ?? {},
    reproduction: input.reproduction ?? "unavailable",
    results: input.results,
    advisories,
    summary,
    policy
  };
  return {
    schemaVersion: "2",
    vigilVersion: VERSION,
    transcript: input.transcript,
    transcriptSha256: input.transcriptSha256 ?? "sha256:unavailable",
    transcriptFormat: input.transcriptFormat,
    repo: input.repo,
    base: input.base,
    head: input.head,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    receiptHash: `sha256:${createHash2("sha256").update(canonical(receiptPayload2)).digest("hex")}`,
    repository: input.repository ?? {},
    reproduction: input.reproduction ?? "unavailable",
    results: input.results,
    advisories,
    summary,
    policy
  };
}
function recomputeReceiptHash(report) {
  const payload = {
    schemaVersion: report.schemaVersion,
    vigilVersion: report.vigilVersion,
    transcriptFormat: report.transcriptFormat,
    transcriptSha256: report.transcriptSha256,
    base: report.base,
    head: report.head,
    repository: report.repository,
    reproduction: report.reproduction,
    results: report.results,
    ...report.advisories !== void 0 ? { advisories: report.advisories } : {},
    summary: report.summary,
    policy: report.policy
  };
  return `sha256:${createHash2("sha256").update(canonical(payload)).digest("hex")}`;
}

// src/safe-output.ts
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync as readFileSync3,
  realpathSync as realpathSync2,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, parse, resolve as resolve2, sep as sep2 } from "node:path";
function isMissing(error) {
  return error?.code === "ENOENT";
}
function assertReplaceableDestination(path) {
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic-link output: ${path}`);
    }
    if (!status.isFile()) {
      throw new Error(`Refusing to replace non-regular output: ${path}`);
    }
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}
function resolveSafeParent(requested) {
  const parent = dirname(requested);
  const root = parse(parent).root;
  const rootStatus = lstatSync(root);
  if (!rootStatus.isDirectory()) {
    throw new Error(`Refusing to use non-directory output root: ${root}`);
  }
  let current = root;
  const components = parent.slice(root.length).split(sep2).filter(Boolean);
  for (const [index, component] of components.entries()) {
    const next = join(current, component);
    const status = lstatSync(next);
    if (status.isSymbolicLink()) {
      const trustedRootAlias = index === 0 && status.uid === rootStatus.uid && (rootStatus.mode & 18) === 0;
      if (!trustedRootAlias) {
        throw new Error(`Refusing to traverse symbolic-link output parent: ${next}`);
      }
      const canonical3 = realpathSync2(next);
      if (!lstatSync(canonical3).isDirectory()) {
        throw new Error(`Refusing to traverse non-directory output parent: ${next}`);
      }
      current = canonical3;
      continue;
    }
    if (!status.isDirectory()) {
      throw new Error(`Refusing to traverse non-directory output parent: ${next}`);
    }
    current = next;
  }
  return current;
}
function readRegularFileWithoutFollowingReplacement(path) {
  let expected;
  try {
    expected = lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
  if (expected.isSymbolicLink()) {
    throw new Error(`Refusing to replace symbolic-link output: ${path}`);
  }
  if (!expected.isFile()) {
    throw new Error(`Refusing to replace non-regular output: ${path}`);
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error(`Output changed while preparing an atomic append: ${path}`);
    }
    return readFileSync3(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
function openPrivateTemporaryFile(parent) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const path = join(parent, `.agent-vigil-${randomBytes(16).toString("hex")}.tmp`);
    try {
      const descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        384
      );
      return { descriptor, path };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Unable to allocate a private temporary output in ${parent}`);
}
function writePrivateFileAtomic(destination, content) {
  const requested = resolve2(destination);
  const parent = resolveSafeParent(requested);
  const target = join(parent, basename(requested));
  assertReplaceableDestination(target);
  let descriptor;
  let temporaryPath;
  let failure;
  try {
    ({ descriptor, path: temporaryPath } = openPrivateTemporaryFile(parent));
    fchmodSync(descriptor, 384);
    writeFileSync(descriptor, Buffer.from(content, "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = void 0;
    assertReplaceableDestination(target);
    renameSync(temporaryPath, target);
    temporaryPath = void 0;
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== void 0) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
    if (temporaryPath !== void 0) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (!isMissing(error)) failure ??= error;
      }
    }
  }
  if (failure !== void 0) throw failure;
}
function appendPrivateFileAtomic(destination, content) {
  const requested = resolve2(destination);
  const parent = resolveSafeParent(requested);
  const target = join(parent, basename(requested));
  const existing = readRegularFileWithoutFollowingReplacement(target);
  writePrivateFileAtomic(target, `${existing}${content}`);
}

// src/output.ts
var icon = { verified: "\u2713", contradicted: "\u2717", unverifiable: "?" };
function advisoryLabel(result5) {
  return result5.verdict === "unverifiable" ? "unresolved advisory" : "advisory";
}
function remediationFor(ruleId) {
  const fixes = {
    "test-count": "Run the configured test command without truncating its output, then report the observed passing count exactly; use `vigil doctor` to inspect command selection.",
    "tests-pass": "Run `vigil doctor`, configure policy `testCommand` when inference is absent, and preserve the fresh runner's complete output.",
    "file-changed": "Inspect `git diff --name-only <base>..<head>`, pass those exact SHAs, then correct the claimed path.",
    "path-exists": "Create the claimed artifact or remove the unsupported claim.",
    "path-outside-repo": "Reference a repository-relative path that resolves inside the checkout.",
    "file-outside-repo": "Reference only repository-relative changed files.",
    "command-ran": "Export the complete supported tool trajectory, rerun the claimed command, and preserve its terminal result event.",
    "tool-loop": "Stop the repeated call, inspect its result, and record the next distinct action.",
    "test-count-drop": "Restore removed tests or document and review the intentional test-surface change.",
    "test-skip-added": "Remove the new skip/focus marker or obtain an explicit reviewed exception.",
    "verification-bypass": "Remove the verification bypass and let the underlying check fail honestly.",
    "suppression-added": "Remove the new suppression or narrow it with an explicit reviewed justification.",
    "coverage-weakened": "Restore a meaningful coverage threshold.",
    "coverage-exclusion-added": "Remove the new coverage exclusion, or document the unreachable/platform-specific path and review the advisory explicitly.",
    "test-empty-added": "Add an assertion against observable behavior or remove the empty test.",
    "test-oracle-constant": "Replace the constant or self-equal assertion with an assertion whose value comes from the subject under test.",
    "test-runtime-patch": "Test the application as delivered; remove browser-side repair code or prove that the mutation is only fixture setup outside the behavior being asserted.",
    "assertion-drop": "Restore equivalent assertions or review the intentional reduction explicitly.",
    "test-assertion-relaxed": "Restore the exact assertion, or document why the weaker predicate preserves the same contract and review the exception.",
    "subject-mocked": "Exercise the real subject or replace the self-fulfilling mock with a boundary fixture whose behavior is independently asserted.",
    "dead-branch-added": "Remove the unreachable branch or replace the constant condition with the intended reachable control flow.",
    "error-swallowed": "Handle, report, or deliberately propagate the error; if swallowing is intentional, keep advisory mode or review a blocking-policy exception.",
    "exception-context-lost": "Rethrow the original error or attach it as the new error's cause so diagnostic context is preserved.",
    "stale-refactor-caller": "Update remaining callers to the renamed symbol and run the focused regression test.",
    "no-op-code-change": "Make the behavioral change explicit or remove the comment/whitespace-only edit from the claimed fix.",
    "comment-only-change": "Implement the claimed behavior change, or move the comment-only edit out of the fix and avoid presenting it as implementation proof.",
    "diff-unparseable": "Export a complete unified Git diff with `git diff --no-color <base>...<head>` and rerun the audit.",
    "completion-marker": "Resolve the added unfinished-work marker before claiming completion.",
    "completion-evidence": "Add at least one independently verifiable path, command, change, or test claim.",
    "workspace-dirty": "Run `git status --short`, commit or remove unbound paths, then rerun with `--head $(git rev-parse HEAD)`.",
    "workspace-unbound": "Commit the candidate change, then rerun with `--head $(git rev-parse HEAD)` instead of WORKTREE.",
    "workspace-mutated": "Make the verification command read-only with respect to tracked inputs, restore the changed paths, and rerun.",
    "portable-signature": "Regenerate the portable receipt from an intact full report with the trusted Ed25519 key.",
    "portable-signer": "Pin the signer key ID in base policy `trustedSignerKeyIds`, or regenerate with an already pinned key.",
    "portable-local-verdict": "Resolve the local FAIL or INCONCLUSIVE result, rerun Agent Vigil, and attach a new signed portable receipt.",
    "portable-policy": "Regenerate the receipt using policy loaded from the pull request base commit.",
    "portable-path": "Set base policy `portableReceipt` and pass that exact repository-relative path.",
    "portable-git-binding": "Regenerate after the latest source commit; after signing, commit only the base-policy-controlled receipt path.",
    "responsible-human": "Set `Responsible human` to the pull request author's exact GitHub login and accept responsibility for the change.",
    "human-review-attestation": "Review every changed line, then check the exact declaration in the pull request template.",
    "human-maintenance-attestation": "Confirm you can explain and maintain the change, then check the exact declaration.",
    "automated-review-mode": "Review the base policy's automatedReview setup and commands; this record is automated evidence, not a human declaration.",
    "automated-review-setup": "Fix the base-policy setup command so it completes in a clean isolated checkout of the exact candidate commit.",
    "automated-review-command": "Run the failing base-policy command at the reported candidate commit, fix the failure or timeout, and rerun Agent Vigil.",
    "automated-review-head": "Remove any checkout, reset, commit, or other command that moves HEAD during automated review.",
    "automated-review-worktree": "Make automated review read-only for tracked files; generated outputs must be unchanged or written outside tracked paths.",
    "ai-assistance-disclosure": "Set `AI assistance` to exactly `none`, `assisted`, or `agent`.",
    "linked-issue": "Link the maintainer-approved issue as `#123` or a full GitHub issue URL.",
    "changed-file-budget": "Split the change or obtain a reviewed base-policy exception before expanding the file budget.",
    "changed-line-budget": "Split the change, remove unrelated edits, or obtain a reviewed base-policy exception.",
    "test-change-required": "Add a focused regression test under a configured testPathPatterns path.",
    "protected-path": "Remove the protected-path edit and change policy or workflow controls in a separately reviewed pull request.",
    "differential-setup": "Make the base-policy setup command succeed in isolated base and head worktrees; do not hide setup errors.",
    "differential-head-pass": "Fix the candidate until the trusted regression command passes in the isolated head worktree.",
    "differential-base-fail": "Add a regression test that fails against base source and passes against the candidate; a test green on both sides is not catching evidence.",
    "differential-failure-pattern": "Tighten the test or update the base-anchored expected failure pattern through separate review.",
    "differential-test": "Inspect isolated-worktree output, test-path patterns, setup, and timeout; rerun without secrets on the same exact SHAs.",
    "merge-group-binding": "Use the exact base_sha and head_sha from the GitHub merge_group event.",
    "merge-group-range": "Recreate the merge group from the current target branch; the reported head must descend from the event base.",
    "authority-validity": "Issue a new task-scoped contract with a short expiresAt window; do not silently extend expired authority.",
    "authorized-change-paths": "Revert out-of-scope paths or issue a separately reviewed contract that explicitly includes them.",
    "authorized-action-classes": "Remove the unauthorized action, or obtain new human authority before rerunning it; never edit the contract after the action to manufacture compliance.",
    "unknown-action-risk": "Use a supported structured tool adapter or normalize the action explicitly; do not allow unknown_effect in a blocking policy.",
    "complete-tool-results": "Export the complete session trajectory with terminal results for every tool call.",
    "observed-action-coverage": "Provide a supported JSONL transcript with structured tool calls; narrative summaries cannot prove action boundaries.",
    "authority-contract-anchor": "Store the contract in the trusted base revision and pass --contract-ref <base-sha> in CI.",
    "authority-plan": "Review each blocking authority change below; remove it or approve the exact kind, subject, and value in the base revision policy before reopening the code change.",
    "authority-server": "Remove the new or changed agent server, or approve its exact normalized identity in the base revision policy.",
    "authority-tool": "Restore the prior tool boundary, or approve the exact tool grant in the base revision policy.",
    "authority-network": "Remove the new network destination, or approve that exact host in the base revision policy.",
    "authority-filesystem": "Narrow the filesystem scope, or approve that exact path in the base revision policy.",
    "authority-secret": "Remove the new secret reference, or approve the exact variable or header name in the base revision policy; never commit the secret value.",
    "authority-model": "Restore the pinned model or review the model-identity change; do not replace a pinned version with a mutable alias.",
    "authority-approval": "Restore the prior approval mode or approve the weaker mode in the base revision policy.",
    "authority-sandbox": "Restore the prior sandbox boundary or approve the weaker setting in the base revision policy.",
    "authority-hook": "Remove the new hook or approve its exact hashed command identity in the base revision policy.",
    "authority-setting-unknown": "Upgrade the adapter or remove the unrecognized setting change; use a separately reviewed base-policy exception only after inspecting its effect."
  };
  return fixes[ruleId ?? ""] ?? "Provide objective evidence or remove the unsupported claim.";
}
function renderText(report) {
  const lines = [
    `agent-vigil ${report.vigilVersion} \u2014 evidence receipt`,
    `  transcript: ${report.transcript} (${report.transcriptFormat})`,
    `  digest:     ${report.transcriptSha256}`,
    `  repo:       ${report.repo}`,
    `  range:      ${report.base}..${report.head}`,
    `  policy:     ${report.policy.sha256}`,
    ""
  ];
  for (const result5 of report.results) {
    lines.push(`  ${icon[result5.verdict]} [${result5.ruleId ?? result5.claim.kind}] ${result5.claim.subject}`);
    lines.push(`      claim:    "${result5.claim.quote.slice(0, 140)}"`);
    lines.push(`      evidence: ${result5.evidence}`, "");
    if (result5.verdict !== "verified") lines.splice(lines.length - 1, 0, `      fix:      ${remediationFor(result5.ruleId)}`);
  }
  for (const result5 of report.advisories ?? []) {
    lines.push(`  ! [${result5.ruleId ?? result5.claim.kind}] ${result5.claim.subject}`);
    lines.push(`      ${advisoryLabel(result5)}: ${result5.evidence}`);
    lines.push(`      review:   ${remediationFor(result5.ruleId)}`, "");
  }
  const summary = report.summary;
  lines.push(`  ${summary.verified} verified \xB7 ${summary.contradicted} contradicted \xB7 ${summary.unverifiable} unresolved`);
  if (report.advisories?.length) lines.push(`  ${report.advisories.length} advisory finding(s) \xB7 non-blocking under this policy`);
  lines.push(`  ${summary.status} \xB7 ${report.receiptHash}`);
  lines.push(`  reproduce: ${report.reproduction}`);
  if (summary.status === "INCONCLUSIVE") lines.push("  Missing or unresolved evidence prevents a trustworthy pass.");
  return lines.join("\n");
}
function renderMarkdown(report) {
  const rows = report.results.map(
    (result5) => `| ${icon[result5.verdict]} ${result5.verdict} | \`${result5.ruleId ?? result5.claim.kind}\` | ${escapeCell(result5.claim.subject)} | ${escapeCell(result5.evidence)} |`
  );
  const advisoryRows = (report.advisories ?? []).map(
    (result5) => `| \u26A0\uFE0F ${advisoryLabel(result5)} | \`${result5.ruleId ?? result5.claim.kind}\` | ${escapeCell(result5.claim.subject)} | ${escapeCell(result5.evidence)} |`
  );
  return [
    `# ${report.summary.status === "PASS" ? "\u2705" : report.summary.status === "FAIL" ? "\u274C" : "\u26A0\uFE0F"} Agent Vigil: ${report.summary.status}`,
    "",
    `**Receipt:** \`${report.receiptHash}\`  `,
    `**Range:** \`${report.base}..${report.head}\`  `,
    `**Transcript:** \`${report.transcript}\` (${report.transcriptFormat})  `,
    `**Policy:** \`${report.policy.sha256}\``,
    "",
    "| Verdict | Rule | Claim | Evidence |",
    "|---|---|---|---|",
    ...rows,
    ...advisoryRows,
    "",
    `${report.summary.verified} verified \xB7 ${report.summary.contradicted} contradicted \xB7 ${report.summary.unverifiable} unresolved`,
    ...report.advisories?.length ?? 0 ? [`${report.advisories.length} advisory finding(s) \xB7 non-blocking under this policy`] : [],
    "",
    ...report.results.some((result5) => result5.verdict !== "verified") || (report.advisories?.length ?? 0) ? [
      "## What to do next",
      "",
      ...report.results.filter((result5) => result5.verdict !== "verified").map(
        (result5) => `- **\`${result5.ruleId ?? result5.claim.kind}\`**: ${remediationFor(result5.ruleId)}`
      ),
      ...(report.advisories ?? []).map(
        (result5) => `- **\`${result5.ruleId ?? result5.claim.kind}\` (advisory)**: ${remediationFor(result5.ruleId)}`
      ),
      ""
    ] : [],
    `Reproduce: \`${report.reproduction.replace(/`/g, "\\`")}\``,
    ""
  ].join("\n");
}
function renderDecisionCard(report) {
  const meaning = report.summary.status === "PASS" ? "The required evidence is present for this exact change." : report.summary.status === "FAIL" ? "A required check contradicted the change, its claims, or the trusted policy." : "The available evidence is not enough to approve this change.";
  const open = report.results.filter((result5) => result5.verdict !== "verified");
  return [
    `### Agent Vigil: ${report.summary.status}`,
    "",
    meaning,
    "",
    `- **Change:** \`${report.base}\` \u2192 \`${report.head}\``,
    `- **Evidence:** ${report.summary.verified} verified \xB7 ${report.summary.contradicted} contradicted \xB7 ${report.summary.unverifiable} unresolved`,
    `- **Policy:** \`${report.policy.sha256}\``,
    `- **Receipt:** \`${report.receiptHash}\``,
    ...open.length ? [
      "",
      "**Before this can pass:**",
      ...open.slice(0, 5).map((result5) => `- ${result5.claim.subject}: ${remediationFor(result5.ruleId)}`),
      ...open.length > 5 ? [`- ${open.length - 5} more item(s) are listed in the retained receipt.`] : []
    ] : [],
    "",
    `Reproduce: \`${report.reproduction.replace(/`/g, "\\`")}\``,
    ""
  ].join("\n");
}
function escapeCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}
function sarifResult(result5, advisory = false) {
  const level = advisory ? "warning" : result5.verdict === "contradicted" ? "error" : result5.verdict === "unverifiable" ? "warning" : "note";
  return {
    ruleId: result5.ruleId ?? result5.claim.kind,
    level,
    message: { text: `${result5.claim.subject}: ${result5.evidence}. Remediation: ${remediationFor(result5.ruleId)}` }
  };
}
function toSarif(report) {
  const allResults = [...report.results, ...report.advisories ?? []];
  const rules = [...new Set(allResults.map((result5) => result5.ruleId ?? result5.claim.kind))].map((id) => ({
    id,
    shortDescription: { text: id.replace(/-/g, " ") }
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "agent-vigil", version: report.vigilVersion, informationUri: "https://github.com/sulmusic2-star/agent-vigil", rules } },
      results: [
        ...report.results.filter((result5) => result5.verdict !== "verified").map((result5) => sarifResult(result5)),
        ...(report.advisories ?? []).map((result5) => sarifResult(result5, true))
      ],
      properties: { receiptHash: report.receiptHash, status: report.summary.status, advisoryCount: report.advisories?.length ?? 0 }
    }]
  };
}
function writeOutputs(report, options) {
  if (options.output) writePrivateFileAtomic(options.output, `${JSON.stringify(report, null, 2)}
`);
  if (options.sarif) writePrivateFileAtomic(options.sarif, `${JSON.stringify(toSarif(report), null, 2)}
`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (options.githubSummary && summaryPath) appendPrivateFileAtomic(summaryPath, renderDecisionCard(report));
}

// src/demo.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
function git2(repo, ...args) {
  execFileSync2("git", args, { cwd: repo, stdio: "ignore" });
}
function runDemo(run2) {
  const repo = mkdtempSync(join2(tmpdir(), "agent-vigil-demo-"));
  git2(repo, "init", "-q");
  git2(repo, "config", "user.email", "demo@agent-vigil.local");
  git2(repo, "config", "user.name", "Agent Vigil Demo");
  mkdirSync(join2(repo, "src"));
  writeFileSync2(join2(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test test.js" } }, null, 2));
  writeFileSync2(join2(repo, "test.js"), "const { test } = require('node:test'); test('real', () => {});\n");
  writeFileSync2(join2(repo, "src", "real.ts"), "export const real = true;\n");
  git2(repo, "add", "-A");
  git2(repo, "commit", "-qm", "baseline");
  writeFileSync2(join2(repo, "README.md"), "demo head\n");
  git2(repo, "add", "README.md");
  git2(repo, "commit", "-qm", "head");
  const evidence = mkdtempSync(join2(tmpdir(), "agent-vigil-demo-evidence-"));
  const count2 = join2(evidence, "false-count.md");
  const ghost = join2(evidence, "ghost-file.md");
  const loop = join2(evidence, "tool-loop.jsonl");
  writeFileSync2(count2, "All 99 tests pass.\n");
  writeFileSync2(ghost, "I created src/ghost.ts. The work is complete.\n");
  const rows = [
    { type: "assistant", message: { content: [{ type: "text", text: "The test suite passes." }] } },
    ...["a", "b", "c"].map((id) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "src/real.ts" } }] } }))
  ];
  writeFileSync2(loop, `${rows.map((row) => JSON.stringify(row)).join("\n")}
`);
  const scenarios = [
    ["claimed 99 tests; runner has 1", count2],
    ["claimed a file that does not exist", ghost],
    ["repeated the identical tool call 3 times", loop]
  ];
  let caught = 0;
  console.log("Agent Vigil adversarial demo\n");
  for (const [label, transcript] of scenarios) {
    console.log(`=== ${label} ===`);
    const code2 = run2([transcript, "--repo", repo, "--base", "HEAD~1", "--head", "HEAD", "--strict"]);
    if (code2 === 1) caught++;
    console.log("");
  }
  console.log(`${caught}/${scenarios.length} planted contradictions caught.`);
  return caught === scenarios.length ? 0 : 1;
}

// src/config.ts
import { createHash as createHash3 } from "node:crypto";
import { execFileSync as execFileSync3 } from "node:child_process";
import { existsSync as existsSync2, readFileSync as readFileSync4 } from "node:fs";
import { isAbsolute as isAbsolute2, normalize, resolve as resolve3, win32 } from "node:path";
var DEFAULT_POLICY_FILE = ".agent-vigil.json";
function canonical2(value) {
  if (value === void 0) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical2).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item2]) => item2 !== void 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item2]) => `${JSON.stringify(key)}:${canonical2(item2)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function validatePolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("policy must be a JSON object");
  const value = input;
  const allowed = /* @__PURE__ */ new Set(["schemaVersion", "integrityMode", "transcript", "testCommand", "strict", "minVerified", "trustedSignerKeyIds", "portableReceipt", "maintainer"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`policy contains unknown field(s): ${unknown.join(", ")}`);
  if (value.schemaVersion !== 1) throw new Error("policy schemaVersion must be 1");
  if (value.integrityMode !== void 0 && !(/* @__PURE__ */ new Set(["advisory", "calibrated", "blocking"])).has(String(value.integrityMode))) {
    throw new Error("policy integrityMode must be advisory, calibrated, or blocking");
  }
  if (value.transcript !== void 0 && (typeof value.transcript !== "string" || !value.transcript.trim())) {
    throw new Error("policy transcript must be a non-empty string");
  }
  if (value.testCommand !== void 0 && (typeof value.testCommand !== "string" || !value.testCommand.trim())) {
    throw new Error("policy testCommand must be a non-empty string");
  }
  if (value.strict !== void 0 && typeof value.strict !== "boolean") throw new Error("policy strict must be boolean");
  if (value.minVerified !== void 0 && (!Number.isInteger(value.minVerified) || Number(value.minVerified) < 1)) {
    throw new Error("policy minVerified must be a positive integer");
  }
  if (value.trustedSignerKeyIds !== void 0) {
    if (!Array.isArray(value.trustedSignerKeyIds) || value.trustedSignerKeyIds.length < 1) {
      throw new Error("policy trustedSignerKeyIds must be a non-empty array");
    }
    const ids = value.trustedSignerKeyIds;
    if (ids.some((id) => typeof id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(id))) {
      throw new Error("policy trustedSignerKeyIds must contain SHA-256 key IDs");
    }
    if (new Set(ids).size !== ids.length) throw new Error("policy trustedSignerKeyIds must not contain duplicates");
  }
  if (value.portableReceipt !== void 0) {
    if (typeof value.portableReceipt !== "string" || !value.portableReceipt.trim()) {
      throw new Error("policy portableReceipt must be a non-empty repository-relative path");
    }
    const clean = normalize(value.portableReceipt).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isAbsolute2(value.portableReceipt) || win32.isAbsolute(value.portableReceipt) || clean === ".." || clean.startsWith("../")) {
      throw new Error("policy portableReceipt must stay inside the repository");
    }
  }
  if (value.maintainer !== void 0) validateMaintainerPolicy(value.maintainer);
  return value;
}
function positiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || Number(value) < 1 || maximum !== void 0 && Number(value) > maximum) {
    throw new Error(`policy ${label} must be a positive integer${maximum ? ` no greater than ${maximum}` : ""}`);
  }
}
function nonEmptyStrings(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.some((item2) => typeof item2 !== "string" || !item2.trim())) {
    throw new Error(`policy ${label} must be a non-empty array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`policy ${label} must not contain duplicates`);
}
function validateMaintainerPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("policy maintainer must be a JSON object");
  const value = input;
  const allowed = /* @__PURE__ */ new Set([
    "reviewMode",
    "requireHumanAttestation",
    "requireLinkedIssue",
    "requireAiDisclosure",
    "maxChangedFiles",
    "maxChangedLines",
    "requireTestChange",
    "protectedPaths",
    "testPathPatterns",
    "differentialTest",
    "automatedReview"
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`policy maintainer contains unknown field(s): ${unknown.join(", ")}`);
  for (const key of ["requireHumanAttestation", "requireLinkedIssue", "requireAiDisclosure", "requireTestChange"]) {
    if (value[key] !== void 0 && typeof value[key] !== "boolean") throw new Error(`policy maintainer.${key} must be boolean`);
  }
  if (value.reviewMode !== void 0 && !(/* @__PURE__ */ new Set(["human", "automated"])).has(String(value.reviewMode))) {
    throw new Error("policy maintainer.reviewMode must be human or automated");
  }
  if (value.reviewMode === "human" && value.requireHumanAttestation === false) {
    throw new Error("policy maintainer.reviewMode human conflicts with requireHumanAttestation false");
  }
  if (value.reviewMode === "automated" && value.requireHumanAttestation === true) {
    throw new Error("policy maintainer.reviewMode automated conflicts with requireHumanAttestation true");
  }
  if (value.maxChangedFiles !== void 0) positiveInteger(value.maxChangedFiles, "maintainer.maxChangedFiles", 1e5);
  if (value.maxChangedLines !== void 0) positiveInteger(value.maxChangedLines, "maintainer.maxChangedLines", 1e7);
  if (value.protectedPaths !== void 0) nonEmptyStrings(value.protectedPaths, "maintainer.protectedPaths");
  if (value.testPathPatterns !== void 0) nonEmptyStrings(value.testPathPatterns, "maintainer.testPathPatterns");
  if (value.automatedReview !== void 0) {
    if (!value.automatedReview || typeof value.automatedReview !== "object" || Array.isArray(value.automatedReview)) {
      throw new Error("policy maintainer.automatedReview must be a JSON object");
    }
    const automated = value.automatedReview;
    const automatedAllowed = /* @__PURE__ */ new Set(["setupCommand", "commands", "timeoutSeconds"]);
    const automatedUnknown = Object.keys(automated).filter((key) => !automatedAllowed.has(key));
    if (automatedUnknown.length) throw new Error(`policy maintainer.automatedReview contains unknown field(s): ${automatedUnknown.join(", ")}`);
    nonEmptyStrings(automated.commands, "maintainer.automatedReview.commands");
    if (automated.commands.length > 8) throw new Error("policy maintainer.automatedReview.commands must contain no more than 8 commands");
    if (automated.commands.some((command) => command.length > 1e3)) throw new Error("policy maintainer.automatedReview.commands entries must be at most 1000 characters");
    if (automated.setupCommand !== void 0 && (typeof automated.setupCommand !== "string" || !automated.setupCommand.trim() || automated.setupCommand.length > 1e3)) {
      throw new Error("policy maintainer.automatedReview.setupCommand must be a non-empty string of at most 1000 characters");
    }
    if (automated.timeoutSeconds !== void 0) positiveInteger(automated.timeoutSeconds, "maintainer.automatedReview.timeoutSeconds", 3600);
  }
  if (value.reviewMode === "automated" && value.automatedReview === void 0) {
    throw new Error("policy maintainer.reviewMode automated requires maintainer.automatedReview");
  }
  if (value.reviewMode !== "automated" && value.automatedReview !== void 0) {
    throw new Error("policy maintainer.automatedReview requires reviewMode automated");
  }
  if (value.differentialTest !== void 0) {
    if (!value.differentialTest || typeof value.differentialTest !== "object" || Array.isArray(value.differentialTest)) {
      throw new Error("policy maintainer.differentialTest must be a JSON object");
    }
    const differential = value.differentialTest;
    const differentialAllowed = /* @__PURE__ */ new Set(["command", "setupCommand", "timeoutSeconds", "baseFailurePattern", "overlayChangedTests"]);
    const differentialUnknown = Object.keys(differential).filter((key) => !differentialAllowed.has(key));
    if (differentialUnknown.length) throw new Error(`policy maintainer.differentialTest contains unknown field(s): ${differentialUnknown.join(", ")}`);
    if (typeof differential.command !== "string" || !differential.command.trim()) throw new Error("policy maintainer.differentialTest.command must be a non-empty string");
    if (differential.setupCommand !== void 0 && (typeof differential.setupCommand !== "string" || !differential.setupCommand.trim())) {
      throw new Error("policy maintainer.differentialTest.setupCommand must be a non-empty string");
    }
    if (differential.timeoutSeconds !== void 0) positiveInteger(differential.timeoutSeconds, "maintainer.differentialTest.timeoutSeconds", 3600);
    if (differential.baseFailurePattern !== void 0) {
      if (typeof differential.baseFailurePattern !== "string" || !differential.baseFailurePattern.trim() || differential.baseFailurePattern.length > 500) throw new Error("policy maintainer.differentialTest.baseFailurePattern must be a non-empty string of at most 500 characters");
      try {
        new RegExp(differential.baseFailurePattern);
      } catch {
        throw new Error("policy maintainer.differentialTest.baseFailurePattern must be a valid regular expression");
      }
    }
    if (differential.overlayChangedTests !== void 0 && typeof differential.overlayChangedTests !== "boolean") {
      throw new Error("policy maintainer.differentialTest.overlayChangedTests must be boolean");
    }
  }
}
function parsePolicy(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`policy is not valid JSON: ${source}`);
  }
  return validatePolicy(parsed);
}
function loadPolicy(repo, requested, ref) {
  const gitPath = requested ?? DEFAULT_POLICY_FILE;
  if (ref) {
    const clean = normalize(gitPath).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isAbsolute2(gitPath) || win32.isAbsolute(gitPath) || clean === ".." || clean.startsWith("../")) throw new Error("policy-ref requires a repository-relative policy path");
    let raw2;
    try {
      raw2 = execFileSync3("git", ["show", `${ref}:${clean}`], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 1024 * 1024
      });
    } catch {
      throw new Error(`policy not found at ${ref}:${clean}`);
    }
    const value2 = parsePolicy(raw2, `${ref}:${clean}`);
    return {
      gitPath: clean,
      ref,
      sha256: `sha256:${createHash3("sha256").update(canonical2(value2)).digest("hex")}`,
      value: value2
    };
  }
  const candidate = requested ? resolve3(repo, requested) : resolve3(repo, DEFAULT_POLICY_FILE);
  if (!existsSync2(candidate)) {
    if (requested) throw new Error(`policy not found: ${candidate}`);
    const value2 = { schemaVersion: 1 };
    return { sha256: `sha256:${createHash3("sha256").update(canonical2(value2)).digest("hex")}`, value: value2 };
  }
  const raw = readFileSync4(candidate, "utf8");
  const value = parsePolicy(raw, candidate);
  return {
    path: candidate,
    sha256: `sha256:${createHash3("sha256").update(canonical2(value)).digest("hex")}`,
    value
  };
}
function policyTemplate(testCommand, portableSignerKeyId) {
  const value = {
    schemaVersion: 1,
    integrityMode: "advisory",
    ...portableSignerKeyId ? {
      portableReceipt: ".agent-vigil/receipt.json",
      trustedSignerKeyIds: [portableSignerKeyId]
    } : { transcript: ".agent-vigil/session.md" },
    ...testCommand ? { testCommand } : {},
    strict: true,
    minVerified: 1
  };
  return `${JSON.stringify(value, null, 2)}
`;
}
function maintainerPolicyTemplate(testCommand, setupCommand, protectCommands) {
  const command = testCommand ?? "REPLACE_WITH_TEST_COMMAND";
  const value = {
    schemaVersion: 1,
    integrityMode: protectCommands ? "calibrated" : "advisory",
    testCommand: command,
    strict: true,
    minVerified: 1,
    maintainer: {
      reviewMode: "automated",
      requireHumanAttestation: false,
      requireLinkedIssue: true,
      requireAiDisclosure: true,
      maxChangedFiles: 20,
      maxChangedLines: 800,
      requireTestChange: true,
      protectedPaths: [".github/workflows/**", ".agent-vigil.json"],
      testPathPatterns: ["test/**", "tests/**", "__tests__/**", "**/*.test.*", "**/*.spec.*"],
      differentialTest: {
        command,
        ...setupCommand ? { setupCommand } : {},
        timeoutSeconds: 300,
        overlayChangedTests: true
      },
      automatedReview: {
        ...setupCommand ? { setupCommand } : {},
        commands: protectCommands?.length ? protectCommands : [command],
        timeoutSeconds: 300
      }
    }
  };
  return `${JSON.stringify(value, null, 2)}
`;
}

// src/setup.ts
import { execFileSync as execFileSync6 } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync7, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, relative as relative4, resolve as resolve6 } from "node:path";

// src/authority.ts
import { createHash as createHash4 } from "node:crypto";
import { execFileSync as execFileSync5 } from "node:child_process";
import { isAbsolute as isAbsolute3, normalize as normalize3, relative as relative3, resolve as resolve5, win32 as win322 } from "node:path";
import { readFileSync as readFileSync6, statSync as statSync3 } from "node:fs";

// src/maintainer.ts
import { execFileSync as execFileSync4, spawnSync as spawnSync2 } from "node:child_process";
import { cpSync, existsSync as existsSync3, lstatSync as lstatSync2, mkdirSync as mkdirSync2, mkdtempSync as mkdtempSync2, readFileSync as readFileSync5, rmSync, statSync as statSync2 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname2, join as join3, normalize as normalize2, resolve as resolve4, sep as sep3 } from "node:path";
var DEFAULT_TEST_PATTERNS = ["test/**", "tests/**", "__tests__/**", "**/*.test.*", "**/*.spec.*"];
var MAX_COMMAND_OUTPUT = 12e3;
var TIMEOUT_MARKER = "[agent-vigil-command-timeout]";
var ABNORMAL_MARKER = "[agent-vigil-command-abnormal]";
var COMMAND_WRAPPER = String.raw`
const { execFile, spawn } = require("node:child_process");
const command = process.env.VIGIL_WRAPPED_COMMAND;
const timeout = Number(process.env.VIGIL_WRAPPED_TIMEOUT_MS);
const child = spawn(command, { shell: true, env: process.env, detached: process.platform !== "win32" });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  process.stderr.write("${TIMEOUT_MARKER}\\n");
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => process.exit(124));
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    setTimeout(() => process.exit(124), 50);
  }
}, timeout);
child.on("error", (error) => {
  clearTimeout(timer);
  process.stderr.write("${ABNORMAL_MARKER} " + error.message + "\\n");
  process.exit(125);
});
child.on("close", (code, signal) => {
  if (timedOut) return;
  clearTimeout(timer);
  if (signal || code === null) {
    process.stderr.write("${ABNORMAL_MARKER} signal=" + (signal || "unknown") + "\\n");
    process.exit(125);
  }
  process.exit(code);
});
`;
function result(kind, ruleId, subject, quote, verdict, evidence, options = {}) {
  return { claim: { kind, subject, quote }, ruleId, verdict, evidence, ...options };
}
function loadPullRequestEvidence(path) {
  const size = statSync2(path).size;
  if (size > 2 * 1024 * 1024) throw new Error(`pull request event is ${size} bytes; maximum is ${2 * 1024 * 1024}`);
  let event;
  try {
    event = JSON.parse(readFileSync5(path, "utf8"));
  } catch {
    throw new Error(`pull request event is not valid JSON: ${path}`);
  }
  if (!event?.pull_request || typeof event.pull_request !== "object") throw new Error("event does not contain a pull_request object");
  const author = event.pull_request.user?.login;
  const body = event.pull_request.body;
  if (typeof author !== "string" || !author.trim()) throw new Error("pull request event does not identify the author");
  if (body !== null && body !== void 0 && typeof body !== "string") throw new Error("pull request body must be text");
  return {
    author,
    body: body ?? "",
    ...typeof event.pull_request.base?.sha === "string" ? { baseSha: event.pull_request.base.sha } : {},
    ...typeof event.pull_request.head?.sha === "string" ? { headSha: event.pull_request.head.sha } : {}
  };
}
function capture(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return body.match(new RegExp(`^\\s*-\\s*${escaped}\\s*:\\s*(.+?)\\s*$`, "im"))?.[1]?.trim();
}
function checked(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*-\\s*\\[[xX]\\]\\s*${escaped}\\s*$`, "im").test(body);
}
function checkAttestations(evidence, policy) {
  const out = [];
  const humanReview = policy.reviewMode === "human" || policy.reviewMode === void 0 && policy.requireHumanAttestation !== false;
  if (humanReview) {
    const responsible = capture(evidence.body, "Responsible human");
    const normalized = responsible?.replace(/^@/, "").toLowerCase();
    const matches = normalized === evidence.author.toLowerCase();
    out.push(result(
      "policy_attestation",
      "responsible-human",
      "named responsible human",
      responsible ?? "missing",
      matches ? "verified" : "contradicted",
      matches ? `PR author @${evidence.author} made the required responsibility declaration; this verifies attribution, not understanding` : responsible ? `declared ${responsible}, but the GitHub event identifies @${evidence.author} as the PR author` : "required `Responsible human: @login` declaration is missing"
    ));
    for (const label of ["I reviewed every changed line.", "I can explain and maintain this change."]) {
      const present = checked(evidence.body, label);
      out.push(result(
        "policy_attestation",
        label.startsWith("I reviewed") ? "human-review-attestation" : "human-maintenance-attestation",
        label,
        present ? "checked" : "missing",
        present ? "verified" : "contradicted",
        present ? "required human declaration is checked; Agent Vigil does not independently prove the declarant's understanding" : `required checked declaration is missing: ${label}`
      ));
    }
  }
  if (policy.requireAiDisclosure !== false) {
    const disclosure = capture(evidence.body, "AI assistance")?.toLowerCase();
    const allowed = /* @__PURE__ */ new Set(["none", "assisted", "agent"]);
    out.push(result(
      "policy_attestation",
      "ai-assistance-disclosure",
      "AI assistance disclosure",
      disclosure ?? "missing",
      disclosure !== void 0 && allowed.has(disclosure) ? "verified" : "contradicted",
      disclosure !== void 0 && allowed.has(disclosure) ? `declared ${disclosure}` : "use exactly one of: none, assisted, agent"
    ));
  }
  if (policy.requireLinkedIssue) {
    const issue = capture(evidence.body, "Linked issue");
    const valid = Boolean(issue && /(?:^|\s)(?:#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+)(?:\s|$)/i.test(issue));
    out.push(result(
      "policy_attestation",
      "linked-issue",
      "linked approved issue",
      issue ?? "missing",
      valid ? "verified" : "contradicted",
      valid ? `declared ${issue}; syntax is verified, but issue approval/state is not fetched` : "provide `#123` or a full GitHub issue URL"
    ));
  }
  return out;
}
function git3(repo, args) {
  return execFileSync4("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }).trim();
}
function globRegex(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
function pathMatches(path, patterns) {
  const clean = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return patterns.some((pattern) => globRegex(pattern.replaceAll("\\", "/").replace(/^\.\//, "")).test(clean));
}
function collectDiffEvidence(repo, base, head, testPathPatterns = DEFAULT_TEST_PATTERNS) {
  const paths = git3(repo, ["diff", "--name-only", "--diff-filter=ACMR", `${base}..${head}`]).split("\n").filter(Boolean);
  const binaryPaths = [];
  let changedLines = 0;
  const numstat = git3(repo, ["diff", "--numstat", `${base}..${head}`]);
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [added, removed, ...pathParts] = line.split("	");
    const path = pathParts.join("	");
    if (added === "-" || removed === "-") binaryPaths.push(path);
    else changedLines += Number(added) + Number(removed);
  }
  return { paths, testPaths: paths.filter((path) => pathMatches(path, testPathPatterns)), ...binaryPaths.length ? {} : { changedLines }, binaryPaths };
}
function checkChangeScope(diff, policy) {
  const out = [];
  if (policy.maxChangedFiles !== void 0) {
    out.push(result(
      "change_scope",
      "changed-file-budget",
      "changed-file budget",
      `${diff.paths.length} changed files`,
      diff.paths.length <= policy.maxChangedFiles ? "verified" : "contradicted",
      `${diff.paths.length} changed file(s); policy maximum is ${policy.maxChangedFiles}`
    ));
  }
  if (policy.maxChangedLines !== void 0) {
    if (diff.changedLines === void 0) out.push(result("change_scope", "changed-line-budget", "changed-line budget", "binary diff present", "unverifiable", `Git numstat cannot quantify binary path(s): ${diff.binaryPaths.join(", ")}`, { blocksPass: true }));
    else out.push(result(
      "change_scope",
      "changed-line-budget",
      "changed-line budget",
      `${diff.changedLines} changed lines`,
      diff.changedLines <= policy.maxChangedLines ? "verified" : "contradicted",
      `${diff.changedLines} added/deleted line(s); policy maximum is ${policy.maxChangedLines}`
    ));
  }
  if (policy.requireTestChange) {
    out.push(result(
      "change_scope",
      "test-change-required",
      "changed test evidence",
      diff.testPaths.join(", ") || "none",
      diff.testPaths.length ? "verified" : "contradicted",
      diff.testPaths.length ? `${diff.testPaths.length} changed test path(s): ${diff.testPaths.join(", ")}` : "no changed path matched the policy testPathPatterns"
    ));
  }
  if (policy.protectedPaths?.length) {
    const matches = diff.paths.filter((path) => pathMatches(path, policy.protectedPaths));
    out.push(result(
      "change_scope",
      "protected-path",
      "protected path policy",
      matches.join(", ") || "none",
      matches.length ? "contradicted" : "verified",
      matches.length ? `candidate changed protected path(s): ${matches.join(", ")}` : "no candidate path matched protectedPaths",
      { contributesToPass: false }
    ));
  }
  return out;
}
function shell(command, cwd, timeoutMs) {
  const env = {
    ...process.env,
    CI: "true",
    VIGIL_WRAPPED_COMMAND: command,
    VIGIL_WRAPPED_TIMEOUT_MS: String(timeoutMs)
  };
  delete env.NODE_TEST_CONTEXT;
  const execution = spawnSync2(process.execPath, ["-e", COMMAND_WRAPPER], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs + 1e4,
    maxBuffer: 4 * 1024 * 1024,
    env
  });
  const full = `${execution.stdout ?? ""}${execution.stderr ?? ""}`;
  const output = full.length > MAX_COMMAND_OUTPUT ? `${full.slice(0, MAX_COMMAND_OUTPUT)}
[output truncated]` : full;
  const wrapperError = full.includes(TIMEOUT_MARKER) ? `command timed out after ${timeoutMs} ms` : full.includes(ABNORMAL_MARKER) ? "command ended abnormally" : execution.error?.message;
  return { status: execution.status, signal: execution.signal, output, ...wrapperError ? { error: wrapperError } : {} };
}
function unsafeOverlayPath(path) {
  const clean = normalize2(path);
  return clean === ".." || clean.startsWith(`..${sep3}`) || resolve4("/safe", clean) === "/safe";
}
function overlayTests(headWorktree, baseWorktree, paths) {
  for (const path of paths) {
    if (unsafeOverlayPath(path)) return `unsafe overlay path: ${path}`;
    const source = resolve4(headWorktree, path);
    const target = resolve4(baseWorktree, path);
    if (!source.startsWith(`${resolve4(headWorktree)}${sep3}`) || !target.startsWith(`${resolve4(baseWorktree)}${sep3}`)) return `overlay escaped worktree: ${path}`;
    if (!existsSync3(source)) continue;
    if (lstatSync2(source).isSymbolicLink()) return `refusing to overlay symlink test path: ${path}`;
    mkdirSync2(dirname2(target), { recursive: true });
    cpSync(source, target, { recursive: true, force: true });
  }
  return void 0;
}
function summarize(outcome) {
  const last = outcome.output.trim().split("\n").slice(-3).join(" | ");
  return `exit=${outcome.status ?? "none"}${outcome.signal ? ` signal=${outcome.signal}` : ""}${outcome.error ? ` error=${outcome.error}` : ""}${last ? ` output=${last}` : ""}`;
}
function trackedStatus(repo) {
  return git3(repo, ["status", "--porcelain=v1", "--untracked-files=no"]);
}
function checkAutomatedReview(repo, head, policy) {
  const out = [result(
    "policy_attestation",
    "automated-review-mode",
    "automated review policy",
    `${policy.commands.length} base-policy command(s)`,
    "verified",
    "the trusted base policy selected isolated automated review; this proves repeatable checks, not human understanding",
    { contributesToPass: false }
  )];
  const expectedHead = git3(repo, ["rev-parse", head]);
  const root = mkdtempSync2(join3(tmpdir2(), "agent-vigil-automated-review-"));
  const candidate = join3(root, "candidate");
  const timeoutMs = (policy.timeoutSeconds ?? 300) * 1e3;
  let worktreeAdded = false;
  try {
    execFileSync4("git", ["worktree", "add", "--detach", candidate, expectedHead], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    worktreeAdded = true;
    const initialHead = git3(candidate, ["rev-parse", "HEAD"]);
    if (initialHead !== expectedHead) {
      out.push(result(
        "integrity",
        "automated-review-head",
        "exact candidate checkout",
        expectedHead,
        "unverifiable",
        `isolated checkout resolved to ${initialHead} instead of ${expectedHead}`,
        { blocksPass: true }
      ));
      return out;
    }
    if (policy.setupCommand) {
      const setup = shell(policy.setupCommand, candidate, timeoutMs);
      if (setup.status === null || setup.signal || setup.error) {
        out.push(result(
          "command_ran",
          "automated-review-setup",
          "automated review setup",
          policy.setupCommand,
          "unverifiable",
          `setup did not terminate normally; ${summarize(setup)}`,
          { blocksPass: true }
        ));
        return out;
      }
      if (setup.status !== 0) {
        out.push(result(
          "command_ran",
          "automated-review-setup",
          "automated review setup",
          policy.setupCommand,
          "contradicted",
          `base-policy setup command failed; ${summarize(setup)}`
        ));
        return out;
      }
      out.push(result(
        "command_ran",
        "automated-review-setup",
        "automated review setup",
        policy.setupCommand,
        "verified",
        "base-policy setup command completed in the isolated candidate checkout",
        { contributesToPass: false }
      ));
    }
    const preparedHead = git3(candidate, ["rev-parse", "HEAD"]);
    const preparedStatus = trackedStatus(candidate);
    if (preparedHead !== expectedHead) {
      out.push(result(
        "integrity",
        "automated-review-head",
        "candidate commit remained fixed during setup",
        expectedHead,
        "unverifiable",
        `setup moved HEAD to ${preparedHead}`,
        { blocksPass: true }
      ));
      return out;
    }
    if (preparedStatus) {
      out.push(result(
        "integrity",
        "automated-review-worktree",
        "setup preserved tracked candidate files",
        "clean",
        "contradicted",
        `setup modified tracked path(s): ${preparedStatus.split("\n").join(", ")}`
      ));
      return out;
    }
    for (const [index, command] of policy.commands.entries()) {
      const outcome = shell(command, candidate, timeoutMs);
      const observedHead = git3(candidate, ["rev-parse", "HEAD"]);
      const observedStatus = trackedStatus(candidate);
      const label = `automated review command ${index + 1}`;
      if (observedHead !== expectedHead) {
        out.push(result(
          "integrity",
          "automated-review-head",
          label,
          command,
          "unverifiable",
          `command moved HEAD to ${observedHead}; expected ${expectedHead}`,
          { blocksPass: true }
        ));
        return out;
      }
      if (observedStatus !== preparedStatus) {
        out.push(result(
          "integrity",
          "automated-review-worktree",
          label,
          command,
          "contradicted",
          `command modified tracked path(s): ${observedStatus.split("\n").filter(Boolean).join(", ") || "previous tracked changes were removed"}`
        ));
        return out;
      }
      if (outcome.status === null || outcome.signal || outcome.error) {
        out.push(result(
          "command_ran",
          "automated-review-command",
          label,
          command,
          "unverifiable",
          `command did not terminate normally; ${summarize(outcome)}`,
          { blocksPass: true }
        ));
        return out;
      }
      if (outcome.status !== 0) {
        out.push(result(
          "command_ran",
          "automated-review-command",
          label,
          command,
          "contradicted",
          `base-policy command failed; ${summarize(outcome)}`
        ));
        return out;
      }
      out.push(result(
        "command_ran",
        "automated-review-command",
        label,
        command,
        "verified",
        `base-policy command exited 0 in an isolated checkout of ${expectedHead.slice(0, 12)}`
      ));
    }
    return out;
  } catch (error) {
    out.push(result(
      "integrity",
      "automated-review-worktree",
      "isolated automated review checkout",
      expectedHead,
      "unverifiable",
      `could not run isolated automated review: ${error.message}`,
      { blocksPass: true }
    ));
    return out;
  } finally {
    if (worktreeAdded) {
      try {
        execFileSync4("git", ["worktree", "remove", "--force", candidate], { cwd: repo, stdio: "ignore" });
      } catch {
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
function checkDifferentialTest(repo, base, head, testPaths, policy) {
  if (policy.overlayChangedTests !== false && testPaths.length === 0) {
    return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "contradicted", "no changed test artifact is available to exercise against the base source");
  }
  const root = mkdtempSync2(join3(tmpdir2(), "agent-vigil-differential-"));
  const baseWorktree = join3(root, "base");
  const headWorktree = join3(root, "head");
  const timeoutMs = (policy.timeoutSeconds ?? 300) * 1e3;
  let baseAdded = false;
  let headAdded = false;
  try {
    execFileSync4("git", ["worktree", "add", "--detach", baseWorktree, base], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    baseAdded = true;
    execFileSync4("git", ["worktree", "add", "--detach", headWorktree, head], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    headAdded = true;
    if (policy.overlayChangedTests !== false) {
      const error = overlayTests(headWorktree, baseWorktree, testPaths);
      if (error) return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "unverifiable", error, { blocksPass: true });
    }
    if (policy.setupCommand) {
      const headSetup = shell(policy.setupCommand, headWorktree, timeoutMs);
      const baseSetup = shell(policy.setupCommand, baseWorktree, timeoutMs);
      if (headSetup.status !== 0 || baseSetup.status !== 0) {
        return result(
          "differential_test",
          "differential-setup",
          "isolated differential setup",
          policy.setupCommand,
          "unverifiable",
          `setup did not succeed in both isolated worktrees; head ${summarize(headSetup)}; base ${summarize(baseSetup)}`,
          { blocksPass: true }
        );
      }
    }
    const headOutcome = shell(policy.command, headWorktree, timeoutMs);
    const baseOutcome = shell(policy.command, baseWorktree, timeoutMs);
    if (headOutcome.status === null || baseOutcome.status === null || headOutcome.signal || baseOutcome.signal || headOutcome.error || baseOutcome.error) {
      return result(
        "differential_test",
        "differential-test",
        "base-fail/head-pass regression proof",
        policy.command,
        "unverifiable",
        `command did not terminate normally in both worktrees; head ${summarize(headOutcome)}; base ${summarize(baseOutcome)}`,
        { blocksPass: true }
      );
    }
    if (headOutcome.status !== 0) {
      return result("differential_test", "differential-head-pass", "candidate passes changed regression test", policy.command, "contradicted", `candidate command failed; ${summarize(headOutcome)}`);
    }
    if (baseOutcome.status === 0) {
      return result(
        "differential_test",
        "differential-base-fail",
        "base fails changed regression test",
        policy.command,
        "contradicted",
        "the changed test command also passed against the base source; the test does not demonstrate the claimed regression"
      );
    }
    if (policy.baseFailurePattern && !new RegExp(policy.baseFailurePattern).test(baseOutcome.output)) {
      return result(
        "differential_test",
        "differential-failure-pattern",
        "base failure matches expected regression",
        policy.baseFailurePattern,
        "contradicted",
        `base failed, but output did not match the trusted failure pattern; ${summarize(baseOutcome)}`
      );
    }
    return result(
      "differential_test",
      "differential-test",
      "base-fail/head-pass regression proof",
      policy.command,
      "verified",
      `isolated candidate passed and base source failed with the candidate's changed test artifact(s): ${testPaths.join(", ")}`
    );
  } catch (error) {
    return result("differential_test", "differential-test", "base-fail/head-pass regression proof", policy.command, "unverifiable", `could not create isolated Git worktrees: ${error.message}`, { blocksPass: true });
  } finally {
    if (headAdded) {
      try {
        execFileSync4("git", ["worktree", "remove", "--force", headWorktree], { cwd: repo, stdio: "ignore" });
      } catch {
      }
    }
    if (baseAdded) {
      try {
        execFileSync4("git", ["worktree", "remove", "--force", baseWorktree], { cwd: repo, stdio: "ignore" });
      } catch {
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
function buildMaintainerChecks(repo, base, head, evidence, policy) {
  const patterns = policy.testPathPatterns ?? DEFAULT_TEST_PATTERNS;
  const diff = collectDiffEvidence(repo, base, head, patterns);
  const checks = [...checkAttestations(evidence, policy), ...checkChangeScope(diff, policy)];
  if (policy.differentialTest) checks.push(checkDifferentialTest(repo, base, head, diff.testPaths, policy.differentialTest));
  if (policy.reviewMode === "automated" && policy.automatedReview) checks.push(...checkAutomatedReview(repo, head, policy.automatedReview));
  return checks;
}

// src/authority.ts
var ACTION_CLASSES = [
  "repository_read",
  "repository_write",
  "test_execute",
  "build_execute",
  "dependency_install",
  "network_read",
  "credential_access",
  "destructive_filesystem",
  "git_commit",
  "git_push",
  "pull_request_write",
  "release_publish",
  "deploy",
  "external_write",
  "task_create",
  "unknown_effect"
];
var MAX_CONTRACT_BYTES = 1024 * 1024;
var ACTION_SET = new Set(ACTION_CLASSES);
function result2(kind, ruleId, subject, quote, verdict, evidence, options = {}) {
  return { claim: { kind, subject, quote }, ruleId, verdict, evidence, ...options };
}
function stringArray(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || !allowEmpty && value.length === 0 || value.some((item2) => typeof item2 !== "string" || !item2.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return value;
}
function validatePatterns(patterns, label) {
  if (patterns.length > 1e3) throw new Error(`${label} must contain at most 1000 patterns`);
  for (const pattern of patterns) {
    if (pattern.length > 500) throw new Error(`${label} patterns must contain at most 500 characters`);
    const clean = normalize3(pattern).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isAbsolute3(pattern) || win322.isAbsolute(pattern) || clean === ".." || clean.startsWith("../")) {
      throw new Error(`${label} patterns must stay inside the repository`);
    }
  }
}
function optionalLimit(value, label) {
  if (value === void 0) return void 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}
function validateAuthorityContract(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("authority contract must be a JSON object");
  const value = input;
  const allowedFields = /* @__PURE__ */ new Set([
    "schemaVersion",
    "taskId",
    "allowedChangePaths",
    "deniedChangePaths",
    "allowedActions",
    "requireCompleteToolResults",
    "maxToolCalls",
    "maxFailedToolCalls",
    "maxIdenticalToolCalls",
    "maxConsecutiveFailedToolCalls",
    "maxObservedTokens",
    "maxTokensWithoutObservedProgress",
    "expiresAt"
  ]);
  const unknownFields = Object.keys(value).filter((key) => !allowedFields.has(key));
  if (unknownFields.length) throw new Error(`authority contract contains unknown field(s): ${unknownFields.join(", ")}`);
  if (value.schemaVersion !== 1) throw new Error("authority contract schemaVersion must be 1");
  if (typeof value.taskId !== "string" || !value.taskId.trim() || value.taskId.length > 200) throw new Error("authority contract taskId must be a non-empty string of at most 200 characters");
  const allowedChangePaths = stringArray(value.allowedChangePaths, "authority contract allowedChangePaths");
  validatePatterns(allowedChangePaths, "allowedChangePaths");
  let deniedChangePaths;
  if (value.deniedChangePaths !== void 0) {
    deniedChangePaths = stringArray(value.deniedChangePaths, "authority contract deniedChangePaths");
    validatePatterns(deniedChangePaths, "deniedChangePaths");
  }
  const allowedActions = stringArray(value.allowedActions, "authority contract allowedActions", true);
  if (allowedActions.length > ACTION_CLASSES.length) throw new Error("authority contract allowedActions contains too many entries");
  const invalidActions = allowedActions.filter((action) => !ACTION_SET.has(action));
  if (invalidActions.length) throw new Error(`authority contract contains unsupported action class(es): ${invalidActions.join(", ")}`);
  if (value.requireCompleteToolResults !== void 0 && typeof value.requireCompleteToolResults !== "boolean") {
    throw new Error("authority contract requireCompleteToolResults must be boolean");
  }
  const maxToolCalls = optionalLimit(value.maxToolCalls, "authority contract maxToolCalls");
  const maxFailedToolCalls = optionalLimit(value.maxFailedToolCalls, "authority contract maxFailedToolCalls");
  const maxIdenticalToolCalls = optionalLimit(value.maxIdenticalToolCalls, "authority contract maxIdenticalToolCalls");
  const maxConsecutiveFailedToolCalls = optionalLimit(value.maxConsecutiveFailedToolCalls, "authority contract maxConsecutiveFailedToolCalls");
  const maxObservedTokens = optionalLimit(value.maxObservedTokens, "authority contract maxObservedTokens");
  const maxTokensWithoutObservedProgress = optionalLimit(value.maxTokensWithoutObservedProgress, "authority contract maxTokensWithoutObservedProgress");
  if (value.expiresAt !== void 0) {
    if (typeof value.expiresAt !== "string" || !value.expiresAt.trim() || !Number.isFinite(new Date(value.expiresAt).getTime())) {
      throw new Error("authority contract expiresAt must be an ISO-compatible timestamp");
    }
  }
  return {
    schemaVersion: 1,
    taskId: value.taskId.trim(),
    allowedChangePaths,
    ...deniedChangePaths ? { deniedChangePaths } : {},
    allowedActions,
    ...value.requireCompleteToolResults !== void 0 ? { requireCompleteToolResults: value.requireCompleteToolResults } : {},
    ...maxToolCalls !== void 0 ? { maxToolCalls } : {},
    ...maxFailedToolCalls !== void 0 ? { maxFailedToolCalls } : {},
    ...maxIdenticalToolCalls !== void 0 ? { maxIdenticalToolCalls } : {},
    ...maxConsecutiveFailedToolCalls !== void 0 ? { maxConsecutiveFailedToolCalls } : {},
    ...maxObservedTokens !== void 0 ? { maxObservedTokens } : {},
    ...maxTokensWithoutObservedProgress !== void 0 ? { maxTokensWithoutObservedProgress } : {},
    ...value.expiresAt !== void 0 ? { expiresAt: new Date(value.expiresAt).toISOString() } : {}
  };
}
function parseContract(raw, source) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`authority contract is not valid JSON: ${source}`);
  }
  return validateAuthorityContract(parsed);
}
function loadAuthorityContract(repo, requested, ref) {
  if (ref) {
    const clean = normalize3(requested).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isAbsolute3(requested) || win322.isAbsolute(requested) || clean === ".." || clean.startsWith("../")) {
      throw new Error("contract-ref requires a repository-relative contract path");
    }
    let raw;
    try {
      raw = execFileSync5("git", ["show", `${ref}:${clean}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_CONTRACT_BYTES });
    } catch {
      throw new Error(`authority contract not found at ${ref}:${clean}`);
    }
    if (Buffer.byteLength(raw) > MAX_CONTRACT_BYTES) throw new Error(`authority contract exceeds ${MAX_CONTRACT_BYTES} bytes`);
    const value2 = parseContract(raw, `${ref}:${clean}`);
    return { value: value2, sha256: `sha256:${createHash4("sha256").update(canonical(value2)).digest("hex")}`, source: `${clean}@${ref}`, gitPath: clean, ref };
  }
  const path = resolve5(repo, requested);
  const size = statSync3(path).size;
  if (size > MAX_CONTRACT_BYTES) throw new Error(`authority contract is ${size} bytes; maximum is ${MAX_CONTRACT_BYTES}`);
  const value = parseContract(readFileSync6(path, "utf8"), path);
  return { value, sha256: `sha256:${createHash4("sha256").update(canonical(value)).digest("hex")}`, source: relative3(repo, path) || requested, path };
}
function inputObject(call) {
  try {
    const parsed = JSON.parse(call.input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : void 0;
  } catch {
    return void 0;
  }
}
function commandText(call) {
  const input = inputObject(call);
  for (const key of ["cmd", "command", "script"]) {
    if (typeof input?.[key] === "string") return input[key];
  }
  if (/exec|bash|shell|terminal|command/i.test(call.name)) return call.input;
  return void 0;
}
function splitShellCommands(command) {
  const out = [];
  let current = "";
  let quote;
  let escaped = false;
  let substitutionDepth = 0;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = void 0;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "$" && next === "(") {
      substitutionDepth += 1;
      current += "$";
      continue;
    }
    if (char === ")" && substitutionDepth > 0) {
      substitutionDepth -= 1;
      current += char;
      continue;
    }
    const separator = substitutionDepth === 0 && (char === "\n" || char === ";" || char === "|" || char === "&");
    if (separator) {
      if (current.trim()) out.push(current.trim());
      current = "";
      if (char === "|" && next === "|" || char === "&" && next === "&") index += 1;
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
function classesForCommand(raw) {
  const command = raw.trim().replace(/^(?:sudo\s+|env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+)+/, "");
  const classes = /* @__PURE__ */ new Set();
  const add = (...items) => items.forEach((item2) => classes.add(item2));
  if (/^(?:ls|pwd|cat|head|tail|grep|rg|find|stat|wc|diff|jq|sed\s+(?!.*(?:-i|--in-place))|git\s+(?:status|diff|log|show|rev-parse|ls-files|remote\s+-v)\b)/i.test(command)) add("repository_read");
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|typecheck|smoke|verify)|exec\s+.*test)|^(?:pytest|python\s+-m\s+pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|make\s+(?:test|check|verify))\b/i.test(command)) add("test_execute");
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+build|build)|^(?:cargo|go|dotnet|mvn|gradle|make)\s+build\b/i.test(command)) add("build_execute");
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|pipx?\s+install\b|python\s+-m\s+pip\s+install\b|uv\s+(?:add|sync|pip\s+install)\b|brew\s+install\b|apt(?:-get)?\s+install\b|dnf\s+install\b|gem\s+install\b)/i.test(command)) add("dependency_install");
  if (/^(?:rm|rmdir|del|erase|trash)\b|\bgit\s+(?:clean|reset\s+--hard)\b/i.test(command)) add("destructive_filesystem");
  if (/^git\s+commit\b/i.test(command)) add("git_commit");
  if (/^git\s+push\b/i.test(command)) add("git_push");
  if (/^gh\s+pr\s+(?:create|merge|close|comment|edit|review)\b/i.test(command)) add("pull_request_write");
  if (/^(?:gh\s+release\s+(?:create|upload|edit|delete)|npm\s+publish|cargo\s+publish|twine\s+upload)\b/i.test(command)) add("release_publish");
  if (/^(?:vercel|netlify|wrangler\s+deploy|flyctl\s+deploy|gcloud\s+(?:run\s+deploy|app\s+deploy)|aws\s+.*deploy|kubectl\s+(?:apply|delete|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+apply)\b/i.test(command)) add("deploy");
  if (/^(?:curl|wget)\b/i.test(command)) add(/(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b|--data(?:-\w+)?\b|-d\s)/i.test(command) ? "external_write" : "network_read");
  if (/^(?:gh\s+(?:issue|api)\s+.*(?:comment|create|edit|delete)|mail|sendmail|osascript\s+.*mail)\b/i.test(command)) add("external_write");
  if (/(?:\.env\b|\.ssh\/|credentials?|api[_-]?key|token|secret|keychain|security\s+find-generic-password)/i.test(command)) add("credential_access");
  if (/^(?:git\s+(?:add|checkout|switch|restore|mv|rm)|mkdir|touch|cp|mv|sed\s+.*(?:-i|--in-place)|tee\b|printf\b.*>|echo\b.*>)\b/i.test(command)) add("repository_write");
  if (/^(?:sh|bash|zsh|cmd|powershell|pwsh)\s+(?:-c|\/c)\b|\beval\b/i.test(command)) add("unknown_effect");
  if (!classes.size) add("unknown_effect");
  return [...classes];
}
function classifyToolCall(call) {
  const name = call.name.toLowerCase();
  const classes = /* @__PURE__ */ new Set();
  const add = (...items) => items.forEach((item2) => classes.add(item2));
  const command = commandText(call);
  if (command !== void 0) {
    for (const segment of splitShellCommands(command)) for (const item2 of classesForCommand(segment)) classes.add(item2);
  } else if (/create_thread|spawn_agent|delegate/.test(name)) add("task_create");
  else if (/apply[_-]?patch|write|edit|create_file|delete_file/.test(name)) add("repository_write");
  else if (/read|glob|grep|search_files|list_files|view_image/.test(name)) add("repository_read");
  else if (/web|fetch|search_query|open_url|browser/.test(name)) add("network_read");
  else if (/send|email|message|comment|post|submit/.test(name)) add("external_write");
  else add("unknown_effect");
  if (/credential|secret|keychain|token/.test(name)) add("credential_access");
  const identityInput = command ?? call.input;
  return {
    toolCallId: call.id,
    toolName: call.name,
    sequence: call.sequence,
    classes: [...classes],
    summary: command ? command.slice(0, 240).replace(/\s+/g, " ") : call.input.slice(0, 240).replace(/\s+/g, " "),
    identitySha256: `sha256:${createHash4("sha256").update(`${call.name}\0${identityInput}`).digest("hex")}`,
    completed: call.output !== void 0,
    failed: call.isError === true
  };
}
function classifyTranscriptActions(transcript) {
  return transcript.toolCalls.map(classifyToolCall);
}
function analyzeTrajectory(actions) {
  const identities = /* @__PURE__ */ new Map();
  let failureStreak = 0;
  let maxFailureStreak = 0;
  for (const action of actions) {
    identities.set(action.identitySha256, (identities.get(action.identitySha256) ?? 0) + 1);
    failureStreak = action.failed ? failureStreak + 1 : 0;
    maxFailureStreak = Math.max(maxFailureStreak, failureStreak);
  }
  const counts = [...identities.values()];
  const progressClasses = /* @__PURE__ */ new Set(["repository_write", "test_execute", "build_execute", "git_commit"]);
  return {
    toolCalls: actions.length,
    failedToolCalls: actions.filter((action) => action.failed).length,
    maxIdenticalToolCalls: counts.length ? Math.max(...counts) : 0,
    repeatedActionGroups: counts.filter((count2) => count2 > 1).length,
    maxConsecutiveFailedToolCalls: maxFailureStreak,
    progressBearingActions: actions.filter((action) => action.classes.some((item2) => progressClasses.has(item2))).length
  };
}
function buildAuthorityChecks(repo, base, head, transcript, contract, now = /* @__PURE__ */ new Date()) {
  const results = [];
  if (contract.expiresAt) {
    const valid = now.getTime() <= new Date(contract.expiresAt).getTime();
    results.push(result2("authority_scope", "authority-validity", "authority validity window", contract.expiresAt, valid ? "verified" : "contradicted", valid ? `authority remains valid until ${contract.expiresAt}` : `authority expired at ${contract.expiresAt}`));
  } else {
    results.push(result2("authority_scope", "authority-validity", "authority validity window", "no expiry", "unverifiable", "contract has no expiresAt; durable authority can outlive the task", { contributesToPass: false }));
  }
  const diff = collectDiffEvidence(repo, base, head);
  const outside = diff.paths.filter((path) => !pathMatches(path, contract.allowedChangePaths));
  const denied = contract.deniedChangePaths ? diff.paths.filter((path) => pathMatches(path, contract.deniedChangePaths)) : [];
  const pathViolations = [.../* @__PURE__ */ new Set([...outside, ...denied])];
  results.push(result2(
    "authority_scope",
    "authorized-change-paths",
    "repository change boundary",
    diff.paths.join(", ") || "no changed paths",
    pathViolations.length ? "contradicted" : "verified",
    pathViolations.length ? `change exceeded task authority: ${pathViolations.join(", ")}` : `${diff.paths.length} changed path(s) stayed within allowedChangePaths${contract.deniedChangePaths ? " and outside deniedChangePaths" : ""}`
  ));
  const actions = classifyTranscriptActions(transcript);
  if (!actions.length) {
    results.push(result2("authority_action", "observed-action-coverage", "observed agent actions", "no tool calls", "unverifiable", "the transcript contains no structured tool calls; Agent Vigil cannot reconcile authority from narrative alone", { blocksPass: true }));
    return { results, actions };
  }
  const allowed = new Set(contract.allowedActions);
  const trajectory = analyzeTrajectory(actions);
  const violations = actions.flatMap((action) => action.classes.filter((item2) => !allowed.has(item2)).map((item2) => ({ action, item: item2 })));
  results.push(result2(
    "authority_action",
    "authorized-action-classes",
    "observed action boundary",
    `${actions.length} observed tool call(s)`,
    violations.length ? "contradicted" : "verified",
    violations.length ? violations.slice(0, 20).map(({ action, item: item2 }) => `#${action.sequence} ${action.toolName}: ${item2}`).join("; ") : `${actions.length} observed tool call(s) classified only into allowedActions`
  ));
  if (contract.maxToolCalls !== void 0) {
    const exceeded = actions.length > contract.maxToolCalls;
    results.push(result2(
      "authority_scope",
      "tool-call-budget",
      "observed tool-call budget",
      `${actions.length}/${contract.maxToolCalls} tool call(s)`,
      exceeded ? "contradicted" : "verified",
      exceeded ? `observed ${actions.length} tool calls; contract permits at most ${contract.maxToolCalls}` : `observed tool calls stayed within the ${contract.maxToolCalls} call limit`
    ));
  }
  if (contract.maxFailedToolCalls !== void 0) {
    const failed = trajectory.failedToolCalls;
    const exceeded = failed > contract.maxFailedToolCalls;
    results.push(result2(
      "authority_scope",
      "failed-tool-call-budget",
      "observed failed-tool-call budget",
      `${failed}/${contract.maxFailedToolCalls} failed tool call(s)`,
      exceeded ? "contradicted" : "verified",
      exceeded ? `observed ${failed} failed tool calls; contract permits at most ${contract.maxFailedToolCalls}` : `observed failed tool calls stayed within the ${contract.maxFailedToolCalls} failure limit`
    ));
  }
  if (contract.maxIdenticalToolCalls !== void 0) {
    const observed = trajectory.maxIdenticalToolCalls;
    const exceeded = observed > contract.maxIdenticalToolCalls;
    results.push(result2(
      "authority_scope",
      "identical-tool-call-budget",
      "identical observed tool-call budget",
      `${observed}/${contract.maxIdenticalToolCalls} identical call(s)`,
      exceeded ? "contradicted" : "verified",
      exceeded ? `one exact observed tool action repeated ${observed} times; contract permits at most ${contract.maxIdenticalToolCalls}` : `identical observed tool calls stayed within the ${contract.maxIdenticalToolCalls} call limit`
    ));
  }
  if (contract.maxConsecutiveFailedToolCalls !== void 0) {
    const observed = trajectory.maxConsecutiveFailedToolCalls;
    const exceeded = observed > contract.maxConsecutiveFailedToolCalls;
    results.push(result2(
      "authority_scope",
      "consecutive-failure-budget",
      "consecutive failed tool-call budget",
      `${observed}/${contract.maxConsecutiveFailedToolCalls} consecutive failure(s)`,
      exceeded ? "contradicted" : "verified",
      exceeded ? `observed a streak of ${observed} failed tool calls; contract permits at most ${contract.maxConsecutiveFailedToolCalls}` : `consecutive failed tool calls stayed within the ${contract.maxConsecutiveFailedToolCalls} failure limit`
    ));
  }
  if (contract.maxObservedTokens !== void 0) {
    const observed = transcript.usage?.totalTokens;
    if (observed === void 0) {
      results.push(result2("authority_scope", "observed-token-budget", "observed token budget", `unknown/${contract.maxObservedTokens} tokens`, "unverifiable", "the transcript adapter exposed no token accounting, so the declared token budget cannot be checked", { blocksPass: true }));
    } else {
      const exceeded = observed > contract.maxObservedTokens;
      results.push(result2(
        "authority_scope",
        "observed-token-budget",
        "observed token budget",
        `${observed}/${contract.maxObservedTokens} tokens`,
        exceeded ? "contradicted" : "verified",
        exceeded ? `observed ${observed} tokens; contract permits at most ${contract.maxObservedTokens}` : `observed tokens stayed within the ${contract.maxObservedTokens} token limit`
      ));
    }
  }
  if (contract.maxTokensWithoutObservedProgress !== void 0) {
    const observed = transcript.usage?.totalTokens;
    if (observed === void 0) {
      results.push(result2("authority_scope", "no-progress-token-budget", "token spend without an observed write, test, build, or commit", `unknown/${contract.maxTokensWithoutObservedProgress} tokens`, "unverifiable", "the transcript adapter exposed no token accounting, so the no-progress token limit cannot be checked", { blocksPass: true }));
    } else {
      const exceeded = trajectory.progressBearingActions === 0 && observed > contract.maxTokensWithoutObservedProgress;
      results.push(result2(
        "authority_scope",
        "no-progress-token-budget",
        "token spend without an observed write, test, build, or commit",
        `${observed} tokens \xB7 ${trajectory.progressBearingActions} progress-bearing action(s)`,
        exceeded ? "contradicted" : "verified",
        exceeded ? `observed ${observed} tokens without a repository write, test, build, or commit; contract permits at most ${contract.maxTokensWithoutObservedProgress}` : trajectory.progressBearingActions ? `${trajectory.progressBearingActions} progress-bearing action(s) were observed; this whole-session guard does not claim every intermediate token created progress` : `no progress-bearing action was observed, but token usage stayed within ${contract.maxTokensWithoutObservedProgress}`
      ));
    }
  }
  const unknown = actions.filter((action) => action.classes.includes("unknown_effect"));
  if (unknown.length && allowed.has("unknown_effect")) {
    results.push(result2("authority_action", "unknown-action-risk", "unclassified observed effects", `${unknown.length} unknown action(s)`, "unverifiable", `unknown_effect was explicitly allowed, so ${unknown.length} action(s) cannot be meaningfully bounded`, { blocksPass: true }));
  }
  if (contract.requireCompleteToolResults !== false) {
    const incomplete = actions.filter((action) => !action.completed);
    results.push(result2(
      "telemetry",
      "complete-tool-results",
      "tool-result completeness",
      `${actions.length - incomplete.length}/${actions.length} completed`,
      incomplete.length ? "unverifiable" : "verified",
      incomplete.length ? `missing results for tool call(s): ${incomplete.map((action) => action.toolCallId).join(", ")}` : "every observed tool call has a recorded result",
      incomplete.length ? { blocksPass: true } : {}
    ));
  }
  return { results, actions };
}
function authorityContractTemplate() {
  const value = {
    schemaVersion: 1,
    taskId: "REPLACE_WITH_TASK_OR_TICKET_ID",
    allowedChangePaths: ["src/**", "test/**", "docs/**"],
    deniedChangePaths: [".github/workflows/**", ".env*", "**/*.pem", "**/*.key"],
    allowedActions: ["repository_read", "repository_write", "test_execute", "build_execute"],
    requireCompleteToolResults: true,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString()
  };
  return `${JSON.stringify(value, null, 2)}
`;
}

// src/setup.ts
var PUBLISHED_ACTION_VERSION = "0.15.0";
function workflow(mode, setupCommand, attest = false) {
  return `name: Agent Vigil

on:
  pull_request:
    types: [opened, synchronize, reopened]
  merge_group:
    types: [checks_requested]

permissions:
  contents: read
  pull-requests: read
${attest ? `  id-token: write
  attestations: write
  artifact-metadata: write
` : ""}

jobs:
  evidence:
    name: Agent Vigil evidence
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
${mode === "maintainer" && setupCommand ? `      - name: Install dependencies for fresh verification
        run: ${setupCommand}
` : ""}      - id: vigil
        uses: sulmusic2-star/agent-vigil@v${PUBLISHED_ACTION_VERSION}
        with:
          ${attest ? "attest: true\n          " : ""}${mode === "portable" ? "receipt: .agent-vigil/receipt.json" : mode === "maintainer" ? "mode: maintainer" : mode === "authority" ? "transcript: .agent-vigil/session.jsonl\n          authority-contract: .agent-vigil-authority.json\n          authority-contract-ref: ${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}" : "transcript: .agent-vigil/session.md"}
          policy: .agent-vigil.json
          policy-ref: \${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
          repo: .
          base: \${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}
          head: \${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}
          github-token: \${{ github.token }}
      - name: Retain auditable Agent Vigil receipt
        if: always() && steps.vigil.outputs.report != ''
        uses: actions/upload-artifact@v4
        with:
          name: agent-vigil-receipt
          path: |
            agent-vigil-report.json
            agent-vigil.sarif
            agent-vigil-value-card.json
            agent-vigil-github-evidence.json
          retention-days: 30
`;
}
function outcomeWorkflow() {
  return `name: Agent Vigil outcomes

on:
  workflow_run:
    workflows: [Agent Vigil]
    types: [completed]
  pull_request:
    types: [closed]

permissions:
  actions: read
  contents: read
  pull-requests: read

jobs:
  outcome:
    if: github.event_name == 'pull_request' || github.event.workflow_run.event == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - id: source
        name: Locate the completed evidence run
        env:
          GH_TOKEN: \${{ github.token }}
          EVENT_NAME: \${{ github.event_name }}
          EVENT_RUN_ID: \${{ github.event.workflow_run.id }}
          HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          if [[ "$EVENT_NAME" == "workflow_run" ]]; then
            run_id="$EVENT_RUN_ID"
          else
            run_id=$(gh api --method GET "repos/$GITHUB_REPOSITORY/actions/runs" \\
              -f head_sha="$HEAD_SHA" -f event=pull_request -f status=completed \\
              --jq '.workflow_runs | map(select(.name == "Agent Vigil")) | sort_by(.created_at) | reverse | .[0].id // empty')
          fi
          if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
            echo "No completed Agent Vigil receipt run is available for this outcome." >&2
            exit 2
          fi
          echo "run_id=$run_id" >> "$GITHUB_OUTPUT"
      - name: Download the immutable receipt artifact
        uses: actions/download-artifact@v5
        with:
          name: agent-vigil-receipt
          path: .agent-vigil-prior
          github-token: \${{ github.token }}
          run-id: \${{ steps.source.outputs.run_id }}
      - id: outcome
        uses: sulmusic2-star/agent-vigil@v${PUBLISHED_ACTION_VERSION}
        with:
          mode: outcome
          outcome-receipt: .agent-vigil-prior/agent-vigil-report.json
          actions-run-id: \${{ steps.source.outputs.run_id }}
          github-token: \${{ github.token }}
      - name: Retain the post-run Value Card
        if: always() && steps.outcome.outputs.value-card != ''
        uses: actions/upload-artifact@v4
        with:
          name: agent-vigil-outcome-\${{ steps.source.outputs.run_id }}
          path: |
            \${{ steps.outcome.outputs.value-card }}
            \${{ steps.outcome.outputs.github-evidence }}
          retention-days: 30
`;
}
var MAINTAINER_PR_TEMPLATE = `## Agent Vigil pull request evidence

- AI assistance: assisted
- Linked issue: #REPLACE
- Known limitations: none known

Agent Vigil uses the policy from the base commit. It checks the exact Git range,
scope, fresh tests, integrity rules, and whether the changed regression test
fails against base source and passes against the candidate. The generated
automated-review policy also runs its own commands in an isolated checkout of the
exact candidate commit. It does not claim that a person reviewed or understands
the change.
`;
var SESSION_TEMPLATE = `# Agent change receipt

Replace this file with the coding agent's final summary or point
\`.agent-vigil.json\` at a supported exported transcript.

Agent Vigil will independently compare checkable claims with the selected Git
range and fresh verification. This placeholder intentionally contains no claims,
so strict verification remains INCONCLUSIVE until real evidence is supplied.
`;
var AUTHORITY_SESSION_TEMPLATE = `{"type":"session_meta","payload":{"id":"replace-with-exported-structured-session"}}
`;
var LOCAL_README = `# Agent Vigil evidence input

The workflow reads \`session.md\` by default. Replace it with the agent's actual
final summary, or change \`transcript\` in \`../.agent-vigil.json\` to an exported
Codex, Claude Code, Cursor, Gemini CLI, GitHub Copilot CLI, OpenCode, or Aider
transcript.

Transcripts can contain source code, prompts, paths, and secrets. Review them
before committing or uploading. Agent Vigil reads evidence locally and does not
upload it.
`;
function writeScaffold(root, path, content, force, result5) {
  const target = resolve6(root, path);
  if (existsSync4(target) && !force) {
    result5.kept.push(path);
    return;
  }
  mkdirSync3(dirname3(target), { recursive: true });
  writeFileSync3(target, content);
  result5.created.push(path);
}
function inferProtectCommands(root, testCommand) {
  const commands = [];
  const packagePath = resolve6(root, "package.json");
  if (existsSync4(packagePath)) {
    try {
      const scripts = JSON.parse(readFileSync7(packagePath, "utf8"))?.scripts ?? {};
      for (const name of ["typecheck", "lint", "build"]) {
        if (typeof scripts[name] === "string" && scripts[name].trim()) commands.push(`npm run ${name}`);
      }
    } catch {
    }
  }
  if (testCommand) commands.push(testCommand);
  return [...new Set(commands)].slice(0, 8);
}
function initRepository(repo, force = false, portableSignerKeyId, profile = "default", attest = false) {
  const root = resolve6(repo);
  try {
    execFileSync6("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error(`not a Git repository: ${root}`);
  }
  const result5 = { created: [], kept: [] };
  const inferred = inferTestCommand(root) ?? void 0;
  const mode = profile === "maintainer" || profile === "protect" ? "maintainer" : profile === "authority" ? "authority" : portableSignerKeyId ? "portable" : "transcript";
  const setupCommand = existsSync4(resolve6(root, "package-lock.json")) ? "npm ci --ignore-scripts" : void 0;
  const defaultPolicy = policyTemplate(inferred, portableSignerKeyId);
  const authorityPolicy = defaultPolicy.replace('"transcript": ".agent-vigil/session.md"', '"transcript": ".agent-vigil/session.jsonl"');
  const protectCommands = profile === "protect" ? inferProtectCommands(root, inferred) : void 0;
  writeScaffold(root, DEFAULT_POLICY_FILE, mode === "maintainer" ? maintainerPolicyTemplate(inferred, setupCommand, protectCommands) : mode === "authority" ? authorityPolicy : defaultPolicy, force, result5);
  if (mode === "transcript" || mode === "authority") {
    writeScaffold(root, mode === "authority" ? ".agent-vigil/session.jsonl" : ".agent-vigil/session.md", mode === "authority" ? AUTHORITY_SESSION_TEMPLATE : SESSION_TEMPLATE, force, result5);
    writeScaffold(root, ".agent-vigil/README.md", LOCAL_README, force, result5);
  }
  if (mode === "authority") writeScaffold(root, ".agent-vigil-authority.json", authorityContractTemplate(), force, result5);
  if (mode === "maintainer") writeScaffold(root, ".github/pull_request_template.md", MAINTAINER_PR_TEMPLATE, force, result5);
  writeScaffold(root, ".github/workflows/agent-vigil.yml", workflow(mode, setupCommand, attest), force, result5);
  writeScaffold(root, ".github/workflows/agent-vigil-outcomes.yml", outcomeWorkflow(), force, result5);
  return result5;
}
function git4(repo, args) {
  try {
    return execFileSync6("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function doctorRepository(repo, requestedPolicy, requestedTranscript) {
  const root = resolve6(repo);
  const checks = [];
  const workflow2 = resolve6(root, ".github/workflows/agent-vigil.yml");
  const outcomeObserver = resolve6(root, ".github/workflows/agent-vigil-outcomes.yml");
  const installedWorkflow = existsSync4(workflow2) ? readFileSync7(workflow2, "utf8") : "";
  const authorityConfigured = /^\s*authority-contract:\s*\S+\s*$/m.test(installedWorkflow);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    status: nodeMajor >= 20 ? "PASS" : "FAIL",
    label: "Node.js",
    detail: `${process.versions.node}${nodeMajor >= 20 ? " satisfies Node 20+" : " is unsupported; install Node 20+"}`
  });
  checks.push({
    status: existsSync4(outcomeObserver) ? "PASS" : "WARN",
    label: "Outcome observer",
    detail: existsSync4(outcomeObserver) ? "post-run workflow retains final Actions runtime and later pull-request outcome evidence without re-executing candidate code" : "outcome workflow is missing; rerun vigil init to add post-run evidence closure"
  });
  const gitRoot = git4(root, ["rev-parse", "--show-toplevel"]);
  checks.push({
    status: gitRoot ? "PASS" : "FAIL",
    label: "Git repository",
    detail: gitRoot ?? `${root} is not inside a readable Git repository`
  });
  let transcript = requestedTranscript;
  let portableReceipt;
  let maintainer = false;
  let maintainerReviewMode = "legacy";
  try {
    const policy = loadPolicy(root, requestedPolicy);
    checks.push({
      status: policy.path ? "PASS" : "WARN",
      label: "Policy",
      detail: policy.path ? `${relative4(root, policy.path)} \xB7 ${policy.sha256}` : `no ${DEFAULT_POLICY_FILE}; CLI defaults will be used`
    });
    transcript ??= policy.value.transcript;
    portableReceipt = policy.value.portableReceipt;
    maintainer = Boolean(policy.value.maintainer);
    if (policy.value.maintainer?.reviewMode) maintainerReviewMode = policy.value.maintainer.reviewMode;
    const command = policy.value.testCommand ?? inferTestCommand(root);
    const placeholder = command === "REPLACE_WITH_TEST_COMMAND";
    checks.push({
      status: placeholder ? "FAIL" : command ? "PASS" : "WARN",
      label: "Fresh verification",
      detail: placeholder ? "replace REPLACE_WITH_TEST_COMMAND in .agent-vigil.json" : command ? `test command: ${command}` : "no test command inferred; use policy testCommand or --test-cmd"
    });
    if (portableReceipt) {
      const signerCount = policy.value.trustedSignerKeyIds?.length ?? 0;
      checks.push({
        status: signerCount ? "PASS" : "FAIL",
        label: "Portable signer",
        detail: signerCount ? `${signerCount} signer key ID(s) pinned by policy` : "portable receipt mode requires trustedSignerKeyIds"
      });
    }
  } catch (error) {
    checks.push({ status: "FAIL", label: "Policy", detail: error.message });
  }
  if (portableReceipt) {
    const path = resolve6(root, portableReceipt);
    checks.push({
      status: existsSync4(path) ? "PASS" : "WARN",
      label: "Portable receipt",
      detail: existsSync4(path) ? `${portableReceipt} is present; run vigil gate to verify it` : `${portableReceipt} will be created after the next signed code change; raw transcript remains local`
    });
  } else if (maintainer) {
    const template = resolve6(root, ".github/pull_request_template.md");
    checks.push({
      status: existsSync4(template) ? "PASS" : "FAIL",
      label: "Pull request evidence",
      detail: existsSync4(template) ? "AI-assistance, linked-issue, and limitations template is installed" : "maintainer profile requires .github/pull_request_template.md"
    });
    checks.push({
      status: maintainerReviewMode === "automated" ? "PASS" : maintainerReviewMode === "human" ? "PASS" : "WARN",
      label: "Review mode",
      detail: maintainerReviewMode === "automated" ? "base policy runs explicit automated-review commands in an isolated exact-commit checkout" : maintainerReviewMode === "human" ? "base policy requires named human review declarations" : "legacy policy does not name a reviewMode; set human or automated explicitly"
    });
  } else if (!transcript) {
    checks.push({ status: "WARN", label: "Transcript", detail: "no transcript configured; pass a path or run vigil init" });
  } else {
    const path = resolve6(root, transcript);
    if (!existsSync4(path)) checks.push({ status: "WARN", label: "Transcript", detail: `${transcript} does not exist yet` });
    else {
      try {
        const loaded = loadTranscript(path);
        checks.push({
          status: authorityConfigured && loaded.toolCalls.length === 0 ? "FAIL" : "PASS",
          label: "Transcript",
          detail: authorityConfigured && loaded.toolCalls.length === 0 ? `${transcript} is ${loaded.format} with no structured tool calls; authority mode requires a supported structured export` : `${transcript} detected as ${loaded.format}; ${loaded.toolCalls.length} tool call(s)`
        });
      } catch (error) {
        checks.push({ status: "FAIL", label: "Transcript", detail: error.message });
      }
    }
  }
  checks.push({
    status: existsSync4(workflow2) ? "PASS" : "WARN",
    label: "GitHub Action",
    detail: existsSync4(workflow2) ? "workflow installed; configure Agent Vigil evidence as a required status check after its first run" : "workflow not installed; run vigil init"
  });
  if (existsSync4(workflow2)) {
    const text6 = installedWorkflow;
    const attestationEnabled = /^\s*attest:\s*true\s*$/m.test(text6);
    if (attestationEnabled) {
      const permissionsPresent = /^\s*id-token:\s*write\s*$/m.test(text6) && /^\s*attestations:\s*write\s*$/m.test(text6) && /^\s*artifact-metadata:\s*write\s*$/m.test(text6);
      const repositoryWrite = /^\s*contents:\s*write\s*$/m.test(text6);
      checks.push({
        status: !permissionsPresent ? "FAIL" : repositoryWrite ? "WARN" : "PASS",
        label: "GitHub attestation",
        detail: !permissionsPresent ? "attest: true requires id-token, attestations, and artifact-metadata write permissions" : repositoryWrite ? "receipt signing is configured, but this workflow can also write repository contents; remove that permission unless another reviewed step requires it" : "receipt attestation is enabled with the required GitHub permissions"
      });
    }
    const exactRange = /pull_request\.base\.sha/.test(text6) && /pull_request\.head\.sha/.test(text6);
    checks.push({
      status: exactRange ? "PASS" : "WARN",
      label: "Git range",
      detail: exactRange ? "workflow pins the pull request base and head SHAs" : "workflow does not visibly pin both pull request SHAs"
    });
    const exactCheckout = /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.event\.merge_group\.head_sha\s*\}\}/.test(text6);
    checks.push({
      status: exactCheckout ? "PASS" : "WARN",
      label: "Checkout identity",
      detail: exactCheckout ? "workflow checks out the exact pull request head SHA" : "workflow may verify GitHub's synthetic merge commit instead of the selected head"
    });
    const anchoredPolicy = /policy-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}/.test(text6);
    checks.push({
      status: anchoredPolicy ? "PASS" : "WARN",
      label: "Policy trust",
      detail: anchoredPolicy ? "workflow loads policy from the pull request base commit" : "workflow policy may be controlled by the candidate change"
    });
    const mergeQueue = /merge_group:\s*\n\s*types:\s*\[checks_requested\]/.test(text6) && /merge_group\.base_sha/.test(text6) && /merge_group\.head_sha/.test(text6);
    checks.push({
      status: mergeQueue ? "PASS" : "WARN",
      label: "Merge queue",
      detail: mergeQueue ? "workflow re-verifies the composed merge-group commit" : "required check will not report for GitHub merge queues"
    });
    if (maintainer) {
      const modeInstalled = /mode:\s*maintainer/.test(text6);
      const artifactInstalled = /name:\s*agent-vigil-receipt/.test(text6);
      checks.push({
        status: modeInstalled && artifactInstalled ? "PASS" : "FAIL",
        label: "Maintainer workflow",
        detail: modeInstalled && artifactInstalled ? "maintainer mode and receipt artifact retention are installed" : "workflow must enable maintainer mode and retain agent-vigil-receipt"
      });
    }
    const authorityMatch = text6.match(/^\s*authority-contract:\s*(\S+)\s*$/m);
    if (authorityMatch) {
      try {
        const contract = loadAuthorityContract(root, authorityMatch[1]);
        const placeholder = contract.value.taskId === "REPLACE_WITH_TASK_OR_TICKET_ID";
        const expired = Boolean(contract.value.expiresAt && Date.now() > new Date(contract.value.expiresAt).getTime());
        const anchored = /^\s*authority-contract-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}\s*$/m.test(text6);
        checks.push({
          status: placeholder || expired || !anchored ? "FAIL" : "PASS",
          label: "Task authority",
          detail: placeholder ? "replace the generated taskId before use" : expired ? `contract expired at ${contract.value.expiresAt}` : !anchored ? "workflow must load authority from the GitHub event base" : `${contract.value.taskId} \xB7 ${contract.sha256} \xB7 base-anchored`
        });
      } catch (error) {
        checks.push({ status: "FAIL", label: "Task authority", detail: error.message });
      }
    }
  }
  return checks;
}
function renderDoctor(checks) {
  const icon2 = { PASS: "\u2713", WARN: "!", FAIL: "\u2717" };
  const lines = ["Agent Vigil doctor", ""];
  for (const check of checks) lines.push(`${icon2[check.status]} ${check.status.padEnd(4)} ${check.label}: ${check.detail}`);
  const failed = checks.filter((check) => check.status === "FAIL").length;
  const warned = checks.filter((check) => check.status === "WARN").length;
  lines.push("", `${failed} failure(s) \xB7 ${warned} warning(s)`);
  return lines.join("\n");
}

// src/signature.ts
import {
  createHash as createHash5,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { chmodSync, readFileSync as readFileSync8, writeFileSync as writeFileSync4 } from "node:fs";
function publicKeyDer(key) {
  return key.export({ type: "spki", format: "der" });
}
function signingKeyId(der) {
  return `sha256:${createHash5("sha256").update(der).digest("hex")}`;
}
function signReport(report, privateKeyPath) {
  const privateKey = createPrivateKey(readFileSync8(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  const der = publicKeyDer(publicKey);
  report.signature = {
    algorithm: "Ed25519",
    keyId: signingKeyId(der),
    publicKey: der.toString("base64"),
    value: sign(null, Buffer.from(report.receiptHash), privateKey).toString("base64")
  };
  return report;
}
function verifyReport(report, publicKeyPath) {
  const hashValid = recomputeReceiptHash(report) === report.receiptHash;
  if (!report.signature) return { hashValid, keyPinned: false };
  if (report.signature.algorithm !== "Ed25519") return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  const embedded = createPublicKey({
    key: Buffer.from(report.signature.publicKey, "base64"),
    type: "spki",
    format: "der"
  });
  const selected = publicKeyPath ? createPublicKey(readFileSync8(publicKeyPath)) : embedded;
  const selectedDer = publicKeyDer(selected);
  const selectedId = signingKeyId(selectedDer);
  const signatureValid = selectedId === report.signature.keyId && verify(null, Buffer.from(report.receiptHash), selected, Buffer.from(report.signature.value, "base64"));
  return { hashValid, signatureValid, keyPinned: Boolean(publicKeyPath), keyId: selectedId };
}
function generateSigningKey(privatePath, publicPath) {
  const pair = generateKeyPairSync("ed25519");
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
  writeFileSync4(privatePath, privatePem, { mode: 384, flag: "wx" });
  chmodSync(privatePath, 384);
  writeFileSync4(publicPath, publicPem, { flag: "wx" });
}
function publicKeyId(publicKeyPath) {
  const publicKey = createPublicKey(readFileSync8(publicKeyPath));
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("public key must be Ed25519");
  return signingKeyId(publicKeyDer(publicKey));
}

// src/portable.ts
import {
  createHash as createHash6,
  createPrivateKey as createPrivateKey2,
  createPublicKey as createPublicKey2,
  sign as sign2,
  verify as verify2
} from "node:crypto";
import { readFileSync as readFileSync9 } from "node:fs";
var SHA256 = /^sha256:[0-9a-f]{64}$/;
function digest(value) {
  return `sha256:${createHash6("sha256").update(canonical(value)).digest("hex")}`;
}
function payloadOf(receipt) {
  const { portableHash: _hash, signature: _signature, ...payload } = receipt;
  return payload;
}
function createPortableReceipt(report, privateKeyPath) {
  if (recomputeReceiptHash(report) !== report.receiptHash) throw new Error("full receipt hash is invalid; refusing to seal it");
  if (!report.repository.tree) {
    throw new Error("portable receipt requires a committed head tree; rerun with --head <sha> instead of WORKTREE");
  }
  const privateKey = createPrivateKey2(readFileSync9(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const publicKey = createPublicKey2(privateKey);
  const der = publicKeyDer(publicKey);
  const payload = {
    schemaVersion: "1",
    type: "agent-vigil/portable-receipt",
    vigilVersion: report.vigilVersion,
    reportHash: report.receiptHash,
    resultsHash: digest(report.results),
    transcriptSha256: report.transcriptSha256,
    base: report.base,
    head: report.head,
    repository: report.repository,
    policy: { sha256: report.policy.sha256 },
    summary: report.summary,
    issuedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  const portableHash = digest(payload);
  return {
    ...payload,
    portableHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign2(null, Buffer.from(portableHash), privateKey).toString("base64")
    }
  };
}
function verifyPortableReceipt(receipt, trustedKeyIds = []) {
  const errors = [];
  if (!receipt || typeof receipt !== "object") return { hashValid: false, signatureValid: false, signerTrusted: false, errors: ["portable receipt must be an object"] };
  if (receipt.schemaVersion !== "1" || receipt.type !== "agent-vigil/portable-receipt") errors.push("unsupported portable receipt schema or type");
  for (const [label, value] of [
    ["reportHash", receipt.reportHash],
    ["resultsHash", receipt.resultsHash],
    ["transcriptSha256", receipt.transcriptSha256],
    ["policy.sha256", receipt.policy?.sha256],
    ["portableHash", receipt.portableHash],
    ["signature.keyId", receipt.signature?.keyId]
  ]) if (!SHA256.test(String(value ?? ""))) errors.push(`${label} is not a SHA-256 identifier`);
  if (!receipt.base || !receipt.head || !receipt.repository?.tree) errors.push("base, head, and repository tree are required");
  if (!receipt.summary || !(/* @__PURE__ */ new Set(["PASS", "FAIL", "INCONCLUSIVE"])).has(receipt.summary.status)) errors.push("summary status is invalid");
  if (receipt.summary && receipt.summary.pass !== (receipt.summary.status === "PASS")) errors.push("summary pass flag disagrees with status");
  const hashMatches = digest(payloadOf(receipt)) === receipt.portableHash;
  if (!hashMatches) errors.push("portable receipt hash is invalid");
  const hashValid = errors.length === 0 && hashMatches;
  let signatureValid = false;
  let keyId;
  try {
    if (receipt.signature?.algorithm !== "Ed25519") throw new Error("signature algorithm must be Ed25519");
    const publicKey = createPublicKey2({ key: Buffer.from(receipt.signature.publicKey, "base64"), type: "spki", format: "der" });
    if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("embedded public key must be Ed25519");
    keyId = signingKeyId(publicKeyDer(publicKey));
    signatureValid = keyId === receipt.signature.keyId && verify2(null, Buffer.from(receipt.portableHash), publicKey, Buffer.from(receipt.signature.value, "base64"));
    if (!signatureValid) errors.push("portable receipt signature is invalid");
  } catch (error) {
    errors.push(`portable receipt signature could not be read: ${error.message}`);
  }
  const signerTrusted = Boolean(keyId) && trustedKeyIds.includes(keyId);
  if (!signerTrusted) errors.push("signer key ID is not pinned by the trusted policy");
  return { hashValid, signatureValid, signerTrusted, ...keyId ? { keyId } : {}, errors };
}

// src/gate.ts
import { execFileSync as execFileSync7 } from "node:child_process";
import { relative as relative5, resolve as resolve7, sep as sep4 } from "node:path";

// src/integrity-policy.ts
var CALIBRATED_BLOCKING_RULES = /* @__PURE__ */ new Set([
  "coverage-weakened",
  "test-count-drop",
  "test-empty-added",
  "test-oracle-constant",
  "test-skip-added",
  "verification-bypass"
]);
function routeIntegrity(checks, mode = "advisory") {
  if (mode === "blocking") return { results: checks, advisories: [] };
  if (mode === "calibrated") {
    return {
      results: checks.filter((check) => check.verdict !== "contradicted" || CALIBRATED_BLOCKING_RULES.has(check.ruleId ?? "")),
      advisories: checks.filter((check) => check.verdict === "contradicted" && !CALIBRATED_BLOCKING_RULES.has(check.ruleId ?? ""))
    };
  }
  return {
    results: checks.filter((check) => check.verdict !== "contradicted"),
    advisories: checks.filter((check) => check.verdict === "contradicted")
  };
}

// src/gate.ts
function git5(repo, args) {
  try {
    return execFileSync7("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function result3(subject, verdict, evidence, ruleId, blocksPass = false) {
  return {
    claim: { kind: "integrity", quote: "portable receipt merge-gate check", subject },
    verdict,
    evidence,
    ruleId,
    ...verdict === "verified" ? {} : { contributesToPass: false },
    ...blocksPass ? { blocksPass: true } : {}
  };
}
function receiptRelativePath(repo, path) {
  const value = relative5(resolve7(repo), resolve7(path)).replaceAll("\\", "/");
  if (!value || value === ".." || value.startsWith("../") || value.startsWith(`..${sep4}`)) return void 0;
  return value.replace(/^\.\//, "");
}
function buildPortableGateReport(receipt, options) {
  const repo = resolve7(options.repo);
  const receiptPath = resolve7(options.receiptPath);
  if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) {
    throw new Error(`invalid git range ${options.base}..${options.head}`);
  }
  const policy = loadPolicy(repo, options.policy, options.policyRef);
  const base = resolveGitRef(repo, options.base);
  const head = resolveGitRef(repo, options.head);
  const results = [];
  const advisories = [];
  const trusted = policy.value.trustedSignerKeyIds ?? [];
  const verification2 = verifyPortableReceipt(receipt, trusted);
  results.push(result3(
    "portable receipt hash and Ed25519 signature",
    verification2.hashValid && verification2.signatureValid ? "verified" : "contradicted",
    verification2.hashValid && verification2.signatureValid ? `${receipt.portableHash} is intact and signed by ${verification2.keyId}` : verification2.errors.filter((error) => !error.includes("not pinned")).join("; ") || "portable receipt signature is invalid",
    "portable-signature"
  ));
  results.push(result3(
    "receipt signer is pinned by trusted policy",
    verification2.signerTrusted ? "verified" : trusted.length ? "contradicted" : "unverifiable",
    verification2.signerTrusted ? `${verification2.keyId} is listed in the base-anchored policy` : trusted.length ? `${verification2.keyId ?? "unreadable signer"} is not one of ${trusted.length} trusted key ID(s)` : "trusted policy has no trustedSignerKeyIds; pin a signer before enabling the gate",
    "portable-signer",
    !trusted.length
  ));
  results.push(result3(
    "local Agent Vigil verdict",
    receipt.summary?.status === "PASS" && receipt.summary.pass ? "verified" : receipt.summary?.status === "FAIL" ? "contradicted" : "unverifiable",
    `signed local report ${receipt.reportHash} records ${receipt.summary?.status ?? "an invalid status"}`,
    "portable-local-verdict",
    receipt.summary?.status !== "FAIL"
  ));
  results.push(result3(
    "portable receipt matches trusted policy",
    receipt.policy?.sha256 === policy.sha256 ? "verified" : "contradicted",
    receipt.policy?.sha256 === policy.sha256 ? `receipt and base policy share ${policy.sha256}` : `receipt names ${receipt.policy?.sha256 ?? "no policy hash"}; trusted policy is ${policy.sha256}`,
    "portable-policy"
  ));
  const relativeReceipt = receiptRelativePath(repo, receiptPath);
  const configuredReceipt = policy.value.portableReceipt?.replace(/^\.\//, "");
  if (configuredReceipt) {
    results.push(result3(
      "receipt path is base-policy controlled",
      relativeReceipt === configuredReceipt ? "verified" : "contradicted",
      relativeReceipt === configuredReceipt ? `${relativeReceipt} matches policy portableReceipt` : `received ${relativeReceipt ?? "a path outside the repository"}; policy requires ${configuredReceipt}`,
      "portable-path"
    ));
  } else {
    results.push(result3(
      "receipt path is base-policy controlled",
      "unverifiable",
      "trusted policy has no portableReceipt path",
      "portable-path",
      true
    ));
  }
  const receiptHeadExists = gitRefExists(repo, receipt.head);
  const receiptHead = receiptHeadExists ? resolveGitRef(repo, receipt.head) : void 0;
  const receiptBase = gitRefExists(repo, receipt.base) ? resolveGitRef(repo, receipt.base) : void 0;
  const exactHead = receiptHead === head;
  const ancestor = Boolean(receiptHead && git5(repo, ["merge-base", "--is-ancestor", receiptHead, head]) !== void 0);
  const evidenceDelta = receiptHead && configuredReceipt ? (git5(repo, ["diff", "--name-only", "-z", receiptHead, head]) ?? "").split("\0").filter(Boolean) : [];
  const receiptOnlyTail = ancestor && evidenceDelta.length > 0 && evidenceDelta.every((path) => path === configuredReceipt);
  const expectedTree = receiptHead ? git5(repo, ["rev-parse", `${receiptHead}^{tree}`]) : void 0;
  const currentRemote = git5(repo, ["config", "--get", "remote.origin.url"]);
  const remoteMatches = !receipt.repository?.remote || !currentRemote || receipt.repository.remote === currentRemote;
  const gitBound = receiptBase === base && Boolean(receiptHead) && (exactHead || receiptOnlyTail) && Boolean(expectedTree) && receipt.repository?.tree === expectedTree && remoteMatches;
  results.push(result3(
    "signed repository identity",
    gitBound ? "verified" : "contradicted",
    gitBound ? exactHead ? `receipt binds exact head ${head} and tree ${expectedTree}` : `receipt binds code head ${receiptHead}; ${receiptHead}..${head} changes only ${configuredReceipt}` : `expected base ${base}, current head ${head}, receipt base ${receiptBase ?? "invalid"}, receipt head ${receiptHead ?? "invalid"}, receipt tree ${receipt.repository?.tree ?? "missing"}, observed tree ${expectedTree ?? "invalid"}${remoteMatches ? "" : "; remote differs"}`,
    "portable-git-binding"
  ));
  results.push(...checkWorkspaceBinding(repo, head, exactHead ? [receiptPath] : []));
  const testClaim = { kind: "tests_pass", quote: "trusted policy verification passes in independent CI", subject: "trusted policy test command" };
  results.push(...checkTestsPass([testClaim], repo, policy.value.testCommand));
  results.push(...checkWorkspaceMutation(repo, exactHead ? [receiptPath] : [], head));
  const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
  results.push(...integrity.results);
  advisories.push(...integrity.advisories);
  const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative5(repo, policy.path) : void 0;
  const reproduction = [
    "vigil gate",
    `'${relativeReceipt ?? receiptPath}'`,
    "--repo .",
    "--base",
    base,
    "--head",
    head,
    ...policy.gitPath ? ["--policy", `'${policy.gitPath}'`] : [],
    ...policy.ref ? ["--policy-ref", policy.ref] : []
  ].join(" ");
  return buildReport({
    transcript: relativeReceipt ?? "portable-receipt",
    transcriptSha256: receipt.transcriptSha256,
    transcriptFormat: "portable-receipt",
    repo,
    base,
    head,
    results,
    advisories,
    policy: { minVerified: 1, strict: true, source: policySource, sha256: policy.sha256 },
    repository: { ...currentRemote ? { remote: currentRemote } : {}, ...git5(repo, ["rev-parse", `${head}^{tree}`]) ? { tree: git5(repo, ["rev-parse", `${head}^{tree}`]) } : {} },
    reproduction
  });
}

// src/receipt-diff.ts
import { createHash as createHash7 } from "node:crypto";
function consistencyErrors(report) {
  const errors = [];
  const count2 = (verdict) => report.results.filter((row) => row.verdict === verdict).length;
  const meaningfulVerified = report.results.filter((row) => row.verdict === "verified" && row.contributesToPass !== false).length;
  const expectedStatus = count2("contradicted") > 0 ? "FAIL" : meaningfulVerified < report.policy.minVerified || report.results.some((row) => row.verdict === "unverifiable" && row.blocksPass) || report.policy.strict && count2("unverifiable") > 0 ? "INCONCLUSIVE" : "PASS";
  if (report.summary.verified !== count2("verified")) errors.push("verified count does not match results");
  if (report.summary.contradicted !== count2("contradicted")) errors.push("contradicted count does not match results");
  if (report.summary.unverifiable !== count2("unverifiable")) errors.push("unverifiable count does not match results");
  if (report.summary.meaningfulVerified !== meaningfulVerified) errors.push("meaningfulVerified count does not match results");
  if (report.summary.status !== expectedStatus) errors.push(`status ${report.summary.status} should be ${expectedStatus}`);
  if (report.summary.pass !== (report.summary.status === "PASS")) errors.push("pass boolean does not match status");
  if (!Number.isInteger(report.policy.minVerified) || report.policy.minVerified < 1) errors.push("minVerified is invalid");
  return errors;
}
function checkKey(check) {
  return `${check.ruleId ?? check.claim.kind}|${check.claim.kind}|${check.claim.subject}`;
}
function advisoryKey(check) {
  return `${checkKey(check)}|${check.evidence}`;
}
function item(check, values) {
  return {
    key: checkKey(check),
    ruleId: check.ruleId ?? check.claim.kind,
    subject: check.claim.subject,
    ...values
  };
}
function verification(report) {
  const internallyConsistent = consistencyErrors(report).length === 0;
  try {
    const verified = verifyReport(report);
    return {
      receiptHash: report.receiptHash,
      hashValid: verified.hashValid,
      signature: report.signature ? verified.signatureValid ? "valid" : "invalid" : "absent",
      internallyConsistent,
      ...report.signature ? { keyId: report.signature.keyId } : {},
      base: report.base,
      head: report.head,
      policySha256: report.policy.sha256,
      status: report.summary.status
    };
  } catch {
    return {
      receiptHash: report.receiptHash,
      hashValid: false,
      signature: report.signature ? "invalid" : "absent",
      internallyConsistent,
      base: report.base,
      head: report.head,
      policySha256: report.policy.sha256,
      status: report.summary.status
    };
  }
}
function signerContinuity(before, after) {
  if (!before.keyId && !after.keyId) return { continuity: "unsigned" };
  if (!before.keyId && after.keyId) return { continuity: "added", after: after.keyId };
  if (before.keyId && !after.keyId) return { continuity: "removed", before: before.keyId };
  return { continuity: before.keyId === after.keyId ? "same" : "changed", before: before.keyId, after: after.keyId };
}
function reportStatusRank(status) {
  return status === "PASS" ? 2 : status === "INCONCLUSIVE" ? 1 : 0;
}
function verdictRank(verdict) {
  return verdict === "verified" ? 2 : verdict === "unverifiable" ? 1 : 0;
}
function isInvariant(check) {
  return check.contributesToPass === false || check.blocksPass === true || check.claim.kind === "policy_attestation" || check.claim.kind === "integrity";
}
function compareReceipts(beforeReport, afterReport) {
  const before = verification(beforeReport);
  const after = verification(afterReport);
  const regressions = [];
  const improvements = [];
  const notes = [];
  if (!before.hashValid || !after.hashValid) {
    const receipt = !before.hashValid ? beforeReport : afterReport;
    regressions.push({ key: "receipt-hash", ruleId: "receipt-hash", subject: "receipt content hash", reason: `${!before.hashValid ? "before" : "after"} receipt hash is invalid` });
    notes.push(`Do not trust ${receipt.receiptHash}; its canonical payload does not match the recorded hash.`);
  }
  if (!before.internallyConsistent || !after.internallyConsistent) {
    const which = !before.internallyConsistent ? "before" : "after";
    regressions.push({ key: "receipt-consistency", ruleId: "receipt-consistency", subject: "receipt summary and policy invariants", reason: `${which} receipt is internally inconsistent` });
    notes.push(`${which} receipt: ${consistencyErrors(!before.internallyConsistent ? beforeReport : afterReport).join("; ")}`);
  }
  if (before.signature === "invalid" || after.signature === "invalid") {
    regressions.push({ key: "receipt-signature", ruleId: "receipt-signature", subject: "embedded Ed25519 signature", reason: `${before.signature === "invalid" ? "before" : "after"} receipt signature is invalid` });
  }
  const policyWeakened = [];
  if (afterReport.policy.minVerified < beforeReport.policy.minVerified) policyWeakened.push(`minVerified fell from ${beforeReport.policy.minVerified} to ${afterReport.policy.minVerified}`);
  if (beforeReport.policy.strict && !afterReport.policy.strict) policyWeakened.push("strict policy changed from true to false");
  for (const reason of policyWeakened) regressions.push({ key: `policy|${reason}`, ruleId: "policy-weakened", subject: "verification policy strength", reason });
  const samePolicy = beforeReport.policy.sha256 === afterReport.policy.sha256;
  if (!samePolicy) notes.push("Policy hashes differ; behavioral check deltas are not directly comparable.");
  const relationship = beforeReport.base === afterReport.base ? "same-base" : beforeReport.head === afterReport.base ? "chained" : "unrelated";
  if (relationship === "unrelated") notes.push("Git ranges are neither same-base PR revisions nor a chained before-head to after-base sequence.");
  if (beforeReport.repository.remote && afterReport.repository.remote && beforeReport.repository.remote !== afterReport.repository.remote) {
    notes.push("Repository remotes differ.");
  }
  const beforeChecks = new Map(beforeReport.results.map((check) => [checkKey(check), check]));
  const afterChecks = new Map(afterReport.results.map((check) => [checkKey(check), check]));
  let unchangedChecks = 0;
  for (const [key, prior] of beforeChecks) {
    const current = afterChecks.get(key);
    if (!current) {
      const cleanScanBecameAdvisories = prior.ruleId === "integrity-scan" && (afterReport.advisories?.length ?? 0) > 0;
      if (isInvariant(prior) && prior.verdict === "verified" && !cleanScanBecameAdvisories) {
        regressions.push(item(prior, { before: prior.verdict, after: "absent", reason: "previously verified invariant check disappeared" }));
      }
      continue;
    }
    if (current.verdict === prior.verdict) {
      unchangedChecks += 1;
      continue;
    }
    if (verdictRank(current.verdict) < verdictRank(prior.verdict)) {
      regressions.push(item(current, { before: prior.verdict, after: current.verdict, reason: "check verdict weakened" }));
    } else {
      improvements.push(item(current, { before: prior.verdict, after: current.verdict, reason: "check verdict improved" }));
    }
  }
  for (const [key, current] of afterChecks) {
    if (beforeChecks.has(key)) continue;
    if (current.verdict === "contradicted") regressions.push(item(current, { before: "absent", after: current.verdict, reason: "new contradiction" }));
    else if (current.verdict === "unverifiable" && current.blocksPass) regressions.push(item(current, { before: "absent", after: current.verdict, reason: "new blocking evidence gap" }));
    else if (current.verdict === "verified") improvements.push(item(current, { before: "absent", after: current.verdict, reason: "new verified check" }));
  }
  if (reportStatusRank(afterReport.summary.status) < reportStatusRank(beforeReport.summary.status)) {
    regressions.push({ key: "report-status", ruleId: "report-status", subject: "overall receipt status", before: beforeReport.summary.status === "PASS" ? "verified" : "unverifiable", after: afterReport.summary.status === "FAIL" ? "contradicted" : "unverifiable", reason: `${beforeReport.summary.status} became ${afterReport.summary.status}` });
  } else if (reportStatusRank(afterReport.summary.status) > reportStatusRank(beforeReport.summary.status)) {
    improvements.push({ key: "report-status", ruleId: "report-status", subject: "overall receipt status", reason: `${beforeReport.summary.status} became ${afterReport.summary.status}` });
  }
  const beforeAdvisories = new Map((beforeReport.advisories ?? []).map((check) => [advisoryKey(check), check]));
  const afterAdvisories = new Map((afterReport.advisories ?? []).map((check) => [advisoryKey(check), check]));
  const newAdvisories = [...afterAdvisories].filter(([key]) => !beforeAdvisories.has(key)).map(([, check]) => item(check, { before: "absent", after: "advisory", reason: "new receipt-bound advisory" }));
  const resolvedAdvisories = [...beforeAdvisories].filter(([key]) => !afterAdvisories.has(key)).map(([, check]) => item(check, { before: "advisory", after: "absent", reason: "prior advisory is absent" }));
  const signer = signerContinuity(before, after);
  if (signer.continuity === "removed") regressions.push({ key: "signer-removed", ruleId: "signer-continuity", subject: "receipt signer", reason: "after receipt removed a previously present signature" });
  if (signer.continuity === "changed") notes.push("Signer key changed; establish the rotation through a trusted policy or separate approval.");
  if (signer.continuity === "unsigned") notes.push("Both hashes are content-integrity checks only; signer identity is unestablished.");
  let status;
  if (regressions.length) status = "FAIL";
  else if (!samePolicy || relationship === "unrelated" || signer.continuity === "changed") status = "INCONCLUSIVE";
  else status = "PASS";
  const unsigned = {
    schemaVersion: "agent-vigil-receipt-delta/v1",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    before,
    after,
    status,
    policy: { same: samePolicy, weakened: policyWeakened },
    range: { related: relationship !== "unrelated", relationship },
    signer,
    regressions,
    improvements,
    newAdvisories,
    resolvedAdvisories,
    unchangedChecks,
    notes
  };
  return { ...unsigned, deltaHash: `sha256:${createHash7("sha256").update(canonical(unsigned)).digest("hex")}` };
}
function renderReceiptDelta(delta) {
  const lines = [
    `Agent Vigil receipt delta: ${delta.status}`,
    `  before: ${delta.before.receiptHash} (${delta.before.status})`,
    `  after:  ${delta.after.receiptHash} (${delta.after.status})`,
    `  policy: ${delta.policy.same ? "same" : "changed"}`,
    `  range:  ${delta.range.relationship}`,
    `  signer: ${delta.signer.continuity}`,
    `  ${delta.regressions.length} regression(s) \xB7 ${delta.improvements.length} improvement(s) \xB7 ${delta.newAdvisories.length} new advisory finding(s)`
  ];
  for (const row of delta.regressions) lines.push(`  \u2717 [${row.ruleId}] ${row.subject}: ${row.reason}`);
  for (const row of delta.improvements) lines.push(`  \u2713 [${row.ruleId}] ${row.subject}: ${row.reason}`);
  for (const row of delta.newAdvisories) lines.push(`  ! [${row.ruleId}] ${row.subject}: ${row.reason}`);
  for (const note of delta.notes) lines.push(`  ? ${note}`);
  lines.push(`  ${delta.deltaHash}`);
  return lines.join("\n");
}

// src/merge-group.ts
import { createHash as createHash9 } from "node:crypto";
import { execFileSync as execFileSync9 } from "node:child_process";
import { readFileSync as readFileSync10 } from "node:fs";
import { relative as relative6, resolve as resolve8 } from "node:path";

// src/authority-plan.ts
import { createHash as createHash8 } from "node:crypto";
import { execFileSync as execFileSync8 } from "node:child_process";
import { posix } from "node:path";

// node_modules/smol-toml/dist/date.js
var DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})?[T ]?(?:(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?)?(Z|[-+]\d{2}:\d{2})?$/i;
var TomlDate = class _TomlDate extends Date {
  #hasDate = false;
  #hasTime = false;
  #offset = null;
  constructor(date) {
    let hasDate = true;
    let hasTime = true;
    let offset = "Z";
    if (typeof date === "string") {
      let match = date.match(DATE_TIME_RE);
      if (match) {
        if (!match[1]) {
          hasDate = false;
          date = `0000-01-01T${date}`;
        }
        hasTime = !!match[2];
        hasTime && date[10] === " " && (date = date.replace(" ", "T"));
        if (match[2] && +match[2] > 23) {
          date = "";
        } else {
          offset = match[3] || null;
          date = date.toUpperCase();
          if (!offset && hasTime)
            date += "Z";
        }
      } else {
        date = "";
      }
    }
    super(date);
    if (!isNaN(this.getTime())) {
      this.#hasDate = hasDate;
      this.#hasTime = hasTime;
      this.#offset = offset;
    }
  }
  isDateTime() {
    return this.#hasDate && this.#hasTime;
  }
  isLocal() {
    return !this.#hasDate || !this.#hasTime || !this.#offset;
  }
  isDate() {
    return this.#hasDate && !this.#hasTime;
  }
  isTime() {
    return this.#hasTime && !this.#hasDate;
  }
  isValid() {
    return this.#hasDate || this.#hasTime;
  }
  toISOString() {
    let iso = super.toISOString();
    if (this.isDate())
      return iso.slice(0, 10);
    if (this.isTime())
      return iso.slice(11, 23);
    if (this.#offset === null)
      return iso.slice(0, -1);
    if (this.#offset === "Z")
      return iso;
    let offset = +this.#offset.slice(1, 3) * 60 + +this.#offset.slice(4, 6);
    offset = this.#offset[0] === "-" ? offset : -offset;
    let offsetDate = new Date(this.getTime() - offset * 6e4);
    return offsetDate.toISOString().slice(0, -1) + this.#offset;
  }
  static wrapAsOffsetDateTime(jsDate, offset = "Z") {
    let date = new _TomlDate(jsDate);
    date.#offset = offset;
    return date;
  }
  static wrapAsLocalDateTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#offset = null;
    return date;
  }
  static wrapAsLocalDate(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasTime = false;
    date.#offset = null;
    return date;
  }
  static wrapAsLocalTime(jsDate) {
    let date = new _TomlDate(jsDate);
    date.#hasDate = false;
    date.#offset = null;
    return date;
  }
};

// node_modules/smol-toml/dist/error.js
function getLineColFromPtr(string2, ptr) {
  let lines = string2.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string2, line, column) {
  let lines = string2.split(/\r\n|\n|\r/g);
  let codeblock = "";
  let numberLen = (Math.log10(line + 1) | 0) + 1;
  for (let i = line - 1; i <= line + 1; i++) {
    let l = lines[i - 1];
    if (!l)
      continue;
    codeblock += i.toString().padEnd(numberLen, " ");
    codeblock += ":  ";
    codeblock += l;
    codeblock += "\n";
    if (i === line) {
      codeblock += " ".repeat(numberLen + column + 2);
      codeblock += "^\n";
    }
  }
  return codeblock;
}
var TomlError = class extends Error {
  line;
  column;
  codeblock;
  constructor(message, options) {
    const [line, column] = getLineColFromPtr(options.toml, options.ptr);
    const codeblock = makeCodeBlock(options.toml, line, column);
    super(`Invalid TOML document: ${message}

${codeblock}`, options);
    this.line = line;
    this.column = column;
    this.codeblock = codeblock;
  }
};

// node_modules/smol-toml/dist/util.js
function indexOfNewline(str, start = 0) {
  let idx = str.indexOf("\n", start);
  if (str.charCodeAt(idx - 1) === 13)
    idx--;
  return idx;
}
function skipComment(ctx) {
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 10)
      break;
    if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10) {
      ctx.p++;
      break;
    }
    if (c < 32 && c !== 9 || c === 127) {
      throw new TomlError("control characters are not allowed in comments", {
        toml: ctx.s,
        ptr: ctx.p
      });
    }
  }
}
function skipVoid(ctx, banNewLines, banComments) {
  let c;
  while (1) {
    while ((c = ctx.s.charCodeAt(ctx.p)) === 32 || c === 9 || !banNewLines && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10))
      ctx.p++;
    if (banComments || c !== 35)
      break;
    skipComment(ctx);
  }
}
function skipUntil(ctx, sep12, end) {
  let ptr = ctx.p;
  if (!end) {
    ptr = indexOfNewline(ctx.s, ptr);
    ctx.p = ptr < 0 ? ctx.s.length : ptr;
    return;
  }
  for (; ctx.p < ctx.s.length; ctx.p++) {
    let c = ctx.s.charCodeAt(ctx.p);
    if (c === 35) {
      skipComment(ctx);
    } else if (c === end || c === sep12) {
      return;
    }
  }
  throw new TomlError("cannot find end of structure", {
    toml: ctx.s,
    ptr
  });
}

// node_modules/smol-toml/dist/primitive.js
var INT_REGEX = /^((0x[0-9a-fA-F](_?[0-9a-fA-F])*)|(([+-]|0[ob])?\d(_?\d)*))$/;
var FLOAT_REGEX = /^[+-]?\d(_?\d)*(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/;
var LEADING_ZERO = /^[+-]?0[0-9_]/;
function parseString(ctx) {
  let start = ctx.p;
  let c = ctx.s.charCodeAt(ctx.p++);
  let first = c;
  let isLiteral = c === 39;
  let isMultiline = c === ctx.s.charCodeAt(ctx.p) && c === ctx.s.charCodeAt(ctx.p + 1);
  if (isMultiline) {
    if ((c = ctx.s.charCodeAt(ctx.p += 2)) === 10)
      ctx.p++;
    else if (c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)
      ctx.p += 2;
  }
  let parsed = "";
  let sliceStart = ctx.p;
  let state = 0;
  for (; ctx.p < ctx.s.length; ctx.p++) {
    c = ctx.s.charCodeAt(ctx.p);
    if (isMultiline && (c === 10 || c === 13 && ctx.s.charCodeAt(ctx.p + 1) === 10)) {
      state = state && 3;
    } else if (c < 32 && c !== 9 || c === 127) {
      throw new TomlError("control characters are not allowed in strings", {
        toml: ctx.s,
        ptr: ctx.p
      });
    } else if ((!state || state === 3) && c === first && (!isMultiline || ctx.s.charCodeAt(ctx.p + 1) === first && ctx.s.charCodeAt(ctx.p + 2) === first)) {
      if (isMultiline) {
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
        if (ctx.s.charCodeAt(ctx.p + 3) === first)
          ctx.p++;
      }
      if (!state)
        parsed += ctx.s.slice(sliceStart, ctx.p);
      ctx.p += isMultiline ? 3 : 1;
      return parsed;
    } else if (!state) {
      if (!isLiteral && c === 92) {
        parsed += ctx.s.slice(sliceStart, sliceStart = ctx.p);
        state = 1;
      }
    } else if (state === 1) {
      if (c === 120 || c === 117 || c === 85) {
        let value = 0;
        let len = c === 120 ? 2 : c === 117 ? 4 : 8;
        for (let j = 0; j < len; j++, ctx.p++) {
          let hex = ctx.s.charCodeAt(ctx.p + 1);
          let digit = (
            /* 0-9 */
            hex >= 48 && hex <= 57 ? hex - 48 : (
              /* A-F */
              hex >= 65 && hex <= 70 ? hex - 65 + 10 : (
                /* a-f */
                hex >= 97 && hex <= 102 ? hex - 97 + 10 : -1
              )
            )
          );
          if (digit < 0)
            throw new TomlError("invalid non-hex character in unicode escape", { toml: ctx.s, ptr: ctx.p + 1 });
          value = value << 4 | digit;
        }
        if (value < 0 || value > 1114111 || value >= 55296 && value <= 57343) {
          throw new TomlError("invalid unicode escape", { toml: ctx.s, ptr: ctx.p });
        }
        parsed += String.fromCodePoint(value);
        sliceStart = ctx.p + 1;
        state = 0;
      } else if (c === 32 || c === 9) {
        state = 2;
      } else {
        if (c === 98)
          parsed += "\b";
        else if (c === 116)
          parsed += "	";
        else if (c === 110)
          parsed += "\n";
        else if (c === 102)
          parsed += "\f";
        else if (c === 114)
          parsed += "\r";
        else if (c === 101)
          parsed += "\x1B";
        else if (c === 34)
          parsed += '"';
        else if (c === 92)
          parsed += "\\";
        else
          throw new TomlError("unrecognized escape sequence", { toml: ctx.s, ptr: ctx.p });
        sliceStart = ctx.p + 1;
        state = 0;
      }
    } else if (c !== 32 && c !== 9) {
      if (state === 2) {
        throw new TomlError("invalid escape: only line-ending whitespace may be escaped", {
          toml: ctx.s,
          ptr: sliceStart
        });
      }
      state = !isLiteral && c === 92 ? 1 : 0;
      sliceStart = ctx.p;
    }
  }
  throw new TomlError("unfinished string", { toml: ctx.s, ptr: start });
}
function sliceAndTrimEndOf(ctx, start, end) {
  let value = ctx.s.slice(start, end);
  let commentIdx = value.indexOf("#");
  if (commentIdx > 0) {
    skipComment({ s: value, p: commentIdx, d: 0 });
    value = value.slice(0, commentIdx);
  }
  return value.trimEnd();
}
function parseValue(ctx, integersAsBigInt, end) {
  let ptr = ctx.p;
  let err = { toml: ctx.s, ptr };
  skipUntil(ctx, 44, end);
  let value = sliceAndTrimEndOf(ctx, ptr, ctx.p);
  if (!value)
    throw new TomlError("incomplete declaration: value expected", err);
  if (value === "-inf")
    return -Infinity;
  if (value === "inf" || value === "+inf")
    return Infinity;
  if (value === "nan" || value === "+nan" || value === "-nan")
    return NaN;
  if (value === "-0")
    return integersAsBigInt ? 0n : 0;
  let isInt = INT_REGEX.test(value);
  if (isInt || FLOAT_REGEX.test(value)) {
    if (LEADING_ZERO.test(value)) {
      throw new TomlError("leading zeroes are not allowed", err);
    }
    value = value.replace(/_/g, "");
    let numeric = +value;
    if (isNaN(numeric)) {
      throw new TomlError("invalid number", err);
    }
    if (isInt) {
      if ((isInt = !Number.isSafeInteger(numeric)) && !integersAsBigInt) {
        throw new TomlError("integer value cannot be represented losslessly", err);
      }
      if (isInt || integersAsBigInt === true)
        numeric = BigInt(value);
    }
    return numeric;
  }
  const date = new TomlDate(value);
  if (!date.isValid())
    throw new TomlError("invalid value", err);
  return date;
}

// node_modules/smol-toml/dist/extract.js
function extractValue(ctx, end, integersAsBigInt) {
  let ptr = ctx.p;
  let c = ctx.s.charCodeAt(ptr);
  if (c === 91 || c === 123) {
    if (!ctx.d--) {
      throw new TomlError("document contains excessively nested structures. aborting.", {
        toml: ctx.s,
        ptr
      });
    }
    let value = c === 91 ? parseArray(ctx, integersAsBigInt) : parseInlineTable(ctx, integersAsBigInt);
    ctx.d++;
    return value;
  }
  if (c === 34 || c === 39) {
    return parseString(ctx);
  }
  if (c === 116) {
    if (ctx.s.charCodeAt(++ctx.p) !== 114 || ctx.s.charCodeAt(++ctx.p) !== 117 || ctx.s.charCodeAt(++ctx.p) !== 101)
      throw new TomlError("invalid value", { toml: ctx.s, ptr });
    ctx.p++;
    return true;
  }
  if (c === 102) {
    if (ctx.s.charCodeAt(++ctx.p) !== 97 || ctx.s.charCodeAt(++ctx.p) !== 108 || ctx.s.charCodeAt(++ctx.p) !== 115 || ctx.s.charCodeAt(++ctx.p) !== 101)
      throw new TomlError("invalid value", { toml: ctx.s, ptr });
    ctx.p++;
    return false;
  }
  return parseValue(ctx, integersAsBigInt, end);
}

// node_modules/smol-toml/dist/struct.js
var KEY_PART_RE = /^[a-zA-Z0-9-_]+[ \t]*$/;
function parseKey(ctx, end = "=") {
  let start = ctx.p;
  let dot = start - 1;
  let parsed = [];
  let endPtr = ctx.s.indexOf(end, start);
  if (endPtr < 0) {
    throw new TomlError("incomplete key-value: cannot find end of key", {
      toml: ctx.s,
      ptr: start
    });
  }
  do {
    let c = ctx.s.charCodeAt(ctx.p = ++dot);
    if (c !== 32 && c !== 9) {
      if (c === 34 || c === 39) {
        if (c === ctx.s.charCodeAt(ctx.p + 1) && c === ctx.s.charCodeAt(ctx.p + 2)) {
          throw new TomlError("multiline strings are not allowed in keys", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        let part = parseString(ctx);
        dot = ctx.s.indexOf(".", ctx.p);
        let strEnd = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
        let newLine = indexOfNewline(strEnd);
        if (newLine > -1) {
          throw new TomlError("newlines are not allowed in keys", {
            toml: ctx.s,
            ptr: newLine
          });
        }
        if (strEnd.trimStart()) {
          throw new TomlError("found extra tokens after the string part", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        if (endPtr < ctx.p) {
          endPtr = ctx.s.indexOf(end, ctx.p);
          if (endPtr < 0) {
            throw new TomlError("incomplete key-value: cannot find end of key", {
              toml: ctx.s,
              ptr: start
            });
          }
        }
        parsed.push(part);
      } else {
        dot = ctx.s.indexOf(".", ctx.p);
        let part = ctx.s.slice(ctx.p, dot < 0 || dot > endPtr ? endPtr : dot);
        if (!KEY_PART_RE.test(part)) {
          throw new TomlError("only letter, numbers, dashes and underscores are allowed in keys", {
            toml: ctx.s,
            ptr: ctx.p
          });
        }
        parsed.push(part.trimEnd());
      }
    }
  } while (dot + 1 && dot < endPtr);
  ctx.p = endPtr + 1;
  skipVoid(ctx, true, true);
  return parsed;
}
function parseInlineTable(ctx, integersAsBigInt) {
  let res = {};
  let seen = /* @__PURE__ */ new Set();
  let c;
  ctx.p++;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 125) {
      ctx.p++;
      return res;
    }
    let k;
    let t = res;
    let hasOwn = false;
    let p = ctx.p;
    let key = parseKey(ctx);
    for (let i = 0; i < key.length; i++) {
      if (i)
        t = hasOwn ? t[k] : t[k] = {};
      k = key[i];
      if ((hasOwn = Object.hasOwn(t, k)) && (typeof t[k] !== "object" || seen.has(t[k]))) {
        throw new TomlError("trying to redefine an already defined value", {
          toml: ctx.s,
          ptr: p
        });
      }
      if (!hasOwn && k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
      }
    }
    if (hasOwn) {
      throw new TomlError("trying to redefine an already defined value", {
        toml: ctx.s,
        ptr: ctx.p
      });
    }
    let value = extractValue(ctx, 125, integersAsBigInt);
    seen.add(t[k] = value);
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 125) {
      return res;
    }
    if (c !== 44) {
      throw new TomlError("expected comma or end of structure", { toml: ctx.s, ptr: ctx.p - 1 });
    }
  }
  throw new TomlError("unfinished table encountered", {
    toml: ctx.s,
    ptr: ctx.p
  });
}
function parseArray(ctx, integersAsBigInt) {
  let res = [];
  let c;
  ctx.p++;
  while (ctx.p < ctx.s.length) {
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p)) === 93) {
      ctx.p++;
      return res;
    }
    res.push(extractValue(ctx, 93, integersAsBigInt));
    skipVoid(ctx);
    if ((c = ctx.s.charCodeAt(ctx.p++)) === 93) {
      return res;
    }
    if (c !== 44) {
      throw new TomlError("expected comma or end of structure", { toml: ctx.s, ptr: ctx.p - 1 });
    }
  }
  throw new TomlError("unfinished array encountered", {
    toml: ctx.s,
    ptr: ctx.p
  });
}

// node_modules/smol-toml/dist/parse.js
function peekTable(key, table, meta, type) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type === 0 && (state.t === 1 || state.t === 2)) {
        return null;
      }
      if (state.t === 2) {
        let l = t.length - 1;
        t = t[l];
        m = m[l].c;
      }
    }
    k = key[i];
    if ((hasOwn = Object.hasOwn(t, k)) && m[k]?.t === 0 && m[k]?.d) {
      return null;
    }
    if (!hasOwn) {
      if (k === "__proto__") {
        Object.defineProperty(t, k, { enumerable: true, configurable: true, writable: true });
        Object.defineProperty(m, k, { enumerable: true, configurable: true, writable: true });
      }
      m[k] = {
        t: i < key.length - 1 && type === 2 ? 3 : type,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type && !(type === 1 && state.t === 3)) {
    return null;
  }
  if (type === 2) {
    if (!state.d) {
      state.d = true;
      t[k] = [];
    }
    t[k].push(t = {});
    state.c[state.i++] = state = { t: 1, d: false, i: 0, c: {} };
  }
  if (state.d) {
    return null;
  }
  state.d = true;
  if (type === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type === 0 && hasOwn) {
    return null;
  }
  return [k, t, state.c];
}
function parse2(toml, { maxDepth = 1e3, integersAsBigInt } = {}) {
  let ctx = { s: toml, p: 0, d: maxDepth };
  let res = {};
  let meta = {};
  let tmp;
  let tbl = res;
  let m = meta;
  skipVoid(ctx);
  while (ctx.p < toml.length) {
    if (toml.charCodeAt(ctx.p) === 91) {
      let isTableArray = toml.charCodeAt(++ctx.p) === 91;
      tmp = ctx.p += +isTableArray;
      let k = parseKey(ctx, "]");
      if (isTableArray) {
        if (toml.charCodeAt(ctx.p - 1) !== 93) {
          throw new TomlError("expected end of table declaration", {
            toml,
            ptr: ctx.p - 1
          });
        }
        ctx.p++;
      }
      let p = peekTable(
        k,
        res,
        meta,
        isTableArray ? 2 : 1
        /* Type.EXPLICIT */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr: tmp
        });
      }
      m = p[2];
      tbl = p[1];
    } else {
      tmp = ctx.p;
      let k = parseKey(ctx);
      let p = peekTable(
        k,
        tbl,
        m,
        0
        /* Type.DOTTED */
      );
      if (!p) {
        throw new TomlError("trying to redefine an already defined table or value", {
          toml,
          ptr: tmp
        });
      }
      p[1][p[0]] = extractValue(ctx, void 0, integersAsBigInt);
    }
    skipVoid(ctx, true);
    if (ctx.p < toml.length && (tmp = toml.charCodeAt(ctx.p)) !== 10 && tmp !== 13) {
      throw new TomlError("each key-value declaration must be followed by an end-of-line", {
        toml,
        ptr: ctx.p
      });
    }
    skipVoid(ctx);
  }
  return res;
}

// src/authority-plan.ts
var MAX_CONFIG_BYTES = 1024 * 1024;
var MAX_CONFIG_DEPTH = 32;
var MAX_CONFIG_NODES = 25e3;
var SENSITIVE_TEXT = /(?:token|secret|password|passphrase|api[_-]?key|authorization|bearer|private[_-]?key|gh[pousr]_|sk_(?:live|test)_|AKIA[0-9A-Z]{16}|-----BEGIN)/i;
var AUTHORITY_CONFIG_PATHS = [
  ".mcp.json",
  "mcp.json",
  ".vscode/mcp.json",
  ".cursor/mcp.json",
  ".github/mcp.json",
  ".github/copilot/mcp.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/config.toml"
];
var RELEVANT_PATHS = new Set(AUTHORITY_CONFIG_PATHS);
var DEFAULT_POLICY = { schemaVersion: 1, approvedAdditions: [], allowUnknownChanges: false };
var ALLOW_RESTRICTION = {
  disposition: "ALLOW",
  direction: "CONTRACTION",
  severity: "low",
  ruleId: "AVP000",
  reason: "the declared authority surface became narrower"
};
var HOLD_UNKNOWN = {
  disposition: "HOLD",
  direction: "INCOMPARABLE",
  severity: "medium",
  ruleId: "AVP001",
  reason: "the authority relationship cannot be proven from the declared configuration"
};
function sha256(value) {
  return `sha256:${createHash8("sha256").update(value).digest("hex")}`;
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function stringValue(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function stringList(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item2) => typeof item2 === "string" && Boolean(item2.trim())).map((item2) => item2.trim()))].sort() : [];
}
function invalidStringList(value) {
  return value !== void 0 && (!Array.isArray(value) || value.some((item2) => typeof item2 !== "string" || !item2.trim()));
}
function boolValue(value) {
  return typeof value === "boolean" ? value : void 0;
}
function safeOrigin(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "non-url-endpoint";
  }
}
function safeExecutable(raw) {
  if (SENSITIVE_TEXT.test(raw)) return "redacted-executable";
  const clean = raw.trim().split(/\s+/)[0] || "unknown";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(clean)) return "environment-assignment";
  return clean.split(/[\\/]/).at(-1) || "unknown";
}
function safeUnixSocket(raw) {
  return SENSITIVE_TEXT.test(raw) ? "redacted-unix-socket" : raw.slice(0, 240);
}
function stableId(semanticKey) {
  return `avp:${createHash8("sha256").update(semanticKey).digest("hex").slice(0, 20)}`;
}
function safeField(value, maximum = 240) {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?").slice(0, maximum);
}
function atom(input) {
  const publicAtom2 = {
    id: stableId(input.semanticKey),
    platform: input.platform,
    sourcePath: safeField(input.sourcePath),
    kind: input.kind,
    subject: safeField(input.subject),
    action: safeField(input.action),
    resource: safeField(input.resource),
    effect: input.effect,
    decision: input.decision,
    constraints: input.constraints.map((value) => safeField(value)).sort(),
    locator: safeField(input.locator)
  };
  return {
    ...publicAtom2,
    semanticKey: input.semanticKey,
    comparisonToken: sha256(canonical(input.comparisonValue)),
    added: input.added,
    removed: input.removed,
    ...input.conditionalOn ? { conditionalOn: input.conditionalOn } : {},
    ...input.compare ? { compare: input.compare } : {}
  };
}
function publicAtom(value) {
  const {
    semanticKey: _key,
    comparisonToken: _token,
    added: _added,
    removed: _removed,
    conditionalOn: _conditionalOn,
    compare: _compare,
    ...safe2
  } = value;
  return safe2;
}
function decisionRelation(before, after) {
  if (before === after) return "equal";
  if (before === "UNKNOWN" || after === "UNKNOWN") return "incomparable";
  const rank = { DENY: 0, ASK: 1, ALLOW: 2 };
  return rank[after] > rank[before] ? "expansion" : "contraction";
}
function orderedRelation(order) {
  return (before, after) => {
    const a = order.indexOf(before.constraints.find((item2) => item2.startsWith("mode="))?.slice(5) ?? "");
    const b = order.indexOf(after.constraints.find((item2) => item2.startsWith("mode="))?.slice(5) ?? "");
    if (a < 0 || b < 0) return "incomparable";
    return b === a ? "equal" : b > a ? "expansion" : "contraction";
  };
}
function partialRelation(edges) {
  const reachable = /* @__PURE__ */ new Map();
  for (const [less, more] of edges) {
    if (!reachable.has(less)) reachable.set(less, /* @__PURE__ */ new Set());
    reachable.get(less).add(more);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, targets] of reachable) {
      for (const target of [...targets]) {
        for (const next of reachable.get(target) ?? []) {
          if (!targets.has(next)) {
            targets.add(next);
            changed = true;
          }
        }
      }
      reachable.set(from, targets);
    }
  }
  return (before, after) => {
    const a = before.constraints.find((item2) => item2.startsWith("mode="))?.slice(5) ?? "";
    const b = after.constraints.find((item2) => item2.startsWith("mode="))?.slice(5) ?? "";
    if (!a || !b) return "incomparable";
    if (a === b) return "equal";
    if (reachable.get(a)?.has(b)) return "expansion";
    if (reachable.get(b)?.has(a)) return "contraction";
    return "incomparable";
  };
}
var MCP_APPROVAL_RELATION = partialRelation([
  ["prompt", "auto"],
  ["prompt", "writes"],
  ["auto", "approve"],
  ["writes", "approve"]
]);
var CLAUDE_MODE_RELATION = partialRelation([
  ["plan", "default"],
  ["dontAsk", "default"],
  ["default", "acceptEdits"],
  ["default", "auto"],
  ["acceptEdits", "bypassPermissions"],
  ["auto", "bypassPermissions"]
]);
function expansion(ruleId, reason, severity = "high") {
  return { disposition: "BLOCK", direction: "EXPANSION", severity, ruleId, reason };
}
function hold(ruleId, reason, severity = "medium") {
  return { disposition: "HOLD", direction: "INCOMPARABLE", severity, ruleId, reason };
}
function git6(repo, args, maxBuffer = 64 * 1024 * 1024) {
  return execFileSync8("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer
  });
}
function relevantFiles(repo, ref) {
  return git6(repo, ["ls-tree", "--name-only", "-z", ref, "--", ...RELEVANT_PATHS]).split("\0").filter((path) => RELEVANT_PATHS.has(path)).sort();
}
function readGitFile(repo, ref, path) {
  const raw = git6(repo, ["show", `${ref}:${path}`], MAX_CONFIG_BYTES + 1);
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error(`${path}@${ref} exceeds ${MAX_CONFIG_BYTES} bytes`);
  return raw;
}
function readGitFileOptional(repo, ref, path) {
  try {
    git6(repo, ["cat-file", "-e", `${ref}:${path}`]);
  } catch {
    return void 0;
  }
  return readGitFile(repo, ref, path);
}
function validatePolicy2(input) {
  const root = record(input);
  if (!root || root.schemaVersion !== 1) throw new Error("policy schemaVersion must be 1");
  const allowed = /* @__PURE__ */ new Set(["schemaVersion", "approvedAdditions", "allowUnknownChanges"]);
  const extras = Object.keys(root).filter((key) => !allowed.has(key));
  if (extras.length) throw new Error(`policy contains unknown field(s): ${extras.join(", ")}`);
  if (!Array.isArray(root.approvedAdditions) || root.approvedAdditions.some((item2) => typeof item2 !== "string" || !item2.trim())) {
    throw new Error("policy approvedAdditions must be an array of non-empty strings");
  }
  if (root.approvedAdditions.length > 1e3 || root.approvedAdditions.some((item2) => item2.length > 1e3)) {
    throw new Error("policy approvedAdditions must contain at most 1000 entries of at most 1000 characters");
  }
  if (new Set(root.approvedAdditions).size !== root.approvedAdditions.length) {
    throw new Error("policy approvedAdditions must not contain duplicates");
  }
  if (typeof root.allowUnknownChanges !== "boolean") throw new Error("policy allowUnknownChanges must be boolean");
  return {
    schemaVersion: 1,
    approvedAdditions: [...root.approvedAdditions],
    allowUnknownChanges: root.allowUnknownChanges
  };
}
function loadAuthorityPlanPolicy(repo, base, path = ".agent-vigil-authority-plan.json") {
  const clean = posix.normalize(path.replace(/^\.\//, ""));
  if (!clean || clean === ".." || clean.startsWith("../") || clean.startsWith("/") || path.includes("\\") || path.includes(":")) {
    throw new Error("authority plan policy path must stay inside the repository");
  }
  const raw = readGitFileOptional(repo, base, clean);
  if (raw === void 0) {
    return { value: DEFAULT_POLICY, source: "built-in default", sha256: sha256(canonical(DEFAULT_POLICY)) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`authority plan policy at ${base}:${clean} is not valid JSON`);
  }
  const value = validatePolicy2(parsed);
  return { value, source: `${clean}@${base}`, sha256: sha256(canonical(value)) };
}
function parseConfig(raw, format) {
  const source = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
  const parsed = format === "toml" ? parse2(source) : JSON.parse(source);
  assertBoundedConfig(parsed);
  return parsed;
}
function assertBoundedConfig(value) {
  let nodes = 0;
  const visit3 = (current, depth) => {
    nodes += 1;
    if (nodes > MAX_CONFIG_NODES) throw new Error(`configuration exceeds ${MAX_CONFIG_NODES} structured values`);
    if (depth > MAX_CONFIG_DEPTH) throw new Error(`configuration exceeds maximum depth ${MAX_CONFIG_DEPTH}`);
    if (Array.isArray(current)) {
      for (const item2 of current) visit3(item2, depth + 1);
      return;
    }
    const object2 = record(current);
    if (object2) for (const item2 of Object.values(object2)) visit3(item2, depth + 1);
  };
  visit3(value, 0);
}
function sourcePlatform(path) {
  if (path.startsWith(".claude/")) return "claude-code";
  if (path.startsWith(".codex/")) return "codex";
  return "mcp";
}
function permissionEffect(rule) {
  const tool = rule.split("(", 1)[0].toLowerCase();
  if (/read|grep|glob|search/.test(tool)) return "read";
  if (/edit|write|notebook/.test(tool)) return "write";
  if (/web|fetch/.test(tool)) return "network";
  if (/bash|shell|exec/.test(tool)) return "execute";
  if (/mcp__|send|post|comment|create|delete|update/.test(tool)) return "external";
  return "unknown";
}
function permissionResource(rule) {
  const open = rule.indexOf("(");
  if (open < 0 || !rule.endsWith(")")) return "*";
  const value = rule.slice(open + 1, -1).trim();
  if (SENSITIVE_TEXT.test(value)) return "redacted-rule-scope";
  return value.slice(0, 200) || "*";
}
function safePermissionRule(rule) {
  if (SENSITIVE_TEXT.test(rule)) {
    return `${permissionAction(rule)}(redacted-rule-scope)`;
  }
  return rule.slice(0, 240);
}
function permissionAction(rule) {
  return rule.split("(", 1)[0].trim() || "unknown-tool";
}
function permissionDisposition(decision) {
  if (decision === "ALLOW") return {
    added: expansion("AVP009", "a tool or resource became pre-authorized"),
    removed: ALLOW_RESTRICTION
  };
  if (decision === "DENY") return {
    added: ALLOW_RESTRICTION,
    removed: expansion("AVP010", "an explicit deny rule was removed")
  };
  if (decision === "ASK") return {
    added: { ...ALLOW_RESTRICTION, direction: "NEUTRAL", reason: "an explicit approval boundary was added" },
    removed: hold("AVP014", "removing an ask rule delegates the result to another rule or the default mode")
  };
  return { added: HOLD_UNKNOWN, removed: HOLD_UNKNOWN };
}
function addPermissionAtoms(out, platform, path, rules, decision, locator) {
  const disposition = permissionDisposition(decision);
  for (const rule of stringList(rules)) {
    const semanticKey = `${platform}\0${path}\0permission\0${rule}`;
    out.push(atom({
      semanticKey,
      platform,
      sourcePath: path,
      kind: "permission",
      subject: "agent",
      action: permissionAction(rule),
      resource: permissionResource(rule),
      effect: permissionEffect(rule),
      decision,
      constraints: [`rule=${safePermissionRule(rule)}`],
      locator: `${locator}.${decision.toLowerCase()}`,
      comparisonValue: decision,
      added: disposition.added,
      removed: disposition.removed,
      compare: (before, after) => decisionRelation(before.decision, after.decision)
    }));
  }
}
function addEnvironmentAtoms(out, platform, path, subject, values, locator) {
  const env = record(values);
  if (!env) return;
  for (const name of Object.keys(env).sort()) {
    const semanticKey = `${platform}\0${path}\0credential\0${subject}\0${name}`;
    out.push(atom({
      semanticKey,
      platform,
      sourcePath: path,
      kind: "credential",
      subject,
      action: "credential.expose",
      resource: `env:${name}`,
      effect: "credential",
      decision: "ALLOW",
      constraints: ["value=redacted"],
      locator: `${locator}.${name}`,
      comparisonValue: env[name],
      added: expansion("AVP008", "a new environment value can be exposed to agent-controlled code", "critical"),
      removed: ALLOW_RESTRICTION,
      compare: () => "incomparable"
    }));
  }
}
function addOpaqueAuthoritySection(out, platform, path, locator, value, reason) {
  if (value === void 0) return;
  const disposition = hold("AVP014", reason, "high");
  out.push(atom({
    semanticKey: `${platform}\0${path}\0opaque-authority\0${locator}`,
    platform,
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "authority.opaque",
    resource: locator,
    effect: "unknown",
    decision: "UNKNOWN",
    constraints: ["normalization=opaque"],
    locator,
    comparisonValue: value,
    added: disposition,
    removed: disposition,
    compare: (before, after) => before.comparisonToken === after.comparisonToken ? "equal" : "incomparable"
  }));
}
function addBooleanExpansionControl(out, path, semanticName, rawValue, defaultValue, action, resource, locator, ruleId, reason) {
  if (rawValue !== void 0 && boolValue(rawValue) === void 0) {
    addOpaqueAuthoritySection(out, "claude-code", path, locator, rawValue, `${locator} must be a boolean authority control`);
  }
  const enabled = boolValue(rawValue) ?? defaultValue;
  out.push(atom({
    semanticKey: `claude-code\0${path}\0${semanticName}`,
    platform: "claude-code",
    sourcePath: path,
    kind: "control",
    subject: "bash",
    action,
    resource,
    effect: "control",
    decision: enabled ? "ALLOW" : "DENY",
    constraints: [`enabled=${enabled}`],
    locator,
    comparisonValue: enabled,
    added: enabled ? expansion(ruleId, reason, "critical") : ALLOW_RESTRICTION,
    removed: ALLOW_RESTRICTION,
    conditionalOn: `claude-code\0${path}\0sandbox-enabled`,
    compare: (before, after) => decisionRelation(before.decision, after.decision)
  }));
}
function addMcpEnvironmentReferences(out, platform, path, subject, values, locator) {
  if (!Array.isArray(values)) return;
  for (const [index, raw] of values.entries()) {
    const config = record(raw);
    const name = stringValue(raw) ?? stringValue(config?.name);
    if (!name) {
      addOpaqueAuthoritySection(out, platform, path, `${locator}[${index}]`, raw, "an MCP environment reference has an unsupported shape");
      continue;
    }
    const source = stringValue(config?.source) ?? "local";
    out.push(atom({
      semanticKey: `${platform}\0${path}\0${subject}\0env-ref\0${name}`,
      platform,
      sourcePath: path,
      kind: "credential",
      subject,
      action: "environment.inherit",
      resource: `env:${name}`,
      effect: "credential",
      decision: "ALLOW",
      constraints: [`source=${source}`],
      locator,
      comparisonValue: { name, source },
      added: expansion("AVP008", "an MCP process can inherit an additional environment value", "critical"),
      removed: ALLOW_RESTRICTION,
      compare: (before, after) => before.comparisonToken === after.comparisonToken ? "equal" : "incomparable"
    }));
  }
}
function addMcpServerAtoms(out, platform, path, values, locator) {
  const servers = record(values);
  if (!servers) return;
  for (const [name, rawServer] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    const server = record(rawServer);
    if (!server) {
      addOpaqueAuthoritySection(out, platform, path, `${locator}.${name}`, rawServer, "an MCP server entry has an unsupported shape");
      continue;
    }
    const enabled = boolValue(server.enabled) ?? !boolValue(server.disabled);
    const command = stringValue(server.command);
    const url = stringValue(server.url) ?? stringValue(server.serverUrl);
    const transport = url ? "http" : command ? "stdio" : stringValue(server.type) ?? "unknown";
    const identity = url ? safeOrigin(url) : command ? safeExecutable(command) : "unknown-server";
    const baseKey = `${platform}\0${path}\0mcp\0${name}`;
    out.push(atom({
      semanticKey: `${baseKey}\0enabled`,
      platform,
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.connect",
      resource: `${name}:${identity}`,
      effect: transport === "stdio" ? "execute" : transport === "http" ? "network" : "unknown",
      decision: enabled ? "ALLOW" : "DENY",
      constraints: [`enabled=${enabled}`, `transport=${transport}`],
      locator: `${locator}.${name}.enabled`,
      comparisonValue: enabled,
      added: enabled ? expansion("AVP002", "a newly declared MCP server adds an unbounded tool surface", "critical") : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      removed: enabled ? ALLOW_RESTRICTION : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      compare: (before, after) => decisionRelation(before.decision, after.decision)
    }));
    out.push(atom({
      semanticKey: `${baseKey}\0identity`,
      platform,
      sourcePath: path,
      kind: "control",
      subject: name,
      action: "mcp.launch",
      resource: identity,
      effect: transport === "stdio" ? "execute" : transport === "http" ? "network" : "unknown",
      decision: enabled ? "ALLOW" : "DENY",
      constraints: [`transport=${transport}`, ...command ? [`executable=${safeExecutable(command)}`] : [], ...url ? [`origin=${safeOrigin(url)}`] : []],
      locator: `${locator}.${name}`,
      comparisonValue: { command, args: server.args, cwd: server.cwd, url },
      added: enabled ? expansion("AVP002", "a new MCP launch identity can execute code or contact an external service", "critical") : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      removed: ALLOW_RESTRICTION,
      compare: () => "expansion"
    }));
    addEnvironmentAtoms(out, platform, path, `mcp:${name}`, server.env, `${locator}.${name}.env`);
    addEnvironmentAtoms(out, platform, path, `mcp:${name}`, server.http_headers, `${locator}.${name}.http_headers`);
    addEnvironmentAtoms(out, platform, path, `mcp:${name}`, server.env_http_headers, `${locator}.${name}.env_http_headers`);
    addEnvironmentAtoms(out, platform, path, `mcp:${name}`, server.headers, `${locator}.${name}.headers`);
    addMcpEnvironmentReferences(out, platform, path, `mcp:${name}`, server.env_vars, `${locator}.${name}.env_vars`);
    const bearer = stringValue(server.bearer_token_env_var);
    if (bearer) addEnvironmentAtoms(out, platform, path, `mcp:${name}`, { [bearer]: "environment-reference" }, `${locator}.${name}.bearer_token_env_var`);
    const auth = stringValue(server.auth);
    if (auth) {
      out.push(atom({
        semanticKey: `${baseKey}\0auth-mode`,
        platform,
        sourcePath: path,
        kind: "credential",
        subject: `mcp:${name}`,
        action: "mcp.authenticate",
        resource: "credential-source",
        effect: "credential",
        decision: auth === "oauth" || auth === "chatgpt" ? "ALLOW" : "UNKNOWN",
        constraints: [`mode=${auth}`],
        locator: `${locator}.${name}.auth`,
        comparisonValue: auth,
        added: auth === "oauth" || auth === "chatgpt" ? expansion("AVP008", "an MCP server can use an additional authenticated credential source", "critical") : hold("AVP014", `unsupported MCP authentication mode ${auth}`),
        removed: HOLD_UNKNOWN,
        compare: (before, after) => before.comparisonToken === after.comparisonToken ? "equal" : "incomparable"
      }));
    }
    const executionEnvironment = stringValue(server.experimental_environment);
    if (executionEnvironment) {
      out.push(atom({
        semanticKey: `${baseKey}\0execution-environment`,
        platform,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name}`,
        action: "process.execute",
        resource: executionEnvironment,
        effect: "execute",
        decision: executionEnvironment === "remote" ? "ALLOW" : executionEnvironment === "local" ? "ASK" : "UNKNOWN",
        constraints: [`environment=${executionEnvironment}`],
        locator: `${locator}.${name}.experimental_environment`,
        comparisonValue: executionEnvironment,
        added: executionEnvironment === "remote" ? expansion("AVP009", "an MCP stdio process can execute in a remote environment", "critical") : executionEnvironment === "local" ? { ...ALLOW_RESTRICTION, direction: "NEUTRAL" } : HOLD_UNKNOWN,
        removed: HOLD_UNKNOWN,
        compare: orderedRelation(["local", "remote"])
      }));
    }
    const oauthResource = stringValue(server.oauth_resource);
    if (oauthResource) {
      out.push(atom({
        semanticKey: `${baseKey}\0oauth-resource`,
        platform,
        sourcePath: path,
        kind: "credential",
        subject: `mcp:${name}`,
        action: "oauth.resource",
        resource: safeOrigin(oauthResource),
        effect: "credential",
        decision: "ALLOW",
        constraints: [],
        locator: `${locator}.${name}.oauth_resource`,
        comparisonValue: oauthResource,
        added: expansion("AVP008", "an MCP connection requests credentials for an additional OAuth resource", "critical"),
        removed: ALLOW_RESTRICTION,
        compare: () => "incomparable"
      }));
    }
    for (const scope of stringList(server.scopes)) {
      out.push(atom({
        semanticKey: `${baseKey}\0oauth-scope\0${scope}`,
        platform,
        sourcePath: path,
        kind: "permission",
        subject: `mcp:${name}`,
        action: "oauth.scope",
        resource: scope,
        effect: "external",
        decision: "ALLOW",
        constraints: [],
        locator: `${locator}.${name}.scopes`,
        comparisonValue: scope,
        added: expansion("AVP008", "an MCP connection requests an additional OAuth scope", "critical"),
        removed: ALLOW_RESTRICTION
      }));
    }
    const enabledTools = stringList(server.enabled_tools ?? server.enabledTools);
    const disabledTools = stringList(server.disabled_tools ?? server.disabledTools);
    for (const tool of enabledTools) {
      out.push(atom({
        semanticKey: `${baseKey}\0tool\0${tool}`,
        platform,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name}`,
        action: "mcp.tool",
        resource: tool,
        effect: "unknown",
        decision: "ALLOW",
        constraints: ["selection=enabled"],
        locator: `${locator}.${name}.enabled_tools`,
        comparisonValue: true,
        added: expansion("AVP013", "an additional MCP tool is exposed to the agent", "critical"),
        removed: ALLOW_RESTRICTION
      }));
    }
    for (const tool of disabledTools) {
      out.push(atom({
        semanticKey: `${baseKey}\0tool\0${tool}`,
        platform,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name}`,
        action: "mcp.tool",
        resource: tool,
        effect: "unknown",
        decision: "DENY",
        constraints: ["selection=disabled"],
        locator: `${locator}.${name}.disabled_tools`,
        comparisonValue: false,
        added: ALLOW_RESTRICTION,
        removed: expansion("AVP013", "an MCP tool was removed from the explicit deny list", "critical"),
        compare: (before, after) => decisionRelation(before.decision, after.decision)
      }));
    }
    const approvalMode = stringValue(server.default_tools_approval_mode ?? server.defaultToolsApprovalMode);
    if (approvalMode) addMcpApprovalAtom(out, platform, path, `${baseKey}\0approval`, name, approvalMode, `${locator}.${name}.default_tools_approval_mode`);
    const tools = record(server.tools);
    if (tools) {
      for (const [tool, rawTool] of Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))) {
        const config = record(rawTool);
        if (!config) continue;
        const mode = stringValue(config.approval_mode ?? config.approvalMode);
        if (mode) addMcpApprovalAtom(out, platform, path, `${baseKey}\0tool-approval\0${tool}`, `${name}/${tool}`, mode, `${locator}.${name}.tools.${tool}.approval_mode`);
      }
    }
    const recognized = /* @__PURE__ */ new Set([
      "args",
      "auth",
      "bearer_token_env_var",
      "command",
      "cwd",
      "defaultToolsApprovalMode",
      "default_tools_approval_mode",
      "disabled",
      "disabledTools",
      "disabled_tools",
      "enabled",
      "enabledTools",
      "enabled_tools",
      "env",
      "env_http_headers",
      "env_vars",
      "experimental_environment",
      "headers",
      "http_headers",
      "oauth_resource",
      "required",
      "scopes",
      "serverUrl",
      "startup_timeout_ms",
      "startup_timeout_sec",
      "tool_timeout_sec",
      "tools",
      "type",
      "url"
    ]);
    const unsupported = Object.fromEntries(Object.entries(server).filter(([key]) => !recognized.has(key)));
    if (Object.keys(unsupported).length) {
      addOpaqueAuthoritySection(out, platform, path, `${locator}.${name}.*`, unsupported, "an MCP server contains authority-bearing fields that are not yet normalized");
    }
  }
}
function addMcpApprovalAtom(out, platform, path, semanticKey, subject, mode, locator) {
  const supported = /* @__PURE__ */ new Set(["auto", "prompt", "writes", "approve"]);
  const known = supported.has(mode);
  out.push(atom({
    semanticKey,
    platform,
    sourcePath: path,
    kind: "control",
    subject: `mcp:${subject}`,
    action: "approval.mode",
    resource: "tool-call",
    effect: "control",
    decision: mode === "prompt" ? "ASK" : known ? "ALLOW" : "UNKNOWN",
    constraints: [`mode=${mode}`],
    locator,
    comparisonValue: mode,
    added: mode === "prompt" ? { ...ALLOW_RESTRICTION, direction: "NEUTRAL", reason: "MCP tools require explicit approval" } : known ? expansion("AVP004", "MCP tools can run without an unconditional human prompt", "critical") : hold("AVP014", `unsupported MCP approval mode ${mode}`),
    removed: HOLD_UNKNOWN,
    compare: MCP_APPROVAL_RELATION
  }));
}
function extractMcp(path, parsed) {
  const out = [];
  const declaredContainers = ["mcpServers", "servers"].filter((locator) => parsed[locator] !== void 0);
  const containersToNormalize = declaredContainers.length > 1 ? declaredContainers.slice(0, 1) : declaredContainers;
  if (declaredContainers.length > 1) {
    addOpaqueAuthoritySection(out, "mcp", path, declaredContainers[1], parsed[declaredContainers[1]], "the MCP document declares multiple server containers with ambiguous precedence");
  }
  for (const locator of containersToNormalize) {
    const value = parsed[locator];
    if (value === void 0) continue;
    if (!record(value)) {
      addOpaqueAuthoritySection(out, "mcp", path, locator, value, `the MCP ${locator} container has an unsupported shape`);
      continue;
    }
    addMcpServerAtoms(out, "mcp", path, value, locator);
  }
  for (const [locator, value] of Object.entries(parsed).sort(([a], [b]) => a.localeCompare(b))) {
    if (locator === "$schema" || locator === "mcpServers" || locator === "servers") continue;
    addOpaqueAuthoritySection(out, "mcp", path, locator, value, "the MCP document contains an authority-bearing root field that is not yet normalized");
  }
  return out;
}
function extractClaude(path, parsed) {
  const out = [];
  const permissions = record(parsed.permissions) ?? {};
  addPermissionAtoms(out, "claude-code", path, permissions.allow, "ALLOW", "permissions");
  addPermissionAtoms(out, "claude-code", path, permissions.ask, "ASK", "permissions");
  addPermissionAtoms(out, "claude-code", path, permissions.deny, "DENY", "permissions");
  const mode = stringValue(permissions.defaultMode) ?? "default";
  const supportedModes = /* @__PURE__ */ new Set(["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
  out.push(atom({
    semanticKey: `claude-code\0${path}\0default-mode`,
    platform: "claude-code",
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "approval.default",
    resource: "unmatched-tool-calls",
    effect: "control",
    decision: mode === "dontAsk" || mode === "plan" ? "DENY" : mode === "default" ? "ASK" : supportedModes.has(mode) ? "ALLOW" : "UNKNOWN",
    constraints: [`mode=${mode}`],
    locator: "permissions.defaultMode",
    comparisonValue: mode,
    added: mode === "bypassPermissions" ? expansion("AVP004", "Claude Code bypassPermissions removes ordinary approval prompts", "critical") : supportedModes.has(mode) ? HOLD_UNKNOWN : hold("AVP014", `unsupported Claude Code permission mode ${mode}`),
    removed: HOLD_UNKNOWN,
    compare: CLAUDE_MODE_RELATION
  }));
  const disableBypass = permissions.disableBypassPermissionsMode;
  if (disableBypass !== void 0) {
    const disabled = disableBypass === "disable" || disableBypass === true;
    out.push(atom({
      semanticKey: `claude-code\0${path}\0disable-bypass`,
      platform: "claude-code",
      sourcePath: path,
      kind: "control",
      subject: "agent",
      action: "approval.bypass",
      resource: "all-tools",
      effect: "control",
      decision: disabled ? "DENY" : "ALLOW",
      constraints: [`disabled=${disabled}`],
      locator: "permissions.disableBypassPermissionsMode",
      comparisonValue: disableBypass,
      added: disabled ? ALLOW_RESTRICTION : expansion("AVP004", "permission bypass remains available", "critical"),
      removed: disabled ? expansion("AVP004", "the control that disables permission bypass was removed", "critical") : ALLOW_RESTRICTION,
      compare: (before, after) => decisionRelation(before.decision, after.decision)
    }));
  }
  for (const directory of [.../* @__PURE__ */ new Set([...stringList(permissions.additionalDirectories), ...stringList(parsed.additionalDirectories)])]) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0additional-directory\0${directory}`,
      platform: "claude-code",
      sourcePath: path,
      kind: "permission",
      subject: "agent",
      action: "filesystem.access",
      resource: directory.slice(0, 240),
      effect: "write",
      decision: "ALLOW",
      constraints: ["scope=additional-directory"],
      locator: "permissions.additionalDirectories",
      comparisonValue: directory,
      added: expansion("AVP007", "Claude Code can access an additional filesystem root", "critical"),
      removed: ALLOW_RESTRICTION
    }));
  }
  const sandbox = record(parsed.sandbox);
  if (sandbox) {
    const enabled = boolValue(sandbox.enabled) ?? false;
    out.push(atom({
      semanticKey: `claude-code\0${path}\0sandbox-enabled`,
      platform: "claude-code",
      sourcePath: path,
      kind: "control",
      subject: "bash",
      action: "sandbox.enforce",
      resource: "process",
      effect: "control",
      decision: enabled ? "ALLOW" : "DENY",
      constraints: [`enabled=${enabled}`],
      locator: "sandbox.enabled",
      comparisonValue: enabled,
      added: enabled ? ALLOW_RESTRICTION : expansion("AVP005", "the declared Bash sandbox is disabled", "critical"),
      removed: enabled ? expansion("AVP005", "the declared Bash sandbox control was removed", "critical") : ALLOW_RESTRICTION,
      compare: (before, after) => before.decision === after.decision ? "equal" : after.decision === "DENY" ? "expansion" : "contraction"
    }));
    const failClosed = boolValue(sandbox.failIfUnavailable);
    if (failClosed !== void 0) {
      out.push(atom({
        semanticKey: `claude-code\0${path}\0sandbox-fail-closed`,
        platform: "claude-code",
        sourcePath: path,
        kind: "control",
        subject: "bash",
        action: "sandbox.fail-closed",
        resource: "startup",
        effect: "control",
        decision: failClosed ? "ALLOW" : "DENY",
        constraints: [`enabled=${failClosed}`],
        locator: "sandbox.failIfUnavailable",
        comparisonValue: failClosed,
        added: failClosed ? ALLOW_RESTRICTION : expansion("AVP005", "sandbox startup failure can fall back to unsandboxed execution", "critical"),
        removed: failClosed ? expansion("AVP005", "the sandbox fail-closed requirement was removed", "critical") : ALLOW_RESTRICTION,
        compare: (before, after) => before.decision === after.decision ? "equal" : after.decision === "DENY" ? "expansion" : "contraction"
      }));
    }
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-auto-allow-bash",
      sandbox.autoAllowBashIfSandboxed,
      true,
      "approval.sandbox-auto",
      "bash",
      "sandbox.autoAllowBashIfSandboxed",
      "AVP004",
      "sandboxed Bash commands can run without an unconditional human prompt"
    );
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-allow-unsandboxed",
      sandbox.allowUnsandboxedCommands,
      true,
      "sandbox.escape",
      "dangerouslyDisableSandbox",
      "sandbox.allowUnsandboxedCommands",
      "AVP005",
      "commands can retry outside the declared sandbox"
    );
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-weaker-nested",
      sandbox.enableWeakerNestedSandbox,
      false,
      "sandbox.weaker-nested",
      "process-isolation",
      "sandbox.enableWeakerNestedSandbox",
      "AVP005",
      "the nested sandbox uses a weaker process-isolation boundary"
    );
    for (const command of stringList(sandbox.excludedCommands)) {
      out.push(atom({
        semanticKey: `claude-code\0${path}\0sandbox-excluded-command\0${command}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "permission",
        subject: "bash",
        action: "sandbox.exclude",
        resource: safeExecutable(command),
        effect: "execute",
        decision: "ALLOW",
        constraints: ["isolation=disabled"],
        locator: "sandbox.excludedCommands",
        comparisonValue: command,
        added: expansion("AVP005", "an additional command can run outside the declared sandbox", "critical"),
        removed: ALLOW_RESTRICTION,
        conditionalOn: `claude-code\0${path}\0sandbox-enabled`
      }));
    }
    if (invalidStringList(sandbox.excludedCommands)) {
      addOpaqueAuthoritySection(out, "claude-code", path, "sandbox.excludedCommands", sandbox.excludedCommands, "sandbox.excludedCommands has an unsupported shape");
    }
    const network = record(sandbox.network);
    for (const host of stringList(network?.allowedDomains)) {
      out.push(atom({
        semanticKey: `claude-code\0${path}\0network\0${host}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "permission",
        subject: "bash",
        action: "network.connect",
        resource: host,
        effect: "network",
        decision: "ALLOW",
        constraints: ["scope=allowed-domain"],
        locator: "sandbox.network.allowedDomains",
        comparisonValue: host,
        added: expansion("AVP006", "sandboxed commands can reach an additional network destination", "critical"),
        removed: ALLOW_RESTRICTION,
        conditionalOn: `claude-code\0${path}\0sandbox-enabled`
      }));
    }
    if (invalidStringList(network?.allowedDomains)) {
      addOpaqueAuthoritySection(out, "claude-code", path, "sandbox.network.allowedDomains", network?.allowedDomains, "sandbox.network.allowedDomains has an unsupported shape");
    }
    for (const socket of stringList(network?.allowUnixSockets)) {
      out.push(atom({
        semanticKey: `claude-code\0${path}\0unix-socket\0${socket}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "permission",
        subject: "bash",
        action: "network.unix-socket",
        resource: safeUnixSocket(socket),
        effect: "control",
        decision: "ALLOW",
        constraints: ["scope=allowed-socket"],
        locator: "sandbox.network.allowUnixSockets",
        comparisonValue: socket,
        added: expansion("AVP005", "sandboxed commands can access an additional host Unix socket", "critical"),
        removed: ALLOW_RESTRICTION,
        conditionalOn: `claude-code\0${path}\0sandbox-enabled`
      }));
    }
    if (invalidStringList(network?.allowUnixSockets)) {
      addOpaqueAuthoritySection(out, "claude-code", path, "sandbox.network.allowUnixSockets", network?.allowUnixSockets, "sandbox.network.allowUnixSockets has an unsupported shape");
    }
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-allow-all-unix-sockets",
      network?.allowAllUnixSockets,
      false,
      "network.unix-socket-all",
      "host-sockets:*",
      "sandbox.network.allowAllUnixSockets",
      "AVP005",
      "sandboxed commands can access every host Unix socket"
    );
    addBooleanExpansionControl(
      out,
      path,
      "sandbox-allow-local-binding",
      network?.allowLocalBinding,
      false,
      "network.bind-local",
      "localhost:*",
      "sandbox.network.allowLocalBinding",
      "AVP006",
      "sandboxed commands can bind to local network ports"
    );
    if (network) {
      for (const [locator, value] of Object.entries(network).sort(([a], [b]) => a.localeCompare(b))) {
        if (["allowedDomains", "allowUnixSockets", "allowAllUnixSockets", "allowLocalBinding"].includes(locator)) continue;
        addOpaqueAuthoritySection(out, "claude-code", path, `sandbox.network.${locator}`, value, `Claude Code sandbox.network.${locator} is not yet ordered by the authority lattice`);
      }
    } else if (sandbox.network !== void 0) {
      addOpaqueAuthoritySection(out, "claude-code", path, "sandbox.network", sandbox.network, "sandbox.network has an unsupported shape");
    }
    for (const [locator, value] of Object.entries(sandbox).sort(([a], [b]) => a.localeCompare(b))) {
      if ([
        "allowUnsandboxedCommands",
        "autoAllowBashIfSandboxed",
        "enabled",
        "enableWeakerNestedSandbox",
        "excludedCommands",
        "failIfUnavailable",
        "network"
      ].includes(locator)) continue;
      addOpaqueAuthoritySection(out, "claude-code", path, `sandbox.${locator}`, value, `Claude Code sandbox.${locator} is not yet ordered by the authority lattice`);
    }
  } else if (parsed.sandbox !== void 0) {
    addOpaqueAuthoritySection(out, "claude-code", path, "sandbox", parsed.sandbox, "the Claude Code sandbox container has an unsupported shape");
  }
  const allMcp = boolValue(parsed.enableAllProjectMcpServers);
  if (allMcp !== void 0) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0all-project-mcp`,
      platform: "claude-code",
      sourcePath: path,
      kind: "control",
      subject: "agent",
      action: "mcp.auto-enable",
      resource: "project-servers:*",
      effect: "execute",
      decision: allMcp ? "ALLOW" : "DENY",
      constraints: [`enabled=${allMcp}`],
      locator: "enableAllProjectMcpServers",
      comparisonValue: allMcp,
      added: allMcp ? expansion("AVP003", "all project MCP servers are automatically approved", "critical") : ALLOW_RESTRICTION,
      removed: allMcp ? ALLOW_RESTRICTION : expansion("AVP003", "the explicit block on automatic project MCP approval was removed", "critical"),
      compare: (before, after) => decisionRelation(before.decision, after.decision)
    }));
  }
  for (const name of stringList(parsed.enabledMcpjsonServers)) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0mcp-server\0${name}`,
      platform: "claude-code",
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.enable",
      resource: name,
      effect: "unknown",
      decision: "ALLOW",
      constraints: [],
      locator: "enabledMcpjsonServers",
      comparisonValue: true,
      added: expansion("AVP003", "an MCP server is newly approved for Claude Code", "critical"),
      removed: ALLOW_RESTRICTION
    }));
  }
  for (const name of stringList(parsed.disabledMcpjsonServers)) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0mcp-server\0${name}`,
      platform: "claude-code",
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.enable",
      resource: name,
      effect: "unknown",
      decision: "DENY",
      constraints: [],
      locator: "disabledMcpjsonServers",
      comparisonValue: false,
      added: ALLOW_RESTRICTION,
      removed: expansion("AVP003", "an MCP server was removed from Claude Code's deny list", "critical"),
      compare: (before, after) => decisionRelation(before.decision, after.decision)
    }));
  }
  const plugins = record(parsed.enabledPlugins);
  if (plugins) {
    for (const [name, rawEnabled] of Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b))) {
      const enabled = boolValue(rawEnabled);
      if (enabled === void 0) continue;
      out.push(atom({
        semanticKey: `claude-code\0${path}\0plugin\0${name}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "capability",
        subject: "agent",
        action: "plugin.enable",
        resource: name,
        effect: "unknown",
        decision: enabled ? "ALLOW" : "DENY",
        constraints: [`enabled=${enabled}`],
        locator: `enabledPlugins.${name}`,
        comparisonValue: enabled,
        added: enabled ? expansion("AVP015", "a plugin can add skills, agents, hooks, MCP servers, or executables", "critical") : ALLOW_RESTRICTION,
        removed: enabled ? ALLOW_RESTRICTION : expansion("AVP015", "an explicit plugin disable was removed", "critical"),
        compare: (before, after) => decisionRelation(before.decision, after.decision)
      }));
    }
  }
  addEnvironmentAtoms(out, "claude-code", path, "session", parsed.env, "env");
  addMcpServerAtoms(out, "claude-code", path, parsed.mcpServers, "mcpServers");
  addClaudeHooks(out, path, parsed.hooks);
  addModelAtom(out, "claude-code", path, parsed.model, "model");
  for (const locator of ["extraKnownMarketplaces", "allowManagedPermissionRulesOnly", "allowManagedHooksOnly", "apiKeyHelper"]) {
    addOpaqueAuthoritySection(out, "claude-code", path, locator, parsed[locator], `Claude Code ${locator} can alter executable or managed authority and is not yet fully normalized`);
  }
  return out;
}
function addClaudeHooks(out, path, rawHooks) {
  const hooks = record(rawHooks);
  if (!hooks) return;
  for (const [event, rawEntries] of Object.entries(hooks).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Array.isArray(rawEntries)) continue;
    rawEntries.forEach((rawEntry, index) => {
      const entry = record(rawEntry);
      if (!entry) return;
      const handlers = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      handlers.forEach((rawHandler, handlerIndex) => {
        const handler = record(rawHandler);
        if (!handler) return;
        const type = stringValue(handler.type) ?? "command";
        const command = stringValue(handler.command);
        const semanticKey = `claude-code\0${path}\0hook\0${event}\0${index}\0${handlerIndex}`;
        const securityControl = event === "PreToolUse" || event === "PermissionRequest";
        out.push(atom({
          semanticKey,
          platform: "claude-code",
          sourcePath: path,
          kind: "control",
          subject: event,
          action: "hook.execute",
          resource: command ? safeExecutable(command) : type,
          effect: command ? "execute" : "control",
          decision: "ALLOW",
          constraints: [`type=${type}`, ...stringValue(entry.matcher) ? ["matcher=configured"] : []],
          locator: `hooks.${event}[${index}].hooks[${handlerIndex}]`,
          comparisonValue: { matcher: entry.matcher, handler },
          added: expansion("AVP011", "a repository-controlled hook can execute or alter tool authorization", securityControl ? "critical" : "high"),
          removed: securityControl ? expansion("AVP011", "a pre-execution authorization hook was removed", "critical") : ALLOW_RESTRICTION,
          compare: () => "incomparable"
        }));
      });
    });
  }
}
function addModelAtom(out, platform, path, rawModel, locator) {
  const model = stringValue(rawModel);
  if (!model) return;
  const mutable = /(?:^|[-_/.:])(latest|default|auto|current)(?:$|[-_/.:])/i.test(model);
  out.push(atom({
    semanticKey: `${platform}\0${path}\0model`,
    platform,
    sourcePath: path,
    kind: "model",
    subject: "agent",
    action: "model.select",
    resource: model.slice(0, 200),
    effect: "control",
    decision: mutable ? "UNKNOWN" : "ALLOW",
    constraints: [`mutable=${mutable}`],
    locator,
    comparisonValue: model,
    added: mutable ? hold("AVP012", "the model identifier appears mutable and cannot be bound to one implementation") : { ...ALLOW_RESTRICTION, direction: "NEUTRAL", reason: "a model identifier was declared" },
    removed: HOLD_UNKNOWN,
    compare: (before, after) => {
      const oldMutable = before.constraints.includes("mutable=true");
      const newMutable = after.constraints.includes("mutable=true");
      if (!oldMutable && newMutable) return "expansion";
      if (oldMutable && !newMutable) return "contraction";
      return "incomparable";
    }
  }));
}
function extractCodex(path, parsed) {
  const out = [];
  const sandboxMode = stringValue(parsed.sandbox_mode) ?? "read-only";
  out.push(atom({
    semanticKey: `codex\0${path}\0sandbox-mode`,
    platform: "codex",
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "sandbox.mode",
    resource: "host-filesystem",
    effect: "write",
    decision: sandboxMode === "read-only" ? "DENY" : sandboxMode === "workspace-write" || sandboxMode === "danger-full-access" ? "ALLOW" : "UNKNOWN",
    constraints: [`mode=${sandboxMode}`],
    locator: "sandbox_mode",
    comparisonValue: sandboxMode,
    added: sandboxMode === "read-only" ? ALLOW_RESTRICTION : sandboxMode === "workspace-write" ? expansion("AVP005", "Codex can write inside the repository") : sandboxMode === "danger-full-access" ? expansion("AVP005", "Codex can write outside the repository without OS sandbox enforcement", "critical") : hold("AVP014", `unsupported Codex sandbox mode ${sandboxMode}`),
    removed: HOLD_UNKNOWN,
    compare: orderedRelation(["read-only", "workspace-write", "danger-full-access"])
  }));
  const workspace = record(parsed.sandbox_workspace_write) ?? {};
  const network = boolValue(workspace.network_access) ?? false;
  out.push(atom({
    semanticKey: `codex\0${path}\0network-access`,
    platform: "codex",
    sourcePath: path,
    kind: "permission",
    subject: "agent",
    action: "network.connect",
    resource: "*",
    effect: "network",
    decision: network ? "ALLOW" : "DENY",
    constraints: [`enabled=${network}`],
    locator: "sandbox_workspace_write.network_access",
    comparisonValue: network,
    added: network ? expansion("AVP006", "Codex can make outbound network connections", "critical") : ALLOW_RESTRICTION,
    removed: network ? ALLOW_RESTRICTION : expansion("AVP006", "the explicit network restriction was removed", "critical"),
    compare: (before, after) => decisionRelation(before.decision, after.decision)
  }));
  for (const root of stringList(workspace.writable_roots)) {
    out.push(atom({
      semanticKey: `codex\0${path}\0writable-root\0${root}`,
      platform: "codex",
      sourcePath: path,
      kind: "permission",
      subject: "agent",
      action: "filesystem.write",
      resource: root.slice(0, 240),
      effect: "write",
      decision: "ALLOW",
      constraints: ["scope=additional-root"],
      locator: "sandbox_workspace_write.writable_roots",
      comparisonValue: root,
      added: expansion("AVP007", "Codex can write to an additional filesystem root", "critical"),
      removed: ALLOW_RESTRICTION
    }));
  }
  const approval = parsed.approval_policy;
  const approvalMode = typeof approval === "string" ? approval : record(approval)?.granular ? "granular" : "unknown";
  out.push(atom({
    semanticKey: `codex\0${path}\0approval-policy`,
    platform: "codex",
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "approval.policy",
    resource: "tool-escalation",
    effect: "control",
    decision: approvalMode === "untrusted" || approvalMode === "on-request" || approvalMode === "granular" ? "ASK" : approvalMode === "never" ? "DENY" : "UNKNOWN",
    constraints: [`mode=${approvalMode}`],
    locator: "approval_policy",
    comparisonValue: approval,
    added: approvalMode === "never" ? expansion("AVP004", "approval_policy=never suppresses interactive escalation", "critical") : approvalMode === "unknown" ? HOLD_UNKNOWN : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
    removed: HOLD_UNKNOWN,
    compare: (before, after) => {
      if (before.comparisonToken === after.comparisonToken) return "equal";
      if (before.decision === "UNKNOWN" || after.decision === "UNKNOWN") return "incomparable";
      if (before.decision === "ASK" && after.decision === "DENY") return "expansion";
      if (before.decision === "DENY" && after.decision === "ASK") return "contraction";
      return "incomparable";
    }
  }));
  const reviewer = stringValue(parsed.approvals_reviewer) ?? "user";
  out.push(atom({
    semanticKey: `codex\0${path}\0approval-reviewer`,
    platform: "codex",
    sourcePath: path,
    kind: "control",
    subject: "agent",
    action: "approval.review",
    resource: "tool-escalation",
    effect: "control",
    decision: reviewer === "user" ? "ASK" : reviewer === "auto_review" || reviewer === "guardian_subagent" ? "ALLOW" : "UNKNOWN",
    constraints: [`mode=${reviewer}`],
    locator: "approvals_reviewer",
    comparisonValue: reviewer,
    added: reviewer === "user" ? { ...ALLOW_RESTRICTION, direction: "NEUTRAL" } : reviewer === "auto_review" || reviewer === "guardian_subagent" ? expansion("AVP004", "eligible approval prompts are delegated to an automated reviewer", "critical") : HOLD_UNKNOWN,
    removed: HOLD_UNKNOWN,
    compare: (before, after) => decisionRelation(before.decision, after.decision)
  }));
  const environment = record(parsed.shell_environment_policy);
  if (environment) {
    const inherit = stringValue(environment.inherit) ?? "core";
    out.push(atom({
      semanticKey: `codex\0${path}\0environment-inherit`,
      platform: "codex",
      sourcePath: path,
      kind: "credential",
      subject: "shell",
      action: "environment.inherit",
      resource: "process-environment",
      effect: "credential",
      decision: inherit === "none" ? "DENY" : inherit === "core" || inherit === "all" ? "ALLOW" : "UNKNOWN",
      constraints: [`mode=${inherit}`],
      locator: "shell_environment_policy.inherit",
      comparisonValue: inherit,
      added: inherit === "all" ? expansion("AVP008", "Codex inherits the full parent process environment", "critical") : inherit === "core" ? hold("AVP008", "Codex inherits a core environment set") : ALLOW_RESTRICTION,
      removed: HOLD_UNKNOWN,
      compare: orderedRelation(["none", "core", "all"])
    }));
    const keepSecrets = boolValue(environment.ignore_default_excludes);
    if (keepSecrets !== void 0) {
      out.push(atom({
        semanticKey: `codex\0${path}\0environment-secret-excludes`,
        platform: "codex",
        sourcePath: path,
        kind: "credential",
        subject: "shell",
        action: "environment.keep-secret-names",
        resource: "*KEY,*SECRET,*TOKEN",
        effect: "credential",
        decision: keepSecrets ? "ALLOW" : "DENY",
        constraints: [`enabled=${keepSecrets}`],
        locator: "shell_environment_policy.ignore_default_excludes",
        comparisonValue: keepSecrets,
        added: keepSecrets ? expansion("AVP008", "automatic secret-name exclusions are disabled", "critical") : ALLOW_RESTRICTION,
        removed: keepSecrets ? ALLOW_RESTRICTION : expansion("AVP008", "automatic secret-name exclusions are no longer enforced", "critical"),
        compare: (before, after) => decisionRelation(before.decision, after.decision)
      }));
    }
    addEnvironmentAtoms(out, "codex", path, "shell", environment.set, "shell_environment_policy.set");
  }
  addMcpServerAtoms(out, "codex", path, parsed.mcp_servers, "mcp_servers");
  addModelAtom(out, "codex", path, parsed.model, "model");
  for (const locator of ["agents", "apps", "auto_review", "computer_use", "features", "plugins", "skills", "tools", "web_search"]) {
    addOpaqueAuthoritySection(out, "codex", path, locator, parsed[locator], `Codex ${locator} can alter agent or tool authority and is not yet fully normalized`);
  }
  return out;
}
function profileDigest(profile) {
  return sha256(canonical(profile));
}
function discoverAuthorityProfile(repo, ref) {
  const internal = {
    schemaVersion: "agent-vigil-authority-profile/v1",
    scope: "repository-declared",
    ref,
    sources: [],
    atoms: [],
    gaps: []
  };
  for (const path of relevantFiles(repo, ref)) {
    const platform = sourcePlatform(path);
    let raw;
    try {
      raw = readGitFile(repo, ref, path);
    } catch (error) {
      internal.gaps.push({ platform, sourcePath: path, locator: path, reason: error.message });
      continue;
    }
    const format = path.endsWith(".toml") ? "toml" : "json";
    internal.sources.push({ platform, path, format, sha256: sha256(raw) });
    let parsed;
    try {
      parsed = parseConfig(raw, format);
    } catch {
      internal.gaps.push({ platform, sourcePath: path, locator: path, reason: `${format.toUpperCase()} parse failed; inspect the committed source locally` });
      continue;
    }
    const value = record(parsed);
    if (!value) {
      internal.gaps.push({ platform, sourcePath: path, locator: path, reason: "configuration root is not an object" });
      continue;
    }
    try {
      internal.atoms.push(...platform === "claude-code" ? extractClaude(path, value) : platform === "codex" ? extractCodex(path, value) : extractMcp(path, value));
    } catch {
      internal.gaps.push({ platform, sourcePath: path, locator: path, reason: "authority extraction failed; inspect the committed source locally" });
    }
  }
  internal.sources.sort((a, b) => a.path.localeCompare(b.path));
  internal.atoms.sort((a, b) => a.semanticKey.localeCompare(b.semanticKey));
  internal.gaps.sort((a, b) => `${a.sourcePath}:${a.locator}`.localeCompare(`${b.sourcePath}:${b.locator}`));
  const safe2 = {
    ...internal,
    atoms: internal.atoms.map(publicAtom)
  };
  return { ...safe2, sha256: profileDigest(safe2) };
}
function discoverInternal(repo, ref) {
  const safe2 = discoverAuthorityProfile(repo, ref);
  const internal = {
    schemaVersion: safe2.schemaVersion,
    scope: safe2.scope,
    ref: safe2.ref,
    sources: [...safe2.sources],
    atoms: [],
    gaps: [...safe2.gaps]
  };
  for (const source of safe2.sources) {
    try {
      const raw = readGitFile(repo, ref, source.path);
      const value = record(parseConfig(raw, source.format));
      if (!value) continue;
      internal.atoms.push(...source.platform === "claude-code" ? extractClaude(source.path, value) : source.platform === "codex" ? extractCodex(source.path, value) : extractMcp(source.path, value));
    } catch {
    }
  }
  internal.atoms.sort((a, b) => a.semanticKey.localeCompare(b.semanticKey));
  return internal;
}
function dispositionForRelation(relation, before, after) {
  if (relation === "expansion") {
    if (after.kind === "model") return hold("AVP012", "the model binding became less deterministic");
    if (after.action === "mcp.connect" || after.action === "mcp.launch") return expansion("AVP002", "the MCP connection or launch identity became more permissive", "critical");
    if (after.action === "mcp.auto-enable" || after.action === "mcp.enable") return expansion("AVP003", "the MCP enablement boundary became more permissive", "critical");
    if (after.action === "mcp.tool") return expansion("AVP013", "the MCP tool selection became more permissive", "critical");
    if (after.action === "plugin.enable") return expansion("AVP015", "the plugin enablement boundary became more permissive", "critical");
    if (after.action === "hook.execute") return expansion("AVP011", "the repository-controlled hook changed authority or execution scope", "critical");
    if (after.action === "approval.mode" || after.action.startsWith("approval.")) return expansion("AVP004", "the approval boundary became less restrictive", "critical");
    if (after.action.startsWith("sandbox.")) return expansion("AVP005", "the sandbox boundary became less restrictive", "critical");
    if (after.action === "network.unix-socket-all") return expansion("AVP005", "the sandbox can access every host Unix socket", "critical");
    if (after.action === "network.bind-local") return expansion("AVP006", "the network boundary became less restrictive", "critical");
    if (after.effect === "network") return expansion("AVP006", "the network boundary became less restrictive", "critical");
    if (after.effect === "credential") return expansion("AVP008", "the credential boundary became less restrictive", "critical");
    if (after.action === "filesystem.access" || after.action === "filesystem.write") return expansion("AVP007", "the filesystem boundary became less restrictive", "critical");
    return expansion("AVP009", "the declared authority became more permissive");
  }
  if (relation === "contraction") return ALLOW_RESTRICTION;
  if (relation === "incomparable") return hold("AVP014", `the change from ${before.locator} to ${after.locator} is not ordered by the supported authority lattice`);
  return { ...ALLOW_RESTRICTION, direction: "NEUTRAL", reason: "the semantic authority is unchanged" };
}
function recognizedExpansionFromUnknown(before, after) {
  if (before.decision !== "UNKNOWN" || after.decision === "UNKNOWN") return void 0;
  if (after.added.disposition === "BLOCK") return after.added;
  if ((after.action === "approval.mode" || after.action === "approval.default") && after.decision === "ALLOW") {
    return dispositionForRelation("expansion", before, after);
  }
  return void 0;
}
function deltaSummary(change, atomValue) {
  const prefix = change === "ADDED" ? "added" : change === "REMOVED" ? "removed" : "changed";
  return `${prefix} ${atomValue.platform} ${atomValue.action} for ${atomValue.resource}`;
}
function makeDelta(change, disposition, before, after) {
  const representative = after ?? before;
  const beforeSafe = before ? publicAtom(before) : void 0;
  const afterSafe = after ? publicAtom(after) : void 0;
  const identity = canonical({ change, key: representative.semanticKey, before: beforeSafe, after: afterSafe, ruleId: disposition.ruleId });
  const identitySha256 = sha256(identity);
  return {
    id: `delta:${createHash8("sha256").update(identity).digest("hex").slice(0, 20)}`,
    ruleId: disposition.ruleId,
    change,
    direction: disposition.direction,
    disposition: disposition.disposition,
    severity: disposition.severity,
    summary: deltaSummary(change, representative),
    reason: disposition.reason,
    approvalKey: `authority:${disposition.ruleId}:${representative.platform}:${representative.action}:${representative.resource}@${identitySha256}`,
    ...beforeSafe ? { before: beforeSafe } : {},
    ...afterSafe ? { after: afterSafe } : {}
  };
}
function applyAuthorityPlanPolicy(delta, policy) {
  const exactApproval = policy.approvedAdditions.includes(delta.approvalKey);
  const values = [delta.before, delta.after];
  const explicitUnknown = values.some(
    (value) => value?.action === "authority.opaque" || value?.decision === "UNKNOWN" && value.kind !== "model"
  );
  const incidentalUnknown = delta.ruleId === "AVP001" && delta.change !== "CHANGED" && values.every((value) => !value || value.kind !== "model");
  const unknownSetting = explicitUnknown || incidentalUnknown;
  const unknownApproval = delta.disposition === "HOLD" && policy.allowUnknownChanges && unknownSetting;
  if (delta.disposition === "ALLOW" || !exactApproval && !unknownApproval) return delta;
  return {
    ...delta,
    disposition: "ALLOW",
    approvedByPolicy: true,
    reason: `${delta.reason}; approved by the trusted base revision policy`
  };
}
function buildAuthorityPlan(repo, base, head, _vigilVersion, policyPath) {
  const baseSha = git6(repo, ["rev-parse", "--verify", `${base}^{commit}`]).trim();
  const headSha = git6(repo, ["rev-parse", "--verify", `${head}^{commit}`]).trim();
  const policy = loadAuthorityPlanPolicy(repo, baseSha, policyPath);
  const before = discoverInternal(repo, baseSha);
  const after = discoverInternal(repo, headSha);
  const beforeByKey = new Map(before.atoms.map((item2) => [item2.semanticKey, item2]));
  const afterByKey = new Map(after.atoms.map((item2) => [item2.semanticKey, item2]));
  const keys = [.../* @__PURE__ */ new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const removedMcpServers = new Set(
    [...beforeByKey.entries()].filter(([key, item2]) => key.endsWith("\0enabled") && item2.action === "mcp.connect" && item2.decision === "ALLOW" && !afterByKey.has(key)).map(([key]) => key.slice(0, -"\0enabled".length))
  );
  const rawDeltas = [];
  const conditionActivity = (before2, after2) => {
    const representative = after2 ?? before2;
    const inferredSandboxParent = representative?.platform === "claude-code" && representative.locator !== "sandbox.enabled" && representative.locator.startsWith("sandbox.") ? `claude-code\0${representative.sourcePath}\0sandbox-enabled` : void 0;
    const conditionalOn = after2?.conditionalOn ?? before2?.conditionalOn ?? inferredSandboxParent;
    if (!conditionalOn) return { conditional: false, activeBefore: true, activeAfter: true };
    return {
      conditional: true,
      activeBefore: beforeByKey.get(conditionalOn)?.decision === "ALLOW",
      activeAfter: afterByKey.get(conditionalOn)?.decision === "ALLOW"
    };
  };
  const conditionActiveAcrossRevision = (before2, after2) => {
    const representative = after2 ?? before2;
    const { activeBefore, activeAfter } = conditionActivity(before2, after2);
    return activeBefore && activeAfter || activeAfter && representative?.action === "authority.opaque";
  };
  for (const key of keys) {
    const oldAtom = beforeByKey.get(key);
    const newAtom = afterByKey.get(key);
    if (!oldAtom && newAtom) {
      rawDeltas.push(makeDelta(
        "ADDED",
        conditionActiveAcrossRevision(void 0, newAtom) ? newAtom.added : ALLOW_RESTRICTION,
        void 0,
        newAtom
      ));
    } else if (oldAtom && !newAtom) {
      const removedWithServer = [...removedMcpServers].some((prefix) => key.startsWith(`${prefix}\0`));
      rawDeltas.push(makeDelta(
        "REMOVED",
        removedWithServer || !conditionActiveAcrossRevision(oldAtom) ? ALLOW_RESTRICTION : oldAtom.removed,
        oldAtom
      ));
    } else if (oldAtom && newAtom && oldAtom.comparisonToken !== newAtom.comparisonToken) {
      const relation = oldAtom.compare ? oldAtom.compare(oldAtom, newAtom) : newAtom.compare ? newAtom.compare(oldAtom, newAtom) : "incomparable";
      const recognizedExpansion = relation === "incomparable" ? recognizedExpansionFromUnknown(oldAtom, newAtom) : void 0;
      const disposition = recognizedExpansion ? recognizedExpansion : dispositionForRelation(relation, oldAtom, newAtom);
      rawDeltas.push(makeDelta(
        "CHANGED",
        conditionActiveAcrossRevision(oldAtom, newAtom) ? disposition : ALLOW_RESTRICTION,
        oldAtom,
        newAtom
      ));
    } else if (oldAtom && newAtom && newAtom.action === "authority.opaque") {
      const activity = conditionActivity(oldAtom, newAtom);
      if (activity.conditional && !activity.activeBefore && activity.activeAfter) {
        rawDeltas.push(makeDelta("CHANGED", newAtom.added, oldAtom, newAtom));
      }
    }
  }
  const deltas = rawDeltas.map((delta) => applyAuthorityPlanPolicy(delta, policy.value));
  const gaps = [...before.gaps, ...after.gaps].filter((gap, index, all) => all.findIndex((item2) => canonical(item2) === canonical(gap)) === index).sort((a, b) => `${a.sourcePath}:${a.locator}`.localeCompare(`${b.sourcePath}:${b.locator}`));
  const blocking = deltas.filter((item2) => item2.disposition === "BLOCK").length;
  const uncertainties = rawDeltas.filter((item2) => item2.disposition === "HOLD").length + gaps.length;
  const holds = deltas.filter((item2) => item2.disposition === "HOLD").length + (policy.value.allowUnknownChanges ? 0 : gaps.length);
  const status = blocking ? "BLOCK" : holds ? "HOLD" : "PASS";
  const baseProfile = {
    schemaVersion: before.schemaVersion,
    scope: before.scope,
    ref: before.ref,
    sources: before.sources,
    atoms: before.atoms.map(publicAtom),
    gaps: before.gaps
  };
  const headProfile = {
    schemaVersion: after.schemaVersion,
    scope: after.scope,
    ref: after.ref,
    sources: after.sources,
    atoms: after.atoms.map(publicAtom),
    gaps: after.gaps
  };
  const payload = {
    schemaVersion: "agent-vigil-authority-plan/v1",
    scope: "repository-declared",
    base: baseSha,
    head: headSha,
    status,
    policy: {
      source: policy.source,
      sha256: policy.sha256,
      allowUnknownChanges: policy.value.allowUnknownChanges
    },
    summary: {
      sources: new Set([...before.sources, ...after.sources].map((source) => source.path)).size,
      atomsBefore: before.atoms.length,
      atomsAfter: after.atoms.length,
      changes: deltas.length,
      expansions: deltas.filter((item2) => item2.direction === "EXPANSION").length,
      contractions: deltas.filter((item2) => item2.direction === "CONTRACTION").length,
      incomparable: deltas.filter((item2) => item2.direction === "INCOMPARABLE").length,
      blocking,
      holds,
      uncertainties,
      approved: deltas.filter((item2) => item2.approvedByPolicy).length
    },
    deltas,
    gaps,
    baseProfileSha256: profileDigest(baseProfile),
    headProfileSha256: profileDigest(headProfile),
    limitations: [
      "This plan covers authority declared in supported files committed to the selected Git revisions.",
      "Machine, user, managed, runtime, credential-provider, and live MCP tool state are not claimed unless separately captured.",
      "MCP server additions block because static launch configuration does not prove the server's complete live tool surface or behavior.",
      "Recognized secret-bearing values and sensitive permission scopes are omitted; repository-controlled names and labels can still be sensitive."
    ]
  };
  return { ...payload, planSha256: sha256(canonical(payload)) };
}
function marker(delta) {
  if (delta.change === "ADDED") return "+";
  if (delta.change === "REMOVED") return "-";
  return "~";
}
function renderAuthorityPlanText(plan) {
  const lines = [
    `Agent authority plan: ${plan.status}`,
    `Scope: ${plan.scope}`,
    `Range: ${plan.base}..${plan.head}`,
    `Policy: ${plan.policy.source} (${plan.policy.sha256})`,
    `Digest: ${plan.planSha256}`,
    ""
  ];
  if (!plan.deltas.length) lines.push("  No semantic authority changes detected in supported repository configuration.", "");
  for (const delta of plan.deltas) {
    lines.push(`  ${marker(delta)} [${delta.disposition}] ${delta.summary}`);
    lines.push(`      ${delta.ruleId}: ${delta.reason}`);
  }
  for (const gap of plan.gaps) {
    const disposition = plan.policy.allowUnknownChanges ? "ALLOW" : "HOLD";
    lines.push(`  ? [${disposition}] ${gap.platform} ${gap.sourcePath}:${gap.locator}`);
    lines.push(`      AVP001: ${gap.reason}${plan.policy.allowUnknownChanges ? "; allowed by the trusted base revision policy" : ""}`);
  }
  lines.push(
    "",
    `  ${plan.summary.changes} change(s) | ${plan.summary.expansions} expansion(s) | ${plan.summary.blocking} blocking | ${plan.summary.holds} hold(s) | ${plan.summary.approved} approved`,
    "  Boundary: repository-declared authority only; recognized secret-bearing values are omitted."
  );
  return lines.join("\n");
}
function renderAuthorityPlanMarkdown(plan) {
  const rows = plan.deltas.map(
    (delta) => `| ${delta.disposition} | \`${delta.ruleId}\` | ${delta.change} | ${delta.direction} | ${delta.summary.replace(/\|/g, "\\|")} | ${delta.reason.replace(/\|/g, "\\|")} |`
  );
  const gaps = plan.gaps.map(
    (gap) => `| ${plan.policy.allowUnknownChanges ? "ALLOW" : "HOLD"} | \`AVP001\` | GAP | INCOMPARABLE | ${gap.platform} ${gap.sourcePath}:${gap.locator} | ${(gap.reason + (plan.policy.allowUnknownChanges ? "; allowed by the trusted base revision policy" : "")).replace(/\|/g, "\\|")} |`
  );
  return [
    `# Agent authority plan: ${plan.status}`,
    "",
    `**Scope:** \`${plan.scope}\`  `,
    `**Range:** \`${plan.base}..${plan.head}\`  `,
    `**Policy:** \`${plan.policy.source}\` (\`${plan.policy.sha256}\`)  `,
    `**Digest:** \`${plan.planSha256}\``,
    "",
    "| Decision | Rule | Change | Direction | Authority | Reason |",
    "|---|---|---|---|---|---|",
    ...rows.length || gaps.length ? [...rows, ...gaps] : ["| PASS | `AVP000` | NONE | NEUTRAL | No supported semantic authority change | Supported repository configuration is unchanged |"],
    "",
    `${plan.summary.changes} change(s) | ${plan.summary.expansions} expansion(s) | ${plan.summary.blocking} blocking | ${plan.summary.holds} hold(s) | ${plan.summary.approved} approved`,
    "",
    "> This result covers repository-declared authority only. It does not claim machine, managed-policy, credential-provider, or live MCP state. Recognized secret-bearing values are omitted.",
    ""
  ].join("\n");
}
var renderAuthorityPlan = renderAuthorityPlanText;
function receiptRuleKind(delta) {
  const atom2 = delta.after ?? delta.before;
  if (!atom2) return "change";
  if (atom2.action === "mcp.connect" || atom2.action === "mcp.launch") return "server";
  if (atom2.action === "mcp.tool" || atom2.action.startsWith("permission.")) return "tool";
  if (atom2.action.startsWith("approval.")) return "approval";
  if (atom2.action.startsWith("sandbox.")) return "sandbox";
  if (atom2.action === "hook.execute") return "hook";
  if (atom2.kind === "model") return "model";
  if (atom2.effect === "network") return "network";
  if (atom2.effect === "credential") return "secret";
  if (atom2.action.startsWith("filesystem.") || atom2.resource.startsWith("unix:")) return "filesystem";
  return atom2.kind;
}
function receiptSubject(delta, kind) {
  const atom2 = delta.after ?? delta.before;
  if (!atom2) return delta.summary;
  if (kind === "server") {
    const name = atom2.action === "mcp.connect" ? atom2.resource.split(":", 1)[0] : atom2.subject;
    return `server: mcp:${name}`;
  }
  return `${kind}: ${atom2.resource}`;
}
function authorityPlanChecks(plan) {
  const results = [{
    claim: {
      kind: "authority_scope",
      subject: "agent authority configuration",
      quote: "the exact change does not expand unapproved agent authority"
    },
    verdict: plan.status === "BLOCK" ? "contradicted" : plan.status === "HOLD" ? "unverifiable" : "verified",
    evidence: `${plan.summary.changes} semantic change(s), ${plan.summary.blocking} blocking, ${plan.summary.holds} held, ${plan.summary.approved} approved; plan ${plan.planSha256}`,
    ruleId: "authority-plan",
    contributesToPass: false,
    ...plan.status === "HOLD" ? { blocksPass: true } : {}
  }];
  const advisories = [];
  for (const delta of plan.deltas) {
    const kind = receiptRuleKind(delta);
    const check = {
      claim: {
        kind: "authority_scope",
        subject: receiptSubject(delta, kind),
        quote: "semantic agent authority delta"
      },
      verdict: delta.disposition === "BLOCK" ? "contradicted" : delta.disposition === "HOLD" ? "unverifiable" : "verified",
      evidence: `${delta.ruleId}: ${delta.reason}; ${delta.approvalKey}`,
      ruleId: `authority-${kind}`,
      contributesToPass: false,
      ...delta.disposition === "HOLD" ? { blocksPass: true } : {}
    };
    if (delta.disposition === "ALLOW") advisories.push(check);
    else results.push(check);
    const atom2 = delta.after ?? delta.before;
    if (kind !== "network" && atom2?.effect === "network") {
      const networkCheck = {
        ...check,
        claim: { ...check.claim, subject: `network: ${atom2.resource}` },
        ruleId: "authority-network"
      };
      if (delta.disposition === "ALLOW") advisories.push(networkCheck);
      else results.push(networkCheck);
    }
  }
  for (const gap of plan.gaps) {
    const check = {
      claim: {
        kind: "authority_scope",
        subject: `unrecognized setting: ${gap.sourcePath}:${gap.locator}`,
        quote: "changed authority configuration is fully understood"
      },
      verdict: "unverifiable",
      evidence: gap.reason,
      ruleId: "avp001",
      contributesToPass: false,
      ...!plan.policy.allowUnknownChanges ? { blocksPass: true } : {}
    };
    if (plan.policy.allowUnknownChanges) advisories.push(check);
    else results.push(check);
  }
  return { results, advisories };
}

// src/merge-group.ts
function loadMergeGroupEvent(path) {
  const value = JSON.parse(readFileSync10(path, "utf8"));
  if (!value.merge_group?.base_sha || !value.merge_group?.head_sha) {
    throw new Error("event is not a merge_group payload with base_sha and head_sha");
  }
  return value;
}
function git7(repo, args) {
  try {
    return execFileSync9("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function result4(subject, verdict, evidence, ruleId, blocksPass = false) {
  return {
    claim: { kind: "integrity", quote: "GitHub merge queue verification", subject },
    verdict,
    evidence,
    ruleId,
    ...verdict === "verified" ? {} : { contributesToPass: false },
    ...blocksPass ? { blocksPass: true } : {}
  };
}
function buildMergeGroupReport(options) {
  const repo = resolve8(options.repo);
  const eventPath = resolve8(options.eventPath);
  const event = loadMergeGroupEvent(eventPath);
  if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) {
    throw new Error(`invalid git range ${options.base}..${options.head}`);
  }
  const base = resolveGitRef(repo, options.base);
  const head = resolveGitRef(repo, options.head);
  if (resolveGitRef(repo, event.merge_group.base_sha) !== base) {
    throw new Error(`event base ${event.merge_group.base_sha} does not match selected base ${base}`);
  }
  if (resolveGitRef(repo, event.merge_group.head_sha) !== head) {
    throw new Error(`event head ${event.merge_group.head_sha} does not match selected head ${head}`);
  }
  const policy = loadPolicy(repo, options.policy, options.policyRef);
  if (policy.ref && resolveGitRef(repo, policy.ref) !== base) {
    throw new Error(`merge-group policy-ref ${policy.ref} does not match event base ${base}`);
  }
  const eventHash = `sha256:${createHash9("sha256").update(readFileSync10(eventPath)).digest("hex")}`;
  const inputs = [eventPath, ...policy.path ? [policy.path] : []];
  const results = [];
  const advisories = [];
  results.push(result4(
    "merge-group event is bound to the selected commits",
    "verified",
    `GitHub event binds base ${base} and merge-group head ${head}`,
    "merge-group-binding"
  ));
  const ancestor = git7(repo, ["merge-base", "--is-ancestor", base, head]) !== void 0;
  results.push(result4(
    "merge-group head descends from its target base",
    ancestor ? "verified" : "contradicted",
    ancestor ? `${base} is an ancestor of ${head}` : `${base} is not an ancestor of ${head}`,
    "merge-group-range"
  ));
  results.push(...checkWorkspaceBinding(repo, head, inputs));
  const authorityPlan = authorityPlanChecks(buildAuthorityPlan(repo, base, head, VERSION));
  results.push(...authorityPlan.results);
  advisories.push(...authorityPlan.advisories);
  const testClaim = {
    kind: "tests_pass",
    quote: "trusted base policy verification passes on the composed merge-group commit",
    subject: "merge-group test command"
  };
  results.push(...checkTestsPass([testClaim], repo, policy.value.testCommand));
  results.push(...checkWorkspaceMutation(repo, inputs, head));
  const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
  results.push(...integrity.results);
  advisories.push(...integrity.advisories);
  const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative6(repo, policy.path) : void 0;
  const remote = git7(repo, ["config", "--get", "remote.origin.url"]);
  const tree = git7(repo, ["rev-parse", `${head}^{tree}`]);
  const eventName = relative6(repo, eventPath) || eventPath;
  const reproduction = [
    "vigil merge-group",
    "--event",
    `'${eventName.replace(/'/g, `'"'"'`)}'`,
    "--repo .",
    "--base",
    base,
    "--head",
    head,
    ...policy.gitPath ? ["--policy", `'${policy.gitPath}'`] : [],
    ...policy.ref ? ["--policy-ref", policy.ref] : []
  ].join(" ");
  return buildReport({
    transcript: eventName,
    transcriptSha256: eventHash,
    transcriptFormat: "github-merge-group-event",
    repo,
    base,
    head,
    results,
    advisories,
    policy: {
      minVerified: policy.value.minVerified ?? 1,
      strict: true,
      source: policySource,
      sha256: policy.sha256
    },
    repository: { ...remote ? { remote } : {}, ...tree ? { tree } : {} },
    reproduction
  });
}

// src/value.ts
import { createHash as createHash10 } from "node:crypto";
function nonNegative(value, name) {
  if (value !== void 0 && (!Number.isFinite(value) || value < 0)) throw new Error(`${name} must be a non-negative number`);
}
function validAsOf(value) {
  if (value === void 0) return;
  if (!Number.isFinite(new Date(value).getTime())) throw new Error("outcome as-of must be an RFC3339-compatible timestamp");
}
function cardPayload(card) {
  const { generatedAt: _generatedAt, ...evidence } = card;
  return canonical(evidence);
}
function recomputeValueCardHash(card) {
  const { cardHash: _cardHash, ...withoutHash } = card;
  return `sha256:${createHash10("sha256").update(cardPayload(withoutHash)).digest("hex")}`;
}
function buildValueCard(input) {
  nonNegative(input.values.budgetUsd, "budget USD");
  nonNegative(input.values.costUsd, "cost USD");
  nonNegative(input.values.reviewMinutes, "review minutes");
  validAsOf(input.values.outcomeAsOf);
  if (input.values.costUsd !== void 0 && !input.values.costSource) throw new Error("cost source is required when cost USD is provided");
  if (input.values.costSource && input.values.costUsd === void 0) throw new Error("cost USD is required when cost source is provided");
  if (input.values.costEvidenceSha256 && input.values.costUsd === void 0) throw new Error("cost USD is required when cost evidence is provided");
  if (input.values.reviewEvidenceSha256 && input.values.disposition === void 0 && input.values.reviewMinutes === void 0) {
    throw new Error("review evidence requires a disposition or review duration");
  }
  if (input.values.outcomeAsOf && (!input.values.outcome || input.values.outcome === "unknown")) {
    throw new Error("outcome as-of requires a known outcome");
  }
  if (input.values.outcomeEvidenceSha256 && (!input.values.outcome || input.values.outcome === "unknown")) {
    throw new Error("outcome evidence requires a known outcome");
  }
  const disposition = input.values.disposition ?? "unreviewed";
  const outcome = input.values.outcome ?? "unknown";
  const negative = input.report.summary.status === "FAIL" || disposition === "dismissed" || outcome === "reverted" || outcome === "hotfixed" || outcome === "incident-linked";
  const accepted = disposition === "accepted" || outcome === "merged";
  const acceptedEvidence = disposition === "accepted" && input.values.reviewEvidenceSha256 !== void 0 || outcome === "merged" && input.values.outcomeEvidenceSha256 !== void 0;
  const positive = input.report.summary.status === "PASS" && accepted && acceptedEvidence && input.values.costEvidenceSha256 !== void 0;
  const valueVerdict = negative ? "NEGATIVE" : positive ? "POSITIVE" : "INCONCLUSIVE";
  const gaps = [];
  if (input.report.summary.status === "INCONCLUSIVE") gaps.push("verification receipt is INCONCLUSIVE");
  if (!input.usage) gaps.push("transcript contains no supported token-usage evidence");
  else if (!input.usage.modelIds.length) gaps.push("agent model identity is unavailable");
  if (input.values.costUsd === void 0) gaps.push("task cost is unavailable");
  else if (!input.values.costEvidenceSha256) gaps.push("task cost is self-asserted without hashed billing evidence");
  if (disposition === "unreviewed") gaps.push("maintainer disposition is unreviewed");
  else if (!input.values.reviewEvidenceSha256) gaps.push("maintainer disposition is self-asserted without hashed review evidence");
  if (input.values.reviewMinutes === void 0) gaps.push("human review time is unavailable");
  if (outcome === "unknown") gaps.push("downstream change outcome is unknown");
  else if (!input.values.outcomeEvidenceSha256) gaps.push("downstream change outcome is self-asserted without hashed outcome evidence");
  const budgetStatus = input.values.budgetUsd === void 0 || input.values.costUsd === void 0 ? "UNAVAILABLE" : input.values.costUsd <= input.values.budgetUsd ? "WITHIN" : "EXCEEDED";
  const signature = input.signatureValid === true ? input.keyPinned ? "VALID_PINNED" : "VALID_SELF_ASSERTED" : "UNSIGNED";
  const costStatus = input.values.costUsd === void 0 ? "UNAVAILABLE" : input.values.costEvidenceSha256 ? "EVIDENCE_HASHED" : "SELF_ASSERTED";
  const metrics = {};
  if (input.report.summary.status === "PASS" && input.values.costUsd !== void 0) metrics.costPerVerifiedChangeUsd = input.values.costUsd;
  if (input.report.summary.status === "PASS" && accepted && input.values.costUsd !== void 0) metrics.costPerAcceptedChangeUsd = input.values.costUsd;
  if (input.report.summary.status === "PASS" && input.values.reviewMinutes !== void 0) metrics.reviewMinutesPerVerifiedChange = input.values.reviewMinutes;
  const withoutHash = {
    schemaVersion: "agent-vigil-value-card/v1",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    receipt: {
      receiptHash: input.report.receiptHash,
      hashValid: true,
      signature,
      verificationStatus: input.report.summary.status,
      base: input.report.base,
      head: input.report.head,
      transcriptSha256: input.report.transcriptSha256,
      transcriptFormat: input.report.transcriptFormat
    },
    task: {
      ...input.values.taskClass ? { taskClass: input.values.taskClass } : {},
      ...input.values.budgetUsd !== void 0 ? { budgetUsd: input.values.budgetUsd } : {},
      budgetStatus
    },
    agent: {
      adapter: input.report.transcriptFormat.replace(/^authority\//, ""),
      modelIds: input.usage?.modelIds ?? [],
      ...input.toolCalls !== void 0 ? { toolCalls: input.toolCalls } : {},
      ...input.failedToolCalls !== void 0 ? { failedToolCalls: input.failedToolCalls } : {}
    },
    usage: input.usage ?? { status: "UNAVAILABLE" },
    cost: {
      status: costStatus,
      ...input.values.costUsd !== void 0 ? { amountUsd: input.values.costUsd } : {},
      ...input.values.costSource ? { source: input.values.costSource } : {},
      ...input.values.costEvidenceSha256 ? { evidenceSha256: input.values.costEvidenceSha256 } : {}
    },
    human: {
      disposition,
      ...input.values.reviewMinutes !== void 0 ? { reviewMinutes: input.values.reviewMinutes } : {},
      evidence: disposition === "unreviewed" && input.values.reviewMinutes === void 0 ? "UNAVAILABLE" : input.values.reviewEvidenceSha256 ? "EVIDENCE_HASHED" : "SELF_ASSERTED",
      ...input.values.reviewEvidenceSha256 ? { evidenceSha256: input.values.reviewEvidenceSha256 } : {}
    },
    outcome: {
      state: outcome,
      ...input.values.outcomeAsOf ? { asOf: new Date(input.values.outcomeAsOf).toISOString() } : {},
      evidence: outcome === "unknown" ? "UNAVAILABLE" : input.values.outcomeEvidenceSha256 ? "EVIDENCE_HASHED" : "SELF_ASSERTED",
      ...input.values.outcomeEvidenceSha256 ? { evidenceSha256: input.values.outcomeEvidenceSha256 } : {}
    },
    ...input.values.github ? { github: input.values.github } : {},
    ...input.values.trajectory ? { trajectory: input.values.trajectory } : {},
    metrics,
    valueVerdict,
    gaps
  };
  const card = {
    ...withoutHash,
    cardHash: ""
  };
  card.cardHash = recomputeValueCardHash(card);
  return card;
}
function money(value) {
  return value === void 0 ? "unavailable" : `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}
function renderValueCardText(card) {
  const lines = [
    `Agent Vigil Value Card \xB7 ${card.valueVerdict}`,
    `  verification: ${card.receipt.verificationStatus} \xB7 ${card.receipt.signature}`,
    `  task:         ${card.task.taskClass ?? "unclassified"}`,
    `  agent:        ${card.agent.adapter}${card.agent.modelIds.length ? ` \xB7 ${card.agent.modelIds.join(", ")}` : " \xB7 model unknown"}`,
    `  cost:         ${money(card.cost.amountUsd)} \xB7 ${card.cost.status}${card.cost.source ? ` \xB7 ${card.cost.source}` : ""}`,
    `  budget:       ${money(card.task.budgetUsd)} \xB7 ${card.task.budgetStatus}`,
    `  disposition:  ${card.human.disposition}${card.human.reviewMinutes !== void 0 ? ` \xB7 ${card.human.reviewMinutes} review minute(s)` : ""}`,
    `  outcome:      ${card.outcome.state}${card.outcome.asOf ? ` \xB7 as of ${card.outcome.asOf}` : ""}`,
    `  tokens:       ${"status" in card.usage ? "unavailable" : `${card.usage.totalTokens.toLocaleString("en-US")} \xB7 ${card.usage.accounting}`}`,
    `  receipt:      ${card.receipt.receiptHash}`,
    `  card:         ${card.cardHash}`
  ];
  if (card.metrics.costPerAcceptedChangeUsd !== void 0) lines.push(`  value metric: ${money(card.metrics.costPerAcceptedChangeUsd)} per accepted verified change`);
  if (card.gaps.length) {
    lines.push("  evidence gaps:");
    for (const gap of card.gaps) lines.push(`    - ${gap}`);
  }
  return `${lines.join("\n")}
`;
}
function markdownCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
function renderValueCardMarkdown(card) {
  const rows = [
    ["Value verdict", card.valueVerdict],
    ["Verification", card.receipt.verificationStatus],
    ["Task class", card.task.taskClass ?? "unclassified"],
    ["Agent", `${card.agent.adapter}${card.agent.modelIds.length ? ` \xB7 ${card.agent.modelIds.join(", ")}` : " \xB7 model unknown"}`],
    ["Cost", `${money(card.cost.amountUsd)} \xB7 ${card.cost.status}`],
    ["Budget", `${money(card.task.budgetUsd)} \xB7 ${card.task.budgetStatus}`],
    ["Maintainer", `${card.human.disposition} \xB7 ${card.human.evidence}${card.human.reviewMinutes !== void 0 ? ` \xB7 ${card.human.reviewMinutes} minutes` : ""}`],
    ["Outcome", `${card.outcome.state} \xB7 ${card.outcome.evidence}`],
    ["Tokens", "status" in card.usage ? "unavailable" : card.usage.totalTokens.toLocaleString("en-US")]
  ];
  return [
    "# Agent Vigil Value Card",
    "",
    "| Evidence | Result |",
    "|---|---|",
    ...rows.map(([label, value]) => `| ${markdownCell(label)} | ${markdownCell(value)} |`),
    "",
    ...card.gaps.length ? ["## Evidence gaps", "", ...card.gaps.map((gap) => `- ${gap}`), ""] : [],
    `Receipt: \`${card.receipt.receiptHash}\``,
    "",
    `Card: \`${card.cardHash}\``,
    "",
    "Generated locally by [Agent Vigil](https://github.com/sulmusic2-star/agent-vigil).",
    ""
  ].join("\n");
}
function html(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function readableLabel(value) {
  const words = value.toLowerCase().replace(/[-_]+/g, " ");
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}`;
}
function renderValueCardHtml(card) {
  const statusClass = card.valueVerdict.toLowerCase();
  const verdict = readableLabel(card.valueVerdict);
  const tokenText = "status" in card.usage ? "Unavailable" : card.usage.totalTokens.toLocaleString("en-US");
  const gapItems = card.gaps.length ? card.gaps.map((gap) => `<li>${html(gap)}</li>`).join("") : "<li>None recorded</li>";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Vigil Value Card</title><style>
:root{--paper:#f3f0e8;--ink:#18202a;--muted:#5f6870;--rule:#c9c1b4;--accent:#2d5f73;--pass:#28734e;--fail:#a13d32;--warn:#8a611c;--display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--body:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;--code:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}*{box-sizing:border-box}html,body{overflow-x:clip}body{margin:0;padding:44px 20px;background:var(--paper);color:var(--ink);font:16px/1.55 var(--body)}.wrap{max-width:920px;margin:auto}.kicker{color:var(--accent);font-weight:700}.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,.55fr);gap:32px;align-items:end;margin:14px 0 32px;padding-bottom:28px;border-bottom:1px solid var(--rule)}.verdict{margin:0;font:600 clamp(46px,8vw,76px)/1 var(--display);letter-spacing:-.025em}.summary{margin:0;color:var(--muted)}.positive{color:var(--pass)}.negative{color:var(--fail)}.inconclusive{color:var(--warn)}.records{margin:0}.record{display:grid;grid-template-columns:minmax(150px,.5fr) minmax(0,1fr);gap:24px;padding:18px 0;border-bottom:1px solid var(--rule)}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}dd strong{display:block;font:600 23px/1.2 var(--display)}dd span{display:block;margin-top:5px;color:var(--muted)}.section{margin-top:34px}.section h2{font:600 25px/1.2 var(--display)}.hash{font:12px/1.6 var(--code);overflow-wrap:anywhere}footer{margin-top:38px;padding-top:20px;border-top:1px solid var(--rule);color:var(--muted);font-size:13px}a{color:var(--accent)}@media(max-width:620px){.hero,.record{grid-template-columns:1fr;gap:8px}.hero{align-items:start}}
</style></head><body><main class="wrap">
<div class="kicker">Agent Vigil value record</div><section class="hero"><h1 class="verdict ${statusClass}">${html(verdict)}</h1><p class="summary">${html(card.receipt.verificationStatus)} verification<br>${html(card.task.taskClass ?? "Task class not recorded")}</p></section>
<dl class="records">
<div class="record"><dt>Agent</dt><dd><strong>${html(card.agent.adapter)}</strong><span>${html(card.agent.modelIds.join(", ") || "Model not recorded")}</span></dd></div>
<div class="record"><dt>Attributed cost</dt><dd><strong>${html(money(card.cost.amountUsd))}</strong><span>${html(readableLabel(card.cost.status))}</span></dd></div>
<div class="record"><dt>Budget</dt><dd><strong>${html(readableLabel(card.task.budgetStatus))}</strong><span>${html(money(card.task.budgetUsd))}</span></dd></div>
<div class="record"><dt>Maintainer decision</dt><dd><strong>${html(readableLabel(card.human.disposition))}</strong><span>${html(`${readableLabel(card.human.evidence)}${card.human.reviewMinutes === void 0 ? " \xB7 review time not recorded" : ` \xB7 ${card.human.reviewMinutes} review ${card.human.reviewMinutes === 1 ? "minute" : "minutes"}`}`)}</span></dd></div>
<div class="record"><dt>Later outcome</dt><dd><strong>${html(readableLabel(card.outcome.state))}</strong><span>${html(`${readableLabel(card.outcome.evidence)}${card.outcome.asOf ? ` \xB7 through ${card.outcome.asOf}` : " \xB7 date not recorded"}`)}</span></dd></div>
<div class="record"><dt>Observed tokens</dt><dd><strong>${html(tokenText)}</strong><span>${html("status" in card.usage ? "No supported usage record" : readableLabel(card.usage.accounting))}</span></dd></div>
</dl>
<section class="section"><h2>Evidence gaps</h2><ul>${gapItems}</ul></section>
<section class="section"><h2>Integrity</h2><p class="hash">Receipt ${html(card.receipt.receiptHash)}</p><p class="hash">Card ${html(card.cardHash)}</p></section>
<footer>Local evidence card generated by <a href="https://github.com/sulmusic2-star/agent-vigil">Agent Vigil</a>. A PASS receipt is not proof that code is bug-free, and missing cost or outcome evidence remains INCONCLUSIVE.</footer>
</main></body></html>
`;
}

// src/github-evidence.ts
import { createHash as createHash11 } from "node:crypto";
import { readFileSync as readFileSync11, statSync as statSync4 } from "node:fs";
import { basename as basename2, resolve as resolve9 } from "node:path";
var MAX_SOURCE_BYTES = 32 * 1024 * 1024;
function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return void 0;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : void 0;
}
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function durationSeconds(start, end) {
  const from = timestamp(start);
  const to = timestamp(end);
  if (!from || !to) return void 0;
  const duration = (new Date(to).getTime() - new Date(from).getTime()) / 1e3;
  return duration >= 0 ? duration : void 0;
}
function readSource(path, kind) {
  const absolute = resolve9(path);
  const bytes = statSync4(absolute).size;
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`GitHub ${kind} evidence is ${bytes} bytes; maximum is ${MAX_SOURCE_BYTES}`);
  const raw = readFileSync11(absolute);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`GitHub ${kind} evidence is not valid JSON: ${path}`);
  }
  return {
    value,
    source: { kind, file: basename2(path), bytes, sha256: `sha256:${createHash11("sha256").update(raw).digest("hex")}` }
  };
}
function pullObject(value) {
  return value?.pull_request && typeof value.pull_request === "object" ? value.pull_request : value;
}
function parsePull(value, event) {
  const pull = pullObject(value);
  const number = integer(pull?.number ?? event?.number ?? event?.pull_request?.number);
  if (number === void 0) return void 0;
  const state = pull?.state === "closed" ? "closed" : pull?.state === "open" ? "open" : void 0;
  if (!state) throw new Error("GitHub pull-request evidence state must be open or closed");
  return {
    number,
    state,
    merged: pull?.merged === true || Boolean(pull?.merged_at),
    ...typeof pull?.base?.sha === "string" ? { baseSha: pull.base.sha } : {},
    ...typeof pull?.head?.sha === "string" ? { headSha: pull.head.sha } : {},
    ...typeof pull?.merge_commit_sha === "string" ? { mergeCommitSha: pull.merge_commit_sha } : {},
    ...timestamp(pull?.created_at) ? { createdAt: timestamp(pull.created_at) } : {},
    ...timestamp(pull?.updated_at) ? { updatedAt: timestamp(pull.updated_at) } : {},
    ...timestamp(pull?.closed_at) ? { closedAt: timestamp(pull.closed_at) } : {},
    ...timestamp(pull?.merged_at) ? { mergedAt: timestamp(pull.merged_at) } : {}
  };
}
function parseReviews(value) {
  if (!Array.isArray(value)) throw new Error("GitHub reviews evidence must be an array");
  if (value.length > 1e4) throw new Error("GitHub reviews evidence contains more than 10000 records");
  const latest = /* @__PURE__ */ new Map();
  let anonymous = 0;
  for (const review of value) {
    const state = typeof review?.state === "string" ? review.state.toUpperCase() : "";
    if (!(/* @__PURE__ */ new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"])).has(state)) continue;
    const login = typeof review?.user?.login === "string" && review.user.login ? review.user.login.toLowerCase() : `anonymous-${anonymous++}`;
    const submittedAt = timestamp(review?.submitted_at);
    const previous = latest.get(login);
    if (!previous || !previous.submittedAt || submittedAt && submittedAt >= previous.submittedAt) latest.set(login, { state, ...submittedAt ? { submittedAt } : {} });
  }
  const states = [...latest.values()];
  const dates = states.map((item2) => item2.submittedAt).filter((item2) => Boolean(item2)).sort();
  return {
    records: value.length,
    reviewers: states.length,
    approved: states.filter((item2) => item2.state === "APPROVED").length,
    changesRequested: states.filter((item2) => item2.state === "CHANGES_REQUESTED").length,
    dismissed: states.filter((item2) => item2.state === "DISMISSED").length,
    commented: states.filter((item2) => item2.state === "COMMENTED").length,
    ...dates.length ? { latestSubmittedAt: dates.at(-1) } : {}
  };
}
function parseComments(value) {
  if (!Array.isArray(value)) throw new Error("GitHub review-comments evidence must be an array");
  if (value.length > 1e5) throw new Error("GitHub review-comments evidence contains more than 100000 records");
  return { records: value.length };
}
function parseActions(run2, jobsValue) {
  const jobs = jobsValue === void 0 ? [] : Array.isArray(jobsValue) ? jobsValue : Array.isArray(jobsValue?.jobs) ? jobsValue.jobs : void 0;
  if (jobs === void 0) throw new Error("GitHub actions-jobs evidence must be an array or an object with jobs");
  if (jobs.length > 1e4) throw new Error("GitHub actions-jobs evidence contains more than 10000 jobs");
  const jobDurations = jobs.map((job) => durationSeconds(job?.started_at, job?.completed_at)).filter((value) => typeof value === "number");
  const startedAt = timestamp(run2?.run_started_at ?? run2?.created_at);
  const completedAt = timestamp(run2?.updated_at);
  return {
    ...integer(run2?.id) !== void 0 ? { runId: integer(run2.id) } : {},
    ...integer(run2?.run_attempt) !== void 0 ? { attempt: integer(run2.run_attempt) } : {},
    ...typeof run2?.status === "string" ? { status: run2.status } : {},
    ...typeof run2?.conclusion === "string" ? { conclusion: run2.conclusion } : {},
    ...startedAt ? { startedAt } : {},
    ...completedAt ? { completedAt } : {},
    ...durationSeconds(startedAt, completedAt) !== void 0 ? { runDurationSeconds: durationSeconds(startedAt, completedAt) } : {},
    ...jobsValue !== void 0 ? {
      jobs: jobs.length,
      jobDurationSeconds: jobDurations.reduce((sum, value) => sum + value, 0),
      failedJobs: jobs.filter((job) => (/* @__PURE__ */ new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"])).has(String(job?.conclusion))).length
    } : {},
    billing: "UNAVAILABLE"
  };
}
function labelNames(value) {
  return Array.isArray(value?.labels) ? value.labels.map((label) => typeof label === "string" ? label : label?.name).filter((label) => typeof label === "string") : [];
}
function validateRevert(value) {
  if (typeof value?.sha !== "string" || !/^[0-9a-f]{40,64}$/i.test(value.sha) || typeof value?.commit !== "object") {
    throw new Error("GitHub revert evidence must be a commit object with a full SHA");
  }
  const message = typeof value.commit?.message === "string" ? value.commit.message : "";
  if (!/^Revert\b/im.test(message) && !/This reverts commit [0-9a-f]{7,40}/i.test(message)) {
    throw new Error("GitHub revert evidence commit message does not identify a revert");
  }
}
function validateHotfix(value) {
  const pull = parsePull(value);
  if (!pull?.merged || !labelNames(pullObject(value)).some((label) => /^(?:hotfix|emergency[- ]fix)$/i.test(label))) {
    throw new Error("GitHub hotfix evidence must be a merged pull request labeled hotfix or emergency-fix");
  }
}
function validateIncident(value) {
  if (integer(value?.number) === void 0 || !(/* @__PURE__ */ new Set(["open", "closed"])).has(value?.state) || value?.pull_request) {
    throw new Error("GitHub incident evidence must be an issue object");
  }
  if (!labelNames(value).some((label) => /^(?:incident|outage|sev[- ]?[0-9])/i.test(label))) {
    throw new Error("GitHub incident evidence must carry an incident, outage, or severity label");
  }
}
function payloadWithoutHash(bundle) {
  const { generatedAt: _generatedAt, ...evidence } = bundle;
  return canonical(evidence);
}
function recomputeGitHubEvidenceHash(bundle) {
  const { evidenceHash: _hash, ...withoutHash } = bundle;
  return `sha256:${createHash11("sha256").update(payloadWithoutHash(withoutHash)).digest("hex")}`;
}
function buildGitHubEvidence(inputs) {
  const sources = [];
  const loaded = /* @__PURE__ */ new Map();
  for (const [kind, path] of Object.entries(inputs)) {
    if (!path) continue;
    const item2 = readSource(path, kind);
    loaded.set(kind, item2.value);
    sources.push(item2.source);
  }
  const event = loaded.get("event");
  const repository2 = typeof event?.repository?.full_name === "string" ? event.repository.full_name : void 0;
  const pull = loaded.has("pull-request") ? parsePull(loaded.get("pull-request"), event) : parsePull(event, event);
  const reviews = loaded.has("reviews") ? parseReviews(loaded.get("reviews")) : void 0;
  const reviewComments = loaded.has("review-comments") ? parseComments(loaded.get("review-comments")) : void 0;
  const actions = loaded.has("actions-run") || loaded.has("actions-jobs") ? parseActions(loaded.get("actions-run") ?? {}, loaded.get("actions-jobs")) : void 0;
  if (loaded.has("revert-commit")) validateRevert(loaded.get("revert-commit"));
  if (loaded.has("hotfix-pull-request")) validateHotfix(loaded.get("hotfix-pull-request"));
  if (loaded.has("incident-issue")) validateIncident(loaded.get("incident-issue"));
  const markers = { revert: loaded.has("revert-commit"), hotfix: loaded.has("hotfix-pull-request"), incident: loaded.has("incident-issue") };
  const disposition = reviews?.changesRequested ? "changes-requested" : reviews?.approved || pull?.merged ? "accepted" : "unreviewed";
  const outcome = markers.incident ? "incident-linked" : markers.revert ? "reverted" : markers.hotfix ? "hotfixed" : pull?.merged ? "merged" : pull?.state === "closed" ? "closed" : "unknown";
  const dates = [
    markers.incident ? timestamp(loaded.get("incident-issue")?.updated_at ?? loaded.get("incident-issue")?.created_at) : void 0,
    markers.revert ? timestamp(loaded.get("revert-commit")?.commit?.committer?.date ?? loaded.get("revert-commit")?.commit?.author?.date) : void 0,
    markers.hotfix ? timestamp(pullObject(loaded.get("hotfix-pull-request"))?.merged_at ?? pullObject(loaded.get("hotfix-pull-request"))?.closed_at) : void 0,
    pull?.mergedAt,
    pull?.closedAt
  ].filter((item2) => Boolean(item2)).sort();
  const withoutHash = {
    schemaVersion: "agent-vigil-github-evidence/v1",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ...repository2 ? { repository: repository2 } : {},
    ...pull ? { pullRequest: pull } : {},
    ...reviews ? { reviews } : {},
    ...reviewComments ? { reviewComments } : {},
    ...actions ? { actions } : {},
    markers,
    inference: {
      disposition,
      outcome,
      ...dates.length ? { outcomeAsOf: dates.at(-1) } : {},
      reviewEvidence: reviews || pull?.merged ? "EVIDENCE_HASHED" : "UNAVAILABLE",
      outcomeEvidence: outcome !== "unknown" ? "EVIDENCE_HASHED" : "UNAVAILABLE"
    },
    sources: sources.sort((left, right) => left.kind.localeCompare(right.kind))
  };
  const bundle = { ...withoutHash, evidenceHash: "" };
  bundle.evidenceHash = recomputeGitHubEvidenceHash(bundle);
  return bundle;
}
function loadGitHubEvidence(path) {
  const { value } = readSource(path, "event");
  const bundle = value;
  if (bundle?.schemaVersion !== "agent-vigil-github-evidence/v1" || typeof bundle.evidenceHash !== "string") throw new Error("GitHub evidence bundle schema is unsupported");
  if (recomputeGitHubEvidenceHash(bundle) !== bundle.evidenceHash) throw new Error("GitHub evidence bundle hash is invalid");
  return bundle;
}

// src/value-compare.ts
import { readFileSync as readFileSync12, statSync as statSync5 } from "node:fs";
import { resolve as resolve10 } from "node:path";
var MAX_CARD_BYTES = 8 * 1024 * 1024;
function validCard(value, path) {
  if (value?.schemaVersion !== "agent-vigil-value-card/v1") throw new Error(`${path} is not an Agent Value Card v1`);
  if (typeof value.cardHash !== "string" || typeof value.receipt?.receiptHash !== "string") throw new Error(`${path} lacks value-card integrity fields`);
  if (!(/* @__PURE__ */ new Set(["POSITIVE", "NEGATIVE", "INCONCLUSIVE"])).has(value.valueVerdict)) throw new Error(`${path} has an invalid value verdict`);
  if (recomputeValueCardHash(value) !== value.cardHash) throw new Error(`${path} value-card hash is invalid`);
  return value;
}
function loadValueCard(path) {
  const absolute = resolve10(path);
  const bytes = statSync5(absolute).size;
  if (bytes > MAX_CARD_BYTES) throw new Error(`${path} is ${bytes} bytes; maximum is ${MAX_CARD_BYTES}`);
  let value;
  try {
    value = JSON.parse(readFileSync12(absolute, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  return validCard(value, path);
}
function wilson95(successes, total) {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total <= 0 || successes > total) return void 0;
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin), confidence: 0.95 };
}
function median(values) {
  if (!values.length) return void 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function observationTime(card) {
  const value = card.outcome.asOf ?? card.generatedAt;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
function compareValueCards(cards, inputFiles = cards.length) {
  const byReceipt = /* @__PURE__ */ new Map();
  let supersededCards = 0;
  for (const card of cards) {
    validCard(card, "in-memory card");
    const key = card.receipt.receiptHash;
    const prior = byReceipt.get(key);
    if (!prior) byReceipt.set(key, card);
    else {
      supersededCards += 1;
      if (observationTime(card) > observationTime(prior) || observationTime(card) === observationTime(prior) && card.cardHash > prior.cardHash) byReceipt.set(key, card);
    }
  }
  const episodes = [...byReceipt.values()];
  const grouped = /* @__PURE__ */ new Map();
  for (const card of episodes) {
    const taskClass = card.task.taskClass ?? "unclassified";
    const models = card.agent.modelIds.length ? card.agent.modelIds.join(",") : "model-unknown";
    const key = JSON.stringify([taskClass, card.agent.adapter, models]);
    grouped.set(key, [...grouped.get(key) ?? [], card]);
  }
  const groups = [...grouped.entries()].map(([key, values]) => {
    const [taskClass, agent, modelText] = JSON.parse(key);
    const positive = values.filter((card) => card.valueVerdict === "POSITIVE").length;
    const negative = values.filter((card) => card.valueVerdict === "NEGATIVE").length;
    const conclusive = positive + negative;
    const hashedCosts = values.filter((card) => card.cost.status === "EVIDENCE_HASHED" && card.cost.amountUsd !== void 0);
    const observedHashedCostUsd = hashedCosts.reduce((sum, card) => sum + (card.cost.amountUsd ?? 0), 0);
    const reviewMinutes = values.map((card) => card.human.reviewMinutes).filter((value) => value !== void 0);
    return {
      taskClass,
      agent,
      models: modelText === "model-unknown" ? [] : modelText.split(","),
      episodes: values.length,
      positive,
      negative,
      inconclusive: values.length - conclusive,
      conclusive,
      ...conclusive ? { positiveRate: positive / conclusive, positiveRateWilson95: wilson95(positive, conclusive) } : {},
      hashedCostEpisodes: hashedCosts.length,
      costEvidenceCompleteness: values.length ? hashedCosts.length / values.length : 0,
      observedHashedCostUsd,
      ...hashedCosts.length === values.length && positive ? { costPerPositiveUsd: observedHashedCostUsd / positive } : {},
      accepted: values.filter((card) => card.human.disposition === "accepted" || card.outcome.state === "merged").length,
      revertedOrHotfixedOrIncident: values.filter((card) => (/* @__PURE__ */ new Set(["reverted", "hotfixed", "incident-linked"])).has(card.outcome.state)).length,
      reviewMinutesObserved: reviewMinutes.length,
      ...median(reviewMinutes) !== void 0 ? { medianReviewMinutes: median(reviewMinutes) } : {}
    };
  }).sort((left, right) => left.taskClass.localeCompare(right.taskClass) || left.agent.localeCompare(right.agent) || left.models.join().localeCompare(right.models.join()));
  const byTask = /* @__PURE__ */ new Map();
  for (const group of groups) byTask.set(group.taskClass, [...byTask.get(group.taskClass) ?? [], group]);
  const comparableTaskClasses = [...byTask.entries()].filter(([, values]) => values.length >= 2 && values.every((group) => group.episodes >= 5 && group.conclusive >= 5 && group.costEvidenceCompleteness >= 0.8)).map(([task]) => task).sort();
  const warnings = [];
  if (!episodes.length) warnings.push("no unique value episodes were supplied");
  if (!comparableTaskClasses.length) warnings.push("no task class has at least two agent groups with 5 episodes, 5 conclusive outcomes, and 80% hashed-cost completeness each");
  for (const group of groups) {
    const label = `${group.taskClass}/${group.agent}${group.models.length ? `/${group.models.join(",")}` : ""}`;
    if (group.episodes < 5) warnings.push(`${label}: only ${group.episodes} episode(s); do not rank this group`);
    if (group.costEvidenceCompleteness < 0.8) warnings.push(`${label}: hashed-cost completeness is ${(group.costEvidenceCompleteness * 100).toFixed(1)}%`);
    if (group.conclusive < group.episodes) warnings.push(`${label}: ${group.episodes - group.conclusive} episode(s) remain INCONCLUSIVE`);
  }
  return {
    schemaVersion: "agent-vigil-value-comparison/v1",
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    inputFiles,
    uniqueEpisodes: episodes.length,
    supersededCards,
    comparableTaskClasses,
    status: comparableTaskClasses.length ? "COMPARABLE" : "INCONCLUSIVE",
    groups,
    warnings
  };
}
function percent(value) {
  return value === void 0 ? "unavailable" : `${(value * 100).toFixed(1)}%`;
}
function renderValueComparisonText(comparison) {
  const lines = [
    `Agent Vigil Value Comparison \xB7 ${comparison.status}`,
    `  ${comparison.uniqueEpisodes} unique episode(s) \xB7 ${comparison.supersededCards} superseded card(s)`
  ];
  for (const group of comparison.groups) {
    const interval = group.positiveRateWilson95;
    lines.push("", `${group.taskClass} \xB7 ${group.agent}${group.models.length ? ` \xB7 ${group.models.join(", ")}` : ""}`);
    lines.push(`  n=${group.episodes} \xB7 positive=${group.positive} \xB7 negative=${group.negative} \xB7 inconclusive=${group.inconclusive}`);
    lines.push(`  positive rate: ${percent(group.positiveRate)}${interval ? ` \xB7 Wilson 95% ${percent(interval.lower)}\u2013${percent(interval.upper)}` : ""}`);
    lines.push(`  hashed cost: ${percent(group.costEvidenceCompleteness)} complete \xB7 $${group.observedHashedCostUsd.toFixed(2)} observed${group.costPerPositiveUsd !== void 0 ? ` \xB7 $${group.costPerPositiveUsd.toFixed(2)} per positive` : ""}`);
    lines.push(`  review time: ${group.medianReviewMinutes === void 0 ? "unavailable" : `${group.medianReviewMinutes.toFixed(1)} minute median`} \xB7 ${group.revertedOrHotfixedOrIncident} adverse downstream outcome(s)`);
  }
  if (comparison.warnings.length) {
    lines.push("", "Warnings:");
    for (const warning of comparison.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join("\n")}
`;
}
function html2(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function renderValueComparisonHtml(comparison) {
  const groups = comparison.groups.map((group) => {
    const interval = group.positiveRateWilson95;
    return `<article class="record"><header><p>${html2(group.taskClass)}</p><h2>${html2(group.agent)}</h2><p>${html2(group.models.join(", ") || "Model not recorded")}</p></header><dl><div><dt>Sample</dt><dd>${group.episodes} changes</dd></div><div><dt>Positive records</dt><dd>${html2(percent(group.positiveRate))}${interval ? ` <span>95% range ${html2(percent(interval.lower))}\u2013${html2(percent(interval.upper))}</span>` : ""}</dd></div><div><dt>Cost records</dt><dd>${html2(percent(group.costEvidenceCompleteness))} complete${group.costPerPositiveUsd !== void 0 ? ` <span>$${group.costPerPositiveUsd.toFixed(2)} per positive record</span>` : ""}</dd></div><div><dt>Later problems</dt><dd>${group.revertedOrHotfixedOrIncident}</dd></div></dl></article>`;
  }).join("");
  const warnings = comparison.warnings.length ? comparison.warnings.map((warning) => `<li>${html2(warning)}</li>`).join("") : "<li>None</li>";
  const heading = comparison.status === "COMPARABLE" ? "Comparable records" : "Not enough comparable records";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Vigil Value Comparison</title><style>:root{--paper:#f3f0e8;--ink:#18202a;--muted:#5f6870;--rule:#c9c1b4;--accent:#2d5f73;--warn:#8a611c;--display:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--body:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}*{box-sizing:border-box}html,body{overflow-x:clip}body{margin:0;padding:44px 20px;background:var(--paper);color:var(--ink);font:16px/1.55 var(--body)}.wrap{max-width:1040px;margin:auto}.kicker{color:var(--accent);font-weight:700}h1{max-width:760px;margin:10px 0 14px;font:600 clamp(44px,7vw,72px)/1 var(--display);letter-spacing:-.025em}.summary{max-width:68ch;color:var(--muted)}.records{margin-top:36px;border-top:1px solid var(--rule)}.record{display:grid;grid-template-columns:minmax(200px,.55fr) minmax(0,1fr);gap:36px;padding:28px 0;border-bottom:1px solid var(--rule)}.record header p{margin:0;color:var(--muted)}.record h2{margin:4px 0;font:600 28px/1.2 var(--display)}dl{margin:0}dl div{display:grid;grid-template-columns:minmax(130px,.45fr) minmax(0,1fr);gap:18px;padding:8px 0}dt{color:var(--muted)}dd{margin:0;font-weight:650}dd span{display:block;color:var(--muted);font-weight:400}.warnings{margin-top:36px;padding:22px 0;border-block:1px solid var(--rule)}.warnings h2{font:600 25px/1.2 var(--display)}.note{margin-top:28px;color:var(--muted);font-size:13px}a{color:var(--accent)}@media(max-width:680px){.record,dl div{grid-template-columns:1fr;gap:6px}}</style></head><body><main class="wrap"><div class="kicker">Agent Vigil value comparison</div><h1>${heading}</h1><p class="summary">${comparison.uniqueEpisodes} unique changes \xB7 ${comparison.supersededCards} replaced records \xB7 ${comparison.comparableTaskClasses.length} comparable task classes</p><section class="records">${groups}</section><section class="warnings"><h2>Limits and warnings</h2><ul>${warnings}</ul></section><p class="note">Generated locally by <a href="https://github.com/sulmusic2-star/agent-vigil">Agent Vigil</a>. The 95% ranges show sampling uncertainty. They do not remove task-selection bias or prove that an agent caused the outcome.</p></main></body></html>
`;
}

// src/attestation.ts
import { createHash as createHash12, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync as execFileSync10 } from "node:child_process";
import { readFileSync as readFileSync13, statSync as statSync6 } from "node:fs";
import { basename as basename3, resolve as resolve11 } from "node:path";
var ATTESTATION_PREDICATE_TYPE = "https://sulmusic2-star.github.io/agent-vigil/ai-change-receipt-predicate-v1.schema.json";
function sha2562(buffer) {
  return createHash12("sha256").update(buffer).digest("hex");
}
function fullGitHash(value) {
  return typeof value === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value);
}
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}
function evidenceCount(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function loadReceipt(path) {
  const absolute = resolve11(path);
  const metadata = statSync6(absolute);
  if (!metadata.isFile()) throw new Error("receipt must be a regular file");
  if (metadata.size > 16 * 1024 * 1024) throw new Error("receipt exceeds the 16 MB attestation limit");
  const bytes = readFileSync13(absolute);
  const report = JSON.parse(bytes.toString("utf8"));
  if (report.schemaVersion !== "2") throw new Error(`unsupported receipt schema: ${String(report.schemaVersion)}`);
  if (!(/* @__PURE__ */ new Set(["PASS", "FAIL", "INCONCLUSIVE"])).has(report.summary?.status)) throw new Error("receipt has an invalid status");
  if (!evidenceCount(report.summary?.verified) || !evidenceCount(report.summary?.contradicted) || !evidenceCount(report.summary?.unverifiable)) {
    throw new Error("receipt has invalid evidence counts");
  }
  if (!fullGitHash(report.base) || !fullGitHash(report.head)) throw new Error("attestation requires full base and head commit SHAs");
  if (!fullGitHash(report.repository?.tree)) throw new Error("attestation requires the exact committed Git tree");
  if (!/^sha256:[0-9a-f]{64}$/i.test(report.policy?.sha256)) throw new Error("attestation requires a SHA-256 policy digest");
  if (!/^sha256:[0-9a-f]{64}$/i.test(report.receiptHash)) throw new Error("receipt has an invalid receiptHash");
  if (recomputeReceiptHash(report) !== report.receiptHash) throw new Error("receipt content does not match receiptHash");
  return { report, bytes, fileSha256: sha2562(bytes) };
}
function buildAttestationPredicate(reportPath) {
  const { report, fileSha256 } = loadReceipt(reportPath);
  return {
    predicateVersion: "1",
    receipt: {
      schemaVersion: "2",
      receiptHash: report.receiptHash,
      fileSha256: `sha256:${fileSha256}`,
      status: report.summary.status,
      base: report.base,
      head: report.head,
      tree: report.repository.tree,
      policySha256: report.policy.sha256,
      vigilVersion: report.vigilVersion,
      verified: report.summary.verified,
      contradicted: report.summary.contradicted,
      unresolved: report.summary.unverifiable
    },
    privacy: {
      sourceIncluded: false,
      transcriptIncluded: false,
      promptIncluded: false
    }
  };
}
function writeAttestationPredicate(reportPath, predicateOutput) {
  const predicate = buildAttestationPredicate(reportPath);
  writePrivateFileAtomic(resolve11(predicateOutput), `${JSON.stringify(predicate, null, 2)}
`);
  return predicate;
}
function statementsFromGh(value) {
  const roots = Array.isArray(value) ? value : [value];
  const statements = [];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const record7 = root;
    const verification2 = record7.verificationResult;
    const statement = verification2 && typeof verification2 === "object" ? verification2.statement : record7.statement ?? record7;
    if (statement && typeof statement === "object") statements.push(statement);
  }
  return statements;
}
function subjectMatches(statement, expectedName, expectedDigest) {
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  return subjects.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const subject = entry;
    const digest5 = subject.digest && typeof subject.digest === "object" ? subject.digest : {};
    const name = String(subject.name ?? "");
    return (name === expectedName || name.endsWith(`/${expectedName}`)) && digest5.sha256 === expectedDigest;
  });
}
function predicateMatches(predicate, report, fileSha256) {
  if (!predicate || typeof predicate !== "object") return false;
  const candidate = predicate;
  const receipt = candidate.receipt;
  const privacy = candidate.privacy;
  return candidate.predicateVersion === "1" && exactKeys(candidate, ["predicateVersion", "privacy", "receipt"]) && Boolean(receipt) && exactKeys(receipt, ["base", "contradicted", "fileSha256", "head", "policySha256", "receiptHash", "schemaVersion", "status", "tree", "unresolved", "verified", "vigilVersion"]) && Boolean(privacy) && exactKeys(privacy, ["promptIncluded", "sourceIncluded", "transcriptIncluded"]) && receipt?.schemaVersion === "2" && receipt.receiptHash === report.receiptHash && receipt.fileSha256 === `sha256:${fileSha256}` && receipt.status === report.summary.status && receipt.base === report.base && receipt.head === report.head && receipt.tree === report.repository.tree && receipt.policySha256 === report.policy.sha256 && receipt.vigilVersion === report.vigilVersion && receipt.verified === report.summary.verified && receipt.contradicted === report.summary.contradicted && receipt.unresolved === report.summary.unverifiable && privacy?.sourceIncluded === false && privacy.transcriptIncluded === false && privacy.promptIncluded === false;
}
function verifyGhAttestationOutput(reportPath, ghOutput) {
  const { report, fileSha256 } = loadReceipt(reportPath);
  const statements = statementsFromGh(ghOutput);
  let subjectDigestValid = false;
  let predicateValid = false;
  let matched;
  for (const statement of statements) {
    if (statement.predicateType !== ATTESTATION_PREDICATE_TYPE) continue;
    const subjectOk = subjectMatches(statement, basename3(reportPath), fileSha256);
    const predicateOk = predicateMatches(statement.predicate, report, fileSha256);
    subjectDigestValid ||= subjectOk;
    predicateValid ||= predicateOk;
    if (subjectOk && predicateOk) matched = statement.predicate;
  }
  const receiptHashValid = recomputeReceiptHash(report) === report.receiptHash;
  return {
    valid: receiptHashValid && subjectDigestValid && predicateValid && Boolean(matched),
    receiptHashValid,
    subjectDigestValid,
    predicateValid,
    statementCount: statements.length,
    ...matched ? { predicate: matched } : {}
  };
}
var runGitHubCli = (args) => execFileSync10("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function verifyGitHubAttestation(reportPath, repository2, trust = {}, executeGh = runGitHubCli) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository2)) throw new Error("repository must be owner/name");
  const signerWorkflow = trust.signerWorkflow ?? `${repository2}/.github/workflows/agent-vigil.yml`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/i.test(signerWorkflow)) {
    throw new Error("signer workflow must be owner/name/.github/workflows/file.yml");
  }
  const command = [
    "attestation",
    "verify",
    resolve11(reportPath),
    "--repo",
    repository2,
    "--predicate-type",
    ATTESTATION_PREDICATE_TYPE,
    "--signer-workflow",
    signerWorkflow,
    "--format",
    "json",
    ...!trust.allowSelfHosted ? ["--deny-self-hosted-runners"] : []
  ];
  let raw;
  try {
    raw = executeGh(command);
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    throw new Error(`GitHub attestation verification failed${detail ? `: ${detail}` : "; install and authenticate a current GitHub CLI"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GitHub CLI returned unreadable attestation JSON");
  }
  return verifyGhAttestationOutput(reportPath, parsed);
}
function buildNotaryCheck(reportPath, verification2, expectedHead, expectedPolicySha256) {
  const { report } = loadReceipt(reportPath);
  if (!fullGitHash(expectedHead)) throw new Error("notary expected head must be a full commit SHA");
  if (!/^sha256:[0-9a-f]{64}$/i.test(expectedPolicySha256)) throw new Error("notary expected policy must be sha256:<64 hex characters>");
  if (!verification2.valid) throw new Error("notary refused an invalid GitHub attestation");
  if (report.head !== expectedHead) throw new Error(`receipt head ${report.head} does not match expected head ${expectedHead}`);
  if (report.policy.sha256 !== expectedPolicySha256) throw new Error(`receipt policy ${report.policy.sha256} does not match trusted policy ${expectedPolicySha256}`);
  const conclusion = report.summary.status === "PASS" ? "success" : report.summary.status === "FAIL" ? "failure" : "action_required";
  const explanation = report.summary.status === "PASS" ? "The required evidence is present for this exact commit." : report.summary.status === "FAIL" ? "One or more required checks contradicted the change or its claims." : "The available evidence is not enough to approve this change.";
  return {
    name: "Agent Vigil verified",
    head_sha: expectedHead,
    status: "completed",
    conclusion,
    output: {
      title: `Agent Vigil: ${report.summary.status}`,
      summary: explanation,
      text: [
        explanation,
        "",
        `Receipt: ${report.receiptHash}`,
        `Policy: ${report.policy.sha256}`,
        `Evidence: ${report.summary.verified} verified, ${report.summary.contradicted} contradicted, ${report.summary.unverifiable} unresolved.`,
        `Attestation: ${ATTESTATION_PREDICATE_TYPE}`
      ].join("\n")
    }
  };
}

// src/upgrade/cli.ts
import { lstatSync as lstatSync9, realpathSync as realpathSync10, statSync as statSync9 } from "node:fs";
import { basename as basename7, dirname as dirname9, isAbsolute as isAbsolute8, relative as relative12, resolve as resolve18, sep as sep10 } from "node:path";

// src/upgrade/contracts.ts
import { lstatSync as lstatSync3, readFileSync as readFileSync14, realpathSync as realpathSync3 } from "node:fs";
import { dirname as dirname4, isAbsolute as isAbsolute4, join as join4, normalize as normalize4, relative as relative7, resolve as resolve12, sep as sep5, win32 as win323 } from "node:path";
var UPGRADE_CONFIG_SCHEMA = "agent-vigil-upgrade-config/v1";
var CANARY_SCHEMA = "agent-vigil-upgrade-canary/v1";
var PRIVATE_RECEIPT_SCHEMA = "agent-vigil-upgrade-receipt/v1";
var PUBLIC_ENTRY_SCHEMA = "agent-vigil-compatibility-entry/v1";
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
function exactKeys2(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}
function boundedString(value, label, maximum, pattern) {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} has an unsupported value`);
  return value;
}
function integer2(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}
function numberValue(value, label, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}
function safeRelativePath(value, label) {
  const path = boundedString(value, label, 512);
  if (isAbsolute4(path) || win323.isAbsolute(path) || path.includes("\\")) {
    throw new Error(`${label} must be a portable repository-relative path`);
  }
  const normalized = normalize4(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep5}`)) {
    throw new Error(`${label} must remain inside the selected repository`);
  }
  return path.split("/").join(sep5);
}
function fieldPath(value, label) {
  return boundedString(value, label, 128, /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
}
function imageDigest(value) {
  return boundedString(
    value,
    "runner.image",
    320,
    /^[A-Za-z0-9][A-Za-z0-9._/:~-]{0,246}@sha256:[0-9a-f]{64}$/
  );
}
function validateUpgradeConfig(input) {
  const root = object(input, "upgrade config");
  exactKeys2(root, ["schemaVersion", "component", "runner", "canaryDirectory", "canaries"], "upgrade config");
  if (root.schemaVersion !== UPGRADE_CONFIG_SCHEMA) {
    throw new Error(`upgrade config schemaVersion must be ${UPGRADE_CONFIG_SCHEMA}`);
  }
  const component = object(root.component, "component");
  exactKeys2(component, ["ecosystem", "name", "manifestPath", "identityField", "versionField", "capabilityFields"], "component");
  const capabilityFields = component.capabilityFields;
  if (!Array.isArray(capabilityFields) || capabilityFields.length > 32) {
    throw new Error("component.capabilityFields must be an array of at most 32 field paths");
  }
  const parsedCapabilities = capabilityFields.map((item2, index) => fieldPath(item2, `component.capabilityFields[${index}]`));
  if (new Set(parsedCapabilities).size !== parsedCapabilities.length) {
    throw new Error("component.capabilityFields must not contain duplicates");
  }
  const runner = object(root.runner, "runner");
  exactKeys2(runner, ["engine", "image", "trials", "memoryMiB", "cpus", "pids"], "runner");
  if (runner.engine !== "docker") throw new Error("runner.engine must be docker");
  if (!Array.isArray(root.canaries) || root.canaries.length < 1 || root.canaries.length > 32) {
    throw new Error("canaries must contain from 1 to 32 entries");
  }
  const canaries = root.canaries.map((item2, index) => {
    const canary = object(item2, `canaries[${index}]`);
    exactKeys2(canary, ["id", "publicId", "command", "timeoutSeconds"], `canaries[${index}]`);
    const id = boundedString(canary.id, `canaries[${index}].id`, 80, /^[a-z0-9][a-z0-9._-]*$/);
    const publicId = canary.publicId === void 0 ? void 0 : boundedString(canary.publicId, `canaries[${index}].publicId`, 80, /^[a-z0-9][a-z0-9._-]*$/);
    if (!Array.isArray(canary.command) || canary.command.length < 1 || canary.command.length > 32) {
      throw new Error(`canaries[${index}].command must contain from 1 to 32 argv strings`);
    }
    const command = canary.command.map((value, argumentIndex) => boundedString(value, `canaries[${index}].command[${argumentIndex}]`, 512));
    return {
      id,
      ...publicId ? { publicId } : {},
      command,
      timeoutSeconds: integer2(canary.timeoutSeconds, `canaries[${index}].timeoutSeconds`, 1, 300)
    };
  });
  if (new Set(canaries.map((canary) => canary.id)).size !== canaries.length) {
    throw new Error("canary IDs must be unique");
  }
  const publicIds = canaries.flatMap((canary) => canary.publicId ? [canary.publicId] : []);
  if (new Set(publicIds).size !== publicIds.length) throw new Error("canary public IDs must be unique");
  return {
    schemaVersion: UPGRADE_CONFIG_SCHEMA,
    component: {
      ecosystem: boundedString(component.ecosystem, "component.ecosystem", 80, /^[a-z0-9][a-z0-9._-]*$/),
      name: boundedString(component.name, "component.name", 160, /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/),
      manifestPath: safeRelativePath(component.manifestPath, "component.manifestPath"),
      identityField: fieldPath(component.identityField, "component.identityField"),
      versionField: fieldPath(component.versionField, "component.versionField"),
      capabilityFields: parsedCapabilities
    },
    runner: {
      engine: "docker",
      image: imageDigest(runner.image),
      trials: integer2(runner.trials, "runner.trials", 2, 5),
      memoryMiB: integer2(runner.memoryMiB, "runner.memoryMiB", 128, 4096),
      cpus: numberValue(runner.cpus, "runner.cpus", 0.25, 4),
      pids: integer2(runner.pids, "runner.pids", 16, 512)
    },
    canaryDirectory: safeRelativePath(root.canaryDirectory, "canaryDirectory"),
    canaries
  };
}
function readBoundedJson(path, maximumBytes, label) {
  const status = lstatSync3(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
  if (status.size > maximumBytes) throw new Error(`${label} is ${status.size} bytes; maximum is ${maximumBytes}`);
  return JSON.parse(readFileSync14(path, "utf8"));
}
function trustedRegularFileInside(repositoryPath, filePath, label) {
  const requestedRepository = resolve12(repositoryPath);
  const repositoryStatus = lstatSync3(requestedRepository);
  if (repositoryStatus.isSymbolicLink() || !repositoryStatus.isDirectory()) {
    throw new Error("repository must be a regular directory, not a symbolic link");
  }
  const repository2 = realpathSync3(requestedRepository);
  const requested = resolve12(filePath);
  const rel = relative7(requestedRepository, requested);
  if (rel === ".." || rel.startsWith(`..${sep5}`)) throw new Error(`${label} must remain inside the repository`);
  let current = requestedRepository;
  const parentRel = relative7(requestedRepository, dirname4(requested));
  for (const component of parentRel.split(sep5).filter(Boolean)) {
    current = join4(current, component);
    const status2 = lstatSync3(current);
    if (status2.isSymbolicLink() || !status2.isDirectory()) {
      throw new Error(`${label} and its parents must be regular entries without symbolic links`);
    }
  }
  const status = lstatSync3(requested);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular non-symbolic-link file`);
  }
  const canonical3 = realpathSync3(requested);
  const canonicalRel = relative7(repository2, canonical3);
  if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep5}`)) {
    throw new Error(`${label} resolved outside the repository`);
  }
  return canonical3;
}
function trustedDirectoryInside(repositoryPath, directoryPath, label) {
  const requestedRepository = resolve12(repositoryPath);
  const repositoryStatus = lstatSync3(requestedRepository);
  if (repositoryStatus.isSymbolicLink() || !repositoryStatus.isDirectory()) {
    throw new Error("repository must be a regular directory, not a symbolic link");
  }
  const repository2 = realpathSync3(requestedRepository);
  const requested = resolve12(directoryPath);
  const rel = relative7(requestedRepository, requested);
  if (rel === ".." || rel.startsWith(`..${sep5}`)) throw new Error(`${label} must remain inside the repository`);
  let current = requestedRepository;
  for (const component of rel.split(sep5).filter(Boolean)) {
    current = join4(current, component);
    const status = lstatSync3(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${label} and its parents must be regular directories without symbolic links`);
    }
  }
  const canonical3 = realpathSync3(requested);
  const canonicalRel = relative7(repository2, canonical3);
  if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep5}`)) {
    throw new Error(`${label} resolved outside the repository`);
  }
  return canonical3;
}
function loadUpgradeConfig(path) {
  return validateUpgradeConfig(readBoundedJson(path, 256 * 1024, "upgrade config"));
}
function validateCanaryDocument(input) {
  const root = object(input, "canary output");
  exactKeys2(root, ["schemaVersion", "outcome", "observations"], "canary output");
  if (root.schemaVersion !== CANARY_SCHEMA) throw new Error(`canary output schemaVersion must be ${CANARY_SCHEMA}`);
  if (root.outcome !== "PASS" && root.outcome !== "FAIL") throw new Error("canary output outcome must be PASS or FAIL");
  const observations = object(root.observations, "canary observations");
  if (Object.keys(observations).length < 1) throw new Error("canary observations must contain at least one field");
  if (Object.keys(observations).length > 64) throw new Error("canary observations contain more than 64 fields");
  const parsed = {};
  for (const [key, value] of Object.entries(observations)) {
    boundedString(key, "canary observation key", 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    if (value === null || typeof value === "boolean") parsed[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) parsed[key] = value;
    else if (typeof value === "string" && value.length <= 512 && !value.includes("\0")) parsed[key] = value;
    else throw new Error(`canary observation ${key} must be a bounded JSON primitive`);
  }
  return { schemaVersion: CANARY_SCHEMA, outcome: root.outcome, observations: parsed };
}

// src/upgrade/receipt.ts
import {
  createPrivateKey as createPrivateKey3,
  createPublicKey as createPublicKey3,
  createHash as createHash15,
  randomBytes as randomBytes3,
  sign as sign3,
  verify as verify3
} from "node:crypto";
import { lstatSync as lstatSync5, readFileSync as readFileSync16, realpathSync as realpathSync6 } from "node:fs";
import { dirname as dirname6, isAbsolute as isAbsolute6, relative as relative9, resolve as resolve14, sep as sep7 } from "node:path";

// src/upgrade/decision.ts
import { createHash as createHash13 } from "node:crypto";
import { closeSync as closeSync2, fstatSync as fstatSync2, lstatSync as lstatSync4, openSync as openSync2, readFileSync as readFileSync15, readSync, readdirSync, realpathSync as realpathSync4 } from "node:fs";
import { basename as basename4, dirname as dirname5, join as join5, relative as relative8, resolve as resolve13, sep as sep6 } from "node:path";
var MAX_FILES = 4096;
var MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
var MAX_ARTIFACT_FILE_BYTES = 32 * 1024 * 1024;
var MAX_TOTAL_BYTES = 256 * 1024 * 1024;
function hash(value) {
  return `sha256:${createHash13("sha256").update(value).digest("hex")}`;
}
function hashRegularFile(path, expected, maximumFileBytes, maximumRemainingBytes) {
  const descriptor = openSync2(path, "r");
  try {
    const before = fstatSync2(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size || before.mode !== expected.mode || before.mtimeNs !== expected.mtimeNs || before.ctimeNs !== expected.ctimeNs) {
      throw new Error("artifact entry changed while it was being opened for inventory");
    }
    if (before.size > BigInt(maximumFileBytes)) throw new Error(`target file exceeds ${maximumFileBytes} bytes`);
    if (before.size > BigInt(maximumRemainingBytes)) throw new Error(`target exceeds ${MAX_TOTAL_BYTES} total bytes`);
    const digest5 = createHash13("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0n;
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      total += BigInt(read);
      if (total > BigInt(maximumFileBytes)) throw new Error(`target file exceeds ${maximumFileBytes} bytes`);
      if (total > BigInt(maximumRemainingBytes)) throw new Error(`target exceeds ${MAX_TOTAL_BYTES} total bytes`);
      digest5.update(buffer.subarray(0, read));
    }
    const after = fstatSync2(descriptor, { bigint: true });
    const afterPath = lstatSync4(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || total !== after.size || after.dev !== afterPath.dev || after.ino !== afterPath.ino || after.size !== afterPath.size || after.mode !== afterPath.mode || afterPath.isSymbolicLink()) {
      throw new Error("artifact entry changed while it was being inventoried");
    }
    return {
      bytes: Number(total),
      mode: Number(before.mode & 0o777n),
      sha256: `sha256:${digest5.digest("hex")}`
    };
  } finally {
    closeSync2(descriptor);
  }
}
function lookup(root, field) {
  let value = root;
  for (const segment of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
    value = value[segment];
  }
  return value;
}
function capabilityCount(value) {
  if (value === void 0 || value === null) return 0;
  if (Array.isArray(value)) return value.length;
  if (typeof value === "object") return Object.keys(value).length;
  return 1;
}
function safeFile(root, path) {
  const target = resolve13(root, path);
  const rel = relative8(root, target);
  if (rel === ".." || rel.startsWith(`..${sep6}`)) throw new Error("manifest escaped the target directory");
  const status = lstatSync4(target);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("manifest must be a regular non-symbolic-link file");
  if (status.size > MAX_MANIFEST_BYTES) throw new Error(`manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  const parent = realpathSync4(dirname5(target));
  if (parent !== realpathSync4(root) && !parent.startsWith(`${realpathSync4(root)}${sep6}`)) {
    throw new Error("manifest parent escaped the target directory");
  }
  return target;
}
function inspectArtifactTree(root, hooks = {}) {
  const canonicalRoot = realpathSync4(root);
  if (!lstatSync4(canonicalRoot).isDirectory()) throw new Error("target must be a directory");
  const entries = [];
  let totalBytes = 0;
  const visit3 = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join5(directory, entry.name);
      const status = lstatSync4(path, { bigint: true });
      if (status.isSymbolicLink()) throw new Error(`target contains a symbolic link: ${relative8(canonicalRoot, path)}`);
      if (status.isDirectory()) {
        visit3(path);
        continue;
      }
      if (!status.isFile()) throw new Error(`target contains a non-regular entry: ${relative8(canonicalRoot, path)}`);
      if (status.size > BigInt(MAX_ARTIFACT_FILE_BYTES)) throw new Error(`target file exceeds ${MAX_ARTIFACT_FILE_BYTES} bytes: ${relative8(canonicalRoot, path)}`);
      if (entries.length >= MAX_FILES) throw new Error(`target contains more than ${MAX_FILES} files`);
      const rel = relative8(canonicalRoot, path).split(sep6).join("/");
      hooks.afterEntryLstat?.(path);
      const observed = hashRegularFile(
        path,
        status,
        MAX_ARTIFACT_FILE_BYTES,
        MAX_TOTAL_BYTES - totalBytes
      );
      totalBytes += observed.bytes;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`target exceeds ${MAX_TOTAL_BYTES} total bytes`);
      entries.push({
        path: rel,
        bytes: observed.bytes,
        mode: observed.mode,
        sha256: observed.sha256
      });
    }
  };
  visit3(canonicalRoot);
  return {
    treeSha256: hash(canonical(entries)),
    fileCount: entries.length,
    totalBytes
  };
}
function inspectTarget(directory, component) {
  const requestedStatus = lstatSync4(directory);
  if (requestedStatus.isSymbolicLink() || !requestedStatus.isDirectory()) {
    throw new Error("target must be a regular directory, not a symbolic link");
  }
  const root = realpathSync4(directory);
  const manifestPath = safeFile(root, component.manifestPath);
  const manifestBytes = readFileSync15(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error(`${basename4(component.manifestPath)} is not valid JSON`);
  }
  const name = lookup(manifest, component.identityField);
  const version = lookup(manifest, component.versionField);
  if (typeof name !== "string" || !name.length || name.length > 160) throw new Error("manifest identity is missing or unbounded");
  if (name !== component.name) throw new Error(`manifest identity ${name} does not match configured component ${component.name}`);
  if (typeof version !== "string" || !version.length || version.length > 128) throw new Error("manifest version is missing or unbounded");
  const capabilities = component.capabilityFields.map((field) => {
    const value = lookup(manifest, field);
    return {
      field,
      count: capabilityCount(value),
      sha256: hash(canonical({ present: value !== void 0, value: value ?? null }))
    };
  });
  return {
    ecosystem: component.ecosystem,
    name,
    version,
    ...inspectArtifactTree(root),
    manifestSha256: hash(manifestBytes),
    capabilities
  };
}
function aggregateTrials(trials) {
  if (!trials.length) return { state: "HOLD", trials: 0, stable: false, reason: "no canary trials ran" };
  if (trials.some((trial) => trial.state === "HOLD")) {
    return { state: "HOLD", trials: trials.length, stable: false, reason: "one or more canary trials were incomplete" };
  }
  const states = new Set(trials.map((trial) => trial.state));
  const observations = new Set(trials.map((trial) => trial.observationSha256));
  const counts = new Set(trials.map((trial) => trial.observationCount));
  if (states.size !== 1 || observations.size !== 1 || counts.size !== 1) {
    return { state: "HOLD", trials: trials.length, stable: false, reason: "repeated canary trials produced nondeterministic evidence" };
  }
  const first = trials[0];
  if (!first.observationCount || first.observationCount < 1) {
    return {
      state: "HOLD",
      trials: trials.length,
      stable: false,
      reason: "canary produced no bounded observations"
    };
  }
  return {
    state: first.state,
    observationSha256: first.observationSha256,
    observationCount: first.observationCount,
    trials: trials.length,
    stable: true,
    reason: first.state === "PASS" ? "repeated trials produced one stable observation" : "trusted canary consistently reported FAIL"
  };
}
function compareCanary(canary, commandSha256, currentTrials, candidateTrials) {
  const current = aggregateTrials(currentTrials);
  const candidate = aggregateTrials(candidateTrials);
  const comparable = current.stable && candidate.stable && current.state === "PASS" && candidate.state !== "HOLD" && (current.observationCount ?? 0) > 0 && (candidate.observationCount ?? 0) > 0;
  const changed = comparable && (candidate.state !== "PASS" || current.observationSha256 !== candidate.observationSha256 || current.observationCount !== candidate.observationCount);
  return {
    id: canary.id,
    ...canary.publicId ? { publicId: canary.publicId } : {},
    idSha256: hash(canary.id),
    commandSha256,
    current,
    candidate,
    changed,
    comparable
  };
}
function compareCapabilities(current, candidate) {
  return current.capabilities.map((item2, index) => ({
    field: item2.field,
    currentCount: item2.count,
    candidateCount: candidate.capabilities[index]?.count ?? 0,
    changed: item2.sha256 !== candidate.capabilities[index]?.sha256
  }));
}
function decideUpgrade(containment, current, candidate, canaries) {
  const reasons = [];
  const capabilities = compareCapabilities(current, candidate);
  if (containment.status !== "PASS" || !containment.localEndpoint) reasons.push("required containment controls were not established");
  if (current.name !== candidate.name || current.ecosystem !== candidate.ecosystem) reasons.push("current and candidate identities are not comparable");
  if (current.version === candidate.version) reasons.push("current and candidate versions are identical");
  if (current.treeSha256 === candidate.treeSha256) reasons.push("current and candidate artifact digests are identical");
  if (!canaries.length) reasons.push("at least one trusted canary is required");
  if (canaries.some((canary) => !canary.comparable)) reasons.push("one or more canaries lack a stable healthy baseline and complete candidate evidence");
  if (reasons.length) return { verdict: "HOLD", reasons, capabilities, canaries };
  const changes = capabilities.filter((item2) => item2.changed).length + canaries.filter((item2) => item2.changed).length;
  if (changes) {
    return {
      verdict: "CHANGED",
      reasons: [`${changes} material capability or canary observation change(s) were detected`],
      capabilities,
      canaries
    };
  }
  return {
    verdict: "SAFE",
    reasons: ["no material change was detected by these exact canaries under the recorded contained runner"],
    capabilities,
    canaries
  };
}

// src/upgrade/sandbox.ts
import { createHash as createHash14, randomBytes as randomBytes2 } from "node:crypto";
import { spawnSync as spawnSync3 } from "node:child_process";
import { accessSync, constants as constants2, realpathSync as realpathSync5, statSync as statSync7 } from "node:fs";
import { isAbsolute as isAbsolute5 } from "node:path";
var PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "ftp_proxy",
  "all_proxy",
  "no_proxy"
];
var RESOLVED_DOCKER_CLIENT = Symbol("resolved-docker-client");
var DOCKER_CONTROL_TIMEOUT_MS = 1e4;
var CONTAINMENT_PROBE_TIMEOUT_MS = 15e3;
var DOCKER_ENDPOINT_ENV = /* @__PURE__ */ new Set([
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY"
]);
function isDockerEndpointEnvironment(name) {
  return DOCKER_ENDPOINT_ENV.has(name.toUpperCase());
}
function trustedDockerLocations() {
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "C:\\Program Files\\Docker\\Docker\\resources\\docker.exe"
    ];
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/opt/homebrew/bin/docker",
      "/usr/local/bin/docker",
      "/usr/bin/docker"
    ];
  }
  return [
    "/usr/bin/docker",
    "/usr/local/bin/docker",
    "/snap/bin/docker"
  ];
}
function canonicalExecutable(path) {
  const canonicalPath = realpathSync5(path);
  if (!statSync7(canonicalPath).isFile()) throw new Error("Docker client must be a regular file");
  if (process.platform !== "win32") accessSync(canonicalPath, constants2.X_OK);
  return canonicalPath;
}
function sanitizedDockerEnvironment(source) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (!isDockerEndpointEnvironment(name) && value !== void 0) environment[name] = value;
  }
  return Object.freeze(environment);
}
function resolveDockerBinary(requested = "docker") {
  if (isAbsolute5(requested)) {
    try {
      return canonicalExecutable(requested);
    } catch {
      throw new Error("the explicitly selected Docker client is not an executable regular file");
    }
  }
  if (requested !== "docker" && requested !== "docker.exe") {
    throw new Error("Docker client must be an explicit absolute path");
  }
  for (const path of trustedDockerLocations()) {
    try {
      return canonicalExecutable(path);
    } catch {
    }
  }
  throw new Error("Docker client was not found at a fixed trusted platform location; pass --docker-bin with an absolute path");
}
function isLocalDockerEndpoint(endpoint, platform = process.platform) {
  if (endpoint.includes("\0") || /[\r\n]/.test(endpoint)) return false;
  if (endpoint.startsWith("unix:///")) {
    const path = endpoint.slice("unix://".length);
    return path.startsWith("/") && path.length > 1 && !/[?#]/.test(path);
  }
  if (platform === "win32") {
    return /^npipe:\/{4}\.\/pipe\/[A-Za-z0-9._-]+$/.test(endpoint);
  }
  return false;
}
function contextEndpoint(dockerBin, context) {
  const args = ["context", "inspect"];
  if (context) args.push(context);
  args.push("--format", "{{json .Endpoints.docker.Host}}");
  const inspected = spawnSync3(dockerBin, args, {
    encoding: "utf8",
    timeout: DOCKER_CONTROL_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    env: process.env
  });
  if (inspected.status !== 0 || inspected.error) {
    return { local: false, reason: "the selected Docker daemon endpoint could not be inspected" };
  }
  try {
    const endpoint = JSON.parse(inspected.stdout.trim());
    if (typeof endpoint !== "string" || !isLocalDockerEndpoint(endpoint)) {
      return {
        local: false,
        ...typeof endpoint === "string" ? { endpoint } : {},
        reason: "the selected Docker daemon endpoint is not a local unix or Windows named-pipe endpoint"
      };
    }
    return { local: true, endpoint, reason: "the selected Docker endpoint uses an accepted local transport shape" };
  } catch {
    return { local: false, reason: "the selected Docker daemon endpoint inspection returned malformed output" };
  }
}
function resolveDockerClient(dockerBin = "docker") {
  const executable = resolveDockerBinary(dockerBin);
  const selectedContext = process.env.DOCKER_CONTEXT?.trim();
  let daemon;
  if (selectedContext) daemon = contextEndpoint(executable, selectedContext);
  else {
    const selectedHost = process.env.DOCKER_HOST?.trim();
    if (selectedHost) {
      daemon = isLocalDockerEndpoint(selectedHost) ? { local: true, endpoint: selectedHost, reason: "DOCKER_HOST selects an accepted local Docker transport shape" } : { local: false, endpoint: selectedHost, reason: "DOCKER_HOST does not select a local unix or Windows named-pipe endpoint" };
    } else daemon = contextEndpoint(executable);
  }
  if (!daemon.local || !daemon.endpoint) throw new Error(daemon.reason);
  return Object.freeze({
    executable,
    endpoint: daemon.endpoint,
    env: sanitizedDockerEnvironment(process.env),
    [RESOLVED_DOCKER_CLIENT]: true
  });
}
function selectedDockerClient(selection) {
  if (typeof selection === "string") return resolveDockerClient(selection);
  if (selection[RESOLVED_DOCKER_CLIENT] !== true || !isLocalDockerEndpoint(selection.endpoint) || resolveDockerBinary(selection.executable) !== selection.executable || Object.keys(selection.env).some(isDockerEndpointEnvironment)) {
    throw new Error("resolved Docker client is not a validated local endpoint binding");
  }
  return selection;
}
function dockerArgs(client, args) {
  return ["--host", client.endpoint, ...args];
}
function dockerEnvironment(client, additions = {}) {
  const environment = { ...client.env, ...additions };
  for (const name of Object.keys(environment)) {
    if (isDockerEndpointEnvironment(name)) delete environment[name];
  }
  return environment;
}
function digest2(value) {
  return `sha256:${createHash14("sha256").update(value).digest("hex")}`;
}
function mountedPath(path, label) {
  const canonicalPath = realpathSync5(path);
  if (canonicalPath.includes(",") || canonicalPath.includes("\n") || canonicalPath.includes("\0")) {
    throw new Error(`${label} path cannot be represented safely as a Docker bind mount`);
  }
  return canonicalPath;
}
function dockerBaseArgs(config, targetDirectory, canaryDirectory, containerName2) {
  const target = mountedPath(targetDirectory, "target");
  const canaries = mountedPath(canaryDirectory, "canary directory");
  const hostUid = typeof process.getuid === "function" ? process.getuid() : 65532;
  const hostGid = typeof process.getgid === "function" ? process.getgid() : 65532;
  const containerUid = hostUid > 0 ? hostUid : 65532;
  const containerGid = hostGid > 0 ? hostGid : 65532;
  const args = [
    "run",
    "--name",
    containerName2,
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${config.runner.pids}`,
    `--memory=${config.runner.memoryMiB}m`,
    `--cpus=${config.runner.cpus}`,
    `--user=${containerUid}:${containerGid}`,
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m",
    "--workdir=/canaries",
    "--mount",
    `type=bind,src=${target},dst=/target,readonly`,
    "--mount",
    `type=bind,src=${canaries},dst=/canaries,readonly`
  ];
  for (const name of PROXY_NAMES) args.push("--env", `${name}=`);
  return args;
}
function imageDigest2(config) {
  return config.runner.image.slice(config.runner.image.lastIndexOf("@") + 1);
}
function containerName() {
  return `agent-vigil-upgrade-${randomBytes2(12).toString("hex")}`;
}
function forceRemoveAndVerify(client, name) {
  const removed = spawnSync3(client.executable, dockerArgs(
    client,
    ["container", "rm", "--force", "--volumes", name]
  ), {
    encoding: "utf8",
    timeout: DOCKER_CONTROL_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    env: dockerEnvironment(client)
  });
  if (removed.status !== 0 || removed.error) {
    return { absent: false, reason: "the named container could not be force-removed with attached volumes" };
  }
  const listed = spawnSync3(
    client.executable,
    dockerArgs(client, ["container", "ls", "--all", "--filter", `name=^/${name}$`, "--format", "{{.ID}}"]),
    {
      encoding: "utf8",
      timeout: DOCKER_CONTROL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      env: dockerEnvironment(client)
    }
  );
  if (listed.status !== 0 || listed.error) {
    return { absent: false, reason: "the named container absence check failed" };
  }
  if (listed.stdout.trim() === "") return { absent: true, reason: "the named container is absent" };
  return { absent: false, reason: "the named container could not be force-removed and verified absent" };
}
function dockerImagePresent(config, selection = "docker") {
  let client;
  try {
    client = selectedDockerClient(selection);
  } catch {
    return false;
  }
  const inspected = spawnSync3(
    client.executable,
    dockerArgs(client, ["image", "inspect", "--format", "{{json .RepoDigests}}", config.runner.image]),
    {
      encoding: "utf8",
      timeout: DOCKER_CONTROL_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      env: dockerEnvironment(client)
    }
  );
  if (inspected.status !== 0 || inspected.error || !inspected.stdout.trim()) return false;
  try {
    const values = JSON.parse(inspected.stdout);
    return Array.isArray(values) && values.some((value) => typeof value === "string" && value.endsWith(`@${imageDigest2(config)}`));
  } catch {
    return false;
  }
}
var PROBE_SCRIPT = String.raw`
const fs=require("node:fs"),net=require("node:net");
const out={targetReadOnly:false,rootReadOnly:false,inheritedSecretAbsent:process.env.VIGIL_UPGRADE_PROBE_SECRET===undefined,proxiesCleared:true,networkBlocked:false};
for(const n of ["HTTP_PROXY","HTTPS_PROXY","FTP_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","ftp_proxy","all_proxy","no_proxy"]){if((process.env[n]||"")!=="")out.proxiesCleared=false;}
try{fs.writeFileSync("/target/.agent-vigil-containment-probe","x");}catch{out.targetReadOnly=true;}
try{fs.writeFileSync("/.agent-vigil-containment-probe","x");}catch{out.rootReadOnly=true;}
let done=false; const finish=(blocked)=>{if(done)return;done=true;out.networkBlocked=blocked;process.stdout.write(JSON.stringify(out));};
const socket=net.connect({host:"1.1.1.1",port:53});
socket.setTimeout(600); socket.once("connect",()=>{socket.destroy();finish(false)}); socket.once("error",()=>finish(true)); socket.once("timeout",()=>{socket.destroy();finish(true)});
setTimeout(()=>finish(true),900);
`;
function probeContainment(config, targetDirectory, canaryDirectory, selection = "docker") {
  let client;
  try {
    client = selectedDockerClient(selection);
  } catch (error) {
    return {
      status: "HOLD",
      localEndpoint: false,
      imagePresent: false,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: error.message
    };
  }
  if (!dockerImagePresent(config, client)) {
    return {
      status: "HOLD",
      localEndpoint: true,
      imagePresent: false,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: "the exact-digest runner image is not present locally; Upgrade Guard never pulls during a check"
    };
  }
  const name = containerName();
  let args;
  try {
    args = dockerBaseArgs(config, targetDirectory, canaryDirectory, name);
  } catch (error) {
    return {
      status: "HOLD",
      localEndpoint: true,
      imagePresent: true,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: error.message
    };
  }
  args.push("--env", "VIGIL_TARGET=/target", config.runner.image, "node", "-e", PROBE_SCRIPT);
  const secret = randomBytes2(24).toString("hex");
  let result5;
  let cleanup;
  try {
    result5 = spawnSync3(client.executable, dockerArgs(client, args), {
      encoding: "utf8",
      timeout: CONTAINMENT_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024,
      env: dockerEnvironment(client, { VIGIL_UPGRADE_PROBE_SECRET: secret })
    });
  } finally {
    cleanup = forceRemoveAndVerify(client, name);
  }
  if (!cleanup.absent) {
    return {
      status: "HOLD",
      localEndpoint: true,
      imagePresent: true,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: cleanup.reason
    };
  }
  if (result5.status !== 0 || result5.error) {
    return {
      status: "HOLD",
      localEndpoint: true,
      imagePresent: true,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: result5.error ? "containment probe did not complete" : `containment probe exited ${result5.status ?? "without a status"}`
    };
  }
  try {
    const value = JSON.parse(result5.stdout);
    const networkBlocked = value.networkBlocked === true;
    const targetReadOnly = value.targetReadOnly === true;
    const rootReadOnly = value.rootReadOnly === true;
    const inheritedSecretAbsent = value.inheritedSecretAbsent === true;
    const proxiesCleared = value.proxiesCleared === true;
    const status = networkBlocked && targetReadOnly && rootReadOnly && inheritedSecretAbsent && proxiesCleared ? "PASS" : "HOLD";
    return {
      status,
      localEndpoint: true,
      imagePresent: true,
      networkBlocked,
      targetReadOnly,
      rootReadOnly,
      inheritedSecretAbsent,
      proxiesCleared,
      reason: status === "PASS" ? "network, target writes, root writes, inherited probe secret, and Docker client proxy injection were blocked" : "one or more required containment controls did not hold"
    };
  } catch {
    return {
      status: "HOLD",
      localEndpoint: true,
      imagePresent: true,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: "containment probe returned malformed output"
    };
  }
}
function runCanaryTrial(config, canary, targetDirectory, canaryDirectory, phase, selection = "docker") {
  let client;
  try {
    client = selectedDockerClient(selection);
  } catch (error) {
    return { state: "HOLD", reason: error.message };
  }
  const name = containerName();
  let args;
  try {
    args = dockerBaseArgs(config, targetDirectory, canaryDirectory, name);
  } catch (error) {
    return { state: "HOLD", reason: error.message };
  }
  args.push(
    "--env",
    "VIGIL_TARGET=/target",
    "--env",
    `VIGIL_PHASE=${phase}`,
    config.runner.image,
    ...canary.command
  );
  let result5;
  let cleanup;
  try {
    result5 = spawnSync3(client.executable, dockerArgs(client, args), {
      encoding: "utf8",
      timeout: canary.timeoutSeconds * 1e3,
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024,
      env: dockerEnvironment(client)
    });
  } finally {
    cleanup = forceRemoveAndVerify(client, name);
  }
  if (!cleanup.absent) return { state: "HOLD", reason: cleanup.reason };
  if (result5.error) {
    const timeout = result5.error.code === "ETIMEDOUT";
    return { state: "HOLD", reason: timeout ? "canary timed out" : "container execution failed" };
  }
  if (result5.status !== 0) return { state: "HOLD", reason: `container exited ${result5.status ?? "without a status"}` };
  let document;
  try {
    document = validateCanaryDocument(JSON.parse(result5.stdout.trim()));
  } catch {
    return { state: "HOLD", reason: "canary returned malformed or unbounded JSON" };
  }
  const observationSha256 = digest2(canonical(document.observations));
  return {
    state: document.outcome,
    observationSha256,
    observationCount: Object.keys(document.observations).length,
    reason: document.outcome === "PASS" ? "canary completed with bounded observations" : "trusted canary reported FAIL"
  };
}
function commandDigest(canary) {
  return digest2(canonical(canary.command));
}

// src/upgrade/receipt.ts
var LIMITATIONS = [
  "The verdict applies only to the exact pre/post-stable artifacts, runner image, configuration, canary harness, and observations recorded here.",
  "SAFE means no material change was detected by these canaries; it is not a universal safety or semantic-correctness claim.",
  "The validated local-transport Docker endpoint, selected client, daemon/socket routing, host kernel, runner image, and trusted canary harness remain trust assumptions.",
  "Network-disabled offline canaries do not establish live provider, model-alias, authentication, or production behavior."
];
function hash2(value) {
  return `sha256:${createHash15("sha256").update(value).digest("hex")}`;
}
function publicCanaryPseudonym(receiptNonce, privateCanaryId) {
  return hash2(canonical({
    domain: "agent-vigil-public-canary-id/v1",
    receiptNonce,
    privateCanaryId
  }));
}
function configDigest(config) {
  return hash2(canonical(config));
}
function receiptPayload(receipt) {
  return canonical(receipt);
}
function finalizeReceipt(receipt) {
  return { ...receipt, receiptHash: hash2(receiptPayload(receipt)) };
}
function trustedDirectoryRoot(path, label) {
  const requested = resolve14(path);
  const status = lstatSync5(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a regular directory, not a symbolic link`);
  }
  return realpathSync6(requested);
}
function assertDisjointRoots(roots) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const [leftLabel, leftPath] = roots[left];
      const [rightLabel, rightPath] = roots[right];
      const leftToRight = relative9(leftPath, rightPath);
      const rightToLeft = relative9(rightPath, leftPath);
      const inside2 = (rel) => rel === "" || !isAbsolute6(rel) && rel !== ".." && !rel.startsWith(`..${sep7}`);
      const overlap = inside2(leftToRight) || inside2(rightToLeft);
      if (overlap) throw new Error(`${leftLabel} and ${rightLabel} must be separate, non-overlapping directories`);
    }
  }
}
function recomputeUpgradeReceiptHash(receipt) {
  const { receiptHash: _ignored, ...payload } = receipt;
  return hash2(receiptPayload(payload));
}
function unevaluatedContainment() {
  return {
    status: "HOLD",
    localEndpoint: false,
    imagePresent: false,
    networkBlocked: false,
    targetReadOnly: false,
    rootReadOnly: false,
    inheritedSecretAbsent: false,
    proxiesCleared: false,
    reason: "containment was not evaluated"
  };
}
function readConfigCheckpoint(repository2, requestedPath) {
  const path = trustedRegularFileInside(repository2, requestedPath, "upgrade config");
  const before = lstatSync5(path, { bigint: true });
  const config = loadUpgradeConfig(path);
  const after = lstatSync5(path, { bigint: true });
  const beforeIdentity = `${before.dev}:${before.ino}`;
  const afterIdentity = `${after.dev}:${after.ino}`;
  if (beforeIdentity !== afterIdentity) throw new Error("upgrade config moved or was replaced while it was being read");
  return { path, identity: afterIdentity, config };
}
function holdReceipt(config, containment, generatedAt, nonce, reason, current, candidate, canaryHarness) {
  return finalizeReceipt({
    schemaVersion: PRIVATE_RECEIPT_SCHEMA,
    vigilVersion: VERSION,
    generatedAt,
    nonce,
    component: { ecosystem: config.component.ecosystem, name: config.component.name },
    configSha256: configDigest(config),
    runner: {
      engine: "docker",
      image: config.runner.image,
      trials: config.runner.trials,
      network: "none",
      filesystem: "read-only",
      environment: "explicit"
    },
    containment,
    ...current ? { current } : {},
    ...candidate ? { candidate } : {},
    ...canaryHarness ? { canaryHarness } : {},
    capabilities: [],
    canaries: [],
    summary: {
      verdict: "HOLD",
      reasons: [reason],
      comparedCanaries: 0,
      changedCanaries: 0,
      changedCapabilities: 0
    },
    limitations: LIMITATIONS
  });
}
function runUpgradeEvaluation(input) {
  const generatedAt = input.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const nonce = input.nonce ?? randomBytes3(32).toString("base64url");
  const suppliedConfig = input.config ? validateUpgradeConfig(input.config) : void 0;
  let configCheckpoint;
  try {
    configCheckpoint = readConfigCheckpoint(input.repository, input.configPath);
  } catch (error) {
    if (!suppliedConfig) throw error;
    return holdReceipt(
      suppliedConfig,
      unevaluatedContainment(),
      generatedAt,
      nonce,
      `upgrade config could not be re-resolved and re-read at evaluation entry: ${error.message}`
    );
  }
  const config = configCheckpoint.config;
  if (suppliedConfig && canonical(suppliedConfig) !== canonical(config)) {
    return holdReceipt(
      suppliedConfig,
      unevaluatedContainment(),
      generatedAt,
      nonce,
      "upgrade config no longer matches the validated configuration supplied by the caller"
    );
  }
  let current;
  let candidate;
  let canaryHarness;
  const emptyContainment = unevaluatedContainment();
  let canaryDirectory;
  try {
    canaryDirectory = trustedDirectoryInside(
      input.repository,
      resolve14(input.repository, config.canaryDirectory),
      "canary directory"
    );
  } catch (error) {
    return holdReceipt(config, emptyContainment, generatedAt, nonce, `canary directory could not be trusted: ${error.message}`);
  }
  let currentRoot;
  let candidateRoot;
  try {
    currentRoot = trustedDirectoryRoot(input.currentDirectory, "current artifact");
    candidateRoot = trustedDirectoryRoot(input.candidateDirectory, "candidate artifact");
    assertDisjointRoots([
      ["current artifact", currentRoot],
      ["candidate artifact", candidateRoot],
      ["canary harness", canaryDirectory]
    ]);
  } catch (error) {
    return holdReceipt(config, emptyContainment, generatedAt, nonce, error.message);
  }
  try {
    canaryHarness = inspectArtifactTree(canaryDirectory);
  } catch (error) {
    return holdReceipt(config, emptyContainment, generatedAt, nonce, `canary harness could not be inventoried: ${error.message}`);
  }
  try {
    current = inspectTarget(input.currentDirectory, config.component);
  } catch (error) {
    return holdReceipt(config, emptyContainment, generatedAt, nonce, `current artifact could not be inspected: ${error.message}`, void 0, void 0, canaryHarness);
  }
  try {
    candidate = inspectTarget(input.candidateDirectory, config.component);
  } catch (error) {
    return holdReceipt(config, emptyContainment, generatedAt, nonce, `candidate artifact could not be inspected: ${error.message}`, current, void 0, canaryHarness);
  }
  let dockerClient;
  try {
    dockerClient = resolveDockerClient(input.dockerBin ?? "docker");
  } catch (error) {
    return holdReceipt(
      config,
      emptyContainment,
      generatedAt,
      nonce,
      `Docker client and local endpoint could not be bound for this evaluation: ${error.message}`,
      current,
      candidate,
      canaryHarness
    );
  }
  const containment = probeContainment(
    config,
    input.currentDirectory,
    canaryDirectory,
    dockerClient
  );
  const canaries = config.canaries.map((canary) => {
    const currentTrials = containment.status === "PASS" ? Array.from({ length: config.runner.trials }, () => runCanaryTrial(
      config,
      canary,
      input.currentDirectory,
      canaryDirectory,
      "current",
      dockerClient
    )) : [];
    const candidateTrials = containment.status === "PASS" ? Array.from({ length: config.runner.trials }, () => runCanaryTrial(
      config,
      canary,
      input.candidateDirectory,
      canaryDirectory,
      "candidate",
      dockerClient
    )) : [];
    return compareCanary(canary, commandDigest(canary), currentTrials, candidateTrials);
  });
  let mutationReason;
  try {
    const configAfter = readConfigCheckpoint(input.repository, input.configPath);
    if (configAfter.path !== configCheckpoint.path || configAfter.identity !== configCheckpoint.identity) {
      mutationReason = "upgrade config moved or was replaced while the evaluation was running";
    } else if (canonical(configAfter.config) !== canonical(config)) {
      mutationReason = "upgrade config changed while the evaluation was running";
    }
  } catch (error) {
    mutationReason = `upgrade config could not be re-resolved and re-read after evaluation: ${error.message}`;
  }
  try {
    const currentAfter = inspectTarget(input.currentDirectory, config.component);
    const candidateAfter = inspectTarget(input.candidateDirectory, config.component);
    const harnessAfter = inspectArtifactTree(canaryDirectory);
    if (!mutationReason && canonical(currentAfter) !== canonical(current)) mutationReason = "current artifact changed while the evaluation was running";
    else if (!mutationReason && canonical(candidateAfter) !== canonical(candidate)) mutationReason = "candidate artifact changed while the evaluation was running";
    else if (!mutationReason && canonical(harnessAfter) !== canonical(canaryHarness)) mutationReason = "canary harness changed while the evaluation was running";
  } catch (error) {
    if (!mutationReason) mutationReason = `evaluation inputs could not be re-inventoried: ${error.message}`;
  }
  const initialDecision = decideUpgrade(containment, current, candidate, canaries);
  const decision = mutationReason ? { ...initialDecision, verdict: "HOLD", reasons: [mutationReason] } : initialDecision;
  return finalizeReceipt({
    schemaVersion: PRIVATE_RECEIPT_SCHEMA,
    vigilVersion: VERSION,
    generatedAt,
    nonce,
    component: { ecosystem: config.component.ecosystem, name: config.component.name },
    configSha256: configDigest(config),
    runner: {
      engine: "docker",
      image: config.runner.image,
      trials: config.runner.trials,
      network: "none",
      filesystem: "read-only",
      environment: "explicit"
    },
    containment,
    current,
    candidate,
    canaryHarness,
    capabilities: decision.capabilities,
    canaries,
    summary: {
      verdict: decision.verdict,
      reasons: decision.reasons,
      comparedCanaries: canaries.filter((canary) => canary.comparable).length,
      changedCanaries: canaries.filter((canary) => canary.changed).length,
      changedCapabilities: decision.capabilities.filter((capability) => capability.changed).length
    },
    limitations: LIMITATIONS
  });
}
var PUBLIC_CAPABILITIES = /* @__PURE__ */ new Set(["tools", "hooks", "mcpServers", "permissions", "skills", "agents", "commands", "dependencies"]);
function publicCapability(field) {
  const leaf = field.split(".").at(-1) ?? "other";
  return PUBLIC_CAPABILITIES.has(leaf) ? leaf : "other";
}
function publicEntryPayload(entry) {
  return canonical(entry);
}
function createPublicCompatibilityEntry(receipt, privateKeyPath) {
  if (recomputeUpgradeReceiptHash(receipt) !== receipt.receiptHash) throw new Error("private upgrade receipt hash is invalid");
  if (!receipt.current || !receipt.candidate || !receipt.canaryHarness) {
    throw new Error("public compatibility output requires exact current, candidate, and canary harness identities");
  }
  const privateKey = createPrivateKey3(readFileSync16(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("public compatibility signing key must be Ed25519");
  const publicKey = createPublicKey3(privateKey);
  const der = publicKeyDer(publicKey);
  const unsigned = {
    schemaVersion: PUBLIC_ENTRY_SCHEMA,
    vigilVersion: receipt.vigilVersion,
    generatedAt: receipt.generatedAt,
    component: {
      ecosystem: receipt.current.ecosystem,
      name: receipt.current.name,
      currentVersion: receipt.current.version,
      candidateVersion: receipt.candidate.version,
      currentArtifactSha256: receipt.current.treeSha256,
      candidateArtifactSha256: receipt.candidate.treeSha256
    },
    runner: {
      imageDigest: receipt.runner.image.slice(receipt.runner.image.lastIndexOf("@") + 1),
      trials: receipt.runner.trials,
      localEndpoint: receipt.containment.localEndpoint,
      networkBlocked: receipt.containment.networkBlocked,
      readOnly: receipt.containment.targetReadOnly && receipt.containment.rootReadOnly,
      environmentIsolated: receipt.containment.inheritedSecretAbsent && receipt.containment.proxiesCleared,
      configSha256: receipt.configSha256,
      canaryHarnessSha256: receipt.canaryHarness.treeSha256
    },
    verdict: receipt.summary.verdict,
    changedCapabilities: [...new Set(receipt.capabilities.filter((item2) => item2.changed).map((item2) => publicCapability(item2.field)))].sort(),
    canaries: receipt.canaries.map((canary) => ({
      ...canary.publicId ? { publicId: canary.publicId } : {},
      idSha256: publicCanaryPseudonym(receipt.nonce, canary.id),
      current: canary.current.state,
      candidate: canary.candidate.state,
      matched: canary.comparable && !canary.changed
    })),
    privateReceiptCommitment: receipt.receiptHash,
    limitations: receipt.limitations
  };
  const entryHash = hash2(publicEntryPayload(unsigned));
  const entry = {
    ...unsigned,
    entryHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign3(null, Buffer.from(entryHash), privateKey).toString("base64")
    }
  };
  validatePublicCompatibilityEntry(entry);
  return entry;
}
function verifyPublicCompatibilityEntry(entry, publicKeyPath) {
  const { entryHash: _hash, signature: _signature, ...unsigned } = entry;
  const hashValid = hash2(publicEntryPayload(unsigned)) === entry.entryHash;
  if (entry.signature.algorithm !== "Ed25519") return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  try {
    const embedded = createPublicKey3({ key: Buffer.from(entry.signature.publicKey, "base64"), type: "spki", format: "der" });
    const embeddedId = signingKeyId(publicKeyDer(embedded));
    const selected = publicKeyPath ? createPublicKey3(readFileSync16(publicKeyPath)) : embedded;
    const selectedId = signingKeyId(publicKeyDer(selected));
    const signatureValid = embeddedId === entry.signature.keyId && selectedId === embeddedId && verify3(null, Buffer.from(entry.entryHash), selected, Buffer.from(entry.signature.value, "base64"));
    return { hashValid, signatureValid, keyPinned: Boolean(publicKeyPath), keyId: selectedId };
  } catch {
    return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  }
}
function record2(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exact(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}
function text(value, label, maximum = 512) {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}
function patternedText(value, label, pattern, maximum = 512) {
  const result5 = text(value, label, maximum);
  if (!pattern.test(result5)) throw new Error(`${label} has an unsupported value`);
  return result5;
}
function sha256Text(value, label) {
  return patternedText(value, label, /^sha256:[0-9a-f]{64}$/, 71);
}
function validatePublicCompatibilityEntry(input) {
  const root = record2(input, "public compatibility entry");
  exact(root, ["schemaVersion", "vigilVersion", "generatedAt", "component", "runner", "verdict", "changedCapabilities", "canaries", "privateReceiptCommitment", "limitations", "entryHash", "signature"], "public compatibility entry");
  if (root.schemaVersion !== PUBLIC_ENTRY_SCHEMA) throw new Error(`public entry schemaVersion must be ${PUBLIC_ENTRY_SCHEMA}`);
  if (!(/* @__PURE__ */ new Set(["SAFE", "CHANGED", "HOLD"])).has(String(root.verdict))) throw new Error("public entry verdict is invalid");
  const component = record2(root.component, "public entry component");
  exact(component, ["ecosystem", "name", "currentVersion", "candidateVersion", "currentArtifactSha256", "candidateArtifactSha256"], "public entry component");
  const runner = record2(root.runner, "public entry runner");
  exact(runner, ["imageDigest", "trials", "localEndpoint", "networkBlocked", "readOnly", "environmentIsolated", "configSha256", "canaryHarnessSha256"], "public entry runner");
  if (!Number.isInteger(runner.trials) || Number(runner.trials) < 2 || Number(runner.trials) > 5) throw new Error("public entry trials are invalid");
  for (const field of ["localEndpoint", "networkBlocked", "readOnly", "environmentIsolated"]) {
    if (typeof runner[field] !== "boolean") throw new Error(`public entry runner.${field} must be boolean`);
  }
  if (!Array.isArray(root.changedCapabilities) || root.changedCapabilities.length > 16 || root.changedCapabilities.some((item2) => typeof item2 !== "string" || !(/* @__PURE__ */ new Set([...PUBLIC_CAPABILITIES, "other"])).has(item2))) {
    throw new Error("public entry changedCapabilities are invalid");
  }
  if (new Set(root.changedCapabilities).size !== root.changedCapabilities.length) throw new Error("public entry changedCapabilities contain duplicates");
  if (!Array.isArray(root.canaries) || root.canaries.length > 32) throw new Error("public entry canaries are invalid");
  const canaries = root.canaries.map((item2, index) => {
    const canary = record2(item2, `public entry canaries[${index}]`);
    exact(canary, ["publicId", "idSha256", "current", "candidate", "matched"], `public entry canaries[${index}]`);
    if (!(/* @__PURE__ */ new Set(["PASS", "FAIL", "HOLD"])).has(String(canary.current)) || !(/* @__PURE__ */ new Set(["PASS", "FAIL", "HOLD"])).has(String(canary.candidate))) {
      throw new Error(`public entry canaries[${index}] has an invalid state`);
    }
    if (typeof canary.matched !== "boolean") throw new Error(`public entry canaries[${index}].matched must be boolean`);
    return {
      ...canary.publicId === void 0 ? {} : { publicId: patternedText(canary.publicId, `public entry canaries[${index}].publicId`, /^[a-z0-9][a-z0-9._-]*$/, 80) },
      idSha256: sha256Text(canary.idSha256, `public entry canaries[${index}].idSha256`),
      current: canary.current,
      candidate: canary.candidate,
      matched: canary.matched
    };
  });
  const signature = record2(root.signature, "public entry signature");
  exact(signature, ["algorithm", "keyId", "publicKey", "value"], "public entry signature");
  if (signature.algorithm !== "Ed25519") throw new Error("public entry signature algorithm must be Ed25519");
  if (!Array.isArray(root.limitations) || root.limitations.length > 16 || root.limitations.some((item2) => typeof item2 !== "string" || item2.length > 1024)) {
    throw new Error("public entry limitations are invalid");
  }
  const generatedAt = text(root.generatedAt, "public entry generatedAt", 64);
  if (!Number.isFinite(Date.parse(generatedAt)) || new Date(generatedAt).toISOString() !== generatedAt) {
    throw new Error("public entry generatedAt must be an exact UTC ISO timestamp");
  }
  const entry = {
    schemaVersion: PUBLIC_ENTRY_SCHEMA,
    vigilVersion: patternedText(root.vigilVersion, "public entry vigilVersion", /^[0-9][0-9A-Za-z.+-]*$/, 40),
    generatedAt,
    component: {
      ecosystem: patternedText(component.ecosystem, "public entry component.ecosystem", /^[a-z0-9][a-z0-9._-]*$/, 80),
      name: patternedText(component.name, "public entry component.name", /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/, 160),
      currentVersion: text(component.currentVersion, "public entry currentVersion", 128),
      candidateVersion: text(component.candidateVersion, "public entry candidateVersion", 128),
      currentArtifactSha256: sha256Text(component.currentArtifactSha256, "public entry currentArtifactSha256"),
      candidateArtifactSha256: sha256Text(component.candidateArtifactSha256, "public entry candidateArtifactSha256")
    },
    runner: {
      imageDigest: sha256Text(runner.imageDigest, "public entry runner.imageDigest"),
      trials: Number(runner.trials),
      localEndpoint: runner.localEndpoint,
      networkBlocked: runner.networkBlocked,
      readOnly: runner.readOnly,
      environmentIsolated: runner.environmentIsolated,
      configSha256: sha256Text(runner.configSha256, "public entry runner.configSha256"),
      canaryHarnessSha256: sha256Text(runner.canaryHarnessSha256, "public entry runner.canaryHarnessSha256")
    },
    verdict: root.verdict,
    changedCapabilities: root.changedCapabilities,
    canaries,
    privateReceiptCommitment: sha256Text(root.privateReceiptCommitment, "public entry privateReceiptCommitment"),
    limitations: root.limitations,
    entryHash: sha256Text(root.entryHash, "public entry entryHash"),
    signature: {
      algorithm: "Ed25519",
      keyId: sha256Text(signature.keyId, "public entry signature.keyId"),
      publicKey: text(signature.publicKey, "public entry signature.publicKey", 512),
      value: text(signature.value, "public entry signature.value", 512)
    }
  };
  if (new Set(canaries.map((canary) => canary.idSha256)).size !== canaries.length) throw new Error("public entry canary pseudonyms contain duplicates");
  const publicIds = canaries.flatMap((canary) => canary.publicId ? [canary.publicId] : []);
  if (new Set(publicIds).size !== publicIds.length) throw new Error("public entry canary public IDs contain duplicates");
  if (entry.component.currentVersion === entry.component.candidateVersion || entry.component.currentArtifactSha256 === entry.component.candidateArtifactSha256) {
    throw new Error("public entry must compare distinct exact versions and artifacts");
  }
  if (entry.verdict === "SAFE") {
    if (!entry.runner.localEndpoint || !entry.runner.networkBlocked || !entry.runner.readOnly || !entry.runner.environmentIsolated || !entry.canaries.length || entry.changedCapabilities.length || entry.canaries.some((canary) => canary.current !== "PASS" || canary.candidate !== "PASS" || !canary.matched)) {
      throw new Error("SAFE public entry is inconsistent with its containment or canary evidence");
    }
  }
  return entry;
}
function renderUpgradeReceipt(receipt) {
  const safe2 = (value) => terminalSafe(value);
  const lines = [
    `Agent Vigil Upgrade Guard ${safe2(receipt.vigilVersion)}`,
    `  component: ${safe2(receipt.component.name)}`,
    `  versions:  ${safe2(receipt.current?.version ?? "unknown")} -> ${safe2(receipt.candidate?.version ?? "unknown")}`,
    `  runner:    ${safe2(receipt.runner.image)}`,
    `  canaries:  ${receipt.summary.comparedCanaries} comparable; ${receipt.summary.changedCanaries} changed`,
    `  surfaces:  ${receipt.summary.changedCapabilities} capability class change(s)`,
    `  ${safe2(receipt.summary.verdict)} \xB7 ${safe2(receipt.receiptHash)}`
  ];
  for (const reason of receipt.summary.reasons) lines.push(`  ${receipt.summary.verdict === "SAFE" ? "\u2713" : receipt.summary.verdict === "CHANGED" ? "!" : "?"} ${safe2(reason)}`);
  lines.push("  SAFE is bounded to these exact artifacts, canaries, and contained runner; it is not a universal safety claim.");
  return `${lines.join("\n")}
`;
}

// src/upgrade/network.ts
import {
  createHash as createHash16,
  createPrivateKey as createPrivateKey4,
  createPublicKey as createPublicKey4,
  sign as sign4,
  verify as verify4
} from "node:crypto";
import { readFileSync as readFileSync17 } from "node:fs";
var COMPATIBILITY_RESOLUTION_SCHEMA = "agent-vigil-compatibility-resolution/v1";
var COMPATIBILITY_REGISTRY_SCHEMA = "agent-vigil-compatibility-registry/v1";
var RESOLUTION_LIMITATIONS = [
  "The fixed entry restores the recorded baseline canary behavior; it does not prove universal correctness or that every user-visible regression was fixed.",
  "The relation is valid only for entries signed by the same pinned publisher and for identical baseline, runner, configuration, and canary-harness commitments."
];
function hash3(value) {
  return `sha256:${createHash16("sha256").update(value).digest("hex")}`;
}
function record3(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys3(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}
function text2(value, label, maximum = 512) {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}
function sha2563(value, label) {
  const result5 = text2(value, label, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(result5)) throw new Error(`${label} must be an exact SHA-256 commitment`);
  return result5;
}
function timestamp2(value, label) {
  const result5 = text2(value, label, 64);
  if (!Number.isFinite(Date.parse(result5)) || new Date(result5).toISOString() !== result5) {
    throw new Error(`${label} must be an exact UTC ISO timestamp`);
  }
  return result5;
}
function resolutionPayload(value) {
  return canonical(value);
}
function sameRunner(left, right) {
  return canonical(left.runner) === canonical(right.runner);
}
function assertFixedEntryIsLater(broken, fixed) {
  const brokenGeneratedAt = timestamp2(broken.generatedAt, "broken compatibility entry generatedAt");
  const fixedGeneratedAt = timestamp2(fixed.generatedAt, "fixed compatibility entry generatedAt");
  if (Date.parse(fixedGeneratedAt) <= Date.parse(brokenGeneratedAt)) {
    throw new Error("fixed compatibility entry must be generated strictly later than the broken compatibility entry");
  }
}
function createCompatibilityResolution(input) {
  const inputRecord = record3(input, "compatibility resolution input");
  exactKeys3(inputRecord, ["broken", "fixed", "privateKeyPath", "generatedAt"], "compatibility resolution input");
  const brokenVerification = verifyPublicCompatibilityEntry(input.broken);
  const fixedVerification = verifyPublicCompatibilityEntry(input.fixed);
  if (!brokenVerification.hashValid || brokenVerification.signatureValid !== true || !fixedVerification.hashValid || fixedVerification.signatureValid !== true) {
    throw new Error("resolution inputs must be valid signed compatibility entries");
  }
  if (input.broken.signature.keyId !== input.fixed.signature.keyId) {
    throw new Error("resolution inputs must share one publisher identity");
  }
  if (input.broken.verdict !== "CHANGED") throw new Error("broken entry must have verdict CHANGED");
  if (input.fixed.verdict !== "SAFE") throw new Error("fixed entry must have verdict SAFE");
  assertFixedEntryIsLater(input.broken, input.fixed);
  if (input.broken.component.ecosystem !== input.fixed.component.ecosystem || input.broken.component.name !== input.fixed.component.name) {
    throw new Error("resolution entries must describe the same component");
  }
  if (input.broken.component.currentVersion !== input.fixed.component.currentVersion || input.broken.component.currentArtifactSha256 !== input.fixed.component.currentArtifactSha256) {
    throw new Error("resolution entries must use the same exact baseline");
  }
  if (!sameRunner(input.broken, input.fixed)) {
    throw new Error("resolution entries must use the same exact runner, config, and canary harness");
  }
  if (input.broken.component.candidateVersion === input.fixed.component.candidateVersion || input.broken.component.candidateArtifactSha256 === input.fixed.component.candidateArtifactSha256) {
    throw new Error("fixed candidate must be distinct from the recorded broken candidate");
  }
  const privateKey = createPrivateKey4(readFileSync17(input.privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("resolution signing key must be Ed25519");
  const publicKey = createPublicKey4(privateKey);
  const der = publicKeyDer(publicKey);
  const keyId = signingKeyId(der);
  if (keyId !== input.broken.signature.keyId) {
    throw new Error("resolution signing key must match the compatibility-entry publisher");
  }
  const unsigned = {
    schemaVersion: COMPATIBILITY_RESOLUTION_SCHEMA,
    vigilVersion: VERSION,
    generatedAt: input.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    component: {
      ecosystem: input.broken.component.ecosystem,
      name: input.broken.component.name
    },
    broken: {
      entryHash: input.broken.entryHash,
      baselineVersion: input.broken.component.currentVersion,
      brokenVersion: input.broken.component.candidateVersion,
      brokenArtifactSha256: input.broken.component.candidateArtifactSha256
    },
    fixed: {
      entryHash: input.fixed.entryHash,
      baselineVersion: input.fixed.component.currentVersion,
      fixedVersion: input.fixed.component.candidateVersion,
      fixedArtifactSha256: input.fixed.component.candidateArtifactSha256
    },
    relation: "RESTORED_RECORDED_COMPATIBILITY",
    limitations: RESOLUTION_LIMITATIONS
  };
  const resolutionHash = hash3(resolutionPayload(unsigned));
  const value = {
    ...unsigned,
    resolutionHash,
    signature: {
      algorithm: "Ed25519",
      keyId,
      publicKey: der.toString("base64"),
      value: sign4(null, Buffer.from(resolutionHash), privateKey).toString("base64")
    }
  };
  return validateCompatibilityResolution(value);
}
function validateCompatibilityResolution(input) {
  const root = record3(input, "compatibility resolution");
  exactKeys3(root, ["schemaVersion", "vigilVersion", "generatedAt", "component", "broken", "fixed", "relation", "limitations", "resolutionHash", "signature"], "compatibility resolution");
  if (root.schemaVersion !== COMPATIBILITY_RESOLUTION_SCHEMA) throw new Error(`resolution schemaVersion must be ${COMPATIBILITY_RESOLUTION_SCHEMA}`);
  if (root.relation !== "RESTORED_RECORDED_COMPATIBILITY") throw new Error("compatibility resolution relation is invalid");
  const component = record3(root.component, "resolution component");
  exactKeys3(component, ["ecosystem", "name"], "resolution component");
  const broken = record3(root.broken, "resolution broken entry");
  exactKeys3(broken, ["entryHash", "baselineVersion", "brokenVersion", "brokenArtifactSha256"], "resolution broken entry");
  const fixed = record3(root.fixed, "resolution fixed entry");
  exactKeys3(fixed, ["entryHash", "baselineVersion", "fixedVersion", "fixedArtifactSha256"], "resolution fixed entry");
  const signature = record3(root.signature, "resolution signature");
  exactKeys3(signature, ["algorithm", "keyId", "publicKey", "value"], "resolution signature");
  if (signature.algorithm !== "Ed25519") throw new Error("resolution signature algorithm must be Ed25519");
  if (!Array.isArray(root.limitations) || root.limitations.length < 1 || root.limitations.length > 8 || root.limitations.some((item2) => typeof item2 !== "string" || !item2.length || item2.length > 1024)) {
    throw new Error("resolution limitations are invalid");
  }
  const value = {
    schemaVersion: COMPATIBILITY_RESOLUTION_SCHEMA,
    vigilVersion: text2(root.vigilVersion, "resolution vigilVersion", 40),
    generatedAt: timestamp2(root.generatedAt, "resolution generatedAt"),
    component: {
      ecosystem: text2(component.ecosystem, "resolution component ecosystem", 80),
      name: text2(component.name, "resolution component name", 160)
    },
    broken: {
      entryHash: sha2563(broken.entryHash, "resolution broken entryHash"),
      baselineVersion: text2(broken.baselineVersion, "resolution broken baselineVersion", 128),
      brokenVersion: text2(broken.brokenVersion, "resolution broken version", 128),
      brokenArtifactSha256: sha2563(broken.brokenArtifactSha256, "resolution broken artifact")
    },
    fixed: {
      entryHash: sha2563(fixed.entryHash, "resolution fixed entryHash"),
      baselineVersion: text2(fixed.baselineVersion, "resolution fixed baselineVersion", 128),
      fixedVersion: text2(fixed.fixedVersion, "resolution fixed version", 128),
      fixedArtifactSha256: sha2563(fixed.fixedArtifactSha256, "resolution fixed artifact")
    },
    relation: "RESTORED_RECORDED_COMPATIBILITY",
    limitations: root.limitations,
    resolutionHash: sha2563(root.resolutionHash, "resolution hash"),
    signature: {
      algorithm: "Ed25519",
      keyId: sha2563(signature.keyId, "resolution signature keyId"),
      publicKey: text2(signature.publicKey, "resolution signature publicKey", 512),
      value: text2(signature.value, "resolution signature value", 512)
    }
  };
  if (value.broken.baselineVersion !== value.fixed.baselineVersion) throw new Error("resolution baselines must match");
  if (value.broken.entryHash === value.fixed.entryHash || value.broken.brokenVersion === value.fixed.fixedVersion || value.broken.brokenArtifactSha256 === value.fixed.fixedArtifactSha256) {
    throw new Error("resolution fixed evidence must be distinct from broken evidence");
  }
  return value;
}
function verifyCompatibilityResolution(value, publicKeyPath) {
  const { resolutionHash: _hash, signature: _signature, ...unsigned } = value;
  const hashValid = hash3(resolutionPayload(unsigned)) === value.resolutionHash;
  try {
    const embedded = createPublicKey4({ key: Buffer.from(value.signature.publicKey, "base64"), type: "spki", format: "der" });
    const embeddedId = signingKeyId(publicKeyDer(embedded));
    const selected = publicKeyPath ? createPublicKey4(readFileSync17(publicKeyPath)) : embedded;
    const selectedId = signingKeyId(publicKeyDer(selected));
    const signatureValid = embeddedId === value.signature.keyId && selectedId === embeddedId && verify4(null, Buffer.from(value.resolutionHash), selected, Buffer.from(value.signature.value, "base64"));
    return { hashValid, signatureValid, keyPinned: Boolean(publicKeyPath), keyId: selectedId };
  } catch {
    return { hashValid, signatureValid: false, keyPinned: Boolean(publicKeyPath) };
  }
}
function registryPayload(value) {
  return canonical(value);
}
function createCompatibilityRegistry(entries, resolutions) {
  if (entries.length > 2048) throw new Error("registry accepts at most 2048 compatibility entries");
  if (resolutions.length > 2048) throw new Error("registry accepts at most 2048 resolution records");
  const orderedEntries = [...entries].sort((left, right) => left.entryHash.localeCompare(right.entryHash));
  const orderedResolutions = resolutions.map((resolution) => validateCompatibilityResolution(resolution)).sort((left, right) => left.resolutionHash.localeCompare(right.resolutionHash));
  if (new Set(orderedEntries.map((entry) => entry.entryHash)).size !== orderedEntries.length) throw new Error("registry contains duplicate compatibility entries");
  if (new Set(orderedResolutions.map((entry) => entry.resolutionHash)).size !== orderedResolutions.length) throw new Error("registry contains duplicate resolution records");
  const entryHashes = new Set(orderedEntries.map((entry) => entry.entryHash));
  const entriesByHash = new Map(orderedEntries.map((entry) => [entry.entryHash, entry]));
  for (const entry of orderedEntries) {
    const checked2 = verifyPublicCompatibilityEntry(entry);
    if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error("registry contains an invalid compatibility entry");
  }
  for (const resolution of orderedResolutions) {
    if (!entryHashes.has(resolution.broken.entryHash) || !entryHashes.has(resolution.fixed.entryHash)) {
      throw new Error("registry resolution references an entry that is not present");
    }
    const checked2 = verifyCompatibilityResolution(resolution);
    if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error("registry contains an invalid resolution record");
    const broken = entriesByHash.get(resolution.broken.entryHash);
    const fixed = entriesByHash.get(resolution.fixed.entryHash);
    assertFixedEntryIsLater(broken, fixed);
    if (broken.verdict !== "CHANGED" || fixed.verdict !== "SAFE" || broken.signature.keyId !== fixed.signature.keyId || broken.signature.keyId !== resolution.signature.keyId || broken.component.ecosystem !== resolution.component.ecosystem || fixed.component.ecosystem !== resolution.component.ecosystem || broken.component.name !== resolution.component.name || fixed.component.name !== resolution.component.name || broken.component.currentVersion !== resolution.broken.baselineVersion || fixed.component.currentVersion !== resolution.fixed.baselineVersion || broken.component.currentArtifactSha256 !== fixed.component.currentArtifactSha256 || broken.component.candidateVersion !== resolution.broken.brokenVersion || fixed.component.candidateVersion !== resolution.fixed.fixedVersion || broken.component.candidateArtifactSha256 !== resolution.broken.brokenArtifactSha256 || fixed.component.candidateArtifactSha256 !== resolution.fixed.fixedArtifactSha256 || !sameRunner(broken, fixed)) {
      throw new Error("registry resolution is inconsistent with its referenced exact-pair entries");
    }
  }
  const timestamps = [...orderedEntries.map((entry) => entry.generatedAt), ...orderedResolutions.map((item2) => item2.generatedAt)].sort();
  const value = {
    schemaVersion: COMPATIBILITY_REGISTRY_SCHEMA,
    generatedAt: timestamps.at(-1) ?? "1970-01-01T00:00:00.000Z",
    entries: orderedEntries,
    resolutions: orderedResolutions,
    summary: {
      entries: orderedEntries.length,
      safe: orderedEntries.filter((entry) => entry.verdict === "SAFE").length,
      changed: orderedEntries.filter((entry) => entry.verdict === "CHANGED").length,
      hold: orderedEntries.filter((entry) => entry.verdict === "HOLD").length,
      resolvedBreakages: orderedResolutions.length,
      components: new Set(orderedEntries.map((entry) => `${entry.component.ecosystem}:${entry.component.name}`)).size
    }
  };
  return { ...value, registryHash: hash3(registryPayload(value)) };
}
function renderMaintainerEvidence(entry) {
  const checked2 = verifyPublicCompatibilityEntry(entry);
  if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error("maintainer evidence requires a valid signed compatibility entry");
  const icon2 = entry.verdict === "SAFE" ? "\u2705" : entry.verdict === "CHANGED" ? "\u26A0\uFE0F" : "\u23F8\uFE0F";
  const observed = entry.verdict === "SAFE" ? "The recorded canaries produced matching PASS observations for the exact baseline and candidate artifacts." : entry.verdict === "CHANGED" ? "At least one recorded capability or canary observation changed for this exact version pair." : "The verifier withheld a compatibility ruling because required evidence or containment was incomplete.";
  const markdown = (value) => html3(value).replaceAll("|", "&#124;").replaceAll("`", "&#96;").replaceAll("\r", "\\u{000D}").replaceAll("\n", "\\u{000A}");
  const changed = entry.changedCapabilities.length ? entry.changedCapabilities.map(markdown).join(", ") : "none observed";
  return `## ${icon2} Agent update evidence: ${entry.verdict}

| Field | Bound evidence |
|---|---|
| Component | <code>${markdown(entry.component.name)}</code> (<code>${markdown(entry.component.ecosystem)}</code>) |
| Version pair | <code>${markdown(entry.component.currentVersion)}</code> \u2192 <code>${markdown(entry.component.candidateVersion)}</code> |
| Exact artifacts | <code>${markdown(entry.component.currentArtifactSha256)}</code> \u2192 <code>${markdown(entry.component.candidateArtifactSha256)}</code> |
| Canary agreement | ${entry.canaries.filter((canary) => canary.matched).length}/${entry.canaries.length} |
| Changed capability classes | ${changed} |
| Signed entry | <code>${markdown(entry.entryHash)}</code> |
| Publisher key | <code>${markdown(entry.signature.keyId)}</code> |

${observed}

### What this does not prove

${entry.limitations.map((item2) => `- ${markdown(item2)}`).join("\n")}

Verify locally with a pinned publisher key:

\`\`\`sh
vigil upgrade verify compatibility-entry.json --public-key publisher.pem
\`\`\`
`;
}
function html3(value) {
  return terminalSafe(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function shortHash(value) {
  return value.slice(7, 19);
}
function renderCompatibilityRegistryPage(registry) {
  const resolvedByBroken = new Map(registry.resolutions.map((resolution) => [resolution.broken.entryHash, resolution]));
  const rows = [...registry.entries].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt)).map((entry) => {
    const resolution = resolvedByBroken.get(entry.entryHash);
    const search = `${entry.component.name} ${entry.component.ecosystem} ${entry.component.currentVersion} ${entry.component.candidateVersion} ${entry.verdict} ${entry.changedCapabilities.join(" ")}`.toLowerCase();
    const anchor = `entry-${entry.entryHash.slice(7)}`;
    return `<tr data-proof-row data-search="${html3(search)}"><td><a href="#${anchor}"><strong>${html3(entry.component.name)}</strong></a><small>${html3(entry.component.ecosystem)}</small></td><td>${html3(entry.component.currentVersion)} \u2192 ${html3(entry.component.candidateVersion)}</td><td><span class="status ${entry.verdict.toLowerCase()}">${html3(entry.verdict)}</span>${resolution ? '<small class="restored">restored by a later verified pair</small>' : ""}</td><td>${entry.canaries.filter((canary) => canary.matched).length}/${entry.canaries.length}</td><td>${html3(entry.changedCapabilities.join(", ") || "none observed")}</td><td><code>${html3(shortHash(entry.entryHash))}</code></td></tr>`;
  }).join("\n");
  const details = [...registry.entries].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt)).map((entry) => {
    const resolution = resolvedByBroken.get(entry.entryHash);
    return `<article id="entry-${entry.entryHash.slice(7)}" class="proof"><header><div><small>${html3(entry.component.ecosystem)}</small><h2>${html3(entry.component.name)}</h2></div><span class="status ${entry.verdict.toLowerCase()}">${html3(entry.verdict)}</span></header><p><code>${html3(entry.component.currentVersion)}</code> \u2192 <code>${html3(entry.component.candidateVersion)}</code></p><dl><div><dt>Entry</dt><dd><code>${html3(entry.entryHash)}</code></dd></div><div><dt>Publisher</dt><dd><code>${html3(entry.signature.keyId)}</code></dd></div><div><dt>Runner</dt><dd><code>${html3(entry.runner.imageDigest)}</code></dd></div><div><dt>Canary harness</dt><dd><code>${html3(entry.runner.canaryHarnessSha256)}</code></dd></div></dl>${resolution ? `<p class="resolution">Recorded compatibility restored by <a href="#entry-${resolution.fixed.entryHash.slice(7)}">${html3(resolution.fixed.fixedVersion)}</a>.</p>` : ""}<details><summary>Bounded claim</summary><ul>${entry.limitations.map((item2) => `<li>${html3(item2)}</li>`).join("")}</ul></details></article>`;
  }).join("\n");
  const script = `(()=>{const q=document.querySelector('#proof-search');const rows=[...document.querySelectorAll('[data-proof-row]')];const count=document.querySelector('#visible-count');const apply=()=>{const value=q.value.trim().toLowerCase();let visible=0;for(const row of rows){const show=!value||row.dataset.search.includes(value);row.hidden=!show;if(show)visible++}count.textContent=String(visible)};q.addEventListener('input',apply);apply()})();`;
  const scriptHash = createHash16("sha256").update(script).digest("base64");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>Agent compatibility proof registry</title><style>:root{font-family:ui-sans-serif,system-ui,sans-serif;color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#e7eef8}main{max-width:1160px;margin:auto;padding:52px 24px}.eyebrow{color:#69e6a6;text-transform:uppercase;letter-spacing:.12em;font-weight:800}h1{font-size:clamp(2.2rem,6vw,4.8rem);letter-spacing:-.04em;line-height:1;margin:.25em 0}.lede{max-width:780px;color:#a9b8ca;font-size:1.1rem;line-height:1.65}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:30px 0}.card,.proof,.table{border:1px solid #293a50;background:#0d1a2b;border-radius:18px}.card{padding:18px}.card strong{display:block;font-size:2rem}.search{display:flex;gap:12px;align-items:center;margin:24px 0}.search input{width:100%;padding:14px 16px;border:1px solid #3a4d66;border-radius:12px;background:#07111f;color:#fff;font:inherit}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:820px}th,td{text-align:left;padding:14px;border-bottom:1px solid #223349}th{font-size:.75rem;color:#91a6be;text-transform:uppercase;letter-spacing:.08em}td small{display:block;color:#8197b0;margin-top:4px}a{color:#b9d8ff}.status{font-weight:900}.safe{color:#69e6a6}.changed{color:#ffcb6b}.hold{color:#ff8e9b}.restored{color:#69e6a6}.proofs{display:grid;gap:18px;margin-top:40px}.proof{padding:22px;scroll-margin-top:20px}.proof header{display:flex;justify-content:space-between;gap:20px}.proof h2{margin:.2em 0}.proof dl{display:grid;gap:8px}.proof dl div{display:grid;grid-template-columns:130px 1fr;gap:12px}.proof dt{color:#8fa4bc}.proof dd{margin:0;overflow-wrap:anywhere}.resolution{border-left:3px solid #69e6a6;padding-left:12px}footer{margin-top:32px;color:#8499b0}@media(max-width:720px){main{padding:32px 16px}.cards{grid-template-columns:1fr 1fr}.proof dl div{grid-template-columns:1fr}.search{align-items:stretch;flex-direction:column}}</style></head><body><main><p class="eyebrow">Signed exact-pair evidence</p><h1>Agent compatibility proof registry</h1><p class="lede">Search privacy-minimized results for exact agent, skill, plugin, and MCP update pairs. SAFE is bounded to the recorded contained run. CHANGED means review the evidence before updating. HOLD means the verifier abstained.</p><section class="cards" aria-label="Registry summary"><div class="card"><strong>${registry.summary.entries}</strong>proof entries</div><div class="card"><strong>${registry.summary.changed}</strong>changed</div><div class="card"><strong>${registry.summary.resolvedBreakages}</strong>restored</div><div class="card"><strong>${registry.summary.components}</strong>components</div></section><label class="search" for="proof-search"><span>Search proofs</span><input id="proof-search" type="search" placeholder="component, version, verdict, capability"><small><span id="visible-count">${registry.entries.length}</span> shown</small></label><section class="table"><table><thead><tr><th>Component</th><th>Exact pair</th><th>Verdict</th><th>Matched</th><th>Changed surface</th><th>Commitment</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No signed entries supplied.</td></tr>'}</tbody></table></section><section class="proofs">${details}</section><footer>Registry <code>${html3(registry.registryHash)}</code>. Each entry and resolution remains independently verifiable with a pinned publisher key. No repositories, prompts, commands, raw outputs, paths, or secrets are included.</footer></main><script>${script}</script></body></html>`;
}
function renderBadgeEndpoint(entry) {
  const color = entry.verdict === "SAFE" ? "2ea66b" : entry.verdict === "CHANGED" ? "d38b16" : "b5475e";
  return `${JSON.stringify({ schemaVersion: 1, label: "agent update", message: entry.verdict.toLowerCase(), color }, null, 2)}
`;
}

// src/upgrade/manager-plan.ts
import { createHash as createHash17 } from "node:crypto";
import { closeSync as closeSync3, fstatSync as fstatSync3, lstatSync as lstatSync6, openSync as openSync3, readFileSync as readFileSync18, readdirSync as readdirSync2, realpathSync as realpathSync7 } from "node:fs";
import { basename as basename5, join as join7, resolve as resolve15 } from "node:path";
import { TextDecoder } from "node:util";

// node_modules/yaml/browser/dist/nodes/identity.js
var ALIAS = Symbol.for("yaml.alias");
var DOC = Symbol.for("yaml.document");
var MAP = Symbol.for("yaml.map");
var PAIR = Symbol.for("yaml.pair");
var SCALAR = Symbol.for("yaml.scalar");
var SEQ = Symbol.for("yaml.seq");
var NODE_TYPE = Symbol.for("yaml.node.type");
var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
function isCollection(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case MAP:
      case SEQ:
        return true;
    }
  return false;
}
function isNode(node) {
  if (node && typeof node === "object")
    switch (node[NODE_TYPE]) {
      case ALIAS:
      case MAP:
      case SCALAR:
      case SEQ:
        return true;
    }
  return false;
}
var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;

// node_modules/yaml/browser/dist/visit.js
var BREAK = Symbol("break visit");
var SKIP = Symbol("skip children");
var REMOVE = Symbol("remove node");
function visit(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    visit_(null, node, visitor_, Object.freeze([]));
}
visit.BREAK = BREAK;
visit.SKIP = SKIP;
visit.REMOVE = REMOVE;
function visit_(key, node, visitor, path) {
  const ctrl = callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visit_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = visit_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = visit_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = visit_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
async function visitAsync(node, visitor) {
  const visitor_ = initVisitor(visitor);
  if (isDocument(node)) {
    const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
    if (cd === REMOVE)
      node.contents = null;
  } else
    await visitAsync_(null, node, visitor_, Object.freeze([]));
}
visitAsync.BREAK = BREAK;
visitAsync.SKIP = SKIP;
visitAsync.REMOVE = REMOVE;
async function visitAsync_(key, node, visitor, path) {
  const ctrl = await callVisitor(key, node, visitor, path);
  if (isNode(ctrl) || isPair(ctrl)) {
    replaceNode(key, path, ctrl);
    return visitAsync_(key, ctrl, visitor, path);
  }
  if (typeof ctrl !== "symbol") {
    if (isCollection(node)) {
      path = Object.freeze(path.concat(node));
      for (let i = 0; i < node.items.length; ++i) {
        const ci = await visitAsync_(i, node.items[i], visitor, path);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK)
          return BREAK;
        else if (ci === REMOVE) {
          node.items.splice(i, 1);
          i -= 1;
        }
      }
    } else if (isPair(node)) {
      path = Object.freeze(path.concat(node));
      const ck = await visitAsync_("key", node.key, visitor, path);
      if (ck === BREAK)
        return BREAK;
      else if (ck === REMOVE)
        node.key = null;
      const cv = await visitAsync_("value", node.value, visitor, path);
      if (cv === BREAK)
        return BREAK;
      else if (cv === REMOVE)
        node.value = null;
    }
  }
  return ctrl;
}
function initVisitor(visitor) {
  if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
    return Object.assign({
      Alias: visitor.Node,
      Map: visitor.Node,
      Scalar: visitor.Node,
      Seq: visitor.Node
    }, visitor.Value && {
      Map: visitor.Value,
      Scalar: visitor.Value,
      Seq: visitor.Value
    }, visitor.Collection && {
      Map: visitor.Collection,
      Seq: visitor.Collection
    }, visitor);
  }
  return visitor;
}
function callVisitor(key, node, visitor, path) {
  if (typeof visitor === "function")
    return visitor(key, node, path);
  if (isMap(node))
    return visitor.Map?.(key, node, path);
  if (isSeq(node))
    return visitor.Seq?.(key, node, path);
  if (isPair(node))
    return visitor.Pair?.(key, node, path);
  if (isScalar(node))
    return visitor.Scalar?.(key, node, path);
  if (isAlias(node))
    return visitor.Alias?.(key, node, path);
  return void 0;
}
function replaceNode(key, path, node) {
  const parent = path[path.length - 1];
  if (isCollection(parent)) {
    parent.items[key] = node;
  } else if (isPair(parent)) {
    if (key === "key")
      parent.key = node;
    else
      parent.value = node;
  } else if (isDocument(parent)) {
    parent.contents = node;
  } else {
    const pt = isAlias(parent) ? "alias" : "scalar";
    throw new Error(`Cannot replace node with ${pt} parent`);
  }
}

// node_modules/yaml/browser/dist/doc/directives.js
var escapeChars = {
  "!": "%21",
  ",": "%2C",
  "[": "%5B",
  "]": "%5D",
  "{": "%7B",
  "}": "%7D"
};
var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
var Directives = class _Directives {
  constructor(yaml, tags) {
    this.docStart = null;
    this.docEnd = false;
    this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
    this.tags = Object.assign({}, _Directives.defaultTags, tags);
  }
  clone() {
    const copy = new _Directives(this.yaml, this.tags);
    copy.docStart = this.docStart;
    return copy;
  }
  /**
   * During parsing, get a Directives instance for the current document and
   * update the stream state according to the current version's spec.
   */
  atDocument() {
    const res = new _Directives(this.yaml, this.tags);
    switch (this.yaml.version) {
      case "1.1":
        this.atNextDocument = true;
        break;
      case "1.2":
        this.atNextDocument = false;
        this.yaml = {
          explicit: _Directives.defaultYaml.explicit,
          version: "1.2"
        };
        this.tags = Object.assign({}, _Directives.defaultTags);
        break;
    }
    return res;
  }
  /**
   * @param onError - May be called even if the action was successful
   * @returns `true` on success
   */
  add(line, onError) {
    if (this.atNextDocument) {
      this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
      this.tags = Object.assign({}, _Directives.defaultTags);
      this.atNextDocument = false;
    }
    const parts = line.trim().split(/[ \t]+/);
    const name = parts.shift();
    switch (name) {
      case "%TAG": {
        if (parts.length !== 2) {
          onError(0, "%TAG directive should contain exactly two parts");
          if (parts.length < 2)
            return false;
        }
        const [handle, prefix] = parts;
        this.tags[handle] = prefix;
        return true;
      }
      case "%YAML": {
        this.yaml.explicit = true;
        if (parts.length !== 1) {
          onError(0, "%YAML directive should contain exactly one part");
          return false;
        }
        const [version] = parts;
        if (version === "1.1" || version === "1.2") {
          this.yaml.version = version;
          return true;
        } else {
          const isValid = /^\d+\.\d+$/.test(version);
          onError(6, `Unsupported YAML version ${version}`, isValid);
          return false;
        }
      }
      default:
        onError(0, `Unknown directive ${name}`, true);
        return false;
    }
  }
  /**
   * Resolves a tag, matching handles to those defined in %TAG directives.
   *
   * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
   *   `'!local'` tag, or `null` if unresolvable.
   */
  tagName(source, onError) {
    if (source === "!")
      return "!";
    if (source[0] !== "!") {
      onError(`Not a valid tag: ${source}`);
      return null;
    }
    if (source[1] === "<") {
      const verbatim = source.slice(2, -1);
      if (verbatim === "!" || verbatim === "!!") {
        onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
        return null;
      }
      if (source[source.length - 1] !== ">")
        onError("Verbatim tags must end with a >");
      return verbatim;
    }
    const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
    if (!suffix)
      onError(`The ${source} tag has no suffix`);
    const prefix = this.tags[handle];
    if (prefix) {
      try {
        return prefix + decodeURIComponent(suffix);
      } catch (error) {
        onError(String(error));
        return null;
      }
    }
    if (handle === "!")
      return source;
    onError(`Could not resolve tag: ${source}`);
    return null;
  }
  /**
   * Given a fully resolved tag, returns its printable string form,
   * taking into account current tag prefixes and defaults.
   */
  tagString(tag) {
    for (const [handle, prefix] of Object.entries(this.tags)) {
      if (tag.startsWith(prefix))
        return handle + escapeTagName(tag.substring(prefix.length));
    }
    return tag[0] === "!" ? tag : `!<${tag}>`;
  }
  toString(doc) {
    const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
    const tagEntries = Object.entries(this.tags);
    let tagNames;
    if (doc && tagEntries.length > 0 && isNode(doc.contents)) {
      const tags = {};
      visit(doc.contents, (_key, node) => {
        if (isNode(node) && node.tag)
          tags[node.tag] = true;
      });
      tagNames = Object.keys(tags);
    } else
      tagNames = [];
    for (const [handle, prefix] of tagEntries) {
      if (handle === "!!" && prefix === "tag:yaml.org,2002:")
        continue;
      if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
        lines.push(`%TAG ${handle} ${prefix}`);
    }
    return lines.join("\n");
  }
};
Directives.defaultYaml = { explicit: false, version: "1.2" };
Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };

// node_modules/yaml/browser/dist/doc/anchors.js
function anchorIsValid(anchor) {
  if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
    const sa = JSON.stringify(anchor);
    const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
    throw new Error(msg);
  }
  return true;
}
function anchorNames(root) {
  const anchors = /* @__PURE__ */ new Set();
  visit(root, {
    Value(_key, node) {
      if (node.anchor)
        anchors.add(node.anchor);
    }
  });
  return anchors;
}
function findNewAnchor(prefix, exclude) {
  for (let i = 1; true; ++i) {
    const name = `${prefix}${i}`;
    if (!exclude.has(name))
      return name;
  }
}
function createNodeAnchors(doc, prefix) {
  const aliasObjects = [];
  const sourceObjects = /* @__PURE__ */ new Map();
  let prevAnchors = null;
  return {
    onAnchor: (source) => {
      aliasObjects.push(source);
      prevAnchors ?? (prevAnchors = anchorNames(doc));
      const anchor = findNewAnchor(prefix, prevAnchors);
      prevAnchors.add(anchor);
      return anchor;
    },
    /**
     * With circular references, the source node is only resolved after all
     * of its child nodes are. This is why anchors are set only after all of
     * the nodes have been created.
     */
    setAnchors: () => {
      for (const source of aliasObjects) {
        const ref = sourceObjects.get(source);
        if (typeof ref === "object" && ref.anchor && (isScalar(ref.node) || isCollection(ref.node))) {
          ref.node.anchor = ref.anchor;
        } else {
          const error = new Error("Failed to resolve repeated object (this should not happen)");
          error.source = source;
          throw error;
        }
      }
    },
    sourceObjects
  };
}

// node_modules/yaml/browser/dist/doc/applyReviver.js
function applyReviver(reviver, obj, key, val) {
  if (val && typeof val === "object") {
    if (Array.isArray(val)) {
      for (let i = 0, len = val.length; i < len; ++i) {
        const v0 = val[i];
        const v1 = applyReviver(reviver, val, String(i), v0);
        if (v1 === void 0)
          delete val[i];
        else if (v1 !== v0)
          val[i] = v1;
      }
    } else if (val instanceof Map) {
      for (const k of Array.from(val.keys())) {
        const v0 = val.get(k);
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          val.delete(k);
        else if (v1 !== v0)
          val.set(k, v1);
      }
    } else if (val instanceof Set) {
      for (const v0 of Array.from(val)) {
        const v1 = applyReviver(reviver, val, v0, v0);
        if (v1 === void 0)
          val.delete(v0);
        else if (v1 !== v0) {
          val.delete(v0);
          val.add(v1);
        }
      }
    } else {
      for (const [k, v0] of Object.entries(val)) {
        const v1 = applyReviver(reviver, val, k, v0);
        if (v1 === void 0)
          delete val[k];
        else if (v1 !== v0)
          val[k] = v1;
      }
    }
  }
  return reviver.call(obj, key, val);
}

// node_modules/yaml/browser/dist/nodes/toJS.js
function toJS(value, arg, ctx) {
  if (Array.isArray(value))
    return value.map((v, i) => toJS(v, String(i), ctx));
  if (value && typeof value.toJSON === "function") {
    if (!ctx || !hasAnchor(value))
      return value.toJSON(arg, ctx);
    const data = { aliasCount: 0, count: 1, res: void 0 };
    ctx.anchors.set(value, data);
    ctx.onCreate = (res2) => {
      data.res = res2;
      delete ctx.onCreate;
    };
    const res = value.toJSON(arg, ctx);
    if (ctx.onCreate)
      ctx.onCreate(res);
    return res;
  }
  if (typeof value === "bigint" && !ctx?.keep)
    return Number(value);
  return value;
}

// node_modules/yaml/browser/dist/nodes/Node.js
var NodeBase = class {
  constructor(type) {
    Object.defineProperty(this, NODE_TYPE, { value: type });
  }
  /** Create a copy of this node.  */
  clone() {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** A plain JavaScript representation of this node. */
  toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    if (!isDocument(doc))
      throw new TypeError("A document argument is required");
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc,
      keep: true,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this, "", ctx);
    if (typeof onAnchor === "function")
      for (const { count: count2, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count2);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
};

// node_modules/yaml/browser/dist/nodes/Alias.js
var Alias = class extends NodeBase {
  constructor(source) {
    super(ALIAS);
    this.source = source;
    Object.defineProperty(this, "tag", {
      set() {
        throw new Error("Alias nodes cannot have tags");
      }
    });
  }
  /**
   * Resolve the value of this alias within `doc`, finding the last
   * instance of the `source` anchor before this node.
   */
  resolve(doc, ctx) {
    if (ctx?.maxAliasCount === 0)
      throw new ReferenceError("Alias resolution is disabled");
    let nodes;
    if (ctx?.aliasResolveCache) {
      nodes = ctx.aliasResolveCache;
    } else {
      nodes = [];
      visit(doc, {
        Node: (_key, node) => {
          if (isAlias(node) || hasAnchor(node))
            nodes.push(node);
        }
      });
      if (ctx)
        ctx.aliasResolveCache = nodes;
    }
    let found = void 0;
    for (const node of nodes) {
      if (node === this)
        break;
      if (node.anchor === this.source)
        found = node;
    }
    return found;
  }
  toJSON(_arg, ctx) {
    if (!ctx)
      return { source: this.source };
    const { anchors, doc, maxAliasCount } = ctx;
    const source = this.resolve(doc, ctx);
    if (!source) {
      const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
      throw new ReferenceError(msg);
    }
    let data = anchors.get(source);
    if (!data) {
      toJS(source, null, ctx);
      data = anchors.get(source);
    }
    if (data?.res === void 0) {
      const msg = "This should not happen: Alias anchor was not resolved?";
      throw new ReferenceError(msg);
    }
    if (maxAliasCount >= 0) {
      data.count += 1;
      if (data.aliasCount === 0)
        data.aliasCount = getAliasCount(doc, source, anchors);
      if (data.count * data.aliasCount > maxAliasCount) {
        const msg = "Excessive alias count indicates a resource exhaustion attack";
        throw new ReferenceError(msg);
      }
    }
    return data.res;
  }
  toString(ctx, _onComment, _onChompKeep) {
    const src = `*${this.source}`;
    if (ctx) {
      anchorIsValid(this.source);
      if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
        const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
        throw new Error(msg);
      }
      if (ctx.implicitKey)
        return `${src} `;
    }
    return src;
  }
};
function getAliasCount(doc, node, anchors) {
  if (isAlias(node)) {
    const source = node.resolve(doc);
    const anchor = anchors && source && anchors.get(source);
    return anchor ? anchor.count * anchor.aliasCount : 0;
  } else if (isCollection(node)) {
    let count2 = 0;
    for (const item2 of node.items) {
      const c = getAliasCount(doc, item2, anchors);
      if (c > count2)
        count2 = c;
    }
    return count2;
  } else if (isPair(node)) {
    const kc = getAliasCount(doc, node.key, anchors);
    const vc = getAliasCount(doc, node.value, anchors);
    return Math.max(kc, vc);
  }
  return 1;
}

// node_modules/yaml/browser/dist/nodes/Scalar.js
var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
var Scalar = class extends NodeBase {
  constructor(value) {
    super(SCALAR);
    this.value = value;
  }
  toJSON(arg, ctx) {
    return ctx?.keep ? this.value : toJS(this.value, arg, ctx);
  }
  toString() {
    return String(this.value);
  }
};
Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
Scalar.PLAIN = "PLAIN";
Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";

// node_modules/yaml/browser/dist/doc/createNode.js
var defaultTagPrefix = "tag:yaml.org,2002:";
function findTagObject(value, tagName, tags) {
  if (tagName) {
    const match = tags.filter((t) => t.tag === tagName);
    const tagObj = match.find((t) => !t.format) ?? match[0];
    if (!tagObj)
      throw new Error(`Tag ${tagName} not found`);
    return tagObj;
  }
  return tags.find((t) => t.identify?.(value) && !t.format);
}
function createNode(value, tagName, ctx) {
  if (isDocument(value))
    value = value.contents;
  if (isNode(value))
    return value;
  if (isPair(value)) {
    const map2 = ctx.schema[MAP].createNode?.(ctx.schema, null, ctx);
    map2.items.push(value);
    return map2;
  }
  if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
    value = value.valueOf();
  }
  const { aliasDuplicateObjects, onAnchor, onTagObj, schema: schema4, sourceObjects } = ctx;
  let ref = void 0;
  if (aliasDuplicateObjects && value && typeof value === "object") {
    ref = sourceObjects.get(value);
    if (ref) {
      ref.anchor ?? (ref.anchor = onAnchor(value));
      return new Alias(ref.anchor);
    } else {
      ref = { anchor: null, node: null };
      sourceObjects.set(value, ref);
    }
  }
  if (tagName?.startsWith("!!"))
    tagName = defaultTagPrefix + tagName.slice(2);
  let tagObj = findTagObject(value, tagName, schema4.tags);
  if (!tagObj) {
    if (value && typeof value.toJSON === "function") {
      value = value.toJSON();
    }
    if (!value || typeof value !== "object") {
      const node2 = new Scalar(value);
      if (ref)
        ref.node = node2;
      return node2;
    }
    tagObj = value instanceof Map ? schema4[MAP] : Symbol.iterator in Object(value) ? schema4[SEQ] : schema4[MAP];
  }
  if (onTagObj) {
    onTagObj(tagObj);
    delete ctx.onTagObj;
  }
  const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar(value);
  if (tagName)
    node.tag = tagName;
  else if (!tagObj.default)
    node.tag = tagObj.tag;
  if (ref)
    ref.node = node;
  return node;
}

// node_modules/yaml/browser/dist/nodes/Collection.js
function collectionFromPath(schema4, path, value) {
  let v = value;
  for (let i = path.length - 1; i >= 0; --i) {
    const k = path[i];
    if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
      const a = [];
      a[k] = v;
      v = a;
    } else {
      v = /* @__PURE__ */ new Map([[k, v]]);
    }
  }
  return createNode(v, void 0, {
    aliasDuplicateObjects: false,
    keepUndefined: false,
    onAnchor: () => {
      throw new Error("This should not happen, please report a bug.");
    },
    schema: schema4,
    sourceObjects: /* @__PURE__ */ new Map()
  });
}
var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
var Collection = class extends NodeBase {
  constructor(type, schema4) {
    super(type);
    Object.defineProperty(this, "schema", {
      value: schema4,
      configurable: true,
      enumerable: false,
      writable: true
    });
  }
  /**
   * Create a copy of this collection.
   *
   * @param schema - If defined, overwrites the original's schema
   */
  clone(schema4) {
    const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
    if (schema4)
      copy.schema = schema4;
    copy.items = copy.items.map((it) => isNode(it) || isPair(it) ? it.clone(schema4) : it);
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /**
   * Adds a value to the collection. For `!!map` and `!!omap` the value must
   * be a Pair instance or a `{ key, value }` object, which may not have a key
   * that already exists in the map.
   */
  addIn(path, value) {
    if (isEmptyPath(path))
      this.add(value);
    else {
      const [key, ...rest] = path;
      const node = this.get(key, true);
      if (isCollection(node))
        node.addIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
  /**
   * Removes a value from the collection.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.delete(key);
    const node = this.get(key, true);
    if (isCollection(node))
      return node.deleteIn(rest);
    else
      throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    const [key, ...rest] = path;
    const node = this.get(key, true);
    if (rest.length === 0)
      return !keepScalar && isScalar(node) ? node.value : node;
    else
      return isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
  }
  hasAllNullValues(allowScalar) {
    return this.items.every((node) => {
      if (!isPair(node))
        return false;
      const n = node.value;
      return n == null || allowScalar && isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
    });
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   */
  hasIn(path) {
    const [key, ...rest] = path;
    if (rest.length === 0)
      return this.has(key);
    const node = this.get(key, true);
    return isCollection(node) ? node.hasIn(rest) : false;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    const [key, ...rest] = path;
    if (rest.length === 0) {
      this.set(key, value);
    } else {
      const node = this.get(key, true);
      if (isCollection(node))
        node.setIn(rest, value);
      else if (node === void 0 && this.schema)
        this.set(key, collectionFromPath(this.schema, rest, value));
      else
        throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
    }
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyComment.js
var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
function indentComment(comment, indent) {
  if (/^\n+$/.test(comment))
    return comment.substring(1);
  return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
}
var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;

// node_modules/yaml/browser/dist/stringify/foldFlowLines.js
var FOLD_FLOW = "flow";
var FOLD_BLOCK = "block";
var FOLD_QUOTED = "quoted";
function foldFlowLines(text6, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
  if (!lineWidth || lineWidth < 0)
    return text6;
  if (lineWidth < minContentWidth)
    minContentWidth = 0;
  const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
  if (text6.length <= endStep)
    return text6;
  const folds = [];
  const escapedFolds = {};
  let end = lineWidth - indent.length;
  if (typeof indentAtStart === "number") {
    if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
      folds.push(0);
    else
      end = lineWidth - indentAtStart;
  }
  let split = void 0;
  let prev = void 0;
  let overflow = false;
  let i = -1;
  let escStart = -1;
  let escEnd = -1;
  if (mode === FOLD_BLOCK) {
    i = consumeMoreIndentedLines(text6, i, indent.length);
    if (i !== -1)
      end = i + endStep;
  }
  for (let ch; ch = text6[i += 1]; ) {
    if (mode === FOLD_QUOTED && ch === "\\") {
      escStart = i;
      switch (text6[i + 1]) {
        case "x":
          i += 3;
          break;
        case "u":
          i += 5;
          break;
        case "U":
          i += 9;
          break;
        default:
          i += 1;
      }
      escEnd = i;
    }
    if (ch === "\n") {
      if (mode === FOLD_BLOCK)
        i = consumeMoreIndentedLines(text6, i, indent.length);
      end = i + indent.length + endStep;
      split = void 0;
    } else {
      if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
        const next = text6[i + 1];
        if (next && next !== " " && next !== "\n" && next !== "	")
          split = i;
      }
      if (i >= end) {
        if (split) {
          folds.push(split);
          end = split + endStep;
          split = void 0;
        } else if (mode === FOLD_QUOTED) {
          while (prev === " " || prev === "	") {
            prev = ch;
            ch = text6[i += 1];
            overflow = true;
          }
          const j = i > escEnd + 1 ? i - 2 : escStart - 1;
          if (escapedFolds[j])
            return text6;
          folds.push(j);
          escapedFolds[j] = true;
          end = j + endStep;
          split = void 0;
        } else {
          overflow = true;
        }
      }
    }
    prev = ch;
  }
  if (overflow && onOverflow)
    onOverflow();
  if (folds.length === 0)
    return text6;
  if (onFold)
    onFold();
  let res = text6.slice(0, folds[0]);
  for (let i2 = 0; i2 < folds.length; ++i2) {
    const fold = folds[i2];
    const end2 = folds[i2 + 1] || text6.length;
    if (fold === 0)
      res = `
${indent}${text6.slice(0, end2)}`;
    else {
      if (mode === FOLD_QUOTED && escapedFolds[fold])
        res += `${text6[fold]}\\`;
      res += `
${indent}${text6.slice(fold + 1, end2)}`;
    }
  }
  return res;
}
function consumeMoreIndentedLines(text6, i, indent) {
  let end = i;
  let start = i + 1;
  let ch = text6[start];
  while (ch === " " || ch === "	") {
    if (i < start + indent) {
      ch = text6[++i];
    } else {
      do {
        ch = text6[++i];
      } while (ch && ch !== "\n");
      end = i;
      start = i + 1;
      ch = text6[start];
    }
  }
  return end;
}

// node_modules/yaml/browser/dist/stringify/stringifyString.js
var getFoldOptions = (ctx, isBlock2) => ({
  indentAtStart: isBlock2 ? ctx.indent.length : ctx.indentAtStart,
  lineWidth: ctx.options.lineWidth,
  minContentWidth: ctx.options.minContentWidth
});
var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
function lineLengthOverLimit(str, lineWidth, indentLength) {
  if (!lineWidth || lineWidth < 0)
    return false;
  const limit = lineWidth - indentLength;
  const strLen = str.length;
  if (strLen <= limit)
    return false;
  for (let i = 0, start = 0; i < strLen; ++i) {
    if (str[i] === "\n") {
      if (i - start > limit)
        return true;
      start = i + 1;
      if (strLen - start <= limit)
        return false;
    }
  }
  return true;
}
function doubleQuotedString(value, ctx) {
  const json = JSON.stringify(value);
  if (ctx.options.doubleQuotedAsJSON)
    return json;
  const { implicitKey } = ctx;
  const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  let str = "";
  let start = 0;
  for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
    if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
      str += json.slice(start, i) + "\\ ";
      i += 1;
      start = i;
      ch = "\\";
    }
    if (ch === "\\")
      switch (json[i + 1]) {
        case "u":
          {
            str += json.slice(start, i);
            const code2 = json.substr(i + 2, 4);
            switch (code2) {
              case "0000":
                str += "\\0";
                break;
              case "0007":
                str += "\\a";
                break;
              case "000b":
                str += "\\v";
                break;
              case "001b":
                str += "\\e";
                break;
              case "0085":
                str += "\\N";
                break;
              case "00a0":
                str += "\\_";
                break;
              case "2028":
                str += "\\L";
                break;
              case "2029":
                str += "\\P";
                break;
              default:
                if (code2.substr(0, 2) === "00")
                  str += "\\x" + code2.substr(2);
                else
                  str += json.substr(i, 6);
            }
            i += 5;
            start = i + 1;
          }
          break;
        case "n":
          if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
            i += 1;
          } else {
            str += json.slice(start, i) + "\n\n";
            while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
              str += "\n";
              i += 2;
            }
            str += indent;
            if (json[i + 2] === " ")
              str += "\\";
            i += 1;
            start = i + 1;
          }
          break;
        default:
          i += 1;
      }
  }
  str = start ? str + json.slice(start) : json;
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_QUOTED, getFoldOptions(ctx, false));
}
function singleQuotedString(value, ctx) {
  if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
    return doubleQuotedString(value, ctx);
  const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
  const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
  return ctx.implicitKey ? res : foldFlowLines(res, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function quotedString(value, ctx) {
  const { singleQuote } = ctx.options;
  let qs;
  if (singleQuote === false)
    qs = doubleQuotedString;
  else {
    const hasDouble = value.includes('"');
    const hasSingle = value.includes("'");
    if (hasDouble && !hasSingle)
      qs = singleQuotedString;
    else if (hasSingle && !hasDouble)
      qs = doubleQuotedString;
    else
      qs = singleQuote ? singleQuotedString : doubleQuotedString;
  }
  return qs(value, ctx);
}
var blockEndNewlines;
try {
  blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
} catch {
  blockEndNewlines = /\n+(?!\n|$)/g;
}
function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
  const { blockQuote, commentString, lineWidth } = ctx.options;
  if (!blockQuote || /\n[\t ]+$/.test(value)) {
    return quotedString(value, ctx);
  }
  const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
  const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.BLOCK_FOLDED ? false : type === Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
  if (!value)
    return literal ? "|\n" : ">\n";
  let chomp;
  let endStart;
  for (endStart = value.length; endStart > 0; --endStart) {
    const ch = value[endStart - 1];
    if (ch !== "\n" && ch !== "	" && ch !== " ")
      break;
  }
  let end = value.substring(endStart);
  const endNlPos = end.indexOf("\n");
  if (endNlPos === -1) {
    chomp = "-";
  } else if (value === end || endNlPos !== end.length - 1) {
    chomp = "+";
    if (onChompKeep)
      onChompKeep();
  } else {
    chomp = "";
  }
  if (end) {
    value = value.slice(0, -end.length);
    if (end[end.length - 1] === "\n")
      end = end.slice(0, -1);
    end = end.replace(blockEndNewlines, `$&${indent}`);
  }
  let startWithSpace = false;
  let startEnd;
  let startNlPos = -1;
  for (startEnd = 0; startEnd < value.length; ++startEnd) {
    const ch = value[startEnd];
    if (ch === " ")
      startWithSpace = true;
    else if (ch === "\n")
      startNlPos = startEnd;
    else
      break;
  }
  let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
  if (start) {
    value = value.substring(start.length);
    start = start.replace(/\n+/g, `$&${indent}`);
  }
  const indentSize = indent ? "2" : "1";
  let header = (startWithSpace ? indentSize : "") + chomp;
  if (comment) {
    header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
    if (onComment)
      onComment();
  }
  if (!literal) {
    const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
    let literalFallback = false;
    const foldOptions = getFoldOptions(ctx, true);
    if (blockQuote !== "folded" && type !== Scalar.BLOCK_FOLDED) {
      foldOptions.onOverflow = () => {
        literalFallback = true;
      };
    }
    const body = foldFlowLines(`${start}${foldedValue}${end}`, indent, FOLD_BLOCK, foldOptions);
    if (!literalFallback)
      return `>${header}
${indent}${body}`;
  }
  value = value.replace(/\n+/g, `$&${indent}`);
  return `|${header}
${indent}${start}${value}${end}`;
}
function plainString(item2, ctx, onComment, onChompKeep) {
  const { type, value } = item2;
  const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
  if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
    return quotedString(value, ctx);
  }
  if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
    return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item2, ctx, onComment, onChompKeep);
  }
  if (!implicitKey && !inFlow && type !== Scalar.PLAIN && value.includes("\n")) {
    return blockString(item2, ctx, onComment, onChompKeep);
  }
  if (containsDocumentMarker(value)) {
    if (indent === "") {
      ctx.forceBlockIndent = true;
      return blockString(item2, ctx, onComment, onChompKeep);
    } else if (implicitKey && indent === indentStep) {
      return quotedString(value, ctx);
    }
  }
  const str = value.replace(/\n+/g, `$&
${indent}`);
  if (actualString) {
    const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
    const { compat, tags } = ctx.doc.schema;
    if (tags.some(test) || compat?.some(test))
      return quotedString(value, ctx);
  }
  return implicitKey ? str : foldFlowLines(str, indent, FOLD_FLOW, getFoldOptions(ctx, false));
}
function stringifyString(item2, ctx, onComment, onChompKeep) {
  const { implicitKey, inFlow } = ctx;
  const ss = typeof item2.value === "string" ? item2 : Object.assign({}, item2, { value: String(item2.value) });
  let { type } = item2;
  if (type !== Scalar.QUOTE_DOUBLE) {
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
      type = Scalar.QUOTE_DOUBLE;
  }
  const _stringify = (_type) => {
    switch (_type) {
      case Scalar.BLOCK_FOLDED:
      case Scalar.BLOCK_LITERAL:
        return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
      case Scalar.QUOTE_DOUBLE:
        return doubleQuotedString(ss.value, ctx);
      case Scalar.QUOTE_SINGLE:
        return singleQuotedString(ss.value, ctx);
      case Scalar.PLAIN:
        return plainString(ss, ctx, onComment, onChompKeep);
      default:
        return null;
    }
  };
  let res = _stringify(type);
  if (res === null) {
    const { defaultKeyType, defaultStringType } = ctx.options;
    const t = implicitKey && defaultKeyType || defaultStringType;
    res = _stringify(t);
    if (res === null)
      throw new Error(`Unsupported default string type ${t}`);
  }
  return res;
}

// node_modules/yaml/browser/dist/stringify/stringify.js
function createStringifyContext(doc, options) {
  const opt = Object.assign({
    blockQuote: true,
    commentString: stringifyComment,
    defaultKeyType: null,
    defaultStringType: "PLAIN",
    directives: null,
    doubleQuotedAsJSON: false,
    doubleQuotedMinMultiLineLength: 40,
    falseStr: "false",
    flowCollectionPadding: true,
    indentSeq: true,
    lineWidth: 80,
    minContentWidth: 20,
    nullStr: "null",
    simpleKeys: false,
    singleQuote: null,
    trailingComma: false,
    trueStr: "true",
    verifyAliasOrder: true
  }, doc.schema.toStringOptions, options);
  let inFlow;
  switch (opt.collectionStyle) {
    case "block":
      inFlow = false;
      break;
    case "flow":
      inFlow = true;
      break;
    default:
      inFlow = null;
  }
  return {
    anchors: /* @__PURE__ */ new Set(),
    doc,
    flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
    indent: "",
    indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
    inFlow,
    options: opt
  };
}
function getTagObject(tags, item2) {
  if (item2.tag) {
    const match = tags.filter((t) => t.tag === item2.tag);
    if (match.length > 0)
      return match.find((t) => t.format === item2.format) ?? match[0];
  }
  let tagObj = void 0;
  let obj;
  if (isScalar(item2)) {
    obj = item2.value;
    let match = tags.filter((t) => t.identify?.(obj));
    if (match.length > 1) {
      const testMatch = match.filter((t) => t.test);
      if (testMatch.length > 0)
        match = testMatch;
    }
    tagObj = match.find((t) => t.format === item2.format) ?? match.find((t) => !t.format);
  } else {
    obj = item2;
    tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
  }
  if (!tagObj) {
    const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
    throw new Error(`Tag not resolved for ${name} value`);
  }
  return tagObj;
}
function stringifyProps(node, tagObj, { anchors, doc }) {
  if (!doc.directives)
    return "";
  const props = [];
  const anchor = (isScalar(node) || isCollection(node)) && node.anchor;
  if (anchor && anchorIsValid(anchor)) {
    anchors.add(anchor);
    props.push(`&${anchor}`);
  }
  const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
  if (tag)
    props.push(doc.directives.tagString(tag));
  return props.join(" ");
}
function stringify2(item2, ctx, onComment, onChompKeep) {
  if (isPair(item2))
    return item2.toString(ctx, onComment, onChompKeep);
  if (isAlias(item2)) {
    if (ctx.doc.directives)
      return item2.toString(ctx);
    if (ctx.resolvedAliases?.has(item2)) {
      throw new TypeError(`Cannot stringify circular structure without alias nodes`);
    } else {
      if (ctx.resolvedAliases)
        ctx.resolvedAliases.add(item2);
      else
        ctx.resolvedAliases = /* @__PURE__ */ new Set([item2]);
      item2 = item2.resolve(ctx.doc);
    }
  }
  let tagObj = void 0;
  const node = isNode(item2) ? item2 : ctx.doc.createNode(item2, { onTagObj: (o) => tagObj = o });
  tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
  const props = stringifyProps(node, tagObj, ctx);
  if (props.length > 0)
    ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
  const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : isScalar(node) ? stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
  if (!props)
    return str;
  return isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
}

// node_modules/yaml/browser/dist/stringify/stringifyPair.js
function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
  const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
  let keyComment = isNode(key) && key.comment || null;
  if (simpleKeys) {
    if (keyComment) {
      throw new Error("With simple keys, key nodes cannot have comments");
    }
    if (isCollection(key) || !isNode(key) && typeof key === "object") {
      const msg = "With simple keys, collection cannot be used as a key value";
      throw new Error(msg);
    }
  }
  let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || isCollection(key) || (isScalar(key) ? key.type === Scalar.BLOCK_FOLDED || key.type === Scalar.BLOCK_LITERAL : typeof key === "object"));
  ctx = Object.assign({}, ctx, {
    allNullValues: false,
    implicitKey: !explicitKey && (simpleKeys || !allNullValues),
    indent: indent + indentStep
  });
  let keyCommentDone = false;
  let chompKeep = false;
  let str = stringify2(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
  if (!explicitKey && !ctx.inFlow && str.length > 1024) {
    if (simpleKeys)
      throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
    explicitKey = true;
  }
  if (ctx.inFlow) {
    if (allNullValues || value == null) {
      if (keyCommentDone && onComment)
        onComment();
      return str === "" ? "?" : explicitKey ? `? ${str}` : str;
    }
  } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
    str = `? ${str}`;
    if (keyComment && !keyCommentDone) {
      str += lineComment(str, ctx.indent, commentString(keyComment));
    } else if (chompKeep && onChompKeep)
      onChompKeep();
    return str;
  }
  if (keyCommentDone)
    keyComment = null;
  if (explicitKey) {
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
    str = `? ${str}
${indent}:`;
  } else {
    str = `${str}:`;
    if (keyComment)
      str += lineComment(str, ctx.indent, commentString(keyComment));
  }
  let vsb, vcb, valueComment;
  if (isNode(value)) {
    vsb = !!value.spaceBefore;
    vcb = value.commentBefore;
    valueComment = value.comment;
  } else {
    vsb = false;
    vcb = null;
    valueComment = null;
    if (value && typeof value === "object")
      value = doc.createNode(value);
  }
  ctx.implicitKey = false;
  if (!explicitKey && !keyComment && isScalar(value))
    ctx.indentAtStart = str.length + 1;
  chompKeep = false;
  if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && isSeq(value) && !value.flow && !value.tag && !value.anchor) {
    ctx.indent = ctx.indent.substring(2);
  }
  let valueCommentDone = false;
  const valueStr = stringify2(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
  let ws = " ";
  if (keyComment || vsb || vcb) {
    ws = vsb ? "\n" : "";
    if (vcb) {
      const cs = commentString(vcb);
      ws += `
${indentComment(cs, ctx.indent)}`;
    }
    if (valueStr === "" && !ctx.inFlow) {
      if (ws === "\n" && valueComment)
        ws = "\n\n";
    } else {
      ws += `
${ctx.indent}`;
    }
  } else if (!explicitKey && isCollection(value)) {
    const vs0 = valueStr[0];
    const nl0 = valueStr.indexOf("\n");
    const hasNewline = nl0 !== -1;
    const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
    if (hasNewline || !flow) {
      let hasPropsLine = false;
      if (hasNewline && (vs0 === "&" || vs0 === "!")) {
        let sp0 = valueStr.indexOf(" ");
        if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
          sp0 = valueStr.indexOf(" ", sp0 + 1);
        }
        if (sp0 === -1 || nl0 < sp0)
          hasPropsLine = true;
      }
      if (!hasPropsLine)
        ws = `
${ctx.indent}`;
    }
  } else if (valueStr === "" || valueStr[0] === "\n") {
    ws = "";
  }
  str += ws + valueStr;
  if (ctx.inFlow) {
    if (valueCommentDone && onComment)
      onComment();
  } else if (valueComment && !valueCommentDone) {
    str += lineComment(str, ctx.indent, commentString(valueComment));
  } else if (chompKeep && onChompKeep) {
    onChompKeep();
  }
  return str;
}

// node_modules/yaml/browser/dist/log.js
function warn(logLevel, warning) {
  if (logLevel === "debug" || logLevel === "warn") {
    console.warn(warning);
  }
}

// node_modules/yaml/browser/dist/schema/yaml-1.1/merge.js
var MERGE_KEY = "<<";
var merge = {
  identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
  default: "key",
  tag: "tag:yaml.org,2002:merge",
  test: /^<<$/,
  resolve: () => Object.assign(new Scalar(Symbol(MERGE_KEY)), {
    addToJSMap: addMergeToJSMap
  }),
  stringify: () => MERGE_KEY
};
var isMergeKey = (ctx, key) => (merge.identify(key) || isScalar(key) && (!key.type || key.type === Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
function addMergeToJSMap(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (isSeq(source))
    for (const it of source.items)
      mergeValue(ctx, map2, it);
  else if (Array.isArray(source))
    for (const it of source)
      mergeValue(ctx, map2, it);
  else
    mergeValue(ctx, map2, source);
}
function mergeValue(ctx, map2, value) {
  const source = resolveAliasValue(ctx, value);
  if (!isMap(source))
    throw new Error("Merge sources must be maps or map aliases");
  const srcMap = source.toJSON(null, ctx, Map);
  for (const [key, value2] of srcMap) {
    if (map2 instanceof Map) {
      if (!map2.has(key))
        map2.set(key, value2);
    } else if (map2 instanceof Set) {
      map2.add(key);
    } else if (!Object.prototype.hasOwnProperty.call(map2, key)) {
      Object.defineProperty(map2, key, {
        value: value2,
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
  }
  return map2;
}
function resolveAliasValue(ctx, value) {
  return ctx && isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
}

// node_modules/yaml/browser/dist/nodes/addPairToJSMap.js
function addPairToJSMap(ctx, map2, { key, value }) {
  if (isNode(key) && key.addToJSMap)
    key.addToJSMap(ctx, map2, value);
  else if (isMergeKey(ctx, key))
    addMergeToJSMap(ctx, map2, value);
  else {
    const jsKey = toJS(key, "", ctx);
    if (map2 instanceof Map) {
      map2.set(jsKey, toJS(value, jsKey, ctx));
    } else if (map2 instanceof Set) {
      map2.add(jsKey);
    } else {
      const stringKey = stringifyKey(key, jsKey, ctx);
      const jsValue = toJS(value, stringKey, ctx);
      if (stringKey in map2)
        Object.defineProperty(map2, stringKey, {
          value: jsValue,
          writable: true,
          enumerable: true,
          configurable: true
        });
      else
        map2[stringKey] = jsValue;
    }
  }
  return map2;
}
function stringifyKey(key, jsKey, ctx) {
  if (jsKey === null)
    return "";
  if (typeof jsKey !== "object")
    return String(jsKey);
  if (isNode(key) && ctx?.doc) {
    const strCtx = createStringifyContext(ctx.doc, {});
    strCtx.anchors = /* @__PURE__ */ new Set();
    for (const node of ctx.anchors.keys())
      strCtx.anchors.add(node.anchor);
    strCtx.inFlow = true;
    strCtx.inStringifyKey = true;
    const strKey = key.toString(strCtx);
    if (!ctx.mapKeyWarned) {
      let jsonStr = JSON.stringify(strKey);
      if (jsonStr.length > 40)
        jsonStr = jsonStr.substring(0, 36) + '..."';
      warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
      ctx.mapKeyWarned = true;
    }
    return strKey;
  }
  return JSON.stringify(jsKey);
}

// node_modules/yaml/browser/dist/nodes/Pair.js
function createPair(key, value, ctx) {
  const k = createNode(key, void 0, ctx);
  const v = createNode(value, void 0, ctx);
  return new Pair(k, v);
}
var Pair = class _Pair {
  constructor(key, value = null) {
    Object.defineProperty(this, NODE_TYPE, { value: PAIR });
    this.key = key;
    this.value = value;
  }
  clone(schema4) {
    let { key, value } = this;
    if (isNode(key))
      key = key.clone(schema4);
    if (isNode(value))
      value = value.clone(schema4);
    return new _Pair(key, value);
  }
  toJSON(_, ctx) {
    const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    return addPairToJSMap(ctx, pair, this);
  }
  toString(ctx, onComment, onChompKeep) {
    return ctx?.doc ? stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyCollection.js
function stringifyCollection(collection, ctx, options) {
  const flow = ctx.inFlow ?? collection.flow;
  const stringify5 = flow ? stringifyFlowCollection : stringifyBlockCollection;
  return stringify5(collection, ctx, options);
}
function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
  const { indent, options: { commentString } } = ctx;
  const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
  let chompKeep = false;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item2 = items[i];
    let comment2 = null;
    if (isNode(item2)) {
      if (!chompKeep && item2.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item2.commentBefore, chompKeep);
      if (item2.comment)
        comment2 = item2.comment;
    } else if (isPair(item2)) {
      const ik = isNode(item2.key) ? item2.key : null;
      if (ik) {
        if (!chompKeep && ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
      }
    }
    chompKeep = false;
    let str2 = stringify2(item2, itemCtx, () => comment2 = null, () => chompKeep = true);
    if (comment2)
      str2 += lineComment(str2, itemIndent, commentString(comment2));
    if (chompKeep && comment2)
      chompKeep = false;
    lines.push(blockItemPrefix + str2);
  }
  let str;
  if (lines.length === 0) {
    str = flowChars.start + flowChars.end;
  } else {
    str = lines[0];
    for (let i = 1; i < lines.length; ++i) {
      const line = lines[i];
      str += line ? `
${indent}${line}` : "\n";
    }
  }
  if (comment) {
    str += "\n" + indentComment(commentString(comment), indent);
    if (onComment)
      onComment();
  } else if (chompKeep && onChompKeep)
    onChompKeep();
  return str;
}
function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
  const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
  itemIndent += indentStep;
  const itemCtx = Object.assign({}, ctx, {
    indent: itemIndent,
    inFlow: true,
    type: null
  });
  let reqNewline = false;
  let linesAtValue = 0;
  const lines = [];
  for (let i = 0; i < items.length; ++i) {
    const item2 = items[i];
    let comment = null;
    if (isNode(item2)) {
      if (item2.spaceBefore)
        lines.push("");
      addCommentBefore(ctx, lines, item2.commentBefore, false);
      if (item2.comment)
        comment = item2.comment;
    } else if (isPair(item2)) {
      const ik = isNode(item2.key) ? item2.key : null;
      if (ik) {
        if (ik.spaceBefore)
          lines.push("");
        addCommentBefore(ctx, lines, ik.commentBefore, false);
        if (ik.comment)
          reqNewline = true;
      }
      const iv = isNode(item2.value) ? item2.value : null;
      if (iv) {
        if (iv.comment)
          comment = iv.comment;
        if (iv.commentBefore)
          reqNewline = true;
      } else if (item2.value == null && ik?.comment) {
        comment = ik.comment;
      }
    }
    if (comment)
      reqNewline = true;
    let str = stringify2(item2, itemCtx, () => comment = null);
    reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
    if (i < items.length - 1) {
      str += ",";
    } else if (ctx.options.trailingComma) {
      if (ctx.options.lineWidth > 0) {
        reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
      }
      if (reqNewline) {
        str += ",";
      }
    }
    if (comment)
      str += lineComment(str, itemIndent, commentString(comment));
    lines.push(str);
    linesAtValue = lines.length;
  }
  const { start, end } = flowChars;
  if (lines.length === 0) {
    return start + end;
  } else {
    if (!reqNewline) {
      const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
      reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
    }
    if (reqNewline) {
      let str = start;
      for (const line of lines)
        str += line ? `
${indentStep}${indent}${line}` : "\n";
      return `${str}
${indent}${end}`;
    } else {
      return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
    }
  }
}
function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
  if (comment && chompKeep)
    comment = comment.replace(/^\n+/, "");
  if (comment) {
    const ic = indentComment(commentString(comment), indent);
    lines.push(ic.trimStart());
  }
}

// node_modules/yaml/browser/dist/nodes/YAMLMap.js
function findPair(items, key) {
  const k = isScalar(key) ? key.value : key;
  for (const it of items) {
    if (isPair(it)) {
      if (it.key === key || it.key === k)
        return it;
      if (isScalar(it.key) && it.key.value === k)
        return it;
    }
  }
  return void 0;
}
var YAMLMap = class extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:map";
  }
  constructor(schema4) {
    super(MAP, schema4);
    this.items = [];
  }
  /**
   * A generic collection parsing method that can be extended
   * to other node classes that inherit from YAMLMap
   */
  static from(schema4, obj, ctx) {
    const { keepUndefined, replacer } = ctx;
    const map2 = new this(schema4);
    const add = (key, value) => {
      if (typeof replacer === "function")
        value = replacer.call(obj, key, value);
      else if (Array.isArray(replacer) && !replacer.includes(key))
        return;
      if (value !== void 0 || keepUndefined)
        map2.items.push(createPair(key, value, ctx));
    };
    if (obj instanceof Map) {
      for (const [key, value] of obj)
        add(key, value);
    } else if (obj && typeof obj === "object") {
      for (const key of Object.keys(obj))
        add(key, obj[key]);
    }
    if (typeof schema4.sortMapEntries === "function") {
      map2.items.sort(schema4.sortMapEntries);
    }
    return map2;
  }
  /**
   * Adds a value to the collection.
   *
   * @param overwrite - If not set `true`, using a key that is already in the
   *   collection will throw. Otherwise, overwrites the previous value.
   */
  add(pair, overwrite) {
    let _pair;
    if (isPair(pair))
      _pair = pair;
    else if (!pair || typeof pair !== "object" || !("key" in pair)) {
      _pair = new Pair(pair, pair?.value);
    } else
      _pair = new Pair(pair.key, pair.value);
    const prev = findPair(this.items, _pair.key);
    const sortEntries = this.schema?.sortMapEntries;
    if (prev) {
      if (!overwrite)
        throw new Error(`Key ${_pair.key} already set`);
      if (isScalar(prev.value) && isScalarValue(_pair.value))
        prev.value.value = _pair.value;
      else
        prev.value = _pair.value;
    } else if (sortEntries) {
      const i = this.items.findIndex((item2) => sortEntries(_pair, item2) < 0);
      if (i === -1)
        this.items.push(_pair);
      else
        this.items.splice(i, 0, _pair);
    } else {
      this.items.push(_pair);
    }
  }
  delete(key) {
    const it = findPair(this.items, key);
    if (!it)
      return false;
    const del = this.items.splice(this.items.indexOf(it), 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const it = findPair(this.items, key);
    const node = it?.value;
    return (!keepScalar && isScalar(node) ? node.value : node) ?? void 0;
  }
  has(key) {
    return !!findPair(this.items, key);
  }
  set(key, value) {
    this.add(new Pair(key, value), true);
  }
  /**
   * @param ctx - Conversion context, originally set in Document#toJS()
   * @param {Class} Type - If set, forces the returned collection type
   * @returns Instance of Type, Map, or Object
   */
  toJSON(_, ctx, Type) {
    const map2 = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const item2 of this.items)
      addPairToJSMap(ctx, map2, item2);
    return map2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    for (const item2 of this.items) {
      if (!isPair(item2))
        throw new Error(`Map items must all be pairs; found ${JSON.stringify(item2)} instead`);
    }
    if (!ctx.allNullValues && this.hasAllNullValues(false))
      ctx = Object.assign({}, ctx, { allNullValues: true });
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "",
      flowChars: { start: "{", end: "}" },
      itemIndent: ctx.indent || "",
      onChompKeep,
      onComment
    });
  }
};

// node_modules/yaml/browser/dist/schema/common/map.js
var map = {
  collection: "map",
  default: true,
  nodeClass: YAMLMap,
  tag: "tag:yaml.org,2002:map",
  resolve(map2, onError) {
    if (!isMap(map2))
      onError("Expected a mapping for this tag");
    return map2;
  },
  createNode: (schema4, obj, ctx) => YAMLMap.from(schema4, obj, ctx)
};

// node_modules/yaml/browser/dist/nodes/YAMLSeq.js
var YAMLSeq = class extends Collection {
  static get tagName() {
    return "tag:yaml.org,2002:seq";
  }
  constructor(schema4) {
    super(SEQ, schema4);
    this.items = [];
  }
  add(value) {
    this.items.push(value);
  }
  /**
   * Removes a value from the collection.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   *
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return false;
    const del = this.items.splice(idx, 1);
    return del.length > 0;
  }
  get(key, keepScalar) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      return void 0;
    const it = this.items[idx];
    return !keepScalar && isScalar(it) ? it.value : it;
  }
  /**
   * Checks if the collection includes a value with the key `key`.
   *
   * `key` must contain a representation of an integer for this to succeed.
   * It may be wrapped in a `Scalar`.
   */
  has(key) {
    const idx = asItemIndex(key);
    return typeof idx === "number" && idx < this.items.length;
  }
  /**
   * Sets a value in this collection. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   *
   * If `key` does not contain a representation of an integer, this will throw.
   * It may be wrapped in a `Scalar`.
   */
  set(key, value) {
    const idx = asItemIndex(key);
    if (typeof idx !== "number")
      throw new Error(`Expected a valid index, not ${key}.`);
    const prev = this.items[idx];
    if (isScalar(prev) && isScalarValue(value))
      prev.value = value;
    else
      this.items[idx] = value;
  }
  toJSON(_, ctx) {
    const seq2 = [];
    if (ctx?.onCreate)
      ctx.onCreate(seq2);
    let i = 0;
    for (const item2 of this.items)
      seq2.push(toJS(item2, String(i++), ctx));
    return seq2;
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    return stringifyCollection(this, ctx, {
      blockItemPrefix: "- ",
      flowChars: { start: "[", end: "]" },
      itemIndent: (ctx.indent || "") + "  ",
      onChompKeep,
      onComment
    });
  }
  static from(schema4, obj, ctx) {
    const { replacer } = ctx;
    const seq2 = new this(schema4);
    if (obj && Symbol.iterator in Object(obj)) {
      let i = 0;
      for (let it of obj) {
        if (typeof replacer === "function") {
          const key = obj instanceof Set ? it : String(i++);
          it = replacer.call(obj, key, it);
        }
        seq2.items.push(createNode(it, void 0, ctx));
      }
    }
    return seq2;
  }
};
function asItemIndex(key) {
  let idx = isScalar(key) ? key.value : key;
  if (idx && typeof idx === "string")
    idx = Number(idx);
  return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
}

// node_modules/yaml/browser/dist/schema/common/seq.js
var seq = {
  collection: "seq",
  default: true,
  nodeClass: YAMLSeq,
  tag: "tag:yaml.org,2002:seq",
  resolve(seq2, onError) {
    if (!isSeq(seq2))
      onError("Expected a sequence for this tag");
    return seq2;
  },
  createNode: (schema4, obj, ctx) => YAMLSeq.from(schema4, obj, ctx)
};

// node_modules/yaml/browser/dist/schema/common/string.js
var string = {
  identify: (value) => typeof value === "string",
  default: true,
  tag: "tag:yaml.org,2002:str",
  resolve: (str) => str,
  stringify(item2, ctx, onComment, onChompKeep) {
    ctx = Object.assign({ actualString: true }, ctx);
    return stringifyString(item2, ctx, onComment, onChompKeep);
  }
};

// node_modules/yaml/browser/dist/schema/common/null.js
var nullTag = {
  identify: (value) => value == null,
  createNode: () => new Scalar(null),
  default: true,
  tag: "tag:yaml.org,2002:null",
  test: /^(?:~|[Nn]ull|NULL)?$/,
  resolve: () => new Scalar(null),
  stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
};

// node_modules/yaml/browser/dist/schema/core/bool.js
var boolTag = {
  identify: (value) => typeof value === "boolean",
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
  resolve: (str) => new Scalar(str[0] === "t" || str[0] === "T"),
  stringify({ source, value }, ctx) {
    if (source && boolTag.test.test(source)) {
      const sv = source[0] === "t" || source[0] === "T";
      if (value === sv)
        return source;
    }
    return value ? ctx.options.trueStr : ctx.options.falseStr;
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyNumber.js
function stringifyNumber({ format, minFractionDigits, tag, value }) {
  if (typeof value === "bigint")
    return String(value);
  const num = typeof value === "number" ? value : Number(value);
  if (!isFinite(num))
    return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
  let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
  if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
    let i = n.indexOf(".");
    if (i < 0) {
      i = n.length;
      n += ".";
    }
    let d = minFractionDigits - (n.length - i - 1);
    while (d-- > 0)
      n += "0";
  }
  return n;
}

// node_modules/yaml/browser/dist/schema/core/float.js
var floatNaN = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str));
    const dot = str.indexOf(".");
    if (dot !== -1 && str[str.length - 1] === "0")
      node.minFractionDigits = str.length - dot - 1;
    return node;
  },
  stringify: stringifyNumber
};

// node_modules/yaml/browser/dist/schema/core/int.js
var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
function intStringify(node, radix, prefix) {
  const { value } = node;
  if (intIdentify(value) && value >= 0)
    return prefix + value.toString(radix);
  return stringifyNumber(node);
}
var intOct = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^0o[0-7]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
  stringify: (node) => intStringify(node, 8, "0o")
};
var int = {
  identify: intIdentify,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex = {
  identify: (value) => intIdentify(value) && value >= 0,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^0x[0-9a-fA-F]+$/,
  resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
  stringify: (node) => intStringify(node, 16, "0x")
};

// node_modules/yaml/browser/dist/schema/core/schema.js
var schema = [
  map,
  seq,
  string,
  nullTag,
  boolTag,
  intOct,
  int,
  intHex,
  floatNaN,
  floatExp,
  float
];

// node_modules/yaml/browser/dist/schema/json/schema.js
function intIdentify2(value) {
  return typeof value === "bigint" || Number.isInteger(value);
}
var stringifyJSON = ({ value }) => JSON.stringify(value);
var jsonScalars = [
  {
    identify: (value) => typeof value === "string",
    default: true,
    tag: "tag:yaml.org,2002:str",
    resolve: (str) => str,
    stringify: stringifyJSON
  },
  {
    identify: (value) => value == null,
    createNode: () => new Scalar(null),
    default: true,
    tag: "tag:yaml.org,2002:null",
    test: /^null$/,
    resolve: () => null,
    stringify: stringifyJSON
  },
  {
    identify: (value) => typeof value === "boolean",
    default: true,
    tag: "tag:yaml.org,2002:bool",
    test: /^true$|^false$/,
    resolve: (str) => str === "true",
    stringify: stringifyJSON
  },
  {
    identify: intIdentify2,
    default: true,
    tag: "tag:yaml.org,2002:int",
    test: /^-?(?:0|[1-9][0-9]*)$/,
    resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
    stringify: ({ value }) => intIdentify2(value) ? value.toString() : JSON.stringify(value)
  },
  {
    identify: (value) => typeof value === "number",
    default: true,
    tag: "tag:yaml.org,2002:float",
    test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
    resolve: (str) => parseFloat(str),
    stringify: stringifyJSON
  }
];
var jsonError = {
  default: true,
  tag: "",
  test: /^/,
  resolve(str, onError) {
    onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
    return str;
  }
};
var schema2 = [map, seq].concat(jsonScalars, jsonError);

// node_modules/yaml/browser/dist/schema/yaml-1.1/binary.js
var binary = {
  identify: (value) => value instanceof Uint8Array,
  // Buffer inherits from Uint8Array
  default: false,
  tag: "tag:yaml.org,2002:binary",
  /**
   * Returns a Buffer in node and an Uint8Array in browsers
   *
   * To use the resulting buffer as an image, you'll want to do something like:
   *
   *   const blob = new Blob([buffer], { type: 'image/jpeg' })
   *   document.querySelector('#photo').src = URL.createObjectURL(blob)
   */
  resolve(src, onError) {
    if (typeof atob === "function") {
      const str = atob(src.replace(/[\n\r]/g, ""));
      const buffer = new Uint8Array(str.length);
      for (let i = 0; i < str.length; ++i)
        buffer[i] = str.charCodeAt(i);
      return buffer;
    } else {
      onError("This environment does not support reading binary tags; either Buffer or atob is required");
      return src;
    }
  },
  stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
    if (!value)
      return "";
    const buf = value;
    let str;
    if (typeof btoa === "function") {
      let s = "";
      for (let i = 0; i < buf.length; ++i)
        s += String.fromCharCode(buf[i]);
      str = btoa(s);
    } else {
      throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
    }
    type ?? (type = Scalar.BLOCK_LITERAL);
    if (type !== Scalar.QUOTE_DOUBLE) {
      const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
      const n = Math.ceil(str.length / lineWidth);
      const lines = new Array(n);
      for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
        lines[i] = str.substr(o, lineWidth);
      }
      str = lines.join(type === Scalar.BLOCK_LITERAL ? "\n" : " ");
    }
    return stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
  }
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/pairs.js
function resolvePairs(seq2, onError) {
  if (isSeq(seq2)) {
    for (let i = 0; i < seq2.items.length; ++i) {
      let item2 = seq2.items[i];
      if (isPair(item2))
        continue;
      else if (isMap(item2)) {
        if (item2.items.length > 1)
          onError("Each pair must have its own sequence indicator");
        const pair = item2.items[0] || new Pair(new Scalar(null));
        if (item2.commentBefore)
          pair.key.commentBefore = pair.key.commentBefore ? `${item2.commentBefore}
${pair.key.commentBefore}` : item2.commentBefore;
        if (item2.comment) {
          const cn = pair.value ?? pair.key;
          cn.comment = cn.comment ? `${item2.comment}
${cn.comment}` : item2.comment;
        }
        item2 = pair;
      }
      seq2.items[i] = isPair(item2) ? item2 : new Pair(item2);
    }
  } else
    onError("Expected a sequence for this tag");
  return seq2;
}
function createPairs(schema4, iterable, ctx) {
  const { replacer } = ctx;
  const pairs2 = new YAMLSeq(schema4);
  pairs2.tag = "tag:yaml.org,2002:pairs";
  let i = 0;
  if (iterable && Symbol.iterator in Object(iterable))
    for (let it of iterable) {
      if (typeof replacer === "function")
        it = replacer.call(iterable, String(i++), it);
      let key, value;
      if (Array.isArray(it)) {
        if (it.length === 2) {
          key = it[0];
          value = it[1];
        } else
          throw new TypeError(`Expected [key, value] tuple: ${it}`);
      } else if (it && it instanceof Object) {
        const keys = Object.keys(it);
        if (keys.length === 1) {
          key = keys[0];
          value = it[key];
        } else {
          throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
        }
      } else {
        key = it;
      }
      pairs2.items.push(createPair(key, value, ctx));
    }
  return pairs2;
}
var pairs = {
  collection: "seq",
  default: false,
  tag: "tag:yaml.org,2002:pairs",
  resolve: resolvePairs,
  createNode: createPairs
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/omap.js
var YAMLOMap = class _YAMLOMap extends YAMLSeq {
  constructor() {
    super();
    this.add = YAMLMap.prototype.add.bind(this);
    this.delete = YAMLMap.prototype.delete.bind(this);
    this.get = YAMLMap.prototype.get.bind(this);
    this.has = YAMLMap.prototype.has.bind(this);
    this.set = YAMLMap.prototype.set.bind(this);
    this.tag = _YAMLOMap.tag;
  }
  /**
   * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
   * but TypeScript won't allow widening the signature of a child method.
   */
  toJSON(_, ctx) {
    if (!ctx)
      return super.toJSON(_);
    const map2 = /* @__PURE__ */ new Map();
    if (ctx?.onCreate)
      ctx.onCreate(map2);
    for (const pair of this.items) {
      let key, value;
      if (isPair(pair)) {
        key = toJS(pair.key, "", ctx);
        value = toJS(pair.value, key, ctx);
      } else {
        key = toJS(pair, "", ctx);
      }
      if (map2.has(key))
        throw new Error("Ordered maps must not include duplicate keys");
      map2.set(key, value);
    }
    return map2;
  }
  static from(schema4, iterable, ctx) {
    const pairs2 = createPairs(schema4, iterable, ctx);
    const omap2 = new this();
    omap2.items = pairs2.items;
    return omap2;
  }
};
YAMLOMap.tag = "tag:yaml.org,2002:omap";
var omap = {
  collection: "seq",
  identify: (value) => value instanceof Map,
  nodeClass: YAMLOMap,
  default: false,
  tag: "tag:yaml.org,2002:omap",
  resolve(seq2, onError) {
    const pairs2 = resolvePairs(seq2, onError);
    const seenKeys = [];
    for (const { key } of pairs2.items) {
      if (isScalar(key)) {
        if (seenKeys.includes(key.value)) {
          onError(`Ordered maps must not include duplicate keys: ${key.value}`);
        } else {
          seenKeys.push(key.value);
        }
      }
    }
    return Object.assign(new YAMLOMap(), pairs2);
  },
  createNode: (schema4, iterable, ctx) => YAMLOMap.from(schema4, iterable, ctx)
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/bool.js
function boolStringify({ value, source }, ctx) {
  const boolObj = value ? trueTag : falseTag;
  if (source && boolObj.test.test(source))
    return source;
  return value ? ctx.options.trueStr : ctx.options.falseStr;
}
var trueTag = {
  identify: (value) => value === true,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
  resolve: () => new Scalar(true),
  stringify: boolStringify
};
var falseTag = {
  identify: (value) => value === false,
  default: true,
  tag: "tag:yaml.org,2002:bool",
  test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
  resolve: () => new Scalar(false),
  stringify: boolStringify
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/float.js
var floatNaN2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
  resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
  stringify: stringifyNumber
};
var floatExp2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "EXP",
  test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
  resolve: (str) => parseFloat(str.replace(/_/g, "")),
  stringify(node) {
    const num = Number(node.value);
    return isFinite(num) ? num.toExponential() : stringifyNumber(node);
  }
};
var float2 = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
  resolve(str) {
    const node = new Scalar(parseFloat(str.replace(/_/g, "")));
    const dot = str.indexOf(".");
    if (dot !== -1) {
      const f = str.substring(dot + 1).replace(/_/g, "");
      if (f[f.length - 1] === "0")
        node.minFractionDigits = f.length;
    }
    return node;
  },
  stringify: stringifyNumber
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/int.js
var intIdentify3 = (value) => typeof value === "bigint" || Number.isInteger(value);
function intResolve2(str, offset, radix, { intAsBigInt }) {
  const sign5 = str[0];
  if (sign5 === "-" || sign5 === "+")
    offset += 1;
  str = str.substring(offset).replace(/_/g, "");
  if (intAsBigInt) {
    switch (radix) {
      case 2:
        str = `0b${str}`;
        break;
      case 8:
        str = `0o${str}`;
        break;
      case 16:
        str = `0x${str}`;
        break;
    }
    const n2 = BigInt(str);
    return sign5 === "-" ? BigInt(-1) * n2 : n2;
  }
  const n = parseInt(str, radix);
  return sign5 === "-" ? -1 * n : n;
}
function intStringify2(node, radix, prefix) {
  const { value } = node;
  if (intIdentify3(value)) {
    const str = value.toString(radix);
    return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
  }
  return stringifyNumber(node);
}
var intBin = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "BIN",
  test: /^[-+]?0b[0-1_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 2, opt),
  stringify: (node) => intStringify2(node, 2, "0b")
};
var intOct2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "OCT",
  test: /^[-+]?0[0-7_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 1, 8, opt),
  stringify: (node) => intStringify2(node, 8, "0")
};
var int2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  test: /^[-+]?[0-9][0-9_]*$/,
  resolve: (str, _onError, opt) => intResolve2(str, 0, 10, opt),
  stringify: stringifyNumber
};
var intHex2 = {
  identify: intIdentify3,
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "HEX",
  test: /^[-+]?0x[0-9a-fA-F_]+$/,
  resolve: (str, _onError, opt) => intResolve2(str, 2, 16, opt),
  stringify: (node) => intStringify2(node, 16, "0x")
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/set.js
var YAMLSet = class _YAMLSet extends YAMLMap {
  constructor(schema4) {
    super(schema4);
    this.tag = _YAMLSet.tag;
  }
  add(key) {
    let pair;
    if (isPair(key))
      pair = key;
    else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
      pair = new Pair(key.key, null);
    else
      pair = new Pair(key, null);
    const prev = findPair(this.items, pair.key);
    if (!prev)
      this.items.push(pair);
  }
  /**
   * If `keepPair` is `true`, returns the Pair matching `key`.
   * Otherwise, returns the value of that Pair's key.
   */
  get(key, keepPair) {
    const pair = findPair(this.items, key);
    return !keepPair && isPair(pair) ? isScalar(pair.key) ? pair.key.value : pair.key : pair;
  }
  set(key, value) {
    if (typeof value !== "boolean")
      throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
    const prev = findPair(this.items, key);
    if (prev && !value) {
      this.items.splice(this.items.indexOf(prev), 1);
    } else if (!prev && value) {
      this.items.push(new Pair(key));
    }
  }
  toJSON(_, ctx) {
    return super.toJSON(_, ctx, Set);
  }
  toString(ctx, onComment, onChompKeep) {
    if (!ctx)
      return JSON.stringify(this);
    if (this.hasAllNullValues(true))
      return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
    else
      throw new Error("Set items must all have null values");
  }
  static from(schema4, iterable, ctx) {
    const { replacer } = ctx;
    const set2 = new this(schema4);
    if (iterable && Symbol.iterator in Object(iterable))
      for (let value of iterable) {
        if (typeof replacer === "function")
          value = replacer.call(iterable, value, value);
        set2.items.push(createPair(value, null, ctx));
      }
    return set2;
  }
};
YAMLSet.tag = "tag:yaml.org,2002:set";
var set = {
  collection: "map",
  identify: (value) => value instanceof Set,
  nodeClass: YAMLSet,
  default: false,
  tag: "tag:yaml.org,2002:set",
  createNode: (schema4, iterable, ctx) => YAMLSet.from(schema4, iterable, ctx),
  resolve(map2, onError) {
    if (isMap(map2)) {
      if (map2.hasAllNullValues(true))
        return Object.assign(new YAMLSet(), map2);
      else
        onError("Set items must all have null values");
    } else
      onError("Expected a mapping for this tag");
    return map2;
  }
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/timestamp.js
function parseSexagesimal(str, asBigInt) {
  const sign5 = str[0];
  const parts = sign5 === "-" || sign5 === "+" ? str.substring(1) : str;
  const num = (n) => asBigInt ? BigInt(n) : Number(n);
  const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
  return sign5 === "-" ? num(-1) * res : res;
}
function stringifySexagesimal(node) {
  let { value } = node;
  let num = (n) => n;
  if (typeof value === "bigint")
    num = (n) => BigInt(n);
  else if (isNaN(value) || !isFinite(value))
    return stringifyNumber(node);
  let sign5 = "";
  if (value < 0) {
    sign5 = "-";
    value *= num(-1);
  }
  const _60 = num(60);
  const parts = [value % _60];
  if (value < 60) {
    parts.unshift(0);
  } else {
    value = (value - parts[0]) / _60;
    parts.unshift(value % _60);
    if (value >= 60) {
      value = (value - parts[0]) / _60;
      parts.unshift(value);
    }
  }
  return sign5 + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
}
var intTime = {
  identify: (value) => typeof value === "bigint" || Number.isInteger(value),
  default: true,
  tag: "tag:yaml.org,2002:int",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
  resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
  stringify: stringifySexagesimal
};
var floatTime = {
  identify: (value) => typeof value === "number",
  default: true,
  tag: "tag:yaml.org,2002:float",
  format: "TIME",
  test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
  resolve: (str) => parseSexagesimal(str, false),
  stringify: stringifySexagesimal
};
var timestamp3 = {
  identify: (value) => value instanceof Date,
  default: true,
  tag: "tag:yaml.org,2002:timestamp",
  // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
  // may be omitted altogether, resulting in a date format. In such a case, the time part is
  // assumed to be 00:00:00Z (start of day, UTC).
  test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
  resolve(str) {
    const match = str.match(timestamp3.test);
    if (!match)
      throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
    const [, year, month, day, hour, minute, second] = match.map(Number);
    const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
    let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
    const tz = match[8];
    if (tz && tz !== "Z") {
      let d = parseSexagesimal(tz, false);
      if (Math.abs(d) < 30)
        d *= 60;
      date -= 6e4 * d;
    }
    return new Date(date);
  },
  stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
};

// node_modules/yaml/browser/dist/schema/yaml-1.1/schema.js
var schema3 = [
  map,
  seq,
  string,
  nullTag,
  trueTag,
  falseTag,
  intBin,
  intOct2,
  int2,
  intHex2,
  floatNaN2,
  floatExp2,
  float2,
  binary,
  merge,
  omap,
  pairs,
  set,
  intTime,
  floatTime,
  timestamp3
];

// node_modules/yaml/browser/dist/schema/tags.js
var schemas = /* @__PURE__ */ new Map([
  ["core", schema],
  ["failsafe", [map, seq, string]],
  ["json", schema2],
  ["yaml11", schema3],
  ["yaml-1.1", schema3]
]);
var tagsByName = {
  binary,
  bool: boolTag,
  float,
  floatExp,
  floatNaN,
  floatTime,
  int,
  intHex,
  intOct,
  intTime,
  map,
  merge,
  null: nullTag,
  omap,
  pairs,
  seq,
  set,
  timestamp: timestamp3
};
var coreKnownTags = {
  "tag:yaml.org,2002:binary": binary,
  "tag:yaml.org,2002:merge": merge,
  "tag:yaml.org,2002:omap": omap,
  "tag:yaml.org,2002:pairs": pairs,
  "tag:yaml.org,2002:set": set,
  "tag:yaml.org,2002:timestamp": timestamp3
};
function getTags(customTags, schemaName, addMergeTag) {
  const schemaTags = schemas.get(schemaName);
  if (schemaTags && !customTags) {
    return addMergeTag && !schemaTags.includes(merge) ? schemaTags.concat(merge) : schemaTags.slice();
  }
  let tags = schemaTags;
  if (!tags) {
    if (Array.isArray(customTags))
      tags = [];
    else {
      const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
    }
  }
  if (Array.isArray(customTags)) {
    for (const tag of customTags)
      tags = tags.concat(tag);
  } else if (typeof customTags === "function") {
    tags = customTags(tags.slice());
  }
  if (addMergeTag)
    tags = tags.concat(merge);
  return tags.reduce((tags2, tag) => {
    const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
    if (!tagObj) {
      const tagName = JSON.stringify(tag);
      const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
      throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
    }
    if (!tags2.includes(tagObj))
      tags2.push(tagObj);
    return tags2;
  }, []);
}

// node_modules/yaml/browser/dist/schema/Schema.js
var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
var Schema = class _Schema {
  constructor({ compat, customTags, merge: merge2, resolveKnownTags, schema: schema4, sortMapEntries, toStringDefaults }) {
    this.compat = Array.isArray(compat) ? getTags(compat, "compat") : compat ? getTags(null, compat) : null;
    this.name = typeof schema4 === "string" && schema4 || "core";
    this.knownTags = resolveKnownTags ? coreKnownTags : {};
    this.tags = getTags(customTags, this.name, merge2);
    this.toStringOptions = toStringDefaults ?? null;
    Object.defineProperty(this, MAP, { value: map });
    Object.defineProperty(this, SCALAR, { value: string });
    Object.defineProperty(this, SEQ, { value: seq });
    this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
  }
  clone() {
    const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
    copy.tags = this.tags.slice();
    return copy;
  }
};

// node_modules/yaml/browser/dist/stringify/stringifyDocument.js
function stringifyDocument(doc, options) {
  const lines = [];
  let hasDirectives = options.directives === true;
  if (options.directives !== false && doc.directives) {
    const dir = doc.directives.toString(doc);
    if (dir) {
      lines.push(dir);
      hasDirectives = true;
    } else if (doc.directives.docStart)
      hasDirectives = true;
  }
  if (hasDirectives)
    lines.push("---");
  const ctx = createStringifyContext(doc, options);
  const { commentString } = ctx.options;
  if (doc.commentBefore) {
    if (lines.length !== 1)
      lines.unshift("");
    const cs = commentString(doc.commentBefore);
    lines.unshift(indentComment(cs, ""));
  }
  let chompKeep = false;
  let contentComment = null;
  if (doc.contents) {
    if (isNode(doc.contents)) {
      if (doc.contents.spaceBefore && hasDirectives)
        lines.push("");
      if (doc.contents.commentBefore) {
        const cs = commentString(doc.contents.commentBefore);
        lines.push(indentComment(cs, ""));
      }
      ctx.forceBlockIndent = !!doc.comment;
      contentComment = doc.contents.comment;
    }
    const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
    let body = stringify2(doc.contents, ctx, () => contentComment = null, onChompKeep);
    if (contentComment)
      body += lineComment(body, "", commentString(contentComment));
    if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
      lines[lines.length - 1] = `--- ${body}`;
    } else
      lines.push(body);
  } else {
    lines.push(stringify2(doc.contents, ctx));
  }
  if (doc.directives?.docEnd) {
    if (doc.comment) {
      const cs = commentString(doc.comment);
      if (cs.includes("\n")) {
        lines.push("...");
        lines.push(indentComment(cs, ""));
      } else {
        lines.push(`... ${cs}`);
      }
    } else {
      lines.push("...");
    }
  } else {
    let dc = doc.comment;
    if (dc && chompKeep)
      dc = dc.replace(/^\n+/, "");
    if (dc) {
      if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
        lines.push("");
      lines.push(indentComment(commentString(dc), ""));
    }
  }
  return lines.join("\n") + "\n";
}

// node_modules/yaml/browser/dist/doc/Document.js
var Document = class _Document {
  constructor(value, replacer, options) {
    this.commentBefore = null;
    this.comment = null;
    this.errors = [];
    this.warnings = [];
    Object.defineProperty(this, NODE_TYPE, { value: DOC });
    let _replacer = null;
    if (typeof replacer === "function" || Array.isArray(replacer)) {
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const opt = Object.assign({
      intAsBigInt: false,
      keepSourceTokens: false,
      logLevel: "warn",
      prettyErrors: true,
      strict: true,
      stringKeys: false,
      uniqueKeys: true,
      version: "1.2"
    }, options);
    this.options = opt;
    let { version } = opt;
    if (options?._directives) {
      this.directives = options._directives.atDocument();
      if (this.directives.yaml.explicit)
        version = this.directives.yaml.version;
    } else
      this.directives = new Directives({ version });
    this.setSchema(version, options);
    this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
  }
  /**
   * Create a deep copy of this Document and its contents.
   *
   * Custom Node values that inherit from `Object` still refer to their original instances.
   */
  clone() {
    const copy = Object.create(_Document.prototype, {
      [NODE_TYPE]: { value: DOC }
    });
    copy.commentBefore = this.commentBefore;
    copy.comment = this.comment;
    copy.errors = this.errors.slice();
    copy.warnings = this.warnings.slice();
    copy.options = Object.assign({}, this.options);
    if (this.directives)
      copy.directives = this.directives.clone();
    copy.schema = this.schema.clone();
    copy.contents = isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
    if (this.range)
      copy.range = this.range.slice();
    return copy;
  }
  /** Adds a value to the document. */
  add(value) {
    if (assertCollection(this.contents))
      this.contents.add(value);
  }
  /** Adds a value to the document. */
  addIn(path, value) {
    if (assertCollection(this.contents))
      this.contents.addIn(path, value);
  }
  /**
   * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
   *
   * If `node` already has an anchor, `name` is ignored.
   * Otherwise, the `node.anchor` value will be set to `name`,
   * or if an anchor with that name is already present in the document,
   * `name` will be used as a prefix for a new unique anchor.
   * If `name` is undefined, the generated anchor will use 'a' as a prefix.
   */
  createAlias(node, name) {
    if (!node.anchor) {
      const prev = anchorNames(this);
      node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      !name || prev.has(name) ? findNewAnchor(name || "a", prev) : name;
    }
    return new Alias(node.anchor);
  }
  createNode(value, replacer, options) {
    let _replacer = void 0;
    if (typeof replacer === "function") {
      value = replacer.call({ "": value }, "", value);
      _replacer = replacer;
    } else if (Array.isArray(replacer)) {
      const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
      const asStr = replacer.filter(keyToStr).map(String);
      if (asStr.length > 0)
        replacer = replacer.concat(asStr);
      _replacer = replacer;
    } else if (options === void 0 && replacer) {
      options = replacer;
      replacer = void 0;
    }
    const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
    const { onAnchor, setAnchors, sourceObjects } = createNodeAnchors(
      this,
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      anchorPrefix || "a"
    );
    const ctx = {
      aliasDuplicateObjects: aliasDuplicateObjects ?? true,
      keepUndefined: keepUndefined ?? false,
      onAnchor,
      onTagObj,
      replacer: _replacer,
      schema: this.schema,
      sourceObjects
    };
    const node = createNode(value, tag, ctx);
    if (flow && isCollection(node))
      node.flow = true;
    setAnchors();
    return node;
  }
  /**
   * Convert a key and a value into a `Pair` using the current schema,
   * recursively wrapping all values as `Scalar` or `Collection` nodes.
   */
  createPair(key, value, options = {}) {
    const k = this.createNode(key, null, options);
    const v = this.createNode(value, null, options);
    return new Pair(k, v);
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  delete(key) {
    return assertCollection(this.contents) ? this.contents.delete(key) : false;
  }
  /**
   * Removes a value from the document.
   * @returns `true` if the item was found and removed.
   */
  deleteIn(path) {
    if (isEmptyPath(path)) {
      if (this.contents == null)
        return false;
      this.contents = null;
      return true;
    }
    return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
  }
  /**
   * Returns item at `key`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  get(key, keepScalar) {
    return isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
  }
  /**
   * Returns item at `path`, or `undefined` if not found. By default unwraps
   * scalar values from their surrounding node; to disable set `keepScalar` to
   * `true` (collections are always returned intact).
   */
  getIn(path, keepScalar) {
    if (isEmptyPath(path))
      return !keepScalar && isScalar(this.contents) ? this.contents.value : this.contents;
    return isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
  }
  /**
   * Checks if the document includes a value with the key `key`.
   */
  has(key) {
    return isCollection(this.contents) ? this.contents.has(key) : false;
  }
  /**
   * Checks if the document includes a value at `path`.
   */
  hasIn(path) {
    if (isEmptyPath(path))
      return this.contents !== void 0;
    return isCollection(this.contents) ? this.contents.hasIn(path) : false;
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  set(key, value) {
    if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, [key], value);
    } else if (assertCollection(this.contents)) {
      this.contents.set(key, value);
    }
  }
  /**
   * Sets a value in this document. For `!!set`, `value` needs to be a
   * boolean to add/remove the item from the set.
   */
  setIn(path, value) {
    if (isEmptyPath(path)) {
      this.contents = value;
    } else if (this.contents == null) {
      this.contents = collectionFromPath(this.schema, Array.from(path), value);
    } else if (assertCollection(this.contents)) {
      this.contents.setIn(path, value);
    }
  }
  /**
   * Change the YAML version and schema used by the document.
   * A `null` version disables support for directives, explicit tags, anchors, and aliases.
   * It also requires the `schema` option to be given as a `Schema` instance value.
   *
   * Overrides all previously set schema options.
   */
  setSchema(version, options = {}) {
    if (typeof version === "number")
      version = String(version);
    let opt;
    switch (version) {
      case "1.1":
        if (this.directives)
          this.directives.yaml.version = "1.1";
        else
          this.directives = new Directives({ version: "1.1" });
        opt = { resolveKnownTags: false, schema: "yaml-1.1" };
        break;
      case "1.2":
      case "next":
        if (this.directives)
          this.directives.yaml.version = version;
        else
          this.directives = new Directives({ version });
        opt = { resolveKnownTags: true, schema: "core" };
        break;
      case null:
        if (this.directives)
          delete this.directives;
        opt = null;
        break;
      default: {
        const sv = JSON.stringify(version);
        throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
      }
    }
    if (options.schema instanceof Object)
      this.schema = options.schema;
    else if (opt)
      this.schema = new Schema(Object.assign(opt, options));
    else
      throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
  }
  // json & jsonArg are only used from toJSON()
  toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
    const ctx = {
      anchors: /* @__PURE__ */ new Map(),
      doc: this,
      keep: !json,
      mapAsMap: mapAsMap === true,
      mapKeyWarned: false,
      maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
    };
    const res = toJS(this.contents, jsonArg ?? "", ctx);
    if (typeof onAnchor === "function")
      for (const { count: count2, res: res2 } of ctx.anchors.values())
        onAnchor(res2, count2);
    return typeof reviver === "function" ? applyReviver(reviver, { "": res }, "", res) : res;
  }
  /**
   * A JSON representation of the document `contents`.
   *
   * @param jsonArg Used by `JSON.stringify` to indicate the array index or
   *   property name.
   */
  toJSON(jsonArg, onAnchor) {
    return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
  }
  /** A YAML representation of the document. */
  toString(options = {}) {
    if (this.errors.length > 0)
      throw new Error("Document with errors cannot be stringified");
    if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
      const s = JSON.stringify(options.indent);
      throw new Error(`"indent" option must be a positive integer, not ${s}`);
    }
    return stringifyDocument(this, options);
  }
};
function assertCollection(contents) {
  if (isCollection(contents))
    return true;
  throw new Error("Expected a YAML collection as document contents");
}

// node_modules/yaml/browser/dist/errors.js
var YAMLError = class extends Error {
  constructor(name, pos, code2, message) {
    super();
    this.name = name;
    this.code = code2;
    this.message = message;
    this.pos = pos;
  }
};
var YAMLParseError = class extends YAMLError {
  constructor(pos, code2, message) {
    super("YAMLParseError", pos, code2, message);
  }
};
var YAMLWarning = class extends YAMLError {
  constructor(pos, code2, message) {
    super("YAMLWarning", pos, code2, message);
  }
};
var prettifyError = (src, lc) => (error) => {
  if (error.pos[0] === -1)
    return;
  error.linePos = error.pos.map((pos) => lc.linePos(pos));
  const { line, col } = error.linePos[0];
  error.message += ` at line ${line}, column ${col}`;
  let ci = col - 1;
  let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
  if (ci >= 60 && lineStr.length > 80) {
    const trimStart = Math.min(ci - 39, lineStr.length - 79);
    lineStr = "\u2026" + lineStr.substring(trimStart);
    ci -= trimStart - 1;
  }
  if (lineStr.length > 80)
    lineStr = lineStr.substring(0, 79) + "\u2026";
  if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
    let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
    if (prev.length > 80)
      prev = prev.substring(0, 79) + "\u2026\n";
    lineStr = prev + lineStr;
  }
  if (/[^ ]/.test(lineStr)) {
    let count2 = 1;
    const end = error.linePos[1];
    if (end?.line === line && end.col > col) {
      count2 = Math.max(1, Math.min(end.col - col, 80 - ci));
    }
    const pointer = " ".repeat(ci) + "^".repeat(count2);
    error.message += `:

${lineStr}
${pointer}
`;
  }
};

// node_modules/yaml/browser/dist/compose/resolve-props.js
function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
  let spaceBefore = false;
  let atNewline = startOnNewline;
  let hasSpace = startOnNewline;
  let comment = "";
  let commentSep = "";
  let hasNewline = false;
  let reqSpace = false;
  let tab = null;
  let anchor = null;
  let tag = null;
  let newlineAfterProp = null;
  let comma = null;
  let found = null;
  let start = null;
  for (const token of tokens) {
    if (reqSpace) {
      if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
        onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      reqSpace = false;
    }
    if (tab) {
      if (atNewline && token.type !== "comment" && token.type !== "newline") {
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      }
      tab = null;
    }
    switch (token.type) {
      case "space":
        if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
          tab = token;
        }
        hasSpace = true;
        break;
      case "comment": {
        if (!hasSpace)
          onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
        const cb = token.source.substring(1) || " ";
        if (!comment)
          comment = cb;
        else
          comment += commentSep + cb;
        commentSep = "";
        atNewline = false;
        break;
      }
      case "newline":
        if (atNewline) {
          if (comment)
            comment += token.source;
          else if (!found || indicator !== "seq-item-ind")
            spaceBefore = true;
        } else
          commentSep += token.source;
        atNewline = true;
        hasNewline = true;
        if (anchor || tag)
          newlineAfterProp = token;
        hasSpace = true;
        break;
      case "anchor":
        if (anchor)
          onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
        if (token.source.endsWith(":"))
          onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
        anchor = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      case "tag": {
        if (tag)
          onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
        tag = token;
        start ?? (start = token.offset);
        atNewline = false;
        hasSpace = false;
        reqSpace = true;
        break;
      }
      case indicator:
        if (anchor || tag)
          onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
        if (found)
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
        found = token;
        atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
        hasSpace = false;
        break;
      case "comma":
        if (flow) {
          if (comma)
            onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
          comma = token;
          atNewline = false;
          hasSpace = false;
          break;
        }
      // else fallthrough
      default:
        onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
        atNewline = false;
        hasSpace = false;
    }
  }
  const last = tokens[tokens.length - 1];
  const end = last ? last.offset + last.source.length : offset;
  if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
    onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
  }
  if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
    onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
  return {
    comma,
    found,
    spaceBefore,
    comment,
    hasNewline,
    anchor,
    tag,
    newlineAfterProp,
    end,
    start: start ?? end
  };
}

// node_modules/yaml/browser/dist/compose/util-contains-newline.js
function containsNewline(key) {
  if (!key)
    return null;
  switch (key.type) {
    case "alias":
    case "scalar":
    case "double-quoted-scalar":
    case "single-quoted-scalar":
      if (key.source.includes("\n"))
        return true;
      if (key.end) {
        for (const st of key.end)
          if (st.type === "newline")
            return true;
      }
      return false;
    case "flow-collection":
      for (const it of key.items) {
        for (const st of it.start)
          if (st.type === "newline")
            return true;
        if (it.sep) {
          for (const st of it.sep)
            if (st.type === "newline")
              return true;
        }
        if (containsNewline(it.key) || containsNewline(it.value))
          return true;
      }
      return false;
    default:
      return true;
  }
}

// node_modules/yaml/browser/dist/compose/util-flow-indent-check.js
function flowIndentCheck(indent, fc, onError) {
  if (fc?.type === "flow-collection") {
    const end = fc.end[0];
    if (end.indent === indent && (end.source === "]" || end.source === "}") && containsNewline(fc)) {
      const msg = "Flow end indicator should be more indented than parent";
      onError(end, "BAD_INDENT", msg, true);
    }
  }
}

// node_modules/yaml/browser/dist/compose/util-map-includes.js
function mapIncludes(ctx, items, search) {
  const { uniqueKeys } = ctx.options;
  if (uniqueKeys === false)
    return false;
  const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || isScalar(a) && isScalar(b) && a.value === b.value;
  return items.some((pair) => isEqual(pair.key, search));
}

// node_modules/yaml/browser/dist/compose/resolve-block-map.js
var startColMsg = "All mapping items must start at the same column";
function resolveBlockMap({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bm, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLMap;
  const map2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  let offset = bm.offset;
  let commentEnd = null;
  for (const collItem of bm.items) {
    const { start, key, sep: sep12, value } = collItem;
    const keyProps = resolveProps(start, {
      indicator: "explicit-key-ind",
      next: key ?? sep12?.[0],
      offset,
      onError,
      parentIndent: bm.indent,
      startOnNewline: true
    });
    const implicitKey = !keyProps.found;
    if (implicitKey) {
      if (key) {
        if (key.type === "block-seq")
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
        else if ("indent" in key && key.indent !== bm.indent)
          onError(offset, "BAD_INDENT", startColMsg);
      }
      if (!keyProps.anchor && !keyProps.tag && !sep12) {
        commentEnd = keyProps.end;
        if (keyProps.comment) {
          if (map2.comment)
            map2.comment += "\n" + keyProps.comment;
          else
            map2.comment = keyProps.comment;
        }
        continue;
      }
      if (keyProps.newlineAfterProp || containsNewline(key)) {
        onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
      }
    } else if (keyProps.found?.indent !== bm.indent) {
      onError(offset, "BAD_INDENT", startColMsg);
    }
    ctx.atKey = true;
    const keyStart = keyProps.end;
    const keyNode = key ? composeNode2(ctx, key, keyProps, onError) : composeEmptyNode2(ctx, keyStart, start, null, keyProps, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bm.indent, key, onError);
    ctx.atKey = false;
    if (mapIncludes(ctx, map2.items, keyNode))
      onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
    const valueProps = resolveProps(sep12 ?? [], {
      indicator: "map-value-ind",
      next: value,
      offset: keyNode.range[2],
      onError,
      parentIndent: bm.indent,
      startOnNewline: !key || key.type === "block-scalar"
    });
    offset = valueProps.end;
    if (valueProps.found) {
      if (implicitKey) {
        if (value?.type === "block-map" && !valueProps.hasNewline)
          onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
        if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
          onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : composeEmptyNode2(ctx, offset, sep12, null, valueProps, onError);
      if (ctx.schema.compat)
        flowIndentCheck(bm.indent, value, onError);
      offset = valueNode.range[2];
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    } else {
      if (implicitKey)
        onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
      if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      map2.items.push(pair);
    }
  }
  if (commentEnd && commentEnd < offset)
    onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
  map2.range = [bm.offset, offset, commentEnd ?? offset];
  return map2;
}

// node_modules/yaml/browser/dist/compose/resolve-block-seq.js
function resolveBlockSeq({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, bs, onError, tag) {
  const NodeClass = tag?.nodeClass ?? YAMLSeq;
  const seq2 = new NodeClass(ctx.schema);
  if (ctx.atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = bs.offset;
  let commentEnd = null;
  for (const { start, value } of bs.items) {
    const props = resolveProps(start, {
      indicator: "seq-item-ind",
      next: value,
      offset,
      onError,
      parentIndent: bs.indent,
      startOnNewline: true
    });
    if (!props.found) {
      if (props.anchor || props.tag || value) {
        if (value?.type === "block-seq")
          onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
        else
          onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
      } else {
        commentEnd = props.end;
        if (props.comment)
          seq2.comment = props.comment;
        continue;
      }
    }
    const node = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, start, null, props, onError);
    if (ctx.schema.compat)
      flowIndentCheck(bs.indent, value, onError);
    offset = node.range[2];
    seq2.items.push(node);
  }
  seq2.range = [bs.offset, offset, commentEnd ?? offset];
  return seq2;
}

// node_modules/yaml/browser/dist/compose/resolve-end.js
function resolveEnd(end, offset, reqSpace, onError) {
  let comment = "";
  if (end) {
    let hasSpace = false;
    let sep12 = "";
    for (const token of end) {
      const { source, type } = token;
      switch (type) {
        case "space":
          hasSpace = true;
          break;
        case "comment": {
          if (reqSpace && !hasSpace)
            onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
          const cb = source.substring(1) || " ";
          if (!comment)
            comment = cb;
          else
            comment += sep12 + cb;
          sep12 = "";
          break;
        }
        case "newline":
          if (comment)
            sep12 += source;
          hasSpace = true;
          break;
        default:
          onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
      }
      offset += source.length;
    }
  }
  return { comment, offset };
}

// node_modules/yaml/browser/dist/compose/resolve-flow-collection.js
var blockMsg = "Block collections are not allowed within flow collections";
var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
function resolveFlowCollection({ composeNode: composeNode2, composeEmptyNode: composeEmptyNode2 }, ctx, fc, onError, tag) {
  const isMap2 = fc.start.source === "{";
  const fcName = isMap2 ? "flow map" : "flow sequence";
  const NodeClass = tag?.nodeClass ?? (isMap2 ? YAMLMap : YAMLSeq);
  const coll = new NodeClass(ctx.schema);
  coll.flow = true;
  const atRoot = ctx.atRoot;
  if (atRoot)
    ctx.atRoot = false;
  if (ctx.atKey)
    ctx.atKey = false;
  let offset = fc.offset + fc.start.source.length;
  for (let i = 0; i < fc.items.length; ++i) {
    const collItem = fc.items[i];
    const { start, key, sep: sep12, value } = collItem;
    const props = resolveProps(start, {
      flow: fcName,
      indicator: "explicit-key-ind",
      next: key ?? sep12?.[0],
      offset,
      onError,
      parentIndent: fc.indent,
      startOnNewline: false
    });
    if (!props.found) {
      if (!props.anchor && !props.tag && !sep12 && !value) {
        if (i === 0 && props.comma)
          onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        else if (i < fc.items.length - 1)
          onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
        if (props.comment) {
          if (coll.comment)
            coll.comment += "\n" + props.comment;
          else
            coll.comment = props.comment;
        }
        offset = props.end;
        continue;
      }
      if (!isMap2 && ctx.options.strict && containsNewline(key))
        onError(
          key,
          // checked by containsNewline()
          "MULTILINE_IMPLICIT_KEY",
          "Implicit keys of flow sequence pairs need to be on a single line"
        );
    }
    if (i === 0) {
      if (props.comma)
        onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
    } else {
      if (!props.comma)
        onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
      if (props.comment) {
        let prevItemComment = "";
        loop: for (const st of start) {
          switch (st.type) {
            case "comma":
            case "space":
              break;
            case "comment":
              prevItemComment = st.source.substring(1);
              break loop;
            default:
              break loop;
          }
        }
        if (prevItemComment) {
          let prev = coll.items[coll.items.length - 1];
          if (isPair(prev))
            prev = prev.value ?? prev.key;
          if (prev.comment)
            prev.comment += "\n" + prevItemComment;
          else
            prev.comment = prevItemComment;
          props.comment = props.comment.substring(prevItemComment.length + 1);
        }
      }
    }
    if (!isMap2 && !sep12 && !props.found) {
      const valueNode = value ? composeNode2(ctx, value, props, onError) : composeEmptyNode2(ctx, props.end, sep12, null, props, onError);
      coll.items.push(valueNode);
      offset = valueNode.range[2];
      if (isBlock(value))
        onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
    } else {
      ctx.atKey = true;
      const keyStart = props.end;
      const keyNode = key ? composeNode2(ctx, key, props, onError) : composeEmptyNode2(ctx, keyStart, start, null, props, onError);
      if (isBlock(key))
        onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
      ctx.atKey = false;
      const valueProps = resolveProps(sep12 ?? [], {
        flow: fcName,
        indicator: "map-value-ind",
        next: value,
        offset: keyNode.range[2],
        onError,
        parentIndent: fc.indent,
        startOnNewline: false
      });
      if (valueProps.found) {
        if (!isMap2 && !props.found && ctx.options.strict) {
          if (sep12)
            for (const st of sep12) {
              if (st === valueProps.found)
                break;
              if (st.type === "newline") {
                onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                break;
              }
            }
          if (props.start < valueProps.found.offset - 1024)
            onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
        }
      } else if (value) {
        if ("source" in value && value.source?.[0] === ":")
          onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
        else
          onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
      }
      const valueNode = value ? composeNode2(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode2(ctx, valueProps.end, sep12, null, valueProps, onError) : null;
      if (valueNode) {
        if (isBlock(value))
          onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
      } else if (valueProps.comment) {
        if (keyNode.comment)
          keyNode.comment += "\n" + valueProps.comment;
        else
          keyNode.comment = valueProps.comment;
      }
      const pair = new Pair(keyNode, valueNode);
      if (ctx.options.keepSourceTokens)
        pair.srcToken = collItem;
      if (isMap2) {
        const map2 = coll;
        if (mapIncludes(ctx, map2.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        map2.items.push(pair);
      } else {
        const map2 = new YAMLMap(ctx.schema);
        map2.flow = true;
        map2.items.push(pair);
        const endRange = (valueNode ?? keyNode).range;
        map2.range = [keyNode.range[0], endRange[1], endRange[2]];
        coll.items.push(map2);
      }
      offset = valueNode ? valueNode.range[2] : valueProps.end;
    }
  }
  const expectedEnd = isMap2 ? "}" : "]";
  const [ce, ...ee] = fc.end;
  let cePos = offset;
  if (ce?.source === expectedEnd)
    cePos = ce.offset + ce.source.length;
  else {
    const name = fcName[0].toUpperCase() + fcName.substring(1);
    const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
    onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
    if (ce && ce.source.length !== 1)
      ee.unshift(ce);
  }
  if (ee.length > 0) {
    const end = resolveEnd(ee, cePos, ctx.options.strict, onError);
    if (end.comment) {
      if (coll.comment)
        coll.comment += "\n" + end.comment;
      else
        coll.comment = end.comment;
    }
    coll.range = [fc.offset, cePos, end.offset];
  } else {
    coll.range = [fc.offset, cePos, cePos];
  }
  return coll;
}

// node_modules/yaml/browser/dist/compose/compose-collection.js
function resolveCollection(CN2, ctx, token, onError, tagName, tag) {
  const coll = token.type === "block-map" ? resolveBlockMap(CN2, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq(CN2, ctx, token, onError, tag) : resolveFlowCollection(CN2, ctx, token, onError, tag);
  const Coll = coll.constructor;
  if (tagName === "!" || tagName === Coll.tagName) {
    coll.tag = Coll.tagName;
    return coll;
  }
  if (tagName)
    coll.tag = tagName;
  return coll;
}
function composeCollection(CN2, ctx, token, props, onError) {
  const tagToken = props.tag;
  const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
  if (token.type === "block-seq") {
    const { anchor, newlineAfterProp: nl } = props;
    const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
    if (lastProp && (!nl || nl.offset < lastProp.offset)) {
      const message = "Missing newline after block sequence props";
      onError(lastProp, "MISSING_CHAR", message);
    }
  }
  const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
  if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.tagName && expType === "seq") {
    return resolveCollection(CN2, ctx, token, onError, tagName);
  }
  let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
  if (!tag) {
    const kt = ctx.schema.knownTags[tagName];
    if (kt?.collection === expType) {
      ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
      tag = kt;
    } else {
      if (kt) {
        onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
      } else {
        onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
      }
      return resolveCollection(CN2, ctx, token, onError, tagName);
    }
  }
  const coll = resolveCollection(CN2, ctx, token, onError, tagName, tag);
  const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
  const node = isNode(res) ? res : new Scalar(res);
  node.range = coll.range;
  node.tag = tagName;
  if (tag?.format)
    node.format = tag.format;
  return node;
}

// node_modules/yaml/browser/dist/compose/resolve-block-scalar.js
function resolveBlockScalar(ctx, scalar, onError) {
  const start = scalar.offset;
  const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
  if (!header)
    return { value: "", type: null, comment: "", range: [start, start, start] };
  const type = header.mode === ">" ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL;
  const lines = scalar.source ? splitLines(scalar.source) : [];
  let chompStart = lines.length;
  for (let i = lines.length - 1; i >= 0; --i) {
    const content = lines[i][1];
    if (content === "" || content === "\r")
      chompStart = i;
    else
      break;
  }
  if (chompStart === 0) {
    const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
    let end2 = start + header.length;
    if (scalar.source)
      end2 += scalar.source.length;
    return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
  }
  let trimIndent = scalar.indent + header.indent;
  let offset = scalar.offset + header.length;
  let contentStart = 0;
  for (let i = 0; i < chompStart; ++i) {
    const [indent, content] = lines[i];
    if (content === "" || content === "\r") {
      if (header.indent === 0 && indent.length > trimIndent)
        trimIndent = indent.length;
    } else {
      if (indent.length < trimIndent) {
        const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
        onError(offset + indent.length, "MISSING_CHAR", message);
      }
      if (header.indent === 0)
        trimIndent = indent.length;
      contentStart = i;
      if (trimIndent === 0 && !ctx.atRoot) {
        const message = "Block scalar values in collections must be indented";
        onError(offset, "BAD_INDENT", message);
      }
      break;
    }
    offset += indent.length + content.length + 1;
  }
  for (let i = lines.length - 1; i >= chompStart; --i) {
    if (lines[i][0].length > trimIndent)
      chompStart = i + 1;
  }
  let value = "";
  let sep12 = "";
  let prevMoreIndented = false;
  for (let i = 0; i < contentStart; ++i)
    value += lines[i][0].slice(trimIndent) + "\n";
  for (let i = contentStart; i < chompStart; ++i) {
    let [indent, content] = lines[i];
    offset += indent.length + content.length + 1;
    const crlf = content[content.length - 1] === "\r";
    if (crlf)
      content = content.slice(0, -1);
    if (content && indent.length < trimIndent) {
      const src = header.indent ? "explicit indentation indicator" : "first line";
      const message = `Block scalar lines must not be less indented than their ${src}`;
      onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
      indent = "";
    }
    if (type === Scalar.BLOCK_LITERAL) {
      value += sep12 + indent.slice(trimIndent) + content;
      sep12 = "\n";
    } else if (indent.length > trimIndent || content[0] === "	") {
      if (sep12 === " ")
        sep12 = "\n";
      else if (!prevMoreIndented && sep12 === "\n")
        sep12 = "\n\n";
      value += sep12 + indent.slice(trimIndent) + content;
      sep12 = "\n";
      prevMoreIndented = true;
    } else if (content === "") {
      if (sep12 === "\n")
        value += "\n";
      else
        sep12 = "\n";
    } else {
      value += sep12 + content;
      sep12 = " ";
      prevMoreIndented = false;
    }
  }
  switch (header.chomp) {
    case "-":
      break;
    case "+":
      for (let i = chompStart; i < lines.length; ++i)
        value += "\n" + lines[i][0].slice(trimIndent);
      if (value[value.length - 1] !== "\n")
        value += "\n";
      break;
    default:
      value += "\n";
  }
  const end = start + header.length + scalar.source.length;
  return { value, type, comment: header.comment, range: [start, end, end] };
}
function parseBlockScalarHeader({ offset, props }, strict, onError) {
  if (props[0].type !== "block-scalar-header") {
    onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
    return null;
  }
  const { source } = props[0];
  const mode = source[0];
  let indent = 0;
  let chomp = "";
  let error = -1;
  for (let i = 1; i < source.length; ++i) {
    const ch = source[i];
    if (!chomp && (ch === "-" || ch === "+"))
      chomp = ch;
    else {
      const n = Number(ch);
      if (!indent && n)
        indent = n;
      else if (error === -1)
        error = offset + i;
    }
  }
  if (error !== -1)
    onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
  let hasSpace = false;
  let comment = "";
  let length = source.length;
  for (let i = 1; i < props.length; ++i) {
    const token = props[i];
    switch (token.type) {
      case "space":
        hasSpace = true;
      // fallthrough
      case "newline":
        length += token.source.length;
        break;
      case "comment":
        if (strict && !hasSpace) {
          const message = "Comments must be separated from other tokens by white space characters";
          onError(token, "MISSING_CHAR", message);
        }
        length += token.source.length;
        comment = token.source.substring(1);
        break;
      case "error":
        onError(token, "UNEXPECTED_TOKEN", token.message);
        length += token.source.length;
        break;
      /* istanbul ignore next should not happen */
      default: {
        const message = `Unexpected token in block scalar header: ${token.type}`;
        onError(token, "UNEXPECTED_TOKEN", message);
        const ts = token.source;
        if (ts && typeof ts === "string")
          length += ts.length;
      }
    }
  }
  return { mode, indent, chomp, comment, length };
}
function splitLines(source) {
  const split = source.split(/\n( *)/);
  const first = split[0];
  const m = first.match(/^( *)/);
  const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
  const lines = [line0];
  for (let i = 1; i < split.length; i += 2)
    lines.push([split[i], split[i + 1]]);
  return lines;
}

// node_modules/yaml/browser/dist/compose/resolve-flow-scalar.js
function resolveFlowScalar(scalar, strict, onError) {
  const { offset, type, source, end } = scalar;
  let _type;
  let value;
  const _onError = (rel, code2, msg) => onError(offset + rel, code2, msg);
  switch (type) {
    case "scalar":
      _type = Scalar.PLAIN;
      value = plainValue(source, _onError);
      break;
    case "single-quoted-scalar":
      _type = Scalar.QUOTE_SINGLE;
      value = singleQuotedValue(source, _onError);
      break;
    case "double-quoted-scalar":
      _type = Scalar.QUOTE_DOUBLE;
      value = doubleQuotedValue(source, _onError);
      break;
    /* istanbul ignore next should not happen */
    default:
      onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
      return {
        value: "",
        type: null,
        comment: "",
        range: [offset, offset + source.length, offset + source.length]
      };
  }
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, strict, onError);
  return {
    value,
    type: _type,
    comment: re.comment,
    range: [offset, valueEnd, re.offset]
  };
}
function plainValue(source, onError) {
  let badChar = "";
  switch (source[0]) {
    /* istanbul ignore next should not happen */
    case "	":
      badChar = "a tab character";
      break;
    case ",":
      badChar = "flow indicator character ,";
      break;
    case "%":
      badChar = "directive indicator character %";
      break;
    case "|":
    case ">": {
      badChar = `block scalar indicator ${source[0]}`;
      break;
    }
    case "@":
    case "`": {
      badChar = `reserved character ${source[0]}`;
      break;
    }
  }
  if (badChar)
    onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
  return foldLines(source);
}
function singleQuotedValue(source, onError) {
  if (source[source.length - 1] !== "'" || source.length === 1)
    onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
  return foldLines(source.slice(1, -1)).replace(/''/g, "'");
}
function foldLines(source) {
  let first, line;
  try {
    first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
    line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
  } catch {
    first = /(.*?)[ \t]*\r?\n/sy;
    line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
  }
  let match = first.exec(source);
  if (!match)
    return source;
  let res = match[1];
  let sep12 = " ";
  let pos = first.lastIndex;
  line.lastIndex = pos;
  while (match = line.exec(source)) {
    if (match[1] === "") {
      if (sep12 === "\n")
        res += sep12;
      else
        sep12 = "\n";
    } else {
      res += sep12 + match[1];
      sep12 = " ";
    }
    pos = line.lastIndex;
  }
  const last = /[ \t]*(.*)/sy;
  last.lastIndex = pos;
  match = last.exec(source);
  return res + sep12 + (match?.[1] ?? "");
}
function doubleQuotedValue(source, onError) {
  let res = "";
  for (let i = 1; i < source.length - 1; ++i) {
    const ch = source[i];
    if (ch === "\r" && source[i + 1] === "\n")
      continue;
    if (ch === "\n") {
      const { fold, offset } = foldNewline(source, i);
      res += fold;
      i = offset;
    } else if (ch === "\\") {
      let next = source[++i];
      const cc = escapeCodes[next];
      if (cc)
        res += cc;
      else if (next === "\n") {
        next = source[i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "\r" && source[i + 1] === "\n") {
        next = source[++i + 1];
        while (next === " " || next === "	")
          next = source[++i + 1];
      } else if (next === "x" || next === "u" || next === "U") {
        const length = next === "x" ? 2 : next === "u" ? 4 : 8;
        res += parseCharCode(source, i + 1, length, onError);
        i += length;
      } else {
        const raw = source.substr(i - 1, 2);
        onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        res += raw;
      }
    } else if (ch === " " || ch === "	") {
      const wsStart = i;
      let next = source[i + 1];
      while (next === " " || next === "	")
        next = source[++i + 1];
      if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
        res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
    } else {
      res += ch;
    }
  }
  if (source[source.length - 1] !== '"' || source.length === 1)
    onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
  return res;
}
function foldNewline(source, offset) {
  let fold = "";
  let ch = source[offset + 1];
  while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
    if (ch === "\r" && source[offset + 2] !== "\n")
      break;
    if (ch === "\n")
      fold += "\n";
    offset += 1;
    ch = source[offset + 1];
  }
  if (!fold)
    fold = " ";
  return { fold, offset };
}
var escapeCodes = {
  "0": "\0",
  // null character
  a: "\x07",
  // bell character
  b: "\b",
  // backspace
  e: "\x1B",
  // escape character
  f: "\f",
  // form feed
  n: "\n",
  // line feed
  r: "\r",
  // carriage return
  t: "	",
  // horizontal tab
  v: "\v",
  // vertical tab
  N: "\x85",
  // Unicode next line
  _: "\xA0",
  // Unicode non-breaking space
  L: "\u2028",
  // Unicode line separator
  P: "\u2029",
  // Unicode paragraph separator
  " ": " ",
  '"': '"',
  "/": "/",
  "\\": "\\",
  "	": "	"
};
function parseCharCode(source, offset, length, onError) {
  const cc = source.substr(offset, length);
  const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
  const code2 = ok ? parseInt(cc, 16) : NaN;
  try {
    return String.fromCodePoint(code2);
  } catch {
    const raw = source.substr(offset - 2, length + 2);
    onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
    return raw;
  }
}

// node_modules/yaml/browser/dist/compose/compose-scalar.js
function composeScalar(ctx, token, tagToken, onError) {
  const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar(ctx, token, onError) : resolveFlowScalar(token, ctx.options.strict, onError);
  const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
  let tag;
  if (ctx.options.stringKeys && ctx.atKey) {
    tag = ctx.schema[SCALAR];
  } else if (tagName)
    tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
  else if (token.type === "scalar")
    tag = findScalarTagByTest(ctx, value, token, onError);
  else
    tag = ctx.schema[SCALAR];
  let scalar;
  try {
    const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
    scalar = isScalar(res) ? res : new Scalar(res);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
    scalar = new Scalar(value);
  }
  scalar.range = range;
  scalar.source = value;
  if (type)
    scalar.type = type;
  if (tagName)
    scalar.tag = tagName;
  if (tag.format)
    scalar.format = tag.format;
  if (comment)
    scalar.comment = comment;
  return scalar;
}
function findScalarTagByName(schema4, value, tagName, tagToken, onError) {
  if (tagName === "!")
    return schema4[SCALAR];
  const matchWithTest = [];
  for (const tag of schema4.tags) {
    if (!tag.collection && tag.tag === tagName) {
      if (tag.default && tag.test)
        matchWithTest.push(tag);
      else
        return tag;
    }
  }
  for (const tag of matchWithTest)
    if (tag.test?.test(value))
      return tag;
  const kt = schema4.knownTags[tagName];
  if (kt && !kt.collection) {
    schema4.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
    return kt;
  }
  onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
  return schema4[SCALAR];
}
function findScalarTagByTest({ atKey, directives, schema: schema4 }, value, token, onError) {
  const tag = schema4.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema4[SCALAR];
  if (schema4.compat) {
    const compat = schema4.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema4[SCALAR];
    if (tag.tag !== compat.tag) {
      const ts = directives.tagString(tag.tag);
      const cs = directives.tagString(compat.tag);
      const msg = `Value may be parsed as either ${ts} or ${cs}`;
      onError(token, "TAG_RESOLVE_FAILED", msg, true);
    }
  }
  return tag;
}

// node_modules/yaml/browser/dist/compose/util-empty-scalar-position.js
function emptyScalarPosition(offset, before, pos) {
  if (before) {
    pos ?? (pos = before.length);
    for (let i = pos - 1; i >= 0; --i) {
      let st = before[i];
      switch (st.type) {
        case "space":
        case "comment":
        case "newline":
          offset -= st.source.length;
          continue;
      }
      st = before[++i];
      while (st?.type === "space") {
        offset += st.source.length;
        st = before[++i];
      }
      break;
    }
  }
  return offset;
}

// node_modules/yaml/browser/dist/compose/compose-node.js
var CN = { composeNode, composeEmptyNode };
function composeNode(ctx, token, props, onError) {
  const atKey = ctx.atKey;
  const { spaceBefore, comment, anchor, tag } = props;
  let node;
  let isSrcToken = true;
  switch (token.type) {
    case "alias":
      node = composeAlias(ctx, token, onError);
      if (anchor || tag)
        onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
      break;
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "block-scalar":
      node = composeScalar(ctx, token, tag, onError);
      if (anchor)
        node.anchor = anchor.source.substring(1);
      break;
    case "block-map":
    case "block-seq":
    case "flow-collection":
      try {
        node = composeCollection(CN, ctx, token, props, onError);
        if (anchor)
          node.anchor = anchor.source.substring(1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(token, "RESOURCE_EXHAUSTION", message);
      }
      break;
    default: {
      const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
      onError(token, "UNEXPECTED_TOKEN", message);
      isSrcToken = false;
    }
  }
  node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
  if (anchor && node.anchor === "")
    onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  if (atKey && ctx.options.stringKeys && (!isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
    const msg = "With stringKeys, all keys must be strings";
    onError(tag ?? token, "NON_STRING_KEY", msg);
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    if (token.type === "scalar" && token.source === "")
      node.comment = comment;
    else
      node.commentBefore = comment;
  }
  if (ctx.options.keepSourceTokens && isSrcToken)
    node.srcToken = token;
  return node;
}
function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
  const token = {
    type: "scalar",
    offset: emptyScalarPosition(offset, before, pos),
    indent: -1,
    source: ""
  };
  const node = composeScalar(ctx, token, tag, onError);
  if (anchor) {
    node.anchor = anchor.source.substring(1);
    if (node.anchor === "")
      onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
  }
  if (spaceBefore)
    node.spaceBefore = true;
  if (comment) {
    node.comment = comment;
    node.range[2] = end;
  }
  return node;
}
function composeAlias({ options }, { offset, source, end }, onError) {
  const alias = new Alias(source.substring(1));
  if (alias.source === "")
    onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
  if (alias.source.endsWith(":"))
    onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
  const valueEnd = offset + source.length;
  const re = resolveEnd(end, valueEnd, options.strict, onError);
  alias.range = [offset, valueEnd, re.offset];
  if (re.comment)
    alias.comment = re.comment;
  return alias;
}

// node_modules/yaml/browser/dist/compose/compose-doc.js
function composeDoc(options, directives, { offset, start, value, end }, onError) {
  const opts = Object.assign({ _directives: directives }, options);
  const doc = new Document(void 0, opts);
  const ctx = {
    atKey: false,
    atRoot: true,
    directives: doc.directives,
    options: doc.options,
    schema: doc.schema
  };
  const props = resolveProps(start, {
    indicator: "doc-start",
    next: value ?? end?.[0],
    offset,
    onError,
    parentIndent: 0,
    startOnNewline: true
  });
  if (props.found) {
    doc.directives.docStart = true;
    if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
      onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
  }
  doc.contents = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
  const contentEnd = doc.contents.range[2];
  const re = resolveEnd(end, contentEnd, false, onError);
  if (re.comment)
    doc.comment = re.comment;
  doc.range = [offset, contentEnd, re.offset];
  return doc;
}

// node_modules/yaml/browser/dist/compose/composer.js
function getErrorPos(src) {
  if (typeof src === "number")
    return [src, src + 1];
  if (Array.isArray(src))
    return src.length === 2 ? src : [src[0], src[1]];
  const { offset, source } = src;
  return [offset, offset + (typeof source === "string" ? source.length : 1)];
}
function parsePrelude(prelude) {
  let comment = "";
  let atComment = false;
  let afterEmptyLine = false;
  for (let i = 0; i < prelude.length; ++i) {
    const source = prelude[i];
    switch (source[0]) {
      case "#":
        comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
        atComment = true;
        afterEmptyLine = false;
        break;
      case "%":
        if (prelude[i + 1]?.[0] !== "#")
          i += 1;
        atComment = false;
        break;
      default:
        if (!atComment)
          afterEmptyLine = true;
        atComment = false;
    }
  }
  return { comment, afterEmptyLine };
}
var Composer = class {
  constructor(options = {}) {
    this.doc = null;
    this.atDirectives = false;
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
    this.onError = (source, code2, message, warning) => {
      const pos = getErrorPos(source);
      if (warning)
        this.warnings.push(new YAMLWarning(pos, code2, message));
      else
        this.errors.push(new YAMLParseError(pos, code2, message));
    };
    this.directives = new Directives({ version: options.version || "1.2" });
    this.options = options;
  }
  decorate(doc, afterDoc) {
    const { comment, afterEmptyLine } = parsePrelude(this.prelude);
    if (comment) {
      const dc = doc.contents;
      if (afterDoc) {
        doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
      } else if (afterEmptyLine || doc.directives.docStart || !dc) {
        doc.commentBefore = comment;
      } else if (isCollection(dc) && !dc.flow && dc.items.length > 0) {
        let it = dc.items[0];
        if (isPair(it))
          it = it.key;
        const cb = it.commentBefore;
        it.commentBefore = cb ? `${comment}
${cb}` : comment;
      } else {
        const cb = dc.commentBefore;
        dc.commentBefore = cb ? `${comment}
${cb}` : comment;
      }
    }
    if (afterDoc) {
      for (let i = 0; i < this.errors.length; ++i)
        doc.errors.push(this.errors[i]);
      for (let i = 0; i < this.warnings.length; ++i)
        doc.warnings.push(this.warnings[i]);
    } else {
      doc.errors = this.errors;
      doc.warnings = this.warnings;
    }
    this.prelude = [];
    this.errors = [];
    this.warnings = [];
  }
  /**
   * Current stream status information.
   *
   * Mostly useful at the end of input for an empty stream.
   */
  streamInfo() {
    return {
      comment: parsePrelude(this.prelude).comment,
      directives: this.directives,
      errors: this.errors,
      warnings: this.warnings
    };
  }
  /**
   * Compose tokens into documents.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *compose(tokens, forceDoc = false, endOffset = -1) {
    for (const token of tokens)
      yield* this.next(token);
    yield* this.end(forceDoc, endOffset);
  }
  /** Advance the composer by one CST token. */
  *next(token) {
    switch (token.type) {
      case "directive":
        this.directives.add(token.source, (offset, message, warning) => {
          const pos = getErrorPos(token);
          pos[0] += offset;
          this.onError(pos, "BAD_DIRECTIVE", message, warning);
        });
        this.prelude.push(token.source);
        this.atDirectives = true;
        break;
      case "document": {
        const doc = composeDoc(this.options, this.directives, token, this.onError);
        if (this.atDirectives && !doc.directives.docStart)
          this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
        this.decorate(doc, false);
        if (this.doc)
          yield this.doc;
        this.doc = doc;
        this.atDirectives = false;
        break;
      }
      case "byte-order-mark":
      case "space":
        break;
      case "comment":
      case "newline":
        this.prelude.push(token.source);
        break;
      case "error": {
        const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
        const error = new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
        if (this.atDirectives || !this.doc)
          this.errors.push(error);
        else
          this.doc.errors.push(error);
        break;
      }
      case "doc-end": {
        if (!this.doc) {
          const msg = "Unexpected doc-end without preceding document";
          this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
          break;
        }
        this.doc.directives.docEnd = true;
        const end = resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
        this.decorate(this.doc, true);
        if (end.comment) {
          const dc = this.doc.comment;
          this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
        }
        this.doc.range[2] = end.offset;
        break;
      }
      default:
        this.errors.push(new YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
    }
  }
  /**
   * Call at end of input to yield any remaining document.
   *
   * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
   * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
   */
  *end(forceDoc = false, endOffset = -1) {
    if (this.doc) {
      this.decorate(this.doc, true);
      yield this.doc;
      this.doc = null;
    } else if (forceDoc) {
      const opts = Object.assign({ _directives: this.directives }, this.options);
      const doc = new Document(void 0, opts);
      if (this.atDirectives)
        this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
      doc.range = [0, endOffset, endOffset];
      this.decorate(doc, false);
      yield doc;
    }
  }
};

// node_modules/yaml/browser/dist/parse/cst-visit.js
var BREAK2 = Symbol("break visit");
var SKIP2 = Symbol("skip children");
var REMOVE2 = Symbol("remove item");
function visit2(cst, visitor) {
  if ("type" in cst && cst.type === "document")
    cst = { start: cst.start, value: cst.value };
  _visit(Object.freeze([]), cst, visitor);
}
visit2.BREAK = BREAK2;
visit2.SKIP = SKIP2;
visit2.REMOVE = REMOVE2;
visit2.itemAtPath = (cst, path) => {
  let item2 = cst;
  for (const [field, index] of path) {
    const tok = item2?.[field];
    if (tok && "items" in tok) {
      item2 = tok.items[index];
    } else
      return void 0;
  }
  return item2;
};
visit2.parentCollection = (cst, path) => {
  const parent = visit2.itemAtPath(cst, path.slice(0, -1));
  const field = path[path.length - 1][0];
  const coll = parent?.[field];
  if (coll && "items" in coll)
    return coll;
  throw new Error("Parent collection not found");
};
function _visit(path, item2, visitor) {
  let ctrl = visitor(item2, path);
  if (typeof ctrl === "symbol")
    return ctrl;
  for (const field of ["key", "value"]) {
    const token = item2[field];
    if (token && "items" in token) {
      for (let i = 0; i < token.items.length; ++i) {
        const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
        if (typeof ci === "number")
          i = ci - 1;
        else if (ci === BREAK2)
          return BREAK2;
        else if (ci === REMOVE2) {
          token.items.splice(i, 1);
          i -= 1;
        }
      }
      if (typeof ctrl === "function" && field === "key")
        ctrl = ctrl(item2, path);
    }
  }
  return typeof ctrl === "function" ? ctrl(item2, path) : ctrl;
}

// node_modules/yaml/browser/dist/parse/cst.js
var BOM = "\uFEFF";
var DOCUMENT = "";
var FLOW_END = "";
var SCALAR2 = "";
function tokenType(source) {
  switch (source) {
    case BOM:
      return "byte-order-mark";
    case DOCUMENT:
      return "doc-mode";
    case FLOW_END:
      return "flow-error-end";
    case SCALAR2:
      return "scalar";
    case "---":
      return "doc-start";
    case "...":
      return "doc-end";
    case "":
    case "\n":
    case "\r\n":
      return "newline";
    case "-":
      return "seq-item-ind";
    case "?":
      return "explicit-key-ind";
    case ":":
      return "map-value-ind";
    case "{":
      return "flow-map-start";
    case "}":
      return "flow-map-end";
    case "[":
      return "flow-seq-start";
    case "]":
      return "flow-seq-end";
    case ",":
      return "comma";
  }
  switch (source[0]) {
    case " ":
    case "	":
      return "space";
    case "#":
      return "comment";
    case "%":
      return "directive-line";
    case "*":
      return "alias";
    case "&":
      return "anchor";
    case "!":
      return "tag";
    case "'":
      return "single-quoted-scalar";
    case '"':
      return "double-quoted-scalar";
    case "|":
    case ">":
      return "block-scalar-header";
  }
  return null;
}

// node_modules/yaml/browser/dist/parse/lexer.js
function isEmpty(ch) {
  switch (ch) {
    case void 0:
    case " ":
    case "\n":
    case "\r":
    case "	":
      return true;
    default:
      return false;
  }
}
var hexDigits = new Set("0123456789ABCDEFabcdef");
var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
var flowIndicatorChars = new Set(",[]{}");
var invalidAnchorChars = new Set(" ,[]{}\n\r	");
var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
var Lexer = class {
  constructor() {
    this.atEnd = false;
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    this.buffer = "";
    this.flowKey = false;
    this.flowLevel = 0;
    this.indentNext = 0;
    this.indentValue = 0;
    this.lineEndPos = null;
    this.next = null;
    this.pos = 0;
  }
  /**
   * Generate YAML tokens from the `source` string. If `incomplete`,
   * a part of the last line may be left as a buffer for the next call.
   *
   * @returns A generator of lexical tokens
   */
  *lex(source, incomplete = false) {
    if (source) {
      if (typeof source !== "string")
        throw TypeError("source is not a string");
      this.buffer = this.buffer ? this.buffer + source : source;
      this.lineEndPos = null;
    }
    this.atEnd = !incomplete;
    let next = this.next ?? "stream";
    while (next && (incomplete || this.hasChars(1)))
      next = yield* this.parseNext(next);
  }
  atLineEnd() {
    let i = this.pos;
    let ch = this.buffer[i];
    while (ch === " " || ch === "	")
      ch = this.buffer[++i];
    if (!ch || ch === "#" || ch === "\n")
      return true;
    if (ch === "\r")
      return this.buffer[i + 1] === "\n";
    return false;
  }
  charAt(n) {
    return this.buffer[this.pos + n];
  }
  continueScalar(offset) {
    let ch = this.buffer[offset];
    if (this.indentNext > 0) {
      let indent = 0;
      while (ch === " ")
        ch = this.buffer[++indent + offset];
      if (ch === "\r") {
        const next = this.buffer[indent + offset + 1];
        if (next === "\n" || !next && !this.atEnd)
          return offset + indent + 1;
      }
      return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
    }
    if (ch === "-" || ch === ".") {
      const dt = this.buffer.substr(offset, 3);
      if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
        return -1;
    }
    return offset;
  }
  getLine() {
    let end = this.lineEndPos;
    if (typeof end !== "number" || end !== -1 && end < this.pos) {
      end = this.buffer.indexOf("\n", this.pos);
      this.lineEndPos = end;
    }
    if (end === -1)
      return this.atEnd ? this.buffer.substring(this.pos) : null;
    if (this.buffer[end - 1] === "\r")
      end -= 1;
    return this.buffer.substring(this.pos, end);
  }
  hasChars(n) {
    return this.pos + n <= this.buffer.length;
  }
  setNext(state) {
    this.buffer = this.buffer.substring(this.pos);
    this.pos = 0;
    this.lineEndPos = null;
    this.next = state;
    return null;
  }
  peek(n) {
    return this.buffer.substr(this.pos, n);
  }
  *parseNext(next) {
    switch (next) {
      case "stream":
        return yield* this.parseStream();
      case "line-start":
        return yield* this.parseLineStart();
      case "block-start":
        return yield* this.parseBlockStart();
      case "doc":
        return yield* this.parseDocument();
      case "flow":
        return yield* this.parseFlowCollection();
      case "quoted-scalar":
        return yield* this.parseQuotedScalar();
      case "block-scalar":
        return yield* this.parseBlockScalar();
      case "plain-scalar":
        return yield* this.parsePlainScalar();
    }
  }
  *parseStream() {
    let line = this.getLine();
    if (line === null)
      return this.setNext("stream");
    if (line[0] === BOM) {
      yield* this.pushCount(1);
      line = line.substring(1);
    }
    if (line[0] === "%") {
      let dirEnd = line.length;
      let cs = line.indexOf("#");
      while (cs !== -1) {
        const ch = line[cs - 1];
        if (ch === " " || ch === "	") {
          dirEnd = cs - 1;
          break;
        } else {
          cs = line.indexOf("#", cs + 1);
        }
      }
      while (true) {
        const ch = line[dirEnd - 1];
        if (ch === " " || ch === "	")
          dirEnd -= 1;
        else
          break;
      }
      const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
      yield* this.pushCount(line.length - n);
      this.pushNewline();
      return "stream";
    }
    if (this.atLineEnd()) {
      const sp = yield* this.pushSpaces(true);
      yield* this.pushCount(line.length - sp);
      yield* this.pushNewline();
      return "stream";
    }
    yield DOCUMENT;
    return yield* this.parseLineStart();
  }
  *parseLineStart() {
    const ch = this.charAt(0);
    if (!ch && !this.atEnd)
      return this.setNext("line-start");
    if (ch === "-" || ch === ".") {
      if (!this.atEnd && !this.hasChars(4))
        return this.setNext("line-start");
      const s = this.peek(3);
      if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
        yield* this.pushCount(3);
        this.indentValue = 0;
        this.indentNext = 0;
        return s === "---" ? "doc" : "stream";
      }
    }
    this.indentValue = yield* this.pushSpaces(false);
    if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
      this.indentNext = this.indentValue;
    return yield* this.parseBlockStart();
  }
  *parseBlockStart() {
    const [ch0, ch1] = this.peek(2);
    if (!ch1 && !this.atEnd)
      return this.setNext("block-start");
    if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
      const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
      this.indentNext = this.indentValue + 1;
      this.indentValue += n;
      return "block-start";
    }
    return "doc";
  }
  *parseDocument() {
    yield* this.pushSpaces(true);
    const line = this.getLine();
    if (line === null)
      return this.setNext("doc");
    let n = yield* this.pushIndicators();
    switch (line[n]) {
      case "#":
        yield* this.pushCount(line.length - n);
      // fallthrough
      case void 0:
        yield* this.pushNewline();
        return yield* this.parseLineStart();
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel = 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        return "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "doc";
      case '"':
      case "'":
        return yield* this.parseQuotedScalar();
      case "|":
      case ">":
        n += yield* this.parseBlockScalarHeader();
        n += yield* this.pushSpaces(true);
        yield* this.pushCount(line.length - n);
        yield* this.pushNewline();
        return yield* this.parseBlockScalar();
      default:
        return yield* this.parsePlainScalar();
    }
  }
  *parseFlowCollection() {
    let nl, sp;
    let indent = -1;
    do {
      nl = yield* this.pushNewline();
      if (nl > 0) {
        sp = yield* this.pushSpaces(false);
        this.indentValue = indent = sp;
      } else {
        sp = 0;
      }
      sp += yield* this.pushSpaces(true);
    } while (nl + sp > 0);
    const line = this.getLine();
    if (line === null)
      return this.setNext("flow");
    if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
      const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
      if (!atFlowEndMarker) {
        this.flowLevel = 0;
        yield FLOW_END;
        return yield* this.parseLineStart();
      }
    }
    let n = 0;
    while (line[n] === ",") {
      n += yield* this.pushCount(1);
      n += yield* this.pushSpaces(true);
      this.flowKey = false;
    }
    n += yield* this.pushIndicators();
    switch (line[n]) {
      case void 0:
        return "flow";
      case "#":
        yield* this.pushCount(line.length - n);
        return "flow";
      case "{":
      case "[":
        yield* this.pushCount(1);
        this.flowKey = false;
        this.flowLevel += 1;
        return "flow";
      case "}":
      case "]":
        yield* this.pushCount(1);
        this.flowKey = true;
        this.flowLevel -= 1;
        return this.flowLevel ? "flow" : "doc";
      case "*":
        yield* this.pushUntil(isNotAnchorChar);
        return "flow";
      case '"':
      case "'":
        this.flowKey = true;
        return yield* this.parseQuotedScalar();
      case ":": {
        const next = this.charAt(1);
        if (this.flowKey || isEmpty(next) || next === ",") {
          this.flowKey = false;
          yield* this.pushCount(1);
          yield* this.pushSpaces(true);
          return "flow";
        }
      }
      // fallthrough
      default:
        this.flowKey = false;
        return yield* this.parsePlainScalar();
    }
  }
  *parseQuotedScalar() {
    const quote = this.charAt(0);
    let end = this.buffer.indexOf(quote, this.pos + 1);
    if (quote === "'") {
      while (end !== -1 && this.buffer[end + 1] === "'")
        end = this.buffer.indexOf("'", end + 2);
    } else {
      while (end !== -1) {
        let n = 0;
        while (this.buffer[end - 1 - n] === "\\")
          n += 1;
        if (n % 2 === 0)
          break;
        end = this.buffer.indexOf('"', end + 1);
      }
    }
    const qb = this.buffer.substring(0, end);
    let nl = qb.indexOf("\n", this.pos);
    if (nl !== -1) {
      while (nl !== -1) {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = qb.indexOf("\n", cs);
      }
      if (nl !== -1) {
        end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
      }
    }
    if (end === -1) {
      if (!this.atEnd)
        return this.setNext("quoted-scalar");
      end = this.buffer.length;
    }
    yield* this.pushToIndex(end + 1, false);
    return this.flowLevel ? "flow" : "doc";
  }
  *parseBlockScalarHeader() {
    this.blockScalarIndent = -1;
    this.blockScalarKeep = false;
    let i = this.pos;
    while (true) {
      const ch = this.buffer[++i];
      if (ch === "+")
        this.blockScalarKeep = true;
      else if (ch > "0" && ch <= "9")
        this.blockScalarIndent = Number(ch) - 1;
      else if (ch !== "-")
        break;
    }
    return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
  }
  *parseBlockScalar() {
    let nl = this.pos - 1;
    let indent = 0;
    let ch;
    loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
      switch (ch) {
        case " ":
          indent += 1;
          break;
        case "\n":
          nl = i2;
          indent = 0;
          break;
        case "\r": {
          const next = this.buffer[i2 + 1];
          if (!next && !this.atEnd)
            return this.setNext("block-scalar");
          if (next === "\n")
            break;
        }
        // fallthrough
        default:
          break loop;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("block-scalar");
    if (indent >= this.indentNext) {
      if (this.blockScalarIndent === -1)
        this.indentNext = indent;
      else {
        this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
      }
      do {
        const cs = this.continueScalar(nl + 1);
        if (cs === -1)
          break;
        nl = this.buffer.indexOf("\n", cs);
      } while (nl !== -1);
      if (nl === -1) {
        if (!this.atEnd)
          return this.setNext("block-scalar");
        nl = this.buffer.length;
      }
    }
    let i = nl + 1;
    ch = this.buffer[i];
    while (ch === " ")
      ch = this.buffer[++i];
    if (ch === "	") {
      while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
        ch = this.buffer[++i];
      nl = i - 1;
    } else if (!this.blockScalarKeep) {
      do {
        let i2 = nl - 1;
        let ch2 = this.buffer[i2];
        if (ch2 === "\r")
          ch2 = this.buffer[--i2];
        const lastChar = i2;
        while (ch2 === " ")
          ch2 = this.buffer[--i2];
        if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
          nl = i2;
        else
          break;
      } while (true);
    }
    yield SCALAR2;
    yield* this.pushToIndex(nl + 1, true);
    return yield* this.parseLineStart();
  }
  *parsePlainScalar() {
    const inFlow = this.flowLevel > 0;
    let end = this.pos - 1;
    let i = this.pos - 1;
    let ch;
    while (ch = this.buffer[++i]) {
      if (ch === ":") {
        const next = this.buffer[i + 1];
        if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
          break;
        end = i;
      } else if (isEmpty(ch)) {
        let next = this.buffer[i + 1];
        if (ch === "\r") {
          if (next === "\n") {
            i += 1;
            ch = "\n";
            next = this.buffer[i + 1];
          } else
            end = i;
        }
        if (next === "#" || inFlow && flowIndicatorChars.has(next))
          break;
        if (ch === "\n") {
          const cs = this.continueScalar(i + 1);
          if (cs === -1)
            break;
          i = Math.max(i, cs - 2);
        }
      } else {
        if (inFlow && flowIndicatorChars.has(ch))
          break;
        end = i;
      }
    }
    if (!ch && !this.atEnd)
      return this.setNext("plain-scalar");
    yield SCALAR2;
    yield* this.pushToIndex(end + 1, true);
    return inFlow ? "flow" : "doc";
  }
  *pushCount(n) {
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos += n;
      return n;
    }
    return 0;
  }
  *pushToIndex(i, allowEmpty) {
    const s = this.buffer.slice(this.pos, i);
    if (s) {
      yield s;
      this.pos += s.length;
      return s.length;
    } else if (allowEmpty)
      yield "";
    return 0;
  }
  *pushIndicators() {
    let n = 0;
    loop: while (true) {
      switch (this.charAt(0)) {
        case "!":
          n += yield* this.pushTag();
          n += yield* this.pushSpaces(true);
          continue loop;
        case "&":
          n += yield* this.pushUntil(isNotAnchorChar);
          n += yield* this.pushSpaces(true);
          continue loop;
        case "-":
        // this is an error
        case "?":
        // this is an error outside flow collections
        case ":": {
          const inFlow = this.flowLevel > 0;
          const ch1 = this.charAt(1);
          if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
            if (!inFlow)
              this.indentNext = this.indentValue + 1;
            else if (this.flowKey)
              this.flowKey = false;
            n += yield* this.pushCount(1);
            n += yield* this.pushSpaces(true);
            continue loop;
          }
        }
      }
      break loop;
    }
    return n;
  }
  *pushTag() {
    if (this.charAt(1) === "<") {
      let i = this.pos + 2;
      let ch = this.buffer[i];
      while (!isEmpty(ch) && ch !== ">")
        ch = this.buffer[++i];
      return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
    } else {
      let i = this.pos + 1;
      let ch = this.buffer[i];
      while (ch) {
        if (tagChars.has(ch))
          ch = this.buffer[++i];
        else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
          ch = this.buffer[i += 3];
        } else
          break;
      }
      return yield* this.pushToIndex(i, false);
    }
  }
  *pushNewline() {
    const ch = this.buffer[this.pos];
    if (ch === "\n")
      return yield* this.pushCount(1);
    else if (ch === "\r" && this.charAt(1) === "\n")
      return yield* this.pushCount(2);
    else
      return 0;
  }
  *pushSpaces(allowTabs) {
    let i = this.pos - 1;
    let ch;
    do {
      ch = this.buffer[++i];
    } while (ch === " " || allowTabs && ch === "	");
    const n = i - this.pos;
    if (n > 0) {
      yield this.buffer.substr(this.pos, n);
      this.pos = i;
    }
    return n;
  }
  *pushUntil(test) {
    let i = this.pos;
    let ch = this.buffer[i];
    while (!test(ch))
      ch = this.buffer[++i];
    return yield* this.pushToIndex(i, false);
  }
};

// node_modules/yaml/browser/dist/parse/line-counter.js
var LineCounter = class {
  constructor() {
    this.lineStarts = [];
    this.addNewLine = (offset) => this.lineStarts.push(offset);
    this.linePos = (offset) => {
      let low = 0;
      let high = this.lineStarts.length;
      while (low < high) {
        const mid = low + high >> 1;
        if (this.lineStarts[mid] < offset)
          low = mid + 1;
        else
          high = mid;
      }
      if (this.lineStarts[low] === offset)
        return { line: low + 1, col: 1 };
      if (low === 0)
        return { line: 0, col: offset };
      const start = this.lineStarts[low - 1];
      return { line: low, col: offset - start + 1 };
    };
  }
};

// node_modules/yaml/browser/dist/parse/parser.js
function includesToken(list, type) {
  for (let i = 0; i < list.length; ++i)
    if (list[i].type === type)
      return true;
  return false;
}
function findNonEmptyIndex(list) {
  for (let i = 0; i < list.length; ++i) {
    switch (list[i].type) {
      case "space":
      case "comment":
      case "newline":
        break;
      default:
        return i;
    }
  }
  return -1;
}
function isFlowToken(token) {
  switch (token?.type) {
    case "alias":
    case "scalar":
    case "single-quoted-scalar":
    case "double-quoted-scalar":
    case "flow-collection":
      return true;
    default:
      return false;
  }
}
function getPrevProps(parent) {
  switch (parent.type) {
    case "document":
      return parent.start;
    case "block-map": {
      const it = parent.items[parent.items.length - 1];
      return it.sep ?? it.start;
    }
    case "block-seq":
      return parent.items[parent.items.length - 1].start;
    /* istanbul ignore next should not happen */
    default:
      return [];
  }
}
function getFirstKeyStartProps(prev) {
  if (prev.length === 0)
    return [];
  let i = prev.length;
  loop: while (--i >= 0) {
    switch (prev[i].type) {
      case "doc-start":
      case "explicit-key-ind":
      case "map-value-ind":
      case "seq-item-ind":
      case "newline":
        break loop;
    }
  }
  while (prev[++i]?.type === "space") {
  }
  return prev.splice(i, prev.length);
}
function arrayPushArray(target, source) {
  if (source.length < 1e5)
    Array.prototype.push.apply(target, source);
  else
    for (let i = 0; i < source.length; ++i)
      target.push(source[i]);
}
function fixFlowSeqItems(fc) {
  if (fc.start.type === "flow-seq-start") {
    for (const it of fc.items) {
      if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
        if (it.key)
          it.value = it.key;
        delete it.key;
        if (isFlowToken(it.value)) {
          if (it.value.end)
            arrayPushArray(it.value.end, it.sep);
          else
            it.value.end = it.sep;
        } else
          arrayPushArray(it.start, it.sep);
        delete it.sep;
      }
    }
  }
}
var Parser = class {
  /**
   * @param onNewLine - If defined, called separately with the start position of
   *   each new line (in `parse()`, including the start of input).
   */
  constructor(onNewLine) {
    this.atNewLine = true;
    this.atScalar = false;
    this.indent = 0;
    this.offset = 0;
    this.onKeyLine = false;
    this.stack = [];
    this.source = "";
    this.type = "";
    this.lexer = new Lexer();
    this.onNewLine = onNewLine;
  }
  /**
   * Parse `source` as a YAML stream.
   * If `incomplete`, a part of the last line may be left as a buffer for the next call.
   *
   * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
   *
   * @returns A generator of tokens representing each directive, document, and other structure.
   */
  *parse(source, incomplete = false) {
    if (this.onNewLine && this.offset === 0)
      this.onNewLine(0);
    for (const lexeme of this.lexer.lex(source, incomplete))
      yield* this.next(lexeme);
    if (!incomplete)
      yield* this.end();
  }
  /**
   * Advance the parser by the `source` of one lexical token.
   */
  *next(source) {
    this.source = source;
    if (this.atScalar) {
      this.atScalar = false;
      yield* this.step();
      this.offset += source.length;
      return;
    }
    const type = tokenType(source);
    if (!type) {
      const message = `Not a YAML token: ${source}`;
      yield* this.pop({ type: "error", offset: this.offset, message, source });
      this.offset += source.length;
    } else if (type === "scalar") {
      this.atNewLine = false;
      this.atScalar = true;
      this.type = "scalar";
    } else {
      this.type = type;
      yield* this.step();
      switch (type) {
        case "newline":
          this.atNewLine = true;
          this.indent = 0;
          if (this.onNewLine)
            this.onNewLine(this.offset + source.length);
          break;
        case "space":
          if (this.atNewLine && source[0] === " ")
            this.indent += source.length;
          break;
        case "explicit-key-ind":
        case "map-value-ind":
        case "seq-item-ind":
          if (this.atNewLine)
            this.indent += source.length;
          break;
        case "doc-mode":
        case "flow-error-end":
          return;
        default:
          this.atNewLine = false;
      }
      this.offset += source.length;
    }
  }
  /** Call at end of input to push out any remaining constructions */
  *end() {
    while (this.stack.length > 0)
      yield* this.pop();
  }
  get sourceToken() {
    const st = {
      type: this.type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
    return st;
  }
  *step() {
    const top = this.peek(1);
    if (this.type === "doc-end" && top?.type !== "doc-end") {
      while (this.stack.length > 0)
        yield* this.pop();
      this.stack.push({
        type: "doc-end",
        offset: this.offset,
        source: this.source
      });
      return;
    }
    if (!top)
      return yield* this.stream();
    switch (top.type) {
      case "document":
        return yield* this.document(top);
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return yield* this.scalar(top);
      case "block-scalar":
        return yield* this.blockScalar(top);
      case "block-map":
        return yield* this.blockMap(top);
      case "block-seq":
        return yield* this.blockSequence(top);
      case "flow-collection":
        return yield* this.flowCollection(top);
      case "doc-end":
        return yield* this.documentEnd(top);
    }
    yield* this.pop();
  }
  peek(n) {
    return this.stack[this.stack.length - n];
  }
  *pop(error) {
    const token = error ?? this.stack.pop();
    if (!token) {
      const message = "Tried to pop an empty stack";
      yield { type: "error", offset: this.offset, source: "", message };
    } else if (this.stack.length === 0) {
      yield token;
    } else {
      const top = this.peek(1);
      if (token.type === "block-scalar") {
        token.indent = "indent" in top ? top.indent : 0;
      } else if (token.type === "flow-collection" && top.type === "document") {
        token.indent = 0;
      }
      if (token.type === "flow-collection")
        fixFlowSeqItems(token);
      switch (top.type) {
        case "document":
          top.value = token;
          break;
        case "block-scalar":
          top.props.push(token);
          break;
        case "block-map": {
          const it = top.items[top.items.length - 1];
          if (it.value) {
            top.items.push({ start: [], key: token, sep: [] });
            this.onKeyLine = true;
            return;
          } else if (it.sep) {
            it.value = token;
          } else {
            Object.assign(it, { key: token, sep: [] });
            this.onKeyLine = !it.explicitKey;
            return;
          }
          break;
        }
        case "block-seq": {
          const it = top.items[top.items.length - 1];
          if (it.value)
            top.items.push({ start: [], value: token });
          else
            it.value = token;
          break;
        }
        case "flow-collection": {
          const it = top.items[top.items.length - 1];
          if (!it || it.value)
            top.items.push({ start: [], key: token, sep: [] });
          else if (it.sep)
            it.value = token;
          else
            Object.assign(it, { key: token, sep: [] });
          return;
        }
        /* istanbul ignore next should not happen */
        default:
          yield* this.pop();
          yield* this.pop(token);
      }
      if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
        const last = token.items[token.items.length - 1];
        if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
          if (top.type === "document")
            top.end = last.start;
          else
            top.items.push({ start: last.start });
          token.items.splice(-1, 1);
        }
      }
    }
  }
  *stream() {
    switch (this.type) {
      case "directive-line":
        yield { type: "directive", offset: this.offset, source: this.source };
        return;
      case "byte-order-mark":
      case "space":
      case "comment":
      case "newline":
        yield this.sourceToken;
        return;
      case "doc-mode":
      case "doc-start": {
        const doc = {
          type: "document",
          offset: this.offset,
          start: []
        };
        if (this.type === "doc-start")
          doc.start.push(this.sourceToken);
        this.stack.push(doc);
        return;
      }
    }
    yield {
      type: "error",
      offset: this.offset,
      message: `Unexpected ${this.type} token in YAML stream`,
      source: this.source
    };
  }
  *document(doc) {
    if (doc.value)
      return yield* this.lineEnd(doc);
    switch (this.type) {
      case "doc-start": {
        if (findNonEmptyIndex(doc.start) !== -1) {
          yield* this.pop();
          yield* this.step();
        } else
          doc.start.push(this.sourceToken);
        return;
      }
      case "anchor":
      case "tag":
      case "space":
      case "comment":
      case "newline":
        doc.start.push(this.sourceToken);
        return;
    }
    const bv = this.startBlockValue(doc);
    if (bv)
      this.stack.push(bv);
    else {
      yield {
        type: "error",
        offset: this.offset,
        message: `Unexpected ${this.type} token in YAML document`,
        source: this.source
      };
    }
  }
  *scalar(scalar) {
    if (this.type === "map-value-ind") {
      const prev = getPrevProps(this.peek(2));
      const start = getFirstKeyStartProps(prev);
      let sep12;
      if (scalar.end) {
        sep12 = scalar.end;
        sep12.push(this.sourceToken);
        delete scalar.end;
      } else
        sep12 = [this.sourceToken];
      const map2 = {
        type: "block-map",
        offset: scalar.offset,
        indent: scalar.indent,
        items: [{ start, key: scalar, sep: sep12 }]
      };
      this.onKeyLine = true;
      this.stack[this.stack.length - 1] = map2;
    } else
      yield* this.lineEnd(scalar);
  }
  *blockScalar(scalar) {
    switch (this.type) {
      case "space":
      case "comment":
      case "newline":
        scalar.props.push(this.sourceToken);
        return;
      case "scalar":
        scalar.source = this.source;
        this.atNewLine = true;
        this.indent = 0;
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        yield* this.pop();
        break;
      /* istanbul ignore next should not happen */
      default:
        yield* this.pop();
        yield* this.step();
    }
  }
  *blockMap(map2) {
    const it = map2.items[map2.items.length - 1];
    switch (this.type) {
      case "newline":
        this.onKeyLine = false;
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          it.start.push(this.sourceToken);
        }
        return;
      case "space":
      case "comment":
        if (it.value) {
          map2.items.push({ start: [this.sourceToken] });
        } else if (it.sep) {
          it.sep.push(this.sourceToken);
        } else {
          if (this.atIndentedComment(it.start, map2.indent)) {
            const prev = map2.items[map2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              map2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
    }
    if (this.indent >= map2.indent) {
      const atMapIndent = !this.onKeyLine && this.indent === map2.indent;
      const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
      let start = [];
      if (atNextItem && it.sep && !it.value) {
        const nl = [];
        for (let i = 0; i < it.sep.length; ++i) {
          const st = it.sep[i];
          switch (st.type) {
            case "newline":
              nl.push(i);
              break;
            case "space":
              break;
            case "comment":
              if (st.indent > map2.indent)
                nl.length = 0;
              break;
            default:
              nl.length = 0;
          }
        }
        if (nl.length >= 2)
          start = it.sep.splice(nl[1]);
      }
      switch (this.type) {
        case "anchor":
        case "tag":
          if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start });
            this.onKeyLine = true;
          } else if (it.sep) {
            it.sep.push(this.sourceToken);
          } else {
            it.start.push(this.sourceToken);
          }
          return;
        case "explicit-key-ind":
          if (!it.sep && !it.explicitKey) {
            it.start.push(this.sourceToken);
            it.explicitKey = true;
          } else if (atNextItem || it.value) {
            start.push(this.sourceToken);
            map2.items.push({ start, explicitKey: true });
          } else {
            this.stack.push({
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken], explicitKey: true }]
            });
          }
          this.onKeyLine = true;
          return;
        case "map-value-ind":
          if (it.explicitKey) {
            if (!it.sep) {
              if (includesToken(it.start, "newline")) {
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              } else {
                const start2 = getFirstKeyStartProps(it.start);
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                });
              }
            } else if (it.value) {
              map2.items.push({ start: [], key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start, key: null, sep: [this.sourceToken] }]
              });
            } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
              const start2 = getFirstKeyStartProps(it.start);
              const key = it.key;
              const sep12 = it.sep;
              sep12.push(this.sourceToken);
              delete it.key;
              delete it.sep;
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: start2, key, sep: sep12 }]
              });
            } else if (start.length > 0) {
              it.sep = it.sep.concat(start, this.sourceToken);
            } else {
              it.sep.push(this.sourceToken);
            }
          } else {
            if (!it.sep) {
              Object.assign(it, { key: null, sep: [this.sourceToken] });
            } else if (it.value || atNextItem) {
              map2.items.push({ start, key: null, sep: [this.sourceToken] });
            } else if (includesToken(it.sep, "map-value-ind")) {
              this.stack.push({
                type: "block-map",
                offset: this.offset,
                indent: this.indent,
                items: [{ start: [], key: null, sep: [this.sourceToken] }]
              });
            } else {
              it.sep.push(this.sourceToken);
            }
          }
          this.onKeyLine = true;
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (atNextItem || it.value) {
            map2.items.push({ start, key: fs, sep: [] });
            this.onKeyLine = true;
          } else if (it.sep) {
            this.stack.push(fs);
          } else {
            Object.assign(it, { key: fs, sep: [] });
            this.onKeyLine = true;
          }
          return;
        }
        default: {
          const bv = this.startBlockValue(map2);
          if (bv) {
            if (bv.type === "block-seq") {
              if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                yield* this.pop({
                  type: "error",
                  offset: this.offset,
                  message: "Unexpected block-seq-ind on same line with key",
                  source: this.source
                });
                return;
              }
            } else if (atMapIndent) {
              map2.items.push({ start });
            }
            this.stack.push(bv);
            return;
          }
        }
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *blockSequence(seq2) {
    const it = seq2.items[seq2.items.length - 1];
    switch (this.type) {
      case "newline":
        if (it.value) {
          const end = "end" in it.value ? it.value.end : void 0;
          const last = Array.isArray(end) ? end[end.length - 1] : void 0;
          if (last?.type === "comment")
            end?.push(this.sourceToken);
          else
            seq2.items.push({ start: [this.sourceToken] });
        } else
          it.start.push(this.sourceToken);
        return;
      case "space":
      case "comment":
        if (it.value)
          seq2.items.push({ start: [this.sourceToken] });
        else {
          if (this.atIndentedComment(it.start, seq2.indent)) {
            const prev = seq2.items[seq2.items.length - 2];
            const end = prev?.value?.end;
            if (Array.isArray(end)) {
              arrayPushArray(end, it.start);
              end.push(this.sourceToken);
              seq2.items.pop();
              return;
            }
          }
          it.start.push(this.sourceToken);
        }
        return;
      case "anchor":
      case "tag":
        if (it.value || this.indent <= seq2.indent)
          break;
        it.start.push(this.sourceToken);
        return;
      case "seq-item-ind":
        if (this.indent !== seq2.indent)
          break;
        if (it.value || includesToken(it.start, "seq-item-ind"))
          seq2.items.push({ start: [this.sourceToken] });
        else
          it.start.push(this.sourceToken);
        return;
    }
    if (this.indent > seq2.indent) {
      const bv = this.startBlockValue(seq2);
      if (bv) {
        this.stack.push(bv);
        return;
      }
    }
    yield* this.pop();
    yield* this.step();
  }
  *flowCollection(fc) {
    const it = fc.items[fc.items.length - 1];
    if (this.type === "flow-error-end") {
      let top;
      do {
        yield* this.pop();
        top = this.peek(1);
      } while (top?.type === "flow-collection");
    } else if (fc.end.length === 0) {
      switch (this.type) {
        case "comma":
        case "explicit-key-ind":
          if (!it || it.sep)
            fc.items.push({ start: [this.sourceToken] });
          else
            it.start.push(this.sourceToken);
          return;
        case "map-value-ind":
          if (!it || it.value)
            fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            Object.assign(it, { key: null, sep: [this.sourceToken] });
          return;
        case "space":
        case "comment":
        case "newline":
        case "anchor":
        case "tag":
          if (!it || it.value)
            fc.items.push({ start: [this.sourceToken] });
          else if (it.sep)
            it.sep.push(this.sourceToken);
          else
            it.start.push(this.sourceToken);
          return;
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar": {
          const fs = this.flowScalar(this.type);
          if (!it || it.value)
            fc.items.push({ start: [], key: fs, sep: [] });
          else if (it.sep)
            this.stack.push(fs);
          else
            Object.assign(it, { key: fs, sep: [] });
          return;
        }
        case "flow-map-end":
        case "flow-seq-end":
          fc.end.push(this.sourceToken);
          return;
      }
      const bv = this.startBlockValue(fc);
      if (bv)
        this.stack.push(bv);
      else {
        yield* this.pop();
        yield* this.step();
      }
    } else {
      const parent = this.peek(2);
      if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
        yield* this.pop();
        yield* this.step();
      } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        fixFlowSeqItems(fc);
        const sep12 = fc.end.splice(1, fc.end.length);
        sep12.push(this.sourceToken);
        const map2 = {
          type: "block-map",
          offset: fc.offset,
          indent: fc.indent,
          items: [{ start, key: fc, sep: sep12 }]
        };
        this.onKeyLine = true;
        this.stack[this.stack.length - 1] = map2;
      } else {
        yield* this.lineEnd(fc);
      }
    }
  }
  flowScalar(type) {
    if (this.onNewLine) {
      let nl = this.source.indexOf("\n") + 1;
      while (nl !== 0) {
        this.onNewLine(this.offset + nl);
        nl = this.source.indexOf("\n", nl) + 1;
      }
    }
    return {
      type,
      offset: this.offset,
      indent: this.indent,
      source: this.source
    };
  }
  startBlockValue(parent) {
    switch (this.type) {
      case "alias":
      case "scalar":
      case "single-quoted-scalar":
      case "double-quoted-scalar":
        return this.flowScalar(this.type);
      case "block-scalar-header":
        return {
          type: "block-scalar",
          offset: this.offset,
          indent: this.indent,
          props: [this.sourceToken],
          source: ""
        };
      case "flow-map-start":
      case "flow-seq-start":
        return {
          type: "flow-collection",
          offset: this.offset,
          indent: this.indent,
          start: this.sourceToken,
          items: [],
          end: []
        };
      case "seq-item-ind":
        return {
          type: "block-seq",
          offset: this.offset,
          indent: this.indent,
          items: [{ start: [this.sourceToken] }]
        };
      case "explicit-key-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        start.push(this.sourceToken);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, explicitKey: true }]
        };
      }
      case "map-value-ind": {
        this.onKeyLine = true;
        const prev = getPrevProps(parent);
        const start = getFirstKeyStartProps(prev);
        return {
          type: "block-map",
          offset: this.offset,
          indent: this.indent,
          items: [{ start, key: null, sep: [this.sourceToken] }]
        };
      }
    }
    return null;
  }
  atIndentedComment(start, indent) {
    if (this.type !== "comment")
      return false;
    if (this.indent <= indent)
      return false;
    return start.every((st) => st.type === "newline" || st.type === "space");
  }
  *documentEnd(docEnd) {
    if (this.type !== "doc-mode") {
      if (docEnd.end)
        docEnd.end.push(this.sourceToken);
      else
        docEnd.end = [this.sourceToken];
      if (this.type === "newline")
        yield* this.pop();
    }
  }
  *lineEnd(token) {
    switch (this.type) {
      case "comma":
      case "doc-start":
      case "doc-end":
      case "flow-seq-end":
      case "flow-map-end":
      case "map-value-ind":
        yield* this.pop();
        yield* this.step();
        break;
      case "newline":
        this.onKeyLine = false;
      // fallthrough
      case "space":
      case "comment":
      default:
        if (token.end)
          token.end.push(this.sourceToken);
        else
          token.end = [this.sourceToken];
        if (this.type === "newline")
          yield* this.pop();
    }
  }
};

// node_modules/yaml/browser/dist/public-api.js
function parseOptions(options) {
  const prettyErrors = options.prettyErrors !== false;
  const lineCounter = options.lineCounter || prettyErrors && new LineCounter() || null;
  return { lineCounter, prettyErrors };
}
function parseDocument(source, options = {}) {
  const { lineCounter, prettyErrors } = parseOptions(options);
  const parser = new Parser(lineCounter?.addNewLine);
  const composer = new Composer(options);
  let doc = null;
  for (const _doc of composer.compose(parser.parse(source), true, source.length)) {
    if (!doc)
      doc = _doc;
    else if (doc.options.logLevel !== "silent") {
      doc.errors.push(new YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
      break;
    }
  }
  if (prettyErrors && lineCounter) {
    doc.errors.forEach(prettifyError(source, lineCounter));
    doc.warnings.forEach(prettifyError(source, lineCounter));
  }
  return doc;
}

// src/upgrade/manager-plan.ts
var UPDATE_PLAN_SCHEMA = "agent-vigil-update-plan/v1";
var UPDATE_PLAN_MAX_CHANGES = 4097;
var LIMITATIONS2 = [
  "This plan proves only how two bounded manager states differ; it does not execute, install, or declare an update safe.",
  "Only UPDATED records with distinct exact artifact integrity on both sides are eligible for behavioral preflight.",
  "ADDED and REMOVED records require separate policy review because no old/new behavior pair exists."
];
function hash4(value) {
  return `sha256:${createHash17("sha256").update(value).digest("hex")}`;
}
function canonicalYamlNode(value) {
  let nodes = 0;
  const visit3 = (item2, depth) => {
    nodes += 1;
    if (nodes > 1e5 || depth > 64) throw new Error("APM YAML state exceeds canonicalization bounds");
    if (item2 && typeof item2 === "object" && "anchor" in item2 && typeof item2.anchor === "string") {
      throw new Error("APM YAML anchors and aliases are not accepted");
    }
    if (isScalar(item2)) {
      return ["scalar", item2.type ?? null, item2.tag ?? null, item2.source ?? null];
    }
    if (isSeq(item2)) return ["sequence", item2.items.map((entry) => visit3(entry, depth + 1))];
    if (isMap(item2)) {
      const entries = item2.items.map((pair) => {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          throw new Error("APM YAML mapping keys must be strings");
        }
        return [pair.key.value, visit3(pair.value, depth + 1)];
      }).sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
      return ["mapping", entries];
    }
    if (item2 === null) return ["empty"];
    throw new Error("APM YAML aliases and unsupported nodes are not accepted");
  };
  return visit3(value, 0);
}
function canonicalJsonNode(value) {
  let nodes = 0;
  const visit3 = (item2, depth) => {
    nodes += 1;
    if (nodes > 1e5 || depth > 64) throw new Error("manager JSON state exceeds canonicalization bounds");
    if (isScalar(item2)) {
      const scalar = item2.value;
      if (typeof scalar === "number") {
        const source = item2.source;
        if (typeof source !== "string" || source.length > 1024 || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(source)) {
          throw new Error("manager JSON contains an unsupported number representation");
        }
        return ["scalar", "number", source];
      }
      return scalar === null ? ["scalar", "null"] : ["scalar", typeof scalar, scalar];
    }
    if (isSeq(item2)) return ["sequence", item2.items.map((entry) => visit3(entry, depth + 1))];
    if (isMap(item2)) {
      const entries = item2.items.map((pair) => {
        if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
          throw new Error("manager JSON mapping keys must be strings");
        }
        return [pair.key.value, visit3(pair.value, depth + 1)];
      }).sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
      return ["mapping", entries];
    }
    throw new Error("manager JSON contains an unsupported node");
  };
  return visit3(value, 0);
}
function yamlMapEntries(value, label) {
  if (!isMap(value)) throw new Error(`${label} must be a YAML mapping`);
  return value.items.map((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error(`${label} keys must be strings`);
    }
    return [pair.key.value, pair.value];
  });
}
function yamlEntriesCommitment(entries) {
  const normalized = entries.map(([key, value]) => [key, canonicalYamlNode(value)]).sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
  return canonical(["mapping", normalized]);
}
function selectedYamlCommitment(entries, fields) {
  return canonical(["mapping", fields.map((field) => [
    field,
    entries.has(field) ? canonicalYamlNode(entries.get(field)) : ["absent"]
  ])]);
}
function jsonMapEntries(value, label) {
  if (!isMap(value)) throw new Error(`${label} must be a JSON object`);
  return value.items.map((pair) => {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") {
      throw new Error(`${label} keys must be strings`);
    }
    return [pair.key.value, pair.value];
  });
}
function jsonEntriesCommitment(entries) {
  const normalized = entries.map(([key, value]) => [key, canonicalJsonNode(value)]).sort(([left], [right]) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
  return canonical(["mapping", normalized]);
}
function selectedJsonCommitment(entries, fields) {
  return canonical(["mapping", fields.map((field) => [
    field,
    entries.has(field) ? canonicalJsonNode(entries.get(field)) : ["absent"]
  ])]);
}
function record4(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function text3(value, label, maximum = 2048) {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}
function optionalText(value, label, maximum = 2048) {
  return value === void 0 || value === null ? void 0 : text3(value, label, maximum);
}
function strictUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}
function strictJsonDocument(bytes, label) {
  const source = strictUtf8(bytes, label);
  try {
    JSON.parse(source);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const document = parseDocument(source, { schema: "json", uniqueKeys: true });
  if (document.errors.length) throw new Error(`${label} is invalid JSON`);
  return { value: document.toJS({ maxAliasCount: 0 }), node: document.contents };
}
function strictJson(bytes, label) {
  return strictJsonDocument(bytes, label).value;
}
function regularBytes(path, maximum, label) {
  const requested = resolve15(path);
  const beforePath = lstatSync6(requested, { bigint: true });
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
  if (beforePath.size > BigInt(maximum)) throw new Error(`${label} exceeds ${maximum} bytes`);
  const descriptor = openSync3(requested, "r");
  try {
    const before = fstatSync3(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw new Error(`${label} changed while it was opened`);
    }
    const bytes = readFileSync18(descriptor);
    const after = fstatSync3(descriptor, { bigint: true });
    const afterPath = lstatSync6(requested, { bigint: true });
    if (bytes.length > maximum || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.dev !== afterPath.dev || after.ino !== afterPath.ino || afterPath.isSymbolicLink()) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    closeSync3(descriptor);
  }
}
function exactSha256(value) {
  if (!value) return void 0;
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  return /^sha256:[0-9a-f]{64}$/.test(normalized) ? normalized : void 0;
}
function exactGitCommit(value) {
  return value && /^[0-9a-f]{40}$/.test(value) ? value : void 0;
}
function apmEndpoint(item2, index) {
  const commit2 = exactGitCommit(optionalText(item2.resolved_commit, `dependencies[${index}].resolved_commit`, 64));
  const treeHash = exactSha256(optionalText(item2.tree_sha256, `dependencies[${index}].tree_sha256`, 80));
  const resolvedHash = exactSha256(optionalText(item2.resolved_hash, `dependencies[${index}].resolved_hash`, 80));
  const contentHash = exactSha256(optionalText(item2.content_hash, `dependencies[${index}].content_hash`, 80));
  optionalText(item2.version, `dependencies[${index}].version`, 128);
  optionalText(item2.resolved_tag, `dependencies[${index}].resolved_tag`, 128);
  optionalText(item2.resolved_ref, `dependencies[${index}].resolved_ref`, 128);
  const version = commit2 ? `commit:${commit2.slice(0, 12)}` : treeHash ? `digest:${treeHash.slice(7, 19)}` : resolvedHash ? `digest:${resolvedHash.slice(7, 19)}` : contentHash ? `digest:${contentHash.slice(7, 19)}` : "unbound";
  if (treeHash) return { version, integrityKind: "sha256", integrity: treeHash };
  if (commit2) return { version, integrityKind: "git-commit", integrity: commit2 };
  if (resolvedHash) return { version, integrityKind: "sha256", integrity: resolvedHash };
  if (contentHash) return { version, integrityKind: "sha256", integrity: contentHash };
  return { version, integrityKind: "unbound", integrity: "unavailable" };
}
var APM_DIAGNOSTIC_TOP_LEVEL_FIELDS = /* @__PURE__ */ new Set(["generated_at", "apm_version"]);
var APM_WORKSPACE_REASON_GROUPS = {
  "APM lockfile format changed": ["lockfile_version"],
  "APM MCP command, arguments, server, target, or ownership state changed": [
    "mcp_servers",
    "mcp_configs",
    "mcp_target_servers",
    "mcp_config_provenance"
  ],
  "APM LSP runtime configuration changed": ["lsp_servers", "lsp_configs"],
  "APM local deployment state changed": ["local_deployed_files", "local_deployed_file_hashes"],
  "APM canonical deployment ledger changed": ["deployments"]
};
function apmWorkspaceRecord(root, yamlEntries) {
  const yamlByName = new Map(yamlEntries);
  const workspaceEntries = yamlEntries.filter(([field]) => field !== "dependencies" && !APM_DIAGNOSTIC_TOP_LEVEL_FIELDS.has(field));
  const workspaceIntegrity = hash4(yamlEntriesCommitment(workspaceEntries));
  const groupedFields = new Set(Object.values(APM_WORKSPACE_REASON_GROUPS).flat());
  const reasonFingerprints = Object.fromEntries([
    ...Object.entries(APM_WORKSPACE_REASON_GROUPS).map(([reason, fields]) => [
      reason,
      hash4(selectedYamlCommitment(yamlByName, fields))
    ]),
    [
      "other APM additive workspace state changed",
      hash4(yamlEntriesCommitment(workspaceEntries.filter(([field]) => !groupedFields.has(field))))
    ]
  ]);
  const lockfileVersion = text3(root.lockfile_version, "APM lockfile_version", 8);
  return {
    identity: "apm:workspace",
    displayName: "APM workspace state",
    componentType: "apm-workspace",
    endpoint: {
      version: `lockfile-v${lockfileVersion}:${workspaceIntegrity.slice(7, 19)}`,
      integrityKind: "sha256",
      integrity: workspaceIntegrity
    },
    fingerprint: workspaceIntegrity,
    reasonFingerprints
  };
}
function parseApm(bytes) {
  const document = parseDocument(strictUtf8(bytes, "APM lockfile"), {
    // OpenAPM req-mf-020 requires untagged scalar values to remain strings.
    schema: "failsafe",
    uniqueKeys: true
  });
  if (document.errors.length) throw new Error("APM lockfile is invalid YAML");
  if (document.warnings.length) throw new Error("APM lockfile uses unsupported YAML syntax");
  canonicalYamlNode(document.contents);
  const rootEntries = yamlMapEntries(document.contents, "APM lockfile");
  const root = record4(document.toJS({ maxAliasCount: 0 }), "APM lockfile");
  if (root.lockfile_version !== "1" && root.lockfile_version !== "2") {
    throw new Error("APM lockfile_version must be 1 or 2");
  }
  if (!Array.isArray(root.dependencies) || root.dependencies.length > 4096) {
    throw new Error("APM dependencies must be an array of at most 4096 entries");
  }
  const workspace = apmWorkspaceRecord(root, rootEntries);
  const output = /* @__PURE__ */ new Map([[workspace.identity, workspace]]);
  const dependencyNode = new Map(rootEntries).get("dependencies");
  if (!isSeq(dependencyNode) || dependencyNode.items.length !== root.dependencies.length) {
    throw new Error("APM dependencies YAML state is inconsistent");
  }
  root.dependencies.forEach((raw, index) => {
    const item2 = record4(raw, `dependencies[${index}]`);
    const repoUrl = text3(item2.repo_url, `dependencies[${index}].repo_url`);
    const host = optionalText(item2.host, `dependencies[${index}].host`, 255) ?? "";
    const source = optionalText(item2.source, `dependencies[${index}].source`, 80) ?? "git";
    const localPath = optionalText(item2.local_path, `dependencies[${index}].local_path`, 1024) ?? "";
    optionalText(item2.name, `dependencies[${index}].name`, 160);
    const identity = `apm:${hash4(canonical({ host, source, repoUrl, localPath })).slice(7)}`;
    if (output.has(identity)) throw new Error(`APM lockfile contains duplicate dependency identity: ${identity}`);
    const endpoint = apmEndpoint(item2, index);
    const fingerprint = hash4(canonical(canonicalYamlNode(dependencyNode.items[index])));
    output.set(identity, {
      identity,
      // APM names and repository URLs are manager-controlled private strings.
      // Use the stable pseudonymous identity for display in JSON and terminals.
      displayName: `APM dependency ${identity.slice(4, 16)}`,
      componentType: "apm-package",
      endpoint,
      fingerprint,
      apmRow: item2
    });
  });
  return output;
}
var SKILLS_DIAGNOSTIC_ENTRY_FIELDS = /* @__PURE__ */ new Set(["installedAt", "updatedAt"]);
var SKILLS_SOURCE_TYPES = /* @__PURE__ */ new Set(["github", "git", "gitlab", "mintlify", "huggingface", "local", "well-known"]);
var SKILLS_TREE_SOURCE_TYPES = /* @__PURE__ */ new Set(["github"]);
var SKILLS_CLONE_SOURCE_TYPES = /* @__PURE__ */ new Set(["github", "git", "gitlab"]);
var SKILLS_ENTRY_REASON_GROUPS = {
  "Skills source, ref, path, or update route changed": [
    "source",
    "sourceType",
    "sourceUrl",
    "ref",
    "skillPath",
    "sourceBaseUrl"
  ],
  "Skills exact content identity changed": ["skillFolderHash", "wellKnownDigest"],
  "Skills plugin ownership changed": ["pluginName"]
};
function skillsWorkspaceRecord(rootEntries) {
  const managerEntries = rootEntries.filter(([field]) => field !== "skills");
  const managerByName = new Map(managerEntries);
  const preferenceFields = ["dismissed", "lastSelectedAgents"];
  const integrity = hash4(jsonEntriesCommitment(managerEntries));
  return {
    identity: "skills:workspace",
    displayName: "Skills manager state",
    componentType: "skills-workspace",
    endpoint: {
      version: `lockfile-v3:${integrity.slice(7, 19)}`,
      integrityKind: "sha256",
      integrity
    },
    fingerprint: integrity,
    reasonFingerprints: {
      "Skills prompt or installation-target preference changed": hash4(selectedJsonCommitment(managerByName, preferenceFields)),
      "other Skills additive manager state changed": hash4(jsonEntriesCommitment(
        managerEntries.filter(([field]) => !preferenceFields.includes(field))
      ))
    }
  };
}
function skillsEndpoint(name, item2, sourceType, ref) {
  if (typeof item2.skillFolderHash !== "string" || item2.skillFolderHash.length > 128 || item2.skillFolderHash.includes("\0")) {
    throw new Error(`skills.${name}.skillFolderHash must be a bounded string`);
  }
  const folderHash = item2.skillFolderHash;
  const digestText = optionalText(item2.wellKnownDigest, `skills.${name}.wellKnownDigest`, 80);
  const wellKnownDigest = digestText && /^sha256:[0-9a-f]{64}$/.test(digestText) ? digestText : void 0;
  if (digestText && !wellKnownDigest) throw new Error(`skills.${name}.wellKnownDigest is not an exact sha256 identity`);
  if (sourceType === "well-known") {
    if (folderHash !== "") throw new Error(`skills.${name}.skillFolderHash must be empty for a well-known source`);
    if (!wellKnownDigest) throw new Error(`skills.${name}.wellKnownDigest is required for a well-known source`);
    exactHttpsUrl(item2.sourceUrl, `skills.${name}.sourceUrl`);
    exactHttpsUrl(item2.sourceBaseUrl, `skills.${name}.sourceBaseUrl`);
    return {
      version: ref ?? `digest:${wellKnownDigest.slice(7, 19)}`,
      integrityKind: "sha256",
      integrity: wellKnownDigest
    };
  }
  if (Object.prototype.hasOwnProperty.call(item2, "wellKnownDigest")) {
    throw new Error(`skills.${name}.wellKnownDigest is supported only for a well-known source`);
  }
  if (Object.prototype.hasOwnProperty.call(item2, "sourceBaseUrl")) {
    throw new Error(`skills.${name}.sourceBaseUrl is supported only for a well-known source`);
  }
  if (sourceType === "local") {
    return { version: ref ?? "local", integrityKind: "unbound", integrity: "unavailable" };
  }
  if (/^[0-9a-f]{40}$/.test(folderHash)) {
    if (!SKILLS_TREE_SOURCE_TYPES.has(sourceType)) {
      throw new Error(`skills.${name}.skillFolderHash Git tree identity is unsupported for sourceType ${sourceType}`);
    }
    return {
      version: ref ?? `tree:${folderHash.slice(0, 12)}`,
      integrityKind: "git-tree",
      integrity: folderHash
    };
  }
  if (/^[0-9a-f]{64}$/.test(folderHash)) {
    const digest5 = `sha256:${folderHash}`;
    return {
      version: ref ?? `digest:${folderHash.slice(0, 12)}`,
      integrityKind: "sha256",
      integrity: digest5
    };
  }
  throw new Error(`skills.${name}.skillFolderHash is not an exact 40-character Git tree or 64-character SHA-256 identity`);
}
function exactUtcTimestamp(value, label) {
  const result5 = text3(value, label, 64);
  const milliseconds = Date.parse(result5);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== result5) {
    throw new Error(`${label} must be an exact UTC ISO timestamp`);
  }
  return result5;
}
function exactHttpsUrl(value, label) {
  const result5 = text3(value, label, 2048);
  try {
    const parsed = new URL(result5);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error("unsupported URL");
  } catch {
    throw new Error(`${label} must be a credential-free HTTPS URL without a fragment`);
  }
  return result5;
}
function optionalSkillsText(item2, field, label, maximum) {
  if (!Object.prototype.hasOwnProperty.call(item2, field)) return void 0;
  return text3(item2[field], label, maximum);
}
function skillsSourceUrl(value, label, sourceType) {
  const result5 = text3(value, label, 2048);
  if (sourceType === "local") return result5;
  if (SKILLS_CLONE_SOURCE_TYPES.has(sourceType) && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s\0]+$/.test(result5)) return result5;
  try {
    const parsed = new URL(result5);
    const allowed = sourceType === "mintlify" || sourceType === "huggingface" || sourceType === "well-known" ? /* @__PURE__ */ new Set(["https:"]) : /* @__PURE__ */ new Set(["https:", "ssh:", "git:"]);
    if (!allowed.has(parsed.protocol) || parsed.password || parsed.hash || parsed.protocol === "https:" && parsed.username) throw new Error("unsupported URL");
  } catch {
    throw new Error(`${label} is not a supported credential-free source URL`);
  }
  return result5;
}
function skillsPath(item2, name, sourceType) {
  const label = `skills.${name}.skillPath`;
  const result5 = optionalSkillsText(item2, "skillPath", label, 1024);
  if (sourceType !== "well-known" && result5 === void 0) {
    throw new Error(`${label} is required for a materializable ${sourceType} source`);
  }
  if (result5 === void 0) return void 0;
  const parts = result5.split("/");
  if (result5.startsWith("/") || /^[A-Za-z]:/.test(result5) || result5.includes("\\") || /[\u0000-\u001f\u007f]/.test(result5) || parts.some((part) => !part || part === "." || part === "..") || parts.at(-1) !== "SKILL.md") {
    throw new Error(`${label} must be a normalized relative path ending in SKILL.md`);
  }
  return result5;
}
function parseSkills(bytes) {
  const document = strictJsonDocument(bytes, "skills lockfile");
  canonicalJsonNode(document.node);
  const rootEntries = jsonMapEntries(document.node, "skills lockfile");
  const root = record4(document.value, "skills lockfile");
  const versionNode = new Map(rootEntries).get("version");
  if (root.version !== 3 || !isScalar(versionNode) || versionNode.source !== "3") {
    throw new Error("skills lockfile version must be the exact integer 3");
  }
  const skills = record4(root.skills, "skills lockfile skills");
  if (Object.keys(skills).length > 4096) throw new Error("skills lockfile contains more than 4096 skills");
  const skillsNode = new Map(rootEntries).get("skills");
  const skillNodeEntries = jsonMapEntries(skillsNode, "skills lockfile skills");
  if (skillNodeEntries.length !== Object.keys(skills).length) throw new Error("skills lockfile JSON state is inconsistent");
  const skillNodes = new Map(skillNodeEntries);
  const output = /* @__PURE__ */ new Map();
  const workspace = skillsWorkspaceRecord(rootEntries);
  output.set(workspace.identity, workspace);
  for (const [name, raw] of Object.entries(skills)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
      throw new Error(`skills lockfile contains unsupported skill name: ${name}`);
    }
    const item2 = record4(raw, `skills.${name}`);
    const source = text3(item2.source, `skills.${name}.source`);
    const sourceType = text3(item2.sourceType, `skills.${name}.sourceType`, 80);
    if (!SKILLS_SOURCE_TYPES.has(sourceType)) throw new Error(`skills.${name}.sourceType is unsupported`);
    const sourceUrl = skillsSourceUrl(item2.sourceUrl, `skills.${name}.sourceUrl`, sourceType);
    const ref = optionalSkillsText(item2, "ref", `skills.${name}.ref`, 128);
    const skillPath = skillsPath(item2, name, sourceType);
    const sourceBaseUrl = optionalSkillsText(item2, "sourceBaseUrl", `skills.${name}.sourceBaseUrl`, 2048);
    const pluginName = optionalSkillsText(item2, "pluginName", `skills.${name}.pluginName`, 160);
    exactUtcTimestamp(item2.installedAt, `skills.${name}.installedAt`);
    exactUtcTimestamp(item2.updatedAt, `skills.${name}.updatedAt`);
    const endpoint = skillsEndpoint(name, item2, sourceType, ref);
    const node = skillNodes.get(name);
    if (!node) throw new Error(`skills lockfile is missing the exact JSON node for ${name}`);
    const entryRows = jsonMapEntries(node, `skills.${name}`);
    const boundRows = entryRows.filter(([field]) => !SKILLS_DIAGNOSTIC_ENTRY_FIELDS.has(field));
    const boundByName = new Map(boundRows);
    const groupedFields = new Set(Object.values(SKILLS_ENTRY_REASON_GROUPS).flat());
    const reasonFingerprints = Object.fromEntries([
      ...Object.entries(SKILLS_ENTRY_REASON_GROUPS).map(([reason, fields]) => [
        reason,
        hash4(selectedJsonCommitment(boundByName, fields))
      ]),
      [
        "other Skills additive entry state changed",
        hash4(jsonEntriesCommitment(boundRows.filter(([field]) => !groupedFields.has(field))))
      ]
    ]);
    const lineage = hash4(canonical({ source, sourceType, sourceUrl, skillPath, sourceBaseUrl, pluginName }));
    const identity = `skill:${name}:${lineage.slice(7)}`;
    output.set(identity, {
      identity,
      displayName: name,
      componentType: "skill",
      endpoint,
      fingerprint: hash4(jsonEntriesCommitment(boundRows)),
      reasonFingerprints
    });
  }
  return output;
}
function pluginSkills(root) {
  const directory = join7(root, "skills");
  try {
    const status = lstatSync6(directory);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("plugin skills path must be a regular directory");
    return readdirSync2(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).flatMap((entry) => {
      const skill = join7(directory, entry.name, "SKILL.md");
      try {
        const skillStatus = lstatSync6(skill);
        return !skillStatus.isSymbolicLink() && skillStatus.isFile() ? [entry.name] : [];
      } catch {
        return [];
      }
    }).sort();
  } catch (error) {
    const code2 = error.code;
    if (code2 === "ENOENT") return [];
    throw error;
  }
}
function pluginMcpServers(root) {
  const path = join7(root, "mcp.json");
  try {
    const value = record4(strictJson(regularBytes(path, 512 * 1024, "agent plugin mcp.json"), "agent plugin mcp.json"), "agent plugin mcp.json");
    const servers = record4(value.mcpServers, "agent plugin mcpServers");
    if (Object.keys(servers).length > 256) throw new Error("agent plugin has more than 256 MCP servers");
    return Object.entries(servers).map(([name, raw]) => ({
      name: text3(name, "MCP server name", 160),
      type: text3(record4(raw, `mcpServers.${name}`).type, `mcpServers.${name}.type`, 40)
    })).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    const code2 = error.code;
    if (code2 === "ENOENT") return [];
    throw error;
  }
}
function parsePlugin(path) {
  const requested = resolve15(path);
  const status = lstatSync6(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("agent-plugin state must be a regular directory");
  const root = realpathSync7(requested);
  const inventoryBefore = inspectArtifactTree(root);
  const manifest = record4(strictJson(regularBytes(join7(root, "plugin.json"), 512 * 1024, "agent plugin manifest"), "agent plugin manifest"), "agent plugin manifest");
  if (manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") {
    throw new Error("agent plugin manifest must target Agent Plugins 1.0.0");
  }
  const name = text3(manifest.name, "agent plugin name", 64);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) || name.includes("--") || name.includes("..")) {
    throw new Error("agent plugin name is invalid");
  }
  const version = optionalText(manifest.version, "agent plugin version", 128) ?? `tree:${inventoryBefore.treeSha256.slice(7, 19)}`;
  const skills = pluginSkills(root);
  const mcpServers = pluginMcpServers(root);
  const identity = `agent-plugin:${name}`;
  const endpoint = {
    version,
    integrityKind: "artifact-tree",
    integrity: inventoryBefore.treeSha256
  };
  const records = /* @__PURE__ */ new Map([[identity, {
    identity,
    displayName: name,
    componentType: "agent-plugin",
    endpoint,
    fingerprint: inventoryBefore.treeSha256,
    capabilityFingerprint: hash4(canonical({ skills, mcpServers, extensions: manifest.extensions ?? null }))
  }]]);
  const inventoryAfter = inspectArtifactTree(root);
  if (inventoryBefore.treeSha256 !== inventoryAfter.treeSha256) {
    throw new Error("agent-plugin state changed while the update plan was created");
  }
  return { records, sourceSha256: inventoryBefore.treeSha256 };
}
function readManager(manager2, path) {
  if (manager2 === "apm") {
    const bytes = regularBytes(path, 4 * 1024 * 1024, "APM lockfile");
    return { records: parseApm(bytes), sourceSha256: hash4(bytes) };
  }
  if (manager2 === "skills") {
    const bytes = regularBytes(path, 4 * 1024 * 1024, "skills lockfile");
    return { records: parseSkills(bytes), sourceSha256: hash4(bytes) };
  }
  return parsePlugin(path);
}
function isExactEndpoint(endpoint) {
  if (endpoint.integrityKind === "git-commit" || endpoint.integrityKind === "git-tree") {
    return /^[0-9a-f]{40}$/.test(endpoint.integrity);
  }
  if (endpoint.integrityKind === "sha256" || endpoint.integrityKind === "artifact-tree") {
    return /^sha256:[0-9a-f]{64}$/.test(endpoint.integrity);
  }
  return false;
}
function isDistinctExactPair(current, candidate) {
  return isExactEndpoint(current) && isExactEndpoint(candidate) && (current.integrityKind !== candidate.integrityKind || current.integrity !== candidate.integrity);
}
function changeReasons(current, candidate) {
  const reasons = [];
  if (current.reasonFingerprints || candidate.reasonFingerprints) {
    const before = current.reasonFingerprints ?? {};
    const after = candidate.reasonFingerprints ?? {};
    for (const reason of [.../* @__PURE__ */ new Set([...Object.keys(before), ...Object.keys(after)])]) {
      if (before[reason] !== after[reason]) reasons.push(reason);
    }
    if (reasons.length) return reasons;
  }
  if (current.endpoint.version !== candidate.endpoint.version) reasons.push("resolved version changed");
  if (current.endpoint.integrity !== candidate.endpoint.integrity) reasons.push("exact manager integrity changed");
  if (current.capabilityFingerprint !== candidate.capabilityFingerprint) reasons.push("declared component surface changed");
  if (!reasons.length) reasons.push("manager-controlled package state changed");
  return reasons;
}
function finalizePlan(plan) {
  return { ...plan, planHash: hash4(canonical(plan)) };
}
function createUpdatePlan(input) {
  const generatedAt = exactUtcTimestamp(
    input.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    "update plan generatedAt"
  );
  const currentSnapshot = readManager(input.manager, input.currentPath);
  const candidateSnapshot = readManager(input.manager, input.candidatePath);
  const current = currentSnapshot.records;
  const candidate = candidateSnapshot.records;
  const changes = [];
  for (const identity of [.../* @__PURE__ */ new Set([...current.keys(), ...candidate.keys()])].sort()) {
    const before = current.get(identity);
    const after = candidate.get(identity);
    if (before && after && before.fingerprint === after.fingerprint) continue;
    if (before && after) {
      const eligible = isDistinctExactPair(before.endpoint, after.endpoint);
      changes.push({
        componentType: before.componentType,
        identity,
        displayName: before.displayName,
        change: "UPDATED",
        current: before.endpoint,
        candidate: after.endpoint,
        behavioralPreflight: eligible ? "REQUIRED" : "UNAVAILABLE",
        reasons: changeReasons(before, after)
      });
    } else if (after) {
      changes.push({
        componentType: after.componentType,
        identity,
        displayName: after.displayName,
        change: "ADDED",
        candidate: after.endpoint,
        behavioralPreflight: "UNAVAILABLE",
        reasons: ["component was added; no old behavior baseline exists"]
      });
    } else if (before) {
      changes.push({
        componentType: before.componentType,
        identity,
        displayName: before.displayName,
        change: "REMOVED",
        current: before.endpoint,
        behavioralPreflight: "UNAVAILABLE",
        reasons: ["component was removed; removal requires policy review"]
      });
    }
  }
  if (changes.length > UPDATE_PLAN_MAX_CHANGES) {
    throw new Error(`manager update produces more than ${UPDATE_PLAN_MAX_CHANGES} bounded changes`);
  }
  const plan = {
    schemaVersion: UPDATE_PLAN_SCHEMA,
    generatedAt,
    manager: input.manager,
    source: {
      currentSha256: currentSnapshot.sourceSha256,
      candidateSha256: candidateSnapshot.sourceSha256
    },
    changes,
    summary: {
      total: changes.length,
      updated: changes.filter((change) => change.change === "UPDATED").length,
      added: changes.filter((change) => change.change === "ADDED").length,
      removed: changes.filter((change) => change.change === "REMOVED").length,
      eligiblePairs: changes.filter((change) => change.behavioralPreflight === "REQUIRED").length
    },
    limitations: LIMITATIONS2
  };
  return finalizePlan(plan);
}
var ApmMaterializationHold = class extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.reasonCode = reasonCode;
  }
};
var APM_KNOWN_DEPENDENCY_FIELDS = /* @__PURE__ */ new Set([
  "repo_url",
  "materialization_repo_url",
  "host",
  "port",
  "registry_prefix",
  "host_type",
  "resolved_ref",
  "resolved_commit",
  "resolved_tag",
  "resolved_url",
  "resolved_hash",
  "resolved_at",
  "tree_sha256",
  "version",
  "virtual_path",
  "is_virtual",
  "depth",
  "resolved_by",
  "package_type",
  "skill_subset",
  "target_subset",
  "deployed_files",
  "deployed_file_hashes",
  "content_hash",
  "source",
  "local_path",
  "name",
  "constraint",
  "is_dev",
  "is_insecure",
  "allow_insecure",
  "exec_status",
  "discovered_via",
  "marketplace_plugin_name",
  "source_url",
  "source_digest",
  "license",
  "licenses",
  "homepage",
  "attestations"
]);
function apmPortablePath(value) {
  if (value === void 0) return void 0;
  const path = text3(value, "APM virtual_path", 1024);
  const parts = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new ApmMaterializationHold("SOURCE_ROUTE_UNSUPPORTED");
  }
  return path;
}
function githubRepository(value) {
  const route = text3(value, "APM repo_url", 512);
  const match = /^(?:github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/.exec(route);
  const name = match?.[2].endsWith(".git") ? match[2].slice(0, -4) : match?.[2];
  if (!match || !name || name === "." || name === "..") {
    throw new ApmMaterializationHold("SOURCE_ROUTE_UNSUPPORTED");
  }
  return { owner: match[1], name };
}
function sameRepository(left, right) {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.name.toLowerCase() === right.name.toLowerCase();
}
function materializationEndpoint(record7) {
  const row = record7.apmRow;
  if (!row || Object.keys(row).some((field) => !APM_KNOWN_DEPENDENCY_FIELDS.has(field))) {
    throw new ApmMaterializationHold("SOURCE_SHAPE_UNSUPPORTED");
  }
  const source = row.source === void 0 ? "git" : text3(row.source, "APM source", 80);
  const host = row.host === void 0 ? "github.com" : text3(row.host, "APM host", 255);
  if (source !== "git" || host.toLowerCase() !== "github.com" || row.host_type !== void 0 || row.port !== void 0 || row.registry_prefix !== void 0 || row.resolved_url !== void 0 || row.resolved_hash !== void 0 || row.local_path !== void 0 || row.is_insecure !== void 0 && row.is_insecure !== "false" || row.allow_insecure !== void 0 && row.allow_insecure !== "false") {
    throw new ApmMaterializationHold("SOURCE_ROUTE_UNSUPPORTED");
  }
  const repository2 = githubRepository(row.repo_url);
  let materializationRepository = repository2;
  if (row.materialization_repo_url !== void 0) {
    materializationRepository = githubRepository(row.materialization_repo_url);
    if (!sameRepository(repository2, materializationRepository)) {
      throw new ApmMaterializationHold("SOURCE_ROUTE_UNSUPPORTED");
    }
  }
  const commit2 = exactGitCommit(optionalText(row.resolved_commit, "APM resolved_commit", 64));
  const expectedTreeSha256 = exactSha256(optionalText(row.tree_sha256, "APM tree_sha256", 80));
  if (!commit2 || !expectedTreeSha256) throw new ApmMaterializationHold("SOURCE_INTEGRITY_UNAVAILABLE");
  const virtualPath = apmPortablePath(row.virtual_path);
  const routeSha256 = hash4(canonical({
    protocol: "https",
    host: "codeload.github.com",
    owner: materializationRepository.owner.toLowerCase(),
    repository: materializationRepository.name.toLowerCase(),
    route: "tar.gz",
    commit: commit2
  }));
  return {
    repository: materializationRepository,
    commit: commit2,
    expectedTreeSha256,
    routeSha256,
    rowSha256: record7.fingerprint,
    ...virtualPath ? { virtualPath } : {}
  };
}
function selectApmMaterialization(input) {
  const plan = createUpdatePlan({
    manager: "apm",
    currentPath: input.currentPath,
    candidatePath: input.candidatePath,
    ...input.generatedAt ? { generatedAt: input.generatedAt } : {}
  });
  const eligible = plan.changes.filter((change) => change.componentType === "apm-package" && change.change === "UPDATED" && change.behavioralPreflight === "REQUIRED");
  const selected = input.identity ? eligible.find((change) => change.identity === input.identity) : eligible.length === 1 ? eligible[0] : void 0;
  if (!selected) {
    throw new ApmMaterializationHold(
      eligible.length === 0 ? "NO_ELIGIBLE_PAIR" : input.identity ? "SELECTED_PAIR_UNAVAILABLE" : "MULTIPLE_ELIGIBLE_PAIRS"
    );
  }
  const currentSnapshot = readManager("apm", input.currentPath);
  const candidateSnapshot = readManager("apm", input.candidatePath);
  if (currentSnapshot.sourceSha256 !== plan.source.currentSha256 || candidateSnapshot.sourceSha256 !== plan.source.candidateSha256) {
    throw new ApmMaterializationHold("SOURCE_STATE_CHANGED");
  }
  const current = currentSnapshot.records.get(selected.identity);
  const candidate = candidateSnapshot.records.get(selected.identity);
  if (!current || !candidate) throw new ApmMaterializationHold("SELECTED_PAIR_UNAVAILABLE");
  return {
    plan,
    change: selected,
    selectedChangeSha256: hash4(canonical(selected)),
    current: materializationEndpoint(current),
    candidate: materializationEndpoint(candidate)
  };
}
function renderUpdatePlan(plan) {
  const lines = [
    `Agent Vigil update plan: ${plan.manager}`,
    `  ${plan.summary.total} change(s) \xB7 ${plan.summary.eligiblePairs} exact old/new pair(s) require behavioral preflight`
  ];
  for (const change of plan.changes) {
    const pair = change.current && change.candidate ? `${terminalSafe(change.current.version)} -> ${terminalSafe(change.candidate.version)}` : change.current ? `${terminalSafe(change.current.version)} -> removed` : `added -> ${terminalSafe(change.candidate?.version ?? "unknown")}`;
    lines.push(`  ${change.change === "UPDATED" ? "!" : "?"} ${terminalSafe(change.displayName)}: ${pair} \xB7 ${change.behavioralPreflight}`);
  }
  if (!plan.changes.length) lines.push("  \u2713 no manager-state changes detected");
  lines.push(`  ${plan.planHash}`);
  return `${lines.join("\n")}
`;
}

// src/upgrade/apm-materialize.ts
import { spawnSync as spawnSync4 } from "node:child_process";
import { createHash as createHash18, randomBytes as randomBytes4 } from "node:crypto";
import {
  accessSync as accessSync2,
  chmodSync as chmodSync2,
  closeSync as closeSync4,
  constants as constants3,
  existsSync as existsSync5,
  fstatSync as fstatSync4,
  fchmodSync as fchmodSync2,
  lstatSync as lstatSync7,
  mkdirSync as mkdirSync4,
  mkdtempSync as mkdtempSync3,
  openSync as openSync4,
  readFileSync as readFileSync19,
  realpathSync as realpathSync8,
  rmSync as rmSync2,
  statSync as statSync8,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync5
} from "node:fs";
import { basename as basename6, dirname as dirname7, isAbsolute as isAbsolute7, join as join8, relative as relative10, resolve as resolve16, sep as sep8 } from "node:path";
import { TextDecoder as TextDecoder2 } from "node:util";
import { gunzipSync } from "node:zlib";
var APM_PREFLIGHT_SCHEMA = "agent-vigil-apm-preflight/v1";
var MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
var MAX_TAR_BYTES = 272 * 1024 * 1024;
var MAX_FILES2 = 4096;
var MAX_DIRECTORIES = 4096;
var MAX_FILE_BYTES = 32 * 1024 * 1024;
var MAX_TOTAL_BYTES2 = 256 * 1024 * 1024;
var SESSION_PREFIX = "agent-vigil-apm-";
var LIMITATIONS3 = [
  "This receipt covers one selected APM package pair; other changes in the bound update plan remain separate decisions.",
  "Automatic acquisition supports only credential-free public github.com git rows pinned by both a lowercase 40-character commit and APM tree_sha256.",
  "Archives containing links, special files, unsupported extension records, unsafe names, or entries beyond the documented bounds return HOLD.",
  "No APM installer, package lifecycle script, repository hook, or host update is executed; only temporary exact artifacts are mounted read-only into the existing contained check."
];
var PreflightHold = class extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.reasonCode = reasonCode;
  }
};
function hash5(value) {
  return `sha256:${createHash18("sha256").update(value).digest("hex")}`;
}
function finalizeReceipt2(receipt) {
  return { ...receipt, receiptHash: hash5(canonical(receipt)) };
}
function strictUtf82(bytes, label) {
  try {
    return new TextDecoder2("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PreflightHold(label);
  }
}
function tarText(block, start, length, reasonCode) {
  const field = block.subarray(start, start + length);
  const zero = field.indexOf(0);
  const textBytes = zero === -1 ? field : field.subarray(0, zero);
  if (zero !== -1 && field.subarray(zero).some((byte) => byte !== 0)) throw new PreflightHold(reasonCode);
  return strictUtf82(textBytes, reasonCode);
}
function tarOctal(block, start, length, reasonCode) {
  const field = block.subarray(start, start + length);
  if (field[0] !== void 0 && (field[0] & 128) !== 0) throw new PreflightHold(reasonCode);
  const source = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!source) return 0;
  if (!/^[0-7]+$/.test(source)) throw new PreflightHold(reasonCode);
  const value = Number.parseInt(source, 8);
  if (!Number.isSafeInteger(value)) throw new PreflightHold(reasonCode);
  return value;
}
function validTarChecksum(block) {
  const expected = tarOctal(block, 148, 8, "ARCHIVE_INVALID");
  let actual = 0;
  for (let index = 0; index < block.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : block[index];
  }
  return actual === expected;
}
function normalizedArchivePath(value) {
  if (!value || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
  }
  const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = trimmed.split("/");
  if (!parts[0] || parts.some((part) => !part || part === "." || part === "..")) {
    throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
  }
  return { root: parts[0], ...parts.length > 1 ? { relativePath: parts.slice(1).join("/") } : {} };
}
function portableIdentity(path) {
  return path.normalize("NFC").toUpperCase();
}
function parentPaths(path) {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join("/"));
}
function canonicalTreeSha256(files) {
  const byDirectory = /* @__PURE__ */ new Map();
  const directories = /* @__PURE__ */ new Set([""]);
  for (const file of files) {
    const parts = file.path.split("/");
    const directory = parts.slice(0, -1).join("/");
    directories.add(directory);
    for (const parent of parentPaths(file.path)) directories.add(parent);
    const rows = byDirectory.get(directory) ?? [];
    rows.push(file);
    byDirectory.set(directory, rows);
  }
  const memo = /* @__PURE__ */ new Map();
  const digestDirectory = (directory) => {
    const cached = memo.get(directory);
    if (cached) return cached;
    const prefix = directory ? `${directory}/` : "";
    const directDirectories = [...directories].filter((candidate) => {
      if (!candidate.startsWith(prefix) || candidate === directory) return false;
      return !candidate.slice(prefix.length).includes("/");
    });
    const entries = [];
    for (const file of byDirectory.get(directory) ?? []) {
      const name = basename6(file.path);
      const blob = createHash18("sha256").update(file.bytes).digest("hex");
      entries.push({ name, line: `${file.executable ? "100755" : "100644"} ${name} ${blob}
` });
    }
    for (const child of directDirectories) {
      const name = child.slice(prefix.length);
      entries.push({ name, line: `040000 ${name} ${digestDirectory(child)}
` });
    }
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    const digest5 = createHash18("sha256").update(entries.map((entry) => entry.line).join(""), "utf8").digest("hex");
    memo.set(directory, digest5);
    return digest5;
  };
  return `sha256:${digestDirectory("")}`;
}
function parseApmGitHubArchive(compressed) {
  if (!compressed.length || compressed.length > MAX_ARCHIVE_BYTES) throw new PreflightHold("ARCHIVE_SIZE_EXCEEDED");
  let tar;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_TAR_BYTES });
  } catch {
    throw new PreflightHold("ARCHIVE_INVALID");
  }
  if (!tar.length || tar.length % 512 !== 0 || tar.length > MAX_TAR_BYTES) throw new PreflightHold("ARCHIVE_INVALID");
  const files = [];
  const directories = /* @__PURE__ */ new Set();
  const identities = /* @__PURE__ */ new Set();
  const fileIdentities = /* @__PURE__ */ new Set();
  const portablePaths = /* @__PURE__ */ new Map();
  const registerPortablePath = (path) => {
    const identity = portableIdentity(path);
    const existing = portablePaths.get(identity);
    if (existing !== void 0 && existing !== path) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
    portablePaths.set(identity, path);
  };
  let archiveRoot;
  let offset = 0;
  let ended = false;
  let totalBytes = 0;
  while (offset < tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      if (offset + 1024 > tar.length || !tar.subarray(offset, offset + 1024).every((byte) => byte === 0)) {
        throw new PreflightHold("ARCHIVE_INVALID");
      }
      ended = true;
      if (!tar.subarray(offset).every((byte) => byte === 0)) throw new PreflightHold("ARCHIVE_INVALID");
      break;
    }
    if (!validTarChecksum(block)) throw new PreflightHold("ARCHIVE_INVALID");
    const magic = block.subarray(257, 263).toString("binary");
    if (magic !== "ustar\0" && magic !== "ustar ") throw new PreflightHold("ARCHIVE_INVALID");
    const name = tarText(block, 0, 100, "ARCHIVE_INVALID");
    const prefix = tarText(block, 345, 155, "ARCHIVE_INVALID");
    const path = prefix ? `${prefix}/${name}` : name;
    const normalized = normalizedArchivePath(path);
    archiveRoot ??= normalized.root;
    if (normalized.root !== archiveRoot) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
    const size = tarOctal(block, 124, 12, "ARCHIVE_INVALID");
    const mode = tarOctal(block, 100, 8, "ARCHIVE_INVALID");
    const type = block[156];
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
    if (dataEnd > tar.length || paddedEnd > tar.length) throw new PreflightHold("ARCHIVE_INVALID");
    const relativePath = normalized.relativePath;
    if (type !== 0 && type !== 48 && type !== 53) throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
    if (type === 53) {
      if (size !== 0) throw new PreflightHold("ARCHIVE_INVALID");
      if (relativePath) {
        if (!directories.has(relativePath) && directories.size >= MAX_DIRECTORIES) {
          throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
        }
        const identity = portableIdentity(relativePath);
        if (identities.has(identity)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
        registerPortablePath(relativePath);
        identities.add(identity);
        directories.add(relativePath);
      }
    } else {
      if (!relativePath) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
      if (files.length >= MAX_FILES2) throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
      if (size > MAX_FILE_BYTES || totalBytes + size > MAX_TOTAL_BYTES2) throw new PreflightHold("ARCHIVE_SIZE_EXCEEDED");
      const identity = portableIdentity(relativePath);
      if (identities.has(identity) || directories.has(relativePath)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
      registerPortablePath(relativePath);
      identities.add(identity);
      fileIdentities.add(identity);
      for (const parent of parentPaths(relativePath)) {
        registerPortablePath(parent);
        const parentIdentity = portableIdentity(parent);
        if (fileIdentities.has(parentIdentity)) throw new PreflightHold("ARCHIVE_PATH_COLLISION");
        if (!directories.has(parent) && directories.size >= MAX_DIRECTORIES) {
          throw new PreflightHold("ARCHIVE_COUNT_EXCEEDED");
        }
        directories.add(parent);
      }
      files.push({
        path: relativePath,
        bytes: Buffer.from(tar.subarray(dataStart, dataEnd)),
        executable: (mode & 73) !== 0
      });
      totalBytes += size;
    }
    offset = paddedEnd;
  }
  if (!ended || !archiveRoot || !files.length) throw new PreflightHold("ARCHIVE_INVALID");
  const materializedDirectories = new Set(files.flatMap((file) => parentPaths(file.path)));
  if ([...directories].some((directory) => !materializedDirectories.has(directory))) {
    throw new PreflightHold("ARCHIVE_ENTRY_UNSUPPORTED");
  }
  return {
    files,
    directories: [...materializedDirectories].sort(),
    treeSha256: canonicalTreeSha256(files),
    fileCount: files.length,
    totalBytes
  };
}
function safeSessionParent(path) {
  const requested = resolve16(path);
  const status = lstatSync7(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
  const canonicalParent = realpathSync8(requested);
  if (!statSync8(canonicalParent).isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
  return canonicalParent;
}
function createSession(parentPath) {
  let root;
  try {
    root = mkdtempSync3(join8(safeSessionParent(parentPath), SESSION_PREFIX));
    chmodSync2(root, 493);
    const status = lstatSync7(root);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new PreflightHold("SESSION_UNAVAILABLE");
    return realpathSync8(root);
  } catch (error) {
    if (root !== void 0 && !safeRemoveSession(root)) {
      throw new PreflightHold("RESTORATION_FAILED");
    }
    throw error;
  }
}
function safeRemoveSession(path) {
  try {
    const requested = resolve16(path);
    if (!basename6(requested).startsWith(SESSION_PREFIX)) return false;
    const status = lstatSync7(requested);
    if (status.isSymbolicLink() || !status.isDirectory()) return false;
    if (realpathSync8(requested) !== requested) return false;
    rmSync2(requested, { recursive: true, force: false, maxRetries: 2 });
    return !existsSync5(requested);
  } catch (error) {
    return error.code === "ENOENT";
  }
}
function trustedCurlLocations() {
  if (process.platform === "win32") return ["C:\\Windows\\System32\\curl.exe"];
  return ["/usr/bin/curl", "/usr/local/bin/curl", "/opt/homebrew/bin/curl"];
}
function resolveFetchBinary(requested = "curl") {
  const candidates = isAbsolute7(requested) ? [requested] : requested === "curl" || requested === "curl.exe" ? trustedCurlLocations() : [];
  for (const candidate of candidates) {
    try {
      const canonicalPath = realpathSync8(candidate);
      if (!statSync8(canonicalPath).isFile()) continue;
      if (process.platform !== "win32") accessSync2(canonicalPath, constants3.X_OK);
      return canonicalPath;
    } catch {
    }
  }
  throw new PreflightHold("FETCH_CLIENT_UNAVAILABLE");
}
function curlArchiveFetcher(fetchBin = "curl") {
  const executable = resolveFetchBinary(fetchBin);
  return (url, destination) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "codeload.github.com" || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !/^\/[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+\/tar\.gz\/[0-9a-f]{40}$/.test(parsed.pathname)) {
      throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED");
    }
    const result5 = spawnSync4(executable, [
      "-q",
      "--fail",
      "--silent",
      "--show-error",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-redirs",
      "0",
      "--connect-timeout",
      "10",
      "--max-time",
      "90",
      "--max-filesize",
      String(MAX_ARCHIVE_BYTES),
      "--noproxy",
      "*",
      "--output",
      "-",
      parsed.toString()
    ], {
      timeout: 1e5,
      killSignal: "SIGKILL",
      maxBuffer: MAX_ARCHIVE_BYTES + 64 * 1024,
      env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : { LANG: "C", LC_ALL: "C" }
    });
    if (result5.status !== 0 || result5.error || !Buffer.isBuffer(result5.stdout) || result5.stdout.length < 1 || result5.stdout.length > MAX_ARCHIVE_BYTES) {
      throw new PreflightHold("FETCH_FAILED");
    }
    writeExclusiveFile(destination, result5.stdout, false, 384);
  };
}
function writeExclusiveFile(path, bytes, executable, mode) {
  const noFollow = typeof constants3.O_NOFOLLOW === "number" ? constants3.O_NOFOLLOW : 0;
  const descriptor = openSync4(
    path,
    constants3.O_CREAT | constants3.O_EXCL | constants3.O_WRONLY | noFollow,
    mode ?? (executable ? 493 : 420)
  );
  try {
    writeFileSync5(descriptor, bytes);
    const status = fstatSync4(descriptor);
    if (!status.isFile() || status.size !== bytes.length) throw new PreflightHold("MATERIALIZATION_FAILED");
  } finally {
    closeSync4(descriptor);
  }
}
function extractArchive(archive, root) {
  mkdirSync4(root, { mode: 493 });
  for (const directory of archive.directories.sort((left, right) => left.split("/").length - right.split("/").length)) {
    const output = join8(root, ...directory.split("/"));
    const rel = relative10(root, output);
    if (rel === ".." || rel.startsWith(`..${sep8}`)) throw new PreflightHold("ARCHIVE_PATH_UNSAFE");
    if (!existsSync5(output)) mkdirSync4(output, { mode: 493 });
    const status = lstatSync7(output);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new PreflightHold("MATERIALIZATION_FAILED");
  }
  for (const file of archive.files) {
    const output = join8(root, ...file.path.split("/"));
    const parent = dirname7(output);
    if (!existsSync5(parent)) mkdirSync4(parent, { recursive: true, mode: 493 });
    writeExclusiveFile(output, file.bytes, file.executable);
  }
}
function materializeEndpoint(endpoint, label, session, fetchArchive) {
  const archivePath = join8(session, `${label}.tar.gz`);
  const url = `https://codeload.github.com/${endpoint.repository.owner}/${endpoint.repository.name}/tar.gz/${endpoint.commit}`;
  fetchArchive(url, archivePath);
  const beforePath = lstatSync7(archivePath, { bigint: true });
  if (beforePath.isSymbolicLink() || !beforePath.isFile() || beforePath.size < 1n || beforePath.size > BigInt(MAX_ARCHIVE_BYTES)) {
    throw new PreflightHold("FETCH_INVALID");
  }
  const noFollow = typeof constants3.O_NOFOLLOW === "number" ? constants3.O_NOFOLLOW : 0;
  const descriptor = openSync4(archivePath, constants3.O_RDONLY | noFollow);
  let compressed;
  try {
    const opened = fstatSync4(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== beforePath.dev || opened.ino !== beforePath.ino) {
      throw new PreflightHold("FETCH_INVALID");
    }
    fchmodSync2(descriptor, 384);
    const before = fstatSync4(descriptor, { bigint: true });
    compressed = readFileSync19(descriptor);
    const after = fstatSync4(descriptor, { bigint: true });
    const afterPath = lstatSync7(archivePath, { bigint: true });
    if (compressed.length > MAX_ARCHIVE_BYTES || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.dev !== afterPath.dev || after.ino !== afterPath.ino || afterPath.isSymbolicLink()) {
      throw new PreflightHold("FETCH_INVALID");
    }
  } finally {
    closeSync4(descriptor);
  }
  const fetchedSha256 = hash5(compressed);
  const parsed = parseApmGitHubArchive(compressed);
  if (parsed.treeSha256 !== endpoint.expectedTreeSha256) throw new PreflightHold("MATERIALIZED_TREE_MISMATCH");
  unlinkSync2(archivePath);
  const materializedRoot = join8(session, label);
  extractArchive(parsed, materializedRoot);
  const selectedRoot = endpoint.virtualPath ? join8(materializedRoot, ...endpoint.virtualPath.split("/")) : materializedRoot;
  const rel = relative10(materializedRoot, selectedRoot);
  if (rel === ".." || rel.startsWith(`..${sep8}`)) throw new PreflightHold("SOURCE_ROUTE_UNSUPPORTED");
  const selectedStatus = lstatSync7(selectedRoot);
  if (selectedStatus.isSymbolicLink() || !selectedStatus.isDirectory()) throw new PreflightHold("VIRTUAL_PATH_UNAVAILABLE");
  const selectedArtifact = inspectArtifactTree(selectedRoot);
  return {
    selectedRoot,
    proof: {
      routeSha256: endpoint.routeSha256,
      rowSha256: endpoint.rowSha256,
      commit: endpoint.commit,
      expectedTreeSha256: endpoint.expectedTreeSha256,
      fetchedSha256,
      fetchedBytes: compressed.length,
      materializedTreeSha256: parsed.treeSha256,
      fileCount: parsed.fileCount,
      totalBytes: parsed.totalBytes,
      selectedArtifact
    }
  };
}
function suppliedPlanTime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
  const generatedAt = value.generatedAt;
  return typeof generatedAt === "string" ? generatedAt : void 0;
}
function exactTimestamp(value) {
  if (!value || value.length > 64) return void 0;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? value : void 0;
}
function exactPlanForInput(input) {
  const suppliedGeneratedAt = suppliedPlanTime(input.suppliedPlan);
  const suppliedTimestamp = exactTimestamp(suppliedGeneratedAt);
  const generatedAt = input.suppliedPlan === void 0 ? input.generatedAt : suppliedTimestamp ?? input.generatedAt;
  const plan = createUpdatePlan({
    manager: "apm",
    currentPath: input.currentLockPath,
    candidatePath: input.candidateLockPath,
    ...generatedAt ? { generatedAt } : input.generatedAt ? { generatedAt: input.generatedAt } : {}
  });
  return {
    plan,
    suppliedPlanMatches: input.suppliedPlan === void 0 || Boolean(suppliedTimestamp && canonical(input.suppliedPlan) === canonical(plan))
  };
}
function holdReason(error, fallback) {
  if (error instanceof PreflightHold || error instanceof ApmMaterializationHold) return error.reasonCode;
  return fallback;
}
function runApmAutomaticPreflight(input, dependencies = {}) {
  const nonce = input.nonce ?? randomBytes4(32).toString("base64url");
  if (nonce.length < 16 || nonce.length > 128 || nonce.includes("\0")) {
    throw new Error("automatic APM preflight nonce must contain from 16 to 128 characters");
  }
  const { plan, suppliedPlanMatches } = exactPlanForInput(input);
  if (!suppliedPlanMatches) {
    return finalizeReceipt2({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      restoration: { status: "RESTORED", hostMutation: "NONE", sessionRemoved: true, reasonCode: "NOTHING_MATERIALIZED" },
      summary: { verdict: "HOLD", reasonCodes: ["PLAN_MISMATCH"] },
      limitations: LIMITATIONS3
    });
  }
  let selection;
  try {
    selection = selectApmMaterialization({
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt,
      ...input.identity ? { identity: input.identity } : {}
    });
    if (canonical(selection.plan) !== canonical(plan)) {
      throw new ApmMaterializationHold("SOURCE_STATE_CHANGED");
    }
  } catch (error) {
    const reasonCode = holdReason(error, "SELECTION_FAILED");
    return finalizeReceipt2({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      restoration: { status: "RESTORED", hostMutation: "NONE", sessionRemoved: true, reasonCode: "NOTHING_MATERIALIZED" },
      summary: { verdict: "HOLD", reasonCodes: [reasonCode] },
      limitations: LIMITATIONS3
    });
  }
  let session;
  try {
    session = createSession(input.workDirectory ?? dirname7(input.configPath));
  } catch (error) {
    return finalizeReceipt2({
      schemaVersion: APM_PREFLIGHT_SCHEMA,
      generatedAt: plan.generatedAt,
      nonce,
      plan,
      selection: {
        identity: selection.change.identity,
        selectedChangeSha256: selection.selectedChangeSha256,
        currentRowSha256: selection.current.rowSha256,
        candidateRowSha256: selection.candidate.rowSha256
      },
      restoration: { status: "HOLD", hostMutation: "NONE", sessionRemoved: false, reasonCode: "SESSION_UNAVAILABLE" },
      summary: { verdict: "HOLD", reasonCodes: [holdReason(error, "SESSION_UNAVAILABLE")] },
      limitations: LIMITATIONS3
    });
  }
  const removeSession = dependencies.removeSession ?? safeRemoveSession;
  let cleanupAttempted = false;
  let cleanupSucceeded = false;
  const cleanup = () => {
    if (cleanupAttempted) return cleanupSucceeded;
    cleanupAttempted = true;
    try {
      cleanupSucceeded = removeSession(session);
    } catch {
      cleanupSucceeded = false;
    }
    return cleanupSucceeded;
  };
  const onInterrupt = () => {
    cleanup();
    process.exit(130);
  };
  const onTerminate = () => {
    cleanup();
    process.exit(143);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const materialization = {};
  let upgradeReceipt;
  const reasons = [];
  try {
    const fetchArchive = dependencies.fetchArchive ?? curlArchiveFetcher(input.fetchBin ?? "curl");
    const current = materializeEndpoint(selection.current, "current", session, fetchArchive);
    materialization.current = current.proof;
    const candidate = materializeEndpoint(selection.candidate, "candidate", session, fetchArchive);
    materialization.candidate = candidate.proof;
    const beforeCheckPlan = createUpdatePlan({
      manager: "apm",
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt
    });
    if (canonical(beforeCheckPlan) !== canonical(plan)) throw new PreflightHold("SOURCE_STATE_CHANGED");
    const evaluate = dependencies.evaluate ?? runUpgradeEvaluation;
    upgradeReceipt = evaluate({
      configPath: input.configPath,
      repository: input.repository,
      currentDirectory: current.selectedRoot,
      candidateDirectory: candidate.selectedRoot,
      ...input.dockerBin ? { dockerBin: input.dockerBin } : {},
      generatedAt: plan.generatedAt,
      nonce
    });
    if (recomputeUpgradeReceiptHash(upgradeReceipt) !== upgradeReceipt.receiptHash) {
      reasons.push("CHECK_RECEIPT_INVALID");
    } else if (!upgradeReceipt.current || !upgradeReceipt.candidate || upgradeReceipt.current.treeSha256 !== current.proof.selectedArtifact.treeSha256 || upgradeReceipt.candidate.treeSha256 !== candidate.proof.selectedArtifact.treeSha256) {
      reasons.push("CHECK_BINDING_MISMATCH");
    } else if (upgradeReceipt.summary.verdict === "HOLD") reasons.push("CHECK_HOLD");
    const afterCheckPlan = createUpdatePlan({
      manager: "apm",
      currentPath: input.currentLockPath,
      candidatePath: input.candidateLockPath,
      generatedAt: plan.generatedAt
    });
    if (canonical(afterCheckPlan) !== canonical(plan)) reasons.push("SOURCE_STATE_CHANGED");
  } catch (error) {
    reasons.push(holdReason(error, upgradeReceipt ? "CHECK_FAILED" : "MATERIALIZATION_FAILED"));
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (!cleanup()) reasons.push("RESTORATION_FAILED");
  }
  const restoration = cleanupSucceeded ? { status: "RESTORED", hostMutation: "NONE", sessionRemoved: true, reasonCode: "TEMPORARY_ARTIFACTS_REMOVED" } : { status: "HOLD", hostMutation: "NONE", sessionRemoved: false, reasonCode: "RESTORATION_FAILED" };
  const verdict = reasons.length || !upgradeReceipt ? "HOLD" : upgradeReceipt.summary.verdict;
  return finalizeReceipt2({
    schemaVersion: APM_PREFLIGHT_SCHEMA,
    generatedAt: plan.generatedAt,
    nonce,
    plan,
    selection: {
      identity: selection.change.identity,
      selectedChangeSha256: selection.selectedChangeSha256,
      currentRowSha256: selection.current.rowSha256,
      candidateRowSha256: selection.candidate.rowSha256
    },
    ...materialization.current || materialization.candidate ? { materialization } : {},
    ...upgradeReceipt ? { upgradeReceipt } : {},
    restoration,
    summary: {
      verdict,
      reasonCodes: reasons.length ? [...new Set(reasons)] : [verdict === "SAFE" ? "NO_MATERIAL_CHANGE" : "MATERIAL_CHANGE_DETECTED"]
    },
    limitations: LIMITATIONS3
  });
}
function renderApmAutomaticPreflight(receipt) {
  const lines = [
    `Agent Vigil automatic APM preflight: ${receipt.summary.verdict}`,
    `  plan ${receipt.plan.planHash}`
  ];
  if (receipt.selection) lines.push(`  selected ${receipt.selection.identity}`);
  if (receipt.upgradeReceipt) lines.push(renderUpgradeReceipt(receipt.upgradeReceipt).trimEnd());
  lines.push(`  restoration ${receipt.restoration.status} \xB7 host mutation ${receipt.restoration.hostMutation}`);
  if (receipt.summary.reasonCodes.length) lines.push(`  ${receipt.summary.reasonCodes.join(", ")}`);
  lines.push(`  ${receipt.receiptHash}`);
  return `${lines.join("\n")}
`;
}

// src/upgrade/fleet.ts
import { createHash as createHash19 } from "node:crypto";
var FLEET_POLICY_SCHEMA = "agent-vigil-fleet-policy/v1";
var FLEET_DECISION_SCHEMA = "agent-vigil-fleet-decision/v1";
function hash6(value) {
  return `sha256:${createHash19("sha256").update(value).digest("hex")}`;
}
function record5(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys4(value, keys, label) {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}
function text4(value, label, maximum, pattern) {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0") || pattern && !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
function stringList2(value, label, maximum, validator) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) throw new Error(`${label} must contain from 1 to ${maximum} entries`);
  const result5 = value.map(validator);
  if (new Set(result5).size !== result5.length) throw new Error(`${label} must not contain duplicates`);
  return result5;
}
function sha2564(value, label) {
  return text4(value, label, 71, /^sha256:[0-9a-f]{64}$/);
}
function validateFleetPolicy(input) {
  const root = record5(input, "fleet policy");
  exactKeys4(root, ["schemaVersion", "policyId", "allowedPublisherKeyIds", "allowedComponents", "allowedRunnerImages", "allowedConfigSha256", "allowedCanaryHarnessSha256", "maxEvidenceAgeHours", "minimumCanaries"], "fleet policy");
  if (root.schemaVersion !== FLEET_POLICY_SCHEMA) throw new Error(`fleet policy schemaVersion must be ${FLEET_POLICY_SCHEMA}`);
  if (!Array.isArray(root.allowedComponents) || root.allowedComponents.length < 1 || root.allowedComponents.length > 256) {
    throw new Error("allowedComponents must contain from 1 to 256 entries");
  }
  const allowedComponents = root.allowedComponents.map((item2, index) => {
    const component = record5(item2, `allowedComponents[${index}]`);
    exactKeys4(component, ["ecosystem", "name"], `allowedComponents[${index}]`);
    return {
      ecosystem: text4(component.ecosystem, `allowedComponents[${index}].ecosystem`, 80, /^[a-z0-9][a-z0-9._-]*$/),
      name: text4(component.name, `allowedComponents[${index}].name`, 160, /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/)
    };
  });
  if (new Set(allowedComponents.map((item2) => `${item2.ecosystem}:${item2.name}`)).size !== allowedComponents.length) {
    throw new Error("allowedComponents must not contain duplicates");
  }
  if (!Number.isInteger(root.maxEvidenceAgeHours) || Number(root.maxEvidenceAgeHours) < 1 || Number(root.maxEvidenceAgeHours) > 8760) {
    throw new Error("maxEvidenceAgeHours must be an integer from 1 to 8760");
  }
  if (!Number.isInteger(root.minimumCanaries) || Number(root.minimumCanaries) < 1 || Number(root.minimumCanaries) > 32) {
    throw new Error("minimumCanaries must be an integer from 1 to 32");
  }
  return {
    schemaVersion: FLEET_POLICY_SCHEMA,
    policyId: text4(root.policyId, "policyId", 128, /^[a-z0-9][a-z0-9._-]*$/),
    allowedPublisherKeyIds: stringList2(root.allowedPublisherKeyIds, "allowedPublisherKeyIds", 32, (item2, index) => sha2564(item2, `allowedPublisherKeyIds[${index}]`)),
    allowedComponents,
    allowedRunnerImages: stringList2(root.allowedRunnerImages, "allowedRunnerImages", 32, (item2, index) => sha2564(item2, `allowedRunnerImages[${index}]`)),
    allowedConfigSha256: stringList2(root.allowedConfigSha256, "allowedConfigSha256", 64, (item2, index) => sha2564(item2, `allowedConfigSha256[${index}]`)),
    allowedCanaryHarnessSha256: stringList2(root.allowedCanaryHarnessSha256, "allowedCanaryHarnessSha256", 64, (item2, index) => sha2564(item2, `allowedCanaryHarnessSha256[${index}]`)),
    maxEvidenceAgeHours: Number(root.maxEvidenceAgeHours),
    minimumCanaries: Number(root.minimumCanaries)
  };
}
function validateFleetDeploymentIntent(input) {
  const root = record5(input, "fleet deployment intent");
  exactKeys4(root, ["currentVersion", "candidateVersion", "currentArtifactSha256", "candidateArtifactSha256"], "fleet deployment intent");
  return {
    currentVersion: text4(root.currentVersion, "fleet deployment intent currentVersion", 128),
    candidateVersion: text4(root.candidateVersion, "fleet deployment intent candidateVersion", 128),
    currentArtifactSha256: sha2564(root.currentArtifactSha256, "fleet deployment intent currentArtifactSha256"),
    candidateArtifactSha256: sha2564(root.candidateArtifactSha256, "fleet deployment intent candidateArtifactSha256")
  };
}
function decisionPayload(value) {
  return canonical(value);
}
function enforceFleetPolicy(input) {
  const policy = validateFleetPolicy(input.policy);
  const deploymentIntent = validateFleetDeploymentIntent(input.deploymentIntent);
  const evaluatedAt = input.evaluatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  const evaluatedMilliseconds = Date.parse(evaluatedAt);
  if (!Number.isFinite(evaluatedMilliseconds) || new Date(evaluatedMilliseconds).toISOString() !== evaluatedAt) {
    throw new Error("fleet decision evaluatedAt must be an exact UTC ISO timestamp");
  }
  const reasons = [];
  if (deploymentIntent.currentVersion !== input.entry.component.currentVersion) {
    reasons.push("trusted deployment intent current version does not match signed entry");
  }
  if (deploymentIntent.candidateVersion !== input.entry.component.candidateVersion) {
    reasons.push("trusted deployment intent candidate version does not match signed entry");
  }
  if (deploymentIntent.currentArtifactSha256 !== input.entry.component.currentArtifactSha256) {
    reasons.push("trusted deployment intent current artifact SHA256 does not match signed entry");
  }
  if (deploymentIntent.candidateArtifactSha256 !== input.entry.component.candidateArtifactSha256) {
    reasons.push("trusted deployment intent candidate artifact SHA256 does not match signed entry");
  }
  if (input.entry.verdict !== "SAFE") reasons.push(`entry verdict is ${input.entry.verdict}; fleet policy requires SAFE`);
  if (!policy.allowedPublisherKeyIds.includes(input.entry.signature.keyId)) reasons.push("publisher key is not allowed by fleet policy");
  if (!policy.allowedComponents.some((item2) => item2.ecosystem === input.entry.component.ecosystem && item2.name === input.entry.component.name)) {
    reasons.push("component is not allowed by fleet policy");
  }
  if (!policy.allowedRunnerImages.includes(input.entry.runner.imageDigest)) reasons.push("runner image is not allowed by fleet policy");
  if (!policy.allowedConfigSha256.includes(input.entry.runner.configSha256)) reasons.push("configuration is not allowed by fleet policy");
  if (!policy.allowedCanaryHarnessSha256.includes(input.entry.runner.canaryHarnessSha256)) reasons.push("canary harness is not allowed by fleet policy");
  if (input.entry.canaries.length < policy.minimumCanaries) reasons.push("entry has fewer canaries than fleet policy requires");
  const ageHours = (evaluatedMilliseconds - Date.parse(input.entry.generatedAt)) / 36e5;
  if (!Number.isFinite(ageHours) || ageHours < 0) reasons.push("entry timestamp is in the future or invalid");
  else if (ageHours > policy.maxEvidenceAgeHours) reasons.push("entry is older than fleet policy permits");
  const value = {
    schemaVersion: FLEET_DECISION_SCHEMA,
    evaluatedAt,
    policyId: policy.policyId,
    policySha256: hash6(canonical(policy)),
    entryHash: input.entry.entryHash,
    component: {
      ecosystem: input.entry.component.ecosystem,
      name: input.entry.component.name,
      currentVersion: input.entry.component.currentVersion,
      candidateVersion: input.entry.component.candidateVersion
    },
    deploymentIntent: { source: "trusted-caller", ...deploymentIntent },
    status: reasons.length ? "BLOCK" : "ALLOW",
    reasons: reasons.length ? reasons : ["signed exact-pair evidence matches trusted deployment intent and satisfies every fleet policy constraint"]
  };
  return { ...value, decisionHash: hash6(decisionPayload(value)) };
}
function renderFleetDecision(value) {
  const lines = [
    `Agent Vigil fleet gate: ${value.status}`,
    `  evidence: ${terminalSafe(value.component.name)} ${terminalSafe(value.component.currentVersion)} -> ${terminalSafe(value.component.candidateVersion)}`,
    `  intent:   ${terminalSafe(value.deploymentIntent.currentVersion)} -> ${terminalSafe(value.deploymentIntent.candidateVersion)}`,
    `  artifacts: ${terminalSafe(value.deploymentIntent.currentArtifactSha256)} -> ${terminalSafe(value.deploymentIntent.candidateArtifactSha256)}`,
    `  policy: ${terminalSafe(value.policyId)}`
  ];
  for (const reason of value.reasons) lines.push(`  ${value.status === "ALLOW" ? "\u2713" : "!"} ${terminalSafe(reason)}`);
  lines.push(`  ${value.decisionHash}`);
  return `${lines.join("\n")}
`;
}

// src/upgrade/setup.ts
import { execFileSync as execFileSync11 } from "node:child_process";
import {
  chmodSync as chmodSync3,
  existsSync as existsSync6,
  lstatSync as lstatSync8,
  mkdirSync as mkdirSync5,
  readFileSync as readFileSync20,
  realpathSync as realpathSync9
} from "node:fs";
import { dirname as dirname8, join as join9, relative as relative11, resolve as resolve17, sep as sep9 } from "node:path";
var DEFAULT_UPGRADE_DIRECTORY = ".agent-vigil/upgrade";
var DEFAULT_UPGRADE_CONFIG = `${DEFAULT_UPGRADE_DIRECTORY}/config.json`;
var DEFAULT_UPGRADE_RECEIPT = `${DEFAULT_UPGRADE_DIRECTORY}/last-receipt.json`;
var DEFAULT_RUNNER_IMAGE = "node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752";
function ensureRepository(path) {
  const requested = resolve17(path);
  const status = lstatSync8(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("--repo must be a regular directory, not a symbolic link");
  const repository2 = realpathSync9(requested);
  try {
    const prefix = execFileSync11("git", ["rev-parse", "--show-prefix"], {
      cwd: repository2,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (prefix !== "") throw new Error("nested");
  } catch {
    throw new Error("--repo must be the root of a Git repository");
  }
  return repository2;
}
function inside(repository2, path) {
  const target = resolve17(repository2, path);
  const rel = relative11(repository2, target);
  if (rel === ".." || rel.startsWith(`..${sep9}`)) throw new Error("upgrade setup path escaped the repository");
  return target;
}
function ensurePrivateDirectory(repository2, target) {
  const rel = relative11(repository2, target);
  if (rel === ".." || rel.startsWith(`..${sep9}`)) throw new Error("upgrade setup directory escaped the repository");
  let current = repository2;
  for (const component of rel.split(sep9).filter(Boolean)) {
    current = join9(current, component);
    if (existsSync6(current)) {
      const status = lstatSync8(current);
      if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`refusing unsafe setup directory: ${current}`);
    } else {
      mkdirSync5(current, { mode: 448 });
    }
    if (process.platform !== "win32") chmodSync3(current, 448);
  }
}
function inferredName(repository2) {
  const manifest = join9(repository2, "package.json");
  try {
    const value = JSON.parse(readFileSync20(manifest, "utf8"));
    if (typeof value.name === "string" && /^[A-Za-z0-9@][A-Za-z0-9@/._-]{0,159}$/.test(value.name)) return value.name;
  } catch {
  }
  return "replace-with-agent-component";
}
function configTemplate(repository2) {
  return `${JSON.stringify({
    schemaVersion: UPGRADE_CONFIG_SCHEMA,
    component: {
      ecosystem: "agent-plugin",
      name: inferredName(repository2),
      manifestPath: "package.json",
      identityField: "name",
      versionField: "version",
      capabilityFields: ["contributes", "mcpServers", "hooks", "skills", "commands", "dependencies"]
    },
    runner: {
      engine: "docker",
      image: DEFAULT_RUNNER_IMAGE,
      trials: 2,
      memoryMiB: 512,
      cpus: 1,
      pids: 128
    },
    canaryDirectory: `${DEFAULT_UPGRADE_DIRECTORY}/canaries`,
    canaries: [{
      id: "replace-with-repository-canary",
      command: ["node", "/canaries/template-canary.mjs"],
      timeoutSeconds: 30
    }]
  }, null, 2)}
`;
}
var CANARY_TEMPLATE = `// This template intentionally reports FAIL. Replace it with a deterministic,
// repository-specific behavioral canary before an update can earn SAFE.
process.stdout.write(JSON.stringify({
  schemaVersion: "agent-vigil-upgrade-canary/v1",
  outcome: "FAIL",
  observations: { templateRequiresReplacement: true }
}));
`;
function writeScaffold2(path, content, force, result5) {
  if (existsSync6(path) && !force) {
    const status = lstatSync8(path);
    if (status.isSymbolicLink() || !status.isFile()) throw new Error(`refusing unsafe existing scaffold: ${path}`);
    result5.kept.push(path);
    return;
  }
  writePrivateFileAtomic(path, content);
  result5.created.push(path);
}
function initUpgrade(repositoryPath, force = false) {
  const repository2 = ensureRepository(repositoryPath);
  const root = inside(repository2, DEFAULT_UPGRADE_DIRECTORY);
  const canaries = join9(root, "canaries");
  ensurePrivateDirectory(repository2, canaries);
  const result5 = { created: [], kept: [] };
  writeScaffold2(join9(root, ".gitignore"), "*\n!.gitignore\n", force, result5);
  writeScaffold2(join9(root, "config.json"), configTemplate(repository2), force, result5);
  writeScaffold2(join9(canaries, "template-canary.mjs"), CANARY_TEMPLATE, force, result5);
  return result5;
}
function doctorUpgrade(repositoryPath, configPath, dockerBin = "docker") {
  const repository2 = ensureRepository(repositoryPath);
  const selectedConfig = configPath ? resolve17(configPath) : join9(repository2, DEFAULT_UPGRADE_CONFIG);
  const rel = relative11(repository2, selectedConfig);
  if (rel === ".." || rel.startsWith(`..${sep9}`)) throw new Error("upgrade config must remain inside the repository");
  const trustedConfig = trustedRegularFileInside(repository2, selectedConfig, "upgrade config");
  const config = loadUpgradeConfig(trustedConfig);
  const canaryDirectory = trustedDirectoryInside(
    repository2,
    inside(repository2, config.canaryDirectory),
    "canaryDirectory"
  );
  const templateCanary = config.canaries.some((canary) => canary.id === "replace-with-repository-canary");
  let imagePresent = false;
  let containment;
  try {
    const dockerClient = resolveDockerClient(dockerBin);
    imagePresent = dockerImagePresent(config, dockerClient);
    containment = probeContainment(config, repository2, canaryDirectory, dockerClient);
  } catch (error) {
    containment = {
      status: "HOLD",
      localEndpoint: false,
      imagePresent: false,
      networkBlocked: false,
      targetReadOnly: false,
      rootReadOnly: false,
      inheritedSecretAbsent: false,
      proxiesCleared: false,
      reason: error.message
    };
  }
  const checks = [
    { status: "PASS", label: "config", detail: "strict upgrade config loaded" },
    { status: imagePresent ? "PASS" : "HOLD", label: "runner image", detail: imagePresent ? "exact digest is present locally" : "exact digest is absent; Upgrade Guard will not pull it during a check" },
    { status: containment.status, label: "containment", detail: containment.reason },
    { status: templateCanary ? "HOLD" : "PASS", label: "canaries", detail: templateCanary ? "replace the fail-closed template with a repository-specific behavioral canary" : `${config.canaries.length} configured canary or canaries` }
  ];
  return {
    status: checks.every((check) => check.status === "PASS") ? "READY" : "HOLD",
    configPath: trustedConfig,
    imagePresent,
    templateCanary,
    containment,
    checks
  };
}
function renderUpgradeDoctor(result5) {
  const lines = [
    `Agent Vigil Upgrade Guard doctor: ${terminalSafe(result5.status)}`,
    `  config: ${terminalSafe(result5.configPath)}`
  ];
  for (const check of result5.checks) {
    lines.push(`  ${check.status === "PASS" ? "\u2713" : "?"} ${terminalSafe(check.label)}: ${terminalSafe(check.detail)}`);
  }
  return `${lines.join("\n")}
`;
}

// src/upgrade/cli.ts
function usage() {
  return `Agent Vigil Upgrade Guard

Usage:
  vigil upgrade init [--repo <path>] [--force]
  vigil upgrade doctor [--repo <path>] [--config <path>] [--docker-bin <path>]
  vigil upgrade plan --manager <apm|skills|agent-plugin> --current <state> --candidate <state> [--repo <path>] [--output <plan.json>]
  vigil upgrade preflight --current-lock <apm.lock.yaml> --candidate-lock <apm.lock.yaml> [--plan <plan.json>] [--identity <apm:...>] [--repo <path>] [--config <path>] [--work-directory <path>] [--output <receipt.json>] [--public-output <entry.json> --signing-key <key>] [--docker-bin <path>] [--fetch-bin <path>]
  vigil upgrade check --current <dir> --candidate <dir> [--repo <path>] [--config <path>] [--output <private.json>] [--public-output <entry.json> --signing-key <key>] [--docker-bin <path>]
  vigil upgrade verify <entry.json> [--public-key <path>]
  vigil upgrade evidence <entry.json> --output <issue.md> --public-key <path>
  vigil upgrade resolve --broken <entry.json> --fixed <entry.json> --output <resolution.json> --public-key <path> --signing-key <path>
  vigil upgrade enforce <entry.json> --policy <fleet-policy.json> --public-key <path> --expected-current-version <version> --expected-candidate-version <version> --expected-current-artifact-sha256 <sha256:...> --expected-candidate-artifact-sha256 <sha256:...> [--output <decision.json>]
  vigil upgrade index <entry-or-resolution.json>... --output <index.html> --public-key <path> [--api-output <registry.json>] [--badge-directory <dir>]

Exit codes: 0 SAFE/verified \xB7 1 CHANGED/invalid signature \xB7 2 HOLD or usage error`;
}
function option(args, name) {
  const indexes = args.flatMap((arg, index) => arg === name ? [index] : []);
  if (indexes.length > 1) throw optionOnlyOnceError(name);
  if (!indexes.length) return void 0;
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw optionRequiresValueError(name);
  return value;
}
function assertKnown(args, values, flags = [], allowPositionals = false) {
  const allowed = /* @__PURE__ */ new Set([...values, ...flags]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (!allowPositionals) throw unexpectedPositionalError();
      continue;
    }
    if (!allowed.has(arg)) throw unknownOptionError(arg);
    if (values.includes(arg)) index += 1;
  }
}
function repository(args) {
  return resolve18(option(args, "--repo") ?? ".");
}
function insideRepository(repositoryPath, value, label) {
  const repository2 = resolve18(repositoryPath);
  const path = resolve18(repository2, value);
  const rel = relative12(repository2, path);
  if (rel === ".." || rel.startsWith(`..${sep10}`)) throw new Error(`${label} must remain inside --repo`);
  return path;
}
function outputIdentity(path) {
  const parent = realpathSync10(dirname9(resolve18(path)));
  const status = statSync9(parent, { bigint: true });
  const name = basename7(path);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.endsWith(".") || name.endsWith(" ") || name.includes("~")) {
    throw new Error(`output basename is not portable and collision-safe: ${name}`);
  }
  return `${status.dev}:${status.ino}:${name.toUpperCase()}`;
}
function assertDistinctOutputs(paths) {
  const identities = paths.map(outputIdentity);
  if (new Set(identities).size !== identities.length) throw new Error("requested output paths resolve to the same filesystem entry");
}
function pathIdentities(path) {
  const requested = resolve18(path);
  const identities = [outputIdentity(requested)];
  const canonical3 = realpathSync10(requested);
  const canonicalIdentity = outputIdentity(canonical3);
  if (!identities.includes(canonicalIdentity)) identities.push(canonicalIdentity);
  return identities;
}
function assertOutputsDoNotAliasInputs(outputs, inputs) {
  const outputIds = new Set(outputs.map(outputIdentity));
  for (const input of inputs) {
    if (pathIdentities(input).some((identity) => outputIds.has(identity))) {
      throw new Error("requested output path aliases a required input file");
    }
  }
}
function assertOutputsOutsideRoots(outputs, roots) {
  for (const rootPath of roots) {
    const root = realpathSync10(rootPath);
    for (const output of outputs) {
      const parent = realpathSync10(dirname9(resolve18(output)));
      const target = resolve18(parent, basename7(output));
      const rel = relative12(root, target);
      if (rel === "" || !isAbsolute8(rel) && rel !== ".." && !rel.startsWith(`..${sep10}`)) {
        throw new Error("requested output path must remain outside current, candidate, and canary input trees");
      }
    }
  }
}
function readPublicEntry(path) {
  return validatePublicCompatibilityEntry(readBoundedJson(path, 512 * 1024, "public compatibility entry"));
}
function manager(value) {
  if (value !== "apm" && value !== "skills" && value !== "agent-plugin") {
    throw new Error("--manager must be apm, skills, or agent-plugin");
  }
  return value;
}
function runInit(args) {
  assertKnown(args, ["--repo"], ["--force", "--help"]);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const result5 = initUpgrade(repository(args), args.includes("--force"));
  console.log("Agent Vigil Upgrade Guard initialized locally.\n");
  for (const path of result5.created) console.log(`  created ${terminalSafe(path)}`);
  for (const path of result5.kept) console.log(`  kept    ${terminalSafe(path)}`);
  console.log("\nThe scaffold is ignored by Git and intentionally returns HOLD until its template canary is replaced.");
  return 0;
}
function runDoctor(args) {
  assertKnown(args, ["--repo", "--config", "--docker-bin"], ["--help"]);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const repo = repository(args);
  const config = option(args, "--config");
  const configPath = config ? insideRepository(repo, config, "--config") : void 0;
  const result5 = doctorUpgrade(repo, configPath, option(args, "--docker-bin") ?? "docker");
  process.stdout.write(renderUpgradeDoctor(result5));
  return result5.status === "READY" ? 0 : 2;
}
function runPlan(args) {
  assertKnown(args, ["--repo", "--manager", "--current", "--candidate", "--output"], ["--help"]);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const repo = repository(args);
  const current = option(args, "--current");
  const candidate = option(args, "--candidate");
  if (!current || !candidate) throw new Error("upgrade plan requires --current <state> and --candidate <state>");
  const selectedManager = manager(option(args, "--manager"));
  const currentPath = resolve18(current);
  const candidatePath = resolve18(candidate);
  const output = insideRepository(repo, option(args, "--output") ?? ".agent-vigil/upgrade/update-plan.json", "--output");
  assertOutputsDoNotAliasInputs([output], [currentPath, candidatePath]);
  if (selectedManager === "agent-plugin") assertOutputsOutsideRoots([output], [currentPath, candidatePath]);
  const plan = createUpdatePlan({ manager: selectedManager, currentPath, candidatePath });
  writePrivateFileAtomic(output, `${JSON.stringify(plan, null, 2)}
`);
  process.stdout.write(renderUpdatePlan(plan));
  return plan.summary.total ? 1 : 0;
}
function runCheck(args) {
  assertKnown(args, ["--repo", "--config", "--current", "--candidate", "--output", "--public-output", "--signing-key", "--docker-bin"], ["--help"]);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const repo = repository(args);
  const current = option(args, "--current");
  const candidate = option(args, "--candidate");
  if (!current || !candidate) throw new Error("upgrade check requires --current <dir> and --candidate <dir>");
  const config = insideRepository(repo, option(args, "--config") ?? DEFAULT_UPGRADE_CONFIG, "--config");
  const trustedConfig = trustedRegularFileInside(repo, config, "upgrade config");
  const loadedConfig = loadUpgradeConfig(trustedConfig);
  const currentDirectory = resolve18(current);
  const candidateDirectory = resolve18(candidate);
  const canaryDirectory = trustedDirectoryInside(
    repo,
    resolve18(repo, loadedConfig.canaryDirectory),
    "canary directory"
  );
  const output = insideRepository(repo, option(args, "--output") ?? DEFAULT_UPGRADE_RECEIPT, "--output");
  const publicOption = option(args, "--public-output");
  const signingKey = option(args, "--signing-key");
  if (Boolean(publicOption) !== Boolean(signingKey)) throw new Error("--public-output and --signing-key must be supplied together");
  const publicOutput = publicOption ? resolve18(publicOption) : void 0;
  const outputs = [output, ...publicOutput ? [publicOutput] : []];
  assertDistinctOutputs(outputs);
  assertOutputsDoNotAliasInputs(outputs, [trustedConfig, ...signingKey ? [resolve18(signingKey)] : []]);
  assertOutputsOutsideRoots(outputs, [currentDirectory, candidateDirectory, canaryDirectory]);
  const receipt = runUpgradeEvaluation({
    configPath: trustedConfig,
    config: loadedConfig,
    repository: repo,
    currentDirectory,
    candidateDirectory,
    dockerBin: option(args, "--docker-bin") ?? "docker"
  });
  writePrivateFileAtomic(output, `${JSON.stringify(receipt, null, 2)}
`);
  if (publicOutput && signingKey) {
    const entry = createPublicCompatibilityEntry(receipt, resolve18(signingKey));
    writePrivateFileAtomic(publicOutput, `${JSON.stringify(entry, null, 2)}
`);
  }
  process.stdout.write(renderUpgradeReceipt(receipt));
  return receipt.summary.verdict === "SAFE" ? 0 : receipt.summary.verdict === "CHANGED" ? 1 : 2;
}
function runPreflight(args) {
  const valueOptions = [
    "--repo",
    "--current-lock",
    "--candidate-lock",
    "--plan",
    "--identity",
    "--config",
    "--work-directory",
    "--output",
    "--public-output",
    "--signing-key",
    "--docker-bin",
    "--fetch-bin"
  ];
  assertKnown(args, valueOptions, ["--help"]);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const repo = repository(args);
  const currentOption = option(args, "--current-lock");
  const candidateOption = option(args, "--candidate-lock");
  if (!currentOption || !candidateOption) {
    throw new Error("upgrade preflight requires --current-lock <state> and --candidate-lock <state>");
  }
  const currentLockPath = resolve18(currentOption);
  const candidateLockPath = resolve18(candidateOption);
  const config = insideRepository(repo, option(args, "--config") ?? DEFAULT_UPGRADE_CONFIG, "--config");
  const trustedConfig = trustedRegularFileInside(repo, config, "upgrade config");
  const planOption = option(args, "--plan");
  const planPath = planOption ? resolve18(planOption) : void 0;
  const suppliedPlan = planPath ? readBoundedJson(planPath, 4 * 1024 * 1024, "APM update plan") : void 0;
  const outputOption = option(args, "--output");
  const output = outputOption ? resolve18(outputOption) : insideRepository(repo, ".agent-vigil/upgrade/apm-preflight-receipt.json", "--output");
  const publicOption = option(args, "--public-output");
  const signingKey = option(args, "--signing-key");
  if (Boolean(publicOption) !== Boolean(signingKey)) {
    throw new Error("--public-output and --signing-key must be supplied together");
  }
  const publicOutput = publicOption ? resolve18(publicOption) : void 0;
  const outputs = [output, ...publicOutput ? [publicOutput] : []];
  assertDistinctOutputs(outputs);
  assertOutputsDoNotAliasInputs(outputs, [
    currentLockPath,
    candidateLockPath,
    trustedConfig,
    ...planPath ? [planPath] : [],
    ...signingKey ? [resolve18(signingKey)] : []
  ]);
  const receipt = runApmAutomaticPreflight({
    repository: repo,
    currentLockPath,
    candidateLockPath,
    configPath: trustedConfig,
    ...option(args, "--identity") ? { identity: option(args, "--identity") } : {},
    ...suppliedPlan !== void 0 ? { suppliedPlan } : {},
    ...option(args, "--docker-bin") ? { dockerBin: option(args, "--docker-bin") } : {},
    ...option(args, "--fetch-bin") ? { fetchBin: option(args, "--fetch-bin") } : {},
    ...option(args, "--work-directory") ? { workDirectory: resolve18(option(args, "--work-directory")) } : {}
  });
  writePrivateFileAtomic(output, `${JSON.stringify(receipt, null, 2)}
`);
  if (publicOutput && signingKey && receipt.summary.verdict !== "HOLD" && receipt.upgradeReceipt) {
    const entry = createPublicCompatibilityEntry(receipt.upgradeReceipt, resolve18(signingKey));
    writePrivateFileAtomic(publicOutput, `${JSON.stringify(entry, null, 2)}
`);
  }
  process.stdout.write(renderApmAutomaticPreflight(receipt));
  return receipt.summary.verdict === "SAFE" ? 0 : receipt.summary.verdict === "CHANGED" ? 1 : 2;
}
function positional(args, optionsWithValues) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    if (optionsWithValues.includes(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("--")) output.push(args[index]);
  }
  return output;
}
function runVerify(args) {
  assertKnown(args, ["--public-key"], ["--help"], true);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const entries = positional(args, ["--public-key"]);
  if (entries.length !== 1) throw new Error("upgrade verify requires exactly one public entry path");
  const inputPath = resolve18(entries[0]);
  const raw = readBoundedJson(inputPath, 512 * 1024, "compatibility record");
  const schema4 = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.schemaVersion : void 0;
  const publicKey = option(args, "--public-key") ? resolve18(option(args, "--public-key")) : void 0;
  const result5 = schema4 === COMPATIBILITY_RESOLUTION_SCHEMA ? verifyCompatibilityResolution(validateCompatibilityResolution(raw), publicKey) : verifyPublicCompatibilityEntry(validatePublicCompatibilityEntry(raw), publicKey);
  console.log(JSON.stringify(result5));
  return result5.hashValid && result5.signatureValid === true ? 0 : 1;
}
function runEvidence(args) {
  assertKnown(args, ["--output", "--public-key"], ["--help"], true);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const inputs = positional(args, ["--output", "--public-key"]);
  const outputOption = option(args, "--output");
  const publicKey = option(args, "--public-key");
  if (inputs.length !== 1 || !outputOption || !publicKey) {
    throw new Error("upgrade evidence requires one entry, --output <issue.md>, and --public-key <path>");
  }
  const inputPath = resolve18(inputs[0]);
  const output = resolve18(outputOption);
  const publicKeyPath = resolve18(publicKey);
  assertOutputsDoNotAliasInputs([output], [inputPath, publicKeyPath]);
  const entry = readPublicEntry(inputPath);
  const checked2 = verifyPublicCompatibilityEntry(entry, publicKeyPath);
  if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error("public entry failed pinned-key verification");
  writePrivateFileAtomic(output, renderMaintainerEvidence(entry));
  console.log(`Wrote privacy-minimized maintainer evidence to ${terminalSafe(output)}`);
  return 0;
}
function runResolve(args) {
  assertKnown(args, ["--broken", "--fixed", "--output", "--public-key", "--signing-key"], ["--help"]);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const brokenOption = option(args, "--broken");
  const fixedOption = option(args, "--fixed");
  const outputOption = option(args, "--output");
  const publicKeyOption = option(args, "--public-key");
  const signingKeyOption = option(args, "--signing-key");
  if (!brokenOption || !fixedOption || !outputOption || !publicKeyOption || !signingKeyOption) {
    throw new Error("upgrade resolve requires --broken, --fixed, --output, --public-key, and --signing-key");
  }
  const brokenPath = resolve18(brokenOption);
  const fixedPath = resolve18(fixedOption);
  const output = resolve18(outputOption);
  const publicKeyPath = resolve18(publicKeyOption);
  const signingKeyPath = resolve18(signingKeyOption);
  assertOutputsDoNotAliasInputs([output], [brokenPath, fixedPath, publicKeyPath, signingKeyPath]);
  const broken = readPublicEntry(brokenPath);
  const fixed = readPublicEntry(fixedPath);
  for (const [label, entry] of [["broken", broken], ["fixed", fixed]]) {
    const checked2 = verifyPublicCompatibilityEntry(entry, publicKeyPath);
    if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error(`${label} entry failed pinned-key verification`);
  }
  const resolution = createCompatibilityResolution({
    broken,
    fixed,
    privateKeyPath: signingKeyPath
  });
  writePrivateFileAtomic(output, `${JSON.stringify(resolution, null, 2)}
`);
  console.log(`Wrote signed compatibility restoration record to ${terminalSafe(output)}`);
  return 0;
}
function runEnforce(args) {
  const valueOptions = [
    "--policy",
    "--public-key",
    "--output",
    "--expected-current-version",
    "--expected-candidate-version",
    "--expected-current-artifact-sha256",
    "--expected-candidate-artifact-sha256"
  ];
  assertKnown(args, valueOptions, ["--help"], true);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const inputs = positional(args, valueOptions);
  const policyOption = option(args, "--policy");
  const publicKeyOption = option(args, "--public-key");
  const expectedCurrentVersion = option(args, "--expected-current-version");
  const expectedCandidateVersion = option(args, "--expected-candidate-version");
  const expectedCurrentArtifactSha256 = option(args, "--expected-current-artifact-sha256");
  const expectedCandidateArtifactSha256 = option(args, "--expected-candidate-artifact-sha256");
  if (inputs.length !== 1 || !policyOption || !publicKeyOption || !expectedCurrentVersion || !expectedCandidateVersion || !expectedCurrentArtifactSha256 || !expectedCandidateArtifactSha256) {
    throw fleetDeploymentIntentRequiredError();
  }
  const deploymentIntent = validateFleetDeploymentIntent({
    currentVersion: expectedCurrentVersion,
    candidateVersion: expectedCandidateVersion,
    currentArtifactSha256: expectedCurrentArtifactSha256,
    candidateArtifactSha256: expectedCandidateArtifactSha256
  });
  const entryPath = resolve18(inputs[0]);
  const policyPath = resolve18(policyOption);
  const publicKeyPath = resolve18(publicKeyOption);
  const outputOption = option(args, "--output");
  const output = outputOption ? resolve18(outputOption) : void 0;
  if (output) assertOutputsDoNotAliasInputs([output], [entryPath, policyPath, publicKeyPath]);
  const entry = readPublicEntry(entryPath);
  const checked2 = verifyPublicCompatibilityEntry(entry, publicKeyPath);
  if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error("public entry failed pinned-key verification");
  const policy = validateFleetPolicy(readBoundedJson(policyPath, 256 * 1024, "fleet policy"));
  const decision = enforceFleetPolicy({ policy, entry, deploymentIntent });
  if (output) writePrivateFileAtomic(output, `${JSON.stringify(decision, null, 2)}
`);
  process.stdout.write(renderFleetDecision(decision));
  return decision.status === "ALLOW" ? 0 : 1;
}
function runIndex(args) {
  assertKnown(args, ["--output", "--api-output", "--public-key", "--badge-directory"], ["--help"], true);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const inputs = positional(args, ["--output", "--api-output", "--public-key", "--badge-directory"]);
  const outputOption = option(args, "--output");
  const apiOutputOption = option(args, "--api-output");
  const publicKey = option(args, "--public-key");
  if (!inputs.length || !outputOption || !publicKey) throw new Error("upgrade index requires entries or resolutions, --output <index.html>, and --public-key <path>");
  if (inputs.length > 2048) throw new Error("upgrade index accepts at most 2048 inputs");
  const output = resolve18(outputOption);
  const apiOutput = apiOutputOption ? resolve18(apiOutputOption) : void 0;
  if (apiOutput) assertDistinctOutputs([output, apiOutput]);
  const inputPaths = inputs.map((path) => resolve18(path));
  const publicKeyPath = resolve18(publicKey);
  const badgeOption = option(args, "--badge-directory");
  let badgeDirectory;
  if (badgeOption) {
    const requested = resolve18(badgeOption);
    const status = lstatSync9(requested);
    if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("--badge-directory must be an existing regular directory");
    badgeDirectory = realpathSync10(requested);
  }
  const entries = [];
  const resolutions = [];
  for (const inputPath of inputPaths) {
    const raw = readBoundedJson(inputPath, 512 * 1024, "registry input");
    const schema4 = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.schemaVersion : void 0;
    if (schema4 === COMPATIBILITY_RESOLUTION_SCHEMA) {
      const resolution = validateCompatibilityResolution(raw);
      const checked2 = verifyCompatibilityResolution(resolution, publicKeyPath);
      if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error(`resolution failed verification: ${inputPath}`);
      resolutions.push(resolution);
    } else {
      const entry = validatePublicCompatibilityEntry(raw);
      const checked2 = verifyPublicCompatibilityEntry(entry, publicKeyPath);
      if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error(`public entry failed verification: ${inputPath}`);
      entries.push(entry);
    }
  }
  const badgeOutputs = badgeDirectory ? entries.map((entry) => resolve18(badgeDirectory, `${entry.entryHash.slice(7)}.json`)) : [];
  const outputs = [output, ...apiOutput ? [apiOutput] : [], ...badgeOutputs];
  assertDistinctOutputs(outputs);
  assertOutputsDoNotAliasInputs(outputs, [...inputPaths, publicKeyPath]);
  const registry = createCompatibilityRegistry(entries, resolutions);
  writePrivateFileAtomic(output, renderCompatibilityRegistryPage(registry));
  if (apiOutput) writePrivateFileAtomic(apiOutput, `${JSON.stringify(registry, null, 2)}
`);
  if (badgeDirectory) {
    for (const entry of entries) {
      writePrivateFileAtomic(resolve18(badgeDirectory, `${entry.entryHash.slice(7)}.json`), renderBadgeEndpoint(entry));
    }
  }
  console.log(`Wrote ${entries.length} verified compatibility entr${entries.length === 1 ? "y" : "ies"}, ${resolutions.length} resolution record(s)${apiOutput ? ", and a static JSON API" : ""} to ${terminalSafe(output)}`);
  return 0;
}
function runUpgradeCommand(args) {
  try {
    const command = args[0];
    const rest = args.slice(1);
    if (!command || command === "--help" || command === "help") {
      console.log(usage());
      return 0;
    }
    if (command === "init") return runInit(rest);
    if (command === "doctor") return runDoctor(rest);
    if (command === "plan") return runPlan(rest);
    if (command === "preflight") return runPreflight(rest);
    if (command === "check") return runCheck(rest);
    if (command === "verify") return runVerify(rest);
    if (command === "evidence") return runEvidence(rest);
    if (command === "resolve") return runResolve(rest);
    if (command === "enforce") return runEnforce(rest);
    if (command === "index") return runIndex(rest);
    throw unknownUpgradeCommandError();
  } catch (error) {
    return reportCliError("agent-vigil upgrade", error);
  }
}

// src/proof-comment.ts
var PROOF_COMMENT_MARKER = "<!-- agent-vigil-proof-comment:v1 -->";
function code(value) {
  return `\`${terminalSafe(value).replace(/`/g, "\\`")}\``;
}
function count(results, ruleId, verdict) {
  return results.filter((result5) => result5.ruleId === ruleId && (!verdict || result5.verdict === verdict)).length;
}
function verifiedUrl(raw) {
  if (!raw) return void 0;
  if (raw.length > 2048) throw new Error("proof comment verify URL exceeds 2048 characters");
  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("proof comment verify URL must be an absolute HTTPS URL");
  }
  if (value.protocol !== "https:" || value.username || value.password) {
    throw new Error("proof comment verify URL must be an absolute HTTPS URL without credentials");
  }
  return value.toString();
}
function renderProofComment(report, options = {}) {
  const verification2 = verifyReport(report);
  if (!verification2.hashValid) throw new Error("proof comment receipt content does not match receiptHash");
  if (verification2.signatureValid === false) throw new Error("proof comment receipt signature is invalid");
  const results = report.results ?? [];
  const differentialEarned = count(results, "differential-test", "verified");
  const differentialAlsoPassedBase = count(results, "differential-base-fail", "contradicted");
  const integrityChanges = results.filter(
    (result5) => result5.verdict === "contradicted" && (result5.claim.kind === "integrity" || result5.ruleId?.startsWith("integrity-"))
  ).length;
  const authorityBlocks = results.filter(
    (result5) => result5.verdict === "contradicted" && result5.ruleId !== "authority-plan" && result5.ruleId?.startsWith("authority-")
  ).length;
  const signature = verification2.signatureValid ? "valid embedded Ed25519 signature; signer identity is not pinned" : "absent; content hash only";
  const url = verifiedUrl(options.verifyUrl);
  const title = report.summary.status === "PASS" ? "Required evidence is present for this exact change" : report.summary.status === "FAIL" ? "Required evidence was contradicted for this exact change" : "Evidence is incomplete for this exact change";
  const facts = [
    `- **Evidence:** ${report.summary.verified} verified, ${report.summary.contradicted} contradicted, ${report.summary.unverifiable} unresolved`,
    `- **Candidate-only regression checks:** ${differentialEarned} verified`,
    `- **Changed regression checks that also passed on base:** ${differentialAlsoPassedBase}`,
    `- **Integrity-control contradictions:** ${integrityChanges}`,
    `- **Unapproved authority contradictions:** ${authorityBlocks}`
  ];
  return [
    PROOF_COMMENT_MARKER,
    `### Agent Vigil: ${report.summary.status}`,
    "",
    title,
    "",
    ...facts,
    "",
    `**Change:** ${code(report.base)} -> ${code(report.head)}  `,
    `**Policy:** ${code(report.policy.sha256)}  `,
    `**Receipt:** ${code(report.receiptHash)}  `,
    `**Signature:** ${signature}`,
    ...url ? ["", `[Verify this receipt](${url.replace(/[()]/g, (character) => `\\${character}`)})`] : [],
    "",
    "The retained receipt contains the check details. This result does not prove that the code is bug-free or that unobserved actions did not occur.",
    ""
  ].join("\n");
}

// src/control-proof.ts
import { createHash as createHash20 } from "node:crypto";
import { execFileSync as execFileSync12 } from "node:child_process";
import {
  existsSync as existsSync7,
  lstatSync as lstatSync10,
  mkdirSync as mkdirSync6,
  mkdtempSync as mkdtempSync4,
  realpathSync as realpathSync11,
  rmSync as rmSync3,
  writeFileSync as writeFileSync6
} from "node:fs";
import { tmpdir as tmpdir3 } from "node:os";
import { dirname as dirname10, isAbsolute as isAbsolute9, join as join10, relative as relative13, resolve as resolve19, sep as sep11 } from "node:path";
var FIXED_COMMIT_EPOCH = Date.parse("2000-01-01T00:00:00Z") / 1e3;
function git8(repo, args, env) {
  return execFileSync12("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...env ? { env } : {}
  }).trim();
}
function digest3(value) {
  return `sha256:${createHash20("sha256").update(canonical(value)).digest("hex")}`;
}
function safeError(error, redactions = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of redactions.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(value, value.includes("control-proof-") ? "<temporary-directory>" : "<source-repository>");
  }
  return terminalSafe(message.replace(/\s+/g, " ").slice(0, 400));
}
function assertDisposableClone(root, repo) {
  const realRoot = realpathSync11(root);
  const realRepo = realpathSync11(repo);
  if (!realRepo.startsWith(`${realRoot}${sep11}`) || !existsSync7(join10(realRepo, ".git"))) {
    throw new Error("refused to mutate a directory outside the disposable control-proof clone");
  }
}
function resetClone(root, repo, sourceCommit) {
  assertDisposableClone(root, repo);
  git8(repo, ["reset", "--hard", sourceCommit]);
  git8(repo, ["clean", "-fdx"]);
}
function safeWrite(repo, gitPath, content) {
  if (!gitPath || isAbsolute9(gitPath) || gitPath.includes("\\")) throw new Error("control-proof path must be repository-relative");
  const target = resolve19(repo, gitPath);
  const fromRoot = relative13(resolve19(repo), target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep11}`)) throw new Error("control-proof path escaped the clone");
  let current = resolve19(repo);
  for (const part of dirname10(fromRoot).split(sep11).filter((item2) => item2 && item2 !== ".")) {
    current = join10(current, part);
    if (existsSync7(current) && (!lstatSync10(current).isDirectory() || lstatSync10(current).isSymbolicLink())) {
      rmSync3(current, { recursive: true, force: true });
    }
    mkdirSync6(current, { recursive: true });
  }
  if (existsSync7(target)) rmSync3(target, { recursive: true, force: true });
  writeFileSync6(target, content, { encoding: "utf8", mode: 384 });
}
function commit(repo, message, sequence) {
  git8(repo, ["add", "-A"]);
  if (!git8(repo, ["status", "--porcelain=v1"])) throw new Error(`challenge produced no Git change: ${message}`);
  const epoch = String(FIXED_COMMIT_EPOCH + sequence);
  git8(repo, ["commit", "-qm", message], {
    ...process.env,
    GIT_AUTHOR_DATE: epoch,
    GIT_COMMITTER_DATE: epoch
  });
  return git8(repo, ["rev-parse", "HEAD"]);
}
function decideControlProof(challenges) {
  return challenges.length > 0 && challenges.every((challenge2) => challenge2.passed) ? "PASS" : "HOLD";
}
function buildControlProof(repo, base, vigilVersion) {
  const sourceRepo = realpathSync11(resolve19(repo));
  const sourceCommit = git8(sourceRepo, ["rev-parse", "--verify", `${base}^{commit}`]);
  const root = mkdtempSync4(join10(tmpdir3(), "agent-vigil-control-proof-"));
  const clone = join10(root, "repo");
  const challenges = [];
  let commitSequence = 1;
  const runChallenge = (id, claim, expected, execute) => {
    try {
      const result5 = execute();
      challenges.push({ id, claim, expected, ...result5, passed: result5.actual === expected });
    } catch (error) {
      challenges.push({
        id,
        claim,
        expected,
        actual: "ERROR",
        passed: false,
        base: sourceCommit,
        head: sourceCommit,
        evidence: safeError(error, [sourceRepo, root, clone])
      });
    }
  };
  try {
    execFileSync12("git", ["clone", "--quiet", "--no-local", "--no-checkout", sourceRepo, clone], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024
    });
    assertDisposableClone(root, clone);
    git8(clone, ["checkout", "--quiet", "--detach", sourceCommit]);
    git8(clone, ["config", "user.email", "control-proof@agent-vigil.invalid"]);
    git8(clone, ["config", "user.name", "Agent Vigil Control Proof"]);
    runChallenge("clean-control", "An unchanged authority surface is allowed.", "PASS", () => {
      resetClone(root, clone, sourceCommit);
      const plan = buildAuthorityPlan(clone, sourceCommit, sourceCommit, vigilVersion);
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: `${plan.summary.changes} authority changes and ${plan.summary.holds} held decisions`
      };
    });
    runChallenge("unapproved-mcp-server", "A new repository MCP server is blocked.", "BLOCK", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, ".mcp.json", `${JSON.stringify({ mcpServers: { "agent-vigil-control-probe": { command: "node", args: ["probe.mjs"] } } }, null, 2)}
`);
      const head = commit(clone, "control proof: add unapproved MCP server", commitSequence++);
      const plan = buildAuthorityPlan(clone, sourceCommit, head, vigilVersion);
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: `${plan.summary.blocking} blocking authority change(s); ${plan.deltas.filter((item2) => item2.disposition === "BLOCK").map((item2) => item2.summary).join(", ") || "none"}`
      };
    });
    runChallenge("candidate-self-approval", "A candidate cannot approve its own authority expansion.", "BLOCK", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, ".mcp.json", `${JSON.stringify({ mcpServers: { "agent-vigil-self-approval-probe": { command: "node", args: ["self-approval-probe.mjs"] } } }, null, 2)}
`);
      const expansionHead = commit(clone, "control proof: stage self-approved authority", commitSequence++);
      const expansion2 = buildAuthorityPlan(clone, sourceCommit, expansionHead, vigilVersion);
      const approvalKeys = expansion2.deltas.filter((item2) => item2.disposition === "BLOCK").map((item2) => item2.approvalKey);
      if (!approvalKeys.length) throw new Error("the planted authority expansion did not produce an approval key");
      safeWrite(clone, ".agent-vigil-authority-plan.json", `${JSON.stringify({ schemaVersion: 1, approvedAdditions: approvalKeys, allowUnknownChanges: true }, null, 2)}
`);
      const head = commit(clone, "control proof: candidate attempts self approval", commitSequence++);
      const plan = buildAuthorityPlan(clone, sourceCommit, head, vigilVersion);
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: `${plan.summary.blocking} planted expansion(s) remained blocked; policy source: ${plan.policy.source}`
      };
    });
    runChallenge("unreadable-authority-config", "An unreadable supported authority file stays on hold.", "HOLD", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, ".codex/config.toml", 'sandbox_mode = "unterminated\n');
      const head = commit(clone, "control proof: add unreadable authority config", commitSequence++);
      const plan = buildAuthorityPlan(clone, sourceCommit, head, vigilVersion);
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: `${plan.summary.holds} held decision(s); ${plan.gaps.map((item2) => item2.reason).join(", ") || "no evidence gap recorded"}`
      };
    });
    runChallenge("sandbox-weakening", "A weaker Codex sandbox setting is blocked.", "BLOCK", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, ".codex/config.toml", 'sandbox_mode = "workspace-write"\n');
      const baseline = commit(clone, "control proof: create sandbox baseline", commitSequence++);
      safeWrite(clone, ".codex/config.toml", 'sandbox_mode = "danger-full-access"\n');
      const head = commit(clone, "control proof: weaken sandbox", commitSequence++);
      const plan = buildAuthorityPlan(clone, baseline, head, vigilVersion);
      const sandbox = plan.deltas.find((item2) => item2.after?.action === "sandbox.mode" || item2.before?.action === "sandbox.mode");
      return {
        actual: plan.status,
        base: plan.base,
        head: plan.head,
        evidence: sandbox ? `${sandbox.summary}; ${sandbox.reason}` : "no sandbox change found"
      };
    });
    runChallenge("skipped-test", "A newly skipped test is blocked by the calibrated integrity policy.", "BLOCK", () => {
      resetClone(root, clone, sourceCommit);
      safeWrite(clone, "agent-vigil-control-proof.test.ts", 'import test from "node:test";\ntest.skip("planted control proof", () => { throw new Error("must not run"); });\n');
      const head = commit(clone, "control proof: skip a test", commitSequence++);
      const routed = routeIntegrity(checkIntegrity(clone, sourceCommit, head), "calibrated");
      const blocking = routed.results.filter((item2) => item2.verdict === "contradicted");
      const actual = blocking.length ? "BLOCK" : routed.results.some((item2) => item2.verdict === "unverifiable") ? "HOLD" : "PASS";
      return {
        actual,
        base: sourceCommit,
        head,
        evidence: blocking.map((item2) => item2.ruleId ?? "unlabeled-integrity-rule").join(", ") || "no calibrated blocking rule fired"
      };
    });
  } catch (error) {
    challenges.push({
      id: "disposable-environment",
      claim: "The disposable control-proof repository can be created safely.",
      expected: "PASS",
      actual: "ERROR",
      passed: false,
      base: sourceCommit,
      head: sourceCommit,
      evidence: safeError(error, [sourceRepo, root, clone])
    });
  }
  try {
    rmSync3(root, { recursive: true, force: true });
    challenges.push({
      id: "disposable-cleanup",
      claim: "The disposable repository is removed after the challenge run.",
      expected: "PASS",
      actual: existsSync7(root) ? "ERROR" : "PASS",
      passed: !existsSync7(root),
      base: sourceCommit,
      head: sourceCommit,
      evidence: existsSync7(root) ? "temporary control-proof directory still exists" : "temporary control-proof directory removed"
    });
  } catch (error) {
    challenges.push({
      id: "disposable-cleanup",
      claim: "The disposable repository is removed after the challenge run.",
      expected: "PASS",
      actual: "ERROR",
      passed: false,
      base: sourceCommit,
      head: sourceCommit,
      evidence: safeError(error, [sourceRepo, root, clone])
    });
  }
  const reproduction = `vigil prove --repo . --base ${sourceCommit}`;
  const limits = [
    "Challenges the installed Agent Vigil authority and test-integrity controls in a disposable local clone.",
    "Does not prove that a GitHub ruleset requires the check or that branch protection cannot be changed.",
    "Does not exercise every detector, a live coding agent, runtime IAM, deployments, or third-party services.",
    "Uses only local repository paths and does not push a branch or modify the source repository; installed Git and its configuration remain trusted."
  ];
  const status = decideControlProof(challenges);
  const payload = {
    schemaVersion: "agent-vigil-control-proof/v1",
    vigilVersion,
    status,
    sourceCommit,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    challenges,
    summary: { passed: challenges.filter((item2) => item2.passed).length, total: challenges.length },
    reproduction,
    limits
  };
  return {
    ...payload,
    receiptHash: digest3(payload)
  };
}
function renderControlProof(report) {
  const lines = [
    `Agent Vigil control proof: ${report.status}`,
    `Source: ${report.sourceCommit}`,
    ""
  ];
  for (const challenge2 of report.challenges) {
    const marker2 = challenge2.passed ? "\u2713" : "\u2717";
    lines.push(terminalSafe(`${marker2} ${challenge2.claim}`));
    if (!challenge2.passed) lines.push(terminalSafe(`  expected ${challenge2.expected}; observed ${challenge2.actual}: ${challenge2.evidence}`));
  }
  lines.push(
    "",
    `${report.summary.passed}/${report.summary.total} expected outcomes observed`,
    `${report.status} \xB7 ${report.receiptHash}`,
    `Reproduce: ${report.reproduction}`
  );
  return lines.join("\n");
}

// src/certification.ts
import { createHash as createHash21 } from "node:crypto";
import { existsSync as existsSync8, lstatSync as lstatSync11, readFileSync as readFileSync22 } from "node:fs";
var CERTIFICATE_SCHEMA = "agent-vigil-control-certificate/v1";
var CORPUS_ENTRY_SCHEMA = "agent-vigil-control-corpus-entry/v1";
var POLICY_SCHEMA = "agent-vigil-control-policy/v1";
var REPORT_SCHEMA = "agent-vigil-control-status/v1";
var CONTROL_POLICY_PACKS = {
  baseline: ["clean-control", "skipped-test", "disposable-cleanup"],
  authority: [
    "clean-control",
    "unapproved-mcp-server",
    "candidate-self-approval",
    "unreadable-authority-config",
    "sandbox-weakening",
    "skipped-test",
    "disposable-cleanup"
  ]
};
function digest4(value) {
  return `sha256:${createHash21("sha256").update(canonical(value)).digest("hex")}`;
}
function record6(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys5(value, keys, label) {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (canonical(actual) !== canonical(expected)) throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
}
function text5(value, label, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} must be plain text between 1 and ${maximum} characters`);
  }
  return value;
}
function identifier(value, label) {
  return text5(value, label, 160).replace(/^\s+|\s+$/g, "");
}
function repositoryName(value, label = "repository") {
  const parsed = identifier(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed)) throw new Error(`${label} must be owner/name`);
  return parsed;
}
function timestamp4(value, label) {
  const parsed = text5(value, label, 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  }
  return parsed;
}
function sha2565(value, label) {
  const parsed = text5(value, label, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label} must be sha256:<64 lowercase hex characters>`);
  return parsed;
}
function commitSha(value, label) {
  const parsed = text5(value, label, 64);
  if (!/^[a-f0-9]{40}$/.test(parsed)) throw new Error(`${label} must be a full lowercase Git commit SHA`);
  return parsed;
}
function challenge(value, index) {
  const item2 = record6(value, `proof.challenges[${index}]`);
  exactKeys5(item2, ["id", "expected", "actual", "passed"], `proof.challenges[${index}]`);
  const expected = item2.expected;
  const actual = item2.actual;
  if (!(/* @__PURE__ */ new Set(["PASS", "BLOCK", "HOLD"])).has(String(expected))) throw new Error(`proof.challenges[${index}].expected is invalid`);
  if (!(/* @__PURE__ */ new Set(["PASS", "BLOCK", "HOLD", "ERROR"])).has(String(actual))) throw new Error(`proof.challenges[${index}].actual is invalid`);
  if (typeof item2.passed !== "boolean") throw new Error(`proof.challenges[${index}].passed must be boolean`);
  if (item2.passed !== (actual === expected)) throw new Error(`proof.challenges[${index}] has inconsistent decision fields`);
  return {
    id: identifier(item2.id, `proof.challenges[${index}].id`),
    expected,
    actual,
    passed: item2.passed
  };
}
function verifyControlProof(input) {
  const proof = record6(input, "control proof");
  exactKeys5(proof, ["schemaVersion", "vigilVersion", "status", "sourceCommit", "generatedAt", "receiptHash", "challenges", "summary", "reproduction", "limits"], "control proof");
  if (proof.schemaVersion !== "agent-vigil-control-proof/v1") throw new Error("only the verified Agent Vigil control-proof/v1 adapter is currently supported");
  const receiptHash = sha2565(proof.receiptHash, "control proof receiptHash");
  const { receiptHash: _receiptHash, ...payload } = proof;
  if (digest4(payload) !== receiptHash) throw new Error("control proof receipt hash is invalid");
  const generatedAt = timestamp4(proof.generatedAt, "control proof generatedAt");
  const sourceCommit = commitSha(proof.sourceCommit, "control proof sourceCommit");
  const vigilVersion = identifier(proof.vigilVersion, "control proof vigilVersion");
  const reproduction = text5(proof.reproduction, "control proof reproduction", 1e3);
  if (!Array.isArray(proof.limits) || proof.limits.length > 100) throw new Error("control proof limits must be an array with at most 100 items");
  const limits = proof.limits.map((item2, index) => text5(item2, `control proof limits[${index}]`, 1e3));
  if (proof.status !== "PASS" && proof.status !== "HOLD") throw new Error("control proof status must be PASS or HOLD");
  if (!Array.isArray(proof.challenges) || proof.challenges.length === 0 || proof.challenges.length > 100) throw new Error("control proof challenges must contain 1 to 100 items");
  const ids = /* @__PURE__ */ new Set();
  const parsedChallenges = [];
  for (const [index, raw] of proof.challenges.entries()) {
    const full = record6(raw, `control proof challenges[${index}]`);
    exactKeys5(full, ["id", "claim", "expected", "actual", "passed", "base", "head", "evidence"], `control proof challenges[${index}]`);
    const parsed = challenge({ id: full.id, expected: full.expected, actual: full.actual, passed: full.passed }, index);
    if (ids.has(parsed.id)) throw new Error(`duplicate control proof challenge: ${parsed.id}`);
    if (parsed.passed !== (parsed.actual === parsed.expected)) throw new Error(`control proof challenge ${parsed.id} has inconsistent decision fields`);
    const enriched = {
      ...parsed,
      claim: text5(full.claim, `control proof challenges[${index}].claim`, 500),
      base: commitSha(full.base, `control proof challenges[${index}].base`),
      head: commitSha(full.head, `control proof challenges[${index}].head`),
      evidence: text5(full.evidence, `control proof challenges[${index}].evidence`, 1e3)
    };
    ids.add(parsed.id);
    parsedChallenges.push(enriched);
  }
  const summary = record6(proof.summary, "control proof summary");
  exactKeys5(summary, ["passed", "total"], "control proof summary");
  const passed = parsedChallenges.filter((item2) => item2.passed).length;
  if (summary.passed !== passed || summary.total !== parsedChallenges.length) throw new Error("control proof summary does not match its challenges");
  if (proof.status !== decideControlProof(parsedChallenges)) throw new Error("control proof status does not match its challenge decisions");
  return {
    schemaVersion: "agent-vigil-control-proof/v1",
    vigilVersion,
    status: proof.status,
    sourceCommit,
    generatedAt,
    receiptHash,
    challenges: parsedChallenges,
    summary: { passed, total: parsedChallenges.length },
    reproduction,
    limits
  };
}
function createCertificate(input) {
  const proof = verifyControlProof(input.proof);
  const payload = {
    schemaVersion: CERTIFICATE_SCHEMA,
    organization: identifier(input.organization, "organization"),
    repository: repositoryName(input.repository),
    requiredCheck: identifier(input.requiredCheck, "requiredCheck"),
    control: {
      vendor: "sulmusic2-star",
      product: "agent-vigil",
      adapter: "agent-vigil/control-proof-v1",
      version: identifier(proof.vigilVersion, "control version")
    },
    proof
  };
  return { ...payload, certificateHash: digest4(payload) };
}
function validateCertificate(input) {
  const root = record6(input, "certificate");
  exactKeys5(root, ["schemaVersion", "organization", "repository", "requiredCheck", "control", "proof", "certificateHash"], "certificate");
  if (root.schemaVersion !== CERTIFICATE_SCHEMA) throw new Error(`certificate schemaVersion must be ${CERTIFICATE_SCHEMA}`);
  const control = record6(root.control, "certificate.control");
  exactKeys5(control, ["vendor", "product", "adapter", "version"], "certificate.control");
  const proof = verifyControlProof(root.proof);
  if (control.adapter !== "agent-vigil/control-proof-v1") throw new Error("certificate adapter and proof schema are not supported");
  if (control.vendor !== "sulmusic2-star" || control.product !== "agent-vigil") throw new Error("certificate control identity does not match its verified adapter");
  const parsed = {
    schemaVersion: CERTIFICATE_SCHEMA,
    organization: identifier(root.organization, "certificate.organization"),
    repository: repositoryName(root.repository, "certificate.repository"),
    requiredCheck: identifier(root.requiredCheck, "certificate.requiredCheck"),
    control: {
      vendor: identifier(control.vendor, "certificate.control.vendor"),
      product: identifier(control.product, "certificate.control.product"),
      adapter: identifier(control.adapter, "certificate.control.adapter"),
      version: identifier(control.version, "certificate.control.version")
    },
    proof
  };
  if (parsed.control.version !== proof.vigilVersion) throw new Error("certificate control version does not match its proof");
  const certificateHash = sha2565(root.certificateHash, "certificate.certificateHash");
  if (digest4(parsed) !== certificateHash) throw new Error("certificate hash is invalid");
  return { ...parsed, certificateHash };
}
function parseCorpus(content) {
  if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("certification corpus exceeds 64 MiB");
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const entries = [];
  let previous = null;
  const certificates = /* @__PURE__ */ new Set();
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error(`corpus line ${index + 1} exceeds 2 MiB`);
    const root = record6(JSON.parse(line), `corpus line ${index + 1}`);
    exactKeys5(root, ["schemaVersion", "sequence", "previousEntryHash", "certificate", "entryHash"], `corpus line ${index + 1}`);
    if (root.schemaVersion !== CORPUS_ENTRY_SCHEMA || root.sequence !== index + 1 || root.previousEntryHash !== previous) throw new Error(`corpus chain is invalid at line ${index + 1}`);
    const certificate = validateCertificate(root.certificate);
    if (certificates.has(certificate.certificateHash)) throw new Error(`duplicate certificate at corpus line ${index + 1}`);
    const payload = { schemaVersion: CORPUS_ENTRY_SCHEMA, sequence: index + 1, previousEntryHash: previous, certificate };
    const entryHash = sha2565(root.entryHash, `corpus line ${index + 1} entryHash`);
    if (digest4(payload) !== entryHash) throw new Error(`corpus entry hash is invalid at line ${index + 1}`);
    entries.push({ ...payload, entryHash });
    certificates.add(certificate.certificateHash);
    previous = entryHash;
  }
  return entries;
}
function appendCorpusEntry(content, certificateInput) {
  const entries = parseCorpus(content);
  const certificate = validateCertificate(certificateInput);
  if (entries.some((item2) => item2.certificate.certificateHash === certificate.certificateHash)) throw new Error("certificate already exists in corpus");
  const payload = {
    schemaVersion: CORPUS_ENTRY_SCHEMA,
    sequence: entries.length + 1,
    previousEntryHash: entries.at(-1)?.entryHash ?? null,
    certificate
  };
  const entry = { ...payload, entryHash: digest4(payload) };
  return { entry, line: `${JSON.stringify(entry)}
` };
}
function loadCorpus(path) {
  if (!existsSync8(path)) return [];
  const status = lstatSync11(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("certification corpus must be a regular non-symbolic-link file");
  if (status.size > 64 * 1024 * 1024) throw new Error("certification corpus exceeds 64 MiB");
  return parseCorpus(readFileSync22(path, "utf8"));
}
function validatePolicy3(input) {
  const root = record6(input, "certification policy");
  exactKeys5(root, ["schemaVersion", "policyId", "organization", "maxAgeHours", "repositories"], "certification policy");
  if (root.schemaVersion !== POLICY_SCHEMA) throw new Error(`certification policy schemaVersion must be ${POLICY_SCHEMA}`);
  if (!Number.isInteger(root.maxAgeHours) || Number(root.maxAgeHours) < 1 || Number(root.maxAgeHours) > 8760) throw new Error("maxAgeHours must be an integer from 1 to 8760");
  if (!Array.isArray(root.repositories) || root.repositories.length === 0 || root.repositories.length > 1e4) throw new Error("repositories must contain 1 to 10000 entries");
  const seen = /* @__PURE__ */ new Set();
  const repositories = root.repositories.map((value, index) => {
    const item2 = record6(value, `repositories[${index}]`);
    exactKeys5(item2, ["repository", "requiredCheck", "allowedControls", "requiredChallenges"], `repositories[${index}]`);
    const repository2 = repositoryName(item2.repository, `repositories[${index}].repository`);
    const requiredCheck = identifier(item2.requiredCheck, `repositories[${index}].requiredCheck`);
    if (seen.has(repository2)) throw new Error(`duplicate policy repository: ${repository2}`);
    seen.add(repository2);
    if (!Array.isArray(item2.allowedControls) || item2.allowedControls.length === 0) throw new Error(`repositories[${index}].allowedControls must not be empty`);
    if (!Array.isArray(item2.requiredChallenges) || item2.requiredChallenges.length === 0) throw new Error(`repositories[${index}].requiredChallenges must not be empty`);
    return {
      repository: repository2,
      requiredCheck,
      allowedControls: [...new Set(item2.allowedControls.map((value2) => identifier(value2, `repositories[${index}].allowedControls`)))],
      requiredChallenges: [...new Set(item2.requiredChallenges.map((value2) => identifier(value2, `repositories[${index}].requiredChallenges`)))]
    };
  });
  return {
    schemaVersion: POLICY_SCHEMA,
    policyId: identifier(root.policyId, "policyId"),
    organization: identifier(root.organization, "organization"),
    maxAgeHours: Number(root.maxAgeHours),
    repositories
  };
}
function loadPolicy2(path) {
  return validatePolicy3(readBoundedJson(path, 2 * 1024 * 1024, "certification policy"));
}
function createSingleRepositoryPolicy(input) {
  return validatePolicy3({
    schemaVersion: POLICY_SCHEMA,
    policyId: `${input.pack}-weekly-v1`,
    organization: input.organization,
    maxAgeHours: input.maxAgeHours ?? 168,
    repositories: [{
      repository: input.repository,
      requiredCheck: input.requiredCheck,
      allowedControls: ["sulmusic2-star/agent-vigil"],
      requiredChallenges: [...CONTROL_POLICY_PACKS[input.pack]]
    }]
  });
}
function buildStatusReport(policyInput, entries, asOfInput) {
  const policy = validatePolicy3(policyInput);
  const asOf = timestamp4(asOfInput, "asOf");
  const asOfMs = Date.parse(asOf);
  const repositories = policy.repositories.map((requirement) => {
    const matches = entries.map((entry) => entry.certificate).filter((certificate) => certificate.organization === policy.organization && certificate.repository === requirement.repository && certificate.requiredCheck === requirement.requiredCheck).sort((left, right) => Date.parse(right.proof.generatedAt) - Date.parse(left.proof.generatedAt));
    const latest = matches[0];
    if (!latest) return { repository: requirement.repository, requiredCheck: requirement.requiredCheck, state: "MISSING", reason: "no matching control certificate is present" };
    const control = `${latest.control.vendor}/${latest.control.product}`;
    const common = { repository: requirement.repository, requiredCheck: requirement.requiredCheck, proofGeneratedAt: latest.proof.generatedAt, certificateHash: latest.certificateHash, control };
    if (!requirement.allowedControls.includes(control)) return { ...common, state: "HOLD", reason: `control ${control} is not allowed by policy` };
    const ageHours = (asOfMs - Date.parse(latest.proof.generatedAt)) / 36e5;
    if (ageHours < 0) return { ...common, ageHours, state: "HOLD", reason: "latest proof is dated after the report time" };
    if (latest.proof.status !== "PASS") return { ...common, ageHours, state: "HOLD", reason: "latest control proof did not pass" };
    const challengeMap = new Map(latest.proof.challenges.map((item2) => [item2.id, item2]));
    const missing = requirement.requiredChallenges.filter((id) => !challengeMap.get(id)?.passed);
    if (missing.length) return { ...common, ageHours, state: "HOLD", reason: `required challenge evidence is absent or unexpected: ${missing.join(", ")}` };
    if (ageHours > policy.maxAgeHours) return { ...common, ageHours, state: "STALE", reason: `latest passing proof is ${ageHours.toFixed(1)} hours old; policy allows ${policy.maxAgeHours}` };
    return { ...common, ageHours, state: "FRESH", reason: `required control passed ${requirement.requiredChallenges.length} challenge(s) within ${policy.maxAgeHours} hours` };
  });
  const summary = {
    fresh: repositories.filter((item2) => item2.state === "FRESH").length,
    stale: repositories.filter((item2) => item2.state === "STALE").length,
    missing: repositories.filter((item2) => item2.state === "MISSING").length,
    held: repositories.filter((item2) => item2.state === "HOLD").length,
    total: repositories.length
  };
  const payload = { schemaVersion: REPORT_SCHEMA, policyId: policy.policyId, organization: policy.organization, asOf, maxAgeHours: policy.maxAgeHours, status: summary.fresh === summary.total ? "PASS" : "HOLD", summary, repositories };
  return { ...payload, reportHash: digest4(payload) };
}
function renderStatusReport(report) {
  const lines = [
    `Agent Vigil control status: ${report.status}`,
    `${report.summary.fresh}/${report.summary.total} required repositories have fresh proof as of ${report.asOf}`,
    ""
  ];
  for (const repository2 of report.repositories) lines.push(terminalSafe(`${repository2.state.padEnd(7)} ${repository2.repository} \u2014 ${repository2.reason}`));
  lines.push("", `${report.status} \xB7 ${report.reportHash}`);
  return lines.join("\n");
}

// src/cli.ts
function usage2() {
  return `agent-vigil ${VERSION}

Usage:
  vigil <transcript.jsonl|summary.md> [options]
  vigil demo
  vigil init [--repo <path>] [--force] [--attest] [--portable --public-key <path>]
  vigil init --profile maintainer [--repo <path>] [--force] [--attest]
  vigil init --profile authority [--repo <path>] [--force] [--attest]
  vigil protect [--repo <path>] [--force] [--attest]
  vigil prove [--repo <path>] [--base <sha>] [--format text|json] [--output <path>]
  vigil certify record <control-proof.json> --organization <name> --repository <owner/name> --required-check <name> --output <path>
  vigil certify add <certificate.json> --corpus <corpus.jsonl>
  vigil certify status --corpus <corpus.jsonl> --policy <policy.json> [--as-of <time>] [--format text|json] [--output <path>]
  vigil certify policy --organization <name> --repository <owner/name> --required-check <name> --pack baseline|authority --output <path>
  vigil plan [--repo <path>] [--base <sha>] [--head <sha>] [--policy <path>] [--format text|json] [--output <path>]
  vigil proof-comment <receipt.json> [--verify-url <https-url>] [--output <path>]
  vigil test-integrity [--repo <path>] [--base <sha>] [--head <sha>] [--strict] [--format <kind>] [--output <path>]
  vigil doctor [--repo <path>] [--policy <path>] [--transcript <path>]
  vigil keygen --private <path> --public <path>
  vigil verify <receipt.json> [--public-key <path>]
  vigil attest <receipt.json> --predicate-output <path>
  vigil verify-attestation <receipt.json> --repository <owner/name> [--signer-workflow <path>] [--allow-self-hosted]
  vigil notary <receipt.json> --repository <owner/name> --head <sha> --policy-sha256 <digest> [--signer-workflow <path>] [--allow-self-hosted] [--output <path>]
  vigil compare <before-receipt.json> <after-receipt.json> [--format text|json] [--output <path>]
  vigil github-evidence --event <event.json> [GitHub API exports] [--output <path>]
  vigil value <receipt.json> [--transcript <session.jsonl>] [--cost-usd <amount>] [options]
  vigil compare-value <card.json>... [--format text|json|html] [--output <path>]
  vigil audit <change.diff> [--strict] [--format <kind>] [--output <path>] [--sarif <path>]
  vigil authority init [--output <path>]
  vigil authority <transcript.jsonl> --contract <authority.json> [--contract-ref <sha>] [options]
  vigil gate <portable-receipt.json> [options]
  vigil maintainer --event <event.json> [options]
  vigil merge-group --event <event.json> [options]
  vigil upgrade <init|doctor|plan|preflight|check|verify|evidence|resolve|enforce|index> [options]

Options:
  --repo <path>          Repository to verify (default: .)
  --base <sha>           Baseline commit (default: GITHUB_BASE_SHA or HEAD~1)
  --head <sha>           Head commit (default: GITHUB_HEAD_SHA or HEAD)
  --test-cmd <command>   Explicit verification command
  --format <kind>        text, json, markdown, or sarif
  --json                 Alias for --format json
  --output <path>        Write the full JSON receipt
  --sarif <path>         Also write SARIF 2.1.0
  --policy <path>        Policy JSON (default: .agent-vigil.json when present)
  --policy-ref <sha>     Load policy from a trusted Git commit instead of the worktree
  --signing-key <path>   Sign the receipt with an Ed25519 private key
  --portable-output <p>  Write a compact signed receipt; requires --signing-key
  --github-summary       Append Markdown to GITHUB_STEP_SUMMARY
  --strict               Block on unresolved claims; for audit, block on static findings
  --min-verified <n>     Minimum objective verified claims (default: 1)
  --version              Print the version
  --help                 Show this help

Value options:
  --transcript <path>    Bind supported token usage to the receipt digest
  --github-evidence <p>  Import a hash-verified normalized GitHub evidence bundle
  --cost-usd <amount>    Attributed task cost; requires --cost-source
  --cost-source <kind>   provider-billed, subscription-allocated, or user-estimated
  --cost-evidence <path> Hash a local billing artifact without copying its contents
  --budget-usd <amount>  Predeclared task budget for WITHIN / EXCEEDED status
  --review-minutes <n>   Explicit human review duration
  --disposition <kind>   accepted, dismissed, changes-requested, or unreviewed
  --review-evidence <p>  Hash review or disposition evidence without copying it
  --outcome <kind>       merged, closed, reverted, hotfixed, incident-linked, or unknown
  --outcome-as-of <time> RFC3339-compatible downstream observation time
  --outcome-evidence <p> Hash merge or downstream evidence without copying it
  --task-class <name>    Local comparison category, such as bugfix or refactor
  --format <kind>        text, json, markdown, or html

Exit codes: 0 PASS \xB7 1 FAIL \xB7 2 INCONCLUSIVE or usage error`;
}
function runProve(args) {
  try {
    const allowed = /* @__PURE__ */ new Set(["prove", "--repo", "--base", "--format", "--output", "--json"]);
    const takesValue = /* @__PURE__ */ new Set(["--repo", "--base", "--format", "--output"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed.has(arg)) {
        throw arg.startsWith("--") ? unknownOptionError(arg) : unexpectedPositionalError();
      }
      if (takesValue.has(arg)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw optionRequiresValueError(arg);
        index += 1;
      }
    }
    const repo = resolve20(optionValue(args, "--repo") ?? ".");
    const baseRef = optionValue(args, "--base") ?? process.env.GITHUB_SHA ?? "HEAD";
    if (!existsSync9(repo)) throw new Error(`repository not found: ${repo}`);
    if (!gitRefExists(repo, baseRef)) throw new Error(`invalid Git commit ${baseRef}`);
    const format = args.includes("--json") ? "json" : optionValue(args, "--format") ?? "text";
    if (!(/* @__PURE__ */ new Set(["text", "json"])).has(format)) throw new Error("prove --format must be text or json");
    const report = buildControlProof(repo, baseRef, VERSION);
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve20(output), `${JSON.stringify(report, null, 2)}
`);
    console.log(format === "json" ? JSON.stringify(report, null, 2) : renderControlProof(report));
    return report.status === "PASS" ? 0 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runCertify(args) {
  try {
    const command = args[1];
    if (command === "record") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--organization", "--repository", "--required-check", "--output"]));
      if (parsed.positional.length !== 1) throw new Error("certify record requires exactly one control-proof JSON path");
      const organization = parsed.values.get("--organization");
      const repository2 = parsed.values.get("--repository");
      const requiredCheck = parsed.values.get("--required-check");
      const output = parsed.values.get("--output");
      if (!organization || !repository2 || !requiredCheck || !output) throw new Error("certify record requires --organization, --repository, --required-check, and --output");
      const proof = readBoundedJson(resolve20(parsed.positional[0]), 2 * 1024 * 1024, "control proof");
      const certificate = createCertificate({ proof, organization, repository: repository2, requiredCheck });
      writePrivateFileAtomic(resolve20(output), `${JSON.stringify(certificate, null, 2)}
`);
      console.log(`Control certificate: ${certificate.proof.status} \xB7 ${certificate.certificateHash}`);
      return certificate.proof.status === "PASS" ? 0 : 2;
    }
    if (command === "add") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--corpus"]));
      const corpus = parsed.values.get("--corpus");
      if (parsed.positional.length !== 1 || !corpus) throw new Error("certify add requires <certificate.json> --corpus <corpus.jsonl>");
      const certificate = validateCertificate(readBoundedJson(resolve20(parsed.positional[0]), 2 * 1024 * 1024, "control certificate"));
      const corpusPath = resolve20(corpus);
      const current = loadCorpus(corpusPath).map((entry2) => JSON.stringify(entry2)).join("\n");
      const { entry, line } = appendCorpusEntry(current, certificate);
      appendPrivateFileAtomic(corpusPath, line);
      console.log(`Added certificate ${entry.sequence} \xB7 ${entry.entryHash}`);
      return 0;
    }
    if (command === "status") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--corpus", "--policy", "--as-of", "--format", "--output"]));
      const corpus = parsed.values.get("--corpus");
      const policy = parsed.values.get("--policy");
      if (!corpus || !policy || parsed.positional.length) throw new Error("certify status requires --corpus <corpus.jsonl> --policy <policy.json>");
      const format = parsed.values.get("--format") ?? "text";
      if (format !== "text" && format !== "json") throw new Error("certify status --format must be text or json");
      const report = buildStatusReport(loadPolicy2(resolve20(policy)), loadCorpus(resolve20(corpus)), parsed.values.get("--as-of") ?? (/* @__PURE__ */ new Date()).toISOString());
      const rendered = format === "json" ? `${JSON.stringify(report, null, 2)}
` : `${renderStatusReport(report)}
`;
      const output = parsed.values.get("--output");
      if (output) writePrivateFileAtomic(resolve20(output), `${JSON.stringify(report, null, 2)}
`);
      process.stdout.write(rendered);
      return report.status === "PASS" ? 0 : 2;
    }
    if (command === "policy") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--organization", "--repository", "--required-check", "--pack", "--max-age-hours", "--output"]));
      const organization = parsed.values.get("--organization");
      const repository2 = parsed.values.get("--repository");
      const requiredCheck = parsed.values.get("--required-check");
      const output = parsed.values.get("--output");
      const pack = parsed.values.get("--pack") ?? "authority";
      if (!organization || !repository2 || !requiredCheck || !output || parsed.positional.length) throw new Error("certify policy requires --organization, --repository, --required-check, and --output");
      if (!(pack in CONTROL_POLICY_PACKS)) throw new Error("certify policy --pack must be baseline or authority");
      const maxAgeRaw = parsed.values.get("--max-age-hours");
      const maxAgeHours = maxAgeRaw === void 0 ? void 0 : Number(maxAgeRaw);
      const generated = createSingleRepositoryPolicy({ organization, repository: repository2, requiredCheck, pack, ...maxAgeHours === void 0 ? {} : { maxAgeHours } });
      writePrivateFileAtomic(resolve20(output), `${JSON.stringify(generated, null, 2)}
`);
      console.log(`Created ${pack} control policy with a ${generated.maxAgeHours}-hour proof window.`);
      return 0;
    }
    throw new Error("certify requires record, add, status, or policy");
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runPlan2(args) {
  try {
    const allowed = /* @__PURE__ */ new Set(["plan", "--repo", "--base", "--head", "--policy", "--format", "--output", "--json", "--github-summary"]);
    const takesValue = /* @__PURE__ */ new Set(["--repo", "--base", "--head", "--policy", "--format", "--output"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed.has(arg)) {
        throw arg.startsWith("--") ? unknownOptionError(arg) : unexpectedPositionalError();
      }
      if (takesValue.has(arg)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw optionRequiresValueError(arg);
        index += 1;
      }
    }
    const repo = resolve20(optionValue(args, "--repo") ?? ".");
    const baseRef = optionValue(args, "--base") ?? process.env.GITHUB_BASE_SHA ?? "HEAD~1";
    const headRef = optionValue(args, "--head") ?? process.env.GITHUB_HEAD_SHA ?? "HEAD";
    if (!existsSync9(repo)) throw new Error(`repository not found: ${repo}`);
    if (!gitRefExists(repo, baseRef) || !gitRefExists(repo, headRef)) throw new Error(`invalid git range ${baseRef}..${headRef}`);
    const format = args.includes("--json") ? "json" : optionValue(args, "--format") ?? "text";
    if (!(/* @__PURE__ */ new Set(["text", "json", "markdown"])).has(format)) throw new Error("plan --format must be text, json, or markdown");
    const policyPath = optionValue(args, "--policy");
    if (policyPath && (isAbsolute10(policyPath) || policyPath === ".." || policyPath.startsWith("../") || policyPath.includes("\\"))) {
      throw new Error("plan --policy must be a repository-relative POSIX path");
    }
    const report = buildAuthorityPlan(repo, baseRef, headRef, VERSION, policyPath);
    const rendered = format === "json" ? `${JSON.stringify(report, null, 2)}
` : format === "markdown" ? renderAuthorityPlanMarkdown(report) : `${renderAuthorityPlan(report)}
`;
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve20(output), `${JSON.stringify(report, null, 2)}
`);
    else process.stdout.write(rendered);
    if (args.includes("--github-summary")) {
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (!summaryPath) throw new Error("--github-summary requires GITHUB_STEP_SUMMARY");
      appendPrivateFileAtomic(resolve20(summaryPath), renderAuthorityPlanMarkdown(report));
    }
    return report.status === "PASS" ? 0 : report.status === "BLOCK" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runProofComment(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--verify-url", "--output"]));
    if (parsed.positional.length !== 1) throw new Error("proof-comment requires exactly one full receipt JSON path");
    let report;
    try {
      ({ report } = loadReceipt(resolve20(parsed.positional[0])));
    } catch {
      throw receiptIntegrityError();
    }
    const rendered = renderProofComment(report, { verifyUrl: parsed.values.get("--verify-url") });
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve20(output), rendered);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function parseArgs(args) {
  const options = {
    repo: ".",
    base: process.env.GITHUB_BASE_SHA || "HEAD~1",
    head: process.env.GITHUB_HEAD_SHA || "HEAD",
    format: "text",
    githubSummary: false
  };
  const takesValue = /* @__PURE__ */ new Set(["--repo", "--base", "--head", "--test-cmd", "--format", "--output", "--sarif", "--min-verified", "--policy", "--policy-ref", "--signing-key", "--portable-output"]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--") && !options.transcript) {
      options.transcript = arg;
      continue;
    }
    if (arg === "--json") {
      options.format = "json";
      continue;
    }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--github-summary") {
      options.githubSummary = true;
      continue;
    }
    if (arg === "--help" || arg === "--version") continue;
    if (!takesValue.has(arg)) {
      throw arg.startsWith("--") ? unknownOptionError(arg) : unexpectedPositionalError();
    }
    const value = args[++index];
    if (value === void 0 || value.startsWith("--")) throw optionRequiresValueError(arg);
    if (arg === "--repo") options.repo = value;
    if (arg === "--base") options.base = value;
    if (arg === "--head") options.head = value;
    if (arg === "--test-cmd") options.testCmd = value;
    if (arg === "--format") {
      if (!(/* @__PURE__ */ new Set(["text", "json", "markdown", "sarif"])).has(value)) throw new Error("--format must be text, json, markdown, or sarif");
      options.format = value;
    }
    if (arg === "--output") options.output = value;
    if (arg === "--sarif") options.sarif = value;
    if (arg === "--policy") options.policy = value;
    if (arg === "--policy-ref") options.policyRef = value;
    if (arg === "--signing-key") options.signingKey = value;
    if (arg === "--portable-output") options.portableOutput = value;
    if (arg === "--min-verified") options.minVerified = Number(value);
  }
  if (options.minVerified !== void 0 && (!Number.isInteger(options.minVerified) || options.minVerified < 1)) {
    throw new Error("--min-verified must be a positive integer");
  }
  return options;
}
function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return void 0;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw optionRequiresValueError(name);
  return args[index + 1];
}
function runInit2(args) {
  try {
    const repo = resolve20(optionValue(args, "--repo") ?? ".");
    const portable = args.includes("--portable");
    const attest = args.includes("--attest");
    const profile = optionValue(args, "--profile") ?? "default";
    if (!(/* @__PURE__ */ new Set(["default", "maintainer", "authority", "protect"])).has(profile)) throw new Error("init --profile must be default, maintainer, authority, or protect");
    const publicKey = optionValue(args, "--public-key");
    if (portable && profile !== "default") throw new Error("init --portable cannot be combined with a named profile");
    if (portable && !publicKey) throw new Error("init --portable requires --public-key <Ed25519 public key>");
    if (!portable && publicKey) throw new Error("init --public-key is only valid with --portable");
    const result5 = initRepository(repo, args.includes("--force"), publicKey ? publicKeyId(resolve20(publicKey)) : void 0, profile, attest);
    console.log("Agent Vigil initialized.\n");
    for (const path of result5.created) console.log(`  created ${path}`);
    for (const path of result5.kept) console.log(`  kept    ${path} (use --force to replace)`);
    console.log(profile === "maintainer" ? "\nNext: replace the PR-template login, review the base-anchored limits, merge this setup first, then open a code PR with a regression test that fails on base and passes on head." : profile === "authority" ? "\nNext: replace the task ID, paths, action classes, and expiry; point the workflow at a structured agent transcript; merge the contract before the code change." : portable ? "\nNext: merge this base policy first, then generate a portable receipt after each code commit with --portable-output." : attest ? "\nNext: replace .agent-vigil/session.md with real evidence, push one PR, verify its GitHub attestation, then require the Agent Vigil evidence status check." : "\nNext: replace .agent-vigil/session.md with a real agent transcript or summary, push one PR, then require the Agent Vigil evidence status check.");
    if (attest && profile !== "default") {
      console.log("Next for signing: push one pull request, download agent-vigil-report.json, and run vigil verify-attestation before making the check required.");
    }
    return 0;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runProtect(args) {
  try {
    const allowed = /* @__PURE__ */ new Set(["protect", "--repo", "--force", "--attest"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed.has(arg)) {
        throw arg.startsWith("--") ? unknownOptionError(arg) : unexpectedPositionalError();
      }
      if (arg === "--repo") index += 1;
    }
    const repo = resolve20(optionValue(args, "--repo") ?? ".");
    const result5 = initRepository(repo, args.includes("--force"), void 0, "protect", args.includes("--attest"));
    console.log("Agent Vigil protection installed.\n");
    for (const path of result5.created) console.log(`  created ${path}`);
    for (const path of result5.kept) console.log(`  kept    ${path} (use --force to replace)`);
    const checks = doctorRepository(repo);
    console.log(`
${renderDoctor(checks)}
`);
    console.log("Next: review the discovered commands and limits in .agent-vigil.json, commit the setup, push one pull request, then require the Agent Vigil evidence check.");
    return checks.some((check) => check.status === "FAIL") ? 2 : 0;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function withoutOption(args, name) {
  const output = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name) {
      index += 1;
      continue;
    }
    output.push(args[index]);
  }
  return output;
}
function runMaintainer(args) {
  try {
    const eventOption = optionValue(args, "--event");
    if (!eventOption) throw new Error("maintainer requires --event <pull_request event JSON>");
    const options = parseArgs(withoutOption(args.slice(1), "--event"));
    const repo = resolve20(options.repo);
    const eventPath = resolve20(eventOption);
    const policy = loadPolicy(repo, options.policy, options.policyRef);
    if (!policy.value.maintainer) throw new Error("base policy does not contain a maintainer profile");
    if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) throw new Error(`invalid git range ${options.base}..${options.head}`);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const evidence = loadPullRequestEvidence(eventPath);
    if (evidence.baseSha && resolveGitRef(repo, evidence.baseSha) !== base) throw new Error(`event base ${evidence.baseSha} does not match selected base ${base}`);
    if (evidence.headSha && resolveGitRef(repo, evidence.headSha) !== head) throw new Error(`event head ${evidence.headSha} does not match selected head ${head}`);
    const inputs = [eventPath, ...policy.path ? [policy.path] : []];
    const results = [...checkWorkspaceBinding(repo, head, inputs)];
    const advisories = [];
    results.push(...buildMaintainerChecks(repo, base, head, evidence, policy.value.maintainer));
    const authorityPlan = authorityPlanChecks(buildAuthorityPlan(repo, base, head, VERSION));
    results.push(...authorityPlan.results);
    advisories.push(...authorityPlan.advisories);
    if (policy.value.testCommand) {
      results.push(...checkTestsPass([{ kind: "tests_pass", quote: "base policy requires the candidate test suite to pass", subject: "fresh candidate test suite" }], repo, policy.value.testCommand));
      results.push(...checkWorkspaceMutation(repo, inputs, head));
    }
    const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
    results.push(...integrity.results);
    advisories.push(...integrity.advisories);
    const rawEvent = readFileSync23(eventPath);
    const eventHash = `sha256:${createHash22("sha256").update(rawEvent).digest("hex")}`;
    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative14(repo, policy.path) : void 0;
    const remote = git9(repo, ["config", "--get", "remote.origin.url"]);
    const tree = git9(repo, ["rev-parse", `${head}^{tree}`]);
    const reproduction = [
      "vigil maintainer",
      "--event",
      shellQuote(eventOption),
      "--repo",
      ".",
      "--base",
      base,
      "--head",
      head,
      ...policy.gitPath ? ["--policy", shellQuote(policy.gitPath)] : policySource ? ["--policy", shellQuote(policySource)] : [],
      ...policy.ref ? ["--policy-ref", policy.ref] : []
    ].join(" ");
    const report = buildReport({
      transcript: eventOption,
      transcriptSha256: eventHash,
      transcriptFormat: "pull-request-evidence",
      repo,
      base,
      head,
      results,
      advisories,
      policy: { minVerified: policy.value.minVerified ?? 1, strict: policy.value.strict ?? true, source: policySource, sha256: policy.sha256 },
      repository: { ...remote ? { remote } : {}, ...tree ? { tree } : {} },
      reproduction
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runMergeGroup(args) {
  try {
    const eventOption = optionValue(args, "--event");
    if (!eventOption) throw new Error("merge-group requires --event <merge_group event JSON>");
    const options = parseArgs(withoutOption(args.slice(1), "--event"));
    if (!options.policy || !options.policyRef) throw new Error("merge-group requires --policy and a base-anchored --policy-ref");
    const report = buildMergeGroupReport({
      repo: options.repo,
      eventPath: eventOption,
      base: options.base,
      head: options.head,
      policy: options.policy,
      policyRef: options.policyRef
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runDoctor2(args) {
  try {
    const repo = resolve20(optionValue(args, "--repo") ?? ".");
    const checks = doctorRepository(repo, optionValue(args, "--policy"), optionValue(args, "--transcript"));
    console.log(renderDoctor(checks));
    return checks.some((check) => check.status === "FAIL") ? 2 : 0;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runKeygen(args) {
  try {
    const privatePath = optionValue(args, "--private");
    const publicPath = optionValue(args, "--public");
    if (!privatePath || !publicPath) throw new Error("keygen requires --private and --public paths");
    generateSigningKey(resolve20(privatePath), resolve20(publicPath));
    console.log(`Created Ed25519 private key ${privatePath} and public key ${publicPath}. Keep the private key out of Git.`);
    console.log(`Signer key ID: ${publicKeyId(resolve20(publicPath))}`);
    return 0;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function printReport(report, options) {
  if (options.format === "json") console.log(JSON.stringify(report, null, 2));
  else if (options.format === "markdown") console.log(renderMarkdown(report));
  else if (options.format === "sarif") console.log(JSON.stringify(toSarif(report), null, 2));
  else console.log(renderText(report));
}
function runGate(args) {
  try {
    const options = parseArgs(args.slice(1));
    const receiptPath = options.transcript;
    if (!receiptPath) throw new Error("gate requires a portable receipt JSON path");
    const absoluteReceipt = resolve20(options.repo, receiptPath);
    const receipt = JSON.parse(readFileSync23(absoluteReceipt, "utf8"));
    const report = buildPortableGateReport(receipt, {
      repo: resolve20(options.repo),
      receiptPath: absoluteReceipt,
      base: options.base,
      head: options.head,
      ...options.policy ? { policy: options.policy } : {},
      ...options.policyRef ? { policyRef: options.policyRef } : {}
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runVerify2(args) {
  try {
    const receiptPath = args.find((arg, index) => index > 0 && !arg.startsWith("--") && args[index - 1] !== "--public-key");
    if (!receiptPath) throw new Error("verify requires a receipt JSON path");
    const report = JSON.parse(readFileSync23(resolve20(receiptPath), "utf8"));
    if (report.schemaVersion !== "2") throw new Error(`unsupported receipt schema: ${String(report.schemaVersion)}`);
    const publicKey = optionValue(args, "--public-key");
    const result5 = verifyReport(report, publicKey ? resolve20(publicKey) : void 0);
    console.log(`Receipt hash: ${result5.hashValid ? "VALID" : "INVALID"}`);
    if (result5.signatureValid !== void 0) {
      console.log(`Ed25519 signature: ${result5.signatureValid ? "VALID" : "INVALID"} \xB7 ${result5.keyPinned ? "pinned public key" : "embedded self-asserted key"}`);
      if (!result5.keyPinned) console.log("Identity is not established until the public key is pinned through a trusted channel.");
    } else console.log("Signature: absent (content hash only)");
    return result5.hashValid && result5.signatureValid !== false ? 0 : 1;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function parseCommandArgs(args, valueOptions, booleanOptions = /* @__PURE__ */ new Set()) {
  const positional2 = [];
  const values = /* @__PURE__ */ new Map();
  const flags = /* @__PURE__ */ new Set();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional2.push(arg);
      continue;
    }
    if (valueOptions.has(arg)) {
      if (values.has(arg)) throw duplicateOptionError(arg);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw optionRequiresValueError(arg);
      values.set(arg, value);
      continue;
    }
    if (booleanOptions.has(arg)) {
      if (flags.has(arg)) throw duplicateOptionError(arg);
      flags.add(arg);
      continue;
    }
    throw unknownOptionError(arg);
  }
  return { positional: positional2, values, flags };
}
function runAttest(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--predicate-output"]));
    const predicateOutput = parsed.values.get("--predicate-output");
    if (parsed.positional.length !== 1 || !predicateOutput) throw new Error("attest requires <receipt.json> and --predicate-output <path>");
    const receiptPath = parsed.positional[0];
    const predicate = writeAttestationPredicate(resolve20(receiptPath), resolve20(predicateOutput));
    console.log("Agent Vigil attestation predicate prepared.");
    console.log(`  receipt:  ${predicate.receipt.receiptHash}`);
    console.log(`  decision: ${predicate.receipt.status}`);
    console.log(`  change:   ${predicate.receipt.base}..${predicate.receipt.head}`);
    console.log(`  output:   ${predicateOutput}`);
    console.log(`  type:     ${ATTESTATION_PREDICATE_TYPE}`);
    console.log("The predicate contains hashes, SHAs, counts, and the decision. It does not contain source code, prompts, or transcript text.");
    return 0;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runVerifyAttestation(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--repository", "--signer-workflow"]), /* @__PURE__ */ new Set(["--allow-self-hosted"]));
    const repository2 = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    if (parsed.positional.length !== 1 || !repository2) throw new Error("verify-attestation requires <receipt.json> and --repository <owner/name>");
    const receiptPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository2}/.github/workflows/agent-vigil.yml`;
    const verification2 = verifyGitHubAttestation(resolve20(receiptPath), repository2, { signerWorkflow, allowSelfHosted: parsed.flags.has("--allow-self-hosted") });
    const { report } = loadReceipt(resolve20(receiptPath));
    console.log(`GitHub attestation: ${verification2.valid ? "VALID" : "INVALID"}`);
    console.log(`Receipt file: ${verification2.subjectDigestValid ? "VALID" : "INVALID"}`);
    console.log(`Receipt contents: ${verification2.receiptHashValid && verification2.predicateValid ? "VALID" : "INVALID"}`);
    console.log(`Decision: ${report.summary.status}`);
    console.log(`Change: ${report.base}..${report.head}`);
    console.log(`Receipt: ${report.receiptHash}`);
    console.log(`Signer workflow: ${signerWorkflow}`);
    return verification2.valid ? 0 : 1;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runNotary(args) {
  try {
    const values = /* @__PURE__ */ new Set(["--repository", "--head", "--policy-sha256", "--signer-workflow", "--output"]);
    const parsed = parseCommandArgs(args, values, /* @__PURE__ */ new Set(["--allow-self-hosted"]));
    const repository2 = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    const head = parsed.values.get("--head");
    const policySha256 = parsed.values.get("--policy-sha256");
    if (parsed.positional.length !== 1 || !repository2 || !head || !policySha256) {
      throw new Error("notary requires <receipt.json>, --repository <owner/name>, --head <sha>, and --policy-sha256 <digest>");
    }
    const receiptPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository2}/.github/workflows/agent-vigil.yml`;
    const verification2 = verifyGitHubAttestation(resolve20(receiptPath), repository2, { signerWorkflow, allowSelfHosted: parsed.flags.has("--allow-self-hosted") });
    const payload = buildNotaryCheck(resolve20(receiptPath), verification2, head, policySha256);
    const rendered = `${JSON.stringify(payload, null, 2)}
`;
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve20(output), rendered);
    else process.stdout.write(rendered);
    return payload.conclusion === "success" ? 0 : payload.conclusion === "failure" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runCompare(args) {
  try {
    const values = args.slice(1).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--format" && all[index - 1] !== "--output");
    if (values.length !== 2) throw new Error("compare requires before and after full receipt JSON paths");
    const format = optionValue(args, "--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("compare --format must be text or json");
    const before = JSON.parse(readFileSync23(resolve20(values[0]), "utf8"));
    const after = JSON.parse(readFileSync23(resolve20(values[1]), "utf8"));
    if (before.schemaVersion !== "2" || after.schemaVersion !== "2") throw new Error("compare supports full receipt schema 2 only");
    const delta = compareReceipts(before, after);
    const rendered = format === "json" ? `${JSON.stringify(delta, null, 2)}
` : `${renderReceiptDelta(delta)}
`;
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve20(output), rendered);
    else process.stdout.write(rendered);
    return delta.status === "PASS" ? 0 : delta.status === "FAIL" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function valueNumber(value, name) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error(`${name} must be a non-negative decimal number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a non-negative decimal number`);
  return parsed;
}
function parseValueArgs(args) {
  const takesValue = /* @__PURE__ */ new Set([
    "--transcript",
    "--public-key",
    "--github-evidence",
    "--cost-usd",
    "--cost-source",
    "--cost-evidence",
    "--budget-usd",
    "--review-minutes",
    "--disposition",
    "--review-evidence",
    "--outcome",
    "--outcome-as-of",
    "--outcome-evidence",
    "--task-class",
    "--format",
    "--output"
  ]);
  const values = /* @__PURE__ */ new Map();
  const positional2 = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional2.push(arg);
      continue;
    }
    if (!takesValue.has(arg)) throw unknownOptionError(arg);
    if (values.has(arg)) throw duplicateOptionError(arg);
    const value = args[++index];
    if (value === void 0 || value.startsWith("--")) throw optionRequiresValueError(arg);
    values.set(arg, value);
  }
  if (positional2.length !== 1) throw new Error("value requires exactly one full receipt JSON path");
  const format = values.get("--format") ?? "text";
  if (!(/* @__PURE__ */ new Set(["text", "json", "markdown", "html"])).has(format)) throw new Error("value --format must be text, json, markdown, or html");
  const costSource = values.get("--cost-source");
  if (costSource && !(/* @__PURE__ */ new Set(["provider-billed", "subscription-allocated", "user-estimated"])).has(costSource)) {
    throw new Error("value --cost-source must be provider-billed, subscription-allocated, or user-estimated");
  }
  const disposition = values.get("--disposition");
  if (disposition && !(/* @__PURE__ */ new Set(["accepted", "dismissed", "changes-requested", "unreviewed"])).has(disposition)) {
    throw new Error("value --disposition must be accepted, dismissed, changes-requested, or unreviewed");
  }
  const outcome = values.get("--outcome");
  if (outcome && !(/* @__PURE__ */ new Set(["merged", "closed", "reverted", "hotfixed", "incident-linked", "unknown"])).has(outcome)) {
    throw new Error("value --outcome must be merged, closed, reverted, hotfixed, incident-linked, or unknown");
  }
  const taskClass = values.get("--task-class");
  if (taskClass && (taskClass.length > 80 || /[\x00-\x1f\x7f]/.test(taskClass))) throw new Error("value --task-class must be at most 80 printable characters");
  return {
    receipt: positional2[0],
    ...values.get("--transcript") ? { transcript: values.get("--transcript") } : {},
    ...values.get("--public-key") ? { publicKey: values.get("--public-key") } : {},
    ...values.get("--github-evidence") ? { githubEvidence: values.get("--github-evidence") } : {},
    ...values.get("--cost-usd") ? { costUsd: valueNumber(values.get("--cost-usd"), "value --cost-usd") } : {},
    ...costSource ? { costSource } : {},
    ...values.get("--cost-evidence") ? { costEvidence: values.get("--cost-evidence") } : {},
    ...values.get("--budget-usd") ? { budgetUsd: valueNumber(values.get("--budget-usd"), "value --budget-usd") } : {},
    ...values.get("--review-minutes") ? { reviewMinutes: valueNumber(values.get("--review-minutes"), "value --review-minutes") } : {},
    ...disposition ? { disposition } : {},
    ...values.get("--review-evidence") ? { reviewEvidence: values.get("--review-evidence") } : {},
    ...outcome ? { outcome } : {},
    ...values.get("--outcome-as-of") ? { outcomeAsOf: values.get("--outcome-as-of") } : {},
    ...values.get("--outcome-evidence") ? { outcomeEvidence: values.get("--outcome-evidence") } : {},
    ...taskClass ? { taskClass } : {},
    format,
    ...values.get("--output") ? { output: values.get("--output") } : {}
  };
}
function readBoundedFile(path, maximumBytes, label) {
  const size = statSync10(path).size;
  if (size > maximumBytes) throw new Error(`${label} is ${size} bytes; maximum is ${maximumBytes}`);
  return readFileSync23(path);
}
function runValue(args) {
  try {
    const options = parseValueArgs(args);
    const receiptPath = resolve20(options.receipt);
    const rawReceipt = readBoundedFile(receiptPath, 16 * 1024 * 1024, "value receipt");
    const report = JSON.parse(rawReceipt.toString("utf8"));
    if (report.schemaVersion !== "2" || !report.summary || typeof report.receiptHash !== "string") {
      throw new Error("value requires a full Agent Vigil receipt schema 2");
    }
    const verification2 = verifyReport(report, options.publicKey ? resolve20(options.publicKey) : void 0);
    if (!verification2.hashValid) throw new Error("value receipt hash is invalid");
    if (verification2.signatureValid === false) throw new Error("value receipt signature is invalid");
    let transcriptPath;
    if (options.transcript) transcriptPath = resolve20(options.transcript);
    else if ((/* @__PURE__ */ new Set(["codex", "claude-code", "authority/codex", "authority/claude-code"])).has(report.transcriptFormat)) {
      const candidates = [
        resolve20(dirname11(receiptPath), report.transcript),
        ...isAbsolute10(report.repo) ? [resolve20(report.repo, report.transcript)] : []
      ];
      transcriptPath = candidates.find((candidate) => existsSync9(candidate));
    }
    let loaded;
    if (transcriptPath) {
      loaded = loadTranscript(transcriptPath);
      if (loaded.transcriptSha256 !== report.transcriptSha256) throw new Error("value transcript digest does not match the receipt");
    }
    const evidenceHash = (path, label) => {
      if (!path) return void 0;
      const evidence = readBoundedFile(resolve20(path), 64 * 1024 * 1024, label);
      return `sha256:${createHash22("sha256").update(evidence).digest("hex")}`;
    };
    const costEvidenceSha256 = evidenceHash(options.costEvidence, "cost evidence");
    const github = options.githubEvidence ? loadGitHubEvidence(resolve20(options.githubEvidence)) : void 0;
    const inferredDisposition = options.disposition ?? github?.inference.disposition;
    const inferredOutcome = options.outcome ?? github?.inference.outcome;
    const inferredOutcomeAsOf = options.outcomeAsOf ?? github?.inference.outcomeAsOf;
    const reviewEvidenceSha256 = evidenceHash(options.reviewEvidence, "review evidence") ?? (github && inferredDisposition === github.inference.disposition && github.inference.reviewEvidence === "EVIDENCE_HASHED" ? github.evidenceHash : void 0);
    const outcomeEvidenceSha256 = evidenceHash(options.outcomeEvidence, "outcome evidence") ?? (github && inferredOutcome === github.inference.outcome && github.inference.outcomeEvidence === "EVIDENCE_HASHED" ? github.evidenceHash : void 0);
    const card = buildValueCard({
      report,
      hashValid: true,
      signatureValid: verification2.signatureValid,
      keyPinned: verification2.keyPinned,
      usage: loaded?.usage,
      toolCalls: loaded?.toolCalls.length,
      failedToolCalls: loaded?.toolCalls.filter((call) => call.isError).length,
      values: {
        taskClass: options.taskClass,
        budgetUsd: options.budgetUsd,
        costUsd: options.costUsd,
        costSource: options.costSource,
        costEvidenceSha256,
        reviewMinutes: options.reviewMinutes,
        disposition: inferredDisposition,
        reviewEvidenceSha256,
        outcome: inferredOutcome,
        outcomeAsOf: inferredOutcomeAsOf,
        outcomeEvidenceSha256,
        ...github ? { github: {
          evidenceHash: github.evidenceHash,
          ...github.pullRequest ? { pullRequestNumber: github.pullRequest.number } : {},
          ...github.reviews ? { approvals: github.reviews.approved, changesRequested: github.reviews.changesRequested } : {},
          ...github.reviewComments ? { reviewComments: github.reviewComments.records } : {},
          ...github.actions?.runDurationSeconds !== void 0 ? { actionsRunDurationSeconds: github.actions.runDurationSeconds } : {},
          ...github.actions?.jobDurationSeconds !== void 0 ? { actionsJobDurationSeconds: github.actions.jobDurationSeconds } : {},
          ...github.actions?.jobs !== void 0 ? { actionsJobs: github.actions.jobs } : {},
          ...github.actions?.failedJobs !== void 0 ? { actionsFailedJobs: github.actions.failedJobs } : {},
          actionsBilling: "UNAVAILABLE"
        } } : {},
        ...loaded ? { trajectory: analyzeTrajectory(classifyTranscriptActions(loaded)) } : {}
      }
    });
    const rendered = options.format === "json" ? `${JSON.stringify(card, null, 2)}
` : options.format === "markdown" ? renderValueCardMarkdown(card) : options.format === "html" ? renderValueCardHtml(card) : renderValueCardText(card);
    if (options.output) writePrivateFileAtomic(resolve20(options.output), rendered);
    else process.stdout.write(rendered);
    return card.valueVerdict === "POSITIVE" ? 0 : card.valueVerdict === "NEGATIVE" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runGitHubEvidence(args) {
  try {
    const flagKinds = {
      "--event": "event",
      "--pull-request": "pull-request",
      "--reviews": "reviews",
      "--review-comments": "review-comments",
      "--actions-run": "actions-run",
      "--actions-jobs": "actions-jobs",
      "--revert-commit": "revert-commit",
      "--hotfix-pull-request": "hotfix-pull-request",
      "--incident-issue": "incident-issue"
    };
    const inputs = {};
    let output;
    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index];
      if (!flag.startsWith("--")) throw unexpectedPositionalError();
      const value = args[++index];
      if (value === void 0 || value.startsWith("--")) throw optionRequiresValueError(flag);
      if (flag === "--output") {
        if (output) throw new Error("duplicate --output");
        output = value;
        continue;
      }
      const kind = flagKinds[flag];
      if (!kind) throw unknownOptionError(flag);
      if (inputs[kind]) throw duplicateOptionError(flag);
      inputs[kind] = value;
    }
    if (!inputs.event) throw new Error("github-evidence requires --event <event.json>");
    const bundle = buildGitHubEvidence(inputs);
    const rendered = `${JSON.stringify(bundle, null, 2)}
`;
    if (output) writePrivateFileAtomic(resolve20(output), rendered);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runCompareValue(args) {
  try {
    const paths = [];
    let format = "text";
    let output;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--format" || arg === "--output") {
        const value = args[++index];
        if (value === void 0 || value.startsWith("--")) throw optionRequiresValueError(arg);
        if (arg === "--format") {
          if (!(/* @__PURE__ */ new Set(["text", "json", "html"])).has(value)) throw new Error("compare-value --format must be text, json, or html");
          format = value;
        } else output = value;
      } else if (arg.startsWith("--")) throw unknownOptionError(arg);
      else paths.push(arg);
    }
    if (!paths.length) throw new Error("compare-value requires at least one Agent Value Card JSON path");
    const cards = paths.map(loadValueCard);
    const comparison = compareValueCards(cards, paths.length);
    const rendered = format === "json" ? `${JSON.stringify(comparison, null, 2)}
` : format === "html" ? renderValueComparisonHtml(comparison) : renderValueComparisonText(comparison);
    if (output) writePrivateFileAtomic(resolve20(output), rendered);
    else process.stdout.write(rendered);
    return comparison.status === "COMPARABLE" ? 0 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runAudit(args) {
  try {
    const options = parseArgs(args.slice(1));
    const diffPath = options.transcript;
    if (!diffPath) throw new Error("audit requires a unified Git diff path");
    const absolute = resolve20(diffPath);
    const raw = readFileSync23(absolute);
    if (raw.byteLength > 64 * 1024 * 1024) throw new Error("audit input exceeds the 64 MiB limit");
    const diff = raw.toString("utf8");
    const digest5 = `sha256:${createHash22("sha256").update(raw).digest("hex")}`;
    const integrity = routeIntegrity(checkIntegrityDiff(diff), options.strict ? "blocking" : "advisory");
    if (!integrity.results.length && integrity.advisories.length) {
      integrity.results.push({
        claim: { kind: "integrity", quote: "static unified-diff audit", subject: "parseable unified Git diff audited" },
        verdict: "verified",
        evidence: `${integrity.advisories.length} heuristic finding(s) recorded as non-blocking advisories`,
        ruleId: "diff-audit-complete"
      });
    }
    const report = buildReport({
      transcript: relative14(process.cwd(), absolute) || absolute,
      transcriptSha256: digest5,
      transcriptFormat: "unified-git-diff",
      repo: "static-diff-audit",
      base: "unavailable",
      head: digest5,
      results: integrity.results,
      advisories: integrity.advisories,
      policy: { minVerified: 1, strict: true, source: options.strict ? "built-in strict static diff policy" : "built-in advisory static diff policy", sha256: `sha256:${createHash22("sha256").update(`agent-vigil-static-diff-v2:${options.strict ? "blocking" : "advisory"}`).digest("hex")}` },
      reproduction: `vigil audit ${shellQuote(diffPath)}${options.strict ? " --strict" : ""}`
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runTestIntegrity(args) {
  try {
    const options = parseArgs(args.slice(1));
    const repo = resolve20(options.repo);
    if (!gitRefExists(repo, options.base) || options.head !== "WORKTREE" && !gitRefExists(repo, options.head)) {
      throw new Error(`invalid git range ${options.base}..${options.head}`);
    }
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const checks = checkIntegrity(repo, base, head);
    const integrity = routeIntegrity(checks, options.strict ? "blocking" : "calibrated");
    for (const check of integrity.results) {
      if (check.ruleId === "integrity-scan" && check.verdict === "verified") check.contributesToPass = true;
    }
    const diffArgs = head === "WORKTREE" ? ["diff", "--no-color", base] : ["diff", "--no-color", base, head];
    const diff = execFileSync13("git", diffArgs, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const digest5 = `sha256:${createHash22("sha256").update(diff).digest("hex")}`;
    const policyName = options.strict ? "all static integrity findings block" : "calibrated high-confidence test integrity rules block";
    const report = buildReport({
      transcript: `${base}..${head}`,
      transcriptSha256: digest5,
      transcriptFormat: "test-integrity-diff",
      repo,
      base,
      head,
      results: integrity.results,
      advisories: integrity.advisories,
      policy: {
        minVerified: 1,
        strict: true,
        source: policyName,
        sha256: `sha256:${createHash22("sha256").update(`agent-vigil-test-integrity-v1:${options.strict ? "blocking" : "calibrated"}`).digest("hex")}`
      },
      repository: {
        ...git9(repo, ["config", "--get", "remote.origin.url"]) ? { remote: git9(repo, ["config", "--get", "remote.origin.url"]) } : {},
        ...head !== "WORKTREE" && git9(repo, ["rev-parse", `${head}^{tree}`]) ? { tree: git9(repo, ["rev-parse", `${head}^{tree}`]) } : {}
      },
      reproduction: `vigil test-integrity --repo . --base ${base} --head ${head}${options.strict ? " --strict" : ""}`
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function runAuthority(args) {
  try {
    if (args[1] === "init") {
      const output = optionValue(args, "--output");
      const rendered = authorityContractTemplate();
      if (output) {
        writePrivateFileAtomic(resolve20(output), rendered);
        console.log(`Created task-scoped authority contract ${output}. Review every allowed action and replace the task ID before use.`);
      } else process.stdout.write(rendered);
      return 0;
    }
    const contractOption = optionValue(args, "--contract");
    if (!contractOption) throw new Error("authority requires --contract <authority.json>");
    const contractRef = optionValue(args, "--contract-ref");
    let stripped = withoutOption(args.slice(1), "--contract");
    if (contractRef) stripped = withoutOption(stripped, "--contract-ref");
    const options = parseArgs(stripped);
    const transcriptOption = options.transcript;
    if (!transcriptOption) throw new Error("authority requires a structured agent transcript");
    const repo = resolve20(options.repo);
    if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) throw new Error(`invalid git range ${options.base}..${options.head}`);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const transcriptPath = isAbsolute10(transcriptOption) ? transcriptOption : resolve20(repo, transcriptOption);
    if (!existsSync9(transcriptPath)) throw new Error(`transcript not found: ${transcriptPath}`);
    const contract = loadAuthorityContract(repo, contractOption, contractRef);
    const loaded = loadTranscript(transcriptPath);
    const inputs = [transcriptPath, ...contract.path ? [contract.path] : []];
    const results = [...checkWorkspaceBinding(repo, head, inputs)];
    const advisories = [];
    const authority = buildAuthorityChecks(repo, base, head, loaded, contract.value);
    results.push(...authority.results);
    if (!contract.ref) advisories.push({
      claim: { kind: "authority_scope", subject: "authority trust root", quote: contract.source },
      verdict: "unverifiable",
      evidence: "the contract was loaded from the local filesystem; use --contract-ref <trusted-base-sha> in CI so candidate changes cannot widen their own authority",
      ruleId: "authority-contract-anchor",
      contributesToPass: false
    });
    const remote = git9(repo, ["config", "--get", "remote.origin.url"]);
    const tree = git9(repo, ["rev-parse", `${head}^{tree}`]);
    const relativeTranscript = relative14(repo, transcriptPath) || transcriptOption;
    const reproduction = [
      "vigil authority",
      shellQuote(relativeTranscript),
      "--contract",
      shellQuote(contract.gitPath ?? contractOption),
      ...contract.ref ? ["--contract-ref", contract.ref] : [],
      "--repo",
      ".",
      "--base",
      base,
      "--head",
      head
    ].join(" ");
    let report = buildReport({
      transcript: relativeTranscript,
      transcriptSha256: loaded.transcriptSha256,
      transcriptFormat: `authority/${loaded.format}`,
      repo,
      base,
      head,
      results,
      advisories,
      policy: { minVerified: 1, strict: true, source: contract.source, sha256: contract.sha256 },
      repository: { ...remote ? { remote } : {}, ...tree ? { tree } : {} },
      reproduction
    });
    if (options.signingKey) report = signReport(report, resolve20(options.signingKey));
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function git9(repo, args) {
  try {
    return execFileSync13("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function run(argv = process.argv.slice(2)) {
  if (argv[0] === "demo") return runDemo(run);
  if (argv[0] === "upgrade") return runUpgradeCommand(argv.slice(1));
  if (argv[0] === "protect") return runProtect(argv);
  if (argv[0] === "prove") return runProve(argv);
  if (argv[0] === "certify") return runCertify(argv);
  if (argv[0] === "plan") return runPlan2(argv);
  if (argv[0] === "proof-comment") return runProofComment(argv);
  if (argv[0] === "test-integrity") return runTestIntegrity(argv);
  if (argv[0] === "init") return runInit2(argv);
  if (argv[0] === "doctor") return runDoctor2(argv);
  if (argv[0] === "keygen") return runKeygen(argv);
  if (argv[0] === "verify") return runVerify2(argv);
  if (argv[0] === "attest") return runAttest(argv);
  if (argv[0] === "verify-attestation") return runVerifyAttestation(argv);
  if (argv[0] === "notary") return runNotary(argv);
  if (argv[0] === "compare") return runCompare(argv);
  if (argv[0] === "github-evidence") return runGitHubEvidence(argv);
  if (argv[0] === "value") return runValue(argv);
  if (argv[0] === "compare-value") return runCompareValue(argv);
  if (argv[0] === "audit") return runAudit(argv);
  if (argv[0] === "authority") return runAuthority(argv);
  if (argv[0] === "gate") return runGate(argv);
  if (argv[0] === "maintainer") return runMaintainer(argv);
  if (argv[0] === "merge-group") return runMergeGroup(argv);
  if (argv.includes("--help")) {
    console.log(usage2());
    return 0;
  }
  if (argv.includes("--version")) {
    console.log(VERSION);
    return 0;
  }
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
  const repo = resolve20(options.repo);
  if (options.portableOutput && !options.signingKey) {
    return reportCliError("agent-vigil", portableSigningKeyError());
  }
  let policy;
  try {
    policy = loadPolicy(repo, options.policy, options.policyRef);
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
  const transcript = options.transcript ?? policy.value.transcript;
  if (!transcript) return reportCliError("agent-vigil", missingTranscriptError());
  const transcriptPath = isAbsolute10(transcript) ? transcript : resolve20(repo, transcript);
  const testCmd = options.testCmd ?? policy.value.testCommand;
  const strict = options.strict ?? policy.value.strict ?? false;
  const minVerified = options.minVerified ?? policy.value.minVerified ?? 1;
  if (!existsSync9(transcriptPath)) return reportCliError("agent-vigil", transcriptUnavailableError());
  if (!existsSync9(repo)) return reportCliError("agent-vigil", repositoryUnavailableError());
  if (!gitRefExists(repo, options.base) || options.head !== "WORKTREE" && !gitRefExists(repo, options.head)) {
    return reportCliError("agent-vigil", invalidGitRangeError());
  }
  try {
    const loaded = loadTranscript(transcriptPath);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const claims = extractClaims(loaded.narrative);
    const runClaims = extractRunClaims(loaded.narrative);
    const results = [];
    const advisories = [];
    const workspaceInputs = [
      transcriptPath,
      ...policy.path ? [policy.path] : [],
      ...options.signingKey ? [resolve20(options.signingKey)] : [],
      ...options.portableOutput ? [resolve20(repo, options.portableOutput)] : []
    ];
    results.push(...checkWorkspaceBinding(repo, head, workspaceInputs));
    results.push(...checkTestsPass(claims, repo, testCmd));
    results.push(...checkWorkspaceMutation(repo, workspaceInputs, head));
    results.push(...checkFilesChanged(claims, repo, base, head));
    const changedClaims = new Set(claims.filter((claim) => claim.kind === "file_changed").map((claim) => claim.subject));
    results.push(...checkPathsExist(claims.filter((claim) => !changedClaims.has(claim.subject)), repo));
    results.push(...checkRunClaims(runClaims, loaded.toolCalls));
    results.push(...checkStepRepetition(loaded.toolCalls));
    const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
    results.push(...integrity.results);
    advisories.push(...integrity.advisories);
    results.push(...checkCompletion(claims, repo, base, head, results));
    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative14(repo, policy.path) : void 0;
    const remote = git9(repo, ["config", "--get", "remote.origin.url"]);
    const tree = head === "WORKTREE" ? void 0 : git9(repo, ["rev-parse", `${head}^{tree}`]);
    const relativeTranscript = relative14(repo, transcriptPath) || transcript;
    const reproduction = [
      "vigil",
      shellQuote(relativeTranscript),
      "--repo",
      ".",
      "--base",
      base,
      "--head",
      head,
      ...options.testCmd ? ["--test-cmd", shellQuote(options.testCmd)] : [],
      ...policy.gitPath ? ["--policy", shellQuote(policy.gitPath)] : policySource ? ["--policy", shellQuote(policySource)] : [],
      ...policy.ref ? ["--policy-ref", policy.ref] : [],
      ...strict && !policy.value.strict ? ["--strict"] : [],
      ...options.minVerified !== void 0 ? ["--min-verified", String(options.minVerified)] : [],
      ...options.portableOutput ? ["--portable-output", shellQuote(options.portableOutput)] : []
    ].join(" ");
    let report = buildReport({
      transcript: relativeTranscript,
      transcriptSha256: loaded.transcriptSha256,
      transcriptFormat: loaded.format,
      repo,
      base,
      head,
      results,
      advisories,
      policy: { minVerified, strict, source: policySource, sha256: policy.sha256 },
      repository: { ...remote ? { remote } : {}, ...tree ? { tree } : {} },
      reproduction
    });
    if (options.signingKey) report = signReport(report, resolve20(options.signingKey));
    writeOutputs(report, options);
    if (options.portableOutput) {
      const portable = createPortableReceipt(report, resolve20(options.signingKey));
      const portablePath = resolve20(repo, options.portableOutput);
      mkdirSync7(dirname11(portablePath), { recursive: true });
      writeFileSync7(portablePath, `${JSON.stringify(portable, null, 2)}
`);
    }
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    return reportCliError("agent-vigil", error);
  }
}
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync12(process.argv[1]) === realpathSync12(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) process.exit(run());
export {
  run
};
/*! Bundled license information:

smol-toml/dist/date.js:
smol-toml/dist/error.js:
smol-toml/dist/util.js:
smol-toml/dist/primitive.js:
smol-toml/dist/extract.js:
smol-toml/dist/struct.js:
smol-toml/dist/parse.js:
smol-toml/dist/stringify.js:
smol-toml/dist/index.js:
  (*!
   * Copyright (c) Squirrel Chat et al., All rights reserved.
   * SPDX-License-Identifier: BSD-3-Clause
   *
   * Redistribution and use in source and binary forms, with or without
   * modification, are permitted provided that the following conditions are met:
   *
   * 1. Redistributions of source code must retain the above copyright notice, this
   *    list of conditions and the following disclaimer.
   * 2. Redistributions in binary form must reproduce the above copyright notice,
   *    this list of conditions and the following disclaimer in the
   *    documentation and/or other materials provided with the distribution.
   * 3. Neither the name of the copyright holder nor the names of its contributors
   *    may be used to endorse or promote products derived from this software without
   *    specific prior written permission.
   *
   * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
   * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
   * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
   * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
   * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
   * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
   * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
   * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
   * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
   * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
   *)
*/
