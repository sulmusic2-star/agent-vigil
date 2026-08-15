// Parse an agent session transcript into (a) the agent's final narrative and
// (b) the concrete claims it makes. v1 supports Claude Code session JSONL
// (~/.claude/projects/<proj>/<session>.jsonl) and plain-text/markdown summaries
// (any agent). Codex/other JSONL shapes: adapters welcome — this boundary is
// deliberately small.

import { readFileSync } from "node:fs";
import type { Claim } from "./report.ts";

/** Extract all assistant text from a Claude Code session JSONL, in order. */
export function assistantTextFromClaudeJsonl(path: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // tolerate partial/corrupt lines — sessions get truncated
    }
    const msg = row?.message;
    if (row?.type !== "assistant" || !msg?.content) continue;
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === "text" && typeof block.text === "string") {
        out.push(block.text);
      }
    }
  }
  return out;
}

export function loadNarrative(path: string): string {
  if (path.endsWith(".jsonl")) {
    const texts = assistantTextFromClaudeJsonl(path);
    // The trailing messages carry the session's conclusions; keep the last few
    // so early exploratory chatter doesn't drown the claims that matter.
    return texts.slice(-8).join("\n\n");
  }
  return readFileSync(path, "utf8");
}

// --- claim extraction (deterministic, pattern-based, over-inclusive by design:
// a false "unverifiable" is cheap; a missed contradiction is not) ---

const PATH_RE =
  /(?:^|[\s`("'])((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z]{1,8})(?=$|[\s`)"':,.])/gm;

const TESTS_PASS_RE =
  /\b(?:all\s+)?(\d+)?\s*tests?\s+(?:are\s+|now\s+)?(?:pass(?:ing|ed)?|green)\b|\btest\s+suite\s+passes\b/gi;

const FILE_CHANGED_RE =
  /\b(?:updated|edited|modified|created|added|wrote|refactored|fixed|implemented(?:\s+in)?)\s+(?:the\s+)?[`"']?((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z]{1,8})[`"']?/gi;

const DONE_RE =
  /\b(?:done|complete[d]?|finished|fully\s+implemented|ready\s+to\s+merge|all\s+set)\b/i;

export function extractClaims(narrative: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const push = (c: Claim) => {
    const k = `${c.kind}:${c.subject}`;
    if (!seen.has(k)) {
      seen.add(k);
      claims.push(c);
    }
  };

  for (const m of narrative.matchAll(TESTS_PASS_RE)) {
    push({
      kind: "tests_pass",
      quote: snippet(narrative, m.index ?? 0),
      subject: m[1] ? `${m[1]} tests` : "tests",
    });
  }
  for (const m of narrative.matchAll(FILE_CHANGED_RE)) {
    push({
      kind: "file_changed",
      quote: snippet(narrative, m.index ?? 0),
      subject: m[1],
    });
  }
  for (const m of narrative.matchAll(PATH_RE)) {
    push({
      kind: "path_exists",
      quote: snippet(narrative, m.index ?? 0),
      subject: m[1],
    });
  }
  if (DONE_RE.test(narrative)) {
    const m = narrative.match(DONE_RE)!;
    push({
      kind: "work_complete",
      quote: snippet(narrative, m.index ?? 0),
      subject: "completion claim",
    });
  }
  return claims;
}

function snippet(text: string, at: number): string {
  const start = Math.max(0, at - 40);
  return text
    .slice(start, at + 80)
    .replace(/\s+/g, " ")
    .trim();
}

/** Tool calls (name + input hash) in order, from a Claude Code session JSONL. */
export function toolCallsFromClaudeJsonl(path: string): string[] {
  const calls: string[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== "assistant" || !row?.message?.content) continue;
    for (const block of Array.isArray(row.message.content) ? row.message.content : []) {
      if (block?.type === "tool_use") {
        calls.push(`${block.name}:${JSON.stringify(block.input ?? {}).slice(0, 300)}`);
      }
    }
  }
  return calls;
}
