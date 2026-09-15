import { parse, type AnyNode } from "acorn";
import * as nodeModule from "node:module";
import type { CheckResult } from "../report.ts";

type Range = { start: number; end: number };
export type FileCodeContext = { ranges: Range[]; lines: string[]; starts: number[] };
export type AddedCodeContext = { ranges: Range[]; offsets: number[] };
type Patch = { path: string; added: string[]; codeContext?: AddedCodeContext };
export type TestPatternMatch = { quoted: boolean; line: number; text: string };

// These ranges establish syntax, not data flow. Even a comment can be read
// back as source. No range from this module grants a PASS or an exemption.
export function readFileCodeContext(path: string, source: string): FileCodeContext | undefined {
  if (!/\.(?:[cm]?[jt]s|md|txt)$/i.test(path) || !source || Buffer.byteLength(source, "utf8") > 1024 * 1024 || /[\0\ufffd]/u.test(source)
    || /\.[jt]sx$/i.test(path)) return undefined;
  let parsedSource = source;
  function parseStrict(): { tree: AnyNode; comments: Range[] } | undefined {
    for (const sourceType of ["module", "script"] as const) {
      const comments: Range[] = [];
      try {
        const tree = parse(parsedSource, {
          ecmaVersion: "latest", sourceType,
          allowReturnOutsideFunction: sourceType === "script",
          onComment: (_block, _text, start, end) => comments.push({ start, end }),
        });
        return { tree, comments };
      } catch { /* A failed parse never supplies ranges. */ }
    }
    return undefined;
  }
  let parsed = parseStrict();
  if (!parsed && /\.[cm]?ts$/i.test(path)) {
    const strip = (nodeModule as unknown as {
      stripTypeScriptTypes?: (text: string, options: { mode: "strip" }) => string;
    }).stripTypeScriptTypes;
    if (typeof strip === "function") {
      try { parsedSource = strip(source, { mode: "strip" }); parsed = parseStrict(); }
      catch { /* Unsupported syntax retains the ordinary textual finding. */ }
    }
  }
  const ranges: Range[] = [];
  if (parsed) {
    ranges.push(...parsed.comments);
    const stack: AnyNode[] = [parsed.tree];
    let visited = 0;
    while (stack.length) {
      if (++visited > 200_000) return undefined;
      const node = stack.pop()!;
      if ((node.type === "Literal" && (typeof node.value === "string" || node.regex))
        || node.type === "TemplateElement") ranges.push({ start: node.start, end: node.end });
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child && typeof child.type === "string") stack.push(child);
        } else if (value && typeof value === "object" && "type" in value && typeof value.type === "string") {
          stack.push(value as AnyNode);
        }
      }
    }
    // Native type stripping currently preserves UTF-16 positions. Validate
    // each retained span instead of relying on that implementation detail.
    if (parsedSource.length !== source.length
      || ranges.some(({ start, end }) => source.slice(start, end) !== parsedSource.slice(start, end))) return undefined;
  } else if (/\.md$/i.test(path) && /^#{1,6} /m.test(source)) {
    // Only single-line, single-backtick examples in headed Markdown. Fences,
    // indented code and HTML are deliberately not assigned prose context.
    let offset = 0;
    let fence: { character: string; length: number } | undefined;
    for (const line of source.split("\n")) {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && /^[ \t\r]*$/.test(marker[2])) fence = undefined;
      } else if (marker) {
        fence = { character: marker[1][0], length: marker[1].length };
      } else if (/<!--|<\/?[A-Za-z][^>]*>/.test(line)) {
        return undefined;
      } else if (!/^(?: {4}|\t)/.test(line) && !/[<>]/.test(line) && !/``/.test(line)) {
        for (const match of line.matchAll(/`[^`\r\n]+`/g)) ranges.push({ start: offset + match.index, end: offset + match.index + match[0].length });
      }
      offset += line.length + 1;
    }
  } else return undefined;
  const lines = source.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  ranges.sort((a, b) => a.start - b.start);
  return { ranges, lines, starts };
}

export function bindAddedCodeContext(context: FileCodeContext | undefined, added: string[], numbers?: number[]): AddedCodeContext | undefined {
  if (!context || !numbers || numbers.length !== added.length) return undefined;
  const offsets: number[] = [];
  for (let index = 0; index < added.length; index++) {
    const line = numbers[index];
    if (!Number.isSafeInteger(line) || line < 1 || (index > 0 && line <= numbers[index - 1])
      || context.lines[line - 1] !== added[index]) return undefined;
    offsets.push(context.starts[line - 1]);
  }
  return { ranges: context.ranges, offsets };
}

/** Retain both a direct finding and quoted uncertainty; neither cancels the other. */
export function findTestCodeMatches(patch: Patch, patterns: RegExp[], triggerOnly = false): TestPatternMatch[] {
  const entries = patch.added.flatMap((text, index) => text.includes("vigil:detector-pattern") ? [] : [{ text, index }]);
  const lines = entries.map(({ text }) => text);
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const added = lines.join("\n");
  function location(position: number): { line: number; column: number } | undefined {
    let low = 0, high = starts.length - 1;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= position) low = mid + 1; else high = mid - 1;
    }
    if (high < 0 || position >= starts[high] + lines[high].length) return undefined;
    return { line: high, column: position - starts[high] };
  }
  let quoted: TestPatternMatch | undefined;
  let direct: TestPatternMatch | undefined;
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "") + "g");
    let match: RegExpExecArray | null;
    while ((match = regex.exec(added)) !== null) {
      if (triggerOnly || !match[0].length) regex.lastIndex = match.index + Math.max(1, /^\w+/.exec(match[0])?.[0].length ?? 1);
      const first = location(match.index);
      // Branch rules use the trigger token, not a greedy match that can reach
      // out of a quoted example into a later, genuine assertion.
      const last = location(match.index + (triggerOnly ? /^\w+/.exec(match[0])?.[0].length ?? match[0].length : match[0].length) - 1);
      let inQuotedText = false;
      const context = patch.codeContext;
      if (context && first && last) {
        const start = context.offsets[entries[first.line].index] + first.column;
        const end = context.offsets[entries[last.line].index] + last.column + 1;
        let low = 0, high = context.ranges.length - 1;
        while (low <= high) {
          const mid = (low + high) >>> 1;
          if (context.ranges[mid].start <= start) low = mid + 1; else high = mid - 1;
        }
        inQuotedText = high >= 0 && context.ranges[high].end >= end;
      }
      const result = { quoted: inQuotedText, line: first ? entries[first.line].index + 1 : 1, text: match[0] };
      if (!inQuotedText) direct ??= result;
      else quoted ??= result;
      if (direct && quoted) return [direct, quoted];
    }
  }
  return [direct, quoted].filter((value): value is TestPatternMatch => value !== undefined);
}

export function matchTestCode(patch: Patch, patterns: RegExp[], triggerOnly = false): TestPatternMatch | undefined {
  return findTestCodeMatches(patch, patterns, triggerOnly)[0];
}

export function uncheckedTestCode(path: string, ruleId: string): CheckResult {
  return {
    claim: { kind: "integrity", quote: "exact-file test-code context check", subject: "quoted test code needs an execution check" },
    verdict: "unverifiable", ruleId: "test-code-context-unchecked", contributesToPass: false, blocksPass: true,
    evidence: `${path}: ${ruleId} matched quoted text or a comment, not a direct operation at that location. The text may still be executed by a helper or generated file. Check that execution path before clearing this hold; this is not proof that a test was weakened or that the change is safe.`,
  };
}
