#!/usr/bin/env node

// src/cli.ts
import { createHash as createHash24 } from "node:crypto";
import { execFileSync as execFileSync19 } from "node:child_process";
import { existsSync as existsSync13, mkdirSync as mkdirSync11, readFileSync as readFileSync27, realpathSync as realpathSync15, statSync as statSync10, writeFileSync as writeFileSync10 } from "node:fs";
import { dirname as dirname12, isAbsolute as isAbsolute11, relative as relative14, resolve as resolve27 } from "node:path";
import { fileURLToPath } from "node:url";

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
function safeJson(text4) {
  try {
    return JSON.parse(text4);
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
  const usage5 = [...usageByMessage.values()].reduce((total, item2) => ({
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
      ...usage5,
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
    const [name2, payloadValue] = entry;
    const payload = payloadValue && typeof payloadValue === "object" ? payloadValue : {};
    const explicitId = row.call_id ?? payload.toolCallId;
    const id = explicitId === void 0 || explicitId === null ? void 0 : String(explicitId);
    if (row.subtype === "started") {
      const call = {
        id: id ?? `cursor-${sequence}`,
        name: name2.replace(/ToolCall$/, ""),
        input: serialiseToolValue(payload.args ?? {}),
        timestamp: row.timestamp,
        sequence: sequence++
      };
      toolCalls.push(call);
      byId.set(call.id, call);
    } else if (row.subtype === "completed") {
      const expectedName = name2.replace(/ToolCall$/, "");
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
  const copilotType = (type3) => typeof type3 === "string" && /^(?:assistant|tool|session|user|permission|subagent|skill)\./.test(type3);
  const hasCursorMarker = rows.some((row) => row?.type === "tool_call") || rows.some((row) => row?.type === "system" && row?.subtype === "init") && rows.some((row) => row?.type === "result" && typeof row?.subtype === "string");
  const hasGeminiMarker = rows.some((row) => row?.type === "init" || row?.type === "tool_use" || row?.type === "tool_result");
  const hasCopilotMarker = rows.some((row) => row?.type === "assistant.message" || row?.type === "tool.execution_start");
  const hasCodexMarker = rows.some((row) => row?.type === "session_meta" || row?.type === "response_item");
  const hasClaudeMarker = rows.some((row) => row?.type === "assistant" && Array.isArray(row?.message?.content));
  const format = hasGeminiMarker ? "gemini-cli" : hasCopilotMarker ? "github-copilot-cli" : hasCodexMarker ? "codex" : hasCursorMarker ? "cursor" : hasClaudeMarker ? "claude-code" : void 0;
  if (!format) throw new Error("unrecognized JSONL transcript schema");
  const accepted = format === "cursor" ? (type3) => cursorTypes.has(String(type3)) : format === "gemini-cli" ? (type3) => geminiTypes.has(String(type3)) : format === "github-copilot-cli" ? copilotType : format === "codex" ? (type3) => codexTypes.has(String(type3)) : (type3) => claudeTypes.has(String(type3));
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
function snippet(text4, at) {
  return text4.slice(Math.max(0, at - 45), at + 100).replace(/\s+/g, " ").trim();
}

// src/detectors/reality.ts
import { execFileSync as execFileSync2, spawnSync } from "node:child_process";
import { existsSync as existsSync2, readFileSync as readFileSync3, realpathSync as realpathSync2 } from "node:fs";
import { isAbsolute, relative, resolve as resolve2, sep as sep2 } from "node:path";

// src/detectors/agentic.ts
import { createHash as createHash2 } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync as readFileSync2, realpathSync, statSync as statSync2 } from "node:fs";
import { resolve, sep } from "node:path";
var MAX_FILE_BYTES = 1024 * 1024;
function gitOptional(repo, args) {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 34 * 1024 * 1024
    });
  } catch {
    return void 0;
  }
}
function finding(subject, evidence, ruleId) {
  return {
    claim: { kind: "integrity", quote: "automatic agent-authored-change check", subject },
    verdict: "contradicted",
    evidence,
    ruleId,
    contributesToPass: false
  };
}
function isTestPath(path) {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)|(^|\/)test_[^/]+\.[^.]+$|(?:\.test|\.spec|\.cy|_test)\.[^.]+$/i.test(path);
}
function isGeneratedOrVendorPath(path) {
  return /^(?:node_modules|vendor|dist|build|coverage|\.git)\//.test(path);
}
function isInstructionPath(path) {
  return /(?:^|\/)(?:AGENTS|CLAUDE|GEMINI)\.md$/i.test(path) || /(?:^|\/)\.cursorrules$/i.test(path) || /(?:^|\/)\.github\/copilot-instructions\.md$/i.test(path);
}
function isDocumentationPath(path) {
  return /^(?:docs?|examples?)\//i.test(path) || /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING|SECURITY|LICENSE)(?:\.[^/]*)?$/i.test(path) || /\.(?:md|mdx|rst|txt)$/i.test(path);
}
function isSourcePath(path) {
  return /\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|kts|go|rs|swift|cs|c|cc|cpp|h|hpp)$/i.test(path) && !isTestPath(path) && !isGeneratedOrVendorPath(path);
}
function isDetectorPatternLine(line) {
  return line.includes("vigil:detector-pattern");
}
function safeWorktreePath(repo, path) {
  const root = resolve(repo);
  const candidate = resolve(root, path);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return void 0;
  if (!existsSync(candidate)) return void 0;
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) return void 0;
    if (statSync2(candidate).size > MAX_FILE_BYTES) return void 0;
    return candidate;
  } catch {
    return void 0;
  }
}
function readRefFile(repo, ref, path) {
  if (path.includes(":")) return void 0;
  if (ref === "WORKTREE") {
    const candidate = safeWorktreePath(repo, path);
    if (!candidate) return void 0;
    try {
      return readFileSync2(candidate, "utf8");
    } catch {
      return void 0;
    }
  }
  const sizeText = gitOptional(repo, ["cat-file", "-s", `${ref}:${path}`]);
  const size = Number(sizeText?.trim());
  if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) return void 0;
  return gitOptional(repo, ["show", `${ref}:${path}`]);
}
function dangerousUnicodeFinding(patch) {
  const bidiOrTag = /[\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;
  for (let index = 0; index < patch.added.length; index++) {
    const line = patch.added[index];
    if (isDetectorPatternLine(line)) continue;
    if (bidiOrTag.test(line)) {
      return finding(
        "hidden Unicode control added",
        `${patch.path}, changed line ${index + 1}: a bidirectional or tag control character was added; the character is intentionally omitted from this receipt`,
        "render-gate"
      );
    }
  }
  return void 0;
}
function hiddenUnicodeAdvisory(patch) {
  const hidden = /[\u200B\u200C\u200D\u200E\u200F\u2060\uFEFF\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
  for (let index = 0; index < patch.added.length; index++) {
    const line = patch.added[index];
    if (isDetectorPatternLine(line)) continue;
    if (hidden.test(line)) {
      return finding(
        "invisible or rendering-sensitive Unicode added",
        `${patch.path}, changed line ${index + 1}: a zero-width, direction-mark, or variation-selector character was added; review the raw bytes. The character is intentionally omitted from this receipt`,
        "render-gate-hidden-character"
      );
    }
  }
  return void 0;
}
function mixedScriptFinding(patch) {
  const identifier2 = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
  for (let lineIndex = 0; lineIndex < patch.added.length; lineIndex++) {
    const line = patch.added[lineIndex];
    if (isDetectorPatternLine(line)) continue;
    for (const match of line.matchAll(identifier2)) {
      const token = match[0];
      const latin = new RegExp("\\p{Script=Latin}", "u").test(token);
      const cyrillic = new RegExp("\\p{Script=Cyrillic}", "u").test(token);
      const greek = new RegExp("\\p{Script=Greek}", "u").test(token);
      if (Number(latin) + Number(cyrillic) + Number(greek) > 1) {
        return finding(
          "mixed-script token added",
          `${patch.path}, changed line ${lineIndex + 1}: one identifier-like token mixes Latin, Cyrillic, or Greek characters; inspect the spelling before accepting it`,
          "render-gate-mixed-script"
        );
      }
    }
  }
  return void 0;
}
function oracleFalsifyFinding(patch) {
  if (!isTestPath(patch.path)) return void 0;
  const added = patch.added.filter((line) => !isDetectorPatternLine(line)).join("\n");
  const swallowedPythonAssertion = /try\s*:[\s\S]{0,1200}\bassert\b[\s\S]{0,1200}except\s+AssertionError\s*:\s*(?:pass|\.\.\.)/m;
  const swallowedJavaScriptAssertion = /try\s*\{[\s\S]{0,1200}\b(?:expect|assert)\b[\s\S]{0,1200}\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}/m;
  const unreachableAssertion = /\bif\s*(?:\(\s*(?:false|0)\s*\)|(?:False|0)\s*:)[\s\S]{0,1000}\b(?:expect|assert)\b/m;
  if (swallowedPythonAssertion.test(added) || swallowedJavaScriptAssertion.test(added)) {
    return finding(
      "test assertion failure is swallowed",
      `${patch.path}: a changed test catches and discards its own assertion failure`,
      "oracle-falsify"
    );
  }
  if (unreachableAssertion.test(added)) {
    return finding(
      "test assertion is statically unreachable",
      `${patch.path}: a changed test places an assertion under a constant-false branch`,
      "oracle-falsify"
    );
  }
  return void 0;
}
function ghostLoaderFinding(patch) {
  const path = patch.path.toLowerCase();
  const added = patch.added.filter((line) => !isDetectorPatternLine(line)).join("\n");
  if (/(?:^|\/)conftest\.py$/.test(path) && /pytest_collection_modifyitems/.test(added) && /(?:items\s*\[:\]\s*=|items\.remove\s*\(|\bitems\s*=\s*\[|deselected|pytest_deselected)/.test(added)) {
    return finding(
      "test discovery filter added",
      `${patch.path}: the changed pytest collection hook can remove collected tests`,
      "ghost-loader"
    );
  }
  if (/(?:pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini)$/.test(path) && /(?:addopts|pytest\.ini_options)[\s\S]{0,800}(?:--deselect|--ignore(?:=|\s)|(?:^|\s)-k(?:\s|=)|-p\s+no:|--continue-on-collection-errors)/m.test(added)) {
    return finding(
      "test discovery exclusion added",
      `${patch.path}: changed pytest options can omit tests from collection or continue after collection errors`,
      "ghost-loader"
    );
  }
  return void 0;
}
function harnessGuardFinding(patch) {
  if (isGeneratedOrVendorPath(patch.path) || isDocumentationPath(patch.path)) return void 0;
  for (let index = 0; index < patch.added.length; index++) {
    const line = patch.added[index];
    if (isDetectorPatternLine(line)) continue;
    if (/\bcontinue-on-error\s*:\s*true\b|\bset\s+\+e\b|\bif\s*:\s*false\b/i.test(line)) {
      return finding(
        "verification harness made non-blocking",
        `${patch.path}, changed line ${index + 1}: the harness can ignore a failed step or disable it outright`,
        "verification-bypass"
      );
    }
  }
  return void 0;
}
function suppressionReceiptFinding(patch) {
  if (isGeneratedOrVendorPath(patch.path) || isDocumentationPath(patch.path)) return void 0;
  for (let index = 0; index < patch.added.length; index++) {
    const line = patch.added[index];
    if (isDetectorPatternLine(line)) continue;
    if (/\bas\s+any\b|\/\/\s*nolint\b|@SuppressWarnings\b|#\s*pragma\s+warning\s+disable\b|#\s*rubocop\s*:\s*disable\b|#\s*pyright\s*:\s*ignore\b/i.test(line)) {
      return finding(
        "compiler, linter, or type suppression added",
        `${patch.path}, changed line ${index + 1}: a new diagnostic suppression requires review`,
        "suppression-added"
      );
    }
  }
  return void 0;
}
function checkAgenticPatches(patches) {
  const results = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (patch, result5) => {
    if (!result5) return;
    const key = `${patch.path}:${result5.ruleId ?? result5.claim.subject}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(result5);
  };
  for (const patch of patches) {
    if (isGeneratedOrVendorPath(patch.path)) continue;
    if (isSourcePath(patch.path) || isInstructionPath(patch.path)) {
      add(patch, dangerousUnicodeFinding(patch));
      add(patch, hiddenUnicodeAdvisory(patch));
      add(patch, mixedScriptFinding(patch));
    }
    for (const check of [oracleFalsifyFinding, ghostLoaderFinding, harnessGuardFinding, suppressionReceiptFinding]) {
      add(patch, check(patch));
    }
  }
  return results;
}
function distinctiveReturnLiterals(patches) {
  const candidates = [];
  const literalPattern = /\breturn\s+(?<literal>(?:["'][^"'\n]{6,80}["'])|(?:-?\d+(?:\.\d+)?))\s*[;,]?\s*(?:\/\/.*|#.*)?$/;
  for (const patch of patches.filter((item2) => isSourcePath(item2.path))) {
    for (let index = 0; index < patch.added.length; index++) {
      const raw = patch.added[index].match(literalPattern)?.groups?.literal;
      if (!raw) continue;
      const unquoted = /^["']/.test(raw) ? raw.slice(1, -1) : raw;
      const numeric = Number(unquoted);
      if (Number.isFinite(numeric)) {
        if (Math.abs(numeric) < 1e4 || numeric % 1e3 === 0) continue;
      } else if (/^(?:success|failure|unknown|default|example|test value|not found)$/i.test(unquoted)) {
        continue;
      }
      candidates.push({
        raw,
        digest: createHash2("sha256").update(raw).digest("hex").slice(0, 12),
        path: patch.path,
        changedLine: index + 1
      });
    }
  }
  return candidates;
}
function grepRefPaths(repo, ref, needle) {
  const args = ref === "WORKTREE" ? ["grep", "-l", "-z", "-F", "-e", needle, "--"] : ["grep", "-l", "-z", "-F", "-e", needle, ref, "--"];
  const raw = gitOptional(repo, args) ?? "";
  const prefix = ref === "WORKTREE" ? "" : `${ref}:`;
  return raw.split("\0").filter(Boolean).map((path) => prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path).filter((path) => path && !path.includes(":")).slice(0, 500);
}
function unchangedAssertion(repo, ref, changed, needle) {
  for (const path of grepRefPaths(repo, ref, needle).filter((item2) => isTestPath(item2) && !changed.has(item2))) {
    const content = readRefFile(repo, ref, path);
    if (content === void 0) continue;
    const lineIndex = content.split("\n").findIndex((line) => line.includes(needle) && /\b(?:expect|assert|should)\b/i.test(line));
    if (lineIndex >= 0) return `${path}:${lineIndex + 1}`;
  }
  return void 0;
}
function oracleEchoChecks(repo, base, head, changed, patches) {
  if ([...changed].some(isTestPath)) return [];
  const candidates = distinctiveReturnLiterals(patches);
  if (!candidates.length) return [];
  const results = [];
  for (const candidate of candidates.slice(0, 20)) {
    if (grepRefPaths(repo, base, candidate.raw).some(isSourcePath)) continue;
    const assertion = unchangedAssertion(repo, head, changed, candidate.raw);
    if (!assertion) continue;
    results.push(finding(
      "implementation echoes a pre-existing test oracle",
      `${candidate.path}, changed line ${candidate.changedLine}, directly returns literal sha256:${candidate.digest}; unchanged assertion ${assertion} contains the same literal. The literal value is intentionally omitted`,
      "oracle-echo"
    ));
  }
  return results;
}
function dependencyMap(content) {
  if (!content) return /* @__PURE__ */ new Set();
  try {
    const parsed = JSON.parse(content);
    const names = /* @__PURE__ */ new Set();
    for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      const value = parsed[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      for (const name2 of Object.keys(value)) names.add(name2.toLowerCase());
    }
    return names;
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function editDistance(left, right) {
  if (Math.abs(left.length - right.length) > 1) return 2;
  if (left.length === right.length) {
    for (let index = 0; index < left.length - 1; index++) {
      if (left[index] !== right[index] && left[index] === right[index + 1] && left[index + 1] === right[index] && left.slice(0, index) === right.slice(0, index) && left.slice(index + 2) === right.slice(index + 2)) return 1;
    }
  }
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return row[right.length];
}
function addedImportNames(patches) {
  const names = /* @__PURE__ */ new Set();
  const addName = (raw) => {
    if (!raw || raw.startsWith(".") || raw.startsWith("/") || raw.startsWith("node:") || raw.includes("://") || raw.startsWith("@")) return;
    const name2 = raw.split(/[/.]/)[0].toLowerCase().replaceAll("_", "-");
    if (/^[a-z0-9][a-z0-9-]{1,213}$/.test(name2)) names.add(name2);
  };
  for (const patch of patches) {
    for (const line of patch.added) {
      if (isDetectorPatternLine(line)) continue;
      const python = /^(?:\s*)(?:from|import)\s+([A-Za-z_][\w.-]*)/.exec(line)?.[1];
      const javascript = /(?:\bfrom\s*|\brequire\s*\(|\bimport\s*\()\s*["']([^"']+)["']/.exec(line)?.[1];
      const requirement = /(?:^|\/)(?:requirements[^/]*\.txt|constraints[^/]*\.txt)$/i.test(patch.path) ? /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line)?.[1] : void 0;
      for (const raw of [python, javascript, requirement]) addName(raw);
    }
  }
  return names;
}
function freshDependencyChecks(repo, base, head, changed, patches) {
  const added = addedImportNames(patches);
  if (changed.has("package.json")) {
    const before = dependencyMap(readRefFile(repo, base, "package.json"));
    const after = dependencyMap(readRefFile(repo, head, "package.json"));
    for (const name2 of after) {
      if (!before.has(name2) && /^[a-z0-9][a-z0-9-]{1,213}$/.test(name2)) added.add(name2);
    }
  }
  const popular = [
    "aiohttp",
    "anthropic",
    "axios",
    "boto3",
    "certifi",
    "chalk",
    "click",
    "commander",
    "cryptography",
    "django",
    "dotenv",
    "eslint",
    "express",
    "fastapi",
    "flask",
    "httpx",
    "jest",
    "lodash",
    "matplotlib",
    "next",
    "numpy",
    "openai",
    "pandas",
    "pillow",
    "prettier",
    "pydantic",
    "pytest",
    "pyyaml",
    "react",
    "redis",
    "requests",
    "rollup",
    "scipy",
    "selenium",
    "sqlalchemy",
    "svelte",
    "tensorflow",
    "torch",
    "transformers",
    "typescript",
    "urllib3",
    "vite",
    "vue",
    "webpack",
    "yargs",
    "zod"
  ];
  const results = [];
  for (const name2 of added) {
    const neighbor = popular.find((known) => known !== name2 && editDistance(known, name2) === 1);
    if (!neighbor) continue;
    results.push(finding(
      "new import or dependency resembles a common package name",
      `${name2} is newly imported or declared and is one edit from ${neighbor}; this offline check does not claim the package is malicious or verify registry ownership`,
      "fresh-dep"
    ));
  }
  return results;
}
function coverageFloor(content) {
  if (!content) return void 0;
  const values = [
    ...[...content.matchAll(/--(?:cov-)?fail-under(?:=|\s+)(\d+(?:\.\d+)?)/gi)].map((match) => Number(match[1])),
    ...[...content.matchAll(/minimum[_-]?coverage\s*[:=]\s*(\d+(?:\.\d+)?)/gi)].map((match) => Number(match[1])),
    ...[...content.matchAll(/coverageThreshold[^\n]{0,160}?(\d+(?:\.\d+)?)/gi)].map((match) => Number(match[1]))
  ].filter(Number.isFinite);
  return values.length ? Math.min(...values) : void 0;
}
function loweredCoverageChecks(repo, base, head, changed) {
  for (const path of changed) {
    if (!/(?:^|\/)(?:package\.json|pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini|.*ya?ml|.*json)$/i.test(path)) continue;
    const before = coverageFloor(readRefFile(repo, base, path));
    const after = coverageFloor(readRefFile(repo, head, path));
    if (before !== void 0 && after !== void 0 && after > 0 && after < before) {
      return [finding(
        "coverage requirement lowered",
        `${path}: the recognized minimum coverage floor fell from ${before} to ${after}`,
        "coverage-weakened"
      )];
    }
  }
  return [];
}
function checkAgenticRepository(repo, base, head, changedPaths2, patches) {
  const changed = new Set(changedPaths2);
  return [
    ...oracleEchoChecks(repo, base, head, changed, patches),
    ...freshDependencyChecks(repo, base, head, changed, patches),
    ...loweredCoverageChecks(repo, base, head, changed)
  ];
}
function isAncestor(repo, commit2, ref) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit2, ref], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function checkOutOfDagReads(repo, base, head, toolCalls) {
  const findings = [];
  const seen = /* @__PURE__ */ new Set();
  for (const call of toolCalls) {
    if (!/\bgit\s+(?:show|diff|cat-file|checkout|cherry-pick|log)\b/i.test(call.input)) continue;
    for (const match of call.input.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
      const supplied = match[0];
      const commit2 = gitOptional(repo, ["rev-parse", "--verify", `${supplied}^{commit}`])?.trim();
      if (!commit2 || seen.has(commit2)) continue;
      seen.add(commit2);
      if (isAncestor(repo, commit2, base)) continue;
      if (head !== "WORKTREE" && isAncestor(repo, commit2, head)) continue;
      findings.push(finding(
        "out-of-change-history commit was read",
        `tool call ${call.sequence + 1} references ${commit2.slice(0, 12)}, which is outside the selected base-to-head history. Retrieval is observed; origin, copying, and causation are not inferred`,
        "leak-gate"
      ));
    }
  }
  return findings;
}

// src/detectors/reality.ts
function gitOptional2(repo, args) {
  try {
    return execFileSync2("git", args, {
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
  return gitOptional2(repo, args) ?? "";
}
function gitRefExists(repo, ref) {
  try {
    execFileSync2("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repo, stdio: "ignore" });
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
    const value = isAbsolute(path) ? relative(resolve2(repo), resolve2(path)) : path;
    if (!value || value === ".." || value.startsWith(`..${sep2}`)) return "";
    return value.replaceAll("\\", "/").replace(/^\.\//, "");
  }).filter(Boolean));
  const selected = gitOptional2(repo, ["rev-parse", "--verify", `${head}^{commit}`])?.trim();
  const checkedOut = gitOptional2(repo, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
  const raw = gitOptional2(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"]);
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
    const value = isAbsolute(path) ? relative(resolve2(repo), resolve2(path)) : path;
    if (!value || value === ".." || value.startsWith(`..${sep2}`)) return "";
    return value.replaceAll("\\", "/").replace(/^\.\//, "");
  }).filter(Boolean));
  if (expectedHead && expectedHead !== "WORKTREE") {
    const selected = gitOptional2(repo, ["rev-parse", "--verify", `${expectedHead}^{commit}`])?.trim();
    const checkedOut = gitOptional2(repo, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
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
  const raw = gitOptional2(repo, ["diff", "HEAD", "--name-only", "-z"]);
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
  const root = resolve2(repo);
  const candidate = resolve2(root, subject);
  return candidate === root || candidate.startsWith(`${root}${sep2}`) ? candidate : null;
}
function existingPathStaysInsideRepo(repo, candidate) {
  if (!existsSync2(candidate)) return false;
  try {
    const root = realpathSync2(repo);
    const target2 = realpathSync2(candidate);
    const fromRoot = relative(root, target2);
    return fromRoot === "" || !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep2}`);
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
    const exists = existsSync2(candidate);
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
      const name2 = row.Test;
      if ((action === "pass" || action === "fail" || action === "skip") && typeof name2 === "string" && !name2.includes("/")) {
        goTests.set(`${String(row.Package ?? "")}:${name2}`, action);
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
function inferTestCommand(repo, platform3 = process.platform) {
  const pkg = resolve2(repo, "package.json");
  if (existsSync2(pkg)) {
    try {
      const script = JSON.parse(readFileSync3(pkg, "utf8"))?.scripts?.test;
      if (script && !/no test specified/i.test(script)) return "npm test --silent";
    } catch {
    }
  }
  if (existsSync2(resolve2(repo, "pytest.ini")) || existsSync2(resolve2(repo, "pyproject.toml"))) return "python3 -m pytest -q";
  if (existsSync2(resolve2(repo, "Cargo.toml"))) return "cargo test --quiet";
  if (existsSync2(resolve2(repo, "go.mod"))) return "go test -json ./...";
  if (existsSync2(resolve2(repo, "pom.xml"))) return "mvn test";
  if (platform3 === "win32" && existsSync2(resolve2(repo, "gradlew.bat"))) return "gradlew.bat test";
  if (existsSync2(resolve2(repo, "gradlew"))) return "./gradlew test";
  if (existsSync2(resolve2(repo, "build.gradle")) || existsSync2(resolve2(repo, "build.gradle.kts"))) return "gradle test";
  if (existsSync2(resolve2(repo, "Gemfile")) && existsSync2(resolve2(repo, "spec"))) return "bundle exec rspec";
  if (existsSync2(resolve2(repo, "composer.json"))) return "./vendor/bin/phpunit";
  if (existsSync2(resolve2(repo, "global.json")) || existsSync2(resolve2(repo, "Directory.Build.props"))) return "dotnet test";
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
function isTestPath2(path) {
  if (isGeneratedOrVendorPath2(path)) return false;
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)|(^|\/)test_[^/]+\.[^.]+$|(?:\.test|\.spec|\.cy|_test)\.[^.]+$/i.test(path);
}
function isGeneratedOrVendorPath2(path) {
  return /^(?:node_modules|vendor|dist|build|coverage|\.git)\//.test(path);
}
function isDocumentationPath2(path) {
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
  return patches.filter((patch) => patch.path && !isGeneratedOrVendorPath2(patch.path));
}
function untrackedFilePatches(repo) {
  const paths = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const patches = [];
  for (const path of paths) {
    if (isGeneratedOrVendorPath2(path)) continue;
    const candidate = withinRepo(repo, path);
    if (!candidate || !existingPathStaysInsideRepo(repo, candidate)) continue;
    try {
      const content = readFileSync3(candidate);
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
  const finding3 = (subject, evidence, ruleId) => ({
    claim: { kind: "integrity", quote: "automatic anti-reward-hacking check", subject },
    verdict: "contradicted",
    evidence,
    ruleId,
    contributesToPass: false
  });
  let baselineTests = 0;
  let headTests = 0;
  const deletedTestFiles = [];
  for (const path of paths.filter(isTestPath2)) {
    const before = gitShow(repo, base, path);
    const after = head === "WORKTREE" ? existsSync2(resolve2(repo, path)) ? readFileSync3(resolve2(repo, path), "utf8") : "" : gitShow(repo, head, path);
    const oldCount = countTests(before);
    const newCount = countTests(after);
    baselineTests += oldCount;
    headTests += newCount;
    if (before && !after) deletedTestFiles.push(path);
  }
  if (headTests < baselineTests) {
    results.push(finding3("test surface shrank", `recognized test definitions across changed test files fell from ${baselineTests} to ${headTests}`, "test-count-drop"));
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
  results.push(...checkAgenticPatches(patches));
  results.push(...checkAgenticRepository(repo, base, head, paths, patches));
  if (!results.length) {
    results.push(cleanIntegrityResult(paths.length));
  }
  return results;
}
function finding2(subject, evidence, ruleId) {
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
    ["focused or skipped test introduced", /\b(?:test|it|describe)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe)\s*\(|@pytest\.mark\.skip|@unittest\.skip\s*\(|#\[ignore\]|\bt\.Skip(?:Now|f)?\s*\(|@Disabled\b|\[(?:Ignore|Explicit)\b[^\]]*\]/i, "test-skip-added", (patch) => isTestPath2(patch.path)],
    // vigil:detector-pattern
    ["verification bypass introduced", /--no-verify|\|\|\s*true\b|passWithNoTests|allowEmptyTests/i, "verification-bypass", (patch) => !isDocumentationPath2(patch.path)],
    // vigil:detector-pattern
    ["compiler or linter suppression introduced", /@ts-nocheck|@ts-ignore|@ts-expect-error|eslint-disable|type:\s*ignore|noqa\b/i, "suppression-added", (patch) => !isDocumentationPath2(patch.path)],
    // vigil:detector-pattern
    ["coverage gate weakened", /coverageThreshold\s*[:=]\s*0|--fail-under[=\s]+0|minimum_coverage\s*[:=]\s*0/i, "coverage-weakened", (patch) => !isDocumentationPath2(patch.path)],
    // vigil:detector-pattern
    ["statically unreachable branch introduced", /\bif\s*\(\s*(?:false|0)\s*\)/i, "dead-branch-added", (patch) => !isDocumentationPath2(patch.path)]
    // vigil:detector-pattern
  ];
  for (const [subject, regex, ruleId, inScope] of checks) {
    const line = patches.filter(inScope).flatMap((patch) => patch.added).find((candidate) => !candidate.includes("vigil:detector-pattern") && regex.test(candidate));
    if (line) results.push(finding2(subject, line.trim().slice(0, 220), ruleId));
  }
  const implementationPatches = patches.filter((patch) => !isDocumentationPath2(patch.path));
  const changedLines = implementationPatches.flatMap((patch) => [...patch.added, ...patch.removed]);
  if (changedLines.length > 0 && implementationPatches.some((patch) => patch.added.some((line) => isStandaloneCommentLine(line) && line.trim() !== "")) && changedLines.every(isStandaloneCommentLine)) {
    results.push(finding2(
      "implementation change contains comments but no executable change",
      `${implementationPatches.map((patch) => patch.path).join(", ")}: only comment or blank lines changed`,
      "comment-only-change"
    ));
  }
  for (const patch of patches.filter((candidate) => !isDocumentationPath2(candidate.path))) {
    const added = patch.added.filter((line) => !line.includes("vigil:detector-pattern")).join("\n");
    const removed = patch.removed.join("\n");
    if (/\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/s.test(added)) {
      results.push(finding2("error path swallowed by an empty catch", `${patch.path} adds an empty catch block`, "error-swallowed"));
    }
    if (/\bthrow\s+[A-Za-z_$][\w$]*\s*;/.test(removed) && /\bthrow\s+new\s+Error\s*\(/.test(added) && !/\bcause\b/.test(added)) {
      results.push(finding2("exception context discarded", `${patch.path} replaces rethrowing the caught value with a new Error without a cause`, "exception-context-lost"));
    }
    const declarationPattern = /\b(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
    const removedNames = [...removed.matchAll(declarationPattern)].map((match) => match[1]);
    const addedNames = new Set([...added.matchAll(declarationPattern)].map((match) => match[1]));
    const candidateText = [...patch.added, ...patch.context].join("\n");
    for (const oldName of removedNames) {
      if (addedNames.has(oldName)) continue;
      const oldReference = new RegExp(`\\b${oldName.replace(/[$]/g, "\\$")}\\s*\\(`);
      if (oldReference.test(candidateText)) {
        results.push(finding2("removed or renamed symbol leaves an old caller", `${patch.path} removes the declaration of ${oldName} while ${oldName} is still called`, "stale-refactor-caller"));
        break;
      }
    }
    if (isTestPath2(patch.path)) {
      if (/\b(?:it|test)\s*\([^,]+,\s*(?:async\s*)?\(?(?:[^)=]*)\)?\s*=>\s*\{\s*\}\s*\)/s.test(added) || /\b(?:it|test)\s*\([^,]+,\s*function\s*\([^)]*\)\s*\{\s*\}\s*\)/s.test(added) || /\bdef\s+test_[A-Za-z0-9_]+\s*\([^)]*\)\s*:\s*pass\b/s.test(added) || /#\[test\]\s*(?:pub\s+)?fn\s+[A-Za-z0-9_]+\s*\([^)]*\)\s*\{\s*\}/s.test(added) || /\bfunc\s+Test[A-Za-z0-9_]+\s*\([^)]*\)\s*\{\s*\}/s.test(added) || /@Test\b[\s\S]*?\bvoid\s+[A-Za-z0-9_]+\s*\([^)]*\)\s*\{\s*\}/s.test(added) || /\[(?:TestMethod|Test|Fact|Theory)\b[^\]]*\][\s\S]*?\bvoid\s+[A-Za-z0-9_]+\s*\([^)]*\)\s*\{\s*\}/s.test(added)) {
        results.push(finding2("empty test introduced", `${patch.path} adds a test body with no observable assertion or behavior`, "test-empty-added"));
      }
      if (/\bexpect\s*\(\s*(true|false|null|undefined|["'][^"']*["']|\d+)\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\s*\(\s*\1\s*\)/s.test(added) || /\bassert(?:\.ok)?\s*\(\s*true\s*\)/.test(added) || /\bassert\.(?:equal|strictEqual)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*\1\s*\)/.test(added) || /\bassert\s+True\b/.test(added) || /\b(?:assertTrue|Assert\.True)\s*\(\s*true\s*\)/.test(added) || /\bassertEqual\s*\(\s*([A-Za-z_][\w]*)\s*,\s*\1\s*\)/.test(added) || /\bassert_eq!\s*\(\s*([A-Za-z_][\w]*)\s*,\s*\1\s*\)/.test(added) || /\b(?:assertEquals|Assert\.Equal)\s*\(\s*([A-Za-z_][\w]*)\s*,\s*\1\s*\)/.test(added)) {
        results.push(finding2("constant or self-equal test oracle introduced", `${patch.path} adds an assertion that is true without exercising the candidate behavior`, "test-oracle-constant"));
      }
      if (/\b(?:page\.)?evaluate\s*\(|\baddInitScript\s*\(|\bevaluateOnNewDocument\s*\(/.test(added) && /\b(?:document\.|window\.|localStorage\.|sessionStorage\.|Object\.defineProperty)/.test(added)) {
        results.push(finding2("browser test mutates runtime state before judging behavior", `${patch.path} adds browser-side state mutation inside an evaluation hook; review whether the test repairs the application it is meant to test`, "test-runtime-patch"));
      }
      if (/\b(?:istanbul|c8)\s+ignore\b|#\s*pragma:\s*no\s*cover\b|\[ExcludeFromCodeCoverage\]/i.test(added)) {
        results.push(finding2("coverage exclusion introduced", `${patch.path} adds a coverage exclusion marker`, "coverage-exclusion-added"));
      }
      const removedStrict = /\.(?:toBe|toEqual|toStrictEqual)\s*\(|\b(?:assertEqual|assertStrictEqual)\s*\(/.test(removed);
      const addedLoose = /\.(?:toBeTruthy|toBeDefined|toBeGreaterThan|toBeGreaterThanOrEqual|toContain)\s*\(|\bassert\s*\(/.test(added);
      if (removedStrict && addedLoose) {
        results.push(finding2("test assertion relaxed", `${patch.path} replaces an exact assertion with a weaker predicate`, "test-assertion-relaxed"));
      }
      if (/\b(?:jest|vi)\.fn\s*\(\s*\)\s*\.mock(?:ReturnValue|Implementation)/.test(added)) {
        results.push(finding2("test replaces the subject with a self-fulfilling mock", `${patch.path} adds a value-producing local mock in the assertion path`, "subject-mocked"));
      }
      const removedHunkAssertions = patch.removed.filter((line) => /\b(?:expect|assert|should)\b/i.test(line)).length;
      const addedHunkAssertions = patch.added.filter((line) => /\b(?:expect|assert|should)\b/i.test(line)).length;
      if (removedHunkAssertions > addedHunkAssertions && !results.some((result5) => result5.ruleId === "assertion-drop")) {
        results.push(finding2("assertion surface shrank", `${patch.path} hunk removes ${removedHunkAssertions} assertion-like line(s) and adds ${addedHunkAssertions}`, "assertion-drop"));
      }
    }
    const removedCode = patch.removed.map(normalizedCodeLine).filter(Boolean);
    const addedCode = patch.added.map(normalizedCodeLine).filter(Boolean);
    if (removedCode.length === 1 && addedCode.length === 1 && removedCode[0] === addedCode[0] && patch.removed[0] !== patch.added[0]) {
      results.push(finding2("code change is behaviorally empty after comment and whitespace normalization", `${patch.path}: ${patch.added[0].trim().slice(0, 180)}`, "no-op-code-change"));
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
        results.push(finding2("removed or renamed symbol leaves an old caller", `${patch.path} removes ${oldName} while another changed-file context still calls it`, "stale-refactor-caller"));
      }
    }
  }
  const testPatches = patches.filter((patch) => isTestPath2(patch.path));
  const removedTests = testPatches.flatMap((patch) => patch.removed).filter((line) => countTests(line) > 0).length;
  const addedTests = testPatches.flatMap((patch) => patch.added).filter((line) => countTests(line) > 0).length;
  if (removedTests > addedTests) {
    results.push(finding2("test surface shrank", `${removedTests} test definitions removed and ${addedTests} added in the supplied diff`, "test-count-drop"));
  }
  const removedAssertions = testPatches.flatMap((patch) => patch.removed).filter((line) => /\b(?:expect|assert|should)\b/i.test(line)).length;
  const addedAssertions = testPatches.flatMap((patch) => patch.added).filter((line) => !line.includes("vigil:detector-pattern") && /\b(?:expect|assert|should)\b/i.test(line)).length;
  if (removedAssertions > addedAssertions && !results.some((result5) => result5.ruleId === "assertion-drop")) {
    results.push(finding2(
      "assertion surface shrank",
      `${removedAssertions} assertion-like lines removed and ${addedAssertions} added`,
      "assertion-drop"
    ));
  }
  if (testPatches.length === patches.length && results.some((result5) => result5.ruleId === "test-assertion-relaxed") && !results.some((result5) => result5.ruleId === "no-op-code-change")) {
    results.push(finding2(
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
  const results = [...checkIntegrityPatches(patches), ...checkAgenticPatches(patches)];
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
import { createHash as createHash3 } from "node:crypto";
var VERSION = "0.19.0";
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
  const count3 = (verdict) => input.results.filter((r) => r.verdict === verdict).length;
  const contradicted = count3("contradicted");
  const unverifiable = count3("unverifiable");
  const meaningfulVerified = input.results.filter(
    (r) => r.verdict === "verified" && r.contributesToPass !== false
  ).length;
  let status;
  if (contradicted > 0) status = "FAIL";
  else if (meaningfulVerified < policy.minVerified || input.results.some((result5) => result5.verdict === "unverifiable" && result5.blocksPass) || policy.strict && unverifiable > 0) status = "INCONCLUSIVE";
  else status = "PASS";
  const summary = {
    verified: count3("verified"),
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
    receiptHash: `sha256:${createHash3("sha256").update(canonical(receiptPayload2)).digest("hex")}`,
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
  return `sha256:${createHash3("sha256").update(canonical(payload)).digest("hex")}`;
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
  readFileSync as readFileSync4,
  realpathSync as realpathSync3,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, parse, resolve as resolve3, sep as sep3 } from "node:path";
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
  const components = parent.slice(root.length).split(sep3).filter(Boolean);
  for (const [index, component] of components.entries()) {
    const next = join(current, component);
    const status = lstatSync(next);
    if (status.isSymbolicLink()) {
      const trustedRootAlias = index === 0 && status.uid === rootStatus.uid && (rootStatus.mode & 18) === 0;
      if (!trustedRootAlias) {
        throw new Error(`Refusing to traverse symbolic-link output parent: ${next}`);
      }
      const canonical3 = realpathSync3(next);
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
    return readFileSync4(descriptor, "utf8");
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
  const requested = resolve3(destination);
  const parent = resolveSafeParent(requested);
  const target2 = join(parent, basename(requested));
  assertReplaceableDestination(target2);
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
    assertReplaceableDestination(target2);
    renameSync(temporaryPath, target2);
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
function writePrivateFileExclusive(destination, content) {
  const requested = resolve3(destination);
  const parent = resolveSafeParent(requested);
  const target2 = join(parent, basename(requested));
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let descriptor;
  let failure;
  try {
    descriptor = openSync(
      target2,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      384
    );
    fchmodSync(descriptor, 384);
    writeFileSync(descriptor, Buffer.from(content, "utf8"));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = void 0;
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
  }
  if (failure !== void 0) throw failure;
}
function appendPrivateFileAtomic(destination, content) {
  const requested = resolve3(destination);
  const parent = resolveSafeParent(requested);
  const target2 = join(parent, basename(requested));
  const existing = readRegularFileWithoutFollowingReplacement(target2);
  writePrivateFileAtomic(target2, `${existing}${content}`);
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
import { execFileSync as execFileSync3 } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
function git2(repo, ...args) {
  execFileSync3("git", args, { cwd: repo, stdio: "ignore" });
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
  const count3 = join2(evidence, "false-count.md");
  const ghost = join2(evidence, "ghost-file.md");
  const loop = join2(evidence, "tool-loop.jsonl");
  writeFileSync2(count3, "All 99 tests pass.\n");
  writeFileSync2(ghost, "I created src/ghost.ts. The work is complete.\n");
  const rows = [
    { type: "assistant", message: { content: [{ type: "text", text: "The test suite passes." }] } },
    ...["a", "b", "c"].map((id) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "src/real.ts" } }] } }))
  ];
  writeFileSync2(loop, `${rows.map((row) => JSON.stringify(row)).join("\n")}
`);
  const scenarios = [
    ["claimed 99 tests; runner has 1", count3],
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
import { createHash as createHash4 } from "node:crypto";
import { execFileSync as execFileSync4 } from "node:child_process";
import { existsSync as existsSync3, readFileSync as readFileSync5 } from "node:fs";
import { isAbsolute as isAbsolute2, normalize, resolve as resolve4, win32 } from "node:path";
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
  const allowed2 = /* @__PURE__ */ new Set(["schemaVersion", "integrityMode", "transcript", "testCommand", "strict", "minVerified", "trustedSignerKeyIds", "portableReceipt", "maintainer"]);
  const unknown = Object.keys(value).filter((key) => !allowed2.has(key));
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
  const allowed2 = /* @__PURE__ */ new Set([
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
  const unknown = Object.keys(value).filter((key) => !allowed2.has(key));
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
function parsePolicy(raw, source2) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`policy is not valid JSON: ${source2}`);
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
      raw2 = execFileSync4("git", ["show", `${ref}:${clean}`], {
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
      sha256: `sha256:${createHash4("sha256").update(canonical2(value2)).digest("hex")}`,
      value: value2
    };
  }
  const candidate = requested ? resolve4(repo, requested) : resolve4(repo, DEFAULT_POLICY_FILE);
  if (!existsSync3(candidate)) {
    if (requested) throw new Error(`policy not found: ${candidate}`);
    const value2 = { schemaVersion: 1 };
    return { sha256: `sha256:${createHash4("sha256").update(canonical2(value2)).digest("hex")}`, value: value2 };
  }
  const raw = readFileSync5(candidate, "utf8");
  const value = parsePolicy(raw, candidate);
  return {
    path: candidate,
    sha256: `sha256:${createHash4("sha256").update(canonical2(value)).digest("hex")}`,
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
import { execFileSync as execFileSync7 } from "node:child_process";
import { existsSync as existsSync5, mkdirSync as mkdirSync3, readFileSync as readFileSync8, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname3, relative as relative4, resolve as resolve7 } from "node:path";

// src/authority.ts
import { createHash as createHash5 } from "node:crypto";
import { execFileSync as execFileSync6 } from "node:child_process";
import { isAbsolute as isAbsolute3, normalize as normalize3, relative as relative3, resolve as resolve6, win32 as win322 } from "node:path";
import { readFileSync as readFileSync7, statSync as statSync4 } from "node:fs";

// src/maintainer.ts
import { execFileSync as execFileSync5, spawnSync as spawnSync2 } from "node:child_process";
import { cpSync, existsSync as existsSync4, lstatSync as lstatSync2, mkdirSync as mkdirSync2, mkdtempSync as mkdtempSync2, readFileSync as readFileSync6, rmSync, statSync as statSync3 } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname as dirname2, join as join3, normalize as normalize2, resolve as resolve5, sep as sep4 } from "node:path";
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
  const size = statSync3(path).size;
  if (size > 2 * 1024 * 1024) throw new Error(`pull request event is ${size} bytes; maximum is ${2 * 1024 * 1024}`);
  let event2;
  try {
    event2 = JSON.parse(readFileSync6(path, "utf8"));
  } catch {
    throw new Error(`pull request event is not valid JSON: ${path}`);
  }
  if (!event2?.pull_request || typeof event2.pull_request !== "object") throw new Error("event does not contain a pull_request object");
  const author = event2.pull_request.user?.login;
  const body = event2.pull_request.body;
  if (typeof author !== "string" || !author.trim()) throw new Error("pull request event does not identify the author");
  if (body !== null && body !== void 0 && typeof body !== "string") throw new Error("pull request body must be text");
  return {
    author,
    body: body ?? "",
    ...typeof event2.pull_request.base?.sha === "string" ? { baseSha: event2.pull_request.base.sha } : {},
    ...typeof event2.pull_request.head?.sha === "string" ? { headSha: event2.pull_request.head.sha } : {}
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
    const allowed2 = /* @__PURE__ */ new Set(["none", "assisted", "agent"]);
    out.push(result(
      "policy_attestation",
      "ai-assistance-disclosure",
      "AI assistance disclosure",
      disclosure ?? "missing",
      disclosure !== void 0 && allowed2.has(disclosure) ? "verified" : "contradicted",
      disclosure !== void 0 && allowed2.has(disclosure) ? `declared ${disclosure}` : "use exactly one of: none, assisted, agent"
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
  return execFileSync5("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 }).trim();
}
function globRegex(pattern) {
  let source2 = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        source2 += "(?:.*/)?";
        index += 2;
      } else {
        source2 += ".*";
        index += 1;
      }
    } else if (char === "*") source2 += "[^/]*";
    else if (char === "?") source2 += "[^/]";
    else source2 += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`^${source2}$`);
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
  return clean === ".." || clean.startsWith(`..${sep4}`) || resolve5("/safe", clean) === "/safe";
}
function overlayTests(headWorktree, baseWorktree, paths) {
  for (const path of paths) {
    if (unsafeOverlayPath(path)) return `unsafe overlay path: ${path}`;
    const source2 = resolve5(headWorktree, path);
    const target2 = resolve5(baseWorktree, path);
    if (!source2.startsWith(`${resolve5(headWorktree)}${sep4}`) || !target2.startsWith(`${resolve5(baseWorktree)}${sep4}`)) return `overlay escaped worktree: ${path}`;
    if (!existsSync4(source2)) continue;
    if (lstatSync2(source2).isSymbolicLink()) return `refusing to overlay symlink test path: ${path}`;
    mkdirSync2(dirname2(target2), { recursive: true });
    cpSync(source2, target2, { recursive: true, force: true });
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
    execFileSync5("git", ["worktree", "add", "--detach", candidate, expectedHead], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
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
        execFileSync5("git", ["worktree", "remove", "--force", candidate], { cwd: repo, stdio: "ignore" });
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
    execFileSync5("git", ["worktree", "add", "--detach", baseWorktree, base], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
    baseAdded = true;
    execFileSync5("git", ["worktree", "add", "--detach", headWorktree, head], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
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
        execFileSync5("git", ["worktree", "remove", "--force", headWorktree], { cwd: repo, stdio: "ignore" });
      } catch {
      }
    }
    if (baseAdded) {
      try {
        execFileSync5("git", ["worktree", "remove", "--force", baseWorktree], { cwd: repo, stdio: "ignore" });
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
function parseContract(raw, source2) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`authority contract is not valid JSON: ${source2}`);
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
      raw = execFileSync6("git", ["show", `${ref}:${clean}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: MAX_CONTRACT_BYTES });
    } catch {
      throw new Error(`authority contract not found at ${ref}:${clean}`);
    }
    if (Buffer.byteLength(raw) > MAX_CONTRACT_BYTES) throw new Error(`authority contract exceeds ${MAX_CONTRACT_BYTES} bytes`);
    const value2 = parseContract(raw, `${ref}:${clean}`);
    return { value: value2, sha256: `sha256:${createHash5("sha256").update(canonical(value2)).digest("hex")}`, source: `${clean}@${ref}`, gitPath: clean, ref };
  }
  const path = resolve6(repo, requested);
  const size = statSync4(path).size;
  if (size > MAX_CONTRACT_BYTES) throw new Error(`authority contract is ${size} bytes; maximum is ${MAX_CONTRACT_BYTES}`);
  const value = parseContract(readFileSync7(path, "utf8"), path);
  return { value, sha256: `sha256:${createHash5("sha256").update(canonical(value)).digest("hex")}`, source: relative3(repo, path) || requested, path };
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
  const name2 = call.name.toLowerCase();
  const classes = /* @__PURE__ */ new Set();
  const add = (...items) => items.forEach((item2) => classes.add(item2));
  const command = commandText(call);
  if (command !== void 0) {
    for (const segment of splitShellCommands(command)) for (const item2 of classesForCommand(segment)) classes.add(item2);
  } else if (/create_thread|spawn_agent|delegate/.test(name2)) add("task_create");
  else if (/apply[_-]?patch|write|edit|create_file|delete_file/.test(name2)) add("repository_write");
  else if (/read|glob|grep|search_files|list_files|view_image/.test(name2)) add("repository_read");
  else if (/web|fetch|search_query|open_url|browser/.test(name2)) add("network_read");
  else if (/send|email|message|comment|post|submit/.test(name2)) add("external_write");
  else add("unknown_effect");
  if (/credential|secret|keychain|token/.test(name2)) add("credential_access");
  const identityInput = command ?? call.input;
  return {
    toolCallId: call.id,
    toolName: call.name,
    sequence: call.sequence,
    classes: [...classes],
    summary: command ? command.slice(0, 240).replace(/\s+/g, " ") : call.input.slice(0, 240).replace(/\s+/g, " "),
    identitySha256: `sha256:${createHash5("sha256").update(`${call.name}\0${identityInput}`).digest("hex")}`,
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
    repeatedActionGroups: counts.filter((count3) => count3 > 1).length,
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
  const allowed2 = new Set(contract.allowedActions);
  const trajectory = analyzeTrajectory(actions);
  const violations = actions.flatMap((action) => action.classes.filter((item2) => !allowed2.has(item2)).map((item2) => ({ action, item: item2 })));
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
  if (unknown.length && allowed2.has("unknown_effect")) {
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
var PUBLISHED_ACTION_VERSION = "0.19.0";
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
  const target2 = resolve7(root, path);
  if (existsSync5(target2) && !force) {
    result5.kept.push(path);
    return;
  }
  mkdirSync3(dirname3(target2), { recursive: true });
  writeFileSync3(target2, content);
  result5.created.push(path);
}
function inferProtectCommands(root, testCommand) {
  const commands = [];
  const packagePath = resolve7(root, "package.json");
  if (existsSync5(packagePath)) {
    try {
      const scripts = JSON.parse(readFileSync8(packagePath, "utf8"))?.scripts ?? {};
      for (const name2 of ["typecheck", "lint", "build"]) {
        if (typeof scripts[name2] === "string" && scripts[name2].trim()) commands.push(`npm run ${name2}`);
      }
    } catch {
    }
  }
  if (testCommand) commands.push(testCommand);
  return [...new Set(commands)].slice(0, 8);
}
function initRepository(repo, force = false, portableSignerKeyId, profile = "default", attest = false) {
  const root = resolve7(repo);
  try {
    execFileSync7("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error(`not a Git repository: ${root}`);
  }
  const result5 = { created: [], kept: [] };
  const inferred = inferTestCommand(root) ?? void 0;
  const mode = profile === "maintainer" || profile === "protect" ? "maintainer" : profile === "authority" ? "authority" : portableSignerKeyId ? "portable" : "transcript";
  const setupCommand = existsSync5(resolve7(root, "package-lock.json")) ? "npm ci --ignore-scripts" : void 0;
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
    return execFileSync7("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function doctorRepository(repo, requestedPolicy, requestedTranscript) {
  const root = resolve7(repo);
  const checks = [];
  const workflow3 = resolve7(root, ".github/workflows/agent-vigil.yml");
  const outcomeObserver = resolve7(root, ".github/workflows/agent-vigil-outcomes.yml");
  const installedWorkflow = existsSync5(workflow3) ? readFileSync8(workflow3, "utf8") : "";
  const authorityConfigured = /^\s*authority-contract:\s*\S+\s*$/m.test(installedWorkflow);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    status: nodeMajor >= 20 ? "PASS" : "FAIL",
    label: "Node.js",
    detail: `${process.versions.node}${nodeMajor >= 20 ? " satisfies Node 20+" : " is unsupported; install Node 20+"}`
  });
  checks.push({
    status: existsSync5(outcomeObserver) ? "PASS" : "WARN",
    label: "Outcome observer",
    detail: existsSync5(outcomeObserver) ? "post-run workflow retains final Actions runtime and later pull-request outcome evidence without re-executing candidate code" : "outcome workflow is missing; rerun vigil init to add post-run evidence closure"
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
    const path = resolve7(root, portableReceipt);
    checks.push({
      status: existsSync5(path) ? "PASS" : "WARN",
      label: "Portable receipt",
      detail: existsSync5(path) ? `${portableReceipt} is present; run vigil gate to verify it` : `${portableReceipt} will be created after the next signed code change; raw transcript remains local`
    });
  } else if (maintainer) {
    const template = resolve7(root, ".github/pull_request_template.md");
    checks.push({
      status: existsSync5(template) ? "PASS" : "FAIL",
      label: "Pull request evidence",
      detail: existsSync5(template) ? "AI-assistance, linked-issue, and limitations template is installed" : "maintainer profile requires .github/pull_request_template.md"
    });
    checks.push({
      status: maintainerReviewMode === "automated" ? "PASS" : maintainerReviewMode === "human" ? "PASS" : "WARN",
      label: "Review mode",
      detail: maintainerReviewMode === "automated" ? "base policy runs explicit automated-review commands in an isolated exact-commit checkout" : maintainerReviewMode === "human" ? "base policy requires named human review declarations" : "legacy policy does not name a reviewMode; set human or automated explicitly"
    });
  } else if (!transcript) {
    checks.push({ status: "WARN", label: "Transcript", detail: "no transcript configured; pass a path or run vigil init" });
  } else {
    const path = resolve7(root, transcript);
    if (!existsSync5(path)) checks.push({ status: "WARN", label: "Transcript", detail: `${transcript} does not exist yet` });
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
    status: existsSync5(workflow3) ? "PASS" : "WARN",
    label: "GitHub Action",
    detail: existsSync5(workflow3) ? "workflow installed; configure Agent Vigil evidence as a required status check after its first run" : "workflow not installed; run vigil init"
  });
  if (existsSync5(workflow3)) {
    const text4 = installedWorkflow;
    const attestationEnabled = /^\s*attest:\s*true\s*$/m.test(text4);
    if (attestationEnabled) {
      const permissionsPresent = /^\s*id-token:\s*write\s*$/m.test(text4) && /^\s*attestations:\s*write\s*$/m.test(text4) && /^\s*artifact-metadata:\s*write\s*$/m.test(text4);
      const repositoryWrite = /^\s*contents:\s*write\s*$/m.test(text4);
      checks.push({
        status: !permissionsPresent ? "FAIL" : repositoryWrite ? "WARN" : "PASS",
        label: "GitHub attestation",
        detail: !permissionsPresent ? "attest: true requires id-token, attestations, and artifact-metadata write permissions" : repositoryWrite ? "receipt signing is configured, but this workflow can also write repository contents; remove that permission unless another reviewed step requires it" : "receipt attestation is enabled with the required GitHub permissions"
      });
    }
    const exactRange = /pull_request\.base\.sha/.test(text4) && /pull_request\.head\.sha/.test(text4);
    checks.push({
      status: exactRange ? "PASS" : "WARN",
      label: "Git range",
      detail: exactRange ? "workflow pins the pull request base and head SHAs" : "workflow does not visibly pin both pull request SHAs"
    });
    const exactCheckout = /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.event\.merge_group\.head_sha\s*\}\}/.test(text4);
    checks.push({
      status: exactCheckout ? "PASS" : "WARN",
      label: "Checkout identity",
      detail: exactCheckout ? "workflow checks out the exact pull request head SHA" : "workflow may verify GitHub's synthetic merge commit instead of the selected head"
    });
    const anchoredPolicy = /policy-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}/.test(text4);
    checks.push({
      status: anchoredPolicy ? "PASS" : "WARN",
      label: "Policy trust",
      detail: anchoredPolicy ? "workflow loads policy from the pull request base commit" : "workflow policy may be controlled by the candidate change"
    });
    const mergeQueue = /merge_group:\s*\n\s*types:\s*\[checks_requested\]/.test(text4) && /merge_group\.base_sha/.test(text4) && /merge_group\.head_sha/.test(text4);
    checks.push({
      status: mergeQueue ? "PASS" : "WARN",
      label: "Merge queue",
      detail: mergeQueue ? "workflow re-verifies the composed merge-group commit" : "required check will not report for GitHub merge queues"
    });
    if (maintainer) {
      const modeInstalled = /mode:\s*maintainer/.test(text4);
      const artifactInstalled = /name:\s*agent-vigil-receipt/.test(text4);
      checks.push({
        status: modeInstalled && artifactInstalled ? "PASS" : "FAIL",
        label: "Maintainer workflow",
        detail: modeInstalled && artifactInstalled ? "maintainer mode and receipt artifact retention are installed" : "workflow must enable maintainer mode and retain agent-vigil-receipt"
      });
    }
    const authorityMatch = text4.match(/^\s*authority-contract:\s*(\S+)\s*$/m);
    if (authorityMatch) {
      try {
        const contract = loadAuthorityContract(root, authorityMatch[1]);
        const placeholder = contract.value.taskId === "REPLACE_WITH_TASK_OR_TICKET_ID";
        const expired = Boolean(contract.value.expiresAt && Date.now() > new Date(contract.value.expiresAt).getTime());
        const anchored = /^\s*authority-contract-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}\s*$/m.test(text4);
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
  createHash as createHash6,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { chmodSync, readFileSync as readFileSync9, writeFileSync as writeFileSync4 } from "node:fs";
function publicKeyDer(key) {
  return key.export({ type: "spki", format: "der" });
}
function signingKeyId(der) {
  return `sha256:${createHash6("sha256").update(der).digest("hex")}`;
}
function signReport(report, privateKeyPath) {
  const privateKey = createPrivateKey(readFileSync9(privateKeyPath));
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
  const selected = publicKeyPath ? createPublicKey(readFileSync9(publicKeyPath)) : embedded;
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
  const publicKey = createPublicKey(readFileSync9(publicKeyPath));
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("public key must be Ed25519");
  return signingKeyId(publicKeyDer(publicKey));
}

// src/portable.ts
import {
  createHash as createHash7,
  createPrivateKey as createPrivateKey2,
  createPublicKey as createPublicKey2,
  sign as sign2,
  verify as verify2
} from "node:crypto";
import { readFileSync as readFileSync10 } from "node:fs";
var SHA256 = /^sha256:[0-9a-f]{64}$/;
function digest(value) {
  return `sha256:${createHash7("sha256").update(canonical(value)).digest("hex")}`;
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
  const privateKey = createPrivateKey2(readFileSync10(privateKeyPath));
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
import { execFileSync as execFileSync8 } from "node:child_process";
import { relative as relative5, resolve as resolve8, sep as sep5 } from "node:path";

// src/integrity-policy.ts
var CALIBRATED_BLOCKING_RULES = /* @__PURE__ */ new Set([
  "coverage-weakened",
  "ghost-loader",
  "oracle-falsify",
  "render-gate",
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
    return execFileSync8("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  const value = relative5(resolve8(repo), resolve8(path)).replaceAll("\\", "/");
  if (!value || value === ".." || value.startsWith("../") || value.startsWith(`..${sep5}`)) return void 0;
  return value.replace(/^\.\//, "");
}
function buildPortableGateReport(receipt, options) {
  const repo = resolve8(options.repo);
  const receiptPath = resolve8(options.receiptPath);
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
import { createHash as createHash8 } from "node:crypto";
function consistencyErrors(report) {
  const errors = [];
  const count3 = (verdict) => report.results.filter((row) => row.verdict === verdict).length;
  const meaningfulVerified = report.results.filter((row) => row.verdict === "verified" && row.contributesToPass !== false).length;
  const expectedStatus = count3("contradicted") > 0 ? "FAIL" : meaningfulVerified < report.policy.minVerified || report.results.some((row) => row.verdict === "unverifiable" && row.blocksPass) || report.policy.strict && count3("unverifiable") > 0 ? "INCONCLUSIVE" : "PASS";
  if (report.summary.verified !== count3("verified")) errors.push("verified count does not match results");
  if (report.summary.contradicted !== count3("contradicted")) errors.push("contradicted count does not match results");
  if (report.summary.unverifiable !== count3("unverifiable")) errors.push("unverifiable count does not match results");
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
  return { ...unsigned, deltaHash: `sha256:${createHash8("sha256").update(canonical(unsigned)).digest("hex")}` };
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
import { createHash as createHash10 } from "node:crypto";
import { execFileSync as execFileSync10 } from "node:child_process";
import { readFileSync as readFileSync11 } from "node:fs";
import { relative as relative6, resolve as resolve9 } from "node:path";

// src/authority-plan.ts
import { createHash as createHash9 } from "node:crypto";
import { execFileSync as execFileSync9 } from "node:child_process";
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
function getLineColFromPtr(string3, ptr) {
  let lines = string3.slice(0, ptr).split(/\r\n|\n|\r/g);
  return [lines.length, lines.pop().length + 1];
}
function makeCodeBlock(string3, line, column) {
  let lines = string3.split(/\r\n|\n|\r/g);
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
function skipUntil(ctx, sep14, end) {
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
    } else if (c === end || c === sep14) {
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
function peekTable(key, table, meta, type3) {
  let t = table;
  let m = meta;
  let k;
  let hasOwn = false;
  let state;
  for (let i = 0; i < key.length; i++) {
    if (i) {
      t = hasOwn ? t[k] : t[k] = {};
      m = (state = m[k]).c;
      if (type3 === 0 && (state.t === 1 || state.t === 2)) {
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
        t: i < key.length - 1 && type3 === 2 ? 3 : type3,
        d: false,
        i: 0,
        c: {}
      };
    }
  }
  state = m[k];
  if (state.t !== type3 && !(type3 === 1 && state.t === 3)) {
    return null;
  }
  if (type3 === 2) {
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
  if (type3 === 1) {
    t = hasOwn ? t[k] : t[k] = {};
  } else if (type3 === 0 && hasOwn) {
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
  return `sha256:${createHash9("sha256").update(value).digest("hex")}`;
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
  return `avp:${createHash9("sha256").update(semanticKey).digest("hex").slice(0, 20)}`;
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
    ...safe
  } = value;
  return safe;
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
      for (const target2 of [...targets]) {
        for (const next of reachable.get(target2) ?? []) {
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
  return execFileSync9("git", args, {
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
  const allowed2 = /* @__PURE__ */ new Set(["schemaVersion", "approvedAdditions", "allowUnknownChanges"]);
  const extras = Object.keys(root).filter((key) => !allowed2.has(key));
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
  const source2 = raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw;
  const parsed = format === "toml" ? parse2(source2) : JSON.parse(source2);
  assertBoundedConfig(parsed);
  return parsed;
}
function assertBoundedConfig(value) {
  let nodes = 0;
  const visit = (current, depth) => {
    nodes += 1;
    if (nodes > MAX_CONFIG_NODES) throw new Error(`configuration exceeds ${MAX_CONFIG_NODES} structured values`);
    if (depth > MAX_CONFIG_DEPTH) throw new Error(`configuration exceeds maximum depth ${MAX_CONFIG_DEPTH}`);
    if (Array.isArray(current)) {
      for (const item2 of current) visit(item2, depth + 1);
      return;
    }
    const object4 = record(current);
    if (object4) for (const item2 of Object.values(object4)) visit(item2, depth + 1);
  };
  visit(value, 0);
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
function addPermissionAtoms(out, platform3, path, rules, decision, locator) {
  const disposition = permissionDisposition(decision);
  for (const rule of stringList(rules)) {
    const semanticKey = `${platform3}\0${path}\0permission\0${rule}`;
    out.push(atom({
      semanticKey,
      platform: platform3,
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
function addEnvironmentAtoms(out, platform3, path, subject, values, locator) {
  const env = record(values);
  if (!env) return;
  for (const name2 of Object.keys(env).sort()) {
    const semanticKey = `${platform3}\0${path}\0credential\0${subject}\0${name2}`;
    out.push(atom({
      semanticKey,
      platform: platform3,
      sourcePath: path,
      kind: "credential",
      subject,
      action: "credential.expose",
      resource: `env:${name2}`,
      effect: "credential",
      decision: "ALLOW",
      constraints: ["value=redacted"],
      locator: `${locator}.${name2}`,
      comparisonValue: env[name2],
      added: expansion("AVP008", "a new environment value can be exposed to agent-controlled code", "critical"),
      removed: ALLOW_RESTRICTION,
      compare: () => "incomparable"
    }));
  }
}
function addOpaqueAuthoritySection(out, platform3, path, locator, value, reason) {
  if (value === void 0) return;
  const disposition = hold("AVP014", reason, "high");
  out.push(atom({
    semanticKey: `${platform3}\0${path}\0opaque-authority\0${locator}`,
    platform: platform3,
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
function addMcpEnvironmentReferences(out, platform3, path, subject, values, locator) {
  if (!Array.isArray(values)) return;
  for (const [index, raw] of values.entries()) {
    const config = record(raw);
    const name2 = stringValue(raw) ?? stringValue(config?.name);
    if (!name2) {
      addOpaqueAuthoritySection(out, platform3, path, `${locator}[${index}]`, raw, "an MCP environment reference has an unsupported shape");
      continue;
    }
    const source2 = stringValue(config?.source) ?? "local";
    out.push(atom({
      semanticKey: `${platform3}\0${path}\0${subject}\0env-ref\0${name2}`,
      platform: platform3,
      sourcePath: path,
      kind: "credential",
      subject,
      action: "environment.inherit",
      resource: `env:${name2}`,
      effect: "credential",
      decision: "ALLOW",
      constraints: [`source=${source2}`],
      locator,
      comparisonValue: { name: name2, source: source2 },
      added: expansion("AVP008", "an MCP process can inherit an additional environment value", "critical"),
      removed: ALLOW_RESTRICTION,
      compare: (before, after) => before.comparisonToken === after.comparisonToken ? "equal" : "incomparable"
    }));
  }
}
function addMcpServerAtoms(out, platform3, path, values, locator) {
  const servers = record(values);
  if (!servers) return;
  for (const [name2, rawServer] of Object.entries(servers).sort(([a], [b]) => a.localeCompare(b))) {
    const server = record(rawServer);
    if (!server) {
      addOpaqueAuthoritySection(out, platform3, path, `${locator}.${name2}`, rawServer, "an MCP server entry has an unsupported shape");
      continue;
    }
    const enabled = boolValue(server.enabled) ?? !boolValue(server.disabled);
    const command = stringValue(server.command);
    const url = stringValue(server.url) ?? stringValue(server.serverUrl);
    const transport = url ? "http" : command ? "stdio" : stringValue(server.type) ?? "unknown";
    const identity = url ? safeOrigin(url) : command ? safeExecutable(command) : "unknown-server";
    const baseKey = `${platform3}\0${path}\0mcp\0${name2}`;
    out.push(atom({
      semanticKey: `${baseKey}\0enabled`,
      platform: platform3,
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.connect",
      resource: `${name2}:${identity}`,
      effect: transport === "stdio" ? "execute" : transport === "http" ? "network" : "unknown",
      decision: enabled ? "ALLOW" : "DENY",
      constraints: [`enabled=${enabled}`, `transport=${transport}`],
      locator: `${locator}.${name2}.enabled`,
      comparisonValue: enabled,
      added: enabled ? expansion("AVP002", "a newly declared MCP server adds an unbounded tool surface", "critical") : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      removed: enabled ? ALLOW_RESTRICTION : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      compare: (before, after) => decisionRelation(before.decision, after.decision)
    }));
    out.push(atom({
      semanticKey: `${baseKey}\0identity`,
      platform: platform3,
      sourcePath: path,
      kind: "control",
      subject: name2,
      action: "mcp.launch",
      resource: identity,
      effect: transport === "stdio" ? "execute" : transport === "http" ? "network" : "unknown",
      decision: enabled ? "ALLOW" : "DENY",
      constraints: [`transport=${transport}`, ...command ? [`executable=${safeExecutable(command)}`] : [], ...url ? [`origin=${safeOrigin(url)}`] : []],
      locator: `${locator}.${name2}`,
      comparisonValue: { command, args: server.args, cwd: server.cwd, url },
      added: enabled ? expansion("AVP002", "a new MCP launch identity can execute code or contact an external service", "critical") : { ...ALLOW_RESTRICTION, direction: "NEUTRAL" },
      removed: ALLOW_RESTRICTION,
      compare: () => "expansion"
    }));
    addEnvironmentAtoms(out, platform3, path, `mcp:${name2}`, server.env, `${locator}.${name2}.env`);
    addEnvironmentAtoms(out, platform3, path, `mcp:${name2}`, server.http_headers, `${locator}.${name2}.http_headers`);
    addEnvironmentAtoms(out, platform3, path, `mcp:${name2}`, server.env_http_headers, `${locator}.${name2}.env_http_headers`);
    addEnvironmentAtoms(out, platform3, path, `mcp:${name2}`, server.headers, `${locator}.${name2}.headers`);
    addMcpEnvironmentReferences(out, platform3, path, `mcp:${name2}`, server.env_vars, `${locator}.${name2}.env_vars`);
    const bearer = stringValue(server.bearer_token_env_var);
    if (bearer) addEnvironmentAtoms(out, platform3, path, `mcp:${name2}`, { [bearer]: "environment-reference" }, `${locator}.${name2}.bearer_token_env_var`);
    const auth = stringValue(server.auth);
    if (auth) {
      out.push(atom({
        semanticKey: `${baseKey}\0auth-mode`,
        platform: platform3,
        sourcePath: path,
        kind: "credential",
        subject: `mcp:${name2}`,
        action: "mcp.authenticate",
        resource: "credential-source",
        effect: "credential",
        decision: auth === "oauth" || auth === "chatgpt" ? "ALLOW" : "UNKNOWN",
        constraints: [`mode=${auth}`],
        locator: `${locator}.${name2}.auth`,
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
        platform: platform3,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name2}`,
        action: "process.execute",
        resource: executionEnvironment,
        effect: "execute",
        decision: executionEnvironment === "remote" ? "ALLOW" : executionEnvironment === "local" ? "ASK" : "UNKNOWN",
        constraints: [`environment=${executionEnvironment}`],
        locator: `${locator}.${name2}.experimental_environment`,
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
        platform: platform3,
        sourcePath: path,
        kind: "credential",
        subject: `mcp:${name2}`,
        action: "oauth.resource",
        resource: safeOrigin(oauthResource),
        effect: "credential",
        decision: "ALLOW",
        constraints: [],
        locator: `${locator}.${name2}.oauth_resource`,
        comparisonValue: oauthResource,
        added: expansion("AVP008", "an MCP connection requests credentials for an additional OAuth resource", "critical"),
        removed: ALLOW_RESTRICTION,
        compare: () => "incomparable"
      }));
    }
    for (const scope of stringList(server.scopes)) {
      out.push(atom({
        semanticKey: `${baseKey}\0oauth-scope\0${scope}`,
        platform: platform3,
        sourcePath: path,
        kind: "permission",
        subject: `mcp:${name2}`,
        action: "oauth.scope",
        resource: scope,
        effect: "external",
        decision: "ALLOW",
        constraints: [],
        locator: `${locator}.${name2}.scopes`,
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
        platform: platform3,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name2}`,
        action: "mcp.tool",
        resource: tool,
        effect: "unknown",
        decision: "ALLOW",
        constraints: ["selection=enabled"],
        locator: `${locator}.${name2}.enabled_tools`,
        comparisonValue: true,
        added: expansion("AVP013", "an additional MCP tool is exposed to the agent", "critical"),
        removed: ALLOW_RESTRICTION
      }));
    }
    for (const tool of disabledTools) {
      out.push(atom({
        semanticKey: `${baseKey}\0tool\0${tool}`,
        platform: platform3,
        sourcePath: path,
        kind: "capability",
        subject: `mcp:${name2}`,
        action: "mcp.tool",
        resource: tool,
        effect: "unknown",
        decision: "DENY",
        constraints: ["selection=disabled"],
        locator: `${locator}.${name2}.disabled_tools`,
        comparisonValue: false,
        added: ALLOW_RESTRICTION,
        removed: expansion("AVP013", "an MCP tool was removed from the explicit deny list", "critical"),
        compare: (before, after) => decisionRelation(before.decision, after.decision)
      }));
    }
    const approvalMode = stringValue(server.default_tools_approval_mode ?? server.defaultToolsApprovalMode);
    if (approvalMode) addMcpApprovalAtom(out, platform3, path, `${baseKey}\0approval`, name2, approvalMode, `${locator}.${name2}.default_tools_approval_mode`);
    const tools = record(server.tools);
    if (tools) {
      for (const [tool, rawTool] of Object.entries(tools).sort(([a], [b]) => a.localeCompare(b))) {
        const config = record(rawTool);
        if (!config) continue;
        const mode = stringValue(config.approval_mode ?? config.approvalMode);
        if (mode) addMcpApprovalAtom(out, platform3, path, `${baseKey}\0tool-approval\0${tool}`, `${name2}/${tool}`, mode, `${locator}.${name2}.tools.${tool}.approval_mode`);
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
      addOpaqueAuthoritySection(out, platform3, path, `${locator}.${name2}.*`, unsupported, "an MCP server contains authority-bearing fields that are not yet normalized");
    }
  }
}
function addMcpApprovalAtom(out, platform3, path, semanticKey, subject, mode, locator) {
  const supported = /* @__PURE__ */ new Set(["auto", "prompt", "writes", "approve"]);
  const known = supported.has(mode);
  out.push(atom({
    semanticKey,
    platform: platform3,
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
  for (const name2 of stringList(parsed.enabledMcpjsonServers)) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0mcp-server\0${name2}`,
      platform: "claude-code",
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.enable",
      resource: name2,
      effect: "unknown",
      decision: "ALLOW",
      constraints: [],
      locator: "enabledMcpjsonServers",
      comparisonValue: true,
      added: expansion("AVP003", "an MCP server is newly approved for Claude Code", "critical"),
      removed: ALLOW_RESTRICTION
    }));
  }
  for (const name2 of stringList(parsed.disabledMcpjsonServers)) {
    out.push(atom({
      semanticKey: `claude-code\0${path}\0mcp-server\0${name2}`,
      platform: "claude-code",
      sourcePath: path,
      kind: "capability",
      subject: "agent",
      action: "mcp.enable",
      resource: name2,
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
    for (const [name2, rawEnabled] of Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b))) {
      const enabled = boolValue(rawEnabled);
      if (enabled === void 0) continue;
      out.push(atom({
        semanticKey: `claude-code\0${path}\0plugin\0${name2}`,
        platform: "claude-code",
        sourcePath: path,
        kind: "capability",
        subject: "agent",
        action: "plugin.enable",
        resource: name2,
        effect: "unknown",
        decision: enabled ? "ALLOW" : "DENY",
        constraints: [`enabled=${enabled}`],
        locator: `enabledPlugins.${name2}`,
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
  for (const [event2, rawEntries] of Object.entries(hooks).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Array.isArray(rawEntries)) continue;
    rawEntries.forEach((rawEntry, index) => {
      const entry = record(rawEntry);
      if (!entry) return;
      const handlers = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      handlers.forEach((rawHandler, handlerIndex) => {
        const handler = record(rawHandler);
        if (!handler) return;
        const type3 = stringValue(handler.type) ?? "command";
        const command = stringValue(handler.command);
        const semanticKey = `claude-code\0${path}\0hook\0${event2}\0${index}\0${handlerIndex}`;
        const securityControl = event2 === "PreToolUse" || event2 === "PermissionRequest";
        out.push(atom({
          semanticKey,
          platform: "claude-code",
          sourcePath: path,
          kind: "control",
          subject: event2,
          action: "hook.execute",
          resource: command ? safeExecutable(command) : type3,
          effect: command ? "execute" : "control",
          decision: "ALLOW",
          constraints: [`type=${type3}`, ...stringValue(entry.matcher) ? ["matcher=configured"] : []],
          locator: `hooks.${event2}[${index}].hooks[${handlerIndex}]`,
          comparisonValue: { matcher: entry.matcher, handler },
          added: expansion("AVP011", "a repository-controlled hook can execute or alter tool authorization", securityControl ? "critical" : "high"),
          removed: securityControl ? expansion("AVP011", "a pre-execution authorization hook was removed", "critical") : ALLOW_RESTRICTION,
          compare: () => "incomparable"
        }));
      });
    });
  }
}
function addModelAtom(out, platform3, path, rawModel, locator) {
  const model = stringValue(rawModel);
  if (!model) return;
  const mutable = /(?:^|[-_/.:])(latest|default|auto|current)(?:$|[-_/.:])/i.test(model);
  out.push(atom({
    semanticKey: `${platform3}\0${path}\0model`,
    platform: platform3,
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
    const platform3 = sourcePlatform(path);
    let raw;
    try {
      raw = readGitFile(repo, ref, path);
    } catch (error) {
      internal.gaps.push({ platform: platform3, sourcePath: path, locator: path, reason: error.message });
      continue;
    }
    const format = path.endsWith(".toml") ? "toml" : "json";
    internal.sources.push({ platform: platform3, path, format, sha256: sha256(raw) });
    let parsed;
    try {
      parsed = parseConfig(raw, format);
    } catch {
      internal.gaps.push({ platform: platform3, sourcePath: path, locator: path, reason: `${format.toUpperCase()} parse failed; inspect the committed source locally` });
      continue;
    }
    const value = record(parsed);
    if (!value) {
      internal.gaps.push({ platform: platform3, sourcePath: path, locator: path, reason: "configuration root is not an object" });
      continue;
    }
    try {
      internal.atoms.push(...platform3 === "claude-code" ? extractClaude(path, value) : platform3 === "codex" ? extractCodex(path, value) : extractMcp(path, value));
    } catch {
      internal.gaps.push({ platform: platform3, sourcePath: path, locator: path, reason: "authority extraction failed; inspect the committed source locally" });
    }
  }
  internal.sources.sort((a, b) => a.path.localeCompare(b.path));
  internal.atoms.sort((a, b) => a.semanticKey.localeCompare(b.semanticKey));
  internal.gaps.sort((a, b) => `${a.sourcePath}:${a.locator}`.localeCompare(`${b.sourcePath}:${b.locator}`));
  const safe = {
    ...internal,
    atoms: internal.atoms.map(publicAtom)
  };
  return { ...safe, sha256: profileDigest(safe) };
}
function discoverInternal(repo, ref) {
  const safe = discoverAuthorityProfile(repo, ref);
  const internal = {
    schemaVersion: safe.schemaVersion,
    scope: safe.scope,
    ref: safe.ref,
    sources: [...safe.sources],
    atoms: [],
    gaps: [...safe.gaps]
  };
  for (const source2 of safe.sources) {
    try {
      const raw = readGitFile(repo, ref, source2.path);
      const value = record(parseConfig(raw, source2.format));
      if (!value) continue;
      internal.atoms.push(...source2.platform === "claude-code" ? extractClaude(source2.path, value) : source2.platform === "codex" ? extractCodex(source2.path, value) : extractMcp(source2.path, value));
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
    id: `delta:${createHash9("sha256").update(identity).digest("hex").slice(0, 20)}`,
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
      sources: new Set([...before.sources, ...after.sources].map((source2) => source2.path)).size,
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
    const name2 = atom2.action === "mcp.connect" ? atom2.resource.split(":", 1)[0] : atom2.subject;
    return `server: mcp:${name2}`;
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
  const value = JSON.parse(readFileSync11(path, "utf8"));
  if (!value.merge_group?.base_sha || !value.merge_group?.head_sha) {
    throw new Error("event is not a merge_group payload with base_sha and head_sha");
  }
  return value;
}
function git7(repo, args) {
  try {
    return execFileSync10("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  const repo = resolve9(options.repo);
  const eventPath = resolve9(options.eventPath);
  const event2 = loadMergeGroupEvent(eventPath);
  if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) {
    throw new Error(`invalid git range ${options.base}..${options.head}`);
  }
  const base = resolveGitRef(repo, options.base);
  const head = resolveGitRef(repo, options.head);
  if (resolveGitRef(repo, event2.merge_group.base_sha) !== base) {
    throw new Error(`event base ${event2.merge_group.base_sha} does not match selected base ${base}`);
  }
  if (resolveGitRef(repo, event2.merge_group.head_sha) !== head) {
    throw new Error(`event head ${event2.merge_group.head_sha} does not match selected head ${head}`);
  }
  const policy = loadPolicy(repo, options.policy, options.policyRef);
  if (policy.ref && resolveGitRef(repo, policy.ref) !== base) {
    throw new Error(`merge-group policy-ref ${policy.ref} does not match event base ${base}`);
  }
  const eventHash = `sha256:${createHash10("sha256").update(readFileSync11(eventPath)).digest("hex")}`;
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
import { createHash as createHash11 } from "node:crypto";
function nonNegative(value, name2) {
  if (value !== void 0 && (!Number.isFinite(value) || value < 0)) throw new Error(`${name2} must be a non-negative number`);
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
  return `sha256:${createHash11("sha256").update(cardPayload(withoutHash)).digest("hex")}`;
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
import { createHash as createHash12 } from "node:crypto";
import { readFileSync as readFileSync12, statSync as statSync5 } from "node:fs";
import { basename as basename2, resolve as resolve10 } from "node:path";
var MAX_SOURCE_BYTES = 32 * 1024 * 1024;
function buildGitHubWebhookEvidence(raw, generatedAt = /* @__PURE__ */ new Date()) {
  if (raw.length > MAX_SOURCE_BYTES) throw new Error(`GitHub event evidence exceeds the ${MAX_SOURCE_BYTES} byte limit`);
  let event2;
  try {
    event2 = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("GitHub event evidence is not valid JSON");
  }
  if (!event2 || typeof event2 !== "object" || Array.isArray(event2)) throw new Error("GitHub event evidence must be an object");
  const repository2 = typeof event2.repository?.full_name === "string" ? event2.repository.full_name : void 0;
  const pull = parsePull(event2, event2);
  const source2 = {
    kind: "event",
    file: "webhook-event.json",
    bytes: raw.length,
    sha256: `sha256:${createHash12("sha256").update(raw).digest("hex")}`
  };
  const withoutHash = {
    schemaVersion: "agent-vigil-github-evidence/v1",
    generatedAt: generatedAt.toISOString(),
    ...repository2 ? { repository: repository2 } : {},
    ...pull ? { pullRequest: pull } : {},
    markers: { revert: false, hotfix: false, incident: false },
    inference: {
      disposition: pull?.merged ? "accepted" : "unreviewed",
      outcome: pull?.merged ? "merged" : pull?.state === "closed" ? "closed" : "unknown",
      ...pull?.mergedAt || pull?.closedAt ? { outcomeAsOf: pull.mergedAt ?? pull.closedAt } : {},
      reviewEvidence: pull?.merged ? "EVIDENCE_HASHED" : "UNAVAILABLE",
      outcomeEvidence: pull?.merged ? "EVIDENCE_HASHED" : "UNAVAILABLE"
    },
    sources: [source2]
  };
  const bundle = { ...withoutHash, evidenceHash: "" };
  bundle.evidenceHash = recomputeGitHubEvidenceHash(bundle);
  return bundle;
}
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
  const absolute = resolve10(path);
  const bytes = statSync5(absolute).size;
  if (bytes > MAX_SOURCE_BYTES) throw new Error(`GitHub ${kind} evidence is ${bytes} bytes; maximum is ${MAX_SOURCE_BYTES}`);
  const raw = readFileSync12(absolute);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`GitHub ${kind} evidence is not valid JSON: ${path}`);
  }
  return {
    value,
    source: { kind, file: basename2(path), bytes, sha256: `sha256:${createHash12("sha256").update(raw).digest("hex")}` }
  };
}
function pullObject(value) {
  return value?.pull_request && typeof value.pull_request === "object" ? value.pull_request : value;
}
function parsePull(value, event2) {
  const pull = pullObject(value);
  const number = integer(pull?.number ?? event2?.number ?? event2?.pull_request?.number);
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
  return `sha256:${createHash12("sha256").update(payloadWithoutHash(withoutHash)).digest("hex")}`;
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
  const event2 = loaded.get("event");
  const repository2 = typeof event2?.repository?.full_name === "string" ? event2.repository.full_name : void 0;
  const pull = loaded.has("pull-request") ? parsePull(loaded.get("pull-request"), event2) : parsePull(event2, event2);
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
import { readFileSync as readFileSync13, statSync as statSync6 } from "node:fs";
import { resolve as resolve11 } from "node:path";
var MAX_CARD_BYTES = 8 * 1024 * 1024;
function validCard(value, path) {
  if (value?.schemaVersion !== "agent-vigil-value-card/v1") throw new Error(`${path} is not an Agent Value Card v1`);
  if (typeof value.cardHash !== "string" || typeof value.receipt?.receiptHash !== "string") throw new Error(`${path} lacks value-card integrity fields`);
  if (!(/* @__PURE__ */ new Set(["POSITIVE", "NEGATIVE", "INCONCLUSIVE"])).has(value.valueVerdict)) throw new Error(`${path} has an invalid value verdict`);
  if (recomputeValueCardHash(value) !== value.cardHash) throw new Error(`${path} value-card hash is invalid`);
  return value;
}
function loadValueCard(path) {
  const absolute = resolve11(path);
  const bytes = statSync6(absolute).size;
  if (bytes > MAX_CARD_BYTES) throw new Error(`${path} is ${bytes} bytes; maximum is ${MAX_CARD_BYTES}`);
  let value;
  try {
    value = JSON.parse(readFileSync13(absolute, "utf8"));
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
import { createHash as createHash13, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync as execFileSync11 } from "node:child_process";
import { readFileSync as readFileSync14, statSync as statSync7 } from "node:fs";
import { basename as basename3, resolve as resolve12 } from "node:path";
var ATTESTATION_PREDICATE_TYPE = "https://sulmusic2-star.github.io/agent-vigil/ai-change-receipt-predicate-v1.schema.json";
function sha2562(buffer) {
  return createHash13("sha256").update(buffer).digest("hex");
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
  const absolute = resolve12(path);
  const metadata = statSync7(absolute);
  if (!metadata.isFile()) throw new Error("receipt must be a regular file");
  if (metadata.size > 16 * 1024 * 1024) throw new Error("receipt exceeds the 16 MB attestation limit");
  const bytes = readFileSync14(absolute);
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
  writePrivateFileAtomic(resolve12(predicateOutput), `${JSON.stringify(predicate, null, 2)}
`);
  return predicate;
}
function statementsFromGh(value) {
  const roots = Array.isArray(value) ? value : [value];
  const statements = [];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const record5 = root;
    const verification2 = record5.verificationResult;
    const statement = verification2 && typeof verification2 === "object" ? verification2.statement : record5.statement ?? record5;
    if (statement && typeof statement === "object") statements.push(statement);
  }
  return statements;
}
function subjectMatches(statement, expectedName, expectedDigest) {
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  return subjects.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const subject = entry;
    const digest8 = subject.digest && typeof subject.digest === "object" ? subject.digest : {};
    const name2 = String(subject.name ?? "");
    return (name2 === expectedName || name2.endsWith(`/${expectedName}`)) && digest8.sha256 === expectedDigest;
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
var runGitHubCli = (args) => execFileSync11("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function verifyGitHubAttestation(reportPath, repository2, trust = {}, executeGh = runGitHubCli) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository2)) throw new Error("repository must be owner/name");
  const signerWorkflow = trust.signerWorkflow ?? `${repository2}/.github/workflows/agent-vigil.yml`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/i.test(signerWorkflow)) {
    throw new Error("signer workflow must be owner/name/.github/workflows/file.yml");
  }
  const command = [
    "attestation",
    "verify",
    resolve12(reportPath),
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
function verifyWebhookSignature(secret, body, signatureHeader) {
  if (!secret || !signatureHeader?.startsWith("sha256=")) return false;
  const actualExpected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(signatureHeader);
  return actual.length === actualExpected.length && timingSafeEqual(actual, actualExpected);
}

// src/upgrade/cli.ts
import { realpathSync as realpathSync9, statSync as statSync9 } from "node:fs";
import { basename as basename5, dirname as dirname8, isAbsolute as isAbsolute7, relative as relative11, resolve as resolve17, sep as sep10 } from "node:path";

// src/upgrade/contracts.ts
import { lstatSync as lstatSync3, readFileSync as readFileSync15, realpathSync as realpathSync4 } from "node:fs";
import { dirname as dirname4, isAbsolute as isAbsolute4, join as join4, normalize as normalize4, relative as relative7, resolve as resolve13, sep as sep6, win32 as win323 } from "node:path";
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
function exactKeys2(value, allowed2, label) {
  const unknown = Object.keys(value).filter((key) => !allowed2.includes(key));
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
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep6}`)) {
    throw new Error(`${label} must remain inside the selected repository`);
  }
  return path.split("/").join(sep6);
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
  return JSON.parse(readFileSync15(path, "utf8"));
}
function trustedRegularFileInside(repositoryPath, filePath, label) {
  const requestedRepository = resolve13(repositoryPath);
  const repositoryStatus = lstatSync3(requestedRepository);
  if (repositoryStatus.isSymbolicLink() || !repositoryStatus.isDirectory()) {
    throw new Error("repository must be a regular directory, not a symbolic link");
  }
  const repository2 = realpathSync4(requestedRepository);
  const requested = resolve13(filePath);
  const rel = relative7(requestedRepository, requested);
  if (rel === ".." || rel.startsWith(`..${sep6}`)) throw new Error(`${label} must remain inside the repository`);
  let current = requestedRepository;
  const parentRel = relative7(requestedRepository, dirname4(requested));
  for (const component of parentRel.split(sep6).filter(Boolean)) {
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
  const canonical3 = realpathSync4(requested);
  const canonicalRel = relative7(repository2, canonical3);
  if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep6}`)) {
    throw new Error(`${label} resolved outside the repository`);
  }
  return canonical3;
}
function trustedDirectoryInside(repositoryPath, directoryPath, label) {
  const requestedRepository = resolve13(repositoryPath);
  const repositoryStatus = lstatSync3(requestedRepository);
  if (repositoryStatus.isSymbolicLink() || !repositoryStatus.isDirectory()) {
    throw new Error("repository must be a regular directory, not a symbolic link");
  }
  const repository2 = realpathSync4(requestedRepository);
  const requested = resolve13(directoryPath);
  const rel = relative7(requestedRepository, requested);
  if (rel === ".." || rel.startsWith(`..${sep6}`)) throw new Error(`${label} must remain inside the repository`);
  let current = requestedRepository;
  for (const component of rel.split(sep6).filter(Boolean)) {
    current = join4(current, component);
    const status = lstatSync3(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${label} and its parents must be regular directories without symbolic links`);
    }
  }
  const canonical3 = realpathSync4(requested);
  const canonicalRel = relative7(repository2, canonical3);
  if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep6}`)) {
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
  createHash as createHash16,
  randomBytes as randomBytes3,
  sign as sign3,
  verify as verify3
} from "node:crypto";
import { lstatSync as lstatSync5, readFileSync as readFileSync17, realpathSync as realpathSync7 } from "node:fs";
import { dirname as dirname6, isAbsolute as isAbsolute6, relative as relative9, resolve as resolve15, sep as sep8 } from "node:path";

// src/upgrade/presentation.ts
var TERMINAL_UNSAFE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu;
function terminalSafe(value) {
  return value.replace(TERMINAL_UNSAFE, (character) => {
    const codePoint = character.codePointAt(0);
    return `\\u{${(codePoint ?? 0).toString(16).toUpperCase().padStart(4, "0")}}`;
  });
}

// src/upgrade/decision.ts
import { createHash as createHash14 } from "node:crypto";
import { lstatSync as lstatSync4, readdirSync, readFileSync as readFileSync16, realpathSync as realpathSync5 } from "node:fs";
import { basename as basename4, dirname as dirname5, join as join5, relative as relative8, resolve as resolve14, sep as sep7 } from "node:path";
var MAX_FILES = 4096;
var MAX_FILE_BYTES2 = 4 * 1024 * 1024;
var MAX_TOTAL_BYTES = 64 * 1024 * 1024;
function hash(value) {
  return `sha256:${createHash14("sha256").update(value).digest("hex")}`;
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
  const target2 = resolve14(root, path);
  const rel = relative8(root, target2);
  if (rel === ".." || rel.startsWith(`..${sep7}`)) throw new Error("manifest escaped the target directory");
  const status = lstatSync4(target2);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("manifest must be a regular non-symbolic-link file");
  if (status.size > MAX_FILE_BYTES2) throw new Error(`manifest exceeds ${MAX_FILE_BYTES2} bytes`);
  const parent = realpathSync5(dirname5(target2));
  if (parent !== realpathSync5(root) && !parent.startsWith(`${realpathSync5(root)}${sep7}`)) {
    throw new Error("manifest parent escaped the target directory");
  }
  return target2;
}
function inspectArtifactTree(root) {
  const canonicalRoot = realpathSync5(root);
  if (!lstatSync4(canonicalRoot).isDirectory()) throw new Error("target must be a directory");
  const entries = [];
  let totalBytes = 0;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join5(directory, entry.name);
      const status = lstatSync4(path);
      if (status.isSymbolicLink()) throw new Error(`target contains a symbolic link: ${relative8(canonicalRoot, path)}`);
      if (status.isDirectory()) {
        visit(path);
        continue;
      }
      if (!status.isFile()) throw new Error(`target contains a non-regular entry: ${relative8(canonicalRoot, path)}`);
      if (status.size > MAX_FILE_BYTES2) throw new Error(`target file exceeds ${MAX_FILE_BYTES2} bytes: ${relative8(canonicalRoot, path)}`);
      totalBytes += status.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`target exceeds ${MAX_TOTAL_BYTES} total bytes`);
      if (entries.length >= MAX_FILES) throw new Error(`target contains more than ${MAX_FILES} files`);
      const rel = relative8(canonicalRoot, path).split(sep7).join("/");
      entries.push({
        path: rel,
        bytes: status.size,
        mode: status.mode & 511,
        sha256: hash(readFileSync16(path))
      });
    }
  };
  visit(canonicalRoot);
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
  const root = realpathSync5(directory);
  const manifestPath = safeFile(root, component.manifestPath);
  const manifestBytes = readFileSync16(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error(`${basename4(component.manifestPath)} is not valid JSON`);
  }
  const name2 = lookup(manifest, component.identityField);
  const version = lookup(manifest, component.versionField);
  if (typeof name2 !== "string" || !name2.length || name2.length > 160) throw new Error("manifest identity is missing or unbounded");
  if (name2 !== component.name) throw new Error(`manifest identity ${name2} does not match configured component ${component.name}`);
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
    name: name2,
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
import { createHash as createHash15, randomBytes as randomBytes2 } from "node:crypto";
import { spawnSync as spawnSync3 } from "node:child_process";
import { accessSync, constants as constants2, realpathSync as realpathSync6, statSync as statSync8 } from "node:fs";
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
function isDockerEndpointEnvironment(name2) {
  return DOCKER_ENDPOINT_ENV.has(name2.toUpperCase());
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
  const canonicalPath = realpathSync6(path);
  if (!statSync8(canonicalPath).isFile()) throw new Error("Docker client must be a regular file");
  if (process.platform !== "win32") accessSync(canonicalPath, constants2.X_OK);
  return canonicalPath;
}
function sanitizedDockerEnvironment(source2) {
  const environment = {};
  for (const [name2, value] of Object.entries(source2)) {
    if (!isDockerEndpointEnvironment(name2) && value !== void 0) environment[name2] = value;
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
function isLocalDockerEndpoint(endpoint, platform3 = process.platform) {
  if (endpoint.includes("\0") || /[\r\n]/.test(endpoint)) return false;
  if (endpoint.startsWith("unix:///")) {
    const path = endpoint.slice("unix://".length);
    return path.startsWith("/") && path.length > 1 && !/[?#]/.test(path);
  }
  if (platform3 === "win32") {
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
  for (const name2 of Object.keys(environment)) {
    if (isDockerEndpointEnvironment(name2)) delete environment[name2];
  }
  return environment;
}
function digest2(value) {
  return `sha256:${createHash15("sha256").update(value).digest("hex")}`;
}
function mountedPath(path, label) {
  const canonicalPath = realpathSync6(path);
  if (canonicalPath.includes(",") || canonicalPath.includes("\n") || canonicalPath.includes("\0")) {
    throw new Error(`${label} path cannot be represented safely as a Docker bind mount`);
  }
  return canonicalPath;
}
function dockerBaseArgs(config, targetDirectory, canaryDirectory, containerName2) {
  const target2 = mountedPath(targetDirectory, "target");
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
    `type=bind,src=${target2},dst=/target,readonly`,
    "--mount",
    `type=bind,src=${canaries},dst=/canaries,readonly`
  ];
  for (const name2 of PROXY_NAMES) args.push("--env", `${name2}=`);
  return args;
}
function imageDigest2(config) {
  return config.runner.image.slice(config.runner.image.lastIndexOf("@") + 1);
}
function containerName() {
  return `agent-vigil-upgrade-${randomBytes2(12).toString("hex")}`;
}
function forceRemoveAndVerify(client, name2) {
  const removed = spawnSync3(client.executable, dockerArgs(
    client,
    ["container", "rm", "--force", "--volumes", name2]
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
    dockerArgs(client, ["container", "ls", "--all", "--filter", `name=^/${name2}$`, "--format", "{{.ID}}"]),
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
  const name2 = containerName();
  let args;
  try {
    args = dockerBaseArgs(config, targetDirectory, canaryDirectory, name2);
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
    cleanup = forceRemoveAndVerify(client, name2);
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
  const name2 = containerName();
  let args;
  try {
    args = dockerBaseArgs(config, targetDirectory, canaryDirectory, name2);
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
    cleanup = forceRemoveAndVerify(client, name2);
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
  return `sha256:${createHash16("sha256").update(value).digest("hex")}`;
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
  const requested = resolve15(path);
  const status = lstatSync5(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${label} must be a regular directory, not a symbolic link`);
  }
  return realpathSync7(requested);
}
function assertDisjointRoots(roots) {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const [leftLabel, leftPath] = roots[left];
      const [rightLabel, rightPath] = roots[right];
      const leftToRight = relative9(leftPath, rightPath);
      const rightToLeft = relative9(rightPath, leftPath);
      const inside2 = (rel) => rel === "" || !isAbsolute6(rel) && rel !== ".." && !rel.startsWith(`..${sep8}`);
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
      resolve15(input.repository, config.canaryDirectory),
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
  const privateKey = createPrivateKey3(readFileSync17(privateKeyPath));
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
    const selected = publicKeyPath ? createPublicKey3(readFileSync17(publicKeyPath)) : embedded;
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
  const safe = (value) => terminalSafe(value);
  const lines = [
    `Agent Vigil Upgrade Guard ${safe(receipt.vigilVersion)}`,
    `  component: ${safe(receipt.component.name)}`,
    `  versions:  ${safe(receipt.current?.version ?? "unknown")} -> ${safe(receipt.candidate?.version ?? "unknown")}`,
    `  runner:    ${safe(receipt.runner.image)}`,
    `  canaries:  ${receipt.summary.comparedCanaries} comparable; ${receipt.summary.changedCanaries} changed`,
    `  surfaces:  ${receipt.summary.changedCapabilities} capability class change(s)`,
    `  ${safe(receipt.summary.verdict)} \xB7 ${safe(receipt.receiptHash)}`
  ];
  for (const reason of receipt.summary.reasons) lines.push(`  ${receipt.summary.verdict === "SAFE" ? "\u2713" : receipt.summary.verdict === "CHANGED" ? "!" : "?"} ${safe(reason)}`);
  lines.push("  SAFE is bounded to these exact artifacts, canaries, and contained runner; it is not a universal safety claim.");
  return `${lines.join("\n")}
`;
}
function html3(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function renderBreakageIndex(entries) {
  const ordered = [...entries].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  const rows = ordered.map((entry) => `<tr>
    <td><strong>${html3(entry.component.name)}</strong><small>${html3(entry.component.ecosystem)}</small></td>
    <td>${html3(entry.component.currentVersion)} <span aria-hidden="true">\u2192</span> ${html3(entry.component.candidateVersion)}</td>
    <td><span class="status ${entry.verdict.toLowerCase()}">${html3(entry.verdict)}</span></td>
    <td>${entry.canaries.filter((canary) => canary.matched).length}/${entry.canaries.length}</td>
    <td>${html3(entry.changedCapabilities.join(", ") || "none observed")}</td>
    <td><code>${html3(entry.entryHash.slice(0, 22))}\u2026</code></td>
  </tr>`).join("\n");
  const safe = ordered.filter((entry) => entry.verdict === "SAFE").length;
  const changed = ordered.filter((entry) => entry.verdict === "CHANGED").length;
  const hold2 = ordered.filter((entry) => entry.verdict === "HOLD").length;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Agent compatibility evidence</title><style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{max-width:1120px;margin:0 auto;padding:48px 24px;background:#07111f;color:#e7eef8}h1{font-size:clamp(2rem,5vw,4rem);margin:0 0 12px}.lede{max-width:760px;color:#a9b8ca;font-size:1.1rem;line-height:1.6}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:32px 0}.card{padding:20px;border:1px solid #2a3a50;border-radius:16px;background:#0d1a2b}.card strong{display:block;font-size:2rem}.table{overflow:auto;border:1px solid #2a3a50;border-radius:16px}table{width:100%;border-collapse:collapse;min-width:760px}th,td{text-align:left;padding:15px;border-bottom:1px solid #213147}th{color:#93a7bf;font-size:.78rem;text-transform:uppercase;letter-spacing:.08em}td small{display:block;color:#7f94ac;margin-top:4px}.status{font-weight:800}.safe{color:#69e6a6}.changed{color:#ffcb6b}.hold{color:#ff8e9b}code{color:#b8c7db}footer{margin-top:28px;color:#8598ae;font-size:.9rem}@media(max-width:640px){body{padding:28px 16px}.cards{grid-template-columns:1fr}}
</style></head><body><main><h1>Agent compatibility evidence</h1>
<p class="lede">Signed, privacy-minimized results for exact coding-agent dependency version pairs. SAFE means no material change was detected by the recorded canaries under the recorded contained runner\u2014not that an update is universally safe.</p>
<section class="cards" aria-label="Verdict counts"><div class="card"><strong>${safe}</strong>SAFE</div><div class="card"><strong>${changed}</strong>CHANGED</div><div class="card"><strong>${hold2}</strong>HOLD</div></section>
<section class="table"><table><thead><tr><th>Component</th><th>Version pair</th><th>Verdict</th><th>Matched canaries</th><th>Changed surfaces</th><th>Entry commitment</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No signed entries were supplied.</td></tr>'}</tbody></table></section>
<footer>Generated by Agent Vigil Upgrade Guard. Raw repositories, commands, outputs, prompts, paths, and secrets are excluded from public entries.</footer></main></body></html>`;
}

// src/upgrade/setup.ts
import { execFileSync as execFileSync12 } from "node:child_process";
import {
  chmodSync as chmodSync2,
  existsSync as existsSync6,
  lstatSync as lstatSync6,
  mkdirSync as mkdirSync4,
  readFileSync as readFileSync18,
  realpathSync as realpathSync8
} from "node:fs";
import { dirname as dirname7, join as join7, relative as relative10, resolve as resolve16, sep as sep9 } from "node:path";
var DEFAULT_UPGRADE_DIRECTORY = ".agent-vigil/upgrade";
var DEFAULT_UPGRADE_CONFIG = `${DEFAULT_UPGRADE_DIRECTORY}/config.json`;
var DEFAULT_UPGRADE_RECEIPT = `${DEFAULT_UPGRADE_DIRECTORY}/last-receipt.json`;
var DEFAULT_RUNNER_IMAGE = "node:22.22.3-bookworm-slim@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752";
function ensureRepository(path) {
  const requested = resolve16(path);
  const status = lstatSync6(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("--repo must be a regular directory, not a symbolic link");
  const repository2 = realpathSync8(requested);
  try {
    const prefix = execFileSync12("git", ["rev-parse", "--show-prefix"], {
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
  const target2 = resolve16(repository2, path);
  const rel = relative10(repository2, target2);
  if (rel === ".." || rel.startsWith(`..${sep9}`)) throw new Error("upgrade setup path escaped the repository");
  return target2;
}
function ensurePrivateDirectory(repository2, target2) {
  const rel = relative10(repository2, target2);
  if (rel === ".." || rel.startsWith(`..${sep9}`)) throw new Error("upgrade setup directory escaped the repository");
  let current = repository2;
  for (const component of rel.split(sep9).filter(Boolean)) {
    current = join7(current, component);
    if (existsSync6(current)) {
      const status = lstatSync6(current);
      if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`refusing unsafe setup directory: ${current}`);
    } else {
      mkdirSync4(current, { mode: 448 });
    }
    if (process.platform !== "win32") chmodSync2(current, 448);
  }
}
function inferredName(repository2) {
  const manifest = join7(repository2, "package.json");
  try {
    const value = JSON.parse(readFileSync18(manifest, "utf8"));
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
    const status = lstatSync6(path);
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
  const canaries = join7(root, "canaries");
  ensurePrivateDirectory(repository2, canaries);
  const result5 = { created: [], kept: [] };
  writeScaffold2(join7(root, ".gitignore"), "*\n!.gitignore\n", force, result5);
  writeScaffold2(join7(root, "config.json"), configTemplate(repository2), force, result5);
  writeScaffold2(join7(canaries, "template-canary.mjs"), CANARY_TEMPLATE, force, result5);
  return result5;
}
function doctorUpgrade(repositoryPath, configPath, dockerBin = "docker") {
  const repository2 = ensureRepository(repositoryPath);
  const selectedConfig = configPath ? resolve16(configPath) : join7(repository2, DEFAULT_UPGRADE_CONFIG);
  const rel = relative10(repository2, selectedConfig);
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
  vigil upgrade check --current <dir> --candidate <dir> [--repo <path>] [--config <path>] [--output <private.json>] [--public-output <entry.json> --signing-key <key>] [--docker-bin <path>]
  vigil upgrade verify <entry.json> [--public-key <path>]
  vigil upgrade index <entry.json>... --output <index.html> --public-key <path>

Exit codes: 0 SAFE/verified \xB7 1 CHANGED/invalid signature \xB7 2 HOLD or usage error`;
}
function option(args, name2) {
  const indexes = args.flatMap((arg, index) => arg === name2 ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name2} may be supplied only once`);
  if (!indexes.length) return void 0;
  const value = args[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name2} requires a value`);
  return value;
}
function assertKnown(args, values, flags = [], allowPositionals = false) {
  const allowed2 = /* @__PURE__ */ new Set([...values, ...flags]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      if (!allowPositionals) throw new Error(`unexpected positional argument: ${arg}`);
      continue;
    }
    if (!allowed2.has(arg)) throw new Error(`unknown argument: ${arg}`);
    if (values.includes(arg)) index += 1;
  }
}
function repository(args) {
  return resolve17(option(args, "--repo") ?? ".");
}
function insideRepository(repositoryPath, value, label) {
  const repository2 = realpathSync9(repositoryPath);
  const path = resolve17(repository2, value);
  const rel = relative11(repository2, path);
  if (rel === ".." || rel.startsWith(`..${sep10}`)) throw new Error(`${label} must remain inside --repo`);
  return path;
}
function outputIdentity(path) {
  const parent = realpathSync9(dirname8(resolve17(path)));
  const status = statSync9(parent, { bigint: true });
  const name2 = basename5(path);
  if (!/^[A-Za-z0-9._-]+$/.test(name2) || name2.endsWith(".") || name2.endsWith(" ") || name2.includes("~")) {
    throw new Error(`output basename is not portable and collision-safe: ${name2}`);
  }
  return `${status.dev}:${status.ino}:${name2.toUpperCase()}`;
}
function assertDistinctOutputs(paths) {
  const identities = paths.map(outputIdentity);
  if (new Set(identities).size !== identities.length) throw new Error("requested output paths resolve to the same filesystem entry");
}
function pathIdentities(path) {
  const requested = resolve17(path);
  const identities = [outputIdentity(requested)];
  const canonical3 = realpathSync9(requested);
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
    const root = realpathSync9(rootPath);
    for (const output of outputs) {
      const parent = realpathSync9(dirname8(resolve17(output)));
      const target2 = resolve17(parent, basename5(output));
      const rel = relative11(root, target2);
      if (rel === "" || !isAbsolute7(rel) && rel !== ".." && !rel.startsWith(`..${sep10}`)) {
        throw new Error("requested output path must remain outside current, candidate, and canary input trees");
      }
    }
  }
}
function readPublicEntry(path) {
  return validatePublicCompatibilityEntry(readBoundedJson(path, 512 * 1024, "public compatibility entry"));
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
  const currentDirectory = resolve17(current);
  const candidateDirectory = resolve17(candidate);
  const canaryDirectory = trustedDirectoryInside(
    repo,
    resolve17(repo, loadedConfig.canaryDirectory),
    "canary directory"
  );
  const output = insideRepository(repo, option(args, "--output") ?? DEFAULT_UPGRADE_RECEIPT, "--output");
  const publicOption = option(args, "--public-output");
  const signingKey = option(args, "--signing-key");
  if (Boolean(publicOption) !== Boolean(signingKey)) throw new Error("--public-output and --signing-key must be supplied together");
  const publicOutput = publicOption ? resolve17(publicOption) : void 0;
  const outputs = [output, ...publicOutput ? [publicOutput] : []];
  assertDistinctOutputs(outputs);
  assertOutputsDoNotAliasInputs(outputs, [trustedConfig, ...signingKey ? [resolve17(signingKey)] : []]);
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
    const entry = createPublicCompatibilityEntry(receipt, resolve17(signingKey));
    writePrivateFileAtomic(publicOutput, `${JSON.stringify(entry, null, 2)}
`);
  }
  process.stdout.write(renderUpgradeReceipt(receipt));
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
  const result5 = verifyPublicCompatibilityEntry(readPublicEntry(resolve17(entries[0])), option(args, "--public-key") ? resolve17(option(args, "--public-key")) : void 0);
  console.log(JSON.stringify(result5));
  return result5.hashValid && result5.signatureValid === true ? 0 : 1;
}
function runIndex(args) {
  assertKnown(args, ["--output", "--public-key"], ["--help"], true);
  if (args.includes("--help")) {
    console.log(usage());
    return 0;
  }
  const inputs = positional(args, ["--output", "--public-key"]);
  const outputOption = option(args, "--output");
  const publicKey = option(args, "--public-key");
  if (!inputs.length || !outputOption || !publicKey) throw new Error("upgrade index requires entries, --output <index.html>, and --public-key <path>");
  if (inputs.length > 512) throw new Error("upgrade index accepts at most 512 entries");
  const output = resolve17(outputOption);
  const inputPaths = inputs.map((path) => resolve17(path));
  const publicKeyPath = resolve17(publicKey);
  assertOutputsDoNotAliasInputs([output], [...inputPaths, publicKeyPath]);
  const entries = inputs.map((path) => {
    const entry = readPublicEntry(resolve17(path));
    const checked2 = verifyPublicCompatibilityEntry(entry, publicKeyPath);
    if (!checked2.hashValid || checked2.signatureValid !== true) throw new Error(`public entry failed verification: ${path}`);
    return entry;
  });
  writePrivateFileAtomic(output, renderBreakageIndex(entries));
  console.log(`Wrote ${entries.length} verified compatibility entr${entries.length === 1 ? "y" : "ies"} to ${terminalSafe(output)}`);
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
    if (command === "check") return runCheck(rest);
    if (command === "verify") return runVerify(rest);
    if (command === "index") return runIndex(rest);
    throw new Error(`unknown upgrade command: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`agent-vigil upgrade: ${terminalSafe(message)}`);
    return 2;
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
import { createHash as createHash17 } from "node:crypto";
import { execFileSync as execFileSync13 } from "node:child_process";
import {
  existsSync as existsSync7,
  lstatSync as lstatSync8,
  mkdirSync as mkdirSync5,
  mkdtempSync as mkdtempSync3,
  realpathSync as realpathSync10,
  rmSync as rmSync2,
  writeFileSync as writeFileSync5
} from "node:fs";
import { tmpdir as tmpdir3 } from "node:os";
import { dirname as dirname9, isAbsolute as isAbsolute8, join as join8, relative as relative12, resolve as resolve18, sep as sep11 } from "node:path";
var FIXED_COMMIT_EPOCH = Date.parse("2000-01-01T00:00:00Z") / 1e3;
function git8(repo, args, env) {
  return execFileSync13("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...env ? { env } : {}
  }).trim();
}
function digest3(value) {
  return `sha256:${createHash17("sha256").update(canonical(value)).digest("hex")}`;
}
function safeError(error, redactions = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of redactions.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(value, value.includes("control-proof-") ? "<temporary-directory>" : "<source-repository>");
  }
  return terminalSafe(message.replace(/\s+/g, " ").slice(0, 400));
}
function assertDisposableClone(root, repo) {
  const realRoot = realpathSync10(root);
  const realRepo = realpathSync10(repo);
  if (!realRepo.startsWith(`${realRoot}${sep11}`) || !existsSync7(join8(realRepo, ".git"))) {
    throw new Error("refused to mutate a directory outside the disposable control-proof clone");
  }
}
function resetClone(root, repo, sourceCommit) {
  assertDisposableClone(root, repo);
  git8(repo, ["reset", "--hard", sourceCommit]);
  git8(repo, ["clean", "-fdx"]);
}
function safeWrite(repo, gitPath, content) {
  if (!gitPath || isAbsolute8(gitPath) || gitPath.includes("\\")) throw new Error("control-proof path must be repository-relative");
  const target2 = resolve18(repo, gitPath);
  const fromRoot = relative12(resolve18(repo), target2);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep11}`)) throw new Error("control-proof path escaped the clone");
  let current = resolve18(repo);
  for (const part of dirname9(fromRoot).split(sep11).filter((item2) => item2 && item2 !== ".")) {
    current = join8(current, part);
    if (existsSync7(current) && (!lstatSync8(current).isDirectory() || lstatSync8(current).isSymbolicLink())) {
      rmSync2(current, { recursive: true, force: true });
    }
    mkdirSync5(current, { recursive: true });
  }
  if (existsSync7(target2)) rmSync2(target2, { recursive: true, force: true });
  writeFileSync5(target2, content, { encoding: "utf8", mode: 384 });
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
  const sourceRepo = realpathSync10(resolve18(repo));
  const sourceCommit = git8(sourceRepo, ["rev-parse", "--verify", `${base}^{commit}`]);
  const root = mkdtempSync3(join8(tmpdir3(), "agent-vigil-control-proof-"));
  const clone = join8(root, "repo");
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
    execFileSync13("git", ["clone", "--quiet", "--no-local", "--no-checkout", sourceRepo, clone], {
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
    rmSync2(root, { recursive: true, force: true });
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

// src/control-proof-attestation.ts
import { createHash as createHash18 } from "node:crypto";
import { execFileSync as execFileSync14 } from "node:child_process";
import { closeSync as closeSync2, constants as constants3, fstatSync as fstatSync2, lstatSync as lstatSync9, openSync as openSync2, readFileSync as readFileSync20 } from "node:fs";
import { basename as basename6, resolve as resolve19 } from "node:path";
var CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE = "https://sulmusic2-star.github.io/agent-vigil/control-proof-predicate-v1.schema.json";
var SHA2562 = /^sha256:[0-9a-f]{64}$/;
var COMMIT = /^[0-9a-f]{40}$/;
var PLAIN = /^[^\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+$/u;
var EXPECTED = /* @__PURE__ */ new Set(["PASS", "BLOCK", "HOLD"]);
var ACTUAL = /* @__PURE__ */ new Set(["PASS", "BLOCK", "HOLD", "ERROR"]);
function sha2563(value) {
  return `sha256:${createHash18("sha256").update(value).digest("hex")}`;
}
function exactKeys3(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function plain(value, label, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum || !PLAIN.test(value)) {
    throw new Error(`${label} must be plain text between 1 and ${maximum} characters`);
  }
  return value;
}
function timestamp2(value, label) {
  const selected = plain(value, label, 40);
  const parsed = Date.parse(selected);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== selected) throw new Error(`${label} must be canonical RFC3339 UTC`);
  return selected;
}
function count2(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}
function validateControlProof(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("control proof must be an object");
  const proof = value;
  if (!exactKeys3(proof, ["schemaVersion", "vigilVersion", "status", "sourceCommit", "generatedAt", "receiptHash", "challenges", "summary", "reproduction", "limits"])) {
    throw new Error("control proof has unsupported or missing fields");
  }
  if (proof.schemaVersion !== "agent-vigil-control-proof/v1") throw new Error("unsupported control proof schema");
  const vigilVersion = plain(proof.vigilVersion, "control proof vigilVersion", 80);
  if (proof.status !== "PASS" && proof.status !== "HOLD") throw new Error("control proof status must be PASS or HOLD");
  const sourceCommit = plain(proof.sourceCommit, "control proof sourceCommit", 40);
  if (!COMMIT.test(sourceCommit)) throw new Error("control proof sourceCommit must be a full lowercase commit SHA");
  const generatedAt = timestamp2(proof.generatedAt, "control proof generatedAt");
  if (!Array.isArray(proof.challenges) || proof.challenges.length < 1 || proof.challenges.length > 100) {
    throw new Error("control proof must contain 1 to 100 challenges");
  }
  const ids = /* @__PURE__ */ new Set();
  const challenges = proof.challenges.map((value2, index) => {
    if (!value2 || typeof value2 !== "object" || Array.isArray(value2)) throw new Error(`control proof challenge ${index} must be an object`);
    const item2 = value2;
    if (!exactKeys3(item2, ["id", "claim", "expected", "actual", "passed", "base", "head", "evidence"])) {
      throw new Error(`control proof challenge ${index} has unsupported or missing fields`);
    }
    const id = plain(item2.id, `control proof challenge ${index} id`, 80);
    if (!/^[A-Za-z0-9_.-]+$/.test(id) || ids.has(id)) throw new Error(`control proof challenge ${index} id is invalid or duplicated`);
    ids.add(id);
    const claim = plain(item2.claim, `control proof challenge ${index} claim`, 400);
    const evidence = plain(item2.evidence, `control proof challenge ${index} evidence`, 1e3);
    if (!EXPECTED.has(item2.expected) || !ACTUAL.has(item2.actual)) {
      throw new Error(`control proof challenge ${index} has an unsupported decision`);
    }
    if (typeof item2.passed !== "boolean" || item2.passed !== (item2.expected === item2.actual)) {
      throw new Error(`control proof challenge ${index} has inconsistent decision fields`);
    }
    const base = plain(item2.base, `control proof challenge ${index} base`, 40);
    const head = plain(item2.head, `control proof challenge ${index} head`, 40);
    if (!COMMIT.test(base) || !COMMIT.test(head)) throw new Error(`control proof challenge ${index} must use full lowercase commit SHAs`);
    return {
      id,
      claim,
      expected: item2.expected,
      actual: item2.actual,
      passed: item2.passed,
      base,
      head,
      evidence
    };
  });
  if (!proof.summary || typeof proof.summary !== "object" || Array.isArray(proof.summary) || !exactKeys3(proof.summary, ["passed", "total"])) throw new Error("control proof summary is invalid");
  const summary = proof.summary;
  const passed = count2(summary.passed, "control proof summary.passed");
  const total = count2(summary.total, "control proof summary.total");
  if (passed !== challenges.filter((item2) => item2.passed).length || total !== challenges.length) throw new Error("control proof summary does not match its challenges");
  if (proof.status !== (passed === total ? "PASS" : "HOLD")) throw new Error("control proof status does not match its challenges");
  const reproduction = plain(proof.reproduction, "control proof reproduction", 400);
  if (!Array.isArray(proof.limits) || proof.limits.length > 32) throw new Error("control proof limits must be an array with at most 32 entries");
  const limits = proof.limits.map((item2, index) => plain(item2, `control proof limit ${index}`, 600));
  const receiptHash = plain(proof.receiptHash, "control proof receiptHash", 71);
  if (!SHA2562.test(receiptHash)) throw new Error("control proof receiptHash must be a lowercase SHA-256 identifier");
  const parsed = {
    schemaVersion: "agent-vigil-control-proof/v1",
    vigilVersion,
    status: proof.status,
    sourceCommit,
    generatedAt,
    receiptHash,
    challenges,
    summary: { passed, total },
    reproduction,
    limits
  };
  const { receiptHash: _receiptHash, ...payload } = parsed;
  if (sha2563(canonical(payload)) !== receiptHash) throw new Error("control proof content does not match receiptHash");
  return parsed;
}
function loadControlProof(path) {
  const absolute = resolve19(path);
  const metadata = lstatSync9(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("control proof must be a regular file, not a symbolic link");
  if (metadata.size > 2 * 1024 * 1024) throw new Error("control proof exceeds the 2 MB attestation limit");
  const descriptor = openSync2(absolute, constants3.O_RDONLY | (constants3.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fstatSync2(descriptor);
    if (!opened.isFile() || opened.size !== metadata.size) throw new Error("control proof changed while it was being opened");
    bytes = readFileSync20(descriptor);
    if (bytes.length !== opened.size) throw new Error("control proof changed while it was being read");
  } finally {
    closeSync2(descriptor);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("control proof is not valid JSON");
  }
  return { proof: validateControlProof(parsed), bytes, fileSha256: sha2563(bytes) };
}
function challengeSetSha256(proof) {
  return sha2563(canonical(proof.challenges.map(({ id, expected, actual, passed }) => ({ id, expected, actual, passed }))));
}
function buildControlProofPredicate(path) {
  const { proof, fileSha256 } = loadControlProof(path);
  return {
    predicateVersion: "1",
    proof: {
      schemaVersion: "agent-vigil-control-proof/v1",
      receiptHash: proof.receiptHash,
      fileSha256,
      status: proof.status,
      sourceCommit: proof.sourceCommit,
      generatedAt: proof.generatedAt,
      vigilVersion: proof.vigilVersion,
      passed: proof.summary.passed,
      total: proof.summary.total,
      challengeSetSha256: challengeSetSha256(proof)
    },
    privacy: { claimsIncluded: false, evidenceIncluded: false, repositoryPathIncluded: false }
  };
}
function writeControlProofPredicate(path, output) {
  const predicate = buildControlProofPredicate(path);
  writePrivateFileAtomic(resolve19(output), `${JSON.stringify(predicate, null, 2)}
`);
  return predicate;
}
function statementsFromGh2(value) {
  const roots = Array.isArray(value) ? value : [value];
  const statements = [];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    const record5 = root;
    const verification2 = record5.verificationResult;
    const statement = verification2 && typeof verification2 === "object" ? verification2.statement : record5.statement ?? record5;
    if (statement && typeof statement === "object") statements.push(statement);
  }
  return statements;
}
function subjectMatches2(statement, expectedName, expectedDigest) {
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  return subjects.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const subject = entry;
    const digest8 = subject.digest && typeof subject.digest === "object" ? subject.digest : {};
    const name2 = String(subject.name ?? "");
    return (name2 === expectedName || name2.endsWith(`/${expectedName}`)) && `sha256:${String(digest8.sha256 ?? "")}` === expectedDigest;
  });
}
function predicateMatches2(value, proof, fileSha256) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  const body = candidate.proof;
  const privacy = candidate.privacy;
  return candidate.predicateVersion === "1" && exactKeys3(candidate, ["predicateVersion", "privacy", "proof"]) && Boolean(body) && exactKeys3(body, ["challengeSetSha256", "fileSha256", "generatedAt", "passed", "receiptHash", "schemaVersion", "sourceCommit", "status", "total", "vigilVersion"]) && Boolean(privacy) && exactKeys3(privacy, ["claimsIncluded", "evidenceIncluded", "repositoryPathIncluded"]) && body?.schemaVersion === "agent-vigil-control-proof/v1" && body.receiptHash === proof.receiptHash && body.fileSha256 === fileSha256 && body.status === proof.status && body.sourceCommit === proof.sourceCommit && body.generatedAt === proof.generatedAt && body.vigilVersion === proof.vigilVersion && body.passed === proof.summary.passed && body.total === proof.summary.total && body.challengeSetSha256 === challengeSetSha256(proof) && privacy?.claimsIncluded === false && privacy.evidenceIncluded === false && privacy.repositoryPathIncluded === false;
}
function verifyGhControlProofAttestationOutput(path, ghOutput) {
  const { proof, fileSha256 } = loadControlProof(path);
  const statements = statementsFromGh2(ghOutput);
  let subjectDigestValid = false;
  let predicateValid = false;
  let matched;
  for (const statement of statements) {
    if (statement.predicateType !== CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE) continue;
    const subjectOk = subjectMatches2(statement, basename6(path), fileSha256);
    const predicateOk = predicateMatches2(statement.predicate, proof, fileSha256);
    subjectDigestValid ||= subjectOk;
    predicateValid ||= predicateOk;
    if (subjectOk && predicateOk) matched = statement.predicate;
  }
  const { receiptHash: _receiptHash, ...payload } = proof;
  const proofHashValid = sha2563(canonical(payload)) === proof.receiptHash;
  return {
    valid: proofHashValid && subjectDigestValid && predicateValid && Boolean(matched),
    proofHashValid,
    subjectDigestValid,
    predicateValid,
    statementCount: statements.length,
    ...matched ? { predicate: matched } : {}
  };
}
var runGitHubCli2 = (args) => execFileSync14("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function verifyGitHubControlProofAttestation(path, repository2, trust = {}, executeGh = runGitHubCli2) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository2)) throw new Error("repository must be owner/name");
  const signerWorkflow = trust.signerWorkflow ?? `${repository2}/.github/workflows/agent-vigil-control-proof.yml`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/i.test(signerWorkflow)) {
    throw new Error("signer workflow must be owner/name/.github/workflows/file.yml");
  }
  if (trust.signerDigest !== void 0 && !COMMIT.test(trust.signerDigest)) throw new Error("signer digest must be a full lowercase commit SHA");
  const { proof } = loadControlProof(path);
  const command = [
    "attestation",
    "verify",
    resolve19(path),
    "--repo",
    repository2,
    "--predicate-type",
    CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE,
    "--signer-workflow",
    signerWorkflow,
    "--source-digest",
    proof.sourceCommit,
    ...trust.signerDigest ? ["--signer-digest", trust.signerDigest] : [],
    "--format",
    "json",
    ...!trust.allowSelfHosted ? ["--deny-self-hosted-runners"] : []
  ];
  let raw;
  try {
    raw = executeGh(command);
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    throw new Error(`GitHub control-proof attestation verification failed${detail ? `: ${detail}` : "; install and authenticate a current GitHub CLI"}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GitHub CLI returned unreadable control-proof attestation JSON");
  }
  return verifyGhControlProofAttestationOutput(path, parsed);
}

// src/control-proof-workflow.ts
import { execFileSync as execFileSync15 } from "node:child_process";
import { existsSync as existsSync8, mkdirSync as mkdirSync6, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname10, resolve as resolve20 } from "node:path";
var CHECKOUT_COMMIT = "11d5960a326750d5838078e36cf38b85af677262";
var UPLOAD_COMMIT = "ea165f8d65b6e75b540449e92b4886f43607fa02";
var FULL_COMMIT = /^[0-9a-f]{40}$/;
function keylessControlProofWorkflow(actionCommit) {
  return `# agent-vigil-keyless-control-proof/v1
name: Agent Vigil control proof

on:
  workflow_dispatch:
  schedule:
    - cron: "17 9 * * 1"

permissions:
  contents: read
  id-token: write
  attestations: write
  artifact-metadata: write

jobs:
  prove:
    name: Challenge the installed control
    runs-on: ubuntu-latest
    steps:
      - name: Check out the exact source commit
        uses: actions/checkout@${CHECKOUT_COMMIT}
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: \${{ github.sha }}
      - id: vigil
        name: Run and sign the control proof
        uses: sulmusic2-star/agent-vigil@${actionCommit}
        with:
          mode: prove
          attest: true
          repo: .
          head: \${{ github.sha }}
      - name: Retain the proof and GitHub attestation bundle
        if: always() && steps.vigil.outputs.report != ''
        uses: actions/upload-artifact@${UPLOAD_COMMIT}
        with:
          name: agent-vigil-control-proof-\${{ github.run_id }}
          if-no-files-found: error
          retention-days: 90
          path: |
            \${{ steps.vigil.outputs.report }}
            \${{ steps.vigil.outputs.attestation-bundle }}
`;
}
function assertRepository(root) {
  try {
    execFileSync15("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error(`not a Git repository: ${root}`);
  }
}
function installKeylessControlProofAction(repo, actionCommit, force = false) {
  const root = resolve20(repo);
  assertRepository(root);
  if (!FULL_COMMIT.test(actionCommit)) throw new Error("--action-ref must be a full lowercase Agent Vigil commit SHA");
  const workflow3 = ".github/workflows/agent-vigil-control-proof.yml";
  const target2 = resolve20(root, workflow3);
  const result5 = { created: [], kept: [], actionCommit, workflow: workflow3 };
  if (existsSync8(target2) && !force) {
    result5.kept.push(workflow3);
    return result5;
  }
  mkdirSync6(dirname10(target2), { recursive: true });
  writeFileSync6(target2, keylessControlProofWorkflow(actionCommit));
  result5.created.push(workflow3);
  return result5;
}

// src/certification.ts
import { createHash as createHash20 } from "node:crypto";
import { existsSync as existsSync9, lstatSync as lstatSync10, readFileSync as readFileSync22 } from "node:fs";

// src/signed-control-proof.ts
import {
  createHash as createHash19,
  createPrivateKey as createPrivateKey4,
  createPublicKey as createPublicKey4,
  sign as sign4,
  verify as verify4
} from "node:crypto";
import { readFileSync as readFileSync21 } from "node:fs";
var SIGNED_CONTROL_PROOF_SCHEMA = "control-proof/signed-challenge-v1";
function digest4(value) {
  return `sha256:${createHash19("sha256").update(canonical(value)).digest("hex")}`;
}
function record3(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys4(value, keys, label) {
  const expected = [...keys].sort();
  if (canonical(Object.keys(value).sort()) !== canonical(expected)) throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
}
function text2(value, label, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} must be plain text between 1 and ${maximum} characters`);
  }
  return value.trim();
}
function name(value, label) {
  const parsed = text2(value, label, 80);
  if (!/^[A-Za-z0-9_.-]+$/.test(parsed)) throw new Error(`${label} must contain only letters, numbers, dot, underscore, or hyphen`);
  return parsed;
}
function timestamp3(value, label) {
  const parsed = text2(value, label, 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  }
  return parsed;
}
function sha2564(value, label) {
  const parsed = text2(value, label, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label} must be sha256:<64 lowercase hex characters>`);
  return parsed;
}
function commitSha(value, label) {
  const parsed = text2(value, label, 64);
  if (!/^[a-f0-9]{40}$/.test(parsed)) throw new Error(`${label} must be a full lowercase Git commit SHA`);
  return parsed;
}
function base64(value, label, expectedBytes) {
  const parsed = text2(value, label, 8192);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parsed)) throw new Error(`${label} must be canonical base64`);
  const decoded = Buffer.from(parsed, "base64");
  if (decoded.toString("base64") !== parsed || expectedBytes !== void 0 && decoded.length !== expectedBytes) throw new Error(`${label} has an invalid length or encoding`);
  return decoded;
}
function parsePayload(input) {
  const payload = record3(input, "signed proof payload");
  exactKeys4(payload, ["control", "sourceCommit", "generatedAt", "status", "challenges", "summary", "limits"], "signed proof payload");
  const control = record3(payload.control, "signed proof payload.control");
  exactKeys4(control, ["vendor", "product", "version"], "signed proof payload.control");
  if (payload.status !== "PASS" && payload.status !== "HOLD") throw new Error("signed proof payload.status must be PASS or HOLD");
  if (!Array.isArray(payload.challenges) || payload.challenges.length === 0 || payload.challenges.length > 100) throw new Error("signed proof payload.challenges must contain 1 to 100 items");
  const ids = /* @__PURE__ */ new Set();
  const challenges = payload.challenges.map((value, index) => {
    const item2 = record3(value, `signed proof payload.challenges[${index}]`);
    exactKeys4(item2, ["id", "expected", "actual", "passed", "evidenceHash"], `signed proof payload.challenges[${index}]`);
    if (!(/* @__PURE__ */ new Set(["PASS", "BLOCK", "HOLD"])).has(String(item2.expected))) throw new Error(`signed proof payload.challenges[${index}].expected is invalid`);
    if (!(/* @__PURE__ */ new Set(["PASS", "BLOCK", "HOLD", "ERROR"])).has(String(item2.actual))) throw new Error(`signed proof payload.challenges[${index}].actual is invalid`);
    if (typeof item2.passed !== "boolean" || item2.passed !== (item2.actual === item2.expected)) throw new Error(`signed proof payload.challenges[${index}] has inconsistent decision fields`);
    const id = name(item2.id, `signed proof payload.challenges[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate signed proof challenge: ${id}`);
    ids.add(id);
    return {
      id,
      expected: item2.expected,
      actual: item2.actual,
      passed: item2.passed,
      evidenceHash: sha2564(item2.evidenceHash, `signed proof payload.challenges[${index}].evidenceHash`)
    };
  });
  const summary = record3(payload.summary, "signed proof payload.summary");
  exactKeys4(summary, ["passed", "total"], "signed proof payload.summary");
  const passed = challenges.filter((item2) => item2.passed).length;
  if (summary.passed !== passed || summary.total !== challenges.length) throw new Error("signed proof payload.summary does not match its challenges");
  if (payload.status !== (passed === challenges.length ? "PASS" : "HOLD")) throw new Error("signed proof payload.status does not match its challenges");
  if (!Array.isArray(payload.limits) || payload.limits.length > 100) throw new Error("signed proof payload.limits must be an array with at most 100 items");
  return {
    control: {
      vendor: name(control.vendor, "signed proof payload.control.vendor"),
      product: name(control.product, "signed proof payload.control.product"),
      version: text2(control.version, "signed proof payload.control.version", 160)
    },
    sourceCommit: commitSha(payload.sourceCommit, "signed proof payload.sourceCommit"),
    generatedAt: timestamp3(payload.generatedAt, "signed proof payload.generatedAt"),
    status: payload.status,
    challenges,
    summary: { passed, total: challenges.length },
    limits: payload.limits.map((item2, index) => text2(item2, `signed proof payload.limits[${index}]`, 1e3))
  };
}
function ed25519PublicKey(der, label) {
  let key;
  try {
    key = createPublicKey4({ key: der, type: "spki", format: "der" });
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${label} must be Ed25519`);
  return key;
}
function signControlProof(payloadInput, privateKeyPath) {
  const payload = parsePayload(payloadInput);
  const privateKey = createPrivateKey4(readFileSync21(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signed proof private key must be Ed25519");
  const der = publicKeyDer(createPublicKey4(privateKey));
  const payloadHash = digest4(payload);
  return {
    schemaVersion: SIGNED_CONTROL_PROOF_SCHEMA,
    payload,
    payloadHash,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign4(null, Buffer.from(payloadHash), privateKey).toString("base64")
    }
  };
}
function verifySignedControlProof(input, pinnedPublicKeyPath) {
  const root = record3(input, "signed control proof");
  exactKeys4(root, ["schemaVersion", "payload", "payloadHash", "signature"], "signed control proof");
  if (root.schemaVersion !== SIGNED_CONTROL_PROOF_SCHEMA) throw new Error(`signed control proof schemaVersion must be ${SIGNED_CONTROL_PROOF_SCHEMA}`);
  const payload = parsePayload(root.payload);
  const payloadHash = sha2564(root.payloadHash, "signed control proof payloadHash");
  if (digest4(payload) !== payloadHash) throw new Error("signed control proof payload hash is invalid");
  const signature = record3(root.signature, "signed control proof signature");
  exactKeys4(signature, ["algorithm", "keyId", "publicKey", "value"], "signed control proof signature");
  if (signature.algorithm !== "Ed25519") throw new Error("signed control proof signature algorithm must be Ed25519");
  const embeddedDer = base64(signature.publicKey, "signed control proof signature.publicKey");
  const embedded = ed25519PublicKey(embeddedDer, "signed control proof embedded key");
  const embeddedId = signingKeyId(publicKeyDer(embedded));
  const keyId = sha2564(signature.keyId, "signed control proof signature.keyId");
  if (embeddedId !== keyId) throw new Error("signed control proof key ID does not match its embedded key");
  let selected = embedded;
  if (pinnedPublicKeyPath) {
    selected = createPublicKey4(readFileSync21(pinnedPublicKeyPath));
    if (selected.asymmetricKeyType !== "ed25519") throw new Error("pinned signed proof public key must be Ed25519");
    if (signingKeyId(publicKeyDer(selected)) !== keyId) throw new Error("signed control proof signer does not match the pinned public key");
  }
  const value = base64(signature.value, "signed control proof signature.value", 64);
  if (!verify4(null, Buffer.from(payloadHash), selected, value)) throw new Error("signed control proof signature is invalid");
  return {
    schemaVersion: SIGNED_CONTROL_PROOF_SCHEMA,
    payload,
    payloadHash,
    signature: { algorithm: "Ed25519", keyId, publicKey: embeddedDer.toString("base64"), value: value.toString("base64") }
  };
}
function signedControlIdentity(proof) {
  return `${proof.payload.control.vendor}/${proof.payload.control.product}@${proof.signature.keyId}`;
}

// src/certification.ts
var CERTIFICATE_SCHEMA = "agent-vigil-control-certificate/v1";
var CORPUS_ENTRY_SCHEMA = "agent-vigil-control-corpus-entry/v1";
var SIGNED_CERTIFICATE_SCHEMA = "agent-vigil-control-certificate/v2";
var SIGNED_CORPUS_ENTRY_SCHEMA = "agent-vigil-control-corpus-entry/v2";
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
function digest5(value) {
  return `sha256:${createHash20("sha256").update(canonical(value)).digest("hex")}`;
}
function record4(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys5(value, keys, label) {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (canonical(actual) !== canonical(expected)) throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
}
function text3(value, label, maximum = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} must be plain text between 1 and ${maximum} characters`);
  }
  return value;
}
function identifier(value, label) {
  return text3(value, label, 160).replace(/^\s+|\s+$/g, "");
}
function repositoryName(value, label = "repository") {
  const parsed = identifier(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed)) throw new Error(`${label} must be owner/name`);
  return parsed;
}
function timestamp4(value, label) {
  const parsed = text3(value, label, 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    throw new Error(`${label} must be an RFC3339 UTC timestamp`);
  }
  return parsed;
}
function sha2565(value, label) {
  const parsed = text3(value, label, 80);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) throw new Error(`${label} must be sha256:<64 lowercase hex characters>`);
  return parsed;
}
function commitSha2(value, label) {
  const parsed = text3(value, label, 64);
  if (!/^[a-f0-9]{40}$/.test(parsed)) throw new Error(`${label} must be a full lowercase Git commit SHA`);
  return parsed;
}
function challenge(value, index) {
  const item2 = record4(value, `proof.challenges[${index}]`);
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
  const proof = record4(input, "control proof");
  exactKeys5(proof, ["schemaVersion", "vigilVersion", "status", "sourceCommit", "generatedAt", "receiptHash", "challenges", "summary", "reproduction", "limits"], "control proof");
  if (proof.schemaVersion !== "agent-vigil-control-proof/v1") throw new Error("only the verified Agent Vigil control-proof/v1 adapter is currently supported");
  const receiptHash = sha2565(proof.receiptHash, "control proof receiptHash");
  const { receiptHash: _receiptHash, ...payload } = proof;
  if (digest5(payload) !== receiptHash) throw new Error("control proof receipt hash is invalid");
  const generatedAt = timestamp4(proof.generatedAt, "control proof generatedAt");
  const sourceCommit = commitSha2(proof.sourceCommit, "control proof sourceCommit");
  const vigilVersion = identifier(proof.vigilVersion, "control proof vigilVersion");
  const reproduction = text3(proof.reproduction, "control proof reproduction", 1e3);
  if (!Array.isArray(proof.limits) || proof.limits.length > 100) throw new Error("control proof limits must be an array with at most 100 items");
  const limits = proof.limits.map((item2, index) => text3(item2, `control proof limits[${index}]`, 1e3));
  if (proof.status !== "PASS" && proof.status !== "HOLD") throw new Error("control proof status must be PASS or HOLD");
  if (!Array.isArray(proof.challenges) || proof.challenges.length === 0 || proof.challenges.length > 100) throw new Error("control proof challenges must contain 1 to 100 items");
  const ids = /* @__PURE__ */ new Set();
  const parsedChallenges = [];
  for (const [index, raw] of proof.challenges.entries()) {
    const full = record4(raw, `control proof challenges[${index}]`);
    exactKeys5(full, ["id", "claim", "expected", "actual", "passed", "base", "head", "evidence"], `control proof challenges[${index}]`);
    const parsed = challenge({ id: full.id, expected: full.expected, actual: full.actual, passed: full.passed }, index);
    if (ids.has(parsed.id)) throw new Error(`duplicate control proof challenge: ${parsed.id}`);
    if (parsed.passed !== (parsed.actual === parsed.expected)) throw new Error(`control proof challenge ${parsed.id} has inconsistent decision fields`);
    const enriched = {
      ...parsed,
      claim: text3(full.claim, `control proof challenges[${index}].claim`, 500),
      base: commitSha2(full.base, `control proof challenges[${index}].base`),
      head: commitSha2(full.head, `control proof challenges[${index}].head`),
      evidence: text3(full.evidence, `control proof challenges[${index}].evidence`, 1e3)
    };
    ids.add(parsed.id);
    parsedChallenges.push(enriched);
  }
  const summary = record4(proof.summary, "control proof summary");
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
  return { ...payload, certificateHash: digest5(payload) };
}
function validateCertificate(input) {
  const root = record4(input, "certificate");
  exactKeys5(root, ["schemaVersion", "organization", "repository", "requiredCheck", "control", "proof", "certificateHash"], "certificate");
  if (root.schemaVersion !== CERTIFICATE_SCHEMA) throw new Error(`certificate schemaVersion must be ${CERTIFICATE_SCHEMA}`);
  const control = record4(root.control, "certificate.control");
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
  if (digest5(parsed) !== certificateHash) throw new Error("certificate hash is invalid");
  return { ...parsed, certificateHash };
}
function createSignedCertificate(input) {
  const proof = verifySignedControlProof(input.proof, input.publicKeyPath);
  const payload = {
    schemaVersion: SIGNED_CERTIFICATE_SCHEMA,
    organization: identifier(input.organization, "organization"),
    repository: repositoryName(input.repository),
    requiredCheck: identifier(input.requiredCheck, "requiredCheck"),
    control: {
      vendor: proof.payload.control.vendor,
      product: proof.payload.control.product,
      adapter: "signed-control-proof/v1",
      version: proof.payload.control.version,
      keyId: proof.signature.keyId
    },
    proof
  };
  return { ...payload, certificateHash: digest5(payload) };
}
function validateSignedCertificate(input) {
  const root = record4(input, "signed certificate");
  exactKeys5(root, ["schemaVersion", "organization", "repository", "requiredCheck", "control", "proof", "certificateHash"], "signed certificate");
  if (root.schemaVersion !== SIGNED_CERTIFICATE_SCHEMA) throw new Error(`signed certificate schemaVersion must be ${SIGNED_CERTIFICATE_SCHEMA}`);
  const control = record4(root.control, "signed certificate.control");
  exactKeys5(control, ["vendor", "product", "adapter", "version", "keyId"], "signed certificate.control");
  const proof = verifySignedControlProof(root.proof);
  if (control.adapter !== "signed-control-proof/v1") throw new Error("signed certificate adapter is not supported");
  const parsed = {
    schemaVersion: SIGNED_CERTIFICATE_SCHEMA,
    organization: identifier(root.organization, "signed certificate.organization"),
    repository: repositoryName(root.repository, "signed certificate.repository"),
    requiredCheck: identifier(root.requiredCheck, "signed certificate.requiredCheck"),
    control: {
      vendor: identifier(control.vendor, "signed certificate.control.vendor"),
      product: identifier(control.product, "signed certificate.control.product"),
      adapter: identifier(control.adapter, "signed certificate.control.adapter"),
      version: identifier(control.version, "signed certificate.control.version"),
      keyId: sha2565(control.keyId, "signed certificate.control.keyId")
    },
    proof
  };
  if (parsed.control.vendor !== proof.payload.control.vendor || parsed.control.product !== proof.payload.control.product || parsed.control.version !== proof.payload.control.version || parsed.control.keyId !== proof.signature.keyId) {
    throw new Error("signed certificate control identity does not match its verified proof");
  }
  const certificateHash = sha2565(root.certificateHash, "signed certificate.certificateHash");
  if (digest5(parsed) !== certificateHash) throw new Error("signed certificate hash is invalid");
  return { ...parsed, certificateHash };
}
function validateAnyCertificate(input) {
  const root = record4(input, "certificate");
  if (root.schemaVersion === CERTIFICATE_SCHEMA) return validateCertificate(root);
  if (root.schemaVersion === SIGNED_CERTIFICATE_SCHEMA) return validateSignedCertificate(root);
  throw new Error(`certificate schemaVersion must be ${CERTIFICATE_SCHEMA} or ${SIGNED_CERTIFICATE_SCHEMA}`);
}
function parseCorpus(content) {
  if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("certification corpus exceeds 64 MiB");
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  const entries = [];
  let previous = null;
  const certificates = /* @__PURE__ */ new Set();
  for (const [index, line] of lines.entries()) {
    if (Buffer.byteLength(line) > 2 * 1024 * 1024) throw new Error(`corpus line ${index + 1} exceeds 2 MiB`);
    const root = record4(JSON.parse(line), `corpus line ${index + 1}`);
    exactKeys5(root, ["schemaVersion", "sequence", "previousEntryHash", "certificate", "entryHash"], `corpus line ${index + 1}`);
    if (root.schemaVersion !== CORPUS_ENTRY_SCHEMA && root.schemaVersion !== SIGNED_CORPUS_ENTRY_SCHEMA || root.sequence !== index + 1 || root.previousEntryHash !== previous) throw new Error(`corpus chain is invalid at line ${index + 1}`);
    const certificate = validateAnyCertificate(root.certificate);
    if (root.schemaVersion === CORPUS_ENTRY_SCHEMA !== (certificate.schemaVersion === CERTIFICATE_SCHEMA)) throw new Error(`corpus entry and certificate versions do not match at line ${index + 1}`);
    if (certificates.has(certificate.certificateHash)) throw new Error(`duplicate certificate at corpus line ${index + 1}`);
    const payload = { schemaVersion: root.schemaVersion, sequence: index + 1, previousEntryHash: previous, certificate };
    const entryHash = sha2565(root.entryHash, `corpus line ${index + 1} entryHash`);
    if (digest5(payload) !== entryHash) throw new Error(`corpus entry hash is invalid at line ${index + 1}`);
    entries.push({ ...payload, entryHash });
    certificates.add(certificate.certificateHash);
    previous = entryHash;
  }
  return entries;
}
function appendCorpusEntry(content, certificateInput) {
  const entries = parseCorpus(content);
  const certificate = validateAnyCertificate(certificateInput);
  if (entries.some((item2) => item2.certificate.certificateHash === certificate.certificateHash)) throw new Error("certificate already exists in corpus");
  const payload = {
    schemaVersion: certificate.schemaVersion === CERTIFICATE_SCHEMA ? CORPUS_ENTRY_SCHEMA : SIGNED_CORPUS_ENTRY_SCHEMA,
    sequence: entries.length + 1,
    previousEntryHash: entries.at(-1)?.entryHash ?? null,
    certificate
  };
  const entry = { ...payload, entryHash: digest5(payload) };
  return { entry, line: `${JSON.stringify(entry)}
` };
}
function loadCorpus(path) {
  if (!existsSync9(path)) return [];
  const status = lstatSync10(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error("certification corpus must be a regular non-symbolic-link file");
  if (status.size > 64 * 1024 * 1024) throw new Error("certification corpus exceeds 64 MiB");
  return parseCorpus(readFileSync22(path, "utf8"));
}
function validatePolicy3(input) {
  const root = record4(input, "certification policy");
  exactKeys5(root, ["schemaVersion", "policyId", "organization", "maxAgeHours", "repositories"], "certification policy");
  if (root.schemaVersion !== POLICY_SCHEMA) throw new Error(`certification policy schemaVersion must be ${POLICY_SCHEMA}`);
  if (!Number.isInteger(root.maxAgeHours) || Number(root.maxAgeHours) < 1 || Number(root.maxAgeHours) > 8760) throw new Error("maxAgeHours must be an integer from 1 to 8760");
  if (!Array.isArray(root.repositories) || root.repositories.length === 0 || root.repositories.length > 1e4) throw new Error("repositories must contain 1 to 10000 entries");
  const seen = /* @__PURE__ */ new Set();
  const repositories = root.repositories.map((value, index) => {
    const item2 = record4(value, `repositories[${index}]`);
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
function certificateControlIdentity(certificate) {
  return certificate.schemaVersion === CERTIFICATE_SCHEMA ? `${certificate.control.vendor}/${certificate.control.product}` : signedControlIdentity(certificate.proof);
}
function certificateProof(certificate) {
  return certificate.schemaVersion === CERTIFICATE_SCHEMA ? certificate.proof : certificate.proof.payload;
}
function buildStatusReport(policyInput, entries, asOfInput) {
  const policy = validatePolicy3(policyInput);
  const asOf = timestamp4(asOfInput, "asOf");
  const asOfMs = Date.parse(asOf);
  const repositories = policy.repositories.map((requirement) => {
    const matches = entries.map((entry) => entry.certificate).filter((certificate) => certificate.organization === policy.organization && certificate.repository === requirement.repository && certificate.requiredCheck === requirement.requiredCheck).sort((left, right) => Date.parse(certificateProof(right).generatedAt) - Date.parse(certificateProof(left).generatedAt));
    const latest = matches[0];
    if (!latest) return { repository: requirement.repository, requiredCheck: requirement.requiredCheck, state: "MISSING", reason: "no matching control certificate is present" };
    const proof = certificateProof(latest);
    const control = certificateControlIdentity(latest);
    const common = { repository: requirement.repository, requiredCheck: requirement.requiredCheck, proofGeneratedAt: proof.generatedAt, certificateHash: latest.certificateHash, control };
    if (!requirement.allowedControls.includes(control)) return { ...common, state: "HOLD", reason: `control ${control} is not allowed by policy` };
    const ageHours = (asOfMs - Date.parse(proof.generatedAt)) / 36e5;
    if (ageHours < 0) return { ...common, ageHours, state: "HOLD", reason: "latest proof is dated after the report time" };
    if (proof.status !== "PASS") return { ...common, ageHours, state: "HOLD", reason: "latest control proof did not pass" };
    const challengeMap = new Map(proof.challenges.map((item2) => [item2.id, item2]));
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
  return { ...payload, reportHash: digest5(payload) };
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

// src/continuity/cli.ts
import { isAbsolute as isAbsolute10, relative as relative13, resolve as resolve24 } from "node:path";

// src/continuity/chain.ts
import {
  chmodSync as chmodSync3,
  existsSync as existsSync10,
  lstatSync as lstatSync12,
  mkdirSync as mkdirSync7,
  readdirSync as readdirSync2,
  realpathSync as realpathSync11
} from "node:fs";
import { execFileSync as execFileSync17 } from "node:child_process";
import { createPrivateKey as createPrivateKey5, createPublicKey as createPublicKey5, sign as sign5, verify as verify5 } from "node:crypto";
import { basename as basename7, join as join9, parse as parse3, resolve as resolve22, sep as sep12 } from "node:path";

// src/continuity/contracts.ts
import { execFileSync as execFileSync16 } from "node:child_process";
import { constants as constants4, closeSync as closeSync3, fstatSync as fstatSync3, lstatSync as lstatSync11, openSync as openSync3, readFileSync as readFileSync23 } from "node:fs";
import { isAbsolute as isAbsolute9, resolve as resolve21 } from "node:path";
import { createHash as createHash21 } from "node:crypto";
var CONTINUITY_EVENT_KINDS = [
  "merge_observed",
  "deployment_observed",
  "revert_observed",
  "hotfix_observed",
  "incident_linked",
  "verification_refreshed",
  "policy_superseded",
  "authority_changed",
  "agent_upgrade_changed",
  "security_advisory_observed",
  "credential_revoked",
  "attestation_invalid",
  "monitor_checkpoint",
  "coverage_gap",
  "exception_granted",
  "remediation_verified"
];
var CONTINUITY_DISPOSITIONS = ["affirm", "hold", "revoke", "observe"];
var CONTINUITY_PRIVACY_TIERS = ["receipt", "metadata", "full-local"];
var SHA2563 = /^sha256:[0-9a-f]{64}$/;
var GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var UUID_URN = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/;
var SAFE_SOURCE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
var CREDENTIAL_LIKE_IDENTIFIER = /^(?:gh[pousr]_|github_pat_|sk_(?:live|test)_|xox[baprs]-)/;
var BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
var MAX_EVENT_BYTES = 1024 * 1024;
var MAX_POLICY_BYTES = 1024 * 1024;
function object2(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys6(record5, expected, label) {
  const actual = Object.keys(record5).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}
function string(value, label, maximum = 240) {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  if (new RegExp("\\p{C}", "u").test(value)) throw new Error(`${label} contains control or format characters`);
  return value;
}
function digest6(value, label) {
  const selected = string(value, label, 71);
  if (!SHA2563.test(selected)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return selected;
}
function gitSha(value, label) {
  const selected = string(value, label, 64);
  if (!GIT_SHA.test(selected)) throw new Error(`${label} must be a full lowercase Git object ID`);
  return selected;
}
function timestamp5(value, label) {
  const selected = string(value, label, 40);
  const parsed = Date.parse(selected);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== selected) throw new Error(`${label} must be canonical RFC3339 UTC`);
  return selected;
}
function nullableTimestamp(value, label) {
  return value === null ? null : timestamp5(value, label);
}
function nullableDigest(value, label) {
  return value === null ? null : digest6(value, label);
}
function nullableUuid(value, label) {
  if (value === null) return null;
  const selected = string(value, label, 45);
  if (!UUID_URN.test(selected)) throw new Error(`${label} must be a lowercase UUID URN`);
  return selected;
}
function safeIdentifier(value, label) {
  const selected = string(value, label, 80);
  if (!SAFE_IDENTIFIER.test(selected)) throw new Error(`${label} must be a privacy-safe machine identifier`);
  if (CREDENTIAL_LIKE_IDENTIFIER.test(selected)) throw new Error(`${label} must not contain a credential-like value`);
  return selected;
}
function validateProtectedEnvironment(value) {
  return safeIdentifier(value, "protected environment");
}
function safeSource(value, label) {
  const selected = string(value, label, 64);
  if (!SAFE_SOURCE.test(selected)) throw new Error(`${label} must be a privacy-safe source identifier`);
  return selected;
}
function oneOf(value, allowed2, label) {
  const selected = string(value, label);
  if (!allowed2.includes(selected)) throw new Error(`${label} is unsupported`);
  return selected;
}
function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function integer3(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}
function stringArray2(value, label, validator) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > 64) throw new Error(`${label} exceeds 64 entries`);
  const selected = value.map((item2, index) => validator(item2, `${label}[${index}]`));
  if (new Set(selected).size !== selected.length) throw new Error(`${label} contains duplicate entries`);
  return selected;
}
function validateContinuitySubject(value) {
  const selected = object2(value, "subject");
  exactKeys6(selected, ["episodeReceiptHash", "repositoryHash", "baseSha", "headSha"], "subject");
  return {
    episodeReceiptHash: digest6(selected.episodeReceiptHash, "subject.episodeReceiptHash"),
    repositoryHash: digest6(selected.repositoryHash, "subject.repositoryHash"),
    baseSha: gitSha(selected.baseSha, "subject.baseSha"),
    headSha: gitSha(selected.headSha, "subject.headSha")
  };
}
function validateEventDraft(value) {
  const selected = object2(value, "continuity event draft");
  exactKeys6(selected, ["schemaVersion", "eventId", "subject", "source", "event", "observedAt", "effectiveAt", "privacyTier"], "continuity event draft");
  if (selected.schemaVersion !== "agent-vigil-continuity-event/v1") throw new Error("unsupported continuity event schema");
  const eventId = string(selected.eventId, "eventId", 45);
  if (!UUID_URN.test(eventId)) throw new Error("eventId must be a lowercase UUID URN");
  const source2 = object2(selected.source, "source");
  exactKeys6(source2, ["kind", "issuer", "evidenceHash", "deliveryIdHash"], "source");
  const deliveryIdHash = nullableDigest(source2.deliveryIdHash, "source.deliveryIdHash");
  const event2 = object2(selected.event, "event");
  exactKeys6(event2, ["kind", "disposition", "reasonCode", "targetHash", "freshUntil", "supersedesEventId"], "event");
  const eventKind = oneOf(event2.kind, CONTINUITY_EVENT_KINDS, "event.kind");
  const eventDisposition = oneOf(event2.disposition, CONTINUITY_DISPOSITIONS, "event.disposition");
  return {
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId,
    subject: validateContinuitySubject(selected.subject),
    source: {
      kind: safeSource(source2.kind, "source.kind"),
      issuer: digest6(source2.issuer, "source.issuer"),
      evidenceHash: digest6(source2.evidenceHash, "source.evidenceHash"),
      deliveryIdHash
    },
    event: {
      kind: eventKind,
      disposition: eventDisposition,
      reasonCode: safeIdentifier(event2.reasonCode, "event.reasonCode"),
      targetHash: nullableDigest(event2.targetHash, "event.targetHash"),
      freshUntil: nullableTimestamp(event2.freshUntil, "event.freshUntil"),
      supersedesEventId: nullableUuid(event2.supersedesEventId, "event.supersedesEventId")
    },
    observedAt: timestamp5(selected.observedAt, "observedAt"),
    effectiveAt: timestamp5(selected.effectiveAt, "effectiveAt"),
    privacyTier: oneOf(selected.privacyTier, CONTINUITY_PRIVACY_TIERS, "privacyTier")
  };
}
function validateSignature(value) {
  if (value === null) return null;
  const selected = object2(value, "signature");
  exactKeys6(selected, ["algorithm", "keyId", "publicKey", "value"], "signature");
  if (selected.algorithm !== "Ed25519") throw new Error("signature.algorithm must be Ed25519");
  const publicKey = string(selected.publicKey, "signature.publicKey", 256);
  const signatureValue = string(selected.value, "signature.value", 128);
  if (!BASE64.test(publicKey) || !BASE64.test(signatureValue)) throw new Error("signature material must be canonical base64");
  return {
    algorithm: "Ed25519",
    keyId: digest6(selected.keyId, "signature.keyId"),
    publicKey,
    value: signatureValue
  };
}
function validateStoredEvent(value) {
  const selected = object2(value, "stored continuity event");
  exactKeys6(selected, [
    "schemaVersion",
    "eventId",
    "subject",
    "source",
    "event",
    "observedAt",
    "effectiveAt",
    "privacyTier",
    "sequence",
    "predecessorHash",
    "eventHash",
    "signature"
  ], "stored continuity event");
  const draft = validateEventDraft(Object.fromEntries(Object.entries(selected).filter(([key]) => !["sequence", "predecessorHash", "eventHash", "signature"].includes(key))));
  return {
    ...draft,
    sequence: integer3(selected.sequence, "sequence", 1, Number.MAX_SAFE_INTEGER),
    predecessorHash: digest6(selected.predecessorHash, "predecessorHash"),
    eventHash: digest6(selected.eventHash, "eventHash"),
    signature: validateSignature(selected.signature)
  };
}
function validateContinuityRoot(value) {
  const selected = object2(value, "continuity root");
  exactKeys6(selected, ["schemaVersion", "receiptFileSha256", "receiptHash", "rootHash", "subject", "historicalVerification", "createdAt"], "continuity root");
  if (selected.schemaVersion !== "agent-vigil-continuity-root/v1") throw new Error("unsupported continuity root schema");
  return {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: digest6(selected.receiptFileSha256, "receiptFileSha256"),
    receiptHash: digest6(selected.receiptHash, "receiptHash"),
    rootHash: digest6(selected.rootHash, "rootHash"),
    subject: validateContinuitySubject(selected.subject),
    historicalVerification: oneOf(selected.historicalVerification, ["PASS", "FAIL", "INCONCLUSIVE"], "historicalVerification"),
    createdAt: timestamp5(selected.createdAt, "createdAt")
  };
}
function validateContinuityPolicy(value) {
  const selected = object2(value, "continuity policy");
  exactKeys6(selected, [
    "schemaVersion",
    "requiredSources",
    "maxAgeSeconds",
    "denyOn",
    "allowRemediation",
    "requireSignedRoot",
    "requireSignedEvents",
    "trustedRootKeyIds",
    "trustedIssuerKeyIds",
    "protectedEnvironments",
    "maxClockSkewSeconds"
  ], "continuity policy");
  if (selected.schemaVersion !== "agent-vigil-continuity-policy/v1") throw new Error("unsupported continuity policy schema");
  const requiredSources = stringArray2(selected.requiredSources, "requiredSources", safeSource);
  const ages = object2(selected.maxAgeSeconds, "maxAgeSeconds");
  if (Object.keys(ages).length > 64) throw new Error("maxAgeSeconds exceeds 64 entries");
  const maxAgeSeconds = {};
  for (const [key, value2] of Object.entries(ages)) {
    const source2 = safeSource(key, "maxAgeSeconds key");
    maxAgeSeconds[source2] = integer3(value2, `maxAgeSeconds.${source2}`, 1, 31536e3);
  }
  const denyOn = stringArray2(selected.denyOn, "denyOn", (item2, label) => oneOf(item2, CONTINUITY_EVENT_KINDS, label));
  return {
    schemaVersion: "agent-vigil-continuity-policy/v1",
    requiredSources,
    maxAgeSeconds,
    denyOn,
    allowRemediation: boolean(selected.allowRemediation, "allowRemediation"),
    requireSignedRoot: boolean(selected.requireSignedRoot, "requireSignedRoot"),
    requireSignedEvents: boolean(selected.requireSignedEvents, "requireSignedEvents"),
    trustedRootKeyIds: stringArray2(selected.trustedRootKeyIds, "trustedRootKeyIds", digest6),
    trustedIssuerKeyIds: stringArray2(selected.trustedIssuerKeyIds, "trustedIssuerKeyIds", digest6),
    protectedEnvironments: stringArray2(selected.protectedEnvironments, "protectedEnvironments", safeIdentifier),
    maxClockSkewSeconds: integer3(selected.maxClockSkewSeconds, "maxClockSkewSeconds", 0, 86400)
  };
}
function sha2566(value) {
  return `sha256:${createHash21("sha256").update(value).digest("hex")}`;
}
function canonicalSha256(value) {
  return sha2566(canonical(value));
}
function readBoundedRegularFile(path, maximumBytes, label) {
  const absolute = resolve21(path);
  const expected = lstatSync11(absolute);
  if (expected.isSymbolicLink() || !expected.isFile()) throw new Error(`${label} must be a regular file, not a symbolic link`);
  if (expected.size > maximumBytes) throw new Error(`${label} exceeds the ${maximumBytes} byte limit`);
  const noFollow = typeof constants4.O_NOFOLLOW === "number" ? constants4.O_NOFOLLOW : 0;
  const descriptor = openSync3(absolute, constants4.O_RDONLY | noFollow);
  try {
    const opened = fstatSync3(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error(`${label} changed while being read`);
    }
    return readFileSync23(descriptor);
  } finally {
    closeSync3(descriptor);
  }
}
function readBoundedJson2(path, maximumBytes, label) {
  const bytes = readBoundedRegularFile(path, maximumBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}
function loadEventDraft(path) {
  return validateEventDraft(readBoundedJson2(path, MAX_EVENT_BYTES, "continuity event"));
}
function loadContinuityPolicy(options) {
  let raw;
  let source2;
  if (options.ref) {
    if (!options.repo) throw new Error("--policy-ref requires --repo");
    if (!GIT_SHA.test(options.ref)) throw new Error("--policy-ref must be a full lowercase Git object ID");
    const pathParts = options.path.split("/");
    if (isAbsolute9(options.path) || options.path.includes("\\") || pathParts.some((part) => !part || part === "." || part === "..")) {
      throw new Error("a Git-anchored continuity policy must use a repository-relative POSIX path");
    }
    const repo = resolve21(options.repo);
    try {
      raw = execFileSync16("git", ["show", `${options.ref}:${options.path}`], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: MAX_POLICY_BYTES
      });
    } catch {
      throw new Error(`continuity policy could not be loaded from ${options.path}@${options.ref}`);
    }
    source2 = `${options.path}@${options.ref}`;
  } else {
    raw = readBoundedRegularFile(options.path, MAX_POLICY_BYTES, "continuity policy").toString("utf8");
    source2 = resolve21(options.path);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("continuity policy is not valid JSON");
  }
  const value = validateContinuityPolicy(parsed);
  return { value, source: source2, sha256: sha2566(raw) };
}

// src/continuity/chain.ts
var ROOT_DOMAIN = "agent-vigil-continuity-root/v1\0";
var EVENT_DOMAIN = "agent-vigil-continuity-event/v1\0";
var MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
var MAX_EVENT_BYTES2 = 1024 * 1024;
var MAX_EVENTS = 1e5;
function isMissing2(error) {
  return error?.code === "ENOENT";
}
function ensurePrivateDirectory2(requested, mustBeNew = false) {
  const absolute = resolve22(requested);
  const root = parse3(absolute).root;
  const rootStatus = lstatSync12(root);
  let current = root;
  const components = absolute.slice(root.length).split(sep12).filter(Boolean);
  for (const [index, component] of components.entries()) {
    const next = join9(current, component);
    try {
      const status = lstatSync12(next);
      if (status.isSymbolicLink()) {
        const trustedRootAlias = index === 0 && status.uid === rootStatus.uid && (rootStatus.mode & 18) === 0;
        if (!trustedRootAlias) throw new Error("continuity directory may not traverse a symbolic link");
        const canonical3 = realpathSync11(next);
        if (!lstatSync12(canonical3).isDirectory()) throw new Error("continuity directory parent is not a directory");
        current = canonical3;
        continue;
      }
      if (!status.isDirectory()) throw new Error("continuity directory path contains a non-directory entry");
      if (mustBeNew && index === components.length - 1) throw new Error("continuity output already exists");
      current = next;
    } catch (error) {
      if (!isMissing2(error)) throw error;
      mkdirSync7(next, { mode: 448 });
      chmodSync3(next, 448);
      current = next;
    }
  }
  return current;
}
function parseReport(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Agent Vigil receipt is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Agent Vigil receipt must be an object");
  const report = value;
  if (report.schemaVersion !== "2") throw new Error("Agent Vigil receipt schema must be version 2");
  if (!report.summary || !(/* @__PURE__ */ new Set(["PASS", "FAIL", "INCONCLUSIVE"])).has(report.summary.status)) throw new Error("Agent Vigil receipt status is invalid");
  if (!Array.isArray(report.results) || !report.policy || !report.repository) throw new Error("Agent Vigil receipt is incomplete");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(report.base) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(report.head)) {
    throw new Error("continuity requires full base and head Git object IDs");
  }
  if (!report.repository.tree || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(report.repository.tree)) {
    throw new Error("continuity requires a committed head tree");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(report.receiptHash) || recomputeReceiptHash(report) !== report.receiptHash) {
    throw new Error("Agent Vigil receipt hash is invalid");
  }
  const count3 = (verdict) => report.results.filter((result5) => result5.verdict === verdict).length;
  const meaningfulVerified = report.results.filter((result5) => result5.verdict === "verified" && result5.contributesToPass !== false).length;
  const expectedStatus = count3("contradicted") > 0 ? "FAIL" : meaningfulVerified < report.policy.minVerified || report.results.some((result5) => result5.verdict === "unverifiable" && result5.blocksPass) || report.policy.strict && count3("unverifiable") > 0 ? "INCONCLUSIVE" : "PASS";
  if (report.summary.verified !== count3("verified") || report.summary.contradicted !== count3("contradicted") || report.summary.unverifiable !== count3("unverifiable") || report.summary.meaningfulVerified !== meaningfulVerified || report.summary.status !== expectedStatus || report.summary.pass !== (report.summary.status === "PASS")) {
    throw new Error("Agent Vigil receipt summary is internally inconsistent");
  }
  return report;
}
function subjectFor(report) {
  return {
    episodeReceiptHash: report.receiptHash,
    repositoryHash: canonicalSha256({ remote: report.repository.remote ?? null, tree: report.repository.tree }),
    baseSha: report.base,
    headSha: report.head
  };
}
function rootHash(report) {
  return sha2566(`${ROOT_DOMAIN}${canonical(report)}`);
}
function unsignedEventPayload(event2) {
  const { eventHash: _eventHash, signature: _signature, ...payload } = event2;
  return payload;
}
function computeEventHash(event2) {
  return sha2566(`${EVENT_DOMAIN}${event2.predecessorHash}${canonical(unsignedEventPayload(event2))}`);
}
function sameSubject(left, right) {
  return canonical(left) === canonical(right);
}
function tip(sequence, eventHash, updatedAt) {
  return { schemaVersion: "agent-vigil-continuity-tip/v1", sequence, eventHash, updatedAt };
}
function validateTip(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("continuity tip must be an object");
  const selected = value;
  const keys = Object.keys(selected).sort();
  if (canonical(keys) !== canonical(["eventHash", "schemaVersion", "sequence", "updatedAt"])) {
    throw new Error("continuity tip has unsupported or missing fields");
  }
  if (selected.schemaVersion !== "agent-vigil-continuity-tip/v1") throw new Error("unsupported continuity tip schema");
  if (!Number.isSafeInteger(selected.sequence) || Number(selected.sequence) < 0 || Number(selected.sequence) > MAX_EVENTS) {
    throw new Error("continuity tip sequence is invalid");
  }
  if (typeof selected.eventHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(selected.eventHash)) {
    throw new Error("continuity tip hash is invalid");
  }
  if (typeof selected.updatedAt !== "string" || !Number.isFinite(Date.parse(selected.updatedAt)) || new Date(Date.parse(selected.updatedAt)).toISOString() !== selected.updatedAt) {
    throw new Error("continuity tip timestamp is invalid");
  }
  return tip(Number(selected.sequence), selected.eventHash, selected.updatedAt);
}
function rootSignatureState(report) {
  if (!report.signature) return { present: false, valid: false };
  try {
    if (report.signature.algorithm !== "Ed25519") return { present: true, valid: false };
    const publicKey = createPublicKey5({
      key: Buffer.from(report.signature.publicKey, "base64"),
      type: "spki",
      format: "der"
    });
    if (publicKey.asymmetricKeyType !== "ed25519") return { present: true, valid: false };
    const keyId = signingKeyId(publicKeyDer(publicKey));
    return {
      present: true,
      valid: keyId === report.signature.keyId && verify5(null, Buffer.from(report.receiptHash), publicKey, Buffer.from(report.signature.value, "base64")),
      keyId
    };
  } catch {
    return { present: true, valid: false };
  }
}
function verifyEventSignature(event2) {
  if (!event2.signature) return { valid: true };
  try {
    const publicKey = createPublicKey5({
      key: Buffer.from(event2.signature.publicKey, "base64"),
      type: "spki",
      format: "der"
    });
    if (publicKey.asymmetricKeyType !== "ed25519") return { valid: false };
    const keyId = signingKeyId(publicKeyDer(publicKey));
    return {
      valid: keyId === event2.signature.keyId && verify5(null, Buffer.from(event2.eventHash), publicKey, Buffer.from(event2.signature.value, "base64")),
      keyId
    };
  } catch {
    return { valid: false };
  }
}
function initializeContinuityChain(receiptPath, outputDirectory, now = /* @__PURE__ */ new Date()) {
  const receiptBytes = readBoundedRegularFile(receiptPath, MAX_RECEIPT_BYTES, "Agent Vigil receipt");
  const report = parseReport(receiptBytes);
  const directory = ensurePrivateDirectory2(outputDirectory, true);
  const eventsDirectory = ensurePrivateDirectory2(join9(directory, "events"), true);
  const root = {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: sha2566(receiptBytes),
    receiptHash: report.receiptHash,
    rootHash: rootHash(report),
    subject: subjectFor(report),
    historicalVerification: report.summary.status,
    createdAt: now.toISOString()
  };
  writePrivateFileExclusive(join9(directory, "receipt.json"), receiptBytes.toString("utf8"));
  writePrivateFileExclusive(join9(directory, "root.json"), `${JSON.stringify(root, null, 2)}
`);
  writePrivateFileExclusive(join9(directory, "tip.json"), `${JSON.stringify(tip(0, root.rootHash, root.createdAt), null, 2)}
`);
  chmodSync3(eventsDirectory, 448);
  return root;
}
function readChainFiles(chainDirectory) {
  const directory = resolve22(chainDirectory);
  let status;
  try {
    status = lstatSync12(directory);
  } catch {
    throw new Error("continuity chain directory is missing or unreadable");
  }
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("continuity chain must be a regular directory, not a symbolic link");
  const entries = readdirSync2(directory).sort();
  if (canonical(entries) !== canonical(["events", "receipt.json", "root.json", "tip.json"])) throw new Error("continuity chain directory contains unsupported or missing entries");
  const eventsDirectory = join9(directory, "events");
  const eventsStatus = lstatSync12(eventsDirectory);
  if (eventsStatus.isSymbolicLink() || !eventsStatus.isDirectory()) throw new Error("continuity events must be stored in a regular directory");
  const root = validateContinuityRoot(readBoundedJson2(join9(directory, "root.json"), MAX_EVENT_BYTES2, "continuity root"));
  const storedTip = validateTip(readBoundedJson2(join9(directory, "tip.json"), MAX_EVENT_BYTES2, "continuity tip"));
  const receiptBytes = readBoundedRegularFile(join9(directory, "receipt.json"), MAX_RECEIPT_BYTES, "Agent Vigil receipt");
  const report = parseReport(receiptBytes);
  const eventFiles = readdirSync2(eventsDirectory).sort();
  if (eventFiles.length > MAX_EVENTS) throw new Error(`continuity chain exceeds ${MAX_EVENTS} events`);
  for (const file of eventFiles) if (!/^\d{8}\.json$/.test(file)) throw new Error("continuity events directory contains an unsupported entry");
  const events = eventFiles.map((file) => validateStoredEvent(readBoundedJson2(join9(eventsDirectory, file), MAX_EVENT_BYTES2, "continuity event")));
  return { root, report, events, receiptBytes, tip: storedTip };
}
function verifyContinuityChain(chainDirectory, options = {}) {
  const errors = [];
  const now = options.now ?? /* @__PURE__ */ new Date();
  const maximumFuture = now.getTime() + (options.maxClockSkewSeconds ?? 300) * 1e3;
  const { root, report, events, receiptBytes, tip: storedTip } = readChainFiles(chainDirectory);
  if (root.receiptFileSha256 !== sha2566(receiptBytes)) errors.push("original receipt bytes no longer match the continuity root");
  if (root.receiptHash !== report.receiptHash) errors.push("original receipt identity no longer matches the continuity root");
  if (root.rootHash !== rootHash(report)) errors.push("original receipt content no longer matches the continuity root hash");
  if (!sameSubject(root.subject, subjectFor(report))) errors.push("continuity root subject does not match the original receipt");
  if (options.expectedBase) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.expectedBase)) throw new Error("expected base must be a full lowercase Git object ID");
    if (root.subject.baseSha !== options.expectedBase) errors.push("continuity root does not match the policy base commit");
  }
  if (options.expectedHead) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.expectedHead)) throw new Error("expected head must be a full lowercase Git object ID");
    if (root.subject.headSha !== options.expectedHead) errors.push("continuity root does not match the expected deployment commit");
  }
  if (options.repo) {
    try {
      const head = execFileSync17("git", ["rev-parse", "--verify", `${root.subject.headSha}^{commit}`], {
        cwd: resolve22(options.repo),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      const tree = execFileSync17("git", ["rev-parse", "--verify", `${root.subject.headSha}^{tree}`], {
        cwd: resolve22(options.repo),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      }).trim();
      if (head !== root.subject.headSha) errors.push("repository resolved the recorded head to a different commit");
      if (tree !== report.repository.tree) errors.push("repository head tree does not match the original receipt");
      execFileSync17("git", ["merge-base", "--is-ancestor", root.subject.baseSha, root.subject.headSha], {
        cwd: resolve22(options.repo),
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
      errors.push("recorded base and head are not a verifiable ancestor range in this repository");
    }
  }
  if (root.historicalVerification !== report.summary.status) errors.push("historical verification verdict was changed");
  const receiptSignature = rootSignatureState(report);
  if (receiptSignature.present && !receiptSignature.valid) errors.push("original receipt signature is invalid");
  let predecessor = root.rootHash;
  let priorObserved = Number.NEGATIVE_INFINITY;
  let priorEffective = Number.NEGATIVE_INFINITY;
  const eventIds = /* @__PURE__ */ new Set();
  const deliveryIds = /* @__PURE__ */ new Set();
  for (const [index, event2] of events.entries()) {
    const sequence = index + 1;
    if (event2.sequence !== sequence) errors.push(`event ${sequence} has an unexpected sequence number`);
    if (event2.predecessorHash !== predecessor) errors.push(`event ${sequence} does not extend the prior chain tip`);
    if (!sameSubject(event2.subject, root.subject)) errors.push(`event ${sequence} is bound to a different receipt subject`);
    if (event2.eventHash !== computeEventHash(event2)) errors.push(`event ${sequence} content hash is invalid`);
    if (eventIds.has(event2.eventId)) errors.push(`event ${sequence} reuses an earlier event ID`);
    eventIds.add(event2.eventId);
    if (event2.source.deliveryIdHash) {
      if (deliveryIds.has(event2.source.deliveryIdHash)) errors.push(`event ${sequence} replays an earlier delivery ID`);
      deliveryIds.add(event2.source.deliveryIdHash);
    }
    const observed = Date.parse(event2.observedAt);
    const effective = Date.parse(event2.effectiveAt);
    if (observed < effective) errors.push(`event ${sequence} was observed before it became effective`);
    if (observed < priorObserved || effective < priorEffective) errors.push(`event ${sequence} rolls the continuity clock backward`);
    if (observed > maximumFuture || effective > maximumFuture) errors.push(`event ${sequence} has an implausible future timestamp`);
    priorObserved = observed;
    priorEffective = effective;
    if (event2.event.freshUntil && Date.parse(event2.event.freshUntil) <= effective) {
      errors.push(`event ${sequence} has a freshness boundary that is not later than its effective time`);
    }
    const signature = verifyEventSignature(event2);
    if (!signature.valid) errors.push(`event ${sequence} signature is invalid`);
    if (event2.signature && event2.source.issuer !== signature.keyId) errors.push(`event ${sequence} issuer does not match its signing key`);
    if (!event2.signature && options.pinnedEventKeyIds?.length) errors.push(`event ${sequence} is unsigned but a pinned event key was required`);
    if (event2.signature && options.pinnedEventKeyIds?.length && !options.pinnedEventKeyIds.includes(signature.keyId ?? "")) {
      errors.push(`event ${sequence} signer does not match the pinned public key`);
    }
    predecessor = event2.eventHash;
  }
  const expectedTipTime = events.at(-1)?.observedAt ?? root.createdAt;
  if (storedTip.sequence !== events.length || storedTip.eventHash !== predecessor || storedTip.updatedAt !== expectedTipTime) {
    errors.push("continuity tip does not match the complete recorded event sequence");
  }
  return {
    valid: errors.length === 0,
    errors,
    root,
    report,
    events,
    chainTip: predecessor,
    rootSignature: receiptSignature
  };
}
function createStoredEvent(draftValue, root, priorEvents, privateKeyPath, now = /* @__PURE__ */ new Date()) {
  const draft = validateEventDraft(draftValue);
  if (!sameSubject(draft.subject, root.subject)) throw new Error("continuity event subject does not match the chain root");
  if (priorEvents.some((event3) => event3.eventId === draft.eventId)) throw new Error("continuity event ID was already used");
  if (draft.source.deliveryIdHash && priorEvents.some((event3) => event3.source.deliveryIdHash === draft.source.deliveryIdHash)) {
    throw new Error("continuity delivery ID was already recorded");
  }
  const prior = priorEvents.at(-1);
  if (prior) {
    if (Date.parse(draft.observedAt) < Date.parse(prior.observedAt) || Date.parse(draft.effectiveAt) < Date.parse(prior.effectiveAt)) {
      throw new Error("continuity event rolls the chain clock backward");
    }
  }
  if (Date.parse(draft.observedAt) < Date.parse(draft.effectiveAt)) throw new Error("continuity event cannot be observed before it becomes effective");
  const maximumFuture = now.getTime() + 3e5;
  if (Date.parse(draft.observedAt) > maximumFuture || Date.parse(draft.effectiveAt) > maximumFuture) {
    throw new Error("continuity event has an implausible future timestamp");
  }
  if (draft.event.freshUntil && Date.parse(draft.event.freshUntil) <= Date.parse(draft.effectiveAt)) {
    throw new Error("continuity event freshness must extend beyond its effective time");
  }
  const event2 = {
    ...draft,
    sequence: priorEvents.length + 1,
    predecessorHash: prior?.eventHash ?? root.rootHash,
    eventHash: "sha256:" + "0".repeat(64),
    signature: null
  };
  event2.eventHash = computeEventHash(event2);
  if (privateKeyPath) {
    const privateKey = createPrivateKey5(readBoundedRegularFile(privateKeyPath, 64 * 1024, "continuity signing key"));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("continuity signing key must be Ed25519");
    const publicKey = createPublicKey5(privateKey);
    const der = publicKeyDer(publicKey);
    event2.signature = {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign5(null, Buffer.from(event2.eventHash), privateKey).toString("base64")
    };
    if (event2.source.issuer !== event2.signature.keyId) throw new Error("continuity event issuer must match its signing key");
  }
  return event2;
}
function appendContinuityEvent(chainDirectory, draft, privateKeyPath) {
  const verified = verifyContinuityChain(chainDirectory);
  if (!verified.valid) throw new Error(`continuity chain is invalid: ${verified.errors.join("; ")}`);
  const event2 = createStoredEvent(draft, verified.root, verified.events, privateKeyPath);
  const file = `${String(event2.sequence).padStart(8, "0")}.json`;
  writePrivateFileExclusive(join9(resolve22(chainDirectory), "events", file), `${JSON.stringify(event2, null, 2)}
`);
  writePrivateFileAtomic(join9(resolve22(chainDirectory), "tip.json"), `${JSON.stringify(tip(event2.sequence, event2.eventHash, event2.observedAt), null, 2)}
`);
  const after = verifyContinuityChain(chainDirectory);
  if (!after.valid) throw new Error(`appended continuity event did not verify: ${after.errors.join("; ")}`);
  return event2;
}

// src/continuity/demo.ts
import { createHmac as createHmac2 } from "node:crypto";
import { mkdtempSync as mkdtempSync4, rmSync as rmSync3, writeFileSync as writeFileSync7 } from "node:fs";
import { tmpdir as tmpdir4 } from "node:os";
import { join as join10 } from "node:path";

// src/continuity/decision.ts
function outcomeFact(event2) {
  const mapping = {
    merge_observed: "merged",
    deployment_observed: "deployed",
    revert_observed: "reverted",
    hotfix_observed: "hotfixed",
    incident_linked: "incident_linked"
  };
  const kind = mapping[event2.event.kind] ?? (event2.event.kind === "monitor_checkpoint" && event2.event.reasonCode === "no_known_event_through" ? "no_known_event_through" : void 0);
  return kind ? { eventId: event2.eventId, kind, observedAt: event2.observedAt } : void 0;
}
function signedByTrustedIssuer(event2, policy) {
  return Boolean(event2.signature && policy.trustedIssuerKeyIds.includes(event2.signature.keyId));
}
function linkedIncident(event2) {
  return event2.event.kind !== "incident_linked" || event2.source.kind === "github-outcome" && Boolean(event2.source.deliveryIdHash) && Boolean(event2.event.targetHash);
}
function sourceQualifies(event2) {
  if (!(/* @__PURE__ */ new Set(["affirm", "observe"])).has(event2.event.disposition)) return false;
  if (event2.event.kind === "coverage_gap") return false;
  if (event2.event.kind === "monitor_checkpoint" && event2.event.reasonCode === "no_known_event_through") return false;
  if ((/* @__PURE__ */ new Set(["credential_revoked", "attestation_invalid", "revert_observed", "incident_linked"])).has(event2.event.kind)) return false;
  return true;
}
function evaluateContinuity(verification2, loadedPolicy, options = {}) {
  const now = options.now ?? /* @__PURE__ */ new Date();
  const policy = loadedPolicy.value;
  const environment = options.environment === void 0 ? void 0 : validateProtectedEnvironment(options.environment);
  const reasons = [];
  const outcomeFacts = verification2.events.map(outcomeFact).filter((item2) => Boolean(item2));
  let structuralRevocation = false;
  let expired = false;
  let held = false;
  if (!verification2.valid) {
    structuralRevocation = true;
    reasons.push({ ruleId: "continuity-chain", disposition: "revoke", message: "the append-only chain failed structural verification" });
  }
  if (verification2.root.historicalVerification === "FAIL") {
    structuralRevocation = true;
    reasons.push({ ruleId: "historical-verification", disposition: "revoke", message: "the original Agent Vigil receipt failed" });
  } else if (verification2.root.historicalVerification === "INCONCLUSIVE") {
    held = true;
    reasons.push({ ruleId: "historical-verification", disposition: "hold", message: "the original Agent Vigil receipt was inconclusive" });
  }
  if (verification2.rootSignature.present && !verification2.rootSignature.valid) {
    structuralRevocation = true;
    reasons.push({ ruleId: "root-signature", disposition: "revoke", message: "the original receipt signature is invalid" });
  } else if (policy.requireSignedRoot && !verification2.rootSignature.present) {
    held = true;
    reasons.push({ ruleId: "root-signature", disposition: "hold", message: "the protected policy requires a signed original receipt" });
  } else if (verification2.rootSignature.present && !policy.trustedRootKeyIds.includes(verification2.rootSignature.keyId ?? "")) {
    structuralRevocation = true;
    reasons.push({ ruleId: "root-signer-trust", disposition: "revoke", message: "the original receipt signer is not trusted by policy" });
  }
  if (environment && !policy.protectedEnvironments.includes(environment)) {
    held = true;
    reasons.push({ ruleId: "protected-environment", disposition: "hold", message: "the named environment is not covered by the protected policy" });
  }
  for (const event2 of verification2.events) {
    if (event2.signature && !policy.trustedIssuerKeyIds.includes(event2.signature.keyId)) {
      structuralRevocation = true;
      reasons.push({ ruleId: "event-signer-trust", disposition: "revoke", eventId: event2.eventId, message: "an event signer is not trusted by policy" });
    } else if (policy.requireSignedEvents && !event2.signature) {
      held = true;
      reasons.push({ ruleId: "event-signature", disposition: "hold", eventId: event2.eventId, message: "the protected policy requires every event to be signed" });
    }
  }
  const activeRevocations = /* @__PURE__ */ new Map();
  for (const event2 of verification2.events) {
    if (event2.event.kind === "remediation_verified") {
      const target2 = event2.event.supersedesEventId ? activeRevocations.get(event2.event.supersedesEventId) : void 0;
      const fresh = Boolean(event2.event.freshUntil) && Date.parse(event2.event.freshUntil) > now.getTime();
      const independent = Boolean(target2) && target2.source.issuer !== event2.source.issuer;
      const acceptable = policy.allowRemediation && event2.event.disposition === "affirm" && event2.source.kind === "verification" && Boolean(event2.event.targetHash) && fresh && independent && signedByTrustedIssuer(event2, policy);
      if (acceptable && target2) {
        activeRevocations.delete(target2.eventId);
        reasons.push({ ruleId: "remediation-verified", disposition: "observe", eventId: event2.eventId, message: "fresh independent remediation superseded one recorded revocation" });
      } else {
        held = true;
        reasons.push({ ruleId: "remediation-incomplete", disposition: "hold", eventId: event2.eventId, message: "a remediation event lacked fresh independent trusted verification" });
      }
      continue;
    }
    const denies = event2.event.disposition === "revoke" || policy.denyOn.includes(event2.event.kind);
    if (denies) {
      if (!linkedIncident(event2)) {
        held = true;
        reasons.push({ ruleId: "incident-linkage", disposition: "hold", eventId: event2.eventId, message: "an incident observation lacked explicit privacy-minimized GitHub linkage" });
      } else {
        activeRevocations.set(event2.eventId, event2);
      }
    }
    if (event2.event.disposition === "hold" || event2.event.kind === "coverage_gap") {
      held = true;
      reasons.push({
        ruleId: event2.event.kind === "coverage_gap" ? "coverage-gap" : "event-hold",
        disposition: "hold",
        eventId: event2.eventId,
        message: event2.event.kind === "coverage_gap" ? "a required observer reported a coverage gap" : "an event explicitly held continuity"
      });
    }
  }
  if (activeRevocations.size) {
    for (const event2 of activeRevocations.values()) {
      reasons.push({ ruleId: "effective-revocation", disposition: "revoke", eventId: event2.eventId, message: "a policy-denied event remains effective" });
    }
  }
  for (const source2 of policy.requiredSources) {
    const latest = [...verification2.events].reverse().find((event2) => event2.source.kind === source2 && sourceQualifies(event2));
    if (!latest) {
      held = true;
      reasons.push({ ruleId: "required-source", disposition: "hold", source: source2, message: "a policy-required evidence source is missing" });
      continue;
    }
    const maximumAge = policy.maxAgeSeconds[source2];
    if (!maximumAge) {
      held = true;
      reasons.push({ ruleId: "freshness-policy", disposition: "hold", source: source2, message: "a required source has no declared freshness window" });
      continue;
    }
    const age = now.getTime() - Date.parse(latest.observedAt);
    if (age < -policy.maxClockSkewSeconds * 1e3) {
      held = true;
      reasons.push({ ruleId: "source-clock", disposition: "hold", source: source2, eventId: latest.eventId, message: "required evidence is implausibly future-dated" });
    } else if (age > maximumAge * 1e3 || latest.event.freshUntil && Date.parse(latest.event.freshUntil) <= now.getTime()) {
      expired = true;
      reasons.push({ ruleId: "source-expired", disposition: "expire", source: source2, eventId: latest.eventId, message: "policy-required evidence is stale" });
    }
  }
  let continuity;
  if (structuralRevocation || activeRevocations.size) continuity = "REVOKED";
  else if (expired) continuity = "EXPIRED";
  else if (held) continuity = "HOLD";
  else continuity = "CURRENT";
  const unsigned = {
    schemaVersion: "agent-vigil-continuity-decision/v1",
    evaluatedAt: now.toISOString(),
    historicalVerification: verification2.root.historicalVerification,
    continuity,
    allowsProtectedAction: continuity === "CURRENT",
    protectedEnvironment: environment ?? null,
    rootHash: verification2.root.rootHash,
    chainTip: verification2.chainTip,
    eventCount: verification2.events.length,
    policy: { sourceHash: canonicalSha256(loadedPolicy.source), sha256: loadedPolicy.sha256 },
    outcomeFacts,
    reasons
  };
  return { ...unsigned, decisionHash: canonicalSha256(unsigned) };
}

// src/continuity/github.ts
import { createPrivateKey as createPrivateKey6, createPublicKey as createPublicKey6 } from "node:crypto";
var MAX_GITHUB_EVENT_BYTES = 32 * 1024 * 1024;
var MAX_SECRET_BYTES = 64 * 1024;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var GIT_SHA2 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var SIGNATURE = /^sha256=[0-9a-f]{64}$/;
var REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return new Date(parsed).toISOString();
}
function fullSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA2.test(value)) throw new Error(`${label} must be a full lowercase Git object ID`);
  return value;
}
function normalizeDeliveryId(value) {
  const normalized = value.toLowerCase();
  if (!UUID.test(normalized)) throw new Error("--delivery-id must be a canonical UUID");
  return normalized;
}
function uuidFromDigest(value) {
  const hexadecimal = value.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{64}$/.test(hexadecimal)) throw new Error("GitHub evidence identity is invalid");
  const uuid = `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-5${hexadecimal.slice(13, 16)}-8${hexadecimal.slice(17, 20)}-${hexadecimal.slice(20, 32)}`;
  return uuid;
}
function githubRepositoryFromRemote(remote) {
  if (typeof remote !== "string" || !remote.trim()) throw new Error("the original receipt does not name a GitHub repository");
  const selected = remote.trim().replace(/^git\+/, "");
  let match = selected.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i) ?? selected.match(/^(?:https?|ssh):\/\/(?:git@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i) ?? selected.match(/^github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i);
  if (!match) throw new Error("the original receipt does not name a supported GitHub repository remote");
  const repository2 = match[1].replace(/\.git$/i, "");
  if (!REPOSITORY.test(repository2)) throw new Error("the original receipt has an invalid GitHub repository name");
  return repository2.toLowerCase();
}
function labels(value) {
  if (!Array.isArray(value?.labels) || value.labels.length > 100) return [];
  return value.labels.map((label) => typeof label === "string" ? label : label?.name).filter((label) => typeof label === "string" && label.length <= 100);
}
function linked(labelsValue, head) {
  const wanted = `agent-vigil:${head}`;
  return labelsValue.some((label) => label.toLowerCase() === wanted);
}
function target(kind, repository2, identifier2) {
  return sha2566(`agent-vigil-github-target/v1\0${kind}\0${repository2}\0${identifier2}`);
}
function classify(payload, root, repository2) {
  const payloadRepository = payload?.repository?.full_name;
  if (typeof payloadRepository !== "string" || payloadRepository.toLowerCase() !== repository2) {
    throw new Error("GitHub evidence belongs to a different repository");
  }
  const pull = payload?.pull_request;
  if (pull && typeof pull === "object") {
    if (payload.action !== "closed" || pull.state !== "closed" || pull.merged !== true || !Number.isSafeInteger(pull.number) || pull.number <= 0) {
      throw new Error("GitHub pull-request evidence must describe a completed merge");
    }
    const mergeSha = fullSha(pull.merge_commit_sha, "GitHub merge commit");
    const pullLabels = labels(pull);
    const hotfix = pullLabels.some((label) => /^(?:hotfix|emergency[- ]fix)$/i.test(label));
    if (hotfix) {
      if (!linked(pullLabels, root.subject.headSha)) throw new Error("hotfix evidence must carry the exact Agent Vigil head link label");
      return {
        kind: "hotfix_observed",
        disposition: "observe",
        reasonCode: "github.hotfix.linked",
        effectiveAt: canonicalTimestamp(pull.merged_at, "GitHub hotfix merge time"),
        targetHash: target("hotfix", repository2, mergeSha)
      };
    }
    if (fullSha(pull.base?.sha, "GitHub pull-request base") !== root.subject.baseSha || fullSha(pull.head?.sha, "GitHub pull-request head") !== root.subject.headSha) {
      throw new Error("GitHub merge evidence does not match the original base and head commits");
    }
    return {
      kind: "merge_observed",
      disposition: "affirm",
      reasonCode: "github.merge.verified",
      effectiveAt: canonicalTimestamp(pull.merged_at, "GitHub merge time"),
      targetHash: target("merge", repository2, mergeSha)
    };
  }
  const issue = payload?.issue;
  if (issue && typeof issue === "object" && !issue.pull_request) {
    if (!Number.isSafeInteger(issue.number) || issue.number <= 0 || !(/* @__PURE__ */ new Set(["open", "closed"])).has(issue.state)) {
      throw new Error("GitHub incident evidence must describe an open or closed numbered issue");
    }
    const issueLabels = labels(issue);
    if (!issueLabels.some((label) => /^(?:incident|outage|sev[- ]?[0-9]+)$/i.test(label))) {
      throw new Error("GitHub issue evidence must carry an incident, outage, or severity label");
    }
    if (!linked(issueLabels, root.subject.headSha)) throw new Error("incident evidence must carry the exact Agent Vigil head link label");
    const issueId = Number.isSafeInteger(issue.id) && issue.id > 0 ? String(issue.id) : void 0;
    if (!issueId) throw new Error("GitHub incident evidence must include a numeric issue ID");
    return {
      kind: "incident_linked",
      disposition: "observe",
      reasonCode: "github.incident.linked",
      effectiveAt: canonicalTimestamp(issue.updated_at ?? issue.created_at, "GitHub incident time"),
      targetHash: target("incident", repository2, issueId)
    };
  }
  if (Array.isArray(payload?.commits)) {
    if (payload.commits.length > 2048) throw new Error("GitHub push evidence contains too many commits");
    const after = fullSha(payload.after, "GitHub push head");
    const revert = payload.commits.find((commit2) => {
      const id = typeof commit2?.id === "string" ? commit2.id : "";
      const message = typeof commit2?.message === "string" ? commit2.message : "";
      return GIT_SHA2.test(id) && new RegExp(`(?:This reverts commit|reverts?)[ :]+${root.subject.headSha}(?:\\b|$)`, "i").test(message);
    });
    if (!revert) throw new Error("GitHub push evidence does not contain an exact revert link to the original head commit");
    return {
      kind: "revert_observed",
      disposition: "revoke",
      reasonCode: "github.revert.linked",
      effectiveAt: canonicalTimestamp(revert.timestamp ?? payload.head_commit?.timestamp, "GitHub revert time"),
      targetHash: target("revert", repository2, after)
    };
  }
  throw new Error("GitHub evidence is not a supported merge, revert, hotfix, or linked incident event");
}
function eventNameFor(payload) {
  if (payload?.pull_request && typeof payload.pull_request === "object") return "pull_request";
  if (payload?.issue && typeof payload.issue === "object" && !payload.issue.pull_request) return "issues";
  if (Array.isArray(payload?.commits)) return "push";
  throw new Error("GitHub Actions evidence is not a supported pull_request, issues, or push event");
}
function readSecret(path) {
  const raw = readBoundedRegularFile(path, MAX_SECRET_BYTES, "GitHub webhook secret").toString("utf8");
  const secret = raw.replace(/\r?\n$/, "");
  if (!secret || secret.length > 4096 || /[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error("GitHub webhook secret is empty or invalid");
  }
  return secret;
}
function signingIssuer(path) {
  const key = createPrivateKey6(readBoundedRegularFile(path, 64 * 1024, "continuity signing key"));
  if (key.asymmetricKeyType !== "ed25519") throw new Error("continuity signing key must be Ed25519");
  return signingKeyId(publicKeyDer(createPublicKey6(key)));
}
function publicReceipt(event2, appended) {
  return {
    schemaVersion: "agent-vigil-github-import/v1",
    appended,
    eventId: event2.eventId,
    sequence: event2.sequence,
    kind: event2.event.kind,
    disposition: event2.event.disposition,
    eventHash: event2.eventHash,
    evidenceHash: event2.source.evidenceHash,
    deliveryIdHash: event2.source.deliveryIdHash
  };
}
function storedDraft(event2) {
  const { sequence: _sequence, predecessorHash: _predecessor, eventHash: _hash, signature: _signature, ...draft } = event2;
  return draft;
}
function appendIdempotently(chain, draft, signingKeyPath) {
  const verified = verifyContinuityChain(chain);
  if (!verified.valid) throw new Error(`continuity chain is invalid: ${verified.errors.join("; ")}`);
  const existing = verified.events.find((event2) => event2.source.deliveryIdHash === draft.source.deliveryIdHash);
  if (existing) {
    const signatureMatches = signingKeyPath ? existing.signature?.keyId === draft.source.issuer : existing.signature === null;
    if (canonical(storedDraft(existing)) !== canonical(draft) || !signatureMatches) {
      throw new Error("the GitHub delivery ID was already recorded with different evidence");
    }
    return publicReceipt(existing, false);
  }
  return publicReceipt(appendContinuityEvent(chain, draft, signingKeyPath), true);
}
function importGitHubOutcome(options) {
  const deliveryId = normalizeDeliveryId(options.deliveryId);
  const deliveryIdHash = sha2566(`agent-vigil-github-delivery/v1\0${deliveryId}`);
  const verified = verifyContinuityChain(options.chain);
  if (!verified.valid) throw new Error(`continuity chain is invalid: ${verified.errors.join("; ")}`);
  const signingKeyPath = options.signingKeyPath;
  if (options.unavailable) {
    if (options.eventPath || options.webhookSignature || options.webhookSecretPath) {
      throw new Error("--unavailable cannot be combined with webhook evidence options");
    }
    if (!signingKeyPath) throw new Error("--unavailable requires --signing-key so the local outage record has an accountable issuer");
    const observedAt = canonicalTimestamp(options.observedAt, "--observed-at");
    const draft2 = validateEventDraft({
      schemaVersion: "agent-vigil-continuity-event/v1",
      eventId: `urn:uuid:${deliveryId}`,
      subject: verified.root.subject,
      source: {
        kind: "github-outcome",
        issuer: signingIssuer(signingKeyPath),
        evidenceHash: canonicalSha256({ schemaVersion: "agent-vigil-github-outage/v1", deliveryIdHash, observedAt }),
        deliveryIdHash
      },
      event: {
        kind: "coverage_gap",
        disposition: "hold",
        reasonCode: "github.adapter.unavailable",
        targetHash: null,
        freshUntil: null,
        supersedesEventId: null
      },
      observedAt,
      effectiveAt: observedAt,
      privacyTier: "receipt"
    });
    return appendIdempotently(options.chain, draft2, signingKeyPath);
  }
  if (!options.eventPath || !options.webhookSecretPath || !options.webhookSignature) {
    throw new Error("GitHub import requires --event, --webhook-secret-file, and --webhook-signature");
  }
  if (options.observedAt) throw new Error("--observed-at is valid only with --unavailable");
  if (!SIGNATURE.test(options.webhookSignature)) throw new Error("--webhook-signature must be a lowercase SHA-256 GitHub signature");
  const raw = readBoundedRegularFile(options.eventPath, MAX_GITHUB_EVENT_BYTES, "GitHub event evidence");
  const secret = readSecret(options.webhookSecretPath);
  if (!verifyWebhookSignature(secret, raw, options.webhookSignature)) throw new Error("GitHub webhook signature is invalid");
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("GitHub event evidence is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("GitHub event evidence must be an object");
  const repository2 = githubRepositoryFromRemote(verified.report.repository.remote);
  const outcome = classify(payload, verified.root, repository2);
  const evidence = buildGitHubWebhookEvidence(raw, new Date(outcome.effectiveAt));
  const issuer = signingKeyPath ? signingIssuer(signingKeyPath) : sha2566("agent-vigil-github-authenticated-source/v1");
  const draft = validateEventDraft({
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: `urn:uuid:${deliveryId}`,
    subject: verified.root.subject,
    source: {
      kind: "github-outcome",
      issuer,
      evidenceHash: evidence.evidenceHash,
      deliveryIdHash
    },
    event: {
      kind: outcome.kind,
      disposition: outcome.disposition,
      reasonCode: outcome.reasonCode,
      targetHash: outcome.targetHash,
      freshUntil: null,
      supersedesEventId: null
    },
    observedAt: outcome.effectiveAt,
    effectiveAt: outcome.effectiveAt,
    privacyTier: "receipt"
  });
  return appendIdempotently(options.chain, draft, signingKeyPath);
}
function importGitHubActionsOutcome(options) {
  const environment = options.environment ?? process.env;
  if (environment.GITHUB_ACTIONS !== "true") {
    throw new Error("GitHub Actions import must run inside GitHub Actions");
  }
  const eventPath = environment.GITHUB_EVENT_PATH;
  const eventName = environment.GITHUB_EVENT_NAME;
  const actionsRepository = environment.GITHUB_REPOSITORY?.toLowerCase();
  if (!eventPath) throw new Error("GitHub Actions did not provide GITHUB_EVENT_PATH");
  if (!eventName || !(/* @__PURE__ */ new Set(["pull_request", "issues", "push"])).has(eventName)) {
    throw new Error("GitHub Actions event must be pull_request, issues, or push");
  }
  if (!actionsRepository || !REPOSITORY.test(actionsRepository)) {
    throw new Error("GitHub Actions did not provide a valid GITHUB_REPOSITORY");
  }
  if (!options.signingKeyPath) throw new Error("GitHub Actions import requires --signing-key");
  const verified = verifyContinuityChain(options.chain);
  if (!verified.valid) throw new Error(`continuity chain is invalid: ${verified.errors.join("; ")}`);
  const receiptRepository = githubRepositoryFromRemote(verified.report.repository.remote);
  if (actionsRepository !== receiptRepository) {
    throw new Error("GitHub Actions is running for a different repository than the original receipt");
  }
  const raw = readBoundedRegularFile(eventPath, MAX_GITHUB_EVENT_BYTES, "GitHub Actions event evidence");
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("GitHub Actions event evidence is not valid JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("GitHub Actions event evidence must be an object");
  }
  if (eventNameFor(payload) !== eventName) {
    throw new Error("GITHUB_EVENT_NAME does not match the GitHub Actions event body");
  }
  const outcome = classify(payload, verified.root, receiptRepository);
  const evidenceHash = buildGitHubWebhookEvidence(raw, new Date(outcome.effectiveAt)).evidenceHash;
  const deliveryIdHash = canonicalSha256({
    schemaVersion: "agent-vigil-github-actions-delivery/v1",
    eventName,
    repositoryHash: verified.root.subject.repositoryHash,
    evidenceHash
  });
  const issuer = signingIssuer(options.signingKeyPath);
  const draft = validateEventDraft({
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: `urn:uuid:${uuidFromDigest(deliveryIdHash)}`,
    subject: verified.root.subject,
    source: {
      kind: "github-outcome",
      issuer,
      evidenceHash,
      deliveryIdHash
    },
    event: {
      kind: outcome.kind,
      disposition: outcome.disposition,
      reasonCode: outcome.reasonCode,
      targetHash: outcome.targetHash,
      freshUntil: null,
      supersedesEventId: null
    },
    observedAt: outcome.effectiveAt,
    effectiveAt: outcome.effectiveAt,
    privacyTier: "receipt"
  });
  return appendIdempotently(options.chain, draft, options.signingKeyPath);
}

// src/continuity/demo.ts
var BASE = "1".repeat(40);
var HEAD = "2".repeat(40);
var TREE = "3".repeat(40);
var MERGE = "4".repeat(40);
var REVERT = "5".repeat(40);
var TIMES = [
  "2026-08-23T12:00:00.000Z",
  "2026-08-23T12:01:00.000Z",
  "2026-08-23T12:02:00.000Z",
  "2026-08-23T12:03:00.000Z",
  "2026-08-23T12:04:00.000Z"
];
function event(root, sequence, at) {
  const suffix = String(sequence).padStart(12, "0");
  return {
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: `urn:uuid:00000000-0000-4000-8000-${suffix}`,
    subject: root.subject,
    source: {
      kind: "verification",
      issuer: sha2566(`demo-verifier-${sequence}`),
      evidenceHash: sha2566(`demo-evidence-${sequence}`),
      deliveryIdHash: null
    },
    event: {
      kind: "verification_refreshed",
      disposition: "affirm",
      reasonCode: "verification.passed",
      targetHash: sha2566(`demo-verification-target-${sequence}`),
      freshUntil: "2026-08-23T13:00:00.000Z",
      supersedesEventId: null
    },
    observedAt: at,
    effectiveAt: at,
    privacyTier: "receipt"
  };
}
function signedWebhook(path, payload, secret) {
  const bytes = Buffer.from(JSON.stringify(payload));
  writeFileSync7(path, bytes, { mode: 384 });
  return {
    path,
    deliverySignature: `sha256=${createHmac2("sha256", secret).update(bytes).digest("hex")}`
  };
}
function runContinuityDemo() {
  const directory = mkdtempSync4(join10(tmpdir4(), "vigil-continuity-demo-"));
  try {
    const rootPrivate = join10(directory, "root-private.pem");
    const rootPublic = join10(directory, "root-public.pem");
    const repairPrivate = join10(directory, "repair-private.pem");
    const repairPublic = join10(directory, "repair-public.pem");
    generateSigningKey(rootPrivate, rootPublic);
    generateSigningKey(repairPrivate, repairPublic);
    const check = {
      claim: { kind: "tests_pass", quote: "the reviewed change passed", subject: "reviewed change" },
      verdict: "verified",
      evidence: "the required check completed"
    };
    const report = signReport(buildReport({
      transcript: "private/session.jsonl",
      transcriptSha256: sha2566("private demonstration transcript"),
      transcriptFormat: "codex",
      repo: "/private/demonstration-repository",
      base: BASE,
      head: HEAD,
      results: [check],
      policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: sha2566("demonstration receipt policy") },
      repository: { remote: "https://github.com/example/demonstration.git", tree: TREE },
      reproduction: "private demonstration command"
    }), rootPrivate);
    const receiptPath = join10(directory, "receipt.json");
    writeFileSync7(receiptPath, `${JSON.stringify(report, null, 2)}
`, { mode: 384 });
    const chain = join10(directory, "chain");
    const root = initializeContinuityChain(receiptPath, chain, new Date(TIMES[0]));
    const policyValue = validateContinuityPolicy({
      schemaVersion: "agent-vigil-continuity-policy/v1",
      requiredSources: ["verification", "github-outcome"],
      maxAgeSeconds: { verification: 3600, "github-outcome": 3600 },
      denyOn: ["revert_observed", "incident_linked", "attestation_invalid", "credential_revoked"],
      allowRemediation: true,
      requireSignedRoot: true,
      requireSignedEvents: false,
      trustedRootKeyIds: [publicKeyId(rootPublic)],
      trustedIssuerKeyIds: [publicKeyId(repairPublic)],
      protectedEnvironments: ["production"],
      maxClockSkewSeconds: 300
    });
    const policy = {
      value: policyValue,
      source: "built-in-demonstration-policy",
      sha256: canonicalSha256(policyValue)
    };
    const decide = (at) => evaluateContinuity(
      verifyContinuityChain(chain, { now: new Date(at), maxClockSkewSeconds: 300 }),
      policy,
      { now: new Date(at), environment: "production" }
    );
    appendContinuityEvent(chain, event(root, 1, TIMES[0]));
    const secret = "demonstration-only-webhook-secret";
    const secretPath = join10(directory, "webhook-secret.txt");
    writeFileSync7(secretPath, secret, { mode: 384 });
    const merge = signedWebhook(join10(directory, "merge.json"), {
      action: "closed",
      repository: { full_name: "example/demonstration" },
      pull_request: {
        number: 14,
        state: "closed",
        merged: true,
        merged_at: TIMES[1],
        merge_commit_sha: MERGE,
        base: { sha: BASE },
        head: { sha: HEAD },
        labels: []
      }
    }, secret);
    importGitHubOutcome({
      chain,
      eventPath: merge.path,
      deliveryId: "11111111-1111-4111-8111-111111111111",
      webhookSignature: merge.deliverySignature,
      webhookSecretPath: secretPath
    });
    const current = decide(TIMES[1]);
    const revert = signedWebhook(join10(directory, "revert.json"), {
      repository: { full_name: "example/demonstration" },
      after: REVERT,
      commits: [{ id: REVERT, message: `This reverts commit ${HEAD}`, timestamp: TIMES[2] }],
      head_commit: { timestamp: TIMES[2] }
    }, secret);
    const revokedRecord = importGitHubOutcome({
      chain,
      eventPath: revert.path,
      deliveryId: "22222222-2222-4222-8222-222222222222",
      webhookSignature: revert.deliverySignature,
      webhookSecretPath: secretPath
    });
    const revoked = decide(TIMES[2]);
    appendContinuityEvent(chain, event(root, 2, TIMES[3]));
    const stillRevoked = decide(TIMES[3]);
    const repair = {
      schemaVersion: "agent-vigil-continuity-event/v1",
      eventId: "urn:uuid:33333333-3333-4333-8333-333333333333",
      subject: root.subject,
      source: {
        kind: "verification",
        issuer: publicKeyId(repairPublic),
        evidenceHash: sha2566("independent repair evidence"),
        deliveryIdHash: null
      },
      event: {
        kind: "remediation_verified",
        disposition: "affirm",
        reasonCode: "repair.independently.verified",
        targetHash: sha2566("verified repaired change"),
        freshUntil: "2026-08-23T13:04:00.000Z",
        supersedesEventId: revokedRecord.eventId
      },
      observedAt: TIMES[4],
      effectiveAt: TIMES[4],
      privacyTier: "receipt"
    };
    appendContinuityEvent(chain, repair, repairPrivate);
    const restored = decide(TIMES[4]);
    if (current.continuity !== "CURRENT" || revoked.continuity !== "REVOKED" || stillRevoked.continuity !== "REVOKED" || restored.continuity !== "CURRENT") {
      throw new Error("the continuity demonstration did not reach its required states");
    }
    return {
      schemaVersion: "agent-vigil-continuity-demo/v1",
      steps: [
        { step: 1, evidence: "Original change check", result: "PASS", deployment: "not evaluated", explanation: "The change passed its original check." },
        { step: 2, evidence: "Verified merge and a fresh check", result: "CURRENT", deployment: "allowed", explanation: "The required records are present and current." },
        { step: 3, evidence: "Authenticated revert", result: "REVOKED", deployment: "stopped", explanation: "The revert contradicts the earlier approval." },
        { step: 4, evidence: "Later ordinary green check", result: "REVOKED", deployment: "stopped", explanation: "A later green check does not erase the recorded revert." },
        { step: 5, evidence: "Independent signed repair check", result: "CURRENT", deployment: "allowed", explanation: "Independent repair evidence closes the exact revocation." }
      ],
      history: verifyContinuityChain(chain).events.map((item2) => item2.event.kind)
    };
  } finally {
    rmSync3(directory, { recursive: true, force: true });
  }
}
function renderContinuityDemo(result5) {
  return [
    "Agent Vigil continuity demonstration",
    "",
    ...result5.steps.flatMap((step) => [
      `${step.step}. ${step.evidence}`,
      `   Result: ${step.result}`,
      `   Deployment: ${step.deployment}`,
      `   ${step.explanation}`,
      ""
    ]),
    "Complete history",
    ...result5.history.map((kind, index) => `  ${index + 1}. ${kind.replaceAll("_", " ")}`)
  ].join("\n");
}

// src/continuity/presentation.ts
function publicChainVerification(value) {
  return {
    schemaVersion: "agent-vigil-continuity-verification/v1",
    valid: value.valid,
    historicalVerification: value.root.historicalVerification,
    rootHash: value.root.rootHash,
    chainTip: value.chainTip,
    eventCount: value.events.length,
    rootSignature: value.rootSignature,
    errors: value.errors.map((error) => terminalSafe(error))
  };
}
function renderChainVerification(value) {
  const lines = [
    `Agent Vigil continuity chain: ${value.valid ? "VALID" : "INVALID"}`,
    `  historical verification: ${value.root.historicalVerification}`,
    `  events: ${value.events.length}`,
    `  root: ${value.root.rootHash}`,
    `  tip:  ${value.chainTip}`,
    `  root signature: ${value.rootSignature.present ? value.rootSignature.valid ? "valid" : "invalid" : "absent"}`
  ];
  for (const error of value.errors) lines.push(`  \u2717 ${terminalSafe(error)}`);
  return lines.join("\n");
}
function renderContinuityDecision(value) {
  const lines = [
    `Agent Vigil continuity: ${value.continuity}`,
    `  historical verification: ${value.historicalVerification}`,
    `  protected action: ${value.allowsProtectedAction ? "ALLOW" : "DENY"}`,
    `  events: ${value.eventCount}`,
    `  root: ${value.rootHash}`,
    `  tip:  ${value.chainTip}`,
    `  policy: ${value.policy.sha256}`
  ];
  for (const reason of value.reasons) {
    const marker2 = reason.disposition === "revoke" ? "\u2717" : reason.disposition === "expire" ? "\u231B" : reason.disposition === "hold" ? "?" : "\u2713";
    lines.push(`  ${marker2} [${terminalSafe(reason.ruleId)}] ${terminalSafe(reason.message)}`);
  }
  for (const fact of value.outcomeFacts) lines.push(`  \u2022 outcome: ${fact.kind} at ${fact.observedAt}`);
  lines.push(`  ${value.decisionHash}`);
  return lines.join("\n");
}

// src/continuity/workflow.ts
import { execFileSync as execFileSync18 } from "node:child_process";
import { existsSync as existsSync11, lstatSync as lstatSync13, mkdirSync as mkdirSync8, realpathSync as realpathSync12 } from "node:fs";
import { join as join11, resolve as resolve23, sep as sep13 } from "node:path";
var ACTION_COMMIT = /^[0-9a-f]{40}$/;
var CHECKOUT_COMMIT2 = "3d3c42e5aac5ba805825da76410c181273ba90b1";
var DOWNLOAD_COMMIT = "634f93cb2916e3fdff6788551b99b062d0335ce0";
var UPLOAD_COMMIT2 = "ea165f8d65b6e75b540449e92b4886f43607fa02";
function repositoryRoot(path) {
  let root;
  try {
    root = execFileSync18("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolve23(path),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch {
    throw new Error("--repo must name a Git repository");
  }
  const canonical3 = realpathSync12(root);
  if (!lstatSync13(canonical3).isDirectory()) throw new Error("Git repository root is not a directory");
  return canonical3;
}
function ensureSafeParent(root, target2) {
  const relative15 = target2.slice(root.length).split(sep13).filter(Boolean).slice(0, -1);
  let current = root;
  for (const part of relative15) {
    current = join11(current, part);
    if (existsSync11(current)) {
      const status = lstatSync13(current);
      if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("continuity setup refuses symbolic-link or non-directory parents");
    } else {
      mkdirSync8(current, { mode: 448 });
    }
  }
}
function policyTemplate2() {
  return {
    schemaVersion: "agent-vigil-continuity-policy/v1",
    requiredSources: ["verification", "github-outcome"],
    maxAgeSeconds: { verification: 86400, "github-outcome": 86400 },
    denyOn: ["revert_observed", "incident_linked", "attestation_invalid", "credential_revoked"],
    allowRemediation: true,
    requireSignedRoot: true,
    requireSignedEvents: true,
    trustedRootKeyIds: [],
    trustedIssuerKeyIds: [],
    protectedEnvironments: ["production"],
    maxClockSkewSeconds: 300
  };
}
function workflow2(actionCommit, sourceWorkflow) {
  return `name: Agent Vigil continuity gate

on:
  workflow_run:
    workflows: [${JSON.stringify(sourceWorkflow)}]
    types: [completed]
  workflow_dispatch:
    inputs:
      artifact_run_id:
        description: Run ID containing the agent-vigil-continuity artifact
        required: true
        type: string
      expected_head:
        description: Exact reviewed commit in that artifact
        required: true
        type: string
      environment:
        description: Protected environment named by the policy
        required: true
        default: production
        type: string

permissions:
  actions: read
  contents: read

jobs:
  continuity:
    name: Check whether the change is still approved
    runs-on: ubuntu-latest
    outputs:
      state: \${{ steps.vigil.outputs.status }}
      head: \${{ steps.identity.outputs.head }}
      environment: \${{ steps.source.outputs.environment }}
    steps:
      - id: source
        name: Select the exact evidence run
        env:
          EVENT_NAME: \${{ github.event_name }}
          EVENT_RUN_ID: \${{ github.event.workflow_run.id }}
          EVENT_HEAD: \${{ github.event.workflow_run.head_sha }}
          EVENT_CONCLUSION: \${{ github.event.workflow_run.conclusion }}
          INPUT_RUN_ID: \${{ inputs.artifact_run_id }}
          INPUT_HEAD: \${{ inputs.expected_head }}
          INPUT_ENVIRONMENT: \${{ inputs.environment }}
        run: |
          if [[ "$EVENT_NAME" == "workflow_run" ]]; then
            if [[ "$EVENT_CONCLUSION" != "success" ]]; then
              echo "The evidence run did not complete successfully." >&2
              exit 3
            fi
            run_id="$EVENT_RUN_ID"
            expected_head="$EVENT_HEAD"
            environment="production"
          else
            run_id="$INPUT_RUN_ID"
            expected_head="$INPUT_HEAD"
            environment="$INPUT_ENVIRONMENT"
          fi
          if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
            echo "The evidence run ID is invalid." >&2
            exit 2
          fi
          if [[ ! "$expected_head" =~ ^[0-9a-f]{40}$ ]]; then
            echo "The expected commit must be a full lowercase commit ID." >&2
            exit 2
          fi
          if [[ ! "$environment" =~ ^[a-z0-9][a-z0-9._-]{0,79}$ ]]; then
            echo "The protected environment name is invalid." >&2
            exit 2
          fi
          {
            echo "run_id=$run_id"
            echo "expected_head=$expected_head"
            echo "environment=$environment"
          } >> "$GITHUB_OUTPUT"
      - name: Download the recorded continuity history
        uses: actions/download-artifact@${DOWNLOAD_COMMIT}
        with:
          name: agent-vigil-continuity
          path: \${{ runner.temp }}/agent-vigil-continuity-\${{ github.run_id }}-\${{ github.run_attempt }}
          github-token: \${{ github.token }}
          run-id: \${{ steps.source.outputs.run_id }}
      - id: identity
        name: Read the exact base and head commits
        env:
          EXPECTED_HEAD: \${{ steps.source.outputs.expected_head }}
          CHAIN_ROOT: \${{ runner.temp }}/agent-vigil-continuity-\${{ github.run_id }}-\${{ github.run_attempt }}
        run: |
          node <<'NODE'
          const fs = require("node:fs");
          const path = require("node:path");
          const root = JSON.parse(fs.readFileSync(path.join(process.env.CHAIN_ROOT, "root.json"), "utf8"));
          const full = /^[0-9a-f]{40}$/;
          if (!full.test(root?.subject?.baseSha ?? "") || !full.test(root?.subject?.headSha ?? "")) {
            throw new Error("The continuity history does not contain full commit IDs.");
          }
          if (root.subject.headSha !== process.env.EXPECTED_HEAD) {
            throw new Error("The continuity history belongs to a different commit.");
          }
          fs.appendFileSync(process.env.GITHUB_OUTPUT, "base=" + root.subject.baseSha + "\\nhead=" + root.subject.headSha + "\\n");
          NODE
      - name: Check out the exact reviewed commit without stored credentials
        uses: actions/checkout@${CHECKOUT_COMMIT2}
        with:
          fetch-depth: 0
          persist-credentials: false
          ref: \${{ steps.identity.outputs.head }}
      - id: vigil
        name: Decide whether deployment is allowed
        uses: sulmusic2-star/agent-vigil@${actionCommit}
        with:
          mode: continuity
          continuity-chain: \${{ runner.temp }}/agent-vigil-continuity-\${{ github.run_id }}-\${{ github.run_attempt }}
          continuity-environment: \${{ steps.source.outputs.environment }}
          policy: .agent-vigil-continuity.json
          policy-ref: \${{ steps.identity.outputs.base }}
          repo: .
          head: \${{ steps.identity.outputs.head }}
      - name: Retain the decision
        if: always() && steps.vigil.outputs.report != ''
        uses: actions/upload-artifact@${UPLOAD_COMMIT2}
        with:
          name: agent-vigil-continuity-decision-\${{ steps.source.outputs.run_id }}
          path: \${{ steps.vigil.outputs.report }}
          retention-days: 30

  deployment:
    name: Protected deployment placeholder
    needs: continuity
    if: needs.continuity.outputs.state == 'CURRENT'
    runs-on: ubuntu-latest
    environment: \${{ needs.continuity.outputs.environment }}
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${CHECKOUT_COMMIT2}
        with:
          fetch-depth: 1
          persist-credentials: false
          ref: \${{ needs.continuity.outputs.head }}
      - name: Reviewed deployment step goes here
        run: echo "Continuity accepted. Add reviewed deployment steps here."
`;
}
function labWorkflow(actionCommit) {
  return `# agent-vigil-continuity-lab/v1
name: Agent Vigil continuity lab

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  demonstration:
    name: Build the five-step evidence history
    runs-on: ubuntu-latest
    outputs:
      revoked: \${{ steps.result.outputs.revoked }}
      repaired: \${{ steps.result.outputs.repaired }}
    steps:
      - name: Check out the reviewed Agent Vigil source
        uses: actions/checkout@${CHECKOUT_COMMIT2}
        with:
          repository: sulmusic2-star/agent-vigil
          ref: ${actionCommit}
          path: agent-vigil-continuity-tool
          persist-credentials: false
      - id: result
        name: Prove revocation and independent repair
        env:
          REPORT_PATH: \${{ runner.temp }}/agent-vigil-continuity-lab.json
        run: |
          node agent-vigil-continuity-tool/dist/cli.js continuity demo --format json --output "$REPORT_PATH" >/dev/null
          node <<'NODE'
          const fs = require("node:fs");
          const report = JSON.parse(fs.readFileSync(process.env.REPORT_PATH, "utf8"));
          const revoked = report.steps?.find((step) => step.step === 3)?.result;
          const regreened = report.steps?.find((step) => step.step === 4)?.result;
          const repaired = report.steps?.find((step) => step.step === 5)?.result;
          if (revoked !== "REVOKED" || regreened !== "REVOKED" || repaired !== "CURRENT") {
            throw new Error("The continuity lab did not reach the required states.");
          }
          fs.appendFileSync(process.env.GITHUB_OUTPUT, "revoked=" + revoked + "\\nrepaired=" + repaired + "\\n");
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
            "## Continuity Lab result",
            "",
            "Synthetic demonstration only. No software was deployed.",
            "",
            "| Later evidence | Permission to deploy |",
            "|---|---|",
            "| Verified merge and fresh check | Allowed |",
            "| Authenticated revert | Stopped |",
            "| Another ordinary green check | Still stopped |",
            "| Independent signed repair | Allowed again |",
            "",
          ].join("\\n"));
          NODE
      - name: Retain the readable result
        uses: actions/upload-artifact@${UPLOAD_COMMIT2}
        with:
          name: agent-vigil-continuity-lab
          path: \${{ runner.temp }}/agent-vigil-continuity-lab.json
          retention-days: 7

  blocked-deployment:
    name: Deployment stays stopped after the revert
    needs: demonstration
    if: needs.demonstration.outputs.revoked == 'CURRENT'
    runs-on: ubuntu-latest
    steps:
      - run: echo "This harmless placeholder should remain skipped."

  repaired-action:
    name: Independent repair restores permission
    needs: demonstration
    if: needs.demonstration.outputs.repaired == 'CURRENT'
    runs-on: ubuntu-latest
    steps:
      - run: echo "Independent signed repair restored permission. No deployment was performed."
`;
}
function installContinuityAction(options) {
  if (!ACTION_COMMIT.test(options.actionCommit)) throw new Error("--action-ref must be a full lowercase 40-character commit ID");
  const sourceWorkflow = options.sourceWorkflow ?? "Agent Vigil";
  if (!/^[A-Za-z0-9 ._-]{1,80}$/.test(sourceWorkflow)) throw new Error("--source-workflow contains unsupported characters");
  const root = repositoryRoot(options.repo);
  const files = [
    { path: ".agent-vigil-continuity.json", content: `${JSON.stringify(policyTemplate2(), null, 2)}
` },
    { path: ".github/workflows/agent-vigil-continuity.yml", content: workflow2(options.actionCommit, sourceWorkflow) },
    ...options.selfServe ? [{
      path: ".github/workflows/agent-vigil-continuity-lab.yml",
      content: labWorkflow(options.actionCommit)
    }] : []
  ];
  const result5 = {
    repository: root,
    created: [],
    replaced: [],
    actionCommit: options.actionCommit,
    selfServe: Boolean(options.selfServe)
  };
  if (!options.force) {
    const existing = files.find((file) => existsSync11(resolve23(root, file.path)));
    if (existing) throw new Error(`${existing.path} already exists; use --force only after reviewing the current file`);
  }
  for (const file of files) {
    const destination = resolve23(root, file.path);
    ensureSafeParent(root, destination);
    const replaced = existsSync11(destination);
    writePrivateFileAtomic(destination, file.content);
    (replaced ? result5.replaced : result5.created).push(file.path);
  }
  return result5;
}

// src/continuity/cli.ts
var VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--output",
  "--chain",
  "--event",
  "--signing-key",
  "--public-key",
  "--format",
  "--policy",
  "--policy-ref",
  "--repo",
  "--now",
  "--environment",
  "--delivery-id",
  "--webhook-signature",
  "--webhook-secret-file",
  "--observed-at",
  "--expected-head",
  "--action-ref",
  "--source-workflow",
  "--expected-github-repository"
]);
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["--json", "--unavailable", "--force", "--self-serve"]);
function usage2() {
  return `Agent Vigil continuity \u2014 offline successor evidence for one exact receipt

Usage:
  vigil continuity init <receipt.json> --output <chain-directory>
  vigil continuity append --chain <directory> --event <event.json> [--signing-key <private.pem>]
  vigil continuity import-github --chain <directory> --event <webhook.json> --delivery-id <uuid> --webhook-signature <sha256=...> --webhook-secret-file <file> [--signing-key <private.pem>]
  vigil continuity import-github --chain <directory> --unavailable --delivery-id <uuid> --observed-at <RFC3339> --signing-key <private.pem>
  vigil continuity import-github-actions --chain <directory> --signing-key <private.pem>
  vigil continuity demo [--format text|json] [--output <file>]
  vigil continuity install-action --repo <path> --action-ref <full-commit-sha> [--source-workflow <name>] [--self-serve] [--force] [--format text|json]
  vigil continuity verify --chain <directory> [--expected-head <sha>] [--public-key <public.pem>] [--format text|json] [--output <file>]
  vigil continuity status --chain <directory> --policy <policy.json> [--repo <path> --policy-ref <sha>] [--environment <name>] [--expected-head <sha>] [--expected-github-repository <owner/name>] [--now <RFC3339>] [--format text|json] [--output <file>]

Examples:
  vigil continuity init agent-vigil-report.json --output .agent-vigil/continuity
  vigil continuity append --chain .agent-vigil/continuity --event refreshed.json --signing-key operator.pem
  vigil continuity import-github --chain .agent-vigil/continuity --event webhook.json --delivery-id <uuid> --webhook-signature <sha256=...> --webhook-secret-file webhook-secret.txt
  vigil continuity import-github-actions --chain .agent-vigil/continuity --signing-key "$RUNNER_TEMP/outcome-recorder.pem"
  vigil continuity verify --chain .agent-vigil/continuity --json
  vigil continuity status --chain .agent-vigil/continuity --policy .agent-vigil-continuity.json --repo . --policy-ref <base-commit-sha> --environment production

Exit codes:
  0 valid or CURRENT
  1 invalid or REVOKED
  2 usage or schema error
  3 HOLD
  4 EXPIRED`;
}
function runImportGitHubActions(args) {
  const parsed = parse4(args);
  allowed(parsed, ["--chain", "--signing-key", "--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity import-github-actions accepts only named options");
  const chain = required(parsed, "--chain");
  const signingKey = required(parsed, "--signing-key");
  protectOutput(parsed, chain, [signingKey, process.env.GITHUB_EVENT_PATH ?? ""]);
  const receipt = importGitHubActionsOutcome({
    chain: resolve24(chain),
    signingKeyPath: resolve24(signingKey)
  });
  outputJson(parsed.values.get("--output"), receipt);
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}
`);
  } else {
    const label = receipt.kind.replaceAll("_", " ");
    process.stdout.write([
      receipt.appended ? `Recorded ${label} from GitHub Actions.` : `The ${label} event was already recorded; no duplicate was added.`,
      `  history entries: ${receipt.sequence}`,
      `  result: ${receipt.disposition}`,
      `  record: ${receipt.eventHash}`,
      ""
    ].join("\n"));
  }
  return 0;
}
function allowed(parsed, values, flags = []) {
  for (const key of parsed.values.keys()) if (!values.includes(key)) throw new Error(`${key} is not valid for this continuity command`);
  for (const key of parsed.flags) if (!flags.includes(key)) throw new Error(`${key} is not valid for this continuity command`);
}
function protectOutput(parsed, chain, inputs = []) {
  const output = parsed.values.get("--output");
  if (!output) return;
  const selected = resolve24(output);
  const chainRoot = resolve24(chain);
  const fromChain = relative13(chainRoot, selected);
  if (!fromChain || !fromChain.startsWith("..") && !isAbsolute10(fromChain)) {
    throw new Error("--output must be outside the continuity chain directory");
  }
  if (inputs.some((input) => input && resolve24(input) === selected)) throw new Error("--output must not replace a continuity input");
}
function parse4(args) {
  const positional2 = [];
  const values = /* @__PURE__ */ new Map();
  const flags = /* @__PURE__ */ new Set();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) {
      if (values.has(arg)) throw new Error(`${arg} may be provided only once`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      index += 1;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      if (flags.has(arg)) throw new Error(`${arg} may be provided only once`);
      flags.add(arg);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown continuity option: ${arg}`);
    } else {
      positional2.push(arg);
    }
  }
  return { positional: positional2, values, flags };
}
function required(parsed, name2) {
  const value = parsed.values.get(name2);
  if (!value) throw new Error(`${name2} is required`);
  return value;
}
function selectedFormat(parsed) {
  if (parsed.flags.has("--json") && parsed.values.has("--format")) throw new Error("use either --json or --format, not both");
  const format = parsed.flags.has("--json") ? "json" : parsed.values.get("--format") ?? "text";
  if (format !== "text" && format !== "json") throw new Error("--format must be text or json");
  return format;
}
function selectedNow(parsed) {
  const raw = parsed.values.get("--now");
  if (!raw) return /* @__PURE__ */ new Date();
  const epoch = Date.parse(raw);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== raw) throw new Error("--now must be canonical RFC3339 UTC");
  return new Date(epoch);
}
function outputJson(path, value) {
  if (path) writePrivateFileAtomic(resolve24(path), `${JSON.stringify(value, null, 2)}
`);
}
function runInit2(args) {
  const parsed = parse4(args);
  allowed(parsed, ["--output"]);
  if (parsed.positional.length !== 1) throw new Error("continuity init requires exactly one Agent Vigil receipt path");
  const output = required(parsed, "--output");
  const root = initializeContinuityChain(resolve24(parsed.positional[0]), resolve24(output));
  process.stdout.write([
    "Agent Vigil continuity chain initialized",
    `  historical verification: ${root.historicalVerification}`,
    `  root: ${root.rootHash}`,
    "  events: 0",
    "  next: append a typed observation, then evaluate it under a protected policy",
    ""
  ].join("\n"));
  return 0;
}
function runAppend(args) {
  const parsed = parse4(args);
  allowed(parsed, ["--chain", "--event", "--signing-key"]);
  if (parsed.positional.length) throw new Error("continuity append accepts only named options");
  const chain = required(parsed, "--chain");
  const eventPath = required(parsed, "--event");
  const draft = loadEventDraft(resolve24(eventPath));
  const event2 = appendContinuityEvent(resolve24(chain), draft, parsed.values.get("--signing-key") ? resolve24(parsed.values.get("--signing-key")) : void 0);
  process.stdout.write([
    "Agent Vigil continuity event appended",
    `  sequence: ${event2.sequence}`,
    `  kind: ${event2.event.kind}`,
    `  event: ${event2.eventId}`,
    `  hash: ${event2.eventHash}`,
    `  signature: ${event2.signature ? event2.signature.keyId : "absent"}`,
    ""
  ].join("\n"));
  return 0;
}
function runVerify2(args) {
  const parsed = parse4(args);
  allowed(parsed, ["--chain", "--expected-head", "--public-key", "--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity verify accepts only named options");
  const chain = required(parsed, "--chain");
  protectOutput(parsed, chain, [parsed.values.get("--public-key") ?? ""]);
  const pinned = parsed.values.get("--public-key") ? [publicKeyId(resolve24(parsed.values.get("--public-key")))] : void 0;
  const verified = verifyContinuityChain(resolve24(chain), {
    pinnedEventKeyIds: pinned,
    ...parsed.values.get("--expected-head") ? { expectedHead: parsed.values.get("--expected-head") } : {}
  });
  const publicValue = publicChainVerification(verified);
  outputJson(parsed.values.get("--output"), publicValue);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(publicValue, null, 2)}
` : `${renderChainVerification(verified)}
`);
  return verified.valid ? 0 : 1;
}
function runImportGitHub(args) {
  const parsed = parse4(args);
  allowed(parsed, [
    "--chain",
    "--event",
    "--delivery-id",
    "--webhook-signature",
    "--webhook-secret-file",
    "--observed-at",
    "--signing-key",
    "--format",
    "--output"
  ], ["--json", "--unavailable"]);
  if (parsed.positional.length) throw new Error("continuity import-github accepts only named options");
  const chain = required(parsed, "--chain");
  const inputs = ["--event", "--webhook-secret-file", "--signing-key"].map((name2) => parsed.values.get(name2) ?? "");
  protectOutput(parsed, chain, inputs);
  const receipt = importGitHubOutcome({
    chain: resolve24(chain),
    deliveryId: required(parsed, "--delivery-id"),
    ...parsed.values.get("--event") ? { eventPath: resolve24(parsed.values.get("--event")) } : {},
    ...parsed.values.get("--webhook-signature") ? { webhookSignature: parsed.values.get("--webhook-signature") } : {},
    ...parsed.values.get("--webhook-secret-file") ? { webhookSecretPath: resolve24(parsed.values.get("--webhook-secret-file")) } : {},
    ...parsed.values.get("--observed-at") ? { observedAt: parsed.values.get("--observed-at") } : {},
    ...parsed.values.get("--signing-key") ? { signingKeyPath: resolve24(parsed.values.get("--signing-key")) } : {},
    unavailable: parsed.flags.has("--unavailable")
  });
  outputJson(parsed.values.get("--output"), receipt);
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}
`);
  } else {
    const label = receipt.kind.replaceAll("_", " ");
    process.stdout.write([
      receipt.appended ? `Recorded ${label}.` : `The ${label} delivery was already recorded; no duplicate was added.`,
      `  history entries: ${receipt.sequence}`,
      `  result: ${receipt.disposition}`,
      `  record: ${receipt.eventHash}`,
      ""
    ].join("\n"));
  }
  return 0;
}
function runStatus(args) {
  const parsed = parse4(args);
  allowed(parsed, ["--chain", "--policy", "--policy-ref", "--repo", "--now", "--environment", "--expected-head", "--expected-github-repository", "--public-key", "--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity status accepts only named options");
  const chain = required(parsed, "--chain");
  const policyPath = required(parsed, "--policy");
  protectOutput(parsed, chain, [policyPath, parsed.values.get("--public-key") ?? ""]);
  const policyRef = parsed.values.get("--policy-ref");
  const repo = parsed.values.get("--repo");
  if (Boolean(policyRef) !== Boolean(repo)) throw new Error("--policy-ref and --repo must be provided together");
  const policy = loadContinuityPolicy({ path: policyPath, ...repo ? { repo: resolve24(repo) } : {}, ...policyRef ? { ref: policyRef } : {} });
  const now = selectedNow(parsed);
  const pinned = parsed.values.get("--public-key") ? [publicKeyId(resolve24(parsed.values.get("--public-key")))] : void 0;
  const verified = verifyContinuityChain(resolve24(chain), {
    now,
    maxClockSkewSeconds: policy.value.maxClockSkewSeconds,
    pinnedEventKeyIds: pinned,
    ...repo ? { repo: resolve24(repo) } : {},
    ...policyRef ? { expectedBase: policyRef } : {},
    ...parsed.values.get("--expected-head") ? { expectedHead: parsed.values.get("--expected-head") } : {}
  });
  const expectedRepository = parsed.values.get("--expected-github-repository");
  if (expectedRepository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepository)) throw new Error("--expected-github-repository must be owner/name");
    try {
      if (githubRepositoryFromRemote(verified.report.repository.remote) !== expectedRepository.toLowerCase()) {
        verified.errors.push("continuity receipt belongs to a different GitHub repository");
      }
    } catch {
      verified.errors.push("continuity receipt does not contain a supported GitHub repository remote");
    }
    verified.valid = verified.errors.length === 0;
  }
  const decision = evaluateContinuity(verified, policy, { now, environment: parsed.values.get("--environment") });
  outputJson(parsed.values.get("--output"), decision);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(decision, null, 2)}
` : `${renderContinuityDecision(decision)}
`);
  if (decision.continuity === "CURRENT") return 0;
  if (decision.continuity === "REVOKED") return 1;
  if (decision.continuity === "HOLD") return 3;
  return 4;
}
function runDemo2(args) {
  const parsed = parse4(args);
  allowed(parsed, ["--format", "--output"], ["--json"]);
  if (parsed.positional.length) throw new Error("continuity demo accepts only named options");
  const result5 = runContinuityDemo();
  outputJson(parsed.values.get("--output"), result5);
  process.stdout.write(selectedFormat(parsed) === "json" ? `${JSON.stringify(result5, null, 2)}
` : `${renderContinuityDemo(result5)}
`);
  return 0;
}
function runInstallAction(args) {
  const parsed = parse4(args);
  allowed(parsed, ["--repo", "--action-ref", "--source-workflow", "--format"], ["--json", "--force", "--self-serve"]);
  if (parsed.positional.length) throw new Error("continuity install-action accepts only named options");
  const result5 = installContinuityAction({
    repo: resolve24(required(parsed, "--repo")),
    actionCommit: required(parsed, "--action-ref"),
    ...parsed.values.get("--source-workflow") ? { sourceWorkflow: parsed.values.get("--source-workflow") } : {},
    force: parsed.flags.has("--force"),
    selfServe: parsed.flags.has("--self-serve")
  });
  if (selectedFormat(parsed) === "json") {
    process.stdout.write(`${JSON.stringify(result5, null, 2)}
`);
  } else {
    process.stdout.write([
      "Continuity deployment check installed locally.",
      ...result5.created.map((path) => `  created: ${path}`),
      ...result5.replaced.map((path) => `  replaced: ${path}`),
      ...result5.selfServe ? ["  test lab: installed; it uses synthetic evidence and cannot deploy"] : [],
      "  next: add trusted signing key IDs to the policy, review the created files, and commit them",
      "  no deployment step was added",
      ""
    ].join("\n"));
  }
  return 0;
}
function runContinuityCommand(args) {
  if (!args.length || args.includes("--help") || args.includes("-h") || args[0] === "help") {
    console.log(usage2());
    return 0;
  }
  const [command, ...rest] = args;
  try {
    if (command === "init") return runInit2(rest);
    if (command === "append") return runAppend(rest);
    if (command === "import-github") return runImportGitHub(rest);
    if (command === "import-github-actions") return runImportGitHubActions(rest);
    if (command === "verify") return runVerify2(rest);
    if (command === "status") return runStatus(rest);
    if (command === "demo") return runDemo2(rest);
    if (command === "install-action") return runInstallAction(rest);
    throw new Error(`unknown continuity command: ${command}`);
  } catch (error) {
    console.error(`agent-vigil: ${terminalSafe(error instanceof Error ? error.message : String(error))}`);
    return 2;
  }
}

// src/public-pr-receipt-cli.ts
import { resolve as resolve25 } from "node:path";

// src/public-pr-receipt.ts
import {
  createHash as createHash22,
  createPrivateKey as createPrivateKey7,
  createPublicKey as createPublicKey7,
  sign as sign6,
  verify as verify6
} from "node:crypto";
import { readFileSync as readFileSync24 } from "node:fs";
var PUBLIC_PR_RECEIPT_SCHEMA = "agent-vigil-public-pr-receipt/v1";
var FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var SAFE_REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
var MAX_GITHUB_RESPONSE_BYTES = 16 * 1024 * 1024;
var SUCCESSFUL_CHECKS = /* @__PURE__ */ new Set(["success", "neutral", "skipped"]);
var FAILED_CHECKS = /* @__PURE__ */ new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale", "error"]);
function sha2567(raw) {
  return `sha256:${createHash22("sha256").update(raw).digest("hex")}`;
}
function object3(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function string2(value) {
  return typeof value === "string" && value.trim() ? value : void 0;
}
function timestamp6(value) {
  const selected = string2(value);
  if (!selected) return void 0;
  const epoch = Date.parse(selected);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : void 0;
}
function integer4(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function lower(value) {
  return string2(value)?.toLowerCase() ?? "";
}
function parseJson(raw, label) {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}
function parsePublicPullRequestUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("pull request URL must be an absolute https://github.com URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error("pull request URL must be an uncredentialed https://github.com URL without query or fragment data");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 4 || parts[2] !== "pull" || !/^\d+$/.test(parts[3])) {
    throw new Error("pull request URL must match https://github.com/<owner>/<repo>/pull/<number>");
  }
  const [owner, repo] = parts;
  if (!SAFE_REPOSITORY_PART.test(owner) || !SAFE_REPOSITORY_PART.test(repo)) throw new Error("pull request owner or repository is invalid");
  const number = Number(parts[3]);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("pull request number is invalid");
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` };
}
function validateToolCommit(value) {
  if (!FULL_GIT_SHA.test(value)) throw new Error("--tool-ref must be a full lowercase Git commit SHA, not a tag or branch");
  return value;
}
async function defaultPublicPrTransport(url, headers) {
  const response = await fetch(url, { method: "GET", headers, redirect: "error" });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub metadata response exceeds the 16 MiB limit");
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub metadata response exceeds the 16 MiB limit");
  const selected = {
    link: response.headers.get("link") ?? void 0,
    "x-ratelimit-remaining": response.headers.get("x-ratelimit-remaining") ?? void 0
  };
  return { status: response.status, headers: selected, body };
}
function source(kind, endpoint, response) {
  return {
    kind,
    endpoint,
    status: response.status,
    bytes: response.body.length,
    sha256: sha2567(response.body),
    complete: !/rel="next"/.test(response.headers.link ?? "")
  };
}
async function collectPublicPrSnapshot(rawUrl, options = {}) {
  const target2 = parsePublicPullRequestUrl(rawUrl);
  const transport = options.transport ?? defaultPublicPrTransport;
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-vigil-public-pr-receipt"
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const api = `https://api.github.com/repos/${encodeURIComponent(target2.owner)}/${encodeURIComponent(target2.repo)}`;
  const pullEndpoint = `${api}/pulls/${target2.number}`;
  const pullResponse = await transport(pullEndpoint, headers);
  if (pullResponse.status !== 200) throw new Error(`GitHub pull request lookup failed with HTTP ${pullResponse.status}`);
  const pull = object3(parseJson(pullResponse.body, "GitHub pull request lookup"), "GitHub pull request response");
  const head = object3(pull.head, "GitHub pull request head");
  const headSha = string2(head.sha);
  if (!headSha || !FULL_GIT_SHA.test(headSha)) throw new Error("GitHub pull request response did not contain a full head SHA");
  const endpoints = [
    { kind: "reviews", url: `${api}/pulls/${target2.number}/reviews?per_page=100`, select: array },
    { kind: "check-runs", url: `${api}/commits/${headSha}/check-runs?per_page=100`, select: (value) => array(object3(value, "GitHub check-runs response").check_runs) },
    { kind: "commit-statuses", url: `${api}/commits/${headSha}/statuses?per_page=100`, select: array }
  ];
  const responses = await Promise.all(endpoints.map(async (entry) => {
    try {
      return { entry, response: await transport(entry.url, headers) };
    } catch {
      return { entry, response: void 0 };
    }
  }));
  const sources = [source("pull-request", pullEndpoint, pullResponse)];
  const unavailable = [];
  const values = /* @__PURE__ */ new Map();
  for (const item2 of responses) {
    if (!item2.response) {
      unavailable.push(`${item2.entry.kind}:network-error`);
      values.set(item2.entry.kind, []);
      continue;
    }
    const recorded = source(item2.entry.kind, item2.entry.url, item2.response);
    sources.push(recorded);
    if (item2.response.status !== 200) {
      unavailable.push(`${item2.entry.kind}:http-${item2.response.status}`);
      values.set(item2.entry.kind, []);
      continue;
    }
    if (!recorded.complete) unavailable.push(`${item2.entry.kind}:pagination-incomplete`);
    try {
      values.set(item2.entry.kind, item2.entry.select(parseJson(item2.response.body, `GitHub ${item2.entry.kind}`)));
    } catch {
      unavailable.push(`${item2.entry.kind}:invalid-response`);
      values.set(item2.entry.kind, []);
    }
  }
  return {
    pull,
    reviews: values.get("reviews") ?? [],
    checkRuns: values.get("check-runs") ?? [],
    statuses: values.get("commit-statuses") ?? [],
    sources,
    unavailable
  };
}
function latestReviews(records) {
  const latest = /* @__PURE__ */ new Map();
  for (const item2 of records) {
    const review = object3(item2, "GitHub review");
    const user = object3(review.user, "GitHub review user");
    const login = lower(user.login);
    const submittedAt = timestamp6(review.submitted_at);
    if (!login || !submittedAt) continue;
    const previous = latest.get(login);
    if (!previous || Date.parse(submittedAt) >= Date.parse(timestamp6(previous.submitted_at) ?? "1970-01-01T00:00:00.000Z")) latest.set(login, review);
  }
  return [...latest.values()];
}
function checkSummary(checkRuns, statuses) {
  const latestRuns = /* @__PURE__ */ new Map();
  for (const item2 of checkRuns) {
    const check = object3(item2, "GitHub check run");
    const app = check.app && typeof check.app === "object" && !Array.isArray(check.app) ? lower(check.app.slug) : "unknown-app";
    const name2 = lower(check.name) || `id-${integer4(check.id) ?? latestRuns.size}`;
    const key = `${app}:${name2}`;
    const selectedAt = timestamp6(check.completed_at) ?? timestamp6(check.started_at) ?? "1970-01-01T00:00:00.000Z";
    const previous = latestRuns.get(key);
    const previousAt = previous ? timestamp6(previous.completed_at) ?? timestamp6(previous.started_at) ?? "1970-01-01T00:00:00.000Z" : void 0;
    if (!previous || Date.parse(selectedAt) >= Date.parse(previousAt)) latestRuns.set(key, check);
  }
  const latestStatuses = /* @__PURE__ */ new Map();
  for (const item2 of statuses) {
    const status = object3(item2, "GitHub commit status");
    const key = lower(status.context) || `id-${integer4(status.id) ?? latestStatuses.size}`;
    const selectedAt = timestamp6(status.updated_at) ?? timestamp6(status.created_at) ?? "1970-01-01T00:00:00.000Z";
    const previous = latestStatuses.get(key);
    const previousAt = previous ? timestamp6(previous.updated_at) ?? timestamp6(previous.created_at) ?? "1970-01-01T00:00:00.000Z" : void 0;
    if (!previous || Date.parse(selectedAt) >= Date.parse(previousAt)) latestStatuses.set(key, status);
  }
  let passing = 0;
  let failing = 0;
  let pending = 0;
  let unknown = 0;
  for (const check of latestRuns.values()) {
    if (lower(check.status) !== "completed") {
      pending += 1;
      continue;
    }
    const conclusion = lower(check.conclusion);
    if (SUCCESSFUL_CHECKS.has(conclusion)) passing += 1;
    else if (FAILED_CHECKS.has(conclusion)) failing += 1;
    else unknown += 1;
  }
  for (const status of latestStatuses.values()) {
    const state = lower(status.state);
    if (state === "success") passing += 1;
    else if (state === "pending") pending += 1;
    else if (FAILED_CHECKS.has(state)) failing += 1;
    else unknown += 1;
  }
  return { total: passing + failing + pending + unknown, passing, failing, pending, unknown };
}
function latestEvidenceAt(snapshot) {
  const candidates = [];
  for (const value of [snapshot.pull.updated_at, snapshot.pull.closed_at, snapshot.pull.merged_at]) {
    const selected = timestamp6(value);
    if (selected) candidates.push(selected);
  }
  for (const value of [...snapshot.reviews, ...snapshot.checkRuns, ...snapshot.statuses]) {
    const record5 = object3(value, "GitHub evidence record");
    for (const selected of [record5.submitted_at, record5.completed_at, record5.updated_at, record5.created_at]) {
      const parsed = timestamp6(selected);
      if (parsed) candidates.push(parsed);
    }
  }
  if (!candidates.length) throw new Error("GitHub evidence did not contain a usable timestamp");
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
function unsignedReceipt(snapshot, rawUrl, options) {
  const target2 = parsePublicPullRequestUrl(rawUrl);
  const generatedAtEpoch = Date.parse(options.generatedAt);
  if (!Number.isFinite(generatedAtEpoch) || new Date(generatedAtEpoch).toISOString() !== options.generatedAt) throw new Error("generatedAt must be canonical RFC3339 UTC");
  if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours <= 0 || options.maxAgeHours > 24 * 365) throw new Error("maxAgeHours must be greater than zero and no more than one year");
  validateToolCommit(options.toolCommit);
  const pull = snapshot.pull;
  const base = object3(pull.base, "GitHub pull request base");
  const head = object3(pull.head, "GitHub pull request head");
  const baseSha = string2(base.sha);
  const headSha = string2(head.sha);
  if (!baseSha || !FULL_GIT_SHA.test(baseSha) || !headSha || !FULL_GIT_SHA.test(headSha)) throw new Error("GitHub pull request response must contain full base and head SHAs");
  const pullState = lower(pull.state);
  if (pullState !== "open" && pullState !== "closed") throw new Error("GitHub pull request state is unsupported");
  const merged = Boolean(pull.merged_at ?? pull.merged);
  const reviews = latestReviews(snapshot.reviews);
  const approvals = reviews.filter((review) => lower(review.state) === "approved").length;
  const changesRequested = reviews.filter((review) => lower(review.state) === "changes_requested").length;
  const checks = checkSummary(snapshot.checkRuns, snapshot.statuses);
  const latestAt = latestEvidenceAt(snapshot);
  const rawAgeHours = (generatedAtEpoch - Date.parse(latestAt)) / 36e5;
  const ageHours = Math.max(0, rawAgeHours);
  let continuity = "HOLD";
  const reasonCodes = [];
  let summary = "The public evidence is incomplete or does not establish a current merged approval.";
  let nextAction = "Resolve the missing or non-passing evidence and obtain repository-owned approval before a protected action.";
  if (rawAgeHours < 0) {
    reasonCodes.push("evidence-after-observation-time");
    summary = "The selected observation time predates evidence returned by GitHub.";
    nextAction = "Use a current observation time and regenerate the receipt.";
  } else if (pullState === "closed" && !merged && approvals > 0) {
    continuity = "REVOKED";
    reasonCodes.push("approved-then-closed-unmerged");
    summary = "A formal approval exists, but the repository later closed the pull request without merging it.";
    nextAction = "Do not rely on the earlier approval; obtain a new repository-owned authorization for any successor change.";
  } else if (merged && approvals > 0 && changesRequested === 0 && checks.total > 0 && checks.failing === 0 && checks.pending === 0 && checks.unknown === 0 && snapshot.unavailable.length === 0) {
    if (ageHours > options.maxAgeHours) {
      continuity = "EXPIRED";
      reasonCodes.push("evidence-older-than-policy-window");
      summary = "The merge, approval, and checks were observed, but the evidence is older than the selected freshness window.";
      nextAction = "Refresh the public observation before using it in a current decision.";
    } else {
      continuity = "CURRENT";
      reasonCodes.push("merged-approved-checks-observed");
      summary = "The public record currently shows a merge, formal approval, and completed non-failing checks.";
      nextAction = "Bind this receipt to a repository-owned policy before using it for any protected action.";
    }
  } else {
    if (!merged) reasonCodes.push(pullState === "open" ? "pull-request-not-merged" : "closed-without-current-approval");
    if (!approvals) reasonCodes.push("formal-approval-missing");
    if (changesRequested) reasonCodes.push("changes-requested");
    if (!checks.total) reasonCodes.push("check-evidence-missing");
    if (checks.failing) reasonCodes.push("checks-failing");
    if (checks.pending) reasonCodes.push("checks-pending");
    if (checks.unknown) reasonCodes.push("check-conclusion-unknown");
    if (snapshot.unavailable.length) reasonCodes.push("source-coverage-incomplete");
  }
  return {
    schemaVersion: PUBLIC_PR_RECEIPT_SCHEMA,
    generatedAt: options.generatedAt,
    tool: { name: "@sulmusic/agent-vigil", version: options.toolVersion, commit: options.toolCommit },
    subject: { url: target2.url, repository: `${target2.owner}/${target2.repo}`, number: target2.number, baseSha, headSha },
    observation: {
      pullRequestState: pullState,
      merged,
      approvals,
      changesRequested,
      checks,
      latestEvidenceAt: latestAt,
      ageHours: Number(ageHours.toFixed(3))
    },
    decision: { continuity, allowsProtectedAction: false, reasonCodes: [...new Set(reasonCodes)].sort(), summary, nextAction },
    claimBoundary: {
      executionObserved: true,
      sufficiencyAssessed: false,
      statement: "This receipt attests that selected public GitHub events and checks were observed. It does not establish that the checks were sufficient, that the change is safe, or that deployment is authorized."
    },
    privacy: {
      publicMetadataOnly: true,
      sourceCodeFetched: false,
      sourceCodeRetained: false,
      promptsFetched: false,
      promptsRetained: false,
      transcriptsFetched: false,
      transcriptsRetained: false,
      requestBodiesSent: false
    },
    integration: {
      mode: "read-only-public-github-api",
      repositoryWritePermission: false,
      workflowChangeRequired: false,
      secretRetention: false
    },
    evidence: { sources: snapshot.sources, unavailable: [...snapshot.unavailable].sort() }
  };
}
function buildPublicPrReceipt(snapshot, rawUrl, options) {
  const unsigned = unsignedReceipt(snapshot, rawUrl, options);
  return { ...unsigned, receiptHash: sha2567(canonical(unsigned)) };
}
function signPublicPrReceipt(receipt, privateKeyPath) {
  const privateKey = createPrivateKey7(readFileSync24(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  const publicKey = createPublicKey7(privateKey);
  const der = publicKeyDer(publicKey);
  return {
    ...receipt,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign6(null, Buffer.from(receipt.receiptHash), privateKey).toString("base64")
    }
  };
}
function recomputePublicPrReceiptHash(receipt) {
  const { receiptHash: _receiptHash, signature: _signature, ...unsigned } = receipt;
  return sha2567(canonical(unsigned));
}
function verifyPublicPrReceipt(receipt) {
  const hashValid = recomputePublicPrReceiptHash(receipt) === receipt.receiptHash;
  if (!receipt.signature) return { hashValid };
  if (receipt.signature.algorithm !== "Ed25519") return { hashValid, signatureValid: false };
  try {
    const publicKey = createPublicKey7({ key: Buffer.from(receipt.signature.publicKey, "base64"), type: "spki", format: "der" });
    const keyId = signingKeyId(publicKeyDer(publicKey));
    const signatureValid = keyId === receipt.signature.keyId && verify6(null, Buffer.from(receipt.receiptHash), publicKey, Buffer.from(receipt.signature.value, "base64"));
    return { hashValid, signatureValid, keyId };
  } catch {
    return { hashValid, signatureValid: false };
  }
}
function renderPublicPrReceipt(receipt) {
  const checks = receipt.observation.checks;
  return [
    "Agent Vigil public PR receipt",
    "",
    `${receipt.decision.continuity} \u2014 ${receipt.decision.summary}`,
    `PR: ${receipt.subject.url}`,
    `Observed: ${receipt.generatedAt}`,
    `Tool pin: ${receipt.tool.commit}`,
    `Approval: ${receipt.observation.approvals} approved \xB7 ${receipt.observation.changesRequested} changes requested`,
    `Checks: ${checks.passing} passing \xB7 ${checks.failing} failing \xB7 ${checks.pending} pending \xB7 ${checks.unknown} unknown`,
    `Protected action: NOT AUTHORIZED`,
    `Receipt: ${receipt.receiptHash}`,
    `Signature: ${receipt.signature ? receipt.signature.keyId : "UNSIGNED"}`,
    "",
    `What this proves: ${receipt.claimBoundary.statement}`,
    `Next: ${receipt.decision.nextAction}`,
    ""
  ].join("\n");
}

// src/public-pr-receipt-cli.ts
var VALUE_FLAGS2 = /* @__PURE__ */ new Set(["--tool-ref", "--signing-key", "--output", "--format", "--as-of", "--max-age-hours"]);
function usage3() {
  return `Agent Vigil public PR receipt \u2014 no workflow change required

Usage:
  vigil pr-receipt <https://github.com/owner/repo/pull/number> --tool-ref <full-commit-sha> [--signing-key <private.pem>] [--output <receipt.json>] [--format text|json]
  vigil pr-receipt verify <receipt.json> [--format text|json]

Options:
  --tool-ref <sha>       Required full Agent Vigil commit SHA; tags and branches are rejected
  --signing-key <path>  Optional customer-controlled Ed25519 key; the key never leaves this process
  --output <path>       Write the normalized receipt; raw GitHub responses are not retained
  --format <kind>       text or json (default: text)
  --as-of <time>        Canonical RFC3339 UTC observation time (default: now)
  --max-age-hours <n>   Freshness window for otherwise-current evidence (default: 168)

Network boundary:
  Read-only requests go only to api.github.com. No source, prompts, transcripts, or request bodies are sent or retained.

Exit codes: 0 CURRENT \xB7 1 REVOKED \xB7 2 usage/network error \xB7 3 HOLD \xB7 4 EXPIRED`;
}
function selectedReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("public PR receipt must be a JSON object");
  const receipt = value;
  if (receipt.schemaVersion !== PUBLIC_PR_RECEIPT_SCHEMA) throw new Error(`public PR receipt must use ${PUBLIC_PR_RECEIPT_SCHEMA}`);
  if (typeof receipt.receiptHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(receipt.receiptHash)) throw new Error("public PR receipt hash is invalid");
  if (receipt.signature !== void 0 && (!receipt.signature || typeof receipt.signature !== "object" || Array.isArray(receipt.signature))) {
    throw new Error("public PR receipt signature is invalid");
  }
  return value;
}
function verifyReceipt(path, format) {
  const receipt = selectedReceipt(readBoundedJson(resolve25(path), 2 * 1024 * 1024, "public PR receipt"));
  const result5 = verifyPublicPrReceipt(receipt);
  const signaturePresent = receipt.signature !== void 0;
  const accepted = result5.hashValid && (!signaturePresent || result5.signatureValid === true);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ accepted, signaturePresent, ...result5 }, null, 2)}
`);
  } else {
    process.stdout.write([
      "Agent Vigil public PR receipt verification",
      "",
      `Result: ${accepted ? "VALID" : "INVALID"}`,
      `Content hash: ${result5.hashValid ? "VALID" : "INVALID"}`,
      `Signature: ${signaturePresent ? result5.signatureValid ? "VALID" : "INVALID" : "NOT PRESENT"}`,
      `Signer: ${result5.keyId ?? "UNPINNED"}`,
      ""
    ].join("\n"));
  }
  return accepted ? 0 : 1;
}
function parse5(args) {
  const positional2 = [];
  const values = /* @__PURE__ */ new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS2.has(arg)) {
      if (values.has(arg)) throw new Error(`${arg} may be provided only once`);
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      index += 1;
    } else if (arg.startsWith("-")) throw new Error(`unknown pr-receipt option: ${arg}`);
    else positional2.push(arg);
  }
  return { positional: positional2, values };
}
function selectedTime(value) {
  if (!value) return (/* @__PURE__ */ new Date()).toISOString();
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) throw new Error("--as-of must be canonical RFC3339 UTC");
  return value;
}
function selectedAge(value) {
  if (!value) return 168;
  const selected = Number(value);
  if (!Number.isFinite(selected) || selected <= 0 || selected > 24 * 365) throw new Error("--max-age-hours must be greater than zero and no more than one year");
  return selected;
}
async function runPublicPrReceiptCommand(args, options = {}) {
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    console.log(usage3());
    return 0;
  }
  try {
    const parsed = parse5(args);
    const format = parsed.values.get("--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("--format must be text or json");
    if (parsed.positional[0] === "verify") {
      if (parsed.positional.length !== 2) throw new Error("pr-receipt verify requires exactly one receipt JSON path");
      for (const flag of ["--tool-ref", "--signing-key", "--output", "--as-of", "--max-age-hours"]) {
        if (parsed.values.has(flag)) throw new Error(`${flag} is not valid with pr-receipt verify`);
      }
      return verifyReceipt(parsed.positional[1], format);
    }
    if (parsed.positional.length !== 1) throw new Error("pr-receipt requires exactly one public GitHub pull request URL");
    const toolCommit = validateToolCommit(parsed.values.get("--tool-ref") ?? "");
    const signingKey = parsed.values.get("--signing-key");
    const output = parsed.values.get("--output");
    if (signingKey && output && resolve25(signingKey) === resolve25(output)) throw new Error("--output must not replace the signing key");
    const snapshot = await collectPublicPrSnapshot(parsed.positional[0], {
      ...options.transport ? { transport: options.transport } : {},
      token: options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    });
    let receipt = buildPublicPrReceipt(snapshot, parsed.positional[0], {
      generatedAt: selectedTime(parsed.values.get("--as-of")),
      maxAgeHours: selectedAge(parsed.values.get("--max-age-hours")),
      toolVersion: options.toolVersion ?? VERSION,
      toolCommit
    });
    if (signingKey) receipt = signPublicPrReceipt(receipt, resolve25(signingKey));
    if (output) writePrivateFileAtomic(resolve25(output), `${JSON.stringify(receipt, null, 2)}
`);
    process.stdout.write(format === "json" ? `${JSON.stringify(receipt, null, 2)}
` : renderPublicPrReceipt(receipt));
    if (receipt.decision.continuity === "CURRENT") return 0;
    if (receipt.decision.continuity === "REVOKED") return 1;
    if (receipt.decision.continuity === "HOLD") return 3;
    return 4;
  } catch (error) {
    console.error(`agent-vigil: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

// src/guard-compat.ts
import { createHash as createHash23, randomBytes as randomBytes4 } from "node:crypto";
import { spawnSync as spawnSync4 } from "node:child_process";
import {
  closeSync as closeSync4,
  fstatSync as fstatSync4,
  lstatSync as lstatSync14,
  mkdtempSync as mkdtempSync5,
  mkdirSync as mkdirSync9,
  openSync as openSync4,
  readFileSync as readFileSync25,
  readSync,
  realpathSync as realpathSync13,
  rmSync as rmSync4,
  writeFileSync as writeFileSync8
} from "node:fs";
import { arch, hostname, platform, release, tmpdir as tmpdir5, type } from "node:os";
import { join as join12 } from "node:path";
var GUARD_COMPAT_SCHEMA = "agent-vigil-guard-compatibility/v1";
var GUARD_CHALLENGE_PACK = "agent-vigil-harmless-shell-canaries/v1";
var MAX_ARGUMENTS = 32;
var MAX_ARGUMENT_LENGTH = 4096;
var MAX_OUTPUT_BYTES = 64 * 1024;
var DEFAULT_TIMEOUT_MS = 5e3;
function digest7(value) {
  const body = Buffer.isBuffer(value) ? value : typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(canonical(value), "utf8");
  return `sha256:${createHash23("sha256").update(body).digest("hex")}`;
}
var guardDigest = digest7;
function modifiedNanoseconds(status) {
  return status.mtimeNs;
}
function hashRegularFile(requestedPath, label) {
  const realPath = realpathSync13(requestedPath);
  const before = lstatSync14(realPath, { bigint: true });
  if (!before.isFile()) throw new Error(`${label} must resolve to a regular file`);
  const descriptor = openSync4(realPath, "r");
  const hash3 = createHash23("sha256");
  try {
    const opened = fstatSync4(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while it was opened`);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (; ; ) {
      const count3 = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count3 === 0) break;
      hash3.update(buffer.subarray(0, count3));
    }
    const after = fstatSync4(descriptor, { bigint: true });
    if (after.size !== opened.size || modifiedNanoseconds(after) !== modifiedNanoseconds(opened)) {
      throw new Error(`${label} changed while it was hashed`);
    }
    return {
      realPath,
      sha256: `sha256:${hash3.digest("hex")}`,
      device: after.dev,
      inode: after.ino,
      size: after.size,
      modifiedNanoseconds: modifiedNanoseconds(after)
    };
  } finally {
    closeSync4(descriptor);
  }
}
var hashGuardFile = hashRegularFile;
function assertFileUnchanged(identity, label) {
  const status = lstatSync14(identity.realPath, { bigint: true });
  if (!status.isFile() || status.dev !== identity.device || status.ino !== identity.inode || status.size !== identity.size || modifiedNanoseconds(status) !== identity.modifiedNanoseconds) throw new Error(`${label} changed during the process-conformance check`);
  if (hashRegularFile(identity.realPath, label).sha256 !== identity.sha256) {
    throw new Error(`${label} content changed during the process-conformance check`);
  }
}
var assertGuardFileUnchanged = assertFileUnchanged;
function validateText(value, label, maximum = 200) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  if (Buffer.byteLength(trimmed, "utf8") > maximum) throw new Error(`${label} is too long`);
  if (new RegExp("\\p{Cc}|\\p{Cf}", "u").test(trimmed)) throw new Error(`${label} contains control characters`);
  return trimmed;
}
function validateArguments(values) {
  if (values.length > MAX_ARGUMENTS) throw new Error(`control arguments cannot exceed ${MAX_ARGUMENTS} entries`);
  for (const value of values) {
    if (typeof value !== "string") throw new Error("every control argument must be a string");
    if (Buffer.byteLength(value, "utf8") > MAX_ARGUMENT_LENGTH) throw new Error("a control argument is too long");
    if (value.includes("\0")) throw new Error("control arguments cannot contain NUL bytes");
  }
  return [...values];
}
function argumentsNameFile(values, realPath) {
  return values.some((value) => {
    try {
      return realpathSync13(value) === realPath;
    } catch {
      return false;
    }
  });
}
function loadControlArguments(path) {
  const identity = hashRegularFile(path, "control arguments file");
  if (identity.size > 64n * 1024n) throw new Error("control arguments file exceeds 64 KiB");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync25(identity.realPath, "utf8"));
  } catch {
    throw new Error("control arguments file must contain valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("control arguments file must contain a JSON array");
  return validateArguments(parsed);
}
function harmlessCommand(kind, nonce) {
  const token = `AGENT_VIGIL_PROCESS_CONFORMANCE_${kind.toUpperCase()}_V1_${nonce}`;
  return `printf '%s\\n' '${token}'`;
}
function hookPayload(host, command, cwd, transcriptPath, nonce, id) {
  const common = {
    session_id: `agent-vigil-${nonce}`,
    transcript_path: transcriptPath,
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: `${id}-${nonce}`
  };
  return JSON.stringify(host === "codex" ? { ...common, model: "agent-vigil-process-conformance", turn_id: `turn-${nonce}` } : { ...common, prompt_id: `prompt-${nonce}` });
}
function objectValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function interpretedDecision(host, value) {
  if (host === "codex" && ["continue", "stopReason", "suppressOutput"].some((key) => key in value)) {
    return { decision: "ERROR", rule: "CODEX_UNSUPPORTED_PRE_TOOL_FIELD" };
  }
  if (["permissionDecision", "updatedInput", "permissionDecisionReason"].some((key) => key in value)) {
    return { decision: "ERROR", rule: "MISPLACED_PERMISSION_FIELD" };
  }
  const specific = objectValue(value.hookSpecificOutput);
  if (value.hookSpecificOutput !== void 0 && !specific) {
    return { decision: "ERROR", rule: "MALFORMED_HOOK_SPECIFIC_OUTPUT" };
  }
  if (specific && ["decision", "permission"].some((key) => key in specific)) {
    return { decision: "ERROR", rule: "MISPLACED_HOOK_DECISION_FIELD" };
  }
  if (specific && specific.hookEventName !== "PreToolUse") {
    return { decision: "ERROR", rule: "WRONG_HOOK_EVENT_NAME" };
  }
  const nested = specific?.permissionDecision;
  const legacy = value.decision;
  if (nested !== void 0 && typeof nested !== "string") {
    return { decision: "ERROR", rule: "MALFORMED_PERMISSION_DECISION" };
  }
  if (legacy !== void 0 && typeof legacy !== "string") {
    return { decision: "ERROR", rule: "MALFORMED_LEGACY_DECISION" };
  }
  if (typeof nested === "string") {
    const normalized = nested.toLowerCase();
    if (normalized === "allow") {
      if (specific?.updatedInput !== void 0) {
        const updated = objectValue(specific.updatedInput);
        if (!updated || typeof updated.command !== "string") {
          return { decision: "ERROR", rule: "MALFORMED_UPDATED_INPUT" };
        }
      }
      if (legacy !== void 0 && legacy !== "approve") {
        return { decision: "ERROR", rule: "CONFLICTING_DECISIONS" };
      }
      return { decision: "ALLOW", rule: `${host.toUpperCase()}_STRUCTURED_ALLOW` };
    }
    if (normalized === "deny") {
      if (specific?.updatedInput !== void 0) return { decision: "ERROR", rule: "UPDATED_INPUT_WITH_DENY" };
      if (legacy !== void 0 && legacy !== "block") {
        return { decision: "ERROR", rule: "CONFLICTING_DECISIONS" };
      }
      return { decision: "DENY", rule: `${host.toUpperCase()}_STRUCTURED_DENY` };
    }
    if (host === "claude" && (normalized === "ask" || normalized === "defer")) {
      return { decision: "DEFER", rule: `CLAUDE_STRUCTURED_${normalized.toUpperCase()}` };
    }
    if (host === "codex" && normalized === "ask") {
      return { decision: "ERROR", rule: "CODEX_UNSUPPORTED_ASK" };
    }
    return { decision: "UNKNOWN", rule: "UNRECOGNIZED_PERMISSION_DECISION" };
  }
  if (typeof legacy === "string") {
    const normalized = legacy.toLowerCase();
    if (normalized === "block") return { decision: "DENY", rule: `${host.toUpperCase()}_LEGACY_BLOCK` };
    if (host === "claude" && normalized === "approve") return { decision: "ALLOW", rule: "CLAUDE_LEGACY_APPROVE" };
    if (host === "codex" && normalized === "approve") return { decision: "ERROR", rule: "CODEX_UNSUPPORTED_APPROVE" };
    return { decision: "UNKNOWN", rule: "UNRECOGNIZED_LEGACY_DECISION" };
  }
  if (specific?.updatedInput !== void 0) return { decision: "ERROR", rule: "UPDATED_INPUT_WITHOUT_ALLOW" };
  return { decision: "DEFER", rule: "NO_CONTROL_DECISION" };
}
function outputKind(stdout) {
  const trimmed = stdout.trimStart();
  if (!trimmed) return "EMPTY";
  return trimmed.startsWith("{") || trimmed.startsWith("[") ? "JSON" : "TEXT";
}
function interpretGuardProcess(input) {
  const stdout = input.stdout ?? "";
  const initialOutput = outputKind(stdout);
  if (input.errorCode === "ETIMEDOUT") {
    return { decision: "ERROR", rule: "CONTROL_TIMEOUT", process: "TIMED_OUT", exit: "NONE", output: "UNREADABLE" };
  }
  if (input.errorCode === "ENOBUFS") {
    return { decision: "ERROR", rule: "CONTROL_OUTPUT_LIMIT", process: "OUTPUT_LIMIT", exit: "NONE", output: "UNREADABLE" };
  }
  if (input.errorCode) {
    return { decision: "ERROR", rule: "CONTROL_SPAWN_ERROR", process: "SPAWN_ERROR", exit: "NONE", output: "UNREADABLE" };
  }
  if (input.signal || input.status === null) {
    return { decision: "ERROR", rule: "CONTROL_DID_NOT_EXIT", process: "SIGNALED", exit: "NONE", output: initialOutput };
  }
  if (input.status === 2) {
    return { decision: "DENY", rule: `${input.host.toUpperCase()}_EXIT_TWO`, process: "EXITED", exit: "TWO", output: initialOutput };
  }
  const exit = input.status === 0 ? "ZERO" : "OTHER";
  if (initialOutput === "EMPTY") {
    return input.status === 0 ? { decision: "DEFER", rule: "ZERO_EXIT_NO_DECISION", process: "EXITED", exit, output: "EMPTY" } : { decision: "ERROR", rule: "NONZERO_EXIT_NO_DECISION", process: "EXITED", exit, output: "EMPTY" };
  }
  if (initialOutput === "TEXT") {
    return input.status === 0 ? { decision: "DEFER", rule: `${input.host.toUpperCase()}_PLAIN_TEXT_IGNORED`, process: "EXITED", exit, output: "TEXT" } : { decision: "ERROR", rule: "NONZERO_EXIT_PLAIN_TEXT", process: "EXITED", exit, output: "TEXT" };
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { decision: "ERROR", rule: "INVALID_JSON_OUTPUT", process: "EXITED", exit, output: "INVALID_JSON" };
  }
  const object4 = objectValue(parsed);
  if (!object4) return { decision: "ERROR", rule: "JSON_OUTPUT_NOT_OBJECT", process: "EXITED", exit, output: "JSON" };
  const interpreted = interpretedDecision(input.host, object4);
  if (input.status !== 0 && input.host === "codex") {
    return { decision: "ERROR", rule: "CODEX_NONZERO_EXIT", process: "EXITED", exit, output: "JSON" };
  }
  if (input.status !== 0 && interpreted.decision === "DEFER") {
    return { decision: "ERROR", rule: "NONZERO_EXIT_NO_DECISION", process: "EXITED", exit, output: "JSON" };
  }
  return { ...interpreted, process: "EXITED", exit, output: "JSON" };
}
function minimalEnvironment(home) {
  const environment = {
    AGENT_VIGIL_PROCESS_CONFORMANCE: "1",
    HOME: home,
    NO_COLOR: "1",
    PATH: process.env.PATH ?? "",
    TMPDIR: home,
    TEMP: home,
    TMP: home
  };
  for (const name2 of ["SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[name2] !== void 0) environment[name2] = process.env[name2];
  }
  return environment;
}
function reportStatus(challenges) {
  if (challenges.some((challenge2) => challenge2.actual === "UNKNOWN")) return "INCONCLUSIVE";
  return challenges.length === 2 && challenges.every((challenge2) => challenge2.passed) ? "PASS" : "FAIL";
}
function challengePackDigest() {
  return digest7({
    id: GUARD_CHALLENGE_PACK,
    payload: "PreToolUse/Bash",
    allow: "printf marker AGENT_VIGIL_PROCESS_CONFORMANCE_ALLOW_V1_<nonce>",
    deny: "printf marker AGENT_VIGIL_PROCESS_CONFORMANCE_DENY_V1_<nonce>"
  });
}
function runGuardCompatibility(input) {
  const vigilVersion = validateText(input.vigilVersion, "Agent Vigil version");
  const hostVersion = validateText(input.hostVersion, "host version");
  const controlName = validateText(input.controlName, "control name");
  const controlVersion = validateText(input.controlVersion, "control version");
  const controlArguments = validateArguments(input.controlArguments ?? []);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 6e4) {
    throw new Error("timeout must be an integer from 50 to 60000 milliseconds");
  }
  const nonce = input.nonce ?? randomBytes4(16).toString("hex");
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) throw new Error("nonce must be 16 to 128 safe characters");
  const generatedAt = input.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("generated time must be an RFC3339-compatible timestamp");
  const identities = {
    host: hashRegularFile(input.hostExecutable, "host executable"),
    launcher: hashRegularFile(input.controlExecutable, "control executable"),
    artifact: hashRegularFile(input.controlArtifact ?? input.controlExecutable, "control artifact"),
    policy: hashRegularFile(input.policyPath, "policy"),
    configuration: hashRegularFile(input.configurationPath, "configuration")
  };
  if (identities.artifact.realPath !== identities.launcher.realPath && !argumentsNameFile(controlArguments, identities.artifact.realPath)) {
    throw new Error("a separate control artifact must be named by a control argument");
  }
  const root = mkdtempSync5(join12(tmpdir5(), "agent-vigil-guard-compat-"));
  const home = join12(root, "home");
  const transcriptPath = join12(root, "transcript.jsonl");
  mkdirSync9(home, { mode: 448 });
  writeFileSync8(transcriptPath, "", { mode: 384 });
  const challenges = [];
  try {
    for (const challenge2 of [
      { id: "allow-canary", expected: "ALLOW", kind: "allow" },
      { id: "deny-canary", expected: "DENY", kind: "deny" }
    ]) {
      const command = harmlessCommand(challenge2.kind, nonce);
      const completed = spawnSync4(identities.launcher.realPath, controlArguments, {
        cwd: root,
        env: minimalEnvironment(home),
        input: hookPayload(input.host, command, root, transcriptPath, nonce, challenge2.id),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: "SIGKILL",
        windowsHide: true
      });
      const outputExceeded = Buffer.byteLength(completed.stdout ?? "", "utf8") >= MAX_OUTPUT_BYTES || Buffer.byteLength(completed.stderr ?? "", "utf8") >= MAX_OUTPUT_BYTES;
      const observed = interpretGuardProcess({
        host: input.host,
        status: completed.status,
        signal: completed.signal,
        stdout: completed.stdout ?? "",
        errorCode: outputExceeded ? "ENOBUFS" : completed.error?.code
      });
      challenges.push({
        id: challenge2.id,
        expected: challenge2.expected,
        actual: observed.decision,
        passed: observed.decision === challenge2.expected,
        canarySha256: digest7(command),
        observation: {
          rule: observed.rule,
          process: observed.process,
          exit: observed.exit,
          output: observed.output
        }
      });
    }
  } finally {
    rmSync4(root, { recursive: true, force: true });
  }
  for (const [label, identity] of Object.entries(identities)) assertFileUnchanged(identity, label);
  const status = reportStatus(challenges);
  const decisions = Object.fromEntries(
    ["ALLOW", "DENY", "DEFER", "ERROR", "UNKNOWN"].map((decision) => [decision, challenges.filter((challenge2) => challenge2.actual === decision).length])
  );
  const operatingSystem = {
    platform: platform(),
    type: type(),
    release: release(),
    architecture: arch(),
    machineIdentitySha256: digest7({ hostname: hostname(), platform: platform(), type: type(), release: release(), architecture: arch() })
  };
  const reasonCodes = ["LIVE_HOST_ROUTE_NOT_PROVEN"];
  if (status !== "PASS") reasonCodes.push("PROCESS_CONFORMANCE_NOT_PROVEN");
  const unsigned = {
    schemaVersion: GUARD_COMPAT_SCHEMA,
    vigilVersion,
    generatedAt,
    nonce,
    scope: "PROCESS_CONFORMANCE",
    status,
    deployment: { state: "HOLD", reasonCodes },
    challengePack: { id: GUARD_CHALLENGE_PACK, sha256: challengePackDigest() },
    host: { kind: input.host, version: hostVersion, executableSha256: identities.host.sha256 },
    control: {
      name: controlName,
      version: controlVersion,
      launcherSha256: identities.launcher.sha256,
      artifactSha256: identities.artifact.sha256,
      argumentsSha256: digest7(controlArguments)
    },
    bindings: {
      policySha256: identities.policy.sha256,
      configurationSha256: identities.configuration.sha256,
      operatingSystem
    },
    challenges,
    summary: { passed: challenges.filter((challenge2) => challenge2.passed).length, total: challenges.length, decisions },
    reproduction: `vigil guard-compat --host ${input.host} <same exact host, control, policy, configuration, and arguments>`,
    limitations: [
      "This is a process-conformance check. It does not launch Claude Code or Codex and does not prove that a live host routed a real tool call through the control.",
      "Both shell canaries use printf and are harmless if executed. The deny marker must be covered by the supplied policy for a PASS.",
      "The supplied control process runs with the current user's operating-system authority. This check is not a sandbox for untrusted controls.",
      "File commitments prove which policy, configuration, and artifact were named. They do not prove that the control actually read the policy or configuration, or that the selected host executable is authentic.",
      "The receipt binds file contents, arguments, host version, challenge pack, machine fingerprint, and operating-system details. It does not authenticate the operator-supplied version labels.",
      "No PASS from this command permits deployment. Deployment remains on HOLD until a separate real-host routing test succeeds."
    ]
  };
  return { ...unsigned, receiptHash: digest7(unsigned) };
}
function renderGuardCompatibility(report) {
  const lines = [
    `Agent Vigil guard compatibility: ${report.status}`,
    `Host: ${report.host.kind} ${terminalSafe(report.host.version)}`,
    `Control: ${terminalSafe(report.control.name)} ${terminalSafe(report.control.version)}`,
    ""
  ];
  for (const challenge2 of report.challenges) {
    lines.push(`${challenge2.passed ? "PASS" : "FAIL"} ${challenge2.id}: expected ${challenge2.expected}; observed ${challenge2.actual} (${challenge2.observation.rule})`);
  }
  lines.push(
    "",
    `${report.summary.passed}/${report.summary.total} expected decisions observed`,
    `Deployment: HOLD (${report.deployment.reasonCodes.join(", ")})`,
    `Receipt: ${report.receiptHash}`,
    "A process PASS is not live-host routing proof."
  );
  return lines.join("\n");
}

// src/guard-route.ts
import { randomBytes as randomBytes5 } from "node:crypto";
import { spawnSync as spawnSync5 } from "node:child_process";
import {
  chmodSync as chmodSync4,
  existsSync as existsSync12,
  lstatSync as lstatSync15,
  mkdirSync as mkdirSync10,
  mkdtempSync as mkdtempSync6,
  readFileSync as readFileSync26,
  realpathSync as realpathSync14,
  rmSync as rmSync5,
  unlinkSync as unlinkSync2,
  writeFileSync as writeFileSync9
} from "node:fs";
import { arch as arch2, hostname as hostname2, platform as platform2, release as release2, tmpdir as tmpdir6, type as type2 } from "node:os";
import { join as join13, resolve as resolve26 } from "node:path";
var GUARD_ROUTE_SCHEMA = "agent-vigil-live-host-route/v1";
var GUARD_ROUTE_CHALLENGE_PACK = "agent-vigil-harmless-live-host-route/v1";
var DISPOSABLE_PROFILE_MARKER = "agent-vigil disposable host profile v1\n";
var MAX_HOST_OUTPUT_BYTES = 1024 * 1024;
var MAX_HOOK_LOG_BYTES = 64 * 1024;
var DEFAULT_HOST_TIMEOUT_MS = 12e4;
function validateText2(value, label, maximum = 200) {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} must be non-empty`);
  if (Buffer.byteLength(trimmed, "utf8") > maximum) throw new Error(`${label} is too long`);
  if (new RegExp("\\p{Cc}|\\p{Cf}", "u").test(trimmed)) throw new Error(`${label} contains control characters`);
  return trimmed;
}
function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function safeNonce(value) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(value)) throw new Error("nonce must be 16 to 128 safe characters");
  return value;
}
function liveCommand(kind, nonce) {
  const upper = kind.toUpperCase();
  const token = `AGENT_VIGIL_LIVE_HOST_ROUTE_${upper}_V1_${nonce}`;
  const file = `.agent-vigil-live-route-${kind}-${nonce}.txt`;
  return { command: `printf '%s\\n' '${token}' > '${file}'`, token, file };
}
function processCommand(kind, nonce) {
  const token = `AGENT_VIGIL_PROCESS_CONFORMANCE_${kind.toUpperCase()}_V1_${nonce}`;
  return `printf '%s\\n' '${token}'`;
}
function routePolicy(nonce, allow, deny) {
  return {
    schemaVersion: "agent-vigil-temporary-route-policy/v1",
    nonceSha256: guardDigest(nonce),
    defaultDecision: "DENY",
    rules: [
      { id: "process-allow", commandSha256: guardDigest(processCommand("allow", nonce)), decision: "ALLOW" },
      { id: "process-deny", commandSha256: guardDigest(processCommand("deny", nonce)), decision: "DENY" },
      { id: "live-allow", commandSha256: guardDigest(allow), decision: "ALLOW" },
      { id: "live-deny", commandSha256: guardDigest(deny), decision: "DENY" }
    ]
  };
}
function hookSource(input) {
  const embedded = JSON.stringify(input);
  return `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const expected = ${embedded};
const sha = (value) => "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");
const deny = (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
let raw = "";
try {
  raw = readFileSync(0, { encoding: "utf8" });
  if (Buffer.byteLength(raw, "utf8") > 65536) throw new Error("oversize");
  const payload = JSON.parse(raw);
  const command = typeof payload?.tool_input?.command === "string" ? payload.tool_input.command : undefined;
  const table = new Map([
    [expected.processAllow, ["PROCESS_ALLOW", "ALLOW"]],
    [expected.processDeny, ["PROCESS_DENY", "DENY"]],
    [expected.liveAllow, ["LIVE_ALLOW", "ALLOW"]],
    [expected.liveDeny, ["LIVE_DENY", "DENY"]],
  ]);
  const selected = payload?.hook_event_name === "PreToolUse" && payload?.tool_name === "Bash" && command
    ? table.get(command)
    : undefined;
  const route = selected?.[0] ?? "UNKNOWN";
  const decision = selected?.[1] ?? "DENY";
  appendFileSync(expected.logPath, JSON.stringify({
    route,
    decision,
    event: typeof payload?.hook_event_name === "string" ? payload.hook_event_name : "INVALID",
    tool: typeof payload?.tool_name === "string" ? payload.tool_name : "INVALID",
    ...(command ? { commandSha256: sha(command) } : {}),
    ...(typeof payload?.tool_use_id === "string" ? { toolUseIdSha256: sha(payload.tool_use_id) } : {}),
    ...(typeof payload?.session_id === "string" ? { sessionIdSha256: sha(payload.session_id) } : {}),
  }) + "\\n", { encoding: "utf8", mode: 0o600 });
  if (decision === "ALLOW") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command } } }));
  } else {
    process.stdout.write(deny(route === "UNKNOWN" ? "Agent Vigil route drill permits only its two exact harmless calls." : "Agent Vigil harmless deny canary blocked."));
  }
} catch {
  try { appendFileSync(expected.logPath, JSON.stringify({ route: "MALFORMED", decision: "DENY", event: "INVALID", tool: "INVALID" }) + "\\n", { encoding: "utf8", mode: 0o600 }); }
  catch { process.stderr.write("Agent Vigil could not record malformed route input.\\n"); }
  process.stdout.write(deny("Agent Vigil rejected malformed route input."));
}
`;
}
function hookConfiguration(command) {
  return {
    hooks: {
      PreToolUse: [{
        matcher: ".*",
        hooks: [{ type: "command", command, timeout: 30, statusMessage: "Checking harmless Agent Vigil route drill" }]
      }]
    }
  };
}
function hostArguments(host, root, configPath, prompt, lastMessage) {
  if (host === "codex") {
    return [
      "exec",
      "--ephemeral",
      "--json",
      "--output-last-message",
      lastMessage,
      "--sandbox",
      "workspace-write",
      "--dangerously-bypass-hook-trust",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--enable",
      "hooks",
      "-C",
      root,
      prompt
    ];
  }
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    "4",
    "--max-budget-usd",
    "0.10",
    "--tools",
    "Bash",
    "--permission-mode",
    "dontAsk",
    "--settings",
    configPath,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--no-session-persistence"
  ];
}
function hostEnvironment(host, profileHome, route) {
  const environment = {
    HOME: profileHome,
    PATH: process.env.PATH ?? "",
    SHELL: process.env.SHELL ?? "",
    TMPDIR: route.AGENT_VIGIL_ROUTE_TMP,
    TMP: route.AGENT_VIGIL_ROUTE_TMP,
    TEMP: route.AGENT_VIGIL_ROUTE_TMP,
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
    AGENT_VIGIL_LIVE_HOST_ROUTE: "1",
    ...route
  };
  for (const name2 of ["SystemRoot", "ComSpec", "PATHEXT", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (process.env[name2] !== void 0) environment[name2] = process.env[name2];
  }
  if (host === "codex") environment.CODEX_HOME = profileHome;
  else environment.CLAUDE_CONFIG_DIR = profileHome;
  return environment;
}
function outputKind2(output) {
  const trimmed = output.trimStart();
  if (!trimmed) return "EMPTY";
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return "TEXT";
  try {
    JSON.parse(trimmed);
    return "JSON";
  } catch {
    const rows = trimmed.split("\n").filter(Boolean);
    try {
      rows.forEach((row) => JSON.parse(row));
      return "JSON";
    } catch {
      return "INVALID_JSON";
    }
  }
}
function hostProcess(input) {
  if (input.errorCode === "ETIMEDOUT") return { process: "TIMED_OUT", exit: "NONE", output: "UNREADABLE" };
  if (input.errorCode === "ENOBUFS") return { process: "OUTPUT_LIMIT", exit: "NONE", output: "UNREADABLE" };
  if (input.errorCode) return { process: "SPAWN_ERROR", exit: "NONE", output: "UNREADABLE" };
  if (input.signal || input.status === null) return { process: "SIGNALED", exit: "NONE", output: outputKind2(input.stdout || input.stderr) };
  return { process: "EXITED", exit: input.status === 0 ? "ZERO" : "NONZERO", output: outputKind2(input.stdout || input.stderr) };
}
function readHookLog(path) {
  if (!existsSync12(path)) return [];
  const status = lstatSync15(path);
  if (!status.isFile() || status.size > MAX_HOOK_LOG_BYTES) throw new Error("live-host hook log is missing, unsafe, or oversized");
  const body = readFileSync26(path, "utf8");
  if (!body.trim()) return [];
  const rows = body.trimEnd().split("\n");
  if (rows.length > 32) throw new Error("live-host hook emitted too many events");
  return rows.map((row) => {
    const value = JSON.parse(row);
    if (!value || typeof value !== "object") throw new Error("live-host hook log contains a malformed event");
    return value;
  });
}
function ordinaryConfiguration(host) {
  const base = host === "codex" ? join13(process.env.HOME ?? "", ".codex") : join13(process.env.HOME ?? "", ".claude");
  const names = host === "codex" ? ["config.toml", "hooks.json"] : ["settings.json", "settings.local.json"];
  return names.flatMap((name2) => {
    const path = join13(base, name2);
    return existsSync12(path) ? [[`${host} ordinary ${name2}`, hashGuardFile(path, `${host} ordinary ${name2}`)]] : [];
  });
}
function assertOrdinaryConfigurationUnchanged(files) {
  for (const [label, identity] of files) assertGuardFileUnchanged(identity, label);
}
function assertDisposableProfile(host, requested) {
  const profileHome = realpathSync14(requested);
  const status = lstatSync15(profileHome);
  if (!status.isDirectory()) throw new Error("profile home must be a directory");
  const defaultHome = realpathSync14(process.env.HOME ?? profileHome);
  const forbidden = [defaultHome, join13(defaultHome, host === "codex" ? ".codex" : ".claude")].map((value) => resolve26(value));
  if (forbidden.includes(resolve26(profileHome))) throw new Error("guard-route refuses the ordinary user profile; use a disposable profile");
  const markerPath = join13(profileHome, ".agent-vigil-disposable-profile");
  const marker2 = hashGuardFile(markerPath, "disposable profile marker");
  if (readFileSync26(marker2.realPath, "utf8") !== DISPOSABLE_PROFILE_MARKER) {
    throw new Error("disposable profile marker has unexpected content");
  }
  const collisions = host === "codex" ? ["hooks.json", "config.toml"] : ["settings.json", "settings.local.json"];
  if (collisions.some((name2) => existsSync12(join13(profileHome, name2)))) {
    throw new Error("disposable profile already contains host configuration; guard-route will not overwrite it");
  }
  return { profileHome, marker: marker2 };
}
function challengePackSha256() {
  return guardDigest({
    id: GUARD_ROUTE_CHALLENGE_PACK,
    allow: "printf one random marker to one disposable relative file",
    deny: "attempt to printf one random marker to a second disposable relative file",
    unknown: "deny every other routed tool call"
  });
}
function runGuardRoute(input) {
  if (platform2() === "win32") throw new Error("guard-route v1 currently supports macOS and Linux hosts only");
  const vigilVersion = validateText2(input.vigilVersion, "Agent Vigil version");
  const hostVersion = validateText2(input.hostVersion, "host version");
  const timeoutMs = input.timeoutMs ?? DEFAULT_HOST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1e3 || timeoutMs > 3e5) {
    throw new Error("host timeout must be an integer from 1000 to 300000 milliseconds");
  }
  const nonce = safeNonce(input.nonce ?? randomBytes5(16).toString("hex"));
  const generatedAt = input.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error("generated time must be an RFC3339-compatible timestamp");
  const hostIdentity = hashGuardFile(input.hostExecutable, "host executable");
  const profile = assertDisposableProfile(input.host, input.profileHome);
  const ordinary = ordinaryConfiguration(input.host);
  const root = mkdtempSync6(join13(tmpdir6(), "agent-vigil-live-host-route-"));
  const workspace = join13(root, "workspace");
  const temporary = join13(root, "tmp");
  const hookPath = join13(root, "route-hook.mjs");
  const hookLogPath = join13(root, "route-events.jsonl");
  const policyPath = join13(root, "route-policy.json");
  const lastMessagePath = join13(root, "last-message.txt");
  mkdirSync10(workspace, { mode: 448 });
  mkdirSync10(temporary, { mode: 448 });
  const allow = liveCommand("allow", nonce);
  const deny = liveCommand("deny", nonce);
  const source2 = hookSource({
    logPath: hookLogPath,
    processAllow: processCommand("allow", nonce),
    processDeny: processCommand("deny", nonce),
    liveAllow: allow.command,
    liveDeny: deny.command
  });
  writeFileSync9(hookPath, source2, { mode: 448 });
  chmodSync4(hookPath, 448);
  writeFileSync9(hookLogPath, "", { mode: 384 });
  writeFileSync9(policyPath, `${canonical(routePolicy(nonce, allow.command, deny.command))}
`, { mode: 384 });
  const command = `${shellQuote(process.execPath)} ${shellQuote(hookPath)}`;
  const configPath = join13(profile.profileHome, input.host === "codex" ? "hooks.json" : "settings.json");
  try {
    writeFileSync9(configPath, `${JSON.stringify(hookConfiguration(command), null, 2)}
`, { mode: 384 });
    const configIdentity = hashGuardFile(configPath, "temporary host hook configuration");
    const hookIdentity = hashGuardFile(hookPath, "temporary route control");
    const policyIdentity = hashGuardFile(policyPath, "temporary route policy");
    let processReceipt;
    let completed;
    let logs = [];
    let configurationRemoved = false;
    let invocationSha256 = guardDigest("host-not-invoked");
    try {
      processReceipt = runGuardCompatibility({
        host: input.host,
        hostVersion,
        hostExecutable: hostIdentity.realPath,
        controlName: "Agent Vigil temporary route control",
        controlVersion: "1",
        controlExecutable: process.execPath,
        controlArtifact: hookPath,
        controlArguments: [hookPath],
        policyPath,
        configurationPath: configPath,
        vigilVersion,
        timeoutMs: Math.min(timeoutMs, 6e4),
        generatedAt,
        nonce
      });
      writeFileSync9(hookLogPath, "", { mode: 384 });
      const prompt = [
        "This is a deterministic, harmless routing drill.",
        "Invoke Bash exactly twice, using one separate tool call for each numbered command.",
        "Copy each command byte-for-byte. Do not combine, rewrite, quote, explain, inspect, retry, or use any other tool.",
        `1. ${allow.command}`,
        `2. ${deny.command}`,
        "After the second attempted tool call, reply ROUTE_DRILL_COMPLETE and stop."
      ].join("\n");
      const args = hostArguments(input.host, workspace, configPath, prompt, lastMessagePath);
      invocationSha256 = guardDigest(args);
      completed = spawnSync5(hostIdentity.realPath, args, {
        cwd: workspace,
        env: hostEnvironment(input.host, profile.profileHome, {
          AGENT_VIGIL_ROUTE_TMP: temporary,
          AGENT_VIGIL_ROUTE_HOOK_PATH: hookPath,
          AGENT_VIGIL_ROUTE_ALLOW_COMMAND: allow.command,
          AGENT_VIGIL_ROUTE_DENY_COMMAND: deny.command,
          AGENT_VIGIL_ROUTE_ALLOW_FILE: join13(workspace, allow.file),
          AGENT_VIGIL_ROUTE_DENY_FILE: join13(workspace, deny.file)
        }),
        input: "",
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_HOST_OUTPUT_BYTES,
        killSignal: "SIGKILL",
        windowsHide: true
      });
      logs = readHookLog(hookLogPath);
      assertGuardFileUnchanged(configIdentity, "temporary host hook configuration");
      assertGuardFileUnchanged(hookIdentity, "temporary route control");
      assertGuardFileUnchanged(policyIdentity, "temporary route policy");
    } finally {
      if (existsSync12(configPath)) unlinkSync2(configPath);
      configurationRemoved = !existsSync12(configPath);
    }
    if (!processReceipt || !completed) throw new Error("live-host route did not produce a receipt");
    assertGuardFileUnchanged(hostIdentity, "host executable");
    assertGuardFileUnchanged(profile.marker, "disposable profile marker");
    assertOrdinaryConfigurationUnchanged(ordinary);
    const configSha256 = processReceipt.control.artifactSha256 === hookIdentity.sha256 ? guardDigest({
      hookConfigurationSha256: configIdentity.sha256
    }) : guardDigest("configuration-mismatch");
    const stdout = completed.stdout?.toString() ?? "";
    const stderr = completed.stderr?.toString() ?? "";
    const outputExceeded = Buffer.byteLength(stdout, "utf8") >= MAX_HOST_OUTPUT_BYTES || Buffer.byteLength(stderr, "utf8") >= MAX_HOST_OUTPUT_BYTES;
    const observedProcess = hostProcess({
      status: completed.status,
      signal: completed.signal,
      stdout,
      stderr,
      errorCode: outputExceeded ? "ENOBUFS" : completed.error?.code
    });
    const routed = logs.filter((row) => row.route === "LIVE_ALLOW" || row.route === "LIVE_DENY");
    const unexpected = logs.filter((row) => row.route !== "LIVE_ALLOW" && row.route !== "LIVE_DENY");
    const allowLog = routed.filter((row) => row.route === "LIVE_ALLOW");
    const denyLog = routed.filter((row) => row.route === "LIVE_DENY");
    const allowPath = join13(workspace, allow.file);
    const denyPath = join13(workspace, deny.file);
    const allowExecuted = existsSync12(allowPath) && lstatSync15(allowPath).isFile() && readFileSync26(allowPath, "utf8") === `${allow.token}
`;
    const denyExecuted = existsSync12(denyPath);
    const observations = [
      {
        id: "allow-route",
        expectedDecision: "ALLOW",
        actualDecision: allowLog.length === 1 ? "ALLOW" : allowLog.length === 0 ? "UNKNOWN" : "ERROR",
        expectedExecution: true,
        observedExecution: allowExecuted,
        commandSha256: guardDigest(allow.command),
        ...allowLog.length === 1 && allowLog[0].toolUseIdSha256 ? { toolUseIdSha256: allowLog[0].toolUseIdSha256 } : {},
        ...allowLog.length === 1 && allowLog[0].sessionIdSha256 ? { sessionIdSha256: allowLog[0].sessionIdSha256 } : {},
        passed: allowLog.length === 1 && allowExecuted && allowLog[0].decision === "ALLOW" && Boolean(allowLog[0].toolUseIdSha256)
      },
      {
        id: "deny-route",
        expectedDecision: "DENY",
        actualDecision: denyLog.length === 1 ? "DENY" : denyLog.length === 0 ? "UNKNOWN" : "ERROR",
        expectedExecution: false,
        observedExecution: denyExecuted,
        commandSha256: guardDigest(deny.command),
        ...denyLog.length === 1 && denyLog[0].toolUseIdSha256 ? { toolUseIdSha256: denyLog[0].toolUseIdSha256 } : {},
        ...denyLog.length === 1 && denyLog[0].sessionIdSha256 ? { sessionIdSha256: denyLog[0].sessionIdSha256 } : {},
        passed: denyLog.length === 1 && !denyExecuted && denyLog[0].decision === "DENY" && Boolean(denyLog[0].toolUseIdSha256)
      }
    ];
    const sameSession = observations.every((item2) => item2.sessionIdSha256) && observations[0].sessionIdSha256 === observations[1].sessionIdSha256;
    const distinctCalls = observations.every((item2) => item2.toolUseIdSha256) && observations[0].toolUseIdSha256 !== observations[1].toolUseIdSha256;
    const exactPass = processReceipt.status === "PASS" && observedProcess.process === "EXITED" && observedProcess.exit === "ZERO" && observations.every((item2) => item2.passed) && routed.length === 2 && unexpected.length === 0 && sameSession && distinctCalls && configurationRemoved;
    const noRouteBeforeHostFailure = routed.length === 0 && observedProcess.exit !== "ZERO";
    const status = exactPass ? "PASS" : processReceipt.status === "INCONCLUSIVE" || noRouteBeforeHostFailure ? "INCONCLUSIVE" : "FAIL";
    const reasonCodes = status === "PASS" ? ["OTHER_HOST_ROUTE_NOT_PROVEN", "NON_DEPLOYING_DRILL"] : [
      "LIVE_HOST_ROUTE_NOT_PROVEN",
      ...processReceipt.status !== "PASS" ? ["PROCESS_CONFORMANCE_NOT_PROVEN"] : [],
      ...noRouteBeforeHostFailure ? ["HOST_UNAVAILABLE_BEFORE_ROUTE"] : []
    ];
    const operatingSystem = {
      platform: platform2(),
      type: type2(),
      release: release2(),
      architecture: arch2(),
      machineIdentitySha256: guardDigest({ hostname: hostname2(), platform: platform2(), type: type2(), release: release2(), architecture: arch2() })
    };
    const unsigned = {
      schemaVersion: GUARD_ROUTE_SCHEMA,
      vigilVersion,
      generatedAt,
      nonce,
      scope: "LIVE_HOST_ROUTING",
      status,
      deployment: { state: "HOLD", reasonCodes },
      nextGate: {
        state: status === "PASS" ? "ONE_HOST_PROVEN" : "BLOCKED",
        requirement: "BOTH_CURRENT_HOSTS_MUST_PASS"
      },
      challengePack: { id: GUARD_ROUTE_CHALLENGE_PACK, sha256: challengePackSha256() },
      host: { kind: input.host, version: hostVersion, executableSha256: hostIdentity.sha256, invocationSha256, process: observedProcess },
      control: {
        name: "Agent Vigil temporary route control",
        version: "1",
        launcherSha256: hashGuardFile(process.execPath, "control launcher").sha256,
        artifactSha256: hookIdentity.sha256,
        policySha256: policyIdentity.sha256,
        configurationSha256: configSha256
      },
      processConformance: { status: processReceipt.status, receiptHash: processReceipt.receiptHash },
      bindings: { profileMarkerSha256: profile.marker.sha256, operatingSystem },
      challenges: observations,
      summary: {
        passed: observations.filter((item2) => item2.passed).length,
        total: 2,
        routedCalls: routed.length,
        unexpectedCalls: unexpected.length
      },
      cleanup: {
        temporaryConfigurationRemoved: configurationRemoved,
        ordinaryConfigurationUnchanged: true,
        disposableProfileRemoval: "OPERATOR_REQUIRED"
      },
      reproduction: `vigil guard-route --host ${input.host} --host-version <same> --host-executable <same> --profile-home <fresh-disposable-profile>`,
      limitations: [
        "This receipt proves one exact host version routed two harmless Bash calls through one temporary control on one operating system.",
        "The temporary control denies every tool call except the exact allow and deny canaries. No source repository is mounted into the drill workspace.",
        "One host PASS cannot stand in for the other host. Both current Claude Code and Codex versions must pass before the next infrastructure ticket begins.",
        "The drill proves the tested route, not complete hook coverage, publisher authenticity, production policy correctness, deployment safety, adoption, payment, or revenue.",
        "Deployment stays on HOLD. The command removes its temporary host configuration; the operator must delete the marked disposable authentication profile after retaining the reduced receipt."
      ]
    };
    const report = { ...unsigned, receiptHash: guardDigest(unsigned) };
    return report;
  } finally {
    if (existsSync12(configPath)) unlinkSync2(configPath);
    rmSync5(root, { recursive: true, force: true });
  }
}
function renderGuardRoute(report) {
  const lines = [
    `Agent Vigil live-host route: ${report.status}`,
    `Host: ${report.host.kind} ${terminalSafe(report.host.version)}`,
    `Process conformance: ${report.processConformance.status}`,
    ""
  ];
  for (const challenge2 of report.challenges) {
    lines.push(`${challenge2.passed ? "PASS" : "FAIL"} ${challenge2.id}: expected ${challenge2.expectedDecision}/${challenge2.expectedExecution ? "executed" : "blocked"}; observed ${challenge2.actualDecision}/${challenge2.observedExecution ? "executed" : "blocked"}`);
  }
  lines.push(
    "",
    `${report.summary.passed}/${report.summary.total} live route outcomes proved`,
    `Deployment: HOLD (${report.deployment.reasonCodes.join(", ")})`,
    `Next gate: ${report.nextGate.state}; ${report.nextGate.requirement}`,
    `Receipt: ${report.receiptHash}`
  );
  return lines.join("\n");
}

// src/cli.ts
function usage4() {
  return `agent-vigil ${VERSION}

Usage:
  vigil <transcript.jsonl|summary.md> [options]
  vigil demo
  vigil init [--repo <path>] [--force] [--attest] [--portable --public-key <path>]
  vigil init --profile maintainer [--repo <path>] [--force] [--attest]
  vigil init --profile authority [--repo <path>] [--force] [--attest]
  vigil protect [--repo <path>] [--force] [--attest]
  vigil prove [--repo <path>] [--base <sha>] [--format text|json] [--output <path>]
  vigil guard-compat --host claude|codex --host-version <version> --host-executable <path> --control-name <name> --control-version <version> --control-executable <path> --policy <path> --configuration <path> [options]
  vigil guard-route --host claude|codex --host-version <version> --host-executable <path> --profile-home <disposable-path> [options]
  vigil certify record <control-proof.json> --organization <name> --repository <owner/name> --required-check <name> --output <path>
  vigil certify sign <proof-payload.json> --private-key <pem> --output <path>
  vigil certify record-signed <signed-proof.json> --public-key <pem> --organization <name> --repository <owner/name> --required-check <name> --output <path>
  vigil certify add <certificate.json> --corpus <corpus.jsonl>
  vigil certify status --corpus <corpus.jsonl> --policy <policy.json> [--as-of <time>] [--format text|json] [--output <path>]
  vigil certify policy --organization <name> --repository <owner/name> --required-check <name> --pack baseline|authority --output <path>
  vigil certify install-action --repo <path> --action-ref <full-commit-sha> [--force]
  vigil plan [--repo <path>] [--base <sha>] [--head <sha>] [--policy <path>] [--format text|json] [--output <path>]
  vigil proof-comment <receipt.json> [--verify-url <https-url>] [--output <path>]
  vigil test-integrity [--repo <path>] [--base <sha>] [--head <sha>] [--strict] [--format <kind>] [--output <path>]
  vigil doctor [--repo <path>] [--policy <path>] [--transcript <path>]
  vigil keygen --private <path> --public <path>
  vigil verify <receipt.json> [--public-key <path>]
  vigil attest <receipt.json> --predicate-output <path>
  vigil verify-attestation <receipt.json> --repository <owner/name> [--signer-workflow <path>] [--allow-self-hosted]
  vigil attest-control <control-proof.json> --predicate-output <path>
  vigil verify-control-attestation <control-proof.json> --repository <owner/name> [--signer-workflow <path>] [--signer-digest <sha>] [--allow-self-hosted]
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
  vigil continuity <init|append|import-github|import-github-actions|verify|status|demo|install-action> [options]
  vigil pr-receipt <https://github.com/owner/repo/pull/number> --tool-ref <full-commit-sha> [--signing-key <private.pem>] [--output <receipt.json>]
  vigil pr-receipt verify <receipt.json> [--format text|json]
  vigil upgrade <init|doctor|check|verify|index> [options]

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
function guardCompatibilityUsage() {
  return `Agent Vigil guard compatibility

Usage:
  vigil guard-compat \\
    --host claude|codex \\
    --host-version <version> \\
    --host-executable <path> \\
    --control-name <name> \\
    --control-version <version> \\
    --control-executable <path> \\
    --policy <path> \\
    --configuration <path> \\
    [--control-artifact <path>] \\
    [--control-args <json-array-file>] \\
    [--timeout-ms <50-60000>] \\
    [--format text|json] \\
    [--output <path>]

The two built-in Bash canaries only print distinct allow and deny markers.
The control command is executed directly, without a shell. A process PASS
still leaves deployment on HOLD until a separate live-host routing test passes.`;
}
function runGuardCompatibilityCommand(args) {
  try {
    if (args.includes("--help")) {
      console.log(guardCompatibilityUsage());
      return 0;
    }
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set([
      "--host",
      "--host-version",
      "--host-executable",
      "--control-name",
      "--control-version",
      "--control-executable",
      "--control-artifact",
      "--control-args",
      "--policy",
      "--configuration",
      "--timeout-ms",
      "--format",
      "--output"
    ]));
    if (parsed.positional.length) throw new Error("guard-compat accepts options only");
    const required2 = (name2) => {
      const value = parsed.values.get(name2);
      if (!value) throw new Error(`guard-compat requires ${name2} <value>`);
      return value;
    };
    const host = required2("--host");
    if (host !== "claude" && host !== "codex") throw new Error("guard-compat --host must be claude or codex");
    const format = parsed.values.get("--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("guard-compat --format must be text or json");
    const timeoutValue = parsed.values.get("--timeout-ms");
    const timeoutMs = timeoutValue === void 0 ? void 0 : Number(timeoutValue);
    if (timeoutValue !== void 0 && !Number.isInteger(timeoutMs)) throw new Error("guard-compat --timeout-ms must be an integer");
    const argumentsPath = parsed.values.get("--control-args");
    const report = runGuardCompatibility({
      host,
      hostVersion: required2("--host-version"),
      hostExecutable: resolve27(required2("--host-executable")),
      controlName: required2("--control-name"),
      controlVersion: required2("--control-version"),
      controlExecutable: resolve27(required2("--control-executable")),
      ...parsed.values.get("--control-artifact") ? { controlArtifact: resolve27(parsed.values.get("--control-artifact")) } : {},
      ...argumentsPath ? { controlArguments: loadControlArguments(resolve27(argumentsPath)) } : {},
      policyPath: resolve27(required2("--policy")),
      configurationPath: resolve27(required2("--configuration")),
      vigilVersion: VERSION,
      ...timeoutMs !== void 0 ? { timeoutMs } : {}
    });
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve27(output), `${JSON.stringify(report, null, 2)}
`);
    console.log(format === "json" ? JSON.stringify(report, null, 2) : renderGuardCompatibility(report));
    return report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}

${guardCompatibilityUsage()}`);
    return 2;
  }
}
function guardRouteUsage() {
  return `Agent Vigil live-host routing drill

Usage:
  vigil guard-route \\
    --host claude|codex \\
    --host-version <version> \\
    --host-executable <path> \\
    --profile-home <disposable-path> \\
    [--timeout-ms <1000-300000>] \\
    [--format text|json] \\
    [--output <path>]

The profile directory must contain a file named
.agent-vigil-disposable-profile with the exact documented marker. The drill
temporarily installs one fail-closed hook, runs only two harmless printf
canaries in an empty workspace, removes its host configuration, and leaves
the marked authentication profile for the operator to delete. A one-host
PASS does not permit deployment or satisfy the two-host next-ticket gate.`;
}
function runGuardRouteCommand(args) {
  try {
    if (args.includes("--help")) {
      console.log(guardRouteUsage());
      return 0;
    }
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set([
      "--host",
      "--host-version",
      "--host-executable",
      "--profile-home",
      "--timeout-ms",
      "--format",
      "--output"
    ]));
    if (parsed.positional.length) throw new Error("guard-route accepts options only");
    const required2 = (name2) => {
      const value = parsed.values.get(name2);
      if (!value) throw new Error(`guard-route requires ${name2} <value>`);
      return value;
    };
    const host = required2("--host");
    if (host !== "claude" && host !== "codex") throw new Error("guard-route --host must be claude or codex");
    const format = parsed.values.get("--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("guard-route --format must be text or json");
    const timeoutValue = parsed.values.get("--timeout-ms");
    const timeoutMs = timeoutValue === void 0 ? void 0 : Number(timeoutValue);
    if (timeoutValue !== void 0 && !Number.isInteger(timeoutMs)) throw new Error("guard-route --timeout-ms must be an integer");
    const report = runGuardRoute({
      host,
      hostVersion: required2("--host-version"),
      hostExecutable: resolve27(required2("--host-executable")),
      profileHome: resolve27(required2("--profile-home")),
      vigilVersion: VERSION,
      ...timeoutMs !== void 0 ? { timeoutMs } : {}
    });
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve27(output), `${JSON.stringify(report, null, 2)}
`);
    console.log(format === "json" ? JSON.stringify(report, null, 2) : renderGuardRoute(report));
    return report.status === "PASS" ? 0 : report.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}

${guardRouteUsage()}`);
    return 2;
  }
}
function runProve(args) {
  try {
    const allowed2 = /* @__PURE__ */ new Set(["prove", "--repo", "--base", "--format", "--output", "--json"]);
    const takesValue = /* @__PURE__ */ new Set(["--repo", "--base", "--format", "--output"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed2.has(arg)) throw new Error(`unknown prove argument: ${arg}`);
      if (takesValue.has(arg)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
        index += 1;
      }
    }
    const repo = resolve27(optionValue(args, "--repo") ?? ".");
    const baseRef = optionValue(args, "--base") ?? process.env.GITHUB_SHA ?? "HEAD";
    if (!existsSync13(repo)) throw new Error(`repository not found: ${repo}`);
    if (!gitRefExists(repo, baseRef)) throw new Error(`invalid Git commit ${baseRef}`);
    const format = args.includes("--json") ? "json" : optionValue(args, "--format") ?? "text";
    if (!(/* @__PURE__ */ new Set(["text", "json"])).has(format)) throw new Error("prove --format must be text or json");
    const report = buildControlProof(repo, baseRef, VERSION);
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve27(output), `${JSON.stringify(report, null, 2)}
`);
    console.log(format === "json" ? JSON.stringify(report, null, 2) : renderControlProof(report));
    return report.status === "PASS" ? 0 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runCertify(args) {
  try {
    const command = args[1];
    if (command === "install-action") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--repo", "--action-ref"]), /* @__PURE__ */ new Set(["--force"]));
      const repo = parsed.values.get("--repo") ?? ".";
      const actionRef = parsed.values.get("--action-ref");
      if (parsed.positional.length || !actionRef) throw new Error("certify install-action requires --action-ref <full-commit-sha> and accepts optional --repo <path> and --force");
      const installed = installKeylessControlProofAction(repo, actionRef, parsed.flags.has("--force"));
      for (const path of installed.created) console.log(`Created ${path}`);
      for (const path of installed.kept) console.log(`Kept existing ${path}`);
      console.log(`Agent Vigil control proof is pinned to ${installed.actionCommit}.`);
      console.log("No private signing key is required. GitHub OIDC signs each proof, and the workflow retains the proof and bundle for 90 days.");
      return 0;
    }
    if (command === "record") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--organization", "--repository", "--required-check", "--output"]));
      if (parsed.positional.length !== 1) throw new Error("certify record requires exactly one control-proof JSON path");
      const organization = parsed.values.get("--organization");
      const repository2 = parsed.values.get("--repository");
      const requiredCheck = parsed.values.get("--required-check");
      const output = parsed.values.get("--output");
      if (!organization || !repository2 || !requiredCheck || !output) throw new Error("certify record requires --organization, --repository, --required-check, and --output");
      const proof = readBoundedJson(resolve27(parsed.positional[0]), 2 * 1024 * 1024, "control proof");
      const certificate = createCertificate({ proof, organization, repository: repository2, requiredCheck });
      writePrivateFileAtomic(resolve27(output), `${JSON.stringify(certificate, null, 2)}
`);
      console.log(`Control certificate: ${certificate.proof.status} \xB7 ${certificate.certificateHash}`);
      return certificate.proof.status === "PASS" ? 0 : 2;
    }
    if (command === "sign") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--private-key", "--output"]));
      const privateKey = parsed.values.get("--private-key");
      const output = parsed.values.get("--output");
      if (parsed.positional.length !== 1 || !privateKey || !output) throw new Error("certify sign requires <proof-payload.json> --private-key <pem> --output <path>");
      const proof = signControlProof(readBoundedJson(resolve27(parsed.positional[0]), 2 * 1024 * 1024, "signed proof payload"), resolve27(privateKey));
      writePrivateFileAtomic(resolve27(output), `${JSON.stringify(proof, null, 2)}
`);
      console.log(`Signed control proof: ${proof.payload.status}`);
      console.log(`Control identity: ${signedControlIdentity(proof)}`);
      return proof.payload.status === "PASS" ? 0 : 2;
    }
    if (command === "record-signed") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--public-key", "--organization", "--repository", "--required-check", "--output"]));
      const publicKeyPath = parsed.values.get("--public-key");
      const organization = parsed.values.get("--organization");
      const repository2 = parsed.values.get("--repository");
      const requiredCheck = parsed.values.get("--required-check");
      const output = parsed.values.get("--output");
      if (parsed.positional.length !== 1 || !publicKeyPath || !organization || !repository2 || !requiredCheck || !output) throw new Error("certify record-signed requires <signed-proof.json> --public-key <pem> --organization <name> --repository <owner/name> --required-check <name> --output <path>");
      const certificate = createSignedCertificate({
        proof: readBoundedJson(resolve27(parsed.positional[0]), 2 * 1024 * 1024, "signed control proof"),
        publicKeyPath: resolve27(publicKeyPath),
        organization,
        repository: repository2,
        requiredCheck
      });
      writePrivateFileAtomic(resolve27(output), `${JSON.stringify(certificate, null, 2)}
`);
      console.log(`Signed control certificate: ${certificate.proof.payload.status} \xB7 ${certificate.certificateHash}`);
      console.log(`Control identity: ${signedControlIdentity(certificate.proof)}`);
      return certificate.proof.payload.status === "PASS" ? 0 : 2;
    }
    if (command === "add") {
      const parsed = parseCommandArgs(args.slice(1), /* @__PURE__ */ new Set(["--corpus"]));
      const corpus = parsed.values.get("--corpus");
      if (parsed.positional.length !== 1 || !corpus) throw new Error("certify add requires <certificate.json> --corpus <corpus.jsonl>");
      const certificate = validateAnyCertificate(readBoundedJson(resolve27(parsed.positional[0]), 2 * 1024 * 1024, "control certificate"));
      const corpusPath = resolve27(corpus);
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
      const report = buildStatusReport(loadPolicy2(resolve27(policy)), loadCorpus(resolve27(corpus)), parsed.values.get("--as-of") ?? (/* @__PURE__ */ new Date()).toISOString());
      const rendered = format === "json" ? `${JSON.stringify(report, null, 2)}
` : `${renderStatusReport(report)}
`;
      const output = parsed.values.get("--output");
      if (output) writePrivateFileAtomic(resolve27(output), `${JSON.stringify(report, null, 2)}
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
      writePrivateFileAtomic(resolve27(output), `${JSON.stringify(generated, null, 2)}
`);
      console.log(`Created ${pack} control policy with a ${generated.maxAgeHours}-hour proof window.`);
      return 0;
    }
    throw new Error("certify requires record, sign, record-signed, add, status, or policy");
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runPlan(args) {
  try {
    const allowed2 = /* @__PURE__ */ new Set(["plan", "--repo", "--base", "--head", "--policy", "--format", "--output", "--json", "--github-summary"]);
    const takesValue = /* @__PURE__ */ new Set(["--repo", "--base", "--head", "--policy", "--format", "--output"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed2.has(arg)) throw new Error(`unknown plan argument: ${arg}`);
      if (takesValue.has(arg)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
        index += 1;
      }
    }
    const repo = resolve27(optionValue(args, "--repo") ?? ".");
    const baseRef = optionValue(args, "--base") ?? process.env.GITHUB_BASE_SHA ?? "HEAD~1";
    const headRef = optionValue(args, "--head") ?? process.env.GITHUB_HEAD_SHA ?? "HEAD";
    if (!existsSync13(repo)) throw new Error(`repository not found: ${repo}`);
    if (!gitRefExists(repo, baseRef) || !gitRefExists(repo, headRef)) throw new Error(`invalid git range ${baseRef}..${headRef}`);
    const format = args.includes("--json") ? "json" : optionValue(args, "--format") ?? "text";
    if (!(/* @__PURE__ */ new Set(["text", "json", "markdown"])).has(format)) throw new Error("plan --format must be text, json, or markdown");
    const policyPath = optionValue(args, "--policy");
    if (policyPath && (isAbsolute11(policyPath) || policyPath === ".." || policyPath.startsWith("../") || policyPath.includes("\\"))) {
      throw new Error("plan --policy must be a repository-relative POSIX path");
    }
    const report = buildAuthorityPlan(repo, baseRef, headRef, VERSION, policyPath);
    const rendered = format === "json" ? `${JSON.stringify(report, null, 2)}
` : format === "markdown" ? renderAuthorityPlanMarkdown(report) : `${renderAuthorityPlan(report)}
`;
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve27(output), `${JSON.stringify(report, null, 2)}
`);
    else process.stdout.write(rendered);
    if (args.includes("--github-summary")) {
      const summaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (!summaryPath) throw new Error("--github-summary requires GITHUB_STEP_SUMMARY");
      appendPrivateFileAtomic(resolve27(summaryPath), renderAuthorityPlanMarkdown(report));
    }
    return report.status === "PASS" ? 0 : report.status === "BLOCK" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runProofComment(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--verify-url", "--output"]));
    if (parsed.positional.length !== 1) throw new Error("proof-comment requires exactly one full receipt JSON path");
    const { report } = loadReceipt(resolve27(parsed.positional[0]));
    const rendered = renderProofComment(report, { verifyUrl: parsed.values.get("--verify-url") });
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve27(output), rendered);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
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
    if (!takesValue.has(arg)) throw new Error(`unknown argument: ${arg}`);
    const value = args[++index];
    if (value === void 0) throw new Error(`${arg} requires a value`);
    if (arg === "--repo") options.repo = value;
    if (arg === "--base") options.base = value;
    if (arg === "--head") options.head = value;
    if (arg === "--test-cmd") options.testCmd = value;
    if (arg === "--format") {
      if (!(/* @__PURE__ */ new Set(["text", "json", "markdown", "sarif"])).has(value)) throw new Error(`unsupported format: ${value}`);
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
function optionValue(args, name2) {
  const index = args.indexOf(name2);
  if (index === -1) return void 0;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name2} requires a value`);
  return args[index + 1];
}
function runInit3(args) {
  try {
    const repo = resolve27(optionValue(args, "--repo") ?? ".");
    const portable = args.includes("--portable");
    const attest = args.includes("--attest");
    const profile = optionValue(args, "--profile") ?? "default";
    if (!(/* @__PURE__ */ new Set(["default", "maintainer", "authority", "protect"])).has(profile)) throw new Error("init --profile must be default, maintainer, authority, or protect");
    const publicKey = optionValue(args, "--public-key");
    if (portable && profile !== "default") throw new Error("init --portable cannot be combined with a named profile");
    if (portable && !publicKey) throw new Error("init --portable requires --public-key <Ed25519 public key>");
    if (!portable && publicKey) throw new Error("init --public-key is only valid with --portable");
    const result5 = initRepository(repo, args.includes("--force"), publicKey ? publicKeyId(resolve27(publicKey)) : void 0, profile, attest);
    console.log("Agent Vigil initialized.\n");
    for (const path of result5.created) console.log(`  created ${path}`);
    for (const path of result5.kept) console.log(`  kept    ${path} (use --force to replace)`);
    console.log(profile === "maintainer" ? "\nNext: replace the PR-template login, review the base-anchored limits, merge this setup first, then open a code PR with a regression test that fails on base and passes on head." : profile === "authority" ? "\nNext: replace the task ID, paths, action classes, and expiry; point the workflow at a structured agent transcript; merge the contract before the code change." : portable ? "\nNext: merge this base policy first, then generate a portable receipt after each code commit with --portable-output." : attest ? "\nNext: replace .agent-vigil/session.md with real evidence, push one PR, verify its GitHub attestation, then require the Agent Vigil evidence status check." : "\nNext: replace .agent-vigil/session.md with a real agent transcript or summary, push one PR, then require the Agent Vigil evidence status check.");
    if (attest && profile !== "default") {
      console.log("Next for signing: push one pull request, download agent-vigil-report.json, and run vigil verify-attestation before making the check required.");
    }
    return 0;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runProtect(args) {
  try {
    const allowed2 = /* @__PURE__ */ new Set(["protect", "--repo", "--force", "--attest"]);
    for (let index = 1; index < args.length; index++) {
      const arg = args[index];
      if (!allowed2.has(arg)) throw new Error(`unknown protect argument: ${arg}`);
      if (arg === "--repo") index += 1;
    }
    const repo = resolve27(optionValue(args, "--repo") ?? ".");
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
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function withoutOption(args, name2) {
  const output = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === name2) {
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
    const repo = resolve27(options.repo);
    const eventPath = resolve27(eventOption);
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
    const rawEvent = readFileSync27(eventPath);
    const eventHash = `sha256:${createHash24("sha256").update(rawEvent).digest("hex")}`;
    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative14(repo, policy.path) : void 0;
    const remote = git9(repo, ["config", "--get", "remote.origin.url"]);
    const tree = git9(repo, ["rev-parse", `${head}^{tree}`]);
    const reproduction = [
      "vigil maintainer",
      "--event",
      shellQuote2(eventOption),
      "--repo",
      ".",
      "--base",
      base,
      "--head",
      head,
      ...policy.gitPath ? ["--policy", shellQuote2(policy.gitPath)] : policySource ? ["--policy", shellQuote2(policySource)] : [],
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
    console.error(`agent-vigil: ${error.message}`);
    return 2;
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
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runDoctor2(args) {
  try {
    const repo = resolve27(optionValue(args, "--repo") ?? ".");
    const checks = doctorRepository(repo, optionValue(args, "--policy"), optionValue(args, "--transcript"));
    console.log(renderDoctor(checks));
    return checks.some((check) => check.status === "FAIL") ? 2 : 0;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runKeygen(args) {
  try {
    const privatePath = optionValue(args, "--private");
    const publicPath = optionValue(args, "--public");
    if (!privatePath || !publicPath) throw new Error("keygen requires --private and --public paths");
    generateSigningKey(resolve27(privatePath), resolve27(publicPath));
    console.log(`Created Ed25519 private key ${privatePath} and public key ${publicPath}. Keep the private key out of Git.`);
    console.log(`Signer key ID: ${publicKeyId(resolve27(publicPath))}`);
    return 0;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
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
    const absoluteReceipt = resolve27(options.repo, receiptPath);
    const receipt = JSON.parse(readFileSync27(absoluteReceipt, "utf8"));
    const report = buildPortableGateReport(receipt, {
      repo: resolve27(options.repo),
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
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runVerify3(args) {
  try {
    const receiptPath = args.find((arg, index) => index > 0 && !arg.startsWith("--") && args[index - 1] !== "--public-key");
    if (!receiptPath) throw new Error("verify requires a receipt JSON path");
    const report = JSON.parse(readFileSync27(resolve27(receiptPath), "utf8"));
    if (report.schemaVersion !== "2") throw new Error(`unsupported receipt schema: ${String(report.schemaVersion)}`);
    const publicKey = optionValue(args, "--public-key");
    const result5 = verifyReport(report, publicKey ? resolve27(publicKey) : void 0);
    console.log(`Receipt hash: ${result5.hashValid ? "VALID" : "INVALID"}`);
    if (result5.signatureValid !== void 0) {
      console.log(`Ed25519 signature: ${result5.signatureValid ? "VALID" : "INVALID"} \xB7 ${result5.keyPinned ? "pinned public key" : "embedded self-asserted key"}`);
      if (!result5.keyPinned) console.log("Identity is not established until the public key is pinned through a trusted channel.");
    } else console.log("Signature: absent (content hash only)");
    return result5.hashValid && result5.signatureValid !== false ? 0 : 1;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
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
      if (values.has(arg)) throw new Error(`duplicate option: ${arg}`);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      continue;
    }
    if (booleanOptions.has(arg)) {
      if (flags.has(arg)) throw new Error(`duplicate option: ${arg}`);
      flags.add(arg);
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return { positional: positional2, values, flags };
}
function runAttest(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--predicate-output"]));
    const predicateOutput = parsed.values.get("--predicate-output");
    if (parsed.positional.length !== 1 || !predicateOutput) throw new Error("attest requires <receipt.json> and --predicate-output <path>");
    const receiptPath = parsed.positional[0];
    const predicate = writeAttestationPredicate(resolve27(receiptPath), resolve27(predicateOutput));
    console.log("Agent Vigil attestation predicate prepared.");
    console.log(`  receipt:  ${predicate.receipt.receiptHash}`);
    console.log(`  decision: ${predicate.receipt.status}`);
    console.log(`  change:   ${predicate.receipt.base}..${predicate.receipt.head}`);
    console.log(`  output:   ${predicateOutput}`);
    console.log(`  type:     ${ATTESTATION_PREDICATE_TYPE}`);
    console.log("The predicate contains hashes, SHAs, counts, and the decision. It does not contain source code, prompts, or transcript text.");
    return 0;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runVerifyAttestation(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--repository", "--signer-workflow"]), /* @__PURE__ */ new Set(["--allow-self-hosted"]));
    const repository2 = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    if (parsed.positional.length !== 1 || !repository2) throw new Error("verify-attestation requires <receipt.json> and --repository <owner/name>");
    const receiptPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository2}/.github/workflows/agent-vigil.yml`;
    const verification2 = verifyGitHubAttestation(resolve27(receiptPath), repository2, { signerWorkflow, allowSelfHosted: parsed.flags.has("--allow-self-hosted") });
    const { report } = loadReceipt(resolve27(receiptPath));
    console.log(`GitHub attestation: ${verification2.valid ? "VALID" : "INVALID"}`);
    console.log(`Receipt file: ${verification2.subjectDigestValid ? "VALID" : "INVALID"}`);
    console.log(`Receipt contents: ${verification2.receiptHashValid && verification2.predicateValid ? "VALID" : "INVALID"}`);
    console.log(`Decision: ${report.summary.status}`);
    console.log(`Change: ${report.base}..${report.head}`);
    console.log(`Receipt: ${report.receiptHash}`);
    console.log(`Signer workflow: ${signerWorkflow}`);
    return verification2.valid ? 0 : 1;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runAttestControl(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--predicate-output"]));
    const predicateOutput = parsed.values.get("--predicate-output");
    if (parsed.positional.length !== 1 || !predicateOutput) throw new Error("attest-control requires <control-proof.json> and --predicate-output <path>");
    const proofPath = parsed.positional[0];
    const predicate = writeControlProofPredicate(resolve27(proofPath), resolve27(predicateOutput));
    console.log("Agent Vigil control-proof attestation predicate prepared.");
    console.log(`  proof:    ${predicate.proof.receiptHash}`);
    console.log(`  decision: ${predicate.proof.status}`);
    console.log(`  source:   ${predicate.proof.sourceCommit}`);
    console.log(`  output:   ${predicateOutput}`);
    console.log(`  type:     ${CONTROL_PROOF_ATTESTATION_PREDICATE_TYPE}`);
    console.log("The predicate contains hashes, the exact source commit, counts, and the decision. It does not contain repository paths, claims, or evidence text.");
    return 0;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runVerifyControlAttestation(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--repository", "--signer-workflow", "--signer-digest"]), /* @__PURE__ */ new Set(["--allow-self-hosted"]));
    const repository2 = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    if (parsed.positional.length !== 1 || !repository2) throw new Error("verify-control-attestation requires <control-proof.json> and --repository <owner/name>");
    const proofPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository2}/.github/workflows/agent-vigil-control-proof.yml`;
    const verification2 = verifyGitHubControlProofAttestation(resolve27(proofPath), repository2, {
      signerWorkflow,
      ...parsed.values.get("--signer-digest") ? { signerDigest: parsed.values.get("--signer-digest") } : {},
      allowSelfHosted: parsed.flags.has("--allow-self-hosted")
    });
    const { proof } = loadControlProof(resolve27(proofPath));
    console.log(`GitHub control-proof attestation: ${verification2.valid ? "VALID" : "INVALID"}`);
    console.log(`Proof file: ${verification2.subjectDigestValid ? "VALID" : "INVALID"}`);
    console.log(`Proof contents: ${verification2.proofHashValid && verification2.predicateValid ? "VALID" : "INVALID"}`);
    console.log(`Decision: ${proof.status}`);
    console.log(`Source commit: ${proof.sourceCommit}`);
    console.log(`Proof: ${proof.receiptHash}`);
    console.log(`Signer workflow: ${signerWorkflow}`);
    if (parsed.values.get("--signer-digest")) console.log(`Signer digest: ${parsed.values.get("--signer-digest")}`);
    return verification2.valid ? 0 : 1;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
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
    const verification2 = verifyGitHubAttestation(resolve27(receiptPath), repository2, { signerWorkflow, allowSelfHosted: parsed.flags.has("--allow-self-hosted") });
    const payload = buildNotaryCheck(resolve27(receiptPath), verification2, head, policySha256);
    const rendered = `${JSON.stringify(payload, null, 2)}
`;
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve27(output), rendered);
    else process.stdout.write(rendered);
    return payload.conclusion === "success" ? 0 : payload.conclusion === "failure" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runCompare(args) {
  try {
    const values = args.slice(1).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--format" && all[index - 1] !== "--output");
    if (values.length !== 2) throw new Error("compare requires before and after full receipt JSON paths");
    const format = optionValue(args, "--format") ?? "text";
    if (format !== "text" && format !== "json") throw new Error("compare --format must be text or json");
    const before = JSON.parse(readFileSync27(resolve27(values[0]), "utf8"));
    const after = JSON.parse(readFileSync27(resolve27(values[1]), "utf8"));
    if (before.schemaVersion !== "2" || after.schemaVersion !== "2") throw new Error("compare supports full receipt schema 2 only");
    const delta = compareReceipts(before, after);
    const rendered = format === "json" ? `${JSON.stringify(delta, null, 2)}
` : `${renderReceiptDelta(delta)}
`;
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve27(output), rendered);
    else process.stdout.write(rendered);
    return delta.status === "PASS" ? 0 : delta.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function valueNumber(value, name2) {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) throw new Error(`${name2} must be a non-negative decimal number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name2} must be a non-negative decimal number`);
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
    if (!takesValue.has(arg)) throw new Error(`unknown value argument: ${arg}`);
    if (values.has(arg)) throw new Error(`duplicate value argument: ${arg}`);
    const value = args[++index];
    if (value === void 0 || value.startsWith("--")) throw new Error(`${arg} requires a value`);
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
  return readFileSync27(path);
}
function runValue(args) {
  try {
    const options = parseValueArgs(args);
    const receiptPath = resolve27(options.receipt);
    const rawReceipt = readBoundedFile(receiptPath, 16 * 1024 * 1024, "value receipt");
    const report = JSON.parse(rawReceipt.toString("utf8"));
    if (report.schemaVersion !== "2" || !report.summary || typeof report.receiptHash !== "string") {
      throw new Error("value requires a full Agent Vigil receipt schema 2");
    }
    const verification2 = verifyReport(report, options.publicKey ? resolve27(options.publicKey) : void 0);
    if (!verification2.hashValid) throw new Error("value receipt hash is invalid");
    if (verification2.signatureValid === false) throw new Error("value receipt signature is invalid");
    let transcriptPath;
    if (options.transcript) transcriptPath = resolve27(options.transcript);
    else if ((/* @__PURE__ */ new Set(["codex", "claude-code", "authority/codex", "authority/claude-code"])).has(report.transcriptFormat)) {
      const candidates = [
        resolve27(dirname12(receiptPath), report.transcript),
        ...isAbsolute11(report.repo) ? [resolve27(report.repo, report.transcript)] : []
      ];
      transcriptPath = candidates.find((candidate) => existsSync13(candidate));
    }
    let loaded;
    if (transcriptPath) {
      loaded = loadTranscript(transcriptPath);
      if (loaded.transcriptSha256 !== report.transcriptSha256) throw new Error("value transcript digest does not match the receipt");
    }
    const evidenceHash = (path, label) => {
      if (!path) return void 0;
      const evidence = readBoundedFile(resolve27(path), 64 * 1024 * 1024, label);
      return `sha256:${createHash24("sha256").update(evidence).digest("hex")}`;
    };
    const costEvidenceSha256 = evidenceHash(options.costEvidence, "cost evidence");
    const github = options.githubEvidence ? loadGitHubEvidence(resolve27(options.githubEvidence)) : void 0;
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
    if (options.output) writePrivateFileAtomic(resolve27(options.output), rendered);
    else process.stdout.write(rendered);
    return card.valueVerdict === "POSITIVE" ? 0 : card.valueVerdict === "NEGATIVE" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
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
      const value = args[++index];
      if (value === void 0 || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--output") {
        if (output) throw new Error("duplicate --output");
        output = value;
        continue;
      }
      const kind = flagKinds[flag];
      if (!kind) throw new Error(`unknown github-evidence argument: ${flag}`);
      if (inputs[kind]) throw new Error(`duplicate ${flag}`);
      inputs[kind] = value;
    }
    if (!inputs.event) throw new Error("github-evidence requires --event <event.json>");
    const bundle = buildGitHubEvidence(inputs);
    const rendered = `${JSON.stringify(bundle, null, 2)}
`;
    if (output) writePrivateFileAtomic(resolve27(output), rendered);
    else process.stdout.write(rendered);
    return 0;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
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
        if (value === void 0 || value.startsWith("--")) throw new Error(`${arg} requires a value`);
        if (arg === "--format") {
          if (!(/* @__PURE__ */ new Set(["text", "json", "html"])).has(value)) throw new Error("compare-value --format must be text, json, or html");
          format = value;
        } else output = value;
      } else if (arg.startsWith("--")) throw new Error(`unknown compare-value argument: ${arg}`);
      else paths.push(arg);
    }
    if (!paths.length) throw new Error("compare-value requires at least one Agent Value Card JSON path");
    const cards = paths.map(loadValueCard);
    const comparison = compareValueCards(cards, paths.length);
    const rendered = format === "json" ? `${JSON.stringify(comparison, null, 2)}
` : format === "html" ? renderValueComparisonHtml(comparison) : renderValueComparisonText(comparison);
    if (output) writePrivateFileAtomic(resolve27(output), rendered);
    else process.stdout.write(rendered);
    return comparison.status === "COMPARABLE" ? 0 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runAudit(args) {
  try {
    const options = parseArgs(args.slice(1));
    const diffPath = options.transcript;
    if (!diffPath) throw new Error("audit requires a unified Git diff path");
    const absolute = resolve27(diffPath);
    const raw = readFileSync27(absolute);
    if (raw.byteLength > 64 * 1024 * 1024) throw new Error("audit input exceeds the 64 MiB limit");
    const diff = raw.toString("utf8");
    const digest8 = `sha256:${createHash24("sha256").update(raw).digest("hex")}`;
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
      transcriptSha256: digest8,
      transcriptFormat: "unified-git-diff",
      repo: "static-diff-audit",
      base: "unavailable",
      head: digest8,
      results: integrity.results,
      advisories: integrity.advisories,
      policy: { minVerified: 1, strict: true, source: options.strict ? "built-in strict static diff policy" : "built-in advisory static diff policy", sha256: `sha256:${createHash24("sha256").update(`agent-vigil-static-diff-v2:${options.strict ? "blocking" : "advisory"}`).digest("hex")}` },
      reproduction: `vigil audit ${shellQuote2(diffPath)}${options.strict ? " --strict" : ""}`
    });
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runTestIntegrity(args) {
  try {
    const options = parseArgs(args.slice(1));
    const repo = resolve27(options.repo);
    if (!gitRefExists(repo, options.base) || options.head !== "WORKTREE" && !gitRefExists(repo, options.head)) {
      throw new Error(`invalid git range ${options.base}..${options.head}`);
    }
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const checks = checkIntegrity(repo, base, head);
    const integrity = routeIntegrity(checks, options.strict ? "blocking" : "calibrated");
    if (!integrity.results.length && integrity.advisories.length) {
      integrity.results.push({
        claim: { kind: "integrity", quote: "calibrated test-integrity scan", subject: "selected diff scanned" },
        verdict: "verified",
        evidence: `${integrity.advisories.length} lower-confidence finding(s) recorded for review without blocking this calibrated run`,
        ruleId: "integrity-scan",
        contributesToPass: true
      });
    }
    for (const check of integrity.results) {
      if (check.ruleId === "integrity-scan" && check.verdict === "verified") check.contributesToPass = true;
    }
    const diffArgs = head === "WORKTREE" ? ["diff", "--no-color", base] : ["diff", "--no-color", base, head];
    const diff = execFileSync19("git", diffArgs, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const digest8 = `sha256:${createHash24("sha256").update(diff).digest("hex")}`;
    const policyName = options.strict ? "all static integrity findings block" : "calibrated high-confidence test integrity rules block";
    const report = buildReport({
      transcript: `${base}..${head}`,
      transcriptSha256: digest8,
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
        sha256: `sha256:${createHash24("sha256").update(`agent-vigil-test-integrity-v1:${options.strict ? "blocking" : "calibrated"}`).digest("hex")}`
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
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runAuthority(args) {
  try {
    if (args[1] === "init") {
      const output = optionValue(args, "--output");
      const rendered = authorityContractTemplate();
      if (output) {
        writePrivateFileAtomic(resolve27(output), rendered);
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
    const repo = resolve27(options.repo);
    if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) throw new Error(`invalid git range ${options.base}..${options.head}`);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const transcriptPath = isAbsolute11(transcriptOption) ? transcriptOption : resolve27(repo, transcriptOption);
    if (!existsSync13(transcriptPath)) throw new Error(`transcript not found: ${transcriptPath}`);
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
      shellQuote2(relativeTranscript),
      "--contract",
      shellQuote2(contract.gitPath ?? contractOption),
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
    if (options.signingKey) report = signReport(report, resolve27(options.signingKey));
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function git9(repo, args) {
  try {
    return execFileSync19("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function shellQuote2(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function run(argv = process.argv.slice(2)) {
  if (argv[0] === "demo") return runDemo(run);
  if (argv[0] === "continuity") return runContinuityCommand(argv.slice(1));
  if (argv[0] === "upgrade") return runUpgradeCommand(argv.slice(1));
  if (argv[0] === "protect") return runProtect(argv);
  if (argv[0] === "prove") return runProve(argv);
  if (argv[0] === "guard-compat") return runGuardCompatibilityCommand(argv);
  if (argv[0] === "guard-route") return runGuardRouteCommand(argv);
  if (argv[0] === "certify") return runCertify(argv);
  if (argv[0] === "plan") return runPlan(argv);
  if (argv[0] === "proof-comment") return runProofComment(argv);
  if (argv[0] === "test-integrity") return runTestIntegrity(argv);
  if (argv[0] === "init") return runInit3(argv);
  if (argv[0] === "doctor") return runDoctor2(argv);
  if (argv[0] === "keygen") return runKeygen(argv);
  if (argv[0] === "verify") return runVerify3(argv);
  if (argv[0] === "attest") return runAttest(argv);
  if (argv[0] === "verify-attestation") return runVerifyAttestation(argv);
  if (argv[0] === "attest-control") return runAttestControl(argv);
  if (argv[0] === "verify-control-attestation") return runVerifyControlAttestation(argv);
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
    console.log(usage4());
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
    console.error(`agent-vigil: ${error.message}

${usage4()}`);
    return 2;
  }
  const repo = resolve27(options.repo);
  if (options.portableOutput && !options.signingKey) {
    console.error("agent-vigil: --portable-output requires --signing-key");
    return 2;
  }
  let policy;
  try {
    policy = loadPolicy(repo, options.policy, options.policyRef);
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
  const transcript = options.transcript ?? policy.value.transcript;
  if (!transcript) {
    console.error(usage4());
    return 2;
  }
  const transcriptPath = isAbsolute11(transcript) ? transcript : resolve27(repo, transcript);
  const testCmd = options.testCmd ?? policy.value.testCommand;
  const strict = options.strict ?? policy.value.strict ?? false;
  const minVerified = options.minVerified ?? policy.value.minVerified ?? 1;
  if (!existsSync13(transcriptPath)) {
    console.error(`agent-vigil: transcript not found: ${transcriptPath}`);
    return 2;
  }
  if (!existsSync13(repo)) {
    console.error(`agent-vigil: repository not found: ${repo}`);
    return 2;
  }
  if (!gitRefExists(repo, options.base) || options.head !== "WORKTREE" && !gitRefExists(repo, options.head)) {
    console.error(`agent-vigil: invalid git range ${options.base}..${options.head}`);
    return 2;
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
      ...options.signingKey ? [resolve27(options.signingKey)] : [],
      ...options.portableOutput ? [resolve27(repo, options.portableOutput)] : []
    ];
    results.push(...checkWorkspaceBinding(repo, head, workspaceInputs));
    results.push(...checkTestsPass(claims, repo, testCmd));
    results.push(...checkWorkspaceMutation(repo, workspaceInputs, head));
    results.push(...checkFilesChanged(claims, repo, base, head));
    const changedClaims = new Set(claims.filter((claim) => claim.kind === "file_changed").map((claim) => claim.subject));
    results.push(...checkPathsExist(claims.filter((claim) => !changedClaims.has(claim.subject)), repo));
    results.push(...checkRunClaims(runClaims, loaded.toolCalls));
    results.push(...checkStepRepetition(loaded.toolCalls));
    const integrity = routeIntegrity([
      ...checkIntegrity(repo, base, head),
      ...checkOutOfDagReads(repo, base, head, loaded.toolCalls)
    ], policy.value.integrityMode ?? "advisory");
    results.push(...integrity.results);
    advisories.push(...integrity.advisories);
    results.push(...checkCompletion(claims, repo, base, head, results));
    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative14(repo, policy.path) : void 0;
    const remote = git9(repo, ["config", "--get", "remote.origin.url"]);
    const tree = head === "WORKTREE" ? void 0 : git9(repo, ["rev-parse", `${head}^{tree}`]);
    const relativeTranscript = relative14(repo, transcriptPath) || transcript;
    const reproduction = [
      "vigil",
      shellQuote2(relativeTranscript),
      "--repo",
      ".",
      "--base",
      base,
      "--head",
      head,
      ...options.testCmd ? ["--test-cmd", shellQuote2(options.testCmd)] : [],
      ...policy.gitPath ? ["--policy", shellQuote2(policy.gitPath)] : policySource ? ["--policy", shellQuote2(policySource)] : [],
      ...policy.ref ? ["--policy-ref", policy.ref] : [],
      ...strict && !policy.value.strict ? ["--strict"] : [],
      ...options.minVerified !== void 0 ? ["--min-verified", String(options.minVerified)] : [],
      ...options.portableOutput ? ["--portable-output", shellQuote2(options.portableOutput)] : []
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
    if (options.signingKey) report = signReport(report, resolve27(options.signingKey));
    writeOutputs(report, options);
    if (options.portableOutput) {
      const portable = createPortableReceipt(report, resolve27(options.signingKey));
      const portablePath = resolve27(repo, options.portableOutput);
      mkdirSync11(dirname12(portablePath), { recursive: true });
      writeFileSync10(portablePath, `${JSON.stringify(portable, null, 2)}
`);
    }
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync15(process.argv[1]) === realpathSync15(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) {
  const argv = process.argv.slice(2);
  if (argv[0] === "pr-receipt") {
    void runPublicPrReceiptCommand(argv.slice(1), { toolVersion: VERSION }).then((code2) => process.exit(code2));
  } else process.exit(run(argv));
}
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
