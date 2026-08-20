import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Claim } from "./report.ts";

export type TranscriptFormat = "claude-code" | "codex" | "markdown";

export type SessionToolCall = {
  id: string;
  name: string;
  input: string;
  output?: string;
  isError?: boolean;
  timestamp?: string;
  sequence: number;
};

export type LoadedTranscript = {
  narrative: string;
  assistantMessages: string[];
  toolCalls: SessionToolCall[];
  format: TranscriptFormat;
  transcriptSha256: string;
};

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

function readBounded(path: string): string {
  const size = statSync(path).size;
  if (size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(`transcript is ${size} bytes; maximum is ${MAX_TRANSCRIPT_BYTES}`);
  }
  return readFileSync(path, "utf8");
}

function safeJson(text: string): any | undefined {
  try { return JSON.parse(text); } catch { return undefined; }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
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

function parseClaude(rows: any[], transcriptSha256: string): LoadedTranscript {
  const messages: string[] = [];
  const toolCalls: SessionToolCall[] = [];
  const byId = new Map<string, SessionToolCall>();
  let sequence = 0;

  for (const row of rows) {
    const msg = row?.message;
    if (row?.type === "assistant" && Array.isArray(msg?.content)) {
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
  return {
    narrative: messages.slice(-8).join("\n\n"),
    assistantMessages: messages,
    toolCalls,
    format: "claude-code",
    transcriptSha256,
  };
}

function parseCodex(rows: any[], transcriptSha256: string): LoadedTranscript {
  const messages: string[] = [];
  const toolCalls: SessionToolCall[] = [];
  const byId = new Map<string, SessionToolCall>();
  let sequence = 0;

  for (const row of rows) {
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
  };
}

export function loadTranscript(path: string): LoadedTranscript {
  const raw = readBounded(path);
  const transcriptSha256 = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  if (!path.endsWith(".jsonl")) {
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
  const codexTypes = new Set(["session_meta", "turn_context", "event_msg", "response_item"]);
  const claudeTypes = new Set(["assistant", "user", "system", "summary", "progress", "file-history-snapshot", "queue-operation"]);
  const firstKnown = rows.findIndex((row) => codexTypes.has(row?.type) || claudeTypes.has(row?.type));
  if (firstKnown === -1) throw new Error("unrecognized JSONL transcript schema");
  const format = codexTypes.has(rows[firstKnown]?.type) ? "codex" : "claude-code";
  const accepted = format === "codex" ? codexTypes : claudeTypes;
  rows.forEach((row, index) => {
    if (accepted.has(row?.type)) return;
    const recordType = typeof row?.type === "string" ? ` record type ${JSON.stringify(row.type)}` : " record without a type";
    throw new Error(`${format} JSONL contains unsupported${recordType} at line ${records[index].lineNumber}`);
  });
  return format === "codex" ? parseCodex(rows, transcriptSha256) : parseClaude(rows, transcriptSha256);
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
      expectedCount,
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
