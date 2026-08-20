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
        input: String(payload.input ?? payload.arguments ?? ""),
        timestamp: row.timestamp,
        sequence: sequence++,
      };
      toolCalls.push(call);
      byId.set(id, call);
    }
    if (payload.type === "custom_tool_call_output" || payload.type === "function_call_output") {
      const call = byId.get(String(payload.call_id ?? ""));
      if (!call) continue;
      call.output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
      call.isError = /(?:"isError"\s*:\s*true|script error|exit_code"?\s*:\s*[1-9])/i.test(call.output ?? "");
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
  const rows = raw.split("\n").filter(Boolean).map(safeJson).filter(Boolean);
  const looksCodex = rows.some((row) => row?.type === "response_item" || row?.type === "session_meta");
  return looksCodex ? parseCodex(rows, transcriptSha256) : parseClaude(rows, transcriptSha256);
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
    const subject = match[1].trim();
    if (subject && !/^(it|them|this|that|a|an|into|out)$/i.test(subject)) {
      out.push({ kind: "command_ran", quote: snippet(narrative, match.index ?? 0), subject });
    }
  }
  return out;
}

export function toolCallFingerprint(call: SessionToolCall): string {
  return `${call.name}:${createHash("sha256").update(call.input).digest("hex")}`;
}

function snippet(text: string, at: number): string {
  return text.slice(Math.max(0, at - 45), at + 100).replace(/\s+/g, " ").trim();
}
