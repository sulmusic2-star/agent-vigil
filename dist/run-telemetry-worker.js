// src/run-telemetry-worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/run-telemetry.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync, lstatSync as lstatSync3 } from "node:fs";
import { resolve as resolve3 } from "node:path";

// src/authority.ts
import { createHash as createHash2 } from "node:crypto";
import { isAbsolute, normalize, relative, resolve as resolve2, win32 } from "node:path";
import { lstatSync as lstatSync2, realpathSync } from "node:fs";

// src/safe-fs.ts
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
function readRegularFileSnapshot(requestedPath, maximumBytes, label = "input") {
  const absolutePath = resolve(requestedPath);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0;
  let descriptor;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    if (error.code === "ELOOP") {
      throw new Error(`${label} must be a regular non-symbolic-link file (symbolic link refused)`);
    }
    throw error;
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(absolutePath, { bigint: true });
    if (linked.isSymbolicLink() || !linked.isFile() || !opened.isFile()) {
      throw new Error(`${label} must be a regular non-symbolic-link file (symbolic link refused)`);
    }
    if (opened.dev !== linked.dev || opened.ino !== linked.ino || opened.size !== linked.size || opened.mtimeNs !== linked.mtimeNs || opened.ctimeNs !== linked.ctimeNs) {
      throw new Error(`${label} changed while it was opened`);
    }
    if (opened.size > BigInt(maximumBytes)) throw new Error(`${label} is ${opened.size} bytes; maximum is ${maximumBytes}`);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`${label} changed while it was read`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error(`${label} changed while it was read`);
    }
    return {
      absolutePath,
      bytes,
      mode: Number(opened.mode & 0o7777n),
      device: opened.dev,
      inode: opened.ino,
      size: opened.size,
      mtimeNs: opened.mtimeNs,
      ctimeNs: opened.ctimeNs,
      identity: [
        opened.dev,
        opened.ino,
        opened.size,
        opened.mtimeNs,
        opened.ctimeNs,
        opened.mode,
        opened.uid,
        opened.gid
      ].join(":")
    };
  } finally {
    closeSync(descriptor);
  }
}

// src/candidate-command.ts
var MAX_WRAPPER_CAPTURE_BYTES = 3 * 1024 * 1024;
var TIMEOUT_MARKER = "[agent-vigil-command-timeout]";
var ABNORMAL_MARKER = "[agent-vigil-command-abnormal]";
var COMMAND_WRAPPER = String.raw`
const { execFile, spawn } = require("node:child_process");
const { writeSync } = require("node:fs");
const command = process.argv[1];
const timeout = Number(process.argv[2]);
const windows = process.platform === "win32";
const shell = windows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
// POSIX shells synthesize and export PWD even when their own environment was
// created with env -i. Remove it before candidate code starts so the hosted
// sandbox contract remains the exact explicit allowlist.
// Match Node's own cmd.exe normalization: /s removes the outer quote pair,
// leaving command-owned quotes intact, while verbatim argv prevents libuv's
// C-runtime escaping from rewriting those quotes into syntax cmd cannot parse.
const shellArgs = windows ? ["/d", "/s", "/c", '"' + command + '"'] : ["-c", "unset PWD\n" + command];
// Retain the child-owned pipes until EOF so a descendant that inherits them
// remains tied to this wrapper's timeout. Buffer under the outer verifier's
// maxBuffer, then synchronously forward complete bytes after the child closes;
// JavaScript stream re-piping can drop the final test summary on Windows.
const child = spawn(shell, shellArgs, {
  env: process.env,
  // POSIX needs a detached process group for the negative-PID kill below.
  // On Windows, taskkill /T already terminates the process tree; detaching cmd
  // lets it return before the candidate console program has actually exited.
  detached: !windows,
  stdio: ["ignore", "pipe", "pipe"],
  windowsVerbatimArguments: windows,
});
const captureLimit = ${MAX_WRAPPER_CAPTURE_BYTES};
const stdoutChunks = [];
const stderrChunks = [];
let capturedBytes = 0;
let timedOut = false;
let terminating = false;
let finished = false;
const writeAll = (fd, chunks) => {
  for (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.length) {
      const written = writeSync(fd, chunk, offset, chunk.length - offset);
      if (written <= 0) throw new Error("candidate output descriptor stopped accepting bytes");
      offset += written;
    }
  }
};
const finish = (code, marker = "") => {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try {
    writeAll(1, stdoutChunks);
    writeAll(2, stderrChunks);
    if (marker) writeAll(2, [Buffer.from(marker + "\\n")]);
    // Setting exitCode lets the wrapper's own descriptors settle. Calling
    // process.exit() here can discard the final test summary on Windows.
    process.exitCode = code;
  } catch {
    process.exitCode = 125;
  }
};
const terminateTree = (code, marker) => {
  if (terminating || finished) return;
  terminating = true;
  clearTimeout(timer);
  const stopCapture = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  if (windows) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
      stopCapture();
      finish(code, marker);
    });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    setTimeout(() => {
      stopCapture();
      finish(code, marker);
    }, 50);
  }
};
const capture = (stream, chunks) => {
  stream.on("data", (value) => {
    if (terminating || finished) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = captureLimit - capturedBytes;
    if (remaining > 0) {
      const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      capturedBytes += kept.length;
    }
    if (chunk.length > remaining) {
      terminateTree(125, "${ABNORMAL_MARKER} output exceeded " + captureLimit + " bytes");
    }
  });
  stream.on("error", (error) => {
    terminateTree(125, "${ABNORMAL_MARKER} output capture failed: " + error.message);
  });
};
capture(child.stdout, stdoutChunks);
capture(child.stderr, stderrChunks);
const timer = setTimeout(() => {
  timedOut = true;
  terminateTree(124, "${TIMEOUT_MARKER}");
}, timeout);
child.on("error", (error) => {
  finish(125, "${ABNORMAL_MARKER} " + error.message);
});
child.on("close", (code, signal) => {
  if (timedOut || terminating || finished) return;
  if (signal || code === null) {
    finish(125, "${ABNORMAL_MARKER} signal=" + (signal || "unknown"));
    return;
  }
  finish(code);
});
`;

// src/transcript.ts
import { createHash } from "node:crypto";
var MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
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
function tokenCounter(value, field) {
  if (value === void 0) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid token usage counter ${field}`);
  }
  return value;
}
function tokenSum(values, field) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error(`invalid token usage aggregate ${field}`);
  return total;
}
function usageCounters(value) {
  const recognizedFields = [
    "input_tokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cache_write_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens"
  ];
  if (!recognizedFields.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    throw new Error("token usage record contains no recognized counters");
  }
  const inputTokens = tokenCounter(value.input_tokens, "input_tokens");
  const cachedInputTokensPrimary = tokenCounter(value.cached_input_tokens, "cached_input_tokens");
  const cachedInputTokensAlias = tokenCounter(value.cache_read_input_tokens, "cache_read_input_tokens");
  const cachedInputTokens = value.cached_input_tokens === void 0 ? cachedInputTokensAlias : cachedInputTokensPrimary;
  const cacheWriteInputTokensPrimary = tokenCounter(value.cache_write_input_tokens, "cache_write_input_tokens");
  const cacheWriteInputTokensAlias = tokenCounter(value.cache_creation_input_tokens, "cache_creation_input_tokens");
  const cacheWriteInputTokens = value.cache_write_input_tokens === void 0 ? cacheWriteInputTokensAlias : cacheWriteInputTokensPrimary;
  const outputTokens = tokenCounter(value.output_tokens, "output_tokens");
  const reasoningOutputTokens = tokenCounter(value.reasoning_output_tokens, "reasoning_output_tokens");
  const reportedTotal = tokenCounter(value.total_tokens, "total_tokens");
  const calculatedTotal = tokenSum(
    [inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens],
    "total_tokens"
  );
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: reportedTotal || calculatedTotal
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
  const usage = [...usageByMessage.values()].reduce((total, item) => ({
    inputTokens: tokenSum([total.inputTokens, item.inputTokens], "input_tokens"),
    cachedInputTokens: tokenSum([total.cachedInputTokens, item.cachedInputTokens], "cached_input_tokens"),
    cacheWriteInputTokens: tokenSum([total.cacheWriteInputTokens, item.cacheWriteInputTokens], "cache_write_input_tokens"),
    outputTokens: tokenSum([total.outputTokens, item.outputTokens], "output_tokens"),
    reasoningOutputTokens: tokenSum([total.reasoningOutputTokens, item.reasoningOutputTokens], "reasoning_output_tokens"),
    totalTokens: tokenSum([total.totalTokens, item.totalTokens], "total_tokens")
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
      ...usage,
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
function parseTranscript(raw, path = "transcript.jsonl") {
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

// src/detectors/agentic.ts
var MAX_FILE_BYTES = 1024 * 1024;

// src/detectors/reality.ts
var INTEGRITY_CHANGED_PATHS_MAX_BUFFER = 1024 * 1024;
var INTEGRITY_DIFF_MAX_BUFFER = 8 * 1024 * 1024;
var INTEGRITY_TEST_BLOB_MAX_BUFFER = 4 * 1024 * 1024;

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
var RESOURCE_KEY = /^(?:path|paths|file|files|file_path|filepath|filename|target|source|directory|dir|cwd|workdir|root|repo|repository)$/i;
var CREDENTIAL_RESOURCE = /(?:^|[\\/._-])(?:\.env|\.ssh|\.aws|\.gnupg|credentials?|secrets?|tokens?|id_(?:rsa|ed25519)|keychain|private[_-]?key|api[_-]?key|npmrc|netrc)(?:$|[\\/._-])/i;
function patchResourcePaths(raw) {
  return [...raw.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((match) => match[1].trim()).filter(Boolean);
}
function toolResourcePaths(call) {
  const paths = [];
  const parsed = inputObject(call);
  const visit = (value, key = "", depth = 0) => {
    if (depth > 3) return;
    if (typeof value === "string") {
      if (RESOURCE_KEY.test(key)) paths.push(value);
      return;
    }
    if (Array.isArray(value)) {
      if (RESOURCE_KEY.test(key)) {
        for (const item of value) if (typeof item === "string") paths.push(item);
      } else {
        for (const item of value) visit(item, key, depth + 1);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
    }
  };
  if (parsed) visit(parsed);
  if (/apply[_-]?patch/i.test(call.name)) paths.push(...patchResourcePaths(call.input));
  if (!parsed && paths.length === 0 && !call.input.includes("\n") && call.input.trim().length <= 1024) {
    const fallback = call.input.trim();
    let validJson = false;
    try {
      JSON.parse(fallback);
      validJson = true;
    } catch {
    }
    if (!validJson) paths.push(fallback);
  }
  return [...new Set(paths.filter(Boolean))];
}
function resourcePathIsRepoBound(path, repo, relativeTo) {
  if (!path || path.includes("\0") || path.includes("\n") || path.includes("\r") || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  if (/[*?\[\]{}()]/.test(path)) return false;
  if (!repo) {
    const clean = normalize(path).replaceAll("\\", "/");
    return !isAbsolute(path) && !win32.isAbsolute(path) && clean !== ".." && !clean.startsWith("../");
  }
  let root;
  try {
    root = realpathSync(repo);
  } catch {
    return false;
  }
  const lexicalRoot = resolve2(repo);
  const base = relativeTo ? resolve2(relativeTo) : root;
  const absolute = isAbsolute(path) ? resolve2(path) : win32.isAbsolute(path) ? "" : resolve2(base, path);
  if (!absolute) return false;
  let fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    const fromLexicalRoot = relative(lexicalRoot, absolute);
    if (fromLexicalRoot === ".." || fromLexicalRoot.startsWith("../") || isAbsolute(fromLexicalRoot)) return false;
    fromRoot = fromLexicalRoot;
  }
  const segments = fromRoot.split(/[\\/]/).filter(Boolean);
  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    if (segment === "..") return false;
    cursor = resolve2(cursor, segment);
    try {
      const entry = lstatSync2(cursor);
      if (entry.isSymbolicLink()) return false;
    } catch (error) {
      if (error.code === "ENOENT") return index === segments.length - 1;
      return false;
    }
  }
  return true;
}
function ambiguousShellSyntax(command) {
  return /[<>`'"\\]|\$\(|\$\{|\$[A-Za-z_][A-Za-z0-9_]*|%[A-Za-z_][A-Za-z0-9_]*%|\n|\r/.test(command) || /(^|[^&])&([^&]|$)/.test(command);
}
function shellHasUnboundPath(command, repo, workingDirectory) {
  const tokens = command.trim().split(/\s+/).slice(1).map((token) => token.replace(/^["']|["']$/g, ""));
  return tokens.some((token) => {
    if (!token || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false;
    if (token.startsWith("-") && !token.includes("=")) {
      return !/^(?:-[A-Za-z]|--[A-Za-z][A-Za-z0-9-]*)$/.test(token);
    }
    const candidate = (token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token).replace(/^["']|["']$/g, "");
    if (!candidate) return false;
    if (/[*?]/.test(candidate)) return true;
    return !resourcePathIsRepoBound(candidate, repo, workingDirectory);
  });
}
function commandWorkingDirectory(call, repo) {
  const input = inputObject(call);
  const selected = input?.workdir ?? input?.cwd;
  if (selected === void 0) return { path: repo, unsafe: false };
  if (typeof selected !== "string" || !repo || !resourcePathIsRepoBound(selected, repo)) {
    return { unsafe: true };
  }
  let root;
  try {
    root = realpathSync(repo);
  } catch {
    return { unsafe: true };
  }
  return { path: isAbsolute(selected) ? resolve2(selected) : resolve2(root, selected), unsafe: false };
}
function browserActionWords(input) {
  if (!input) return "";
  const words = [];
  const visit = (value, key = "", depth = 0) => {
    if (depth > 3) return;
    words.push(key.toLowerCase());
    if (typeof value === "string" && /^(?:action|command|method|op|operation|fn|kind|type|verb|event)$/i.test(key)) words.push(value.toLowerCase());
    else if (Array.isArray(value)) for (const item of value) visit(item, key, depth + 1);
    else if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1);
  };
  visit(input);
  return words.join(" ");
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
function classesForCommand(raw, repo, workingDirectory) {
  const command = raw.trim().replace(/^(?:sudo\s+|env\s+(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)+)+/, "");
  const classes = /* @__PURE__ */ new Set();
  const add = (...items) => items.forEach((item) => classes.add(item));
  if (/^(?:ls|pwd|cat|head|tail|grep|rg|find|stat|wc|diff|jq|sed\s+(?!.*(?:-i|--in-place))|git\s+(?:status|diff|log|show|rev-parse|ls-files|remote\s+-v)\b)/i.test(command)) add("repository_read");
  if (/^(?:node\s+--test\b|(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|check|lint|typecheck|smoke|verify)|exec\s+.*test)|pytest\b|python\s+-m\s+pytest\b|go\s+test\b|cargo\s+test\b|dotnet\s+test\b|mvn\s+test\b|gradle\s+test\b|make\s+(?:test|check|verify)\b)/i.test(command)) add("test_execute");
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+build|build)|^(?:cargo|go|dotnet|mvn|gradle|make)\s+build\b/i.test(command)) add("build_execute");
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci)\b|pipx?\s+install\b|python\s+-m\s+pip\s+install\b|uv\s+(?:add|sync|pip\s+install)\b|brew\s+install\b|apt(?:-get)?\s+install\b|dnf\s+install\b|gem\s+install\b)/i.test(command)) add("dependency_install");
  if (/^(?:rm|rmdir|del|erase|trash)\b|\bgit\s+(?:clean|reset\s+--hard)\b/i.test(command)) add("destructive_filesystem");
  if (/^git\s+commit\b/i.test(command)) add("git_commit");
  if (/^git\s+push\b/i.test(command)) add("git_push");
  if (/^gh\s+pr\s+(?:create|merge|close|comment|edit|review)\b/i.test(command)) add("pull_request_write");
  if (/^(?:gh\s+release\s+(?:create|upload|edit|delete)|npm\s+publish|cargo\s+publish|twine\s+upload)\b/i.test(command)) add("release_publish");
  if (/^(?:vercel|netlify|wrangler\s+deploy|flyctl\s+deploy|gcloud\s+(?:run\s+deploy|app\s+deploy)|aws\s+.*deploy|kubectl\s+(?:apply|delete|rollout)|helm\s+(?:install|upgrade|uninstall)|terraform\s+apply)\b/i.test(command)) add("deploy");
  if (/^(?:curl|wget)\b/i.test(command)) {
    add("network_read");
    if (/(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)\b|--request\s+(?:POST|PUT|PATCH|DELETE)\b|--data(?:-\w+)?\b|-d\s|-F(?:\s|=)|--form(?:-string)?\b|-T(?:\s|=)|--upload-file\b|--json\b|--post-data\b|--post-file\b|--method\s+(?!GET\b)|--body-(?:data|file)\b)/i.test(command)) add("external_write");
    if (/(?:\s-o(?:\s|=)|--output\b|\s-O(?:\s|$)|--remote-name\b|--output-document\b|--cookie-jar\b)/i.test(command)) add("unknown_effect");
    if (/(?:authorization|--netrc\b|(?:^|\s)-(?:u|b)(?:\s|=)|--user\b|--cookie\b)/i.test(command)) add("credential_access");
    add("unknown_effect");
  }
  if (/^(?:gh\s+(?:issue|api)\s+.*(?:comment|create|edit|delete)|mail|sendmail|osascript\s+.*mail)\b/i.test(command)) add("external_write");
  if (/(?:\.env\b|\.ssh\/|credentials?|api[_-]?key|token|secret|keychain|security\s+find-generic-password)/i.test(command)) add("credential_access");
  if (/^(?:git\s+(?:add|checkout|switch|restore|mv|rm)|mkdir|touch|cp|mv|sed\s+.*(?:-i|--in-place)|tee\b|printf\b.*>|echo\b.*>)\b/i.test(command)) add("repository_write");
  if (/^(?:sh|bash|zsh|cmd|powershell|pwsh)\s+(?:-c|\/c)\b|\beval\b/i.test(command)) add("unknown_effect");
  if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:test|run|exec)\b|make\b)/i.test(command) || /(?:^|\s)(?:xargs|parallel)\b|(?:^|\s)-(?:exec|execdir|ok|okdir)\b/i.test(command) || /^(?:sed|find)\b/i.test(command)) add("unknown_effect");
  if (/^find\b.*(?:^|\s)-delete(?:\s|$)/i.test(command)) add("destructive_filesystem");
  if (/^node\s+--test\b.*(?:^|\s)--test-reporter-destination(?:=|\s)/i.test(command) || /^git\s+(?:diff|log|show)\b.*(?:^|\s)--output(?:=|\s)/i.test(command)) add("unknown_effect");
  if (/^rg\b.*(?:^|\s)--(?:pre|hostname-bin)(?:=|\s)/i.test(command)) add("unknown_effect");
  if (ambiguousShellSyntax(raw) || shellHasUnboundPath(command, repo, workingDirectory)) add("unknown_effect");
  if (!classes.size) add("unknown_effect");
  return [...classes];
}
function classifyToolCall(call, repo) {
  const name = call.name.toLowerCase();
  const adapter = name.split("__").filter(Boolean).at(-1) ?? name;
  const classes = /* @__PURE__ */ new Set();
  const add = (...items) => items.forEach((item) => classes.add(item));
  const command = commandText(call);
  if (command !== void 0) {
    const workingDirectory = commandWorkingDirectory(call, repo);
    for (const segment of splitShellCommands(command)) {
      for (const item of classesForCommand(segment, repo, workingDirectory.path)) classes.add(item);
    }
    if (workingDirectory.unsafe) add("unknown_effect");
    if (ambiguousShellSyntax(command)) add("unknown_effect");
  } else if (/^(?:create_thread|spawn_agent|delegate)$/.test(adapter)) add("task_create");
  else if (/^(?:apply[_-]?patch|write[_-]?file|edit[_-]?file|create[_-]?file|delete[_-]?file|write|edit)$/.test(adapter)) {
    add("repository_write");
    const paths = toolResourcePaths(call);
    if (paths.length === 0 || paths.some((path) => !resourcePathIsRepoBound(path, repo))) add("unknown_effect");
  } else if (/^(?:read[_-]?file|read[_-]?text|glob|grep|search_files|list_files|view_image|read)$/.test(adapter)) {
    add("repository_read");
    const parsed = inputObject(call);
    const paths = toolResourcePaths(call);
    const pathRequired = /^(?:read[_-]?file|read[_-]?text|view_image|read)$/.test(adapter);
    if (!parsed && paths.length === 0 || pathRequired && paths.length === 0 || paths.some((path) => !resourcePathIsRepoBound(path, repo))) add("unknown_effect");
    if (/^(?:glob|grep|search_files)$/.test(adapter)) add("unknown_effect");
  } else if (/^(?:web(?:_run)?|fetch|search_query|open_url|browser|chrome|computer_use)$/.test(adapter)) {
    add("network_read");
    const parsed = inputObject(call);
    const words = `${name} ${browserActionWords(parsed)}`;
    const safeWebBatchKeys = /* @__PURE__ */ new Set(["search_query", "image_query", "open", "find", "screenshot", "finance", "weather", "sports", "time", "response_length"]);
    if (/click|submit|fill|type|press|upload|download|execute|evaluate|javascript|drag|select/.test(words)) add("unknown_effect");
    if (/submit|upload|post|send|comment|delete|edit|create/.test(words)) add("external_write");
    if (/browser|chrome|computer_use/.test(name)) add("unknown_effect");
    if (/web/.test(name) && parsed && Object.keys(parsed).some((key) => !safeWebBatchKeys.has(key))) add("unknown_effect");
    if (!/(?:search|search_query|fetch|open_url|screenshot|find|read|get|query)/.test(words)) add("unknown_effect");
    if (!parsed && !/search|fetch|open_url/.test(name)) add("unknown_effect");
  } else if (/^(?:send(?:_email|_message)?|email|message|comment|post|submit)$/.test(adapter)) add("external_write");
  else add("unknown_effect");
  if (name !== adapter) add("unknown_effect");
  const namedSideEffect = /(?:^|[_-])(?:delete|remove|rm|unlink|destroy|truncate|write|edit|publish|release|deploy|upload|submit|send|email|message|comment|post|push|merge|click)(?:$|[_-])/.test(name);
  const classifiedSideEffect = [...classes].some((item) => [
    "repository_write",
    "external_write",
    "release_publish",
    "deploy",
    "pull_request_write",
    "git_push",
    "destructive_filesystem"
  ].includes(item));
  if (namedSideEffect && !classifiedSideEffect) add("unknown_effect");
  if (/credential|secret|keychain|token/.test(name) || (classes.has("repository_read") || classes.has("repository_write")) && CREDENTIAL_RESOURCE.test(call.input)) add("credential_access");
  const identityInput = command ?? call.input;
  return {
    toolCallId: call.id,
    toolName: call.name,
    sequence: call.sequence,
    classes: [...classes],
    summary: command ? command.slice(0, 240).replace(/\s+/g, " ") : call.input.slice(0, 240).replace(/\s+/g, " "),
    identitySha256: `sha256:${createHash2("sha256").update(`${call.name}\0${identityInput}`).digest("hex")}`,
    completed: call.output !== void 0,
    failed: call.isError === true
  };
}
function classifyTranscriptActions(transcript, repo) {
  return transcript.toolCalls.map((call) => classifyToolCall(call, repo));
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
    repeatedActionGroups: counts.filter((count) => count > 1).length,
    maxConsecutiveFailedToolCalls: maxFailureStreak,
    progressBearingActions: actions.filter((action) => action.classes.some((item) => progressClasses.has(item))).length
  };
}

// src/run-telemetry.ts
var PROGRESS_CLASSES = /* @__PURE__ */ new Set(["repository_write", "test_execute", "build_execute", "git_commit"]);
var EMPTY_METRICS = {
  toolCalls: 0,
  failedToolCalls: 0,
  maxIdenticalToolCalls: 0,
  repeatedActionGroups: 0,
  maxConsecutiveFailedToolCalls: 0,
  progressBearingActions: 0
};
function sha256(value) {
  return `sha256:${createHash3("sha256").update(value).digest("hex")}`;
}
function parseLive(raw, path) {
  try {
    return { transcript: parseTranscript(raw, path), partial: false };
  } catch (error) {
    if (!/\.(?:jsonl|ndjson)$/i.test(path) || raw.endsWith("\n")) throw error;
    const boundary = raw.lastIndexOf("\n");
    if (boundary < 0 || !raw.slice(0, boundary).trim()) throw error;
    return { transcript: parseTranscript(raw.slice(0, boundary + 1), path), partial: true };
  }
}
function breached(observed, limit) {
  return limit !== void 0 && observed > limit;
}
var RunTelemetryCore = class {
  path;
  transport;
  limits;
  telemetryGraceMs;
  startedAtMs;
  lastProgressAtMs;
  baselineToolCalls = 0;
  baselineTokens = 0;
  baselineSha256;
  expectedDevice;
  expectedInode;
  expectedSize;
  expectedMtimeNs;
  expectedCtimeNs;
  previousBytes;
  capturedChunks = [];
  capturedLength = 0;
  capturedSnapshot = Buffer.alloc(0);
  capturedDirty = false;
  format;
  parseErrorSinceMs;
  partialSinceMs;
  parseErrorSha256;
  parserStatus = "WAITING";
  metrics = EMPTY_METRICS;
  observedTokens;
  completedProgress = /* @__PURE__ */ new Set();
  latestSha256;
  integrityBreach;
  constructor(input) {
    this.path = resolve3(input.path);
    this.transport = input.transport;
    this.limits = input.limits;
    this.telemetryGraceMs = input.telemetryGraceMs;
    this.startedAtMs = input.startedAtMs;
    this.lastProgressAtMs = input.startedAtMs;
    if (this.transport === "external-file" && existsSync(this.path)) this.establishExternalBaseline();
  }
  appendCaptured(bytes) {
    if (this.transport !== "supervisor-captured-stdout") throw new Error("captured bytes require supervisor-captured stdout");
    const total = this.capturedLength + bytes.length;
    if (total > MAX_TRANSCRIPT_BYTES) {
      this.integrityBreach = { code: "TRANSCRIPT_SIZE", observed: total, limit: MAX_TRANSCRIPT_BYTES };
      return this.integrityBreach;
    }
    this.capturedChunks.push(Buffer.from(bytes));
    this.capturedLength = total;
    this.capturedDirty = true;
    return void 0;
  }
  start(startedAtMs) {
    this.startedAtMs = startedAtMs;
    this.lastProgressAtMs = startedAtMs;
    if (this.partialSinceMs !== void 0) this.partialSinceMs = startedAtMs;
    if (this.parseErrorSinceMs !== void 0) this.parseErrorSinceMs = startedAtMs;
  }
  poll(nowMs, enforce = true, terminal = false) {
    if (this.integrityBreach) return { observation: this.observation(nowMs), breach: this.integrityBreach };
    let raw;
    let sourceIsEmpty = false;
    if (this.transport === "supervisor-captured-stdout") {
      if (this.capturedDirty) {
        this.capturedSnapshot = Buffer.concat(this.capturedChunks, this.capturedLength);
        this.capturedDirty = false;
        raw = this.capturedSnapshot;
      }
      sourceIsEmpty = this.capturedLength === 0;
    } else {
      try {
        if (existsSync(this.path)) {
          const linked = lstatSync3(this.path, { bigint: true });
          if (linked.isSymbolicLink() || !linked.isFile()) {
            this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
          } else if (this.expectedDevice !== void 0 && (linked.dev !== this.expectedDevice || linked.ino !== this.expectedInode)) {
            this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
          } else if (linked.size > BigInt(MAX_TRANSCRIPT_BYTES)) {
            this.integrityBreach = { code: "TRANSCRIPT_SIZE", observed: Number(linked.size), limit: MAX_TRANSCRIPT_BYTES };
          } else {
            const unchanged = this.expectedDevice !== void 0 && linked.size === this.expectedSize && linked.mtimeNs === this.expectedMtimeNs && linked.ctimeNs === this.expectedCtimeNs;
            if (!unchanged) {
              const snapshot = readRegularFileSnapshot(this.path, MAX_TRANSCRIPT_BYTES, "live transcript");
              if (this.expectedDevice !== void 0 && (snapshot.device !== this.expectedDevice || snapshot.inode !== this.expectedInode)) {
                this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
              }
              if (!this.integrityBreach && this.previousBytes && (snapshot.bytes.length < this.previousBytes.length || !snapshot.bytes.subarray(0, this.previousBytes.length).equals(this.previousBytes))) {
                this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
              }
              if (!this.integrityBreach) {
                this.rememberSnapshot(snapshot);
                raw = snapshot.bytes;
              }
            }
          }
          sourceIsEmpty = this.previousBytes?.length === 0;
        } else if (this.expectedDevice !== void 0) {
          this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/changed while it was (?:opened|read)/.test(message)) {
          this.parserStatus = "UNREADABLE";
          this.parseErrorSinceMs ??= nowMs;
          this.parseErrorSha256 = sha256(message);
        } else if (error.code !== "ENOENT" || this.expectedDevice !== void 0) {
          this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
          this.parseErrorSha256 = sha256(message);
        }
      }
    }
    if (this.integrityBreach) return { observation: this.observation(nowMs), breach: this.integrityBreach };
    if (raw?.length) this.updateParsed(raw, nowMs);
    else if (sourceIsEmpty) this.parserStatus = "WAITING";
    const breach = enforce ? this.limitBreach(nowMs, terminal) : void 0;
    return { observation: this.observation(nowMs), ...breach ? { breach } : {} };
  }
  establishExternalBaseline() {
    const snapshot = readRegularFileSnapshot(this.path, MAX_TRANSCRIPT_BYTES, "live transcript");
    this.rememberSnapshot(snapshot);
    this.baselineSha256 = sha256(snapshot.bytes);
    if (!snapshot.bytes.length) return;
    const parsed = parseLive(snapshot.bytes.toString("utf8"), this.path);
    const actions = classifyTranscriptActions(parsed.transcript);
    this.baselineToolCalls = actions.length;
    this.baselineTokens = parsed.transcript.usage?.totalTokens ?? 0;
    this.format = parsed.transcript.format;
    this.parserStatus = parsed.partial ? "PARTIAL" : "READY";
    if (parsed.partial) this.partialSinceMs = this.startedAtMs;
  }
  rememberSnapshot(snapshot) {
    this.expectedDevice = snapshot.device;
    this.expectedInode = snapshot.inode;
    this.expectedSize = snapshot.size;
    this.expectedMtimeNs = snapshot.mtimeNs;
    this.expectedCtimeNs = snapshot.ctimeNs;
    this.previousBytes = Buffer.from(snapshot.bytes);
  }
  updateParsed(raw, nowMs) {
    const digest = sha256(raw);
    if (digest === this.latestSha256) return;
    this.latestSha256 = digest;
    try {
      const parsed = parseLive(raw.toString("utf8"), this.path);
      if (this.format && parsed.transcript.format !== this.format) {
        this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
        return;
      }
      this.format = parsed.transcript.format;
      this.parserStatus = parsed.partial ? "PARTIAL" : "READY";
      if (parsed.partial) this.partialSinceMs ??= nowMs;
      else this.partialSinceMs = void 0;
      this.parseErrorSinceMs = void 0;
      this.parseErrorSha256 = void 0;
      const actions = classifyTranscriptActions(parsed.transcript);
      if (actions.length < this.baselineToolCalls) {
        this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: 1, limit: 0 };
        return;
      }
      const runActions = actions.slice(this.baselineToolCalls);
      this.metrics = analyzeTrajectory(runActions);
      const totalTokens = parsed.transcript.usage?.totalTokens;
      if (totalTokens !== void 0 && totalTokens < this.baselineTokens) {
        this.integrityBreach = { code: "TELEMETRY_INTEGRITY", observed: totalTokens, limit: this.baselineTokens };
        return;
      }
      this.observedTokens = totalTokens === void 0 ? void 0 : totalTokens - this.baselineTokens;
      for (const action of runActions) {
        if (!action.completed || action.failed || !action.classes.some((item) => PROGRESS_CLASSES.has(item))) continue;
        const key = `${action.sequence}\0${action.toolCallId}\0${action.identitySha256}`;
        if (this.completedProgress.has(key)) continue;
        this.completedProgress.add(key);
        this.lastProgressAtMs = nowMs;
      }
    } catch (error) {
      this.parserStatus = "UNREADABLE";
      this.parseErrorSinceMs ??= nowMs;
      this.parseErrorSha256 = sha256(error instanceof Error ? error.message : String(error));
    }
  }
  limitBreach(nowMs, terminal) {
    if (this.integrityBreach) return this.integrityBreach;
    if (this.parserStatus === "WAITING" && Object.values(this.limits).some((value) => value !== void 0) && (terminal || nowMs - this.startedAtMs >= this.telemetryGraceMs)) {
      return { code: "TELEMETRY_MISSING", observed: nowMs - this.startedAtMs, limit: this.telemetryGraceMs };
    }
    if (this.parseErrorSinceMs !== void 0 && (terminal || nowMs - this.parseErrorSinceMs >= this.telemetryGraceMs)) {
      return { code: "TELEMETRY_UNREADABLE", observed: nowMs - this.parseErrorSinceMs, limit: this.telemetryGraceMs };
    }
    if (this.partialSinceMs !== void 0 && (terminal || nowMs - this.partialSinceMs >= this.telemetryGraceMs)) {
      return { code: "TELEMETRY_UNREADABLE", observed: nowMs - this.partialSinceMs, limit: this.telemetryGraceMs };
    }
    if (this.limits.maxObservedTokens !== void 0 && this.observedTokens === void 0 && (this.parserStatus === "READY" || this.parserStatus === "PARTIAL") && (terminal || nowMs - this.startedAtMs >= this.telemetryGraceMs)) {
      return { code: "TOKEN_USAGE_UNAVAILABLE", observed: 0, limit: this.limits.maxObservedTokens };
    }
    if (breached(this.metrics.toolCalls, this.limits.maxToolCalls)) {
      return { code: "TOOL_CALL_LIMIT", observed: this.metrics.toolCalls, limit: this.limits.maxToolCalls };
    }
    if (breached(this.metrics.failedToolCalls, this.limits.maxFailedToolCalls)) {
      return { code: "FAILED_TOOL_CALL_LIMIT", observed: this.metrics.failedToolCalls, limit: this.limits.maxFailedToolCalls };
    }
    if (breached(this.metrics.maxIdenticalToolCalls, this.limits.maxIdenticalToolCalls)) {
      return { code: "IDENTICAL_TOOL_CALL_LIMIT", observed: this.metrics.maxIdenticalToolCalls, limit: this.limits.maxIdenticalToolCalls };
    }
    if (breached(this.metrics.maxConsecutiveFailedToolCalls, this.limits.maxConsecutiveFailures)) {
      return { code: "CONSECUTIVE_FAILURE_LIMIT", observed: this.metrics.maxConsecutiveFailedToolCalls, limit: this.limits.maxConsecutiveFailures };
    }
    if (this.observedTokens !== void 0 && breached(this.observedTokens, this.limits.maxObservedTokens)) {
      return { code: "OBSERVED_TOKEN_LIMIT", observed: this.observedTokens, limit: this.limits.maxObservedTokens };
    }
    if (this.limits.noProgressMs !== void 0 && nowMs - this.lastProgressAtMs > this.limits.noProgressMs) {
      return { code: "NO_PROGRESS", observed: nowMs - this.lastProgressAtMs, limit: this.limits.noProgressMs };
    }
    return void 0;
  }
  observation(nowMs) {
    return {
      configured: true,
      authority: "child-controlled",
      transport: this.transport,
      pathSha256: sha256(this.path),
      parserStatus: this.parserStatus,
      ...this.format ? { format: this.format } : {},
      ...this.baselineSha256 ? { baselineSha256: this.baselineSha256 } : {},
      ...this.latestSha256 ? { latestSha256: this.latestSha256 } : {},
      appendOnly: !this.integrityBreach,
      toolCalls: this.metrics.toolCalls,
      failedToolCalls: this.metrics.failedToolCalls,
      maxIdenticalToolCalls: this.metrics.maxIdenticalToolCalls,
      maxConsecutiveFailedToolCalls: this.metrics.maxConsecutiveFailedToolCalls,
      completedProgressActions: this.completedProgress.size,
      ...this.observedTokens !== void 0 ? { observedTokens: this.observedTokens } : {},
      lastProgressElapsedMs: Math.max(0, nowMs - this.lastProgressAtMs),
      ...this.parseErrorSha256 ? { parseErrorSha256: this.parseErrorSha256 } : {}
    };
  }
};

// src/run-telemetry-worker.ts
if (!parentPort) throw new Error("telemetry worker requires a parent message port");
var port = parentPort;
var monitor;
try {
  monitor = new RunTelemetryCore(workerData);
  port.postMessage({ kind: "ready" });
} catch (error) {
  port.postMessage({
    kind: "error",
    message: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
  throw error;
}
port.on("message", (message) => {
  try {
    if (message.kind === "append") {
      monitor.appendCaptured(Buffer.from(message.bytes));
      return;
    }
    if (message.kind === "start") {
      monitor.start(message.startedAtMs);
      return;
    }
    const result = monitor.poll(message.nowMs, message.enforce, message.terminal);
    port.postMessage({ kind: "result", id: message.id, result });
  } catch (error) {
    port.postMessage({
      kind: "error",
      ...message.kind === "poll" ? { id: message.id } : {},
      message: error instanceof Error ? error.message : String(error)
    });
  }
});
