import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Claim } from "./report.ts";
import { readRegularUtf8 } from "./safe-fs.ts";

export type TranscriptFormat =
  | "claude-code"
  | "codex"
  | "cursor"
  | "gemini-cli"
  | "github-copilot-cli"
  | "opencode"
  | "aider"
  | "markdown";

export type SessionToolCall = {
  id: string;
  name: string;
  input: string;
  output?: string;
  isError?: boolean;
  timestamp?: string | number;
  sequence: number;
};

export type SessionUsage = {
  source: "transcript-observed";
  accounting: "deduplicated-assistant-messages" | "cumulative-session-snapshot";
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  modelIds: string[];
  recordsObserved: number;
  accountedUnits: number;
};

export type LoadedTranscript = {
  narrative: string;
  assistantMessages: string[];
  toolCalls: SessionToolCall[];
  format: TranscriptFormat;
  transcriptSha256: string;
  usage?: SessionUsage;
};

export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

function readBounded(path: string): string {
  return readRegularUtf8(path, MAX_TRANSCRIPT_BYTES, "transcript");
}

function safeJson(text: string): any | undefined {
  try { return JSON.parse(text); } catch { return undefined; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function serialiseToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? ""); }
  catch { return String(value ?? ""); }
}

function isoTimestamp(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const date = new Date(value as string | number);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function toolOutputFailed(output: string): boolean {
  const parsed = safeJson(output);
  if (parsed && typeof parsed === "object") {
    const row = parsed as Record<string, unknown>;
    if (row.isError === true || row.is_error === true) return true;
    for (const key of ["exit_code", "exitCode", "statusCode"]) {
      if (typeof row[key] === "number" && row[key] !== 0) return true;
    }
  }
  return /(?:"?isError"?\s*:\s*true|"?is_error"?\s*:\s*true|script error|exit[_ ]?code"?\s*[:=]\s*[1-9]\d*|exited with (?:code|status)\s*[1-9]\d*|terminated by signal\b|command (?:failed|timed out)\b)/i.test(output);
}

function textFromBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (typeof block === "string") out.push(block);
    else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if ((b.type === "text" || b.type === "output_text" || b.type === "input_text") && typeof b.text === "string") {
        out.push(b.text);
      }
    }
  }
  return out;
}

function tokenCounter(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`invalid token usage counter ${field}`);
  }
  return value as number;
}

function tokenSum(values: number[], field: string): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) throw new Error(`invalid token usage aggregate ${field}`);
  return total;
}

type UsageCounters = Omit<SessionUsage, "source" | "accounting" | "modelIds" | "recordsObserved" | "accountedUnits">;

function usageCounters(value: Record<string, unknown>): UsageCounters {
  const recognizedFields = [
    "input_tokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cache_write_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ];
  if (!recognizedFields.some((field) => Object.prototype.hasOwnProperty.call(value, field))) {
    throw new Error("token usage record contains no recognized counters");
  }
  const inputTokens = tokenCounter(value.input_tokens, "input_tokens");
  const cachedInputTokensPrimary = tokenCounter(value.cached_input_tokens, "cached_input_tokens");
  const cachedInputTokensAlias = tokenCounter(value.cache_read_input_tokens, "cache_read_input_tokens");
  const cachedInputTokens = value.cached_input_tokens === undefined
    ? cachedInputTokensAlias
    : cachedInputTokensPrimary;
  const cacheWriteInputTokensPrimary = tokenCounter(value.cache_write_input_tokens, "cache_write_input_tokens");
  const cacheWriteInputTokensAlias = tokenCounter(value.cache_creation_input_tokens, "cache_creation_input_tokens");
  const cacheWriteInputTokens = value.cache_write_input_tokens === undefined
    ? cacheWriteInputTokensAlias
    : cacheWriteInputTokensPrimary;
  const outputTokens = tokenCounter(value.output_tokens, "output_tokens");
  const reasoningOutputTokens = tokenCounter(value.reasoning_output_tokens, "reasoning_output_tokens");
  const reportedTotal = tokenCounter(value.total_tokens, "total_tokens");
  const calculatedTotal = tokenSum(
    [inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens],
    "total_tokens",
  );
  return {
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens: reportedTotal || calculatedTotal,
  };
}

function maxUsage(left: UsageCounters | undefined, right: UsageCounters): UsageCounters {
  if (!left) return right;
  return {
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteInputTokens: Math.max(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: Math.max(left.reasoningOutputTokens, right.reasoningOutputTokens),
    totalTokens: Math.max(left.totalTokens, right.totalTokens),
  };
}

function parseClaude(rows: any[], transcriptSha256: string): LoadedTranscript {
  const messages: string[] = [];
  const toolCalls: SessionToolCall[] = [];
  const byId = new Map<string, SessionToolCall>();
  const usageByMessage = new Map<string, UsageCounters>();
  const models = new Set<string>();
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
          const call: SessionToolCall = {
            id: String(block.id ?? `claude-${sequence}`),
            name: String(block.name ?? "unknown"),
            input: JSON.stringify(block.input ?? {}),
            timestamp: row.timestamp,
            sequence: sequence++,
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
  const usage = [...usageByMessage.values()].reduce<UsageCounters>((total, item) => ({
    inputTokens: tokenSum([total.inputTokens, item.inputTokens], "input_tokens"),
    cachedInputTokens: tokenSum([total.cachedInputTokens, item.cachedInputTokens], "cached_input_tokens"),
    cacheWriteInputTokens: tokenSum([total.cacheWriteInputTokens, item.cacheWriteInputTokens], "cache_write_input_tokens"),
    outputTokens: tokenSum([total.outputTokens, item.outputTokens], "output_tokens"),
    reasoningOutputTokens: tokenSum([total.reasoningOutputTokens, item.reasoningOutputTokens], "reasoning_output_tokens"),
    totalTokens: tokenSum([total.totalTokens, item.totalTokens], "total_tokens"),
  }), { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 });
  return {
    narrative: messages.slice(-8).join("\n\n"),
    assistantMessages: messages,
    toolCalls,
    format: "claude-code",
    transcriptSha256,
    ...(usageByMessage.size ? { usage: {
      source: "transcript-observed" as const,
      accounting: "deduplicated-assistant-messages" as const,
      ...usage,
      modelIds: [...models].sort(),
      recordsObserved: usageRecords,
      accountedUnits: usageByMessage.size,
    } } : {}),
  };
}

function parseCodex(rows: any[], transcriptSha256: string): LoadedTranscript {
  const messages: string[] = [];
  const toolCalls: SessionToolCall[] = [];
  const byId = new Map<string, SessionToolCall>();
  const models = new Set<string>();
  let cumulativeUsage: UsageCounters | undefined;
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
      const call: SessionToolCall = {
        id,
        name: String(payload.name ?? payload.namespace ?? "unknown"),
        input: serialiseToolValue(payload.input ?? payload.arguments ?? ""),
        timestamp: row.timestamp,
        sequence: sequence++,
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
    ...(cumulativeUsage ? { usage: {
      source: "transcript-observed" as const,
      accounting: "cumulative-session-snapshot" as const,
      ...cumulativeUsage,
      modelIds: [...models].sort(),
      recordsObserved: usageRecords,
      accountedUnits: 1,
    } } : {}),
  };
}

function parseCursor(rows: any[], transcriptSha256: string): LoadedTranscript {
  const messages: string[] = [];
  const toolCalls: SessionToolCall[] = [];
  const byId = new Map<string, SessionToolCall>();
  let sequence = 0;
  for (const row of rows) {
    if (row?.type === "assistant") messages.push(...textFromBlocks(row?.message?.content));
    if (row?.type === "result" && typeof row.result === "string" && !messages.length) messages.push(row.result);
    if (row?.type !== "tool_call" || !row.tool_call || typeof row.tool_call !== "object") continue;
    const entry = Object.entries(row.tool_call as Record<string, unknown>)[0];
    if (!entry) continue;
    const [name, payloadValue] = entry;
    const payload = payloadValue && typeof payloadValue === "object" ? payloadValue as Record<string, unknown> : {};
    const explicitId = row.call_id ?? payload.toolCallId;
    const id = explicitId === undefined || explicitId === null ? undefined : String(explicitId);
    if (row.subtype === "started") {
      const call: SessionToolCall = {
        id: id ?? `cursor-${sequence}`,
        name: name.replace(/ToolCall$/, ""),
        input: serialiseToolValue(payload.args ?? {}),
        timestamp: row.timestamp,
        sequence: sequence++,
      };
      toolCalls.push(call);
      byId.set(call.id, call);
    } else if (row.subtype === "completed") {
      const expectedName = name.replace(/ToolCall$/, "");
      const call = id !== undefined
        ? byId.get(id)
        : [...toolCalls].reverse().find((candidate) => candidate.name === expectedName && candidate.output === undefined);
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
    transcriptSha256,
  };
}

function parseGemini(rows: any[], transcriptSha256: string): LoadedTranscript {
  const messages: string[] = [];
  const toolCalls: SessionToolCall[] = [];
  const byId = new Map<string, SessionToolCall>();
  let sequence = 0;
  for (const row of rows) {
    if (row?.type === "message" && row.role === "assistant" && typeof row.content === "string") messages.push(row.content);
    if (row?.type === "tool_use") {
      const id = String(row.tool_id ?? `gemini-${sequence}`);
      const call: SessionToolCall = {
        id,
        name: String(row.tool_name ?? "unknown"),
        input: serialiseToolValue(row.parameters ?? {}),
        timestamp: row.timestamp,
        sequence: sequence++,
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
    transcriptSha256,
  };
}

function parseCopilot(rows: any[], transcriptSha256: string): LoadedTranscript {
  const messages: string[] = [];
  const toolCalls: SessionToolCall[] = [];
  const byId = new Map<string, SessionToolCall>();
  let sequence = 0;
  for (const row of rows) {
    const data = row?.data ?? {};
    if (row?.type === "assistant.message" && typeof data.content === "string") messages.push(data.content);
    if (row?.type === "tool.execution_start") {
      const id = String(data.toolCallId ?? `copilot-${sequence}`);
      const call: SessionToolCall = {
        id,
        name: String(data.toolName ?? "unknown"),
        input: serialiseToolValue(data.arguments ?? {}),
        timestamp: row.timestamp,
        sequence: sequence++,
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
    transcriptSha256,
  };
}

function parseOpenCode(data: any, transcriptSha256: string): LoadedTranscript {
  const messages: string[] = [];
  const toolCalls: SessionToolCall[] = [];
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
        output: state.output === undefined ? undefined : serialiseToolValue(state.output),
        isError: state.status === "error",
        timestamp: isoTimestamp(part.time?.start),
        sequence: sequence++,
      });
    }
  }
  return {
    narrative: messages.slice(-8).join("\n\n"),
    assistantMessages: messages,
    toolCalls,
    format: "opencode",
    transcriptSha256,
  };
}

export function parseTranscript(raw: string, path = "transcript.jsonl"): LoadedTranscript {
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
  const records = raw.replace(/^\uFEFF/, "").split("\n")
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim());
  const rows = records.map(({ line, lineNumber }) => {
    const row = safeJson(line);
    if (!row) throw new Error(`invalid JSONL at line ${lineNumber}`);
    return row;
  });
  if (!rows.length) throw new Error("JSONL transcript contains no records");
  const cursorTypes = new Set(["system", "user", "assistant", "tool_call", "result"]);
  const geminiTypes = new Set(["init", "message", "tool_use", "tool_result", "error", "result"]);
  const codexTypes = new Set(["session_meta", "turn_context", "event_msg", "response_item"]);
  const claudeTypes = new Set(["assistant", "user", "system", "summary", "progress", "file-history-snapshot", "queue-operation"]);
  const copilotType = (type: unknown) => typeof type === "string" && /^(?:assistant|tool|session|user|permission|subagent|skill)\./.test(type);
  const hasCursorMarker = rows.some((row) => row?.type === "tool_call")
    || (rows.some((row) => row?.type === "system" && row?.subtype === "init")
      && rows.some((row) => row?.type === "result" && typeof row?.subtype === "string"));
  const hasGeminiMarker = rows.some((row) => row?.type === "init" || row?.type === "tool_use" || row?.type === "tool_result");
  const hasCopilotMarker = rows.some((row) => row?.type === "assistant.message" || row?.type === "tool.execution_start");
  const hasCodexMarker = rows.some((row) => row?.type === "session_meta" || row?.type === "response_item");
  const hasClaudeMarker = rows.some((row) => row?.type === "assistant" && Array.isArray(row?.message?.content));
  const format: TranscriptFormat | undefined = hasGeminiMarker ? "gemini-cli"
      : hasCopilotMarker ? "github-copilot-cli"
        : hasCodexMarker ? "codex"
          : hasCursorMarker ? "cursor"
            : hasClaudeMarker ? "claude-code"
              : undefined;
  if (!format) throw new Error("unrecognized JSONL transcript schema");
  const accepted = format === "cursor" ? (type: unknown) => cursorTypes.has(String(type))
    : format === "gemini-cli" ? (type: unknown) => geminiTypes.has(String(type))
      : format === "github-copilot-cli" ? copilotType
        : format === "codex" ? (type: unknown) => codexTypes.has(String(type))
          : (type: unknown) => claudeTypes.has(String(type));
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

export function loadTranscript(path: string): LoadedTranscript {
  return parseTranscript(readBounded(path), path);
}

const PATH_EXISTS_RES = [
  /\b(?:file|path|artifact|report|output|receipt)\s+(?:(?:exists?|is)\s+)?(?:at\s+)?[`"']?((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,11})[`"']?/gi,
  /[`"']((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,11})[`"']\s+(?:exists?|is\s+present)\b/gi,
];
const TESTS_PASS_RE = /\b(?:all\s+)?(\d+)?\s*tests?\s+(?:are\s+|now\s+)?(?:pass(?:ing|ed)?|green)\b|\btest\s+suite\s+passes\b/gi;
const FILE_CHANGED_RE = /\b(?:updated|edited|modified|created|added|wrote|refactored|fixed|implemented(?:\s+in)?)\s+(?:the\s+)?[`"']?((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z][A-Za-z0-9]{0,11})[`"']?/gi;
const DONE_RE = /\b(?:done|complete[d]?|finished|fully\s+implemented|ready\s+to\s+merge|all\s+set)\b/i;

export function extractClaims(narrative: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const push = (claim: Claim) => {
    const key = `${claim.kind}:${claim.subject}`;
    if (!seen.has(key)) { seen.add(key); claims.push(claim); }
  };
  for (const match of narrative.matchAll(TESTS_PASS_RE)) {
    const expectedCount = match[1] ? Number(match[1]) : undefined;
    push({
      kind: "tests_pass",
      quote: snippet(narrative, match.index ?? 0),
      subject: expectedCount ? `${expectedCount} tests` : "test suite",
      ...(expectedCount !== undefined ? { expectedCount } : {}),
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

export function extractRunClaims(narrative: string): Claim[] {
  const out: Claim[] = [];
  const re = /\b(?:I\s+)?(?:ran|executed|invoked|launched)\s+(?:the\s+)?[`"']?([\w./:-]+(?:\s+(?!and\b|then\b|the\b|to\b|it\b|so\b|which\b)[\w./:-]+){0,3})[`"']?/gi;
  for (const match of narrative.matchAll(re)) {
    const subject = match[1].trim().replace(/[.,;:!?]+$/, "");
    if (subject && !/^(it|them|this|that|a|an|into|out)$/i.test(subject)) {
      out.push({ kind: "command_ran", quote: snippet(narrative, match.index ?? 0), subject });
    }
  }
  return out;
}

export function toolCallFingerprint(call: SessionToolCall): string {
  const parsed = safeJson(call.input);
  const normalized = parsed === undefined ? call.input.trim().replace(/\s+/g, " ") : canonicalJson(parsed);
  return `${call.name.toLowerCase()}:${createHash("sha256").update(normalized).digest("hex")}`;
}

function snippet(text: string, at: number): string {
  return text.slice(Math.max(0, at - 45), at + 100).replace(/\s+/g, " ").trim();
}
