#!/usr/bin/env node

// src/cli.ts
import { createHash as createHash12 } from "node:crypto";
import { execFileSync as execFileSync10 } from "node:child_process";
import { existsSync as existsSync5, mkdirSync as mkdirSync4, readFileSync as readFileSync14, realpathSync as realpathSync3, statSync as statSync7, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname4, isAbsolute as isAbsolute4, relative as relative7, resolve as resolve12 } from "node:path";
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
function safeJson(text) {
  try {
    return JSON.parse(text);
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
  const usage2 = [...usageByMessage.values()].reduce((total, item2) => ({
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
      ...usage2,
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
function snippet(text, at) {
  return text.slice(Math.max(0, at - 45), at + 100).replace(/\s+/g, " ").trim();
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
      const marker = line.slice(4).trim();
      currentPath = marker === "/dev/null" ? "" : marker.replace(/^b\//, "");
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
    ["focused or skipped test introduced", /\b(?:test|it|describe)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe)\s*\(|@pytest\.mark\.skip|#\[ignore\]/i, "test-skip-added", (patch) => isTestPath(patch.path)],
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
var VERSION = "0.12.0";
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
  const count = (verdict) => input.results.filter((r) => r.verdict === verdict).length;
  const contradicted = count("contradicted");
  const unverifiable = count("unverifiable");
  const meaningfulVerified = input.results.filter(
    (r) => r.verdict === "verified" && r.contributesToPass !== false
  ).length;
  let status;
  if (contradicted > 0) status = "FAIL";
  else if (meaningfulVerified < policy.minVerified || input.results.some((result5) => result5.verdict === "unverifiable" && result5.blocksPass) || policy.strict && unverifiable > 0) status = "INCONCLUSIVE";
  else status = "PASS";
  const summary = {
    verified: count("verified"),
    contradicted,
    unverifiable,
    meaningfulVerified,
    status,
    pass: status === "PASS"
  };
  const advisories = input.advisories ?? [];
  const receiptPayload = {
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
    receiptHash: `sha256:${createHash2("sha256").update(canonical(receiptPayload)).digest("hex")}`,
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
    "authority-contract-anchor": "Store the contract in the trusted base revision and pass --contract-ref <base-sha> in CI."
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
  const count = join2(evidence, "false-count.md");
  const ghost = join2(evidence, "ghost-file.md");
  const loop = join2(evidence, "tool-loop.jsonl");
  writeFileSync2(count, "All 99 tests pass.\n");
  writeFileSync2(ghost, "I created src/ghost.ts. The work is complete.\n");
  const rows = [
    { type: "assistant", message: { content: [{ type: "text", text: "The test suite passes." }] } },
    ...["a", "b", "c"].map((id) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: "src/real.ts" } }] } }))
  ];
  writeFileSync2(loop, `${rows.map((row) => JSON.stringify(row)).join("\n")}
`);
  const scenarios = [
    ["claimed 99 tests; runner has 1", count],
    ["claimed a file that does not exist", ghost],
    ["repeated the identical tool call 3 times", loop]
  ];
  let caught = 0;
  console.log("Agent Vigil adversarial demo\n");
  for (const [label, transcript] of scenarios) {
    console.log(`=== ${label} ===`);
    const code = run2([transcript, "--repo", repo, "--base", "HEAD~1", "--head", "HEAD", "--strict"]);
    if (code === 1) caught++;
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
  if (value.integrityMode !== void 0 && !(/* @__PURE__ */ new Set(["advisory", "blocking"])).has(String(value.integrityMode))) {
    throw new Error("policy integrityMode must be advisory or blocking");
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
    "requireHumanAttestation",
    "requireLinkedIssue",
    "requireAiDisclosure",
    "maxChangedFiles",
    "maxChangedLines",
    "requireTestChange",
    "protectedPaths",
    "testPathPatterns",
    "differentialTest"
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`policy maintainer contains unknown field(s): ${unknown.join(", ")}`);
  for (const key of ["requireHumanAttestation", "requireLinkedIssue", "requireAiDisclosure", "requireTestChange"]) {
    if (value[key] !== void 0 && typeof value[key] !== "boolean") throw new Error(`policy maintainer.${key} must be boolean`);
  }
  if (value.maxChangedFiles !== void 0) positiveInteger(value.maxChangedFiles, "maintainer.maxChangedFiles", 1e5);
  if (value.maxChangedLines !== void 0) positiveInteger(value.maxChangedLines, "maintainer.maxChangedLines", 1e7);
  if (value.protectedPaths !== void 0) nonEmptyStrings(value.protectedPaths, "maintainer.protectedPaths");
  if (value.testPathPatterns !== void 0) nonEmptyStrings(value.testPathPatterns, "maintainer.testPathPatterns");
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
function maintainerPolicyTemplate(testCommand, setupCommand) {
  const command = testCommand ?? "REPLACE_WITH_TEST_COMMAND";
  const value = {
    schemaVersion: 1,
    integrityMode: "advisory",
    testCommand: command,
    strict: true,
    minVerified: 1,
    maintainer: {
      requireHumanAttestation: true,
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
  if (policy.requireHumanAttestation !== false) {
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
  const env = { ...process.env, CI: "true" };
  delete env.NODE_TEST_CONTEXT;
  const execution = spawnSync2(command, { cwd, shell: true, encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env });
  const full = `${execution.stdout ?? ""}${execution.stderr ?? ""}`;
  const output = full.length > MAX_COMMAND_OUTPUT ? `${full.slice(0, MAX_COMMAND_OUTPUT)}
[output truncated]` : full;
  return { status: execution.status, signal: execution.signal, output, ...execution.error ? { error: execution.error.message } : {} };
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
    repeatedActionGroups: counts.filter((count) => count > 1).length,
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
        uses: sulmusic2-star/agent-vigil@v${VERSION}
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
        uses: sulmusic2-star/agent-vigil@v${VERSION}
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
var MAINTAINER_PR_TEMPLATE = `## Agent Vigil maintainer evidence

- Responsible human: @REPLACE_WITH_YOUR_GITHUB_LOGIN
- [ ] I reviewed every changed line.
- [ ] I can explain and maintain this change.
- AI assistance: assisted
- Linked issue: #REPLACE
- Known limitations: none known

The declarations above establish responsibility and disclosure. They do not
prove understanding. Agent Vigil independently checks the Git range, scope,
fresh tests, integrity rules, and\u2014when configured\u2014whether the changed regression
test fails against base source and passes against the candidate.
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
function initRepository(repo, force = false, portableSignerKeyId, profile = "default", attest = false) {
  const root = resolve6(repo);
  try {
    execFileSync6("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error(`not a Git repository: ${root}`);
  }
  const result5 = { created: [], kept: [] };
  const inferred = inferTestCommand(root) ?? void 0;
  const mode = profile === "maintainer" ? "maintainer" : profile === "authority" ? "authority" : portableSignerKeyId ? "portable" : "transcript";
  const setupCommand = existsSync4(resolve6(root, "package-lock.json")) ? "npm ci --ignore-scripts" : void 0;
  const defaultPolicy = policyTemplate(inferred, portableSignerKeyId);
  const authorityPolicy = defaultPolicy.replace('"transcript": ".agent-vigil/session.md"', '"transcript": ".agent-vigil/session.jsonl"');
  writeScaffold(root, DEFAULT_POLICY_FILE, profile === "maintainer" ? maintainerPolicyTemplate(inferred, setupCommand) : mode === "authority" ? authorityPolicy : defaultPolicy, force, result5);
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
      label: "Maintainer evidence",
      detail: existsSync4(template) ? "PR responsibility and disclosure template is installed" : "maintainer profile requires .github/pull_request_template.md"
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
    const text = installedWorkflow;
    const attestationEnabled = /^\s*attest:\s*true\s*$/m.test(text);
    if (attestationEnabled) {
      const permissionsPresent = /^\s*id-token:\s*write\s*$/m.test(text) && /^\s*attestations:\s*write\s*$/m.test(text) && /^\s*artifact-metadata:\s*write\s*$/m.test(text);
      const repositoryWrite = /^\s*contents:\s*write\s*$/m.test(text);
      checks.push({
        status: !permissionsPresent ? "FAIL" : repositoryWrite ? "WARN" : "PASS",
        label: "GitHub attestation",
        detail: !permissionsPresent ? "attest: true requires id-token, attestations, and artifact-metadata write permissions" : repositoryWrite ? "receipt signing is configured, but this workflow can also write repository contents; remove that permission unless another reviewed step requires it" : "receipt attestation is enabled with the required GitHub permissions"
      });
    }
    const exactRange = /pull_request\.base\.sha/.test(text) && /pull_request\.head\.sha/.test(text);
    checks.push({
      status: exactRange ? "PASS" : "WARN",
      label: "Git range",
      detail: exactRange ? "workflow pins the pull request base and head SHAs" : "workflow does not visibly pin both pull request SHAs"
    });
    const exactCheckout = /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\|\|\s*github\.event\.merge_group\.head_sha\s*\}\}/.test(text);
    checks.push({
      status: exactCheckout ? "PASS" : "WARN",
      label: "Checkout identity",
      detail: exactCheckout ? "workflow checks out the exact pull request head SHA" : "workflow may verify GitHub's synthetic merge commit instead of the selected head"
    });
    const anchoredPolicy = /policy-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}/.test(text);
    checks.push({
      status: anchoredPolicy ? "PASS" : "WARN",
      label: "Policy trust",
      detail: anchoredPolicy ? "workflow loads policy from the pull request base commit" : "workflow policy may be controlled by the candidate change"
    });
    const mergeQueue = /merge_group:\s*\n\s*types:\s*\[checks_requested\]/.test(text) && /merge_group\.base_sha/.test(text) && /merge_group\.head_sha/.test(text);
    checks.push({
      status: mergeQueue ? "PASS" : "WARN",
      label: "Merge queue",
      detail: mergeQueue ? "workflow re-verifies the composed merge-group commit" : "required check will not report for GitHub merge queues"
    });
    if (maintainer) {
      const modeInstalled = /mode:\s*maintainer/.test(text);
      const artifactInstalled = /name:\s*agent-vigil-receipt/.test(text);
      checks.push({
        status: modeInstalled && artifactInstalled ? "PASS" : "FAIL",
        label: "Maintainer workflow",
        detail: modeInstalled && artifactInstalled ? "maintainer mode and receipt artifact retention are installed" : "workflow must enable maintainer mode and retain agent-vigil-receipt"
      });
    }
    const authorityMatch = text.match(/^\s*authority-contract:\s*(\S+)\s*$/m);
    if (authorityMatch) {
      try {
        const contract = loadAuthorityContract(root, authorityMatch[1]);
        const placeholder = contract.value.taskId === "REPLACE_WITH_TASK_OR_TICKET_ID";
        const expired = Boolean(contract.value.expiresAt && Date.now() > new Date(contract.value.expiresAt).getTime());
        const anchored = /^\s*authority-contract-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\|\|\s*github\.event\.merge_group\.base_sha\s*\}\}\s*$/m.test(text);
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
function routeIntegrity(checks, mode = "advisory") {
  if (mode === "blocking") return { results: checks, advisories: [] };
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
  const count = (verdict) => report.results.filter((row) => row.verdict === verdict).length;
  const meaningfulVerified = report.results.filter((row) => row.verdict === "verified" && row.contributesToPass !== false).length;
  const expectedStatus = count("contradicted") > 0 ? "FAIL" : meaningfulVerified < report.policy.minVerified || report.results.some((row) => row.verdict === "unverifiable" && row.blocksPass) || report.policy.strict && count("unverifiable") > 0 ? "INCONCLUSIVE" : "PASS";
  if (report.summary.verified !== count("verified")) errors.push("verified count does not match results");
  if (report.summary.contradicted !== count("contradicted")) errors.push("contradicted count does not match results");
  if (report.summary.unverifiable !== count("unverifiable")) errors.push("unverifiable count does not match results");
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
import { createHash as createHash8 } from "node:crypto";
import { execFileSync as execFileSync8 } from "node:child_process";
import { readFileSync as readFileSync10 } from "node:fs";
import { relative as relative6, resolve as resolve8 } from "node:path";
function loadMergeGroupEvent(path) {
  const value = JSON.parse(readFileSync10(path, "utf8"));
  if (!value.merge_group?.base_sha || !value.merge_group?.head_sha) {
    throw new Error("event is not a merge_group payload with base_sha and head_sha");
  }
  return value;
}
function git6(repo, args) {
  try {
    return execFileSync8("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  const eventHash = `sha256:${createHash8("sha256").update(readFileSync10(eventPath)).digest("hex")}`;
  const inputs = [eventPath, ...policy.path ? [policy.path] : []];
  const results = [];
  const advisories = [];
  results.push(result4(
    "merge-group event is bound to the selected commits",
    "verified",
    `GitHub event binds base ${base} and merge-group head ${head}`,
    "merge-group-binding"
  ));
  const ancestor = git6(repo, ["merge-base", "--is-ancestor", base, head]) !== void 0;
  results.push(result4(
    "merge-group head descends from its target base",
    ancestor ? "verified" : "contradicted",
    ancestor ? `${base} is an ancestor of ${head}` : `${base} is not an ancestor of ${head}`,
    "merge-group-range"
  ));
  results.push(...checkWorkspaceBinding(repo, head, inputs));
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
  const remote = git6(repo, ["config", "--get", "remote.origin.url"]);
  const tree = git6(repo, ["rev-parse", `${head}^{tree}`]);
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
import { createHash as createHash9 } from "node:crypto";
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
  return `sha256:${createHash9("sha256").update(cardPayload(withoutHash)).digest("hex")}`;
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
import { createHash as createHash10 } from "node:crypto";
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
    source: { kind, file: basename2(path), bytes, sha256: `sha256:${createHash10("sha256").update(raw).digest("hex")}` }
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
  return `sha256:${createHash10("sha256").update(payloadWithoutHash(withoutHash)).digest("hex")}`;
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
  const repository = typeof event?.repository?.full_name === "string" ? event.repository.full_name : void 0;
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
    ...repository ? { repository } : {},
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
import { createHash as createHash11, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync as execFileSync9 } from "node:child_process";
import { readFileSync as readFileSync13, statSync as statSync6 } from "node:fs";
import { basename as basename3, resolve as resolve11 } from "node:path";
var ATTESTATION_PREDICATE_TYPE = "https://sulmusic2-star.github.io/agent-vigil/ai-change-receipt-predicate-v1.schema.json";
function sha256(buffer) {
  return createHash11("sha256").update(buffer).digest("hex");
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
  return { report, bytes, fileSha256: sha256(bytes) };
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
    const record = root;
    const verification2 = record.verificationResult;
    const statement = verification2 && typeof verification2 === "object" ? verification2.statement : record.statement ?? record;
    if (statement && typeof statement === "object") statements.push(statement);
  }
  return statements;
}
function subjectMatches(statement, expectedName, expectedDigest) {
  const subjects = Array.isArray(statement.subject) ? statement.subject : [];
  return subjects.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const subject = entry;
    const digest2 = subject.digest && typeof subject.digest === "object" ? subject.digest : {};
    const name = String(subject.name ?? "");
    return (name === expectedName || name.endsWith(`/${expectedName}`)) && digest2.sha256 === expectedDigest;
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
function verifyGitHubAttestation(reportPath, repository, trust = {}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("repository must be owner/name");
  const signerWorkflow = trust.signerWorkflow ?? `${repository}/.github/workflows/agent-vigil.yml`;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/i.test(signerWorkflow)) {
    throw new Error("signer workflow must be owner/name/.github/workflows/file.yml");
  }
  const command = [
    "attestation",
    "verify",
    resolve11(reportPath),
    "--repo",
    repository,
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
    raw = execFileSync9("gh", command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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

// src/cli.ts
function usage() {
  return `agent-vigil ${VERSION}

Usage:
  vigil <transcript.jsonl|summary.md> [options]
  vigil demo
  vigil init [--repo <path>] [--force] [--attest] [--portable --public-key <path>]
  vigil init --profile maintainer [--repo <path>] [--force] [--attest]
  vigil init --profile authority [--repo <path>] [--force] [--attest]
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
function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return void 0;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}
function runInit(args) {
  try {
    const repo = resolve12(optionValue(args, "--repo") ?? ".");
    const portable = args.includes("--portable");
    const attest = args.includes("--attest");
    const profile = optionValue(args, "--profile") ?? "default";
    if (!(/* @__PURE__ */ new Set(["default", "maintainer", "authority"])).has(profile)) throw new Error("init --profile must be default, maintainer, or authority");
    const publicKey = optionValue(args, "--public-key");
    if (portable && profile !== "default") throw new Error("init --portable cannot be combined with a named profile");
    if (portable && !publicKey) throw new Error("init --portable requires --public-key <Ed25519 public key>");
    if (!portable && publicKey) throw new Error("init --public-key is only valid with --portable");
    const result5 = initRepository(repo, args.includes("--force"), publicKey ? publicKeyId(resolve12(publicKey)) : void 0, profile, attest);
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
    const repo = resolve12(options.repo);
    const eventPath = resolve12(eventOption);
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
    if (policy.value.testCommand) {
      results.push(...checkTestsPass([{ kind: "tests_pass", quote: "base policy requires the candidate test suite to pass", subject: "fresh candidate test suite" }], repo, policy.value.testCommand));
      results.push(...checkWorkspaceMutation(repo, inputs, head));
    }
    const integrity = routeIntegrity(checkIntegrity(repo, base, head), policy.value.integrityMode ?? "advisory");
    results.push(...integrity.results);
    advisories.push(...integrity.advisories);
    const rawEvent = readFileSync14(eventPath);
    const eventHash = `sha256:${createHash12("sha256").update(rawEvent).digest("hex")}`;
    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative7(repo, policy.path) : void 0;
    const remote = git7(repo, ["config", "--get", "remote.origin.url"]);
    const tree = git7(repo, ["rev-parse", `${head}^{tree}`]);
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
function runDoctor(args) {
  try {
    const repo = resolve12(optionValue(args, "--repo") ?? ".");
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
    generateSigningKey(resolve12(privatePath), resolve12(publicPath));
    console.log(`Created Ed25519 private key ${privatePath} and public key ${publicPath}. Keep the private key out of Git.`);
    console.log(`Signer key ID: ${publicKeyId(resolve12(publicPath))}`);
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
    const absoluteReceipt = resolve12(options.repo, receiptPath);
    const receipt = JSON.parse(readFileSync14(absoluteReceipt, "utf8"));
    const report = buildPortableGateReport(receipt, {
      repo: resolve12(options.repo),
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
function runVerify(args) {
  try {
    const receiptPath = args.find((arg, index) => index > 0 && !arg.startsWith("--") && args[index - 1] !== "--public-key");
    if (!receiptPath) throw new Error("verify requires a receipt JSON path");
    const report = JSON.parse(readFileSync14(resolve12(receiptPath), "utf8"));
    if (report.schemaVersion !== "2") throw new Error(`unsupported receipt schema: ${String(report.schemaVersion)}`);
    const publicKey = optionValue(args, "--public-key");
    const result5 = verifyReport(report, publicKey ? resolve12(publicKey) : void 0);
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
  const positional = [];
  const values = /* @__PURE__ */ new Map();
  const flags = /* @__PURE__ */ new Set();
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
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
  return { positional, values, flags };
}
function runAttest(args) {
  try {
    const parsed = parseCommandArgs(args, /* @__PURE__ */ new Set(["--predicate-output"]));
    const predicateOutput = parsed.values.get("--predicate-output");
    if (parsed.positional.length !== 1 || !predicateOutput) throw new Error("attest requires <receipt.json> and --predicate-output <path>");
    const receiptPath = parsed.positional[0];
    const predicate = writeAttestationPredicate(resolve12(receiptPath), resolve12(predicateOutput));
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
    const repository = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    if (parsed.positional.length !== 1 || !repository) throw new Error("verify-attestation requires <receipt.json> and --repository <owner/name>");
    const receiptPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository}/.github/workflows/agent-vigil.yml`;
    const verification2 = verifyGitHubAttestation(resolve12(receiptPath), repository, { signerWorkflow, allowSelfHosted: parsed.flags.has("--allow-self-hosted") });
    const { report } = loadReceipt(resolve12(receiptPath));
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
function runNotary(args) {
  try {
    const values = /* @__PURE__ */ new Set(["--repository", "--head", "--policy-sha256", "--signer-workflow", "--output"]);
    const parsed = parseCommandArgs(args, values, /* @__PURE__ */ new Set(["--allow-self-hosted"]));
    const repository = parsed.values.get("--repository") ?? process.env.GITHUB_REPOSITORY;
    const head = parsed.values.get("--head");
    const policySha256 = parsed.values.get("--policy-sha256");
    if (parsed.positional.length !== 1 || !repository || !head || !policySha256) {
      throw new Error("notary requires <receipt.json>, --repository <owner/name>, --head <sha>, and --policy-sha256 <digest>");
    }
    const receiptPath = parsed.positional[0];
    const signerWorkflow = parsed.values.get("--signer-workflow") ?? `${repository}/.github/workflows/agent-vigil.yml`;
    const verification2 = verifyGitHubAttestation(resolve12(receiptPath), repository, { signerWorkflow, allowSelfHosted: parsed.flags.has("--allow-self-hosted") });
    const payload = buildNotaryCheck(resolve12(receiptPath), verification2, head, policySha256);
    const rendered = `${JSON.stringify(payload, null, 2)}
`;
    const output = parsed.values.get("--output");
    if (output) writePrivateFileAtomic(resolve12(output), rendered);
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
    const before = JSON.parse(readFileSync14(resolve12(values[0]), "utf8"));
    const after = JSON.parse(readFileSync14(resolve12(values[1]), "utf8"));
    if (before.schemaVersion !== "2" || after.schemaVersion !== "2") throw new Error("compare supports full receipt schema 2 only");
    const delta = compareReceipts(before, after);
    const rendered = format === "json" ? `${JSON.stringify(delta, null, 2)}
` : `${renderReceiptDelta(delta)}
`;
    const output = optionValue(args, "--output");
    if (output) writePrivateFileAtomic(resolve12(output), rendered);
    else process.stdout.write(rendered);
    return delta.status === "PASS" ? 0 : delta.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
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
  const positional = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!takesValue.has(arg)) throw new Error(`unknown value argument: ${arg}`);
    if (values.has(arg)) throw new Error(`duplicate value argument: ${arg}`);
    const value = args[++index];
    if (value === void 0 || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
  }
  if (positional.length !== 1) throw new Error("value requires exactly one full receipt JSON path");
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
    receipt: positional[0],
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
  const size = statSync7(path).size;
  if (size > maximumBytes) throw new Error(`${label} is ${size} bytes; maximum is ${maximumBytes}`);
  return readFileSync14(path);
}
function runValue(args) {
  try {
    const options = parseValueArgs(args);
    const receiptPath = resolve12(options.receipt);
    const rawReceipt = readBoundedFile(receiptPath, 16 * 1024 * 1024, "value receipt");
    const report = JSON.parse(rawReceipt.toString("utf8"));
    if (report.schemaVersion !== "2" || !report.summary || typeof report.receiptHash !== "string") {
      throw new Error("value requires a full Agent Vigil receipt schema 2");
    }
    const verification2 = verifyReport(report, options.publicKey ? resolve12(options.publicKey) : void 0);
    if (!verification2.hashValid) throw new Error("value receipt hash is invalid");
    if (verification2.signatureValid === false) throw new Error("value receipt signature is invalid");
    let transcriptPath;
    if (options.transcript) transcriptPath = resolve12(options.transcript);
    else if ((/* @__PURE__ */ new Set(["codex", "claude-code", "authority/codex", "authority/claude-code"])).has(report.transcriptFormat)) {
      const candidates = [
        resolve12(dirname4(receiptPath), report.transcript),
        ...isAbsolute4(report.repo) ? [resolve12(report.repo, report.transcript)] : []
      ];
      transcriptPath = candidates.find((candidate) => existsSync5(candidate));
    }
    let loaded;
    if (transcriptPath) {
      loaded = loadTranscript(transcriptPath);
      if (loaded.transcriptSha256 !== report.transcriptSha256) throw new Error("value transcript digest does not match the receipt");
    }
    const evidenceHash = (path, label) => {
      if (!path) return void 0;
      const evidence = readBoundedFile(resolve12(path), 64 * 1024 * 1024, label);
      return `sha256:${createHash12("sha256").update(evidence).digest("hex")}`;
    };
    const costEvidenceSha256 = evidenceHash(options.costEvidence, "cost evidence");
    const github = options.githubEvidence ? loadGitHubEvidence(resolve12(options.githubEvidence)) : void 0;
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
    if (options.output) writePrivateFileAtomic(resolve12(options.output), rendered);
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
    if (output) writePrivateFileAtomic(resolve12(output), rendered);
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
    if (output) writePrivateFileAtomic(resolve12(output), rendered);
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
    const absolute = resolve12(diffPath);
    const raw = readFileSync14(absolute);
    if (raw.byteLength > 64 * 1024 * 1024) throw new Error("audit input exceeds the 64 MiB limit");
    const diff = raw.toString("utf8");
    const digest2 = `sha256:${createHash12("sha256").update(raw).digest("hex")}`;
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
      transcript: relative7(process.cwd(), absolute) || absolute,
      transcriptSha256: digest2,
      transcriptFormat: "unified-git-diff",
      repo: "static-diff-audit",
      base: "unavailable",
      head: digest2,
      results: integrity.results,
      advisories: integrity.advisories,
      policy: { minVerified: 1, strict: true, source: options.strict ? "built-in strict static diff policy" : "built-in advisory static diff policy", sha256: `sha256:${createHash12("sha256").update(`agent-vigil-static-diff-v2:${options.strict ? "blocking" : "advisory"}`).digest("hex")}` },
      reproduction: `vigil audit ${shellQuote(diffPath)}${options.strict ? " --strict" : ""}`
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
        writePrivateFileAtomic(resolve12(output), rendered);
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
    const repo = resolve12(options.repo);
    if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) throw new Error(`invalid git range ${options.base}..${options.head}`);
    const base = resolveGitRef(repo, options.base);
    const head = resolveGitRef(repo, options.head);
    const transcriptPath = isAbsolute4(transcriptOption) ? transcriptOption : resolve12(repo, transcriptOption);
    if (!existsSync5(transcriptPath)) throw new Error(`transcript not found: ${transcriptPath}`);
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
    const remote = git7(repo, ["config", "--get", "remote.origin.url"]);
    const tree = git7(repo, ["rev-parse", `${head}^{tree}`]);
    const relativeTranscript = relative7(repo, transcriptPath) || transcriptOption;
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
    if (options.signingKey) report = signReport(report, resolve12(options.signingKey));
    writeOutputs(report, options);
    printReport(report, options);
    return report.summary.status === "PASS" ? 0 : report.summary.status === "FAIL" ? 1 : 2;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function git7(repo, args) {
  try {
    return execFileSync10("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function shellQuote(value) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function run(argv = process.argv.slice(2)) {
  if (argv[0] === "demo") return runDemo(run);
  if (argv[0] === "init") return runInit(argv);
  if (argv[0] === "doctor") return runDoctor(argv);
  if (argv[0] === "keygen") return runKeygen(argv);
  if (argv[0] === "verify") return runVerify(argv);
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
    console.log(usage());
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

${usage()}`);
    return 2;
  }
  const repo = resolve12(options.repo);
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
    console.error(usage());
    return 2;
  }
  const transcriptPath = isAbsolute4(transcript) ? transcript : resolve12(repo, transcript);
  const testCmd = options.testCmd ?? policy.value.testCommand;
  const strict = options.strict ?? policy.value.strict ?? false;
  const minVerified = options.minVerified ?? policy.value.minVerified ?? 1;
  if (!existsSync5(transcriptPath)) {
    console.error(`agent-vigil: transcript not found: ${transcriptPath}`);
    return 2;
  }
  if (!existsSync5(repo)) {
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
      ...options.signingKey ? [resolve12(options.signingKey)] : [],
      ...options.portableOutput ? [resolve12(repo, options.portableOutput)] : []
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
    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative7(repo, policy.path) : void 0;
    const remote = git7(repo, ["config", "--get", "remote.origin.url"]);
    const tree = head === "WORKTREE" ? void 0 : git7(repo, ["rev-parse", `${head}^{tree}`]);
    const relativeTranscript = relative7(repo, transcriptPath) || transcript;
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
    if (options.signingKey) report = signReport(report, resolve12(options.signingKey));
    writeOutputs(report, options);
    if (options.portableOutput) {
      const portable = createPortableReceipt(report, resolve12(options.signingKey));
      const portablePath = resolve12(repo, options.portableOutput);
      mkdirSync4(dirname4(portablePath), { recursive: true });
      writeFileSync5(portablePath, `${JSON.stringify(portable, null, 2)}
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
    return realpathSync3(process.argv[1]) === realpathSync3(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) process.exit(run());
export {
  run
};
