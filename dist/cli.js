#!/usr/bin/env node

// src/cli.ts
import { execFileSync as execFileSync6 } from "node:child_process";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync7, realpathSync as realpathSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname2, isAbsolute as isAbsolute3, relative as relative4, resolve as resolve5 } from "node:path";
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
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
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
function parseClaude(rows, transcriptSha256) {
  const messages = [];
  const toolCalls = [];
  const byId = /* @__PURE__ */ new Map();
  let sequence = 0;
  for (const row of rows) {
    const msg = row?.message;
    if (row?.type === "assistant" && Array.isArray(msg?.content)) {
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
  return {
    narrative: messages.slice(-8).join("\n\n"),
    assistantMessages: messages,
    toolCalls,
    format: "claude-code",
    transcriptSha256
  };
}
function parseCodex(rows, transcriptSha256) {
  const messages = [];
  const toolCalls = [];
  const byId = /* @__PURE__ */ new Map();
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
    transcriptSha256
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
function checkWorkspaceMutation(repo, ignoredPaths = []) {
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
  return /(^|\/)(test|tests|__tests__)(\/|$)|(?:\.test|\.spec|_test)\.[^.]+$/i.test(path);
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
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const marker = line.slice(4).trim();
      const path = marker === "/dev/null" ? "" : marker.replace(/^b\//, "");
      current = { path, added: [], removed: [] };
      patches.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
    if (line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
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
      patches.push({ path, added: content.toString("utf8").split("\n"), removed: [] });
    } catch {
    }
  }
  return patches;
}
function countTests(content) {
  const patterns = [
    /\b(?:it|test|describe)\s*\(/g,
    /^\s*def\s+test_[A-Za-z0-9_]+\s*\(/gm,
    /^\s*#\[test\]/gm,
    /^\s*func\s+Test[A-Za-z0-9_]+\s*\(/gm
  ];
  return patterns.reduce((sum, regex) => sum + [...content.matchAll(regex)].length, 0);
}
function checkIntegrity(repo, base, head) {
  const paths = [...changedPaths(repo, base, head)];
  const diffRange = head === "WORKTREE" ? [base] : [base, head];
  const diff = git(repo, ["diff", "--unified=0", "--no-color", ...diffRange]);
  const results = [];
  const finding = (subject, evidence, ruleId) => ({
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
    results.push(finding("test surface shrank", `recognized test definitions across changed test files fell from ${baselineTests} to ${headTests}`, "test-count-drop"));
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
  const checks = [
    ["focused or skipped test introduced", /\b(?:test|it|describe)\.(?:skip|only)\s*\(|\b(?:xit|xdescribe)\s*\(|@pytest\.mark\.skip|#\[ignore\]/i, "test-skip-added", (patch) => isTestPath(patch.path)],
    // vigil:detector-pattern
    ["verification bypass introduced", /--no-verify|\|\|\s*true\b|passWithNoTests|allowEmptyTests/i, "verification-bypass", (patch) => !isDocumentationPath(patch.path)],
    // vigil:detector-pattern
    ["compiler or linter suppression introduced", /@ts-nocheck|@ts-ignore|eslint-disable|type:\s*ignore|noqa\b/i, "suppression-added", (patch) => !isDocumentationPath(patch.path)],
    // vigil:detector-pattern
    ["coverage gate weakened", /coverageThreshold\s*[:=]\s*0|--fail-under[=\s]+0|minimum_coverage\s*[:=]\s*0/i, "coverage-weakened", (patch) => !isDocumentationPath(patch.path)]
    // vigil:detector-pattern
  ];
  for (const [subject, regex, ruleId, inScope] of checks) {
    const line = patches.filter(inScope).flatMap((patch) => patch.added).find((candidate) => !candidate.includes("vigil:detector-pattern") && regex.test(candidate));
    if (line) results.push(finding(subject, line.slice(1).trim().slice(0, 220), ruleId));
  }
  const testPatches = patches.filter((patch) => isTestPath(patch.path));
  const removedAssertions = testPatches.flatMap((patch) => patch.removed).filter((line) => /\b(?:expect|assert|should)\b/i.test(line)).length;
  const addedAssertions = testPatches.flatMap((patch) => patch.added).filter((line) => !line.includes("vigil:detector-pattern") && /\b(?:expect|assert|should)\b/i.test(line)).length;
  if (removedAssertions > addedAssertions) {
    results.push(finding(
      "assertion surface shrank",
      `${removedAssertions} assertion-like lines removed and ${addedAssertions} added`,
      "assertion-drop"
    ));
  }
  if (!results.length) {
    results.push({
      claim: { kind: "integrity", quote: "automatic anti-reward-hacking check", subject: "no obvious verification weakening" },
      verdict: "verified",
      evidence: `${paths.length} changed paths checked for deleted tests, count drops, skips, bypasses, suppressions, and assertion loss`,
      ruleId: "integrity-scan",
      contributesToPass: false
    });
  }
  return results;
}
function checkCompletion(claims, repo, base, head, prior) {
  const completion = claims.filter((claim) => claim.kind === "work_complete");
  if (!completion.length) return [];
  const diffRange = head === "WORKTREE" ? [base] : [base, head];
  const diff = git(repo, ["diff", "--unified=0", "--no-color", ...diffRange]);
  const markers = diff.split("\n").filter((line) => /^\+.*\b(TODO|FIXME|XXX|HACK|NotImplementedError|not implemented)\b/i.test(line));
  const objectiveVerified = prior.filter((result2) => result2.verdict === "verified" && result2.contributesToPass !== false).length;
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
var VERSION = "0.6.0";
function canonical(value) {
  if (value === void 0) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
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
  else if (meaningfulVerified < policy.minVerified || input.results.some((result2) => result2.verdict === "unverifiable" && result2.blocksPass) || policy.strict && unverifiable > 0) status = "INCONCLUSIVE";
  else status = "PASS";
  const summary = {
    verified: count("verified"),
    contradicted,
    unverifiable,
    meaningfulVerified,
    status,
    pass: status === "PASS"
  };
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
    summary: report.summary,
    policy: report.policy
  };
  return `sha256:${createHash2("sha256").update(canonical(payload)).digest("hex")}`;
}

// src/output.ts
import { appendFileSync, writeFileSync } from "node:fs";
var icon = { verified: "\u2713", contradicted: "\u2717", unverifiable: "?" };
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
    "portable-git-binding": "Regenerate after the latest source commit; after signing, commit only the base-policy-controlled receipt path."
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
  for (const result2 of report.results) {
    lines.push(`  ${icon[result2.verdict]} [${result2.ruleId ?? result2.claim.kind}] ${result2.claim.subject}`);
    lines.push(`      claim:    "${result2.claim.quote.slice(0, 140)}"`);
    lines.push(`      evidence: ${result2.evidence}`, "");
    if (result2.verdict !== "verified") lines.splice(lines.length - 1, 0, `      fix:      ${remediationFor(result2.ruleId)}`);
  }
  const summary = report.summary;
  lines.push(`  ${summary.verified} verified \xB7 ${summary.contradicted} contradicted \xB7 ${summary.unverifiable} unresolved`);
  lines.push(`  ${summary.status} \xB7 ${report.receiptHash}`);
  lines.push(`  reproduce: ${report.reproduction}`);
  if (summary.status === "INCONCLUSIVE") lines.push("  Missing or unresolved evidence prevents a trustworthy pass.");
  return lines.join("\n");
}
function renderMarkdown(report) {
  const rows = report.results.map(
    (result2) => `| ${icon[result2.verdict]} ${result2.verdict} | \`${result2.ruleId ?? result2.claim.kind}\` | ${escapeCell(result2.claim.subject)} | ${escapeCell(result2.evidence)} |`
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
    "",
    `${report.summary.verified} verified \xB7 ${report.summary.contradicted} contradicted \xB7 ${report.summary.unverifiable} unresolved`,
    "",
    ...report.results.some((result2) => result2.verdict !== "verified") ? [
      "## What to do next",
      "",
      ...report.results.filter((result2) => result2.verdict !== "verified").map(
        (result2) => `- **\`${result2.ruleId ?? result2.claim.kind}\`**: ${remediationFor(result2.ruleId)}`
      ),
      ""
    ] : [],
    `Reproduce: \`${report.reproduction.replace(/`/g, "\\`")}\``,
    ""
  ].join("\n");
}
function escapeCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}
function sarifResult(result2) {
  const level = result2.verdict === "contradicted" ? "error" : result2.verdict === "unverifiable" ? "warning" : "note";
  return {
    ruleId: result2.ruleId ?? result2.claim.kind,
    level,
    message: { text: `${result2.claim.subject}: ${result2.evidence}. Remediation: ${remediationFor(result2.ruleId)}` }
  };
}
function toSarif(report) {
  const rules = [...new Set(report.results.map((result2) => result2.ruleId ?? result2.claim.kind))].map((id) => ({
    id,
    shortDescription: { text: id.replace(/-/g, " ") }
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "agent-vigil", version: report.vigilVersion, informationUri: "https://github.com/sulmusic2-star/agent-vigil", rules } },
      results: report.results.filter((result2) => result2.verdict !== "verified").map(sarifResult),
      properties: { receiptHash: report.receiptHash, status: report.summary.status }
    }]
  };
}
function writeOutputs(report, options) {
  if (options.output) writeFileSync(options.output, `${JSON.stringify(report, null, 2)}
`);
  if (options.sarif) writeFileSync(options.sarif, `${JSON.stringify(toSarif(report), null, 2)}
`);
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (options.githubSummary && summaryPath) appendFileSync(summaryPath, renderMarkdown(report));
}

// src/demo.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function git2(repo, ...args) {
  execFileSync2("git", args, { cwd: repo, stdio: "ignore" });
}
function runDemo(run2) {
  const repo = mkdtempSync(join(tmpdir(), "agent-vigil-demo-"));
  git2(repo, "init", "-q");
  git2(repo, "config", "user.email", "demo@agent-vigil.local");
  git2(repo, "config", "user.name", "Agent Vigil Demo");
  mkdirSync(join(repo, "src"));
  writeFileSync2(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test test.js" } }, null, 2));
  writeFileSync2(join(repo, "test.js"), "const { test } = require('node:test'); test('real', () => {});\n");
  writeFileSync2(join(repo, "src", "real.ts"), "export const real = true;\n");
  git2(repo, "add", "-A");
  git2(repo, "commit", "-qm", "baseline");
  writeFileSync2(join(repo, "README.md"), "demo head\n");
  git2(repo, "add", "README.md");
  git2(repo, "commit", "-qm", "head");
  const evidence = mkdtempSync(join(tmpdir(), "agent-vigil-demo-evidence-"));
  const count = join(evidence, "false-count.md");
  const ghost = join(evidence, "ghost-file.md");
  const loop = join(evidence, "tool-loop.jsonl");
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
import { existsSync as existsSync2, readFileSync as readFileSync3 } from "node:fs";
import { isAbsolute as isAbsolute2, normalize, resolve as resolve2, win32 } from "node:path";
var DEFAULT_POLICY_FILE = ".agent-vigil.json";
function canonical2(value) {
  if (value === void 0) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical2).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical2(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function validatePolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("policy must be a JSON object");
  const value = input;
  const allowed = /* @__PURE__ */ new Set(["schemaVersion", "transcript", "testCommand", "strict", "minVerified", "trustedSignerKeyIds", "portableReceipt"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`policy contains unknown field(s): ${unknown.join(", ")}`);
  if (value.schemaVersion !== 1) throw new Error("policy schemaVersion must be 1");
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
  return value;
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
  const candidate = requested ? resolve2(repo, requested) : resolve2(repo, DEFAULT_POLICY_FILE);
  if (!existsSync2(candidate)) {
    if (requested) throw new Error(`policy not found: ${candidate}`);
    const value2 = { schemaVersion: 1 };
    return { sha256: `sha256:${createHash3("sha256").update(canonical2(value2)).digest("hex")}`, value: value2 };
  }
  const raw = readFileSync3(candidate, "utf8");
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

// src/setup.ts
import { execFileSync as execFileSync4 } from "node:child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname, relative as relative2, resolve as resolve3 } from "node:path";
function workflow(portable) {
  return `name: Agent Vigil

on:
  pull_request:

permissions:
  contents: read

jobs:
  evidence:
    name: Agent Vigil evidence
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha }}
      - uses: sulmusic2-star/agent-vigil@v0.6.0
        with:
          ${portable ? "receipt: .agent-vigil/receipt.json" : "transcript: .agent-vigil/session.md"}
          policy: .agent-vigil.json
          policy-ref: \${{ github.event.pull_request.base.sha }}
          repo: .
          base: \${{ github.event.pull_request.base.sha }}
          head: \${{ github.event.pull_request.head.sha }}
`;
}
var SESSION_TEMPLATE = `# Agent change receipt

Replace this file with the coding agent's final summary or point
\`.agent-vigil.json\` at a supported exported transcript.

Agent Vigil will independently compare checkable claims with the selected Git
range and fresh verification. This placeholder intentionally contains no claims,
so strict verification remains INCONCLUSIVE until real evidence is supplied.
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
function writeScaffold(root, path, content, force, result2) {
  const target = resolve3(root, path);
  if (existsSync3(target) && !force) {
    result2.kept.push(path);
    return;
  }
  mkdirSync2(dirname(target), { recursive: true });
  writeFileSync3(target, content);
  result2.created.push(path);
}
function initRepository(repo, force = false, portableSignerKeyId) {
  const root = resolve3(repo);
  try {
    execFileSync4("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "ignore" });
  } catch {
    throw new Error(`not a Git repository: ${root}`);
  }
  const result2 = { created: [], kept: [] };
  const inferred = inferTestCommand(root) ?? void 0;
  writeScaffold(root, DEFAULT_POLICY_FILE, policyTemplate(inferred, portableSignerKeyId), force, result2);
  if (!portableSignerKeyId) {
    writeScaffold(root, ".agent-vigil/session.md", SESSION_TEMPLATE, force, result2);
    writeScaffold(root, ".agent-vigil/README.md", LOCAL_README, force, result2);
  }
  writeScaffold(root, ".github/workflows/agent-vigil.yml", workflow(Boolean(portableSignerKeyId)), force, result2);
  return result2;
}
function git3(repo, args) {
  try {
    return execFileSync4("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function doctorRepository(repo, requestedPolicy, requestedTranscript) {
  const root = resolve3(repo);
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    status: nodeMajor >= 20 ? "PASS" : "FAIL",
    label: "Node.js",
    detail: `${process.versions.node}${nodeMajor >= 20 ? " satisfies Node 20+" : " is unsupported; install Node 20+"}`
  });
  const gitRoot = git3(root, ["rev-parse", "--show-toplevel"]);
  checks.push({
    status: gitRoot ? "PASS" : "FAIL",
    label: "Git repository",
    detail: gitRoot ?? `${root} is not inside a readable Git repository`
  });
  let transcript = requestedTranscript;
  let portableReceipt;
  try {
    const policy = loadPolicy(root, requestedPolicy);
    checks.push({
      status: policy.path ? "PASS" : "WARN",
      label: "Policy",
      detail: policy.path ? `${relative2(root, policy.path)} \xB7 ${policy.sha256}` : `no ${DEFAULT_POLICY_FILE}; CLI defaults will be used`
    });
    transcript ??= policy.value.transcript;
    portableReceipt = policy.value.portableReceipt;
    const command = policy.value.testCommand ?? inferTestCommand(root);
    checks.push({
      status: command ? "PASS" : "WARN",
      label: "Fresh verification",
      detail: command ? `test command: ${command}` : "no test command inferred; use policy testCommand or --test-cmd"
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
    const path = resolve3(root, portableReceipt);
    checks.push({
      status: existsSync3(path) ? "PASS" : "WARN",
      label: "Portable receipt",
      detail: existsSync3(path) ? `${portableReceipt} is present; run vigil gate to verify it` : `${portableReceipt} will be created after the next signed code change; raw transcript remains local`
    });
  } else if (!transcript) {
    checks.push({ status: "WARN", label: "Transcript", detail: "no transcript configured; pass a path or run vigil init" });
  } else {
    const path = resolve3(root, transcript);
    if (!existsSync3(path)) checks.push({ status: "WARN", label: "Transcript", detail: `${transcript} does not exist yet` });
    else {
      try {
        const loaded = loadTranscript(path);
        checks.push({
          status: "PASS",
          label: "Transcript",
          detail: `${transcript} detected as ${loaded.format}; ${loaded.toolCalls.length} tool call(s)`
        });
      } catch (error) {
        checks.push({ status: "FAIL", label: "Transcript", detail: error.message });
      }
    }
  }
  const workflow2 = resolve3(root, ".github/workflows/agent-vigil.yml");
  checks.push({
    status: existsSync3(workflow2) ? "PASS" : "WARN",
    label: "GitHub Action",
    detail: existsSync3(workflow2) ? "workflow installed; configure Agent Vigil evidence as a required status check after its first run" : "workflow not installed; run vigil init"
  });
  if (existsSync3(workflow2)) {
    const text = readFileSync4(workflow2, "utf8");
    const exactRange = /pull_request\.base\.sha/.test(text) && /pull_request\.head\.sha/.test(text);
    checks.push({
      status: exactRange ? "PASS" : "WARN",
      label: "Git range",
      detail: exactRange ? "workflow pins the pull request base and head SHAs" : "workflow does not visibly pin both pull request SHAs"
    });
    const exactCheckout = /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/.test(text);
    checks.push({
      status: exactCheckout ? "PASS" : "WARN",
      label: "Checkout identity",
      detail: exactCheckout ? "workflow checks out the exact pull request head SHA" : "workflow may verify GitHub's synthetic merge commit instead of the selected head"
    });
    const anchoredPolicy = /policy-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/.test(text);
    checks.push({
      status: anchoredPolicy ? "PASS" : "WARN",
      label: "Policy trust",
      detail: anchoredPolicy ? "workflow loads policy from the pull request base commit" : "workflow policy may be controlled by the candidate change"
    });
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
  createHash as createHash4,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";
import { chmodSync, readFileSync as readFileSync5, writeFileSync as writeFileSync4 } from "node:fs";
function publicKeyDer(key) {
  return key.export({ type: "spki", format: "der" });
}
function signingKeyId(der) {
  return `sha256:${createHash4("sha256").update(der).digest("hex")}`;
}
function signReport(report, privateKeyPath) {
  const privateKey = createPrivateKey(readFileSync5(privateKeyPath));
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
  const selected = publicKeyPath ? createPublicKey(readFileSync5(publicKeyPath)) : embedded;
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
  const publicKey = createPublicKey(readFileSync5(publicKeyPath));
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("public key must be Ed25519");
  return signingKeyId(publicKeyDer(publicKey));
}

// src/portable.ts
import {
  createHash as createHash5,
  createPrivateKey as createPrivateKey2,
  createPublicKey as createPublicKey2,
  sign as sign2,
  verify as verify2
} from "node:crypto";
import { readFileSync as readFileSync6 } from "node:fs";
var SHA256 = /^sha256:[0-9a-f]{64}$/;
function digest(value) {
  return `sha256:${createHash5("sha256").update(canonical(value)).digest("hex")}`;
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
  const privateKey = createPrivateKey2(readFileSync6(privateKeyPath));
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
import { execFileSync as execFileSync5 } from "node:child_process";
import { relative as relative3, resolve as resolve4, sep as sep2 } from "node:path";
function git4(repo, args) {
  try {
    return execFileSync5("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return void 0;
  }
}
function result(subject, verdict, evidence, ruleId, blocksPass = false) {
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
  const value = relative3(resolve4(repo), resolve4(path)).replaceAll("\\", "/");
  if (!value || value === ".." || value.startsWith("../") || value.startsWith(`..${sep2}`)) return void 0;
  return value.replace(/^\.\//, "");
}
function buildPortableGateReport(receipt, options) {
  const repo = resolve4(options.repo);
  const receiptPath = resolve4(options.receiptPath);
  if (!gitRefExists(repo, options.base) || !gitRefExists(repo, options.head)) {
    throw new Error(`invalid git range ${options.base}..${options.head}`);
  }
  const policy = loadPolicy(repo, options.policy, options.policyRef);
  const base = resolveGitRef(repo, options.base);
  const head = resolveGitRef(repo, options.head);
  const results = [];
  const trusted = policy.value.trustedSignerKeyIds ?? [];
  const verification = verifyPortableReceipt(receipt, trusted);
  results.push(result(
    "portable receipt hash and Ed25519 signature",
    verification.hashValid && verification.signatureValid ? "verified" : "contradicted",
    verification.hashValid && verification.signatureValid ? `${receipt.portableHash} is intact and signed by ${verification.keyId}` : verification.errors.filter((error) => !error.includes("not pinned")).join("; ") || "portable receipt signature is invalid",
    "portable-signature"
  ));
  results.push(result(
    "receipt signer is pinned by trusted policy",
    verification.signerTrusted ? "verified" : trusted.length ? "contradicted" : "unverifiable",
    verification.signerTrusted ? `${verification.keyId} is listed in the base-anchored policy` : trusted.length ? `${verification.keyId ?? "unreadable signer"} is not one of ${trusted.length} trusted key ID(s)` : "trusted policy has no trustedSignerKeyIds; pin a signer before enabling the gate",
    "portable-signer",
    !trusted.length
  ));
  results.push(result(
    "local Agent Vigil verdict",
    receipt.summary?.status === "PASS" && receipt.summary.pass ? "verified" : receipt.summary?.status === "FAIL" ? "contradicted" : "unverifiable",
    `signed local report ${receipt.reportHash} records ${receipt.summary?.status ?? "an invalid status"}`,
    "portable-local-verdict",
    receipt.summary?.status !== "FAIL"
  ));
  results.push(result(
    "portable receipt matches trusted policy",
    receipt.policy?.sha256 === policy.sha256 ? "verified" : "contradicted",
    receipt.policy?.sha256 === policy.sha256 ? `receipt and base policy share ${policy.sha256}` : `receipt names ${receipt.policy?.sha256 ?? "no policy hash"}; trusted policy is ${policy.sha256}`,
    "portable-policy"
  ));
  const relativeReceipt = receiptRelativePath(repo, receiptPath);
  const configuredReceipt = policy.value.portableReceipt?.replace(/^\.\//, "");
  if (configuredReceipt) {
    results.push(result(
      "receipt path is base-policy controlled",
      relativeReceipt === configuredReceipt ? "verified" : "contradicted",
      relativeReceipt === configuredReceipt ? `${relativeReceipt} matches policy portableReceipt` : `received ${relativeReceipt ?? "a path outside the repository"}; policy requires ${configuredReceipt}`,
      "portable-path"
    ));
  } else {
    results.push(result(
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
  const ancestor = Boolean(receiptHead && git4(repo, ["merge-base", "--is-ancestor", receiptHead, head]) !== void 0);
  const evidenceDelta = receiptHead && configuredReceipt ? (git4(repo, ["diff", "--name-only", "-z", receiptHead, head]) ?? "").split("\0").filter(Boolean) : [];
  const receiptOnlyTail = ancestor && evidenceDelta.length > 0 && evidenceDelta.every((path) => path === configuredReceipt);
  const expectedTree = receiptHead ? git4(repo, ["rev-parse", `${receiptHead}^{tree}`]) : void 0;
  const currentRemote = git4(repo, ["config", "--get", "remote.origin.url"]);
  const remoteMatches = !receipt.repository?.remote || !currentRemote || receipt.repository.remote === currentRemote;
  const gitBound = receiptBase === base && Boolean(receiptHead) && (exactHead || receiptOnlyTail) && Boolean(expectedTree) && receipt.repository?.tree === expectedTree && remoteMatches;
  results.push(result(
    "signed repository identity",
    gitBound ? "verified" : "contradicted",
    gitBound ? exactHead ? `receipt binds exact head ${head} and tree ${expectedTree}` : `receipt binds code head ${receiptHead}; ${receiptHead}..${head} changes only ${configuredReceipt}` : `expected base ${base}, current head ${head}, receipt base ${receiptBase ?? "invalid"}, receipt head ${receiptHead ?? "invalid"}, receipt tree ${receipt.repository?.tree ?? "missing"}, observed tree ${expectedTree ?? "invalid"}${remoteMatches ? "" : "; remote differs"}`,
    "portable-git-binding"
  ));
  results.push(...checkWorkspaceBinding(repo, head, exactHead ? [receiptPath] : []));
  const testClaim = { kind: "tests_pass", quote: "trusted policy verification passes in independent CI", subject: "trusted policy test command" };
  results.push(...checkTestsPass([testClaim], repo, policy.value.testCommand));
  results.push(...checkWorkspaceMutation(repo, exactHead ? [receiptPath] : []));
  results.push(...checkIntegrity(repo, base, head));
  const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative3(repo, policy.path) : void 0;
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
    policy: { minVerified: 1, strict: true, source: policySource, sha256: policy.sha256 },
    repository: { ...currentRemote ? { remote: currentRemote } : {}, ...git4(repo, ["rev-parse", `${head}^{tree}`]) ? { tree: git4(repo, ["rev-parse", `${head}^{tree}`]) } : {} },
    reproduction
  });
}

// src/cli.ts
function usage() {
  return `agent-vigil ${VERSION}

Usage:
  vigil <transcript.jsonl|summary.md> [options]
  vigil demo
  vigil init [--repo <path>] [--force] [--portable --public-key <path>]
  vigil doctor [--repo <path>] [--policy <path>] [--transcript <path>]
  vigil keygen --private <path> --public <path>
  vigil verify <receipt.json> [--public-key <path>]
  vigil gate <portable-receipt.json> [options]

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
  --strict               INCONCLUSIVE when any claim remains unresolved
  --min-verified <n>     Minimum objective verified claims (default: 1)
  --version              Print the version
  --help                 Show this help

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
    const repo = resolve5(optionValue(args, "--repo") ?? ".");
    const portable = args.includes("--portable");
    const publicKey = optionValue(args, "--public-key");
    if (portable && !publicKey) throw new Error("init --portable requires --public-key <Ed25519 public key>");
    if (!portable && publicKey) throw new Error("init --public-key is only valid with --portable");
    const result2 = initRepository(repo, args.includes("--force"), publicKey ? publicKeyId(resolve5(publicKey)) : void 0);
    console.log("Agent Vigil initialized.\n");
    for (const path of result2.created) console.log(`  created ${path}`);
    for (const path of result2.kept) console.log(`  kept    ${path} (use --force to replace)`);
    console.log(portable ? "\nNext: merge this base policy first, then generate a portable receipt after each code commit with --portable-output." : "\nNext: replace .agent-vigil/session.md with a real agent transcript or summary, push one PR, then require the Agent Vigil evidence status check.");
    return 0;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function runDoctor(args) {
  try {
    const repo = resolve5(optionValue(args, "--repo") ?? ".");
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
    generateSigningKey(resolve5(privatePath), resolve5(publicPath));
    console.log(`Created Ed25519 private key ${privatePath} and public key ${publicPath}. Keep the private key out of Git.`);
    console.log(`Signer key ID: ${publicKeyId(resolve5(publicPath))}`);
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
    const absoluteReceipt = resolve5(options.repo, receiptPath);
    const receipt = JSON.parse(readFileSync7(absoluteReceipt, "utf8"));
    const report = buildPortableGateReport(receipt, {
      repo: resolve5(options.repo),
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
    const report = JSON.parse(readFileSync7(resolve5(receiptPath), "utf8"));
    if (report.schemaVersion !== "2") throw new Error(`unsupported receipt schema: ${String(report.schemaVersion)}`);
    const publicKey = optionValue(args, "--public-key");
    const result2 = verifyReport(report, publicKey ? resolve5(publicKey) : void 0);
    console.log(`Receipt hash: ${result2.hashValid ? "VALID" : "INVALID"}`);
    if (result2.signatureValid !== void 0) {
      console.log(`Ed25519 signature: ${result2.signatureValid ? "VALID" : "INVALID"} \xB7 ${result2.keyPinned ? "pinned public key" : "embedded self-asserted key"}`);
      if (!result2.keyPinned) console.log("Identity is not established until the public key is pinned through a trusted channel.");
    } else console.log("Signature: absent (content hash only)");
    return result2.hashValid && result2.signatureValid !== false ? 0 : 1;
  } catch (error) {
    console.error(`agent-vigil: ${error.message}`);
    return 2;
  }
}
function git5(repo, args) {
  try {
    return execFileSync6("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
  if (argv[0] === "gate") return runGate(argv);
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
  const repo = resolve5(options.repo);
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
  const transcriptPath = isAbsolute3(transcript) ? transcript : resolve5(repo, transcript);
  const testCmd = options.testCmd ?? policy.value.testCommand;
  const strict = options.strict ?? policy.value.strict ?? false;
  const minVerified = options.minVerified ?? policy.value.minVerified ?? 1;
  if (!existsSync4(transcriptPath)) {
    console.error(`agent-vigil: transcript not found: ${transcriptPath}`);
    return 2;
  }
  if (!existsSync4(repo)) {
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
    const workspaceInputs = [
      transcriptPath,
      ...policy.path ? [policy.path] : [],
      ...options.signingKey ? [resolve5(options.signingKey)] : [],
      ...options.portableOutput ? [resolve5(repo, options.portableOutput)] : []
    ];
    results.push(...checkWorkspaceBinding(repo, head, workspaceInputs));
    results.push(...checkTestsPass(claims, repo, testCmd));
    results.push(...checkWorkspaceMutation(repo, workspaceInputs));
    results.push(...checkFilesChanged(claims, repo, base, head));
    const changedClaims = new Set(claims.filter((claim) => claim.kind === "file_changed").map((claim) => claim.subject));
    results.push(...checkPathsExist(claims.filter((claim) => !changedClaims.has(claim.subject)), repo));
    results.push(...checkRunClaims(runClaims, loaded.toolCalls));
    results.push(...checkStepRepetition(loaded.toolCalls));
    results.push(...checkIntegrity(repo, base, head));
    results.push(...checkCompletion(claims, repo, base, head, results));
    const policySource = policy.ref && policy.gitPath ? `${policy.gitPath}@${policy.ref}` : policy.path ? relative4(repo, policy.path) : void 0;
    const remote = git5(repo, ["config", "--get", "remote.origin.url"]);
    const tree = head === "WORKTREE" ? void 0 : git5(repo, ["rev-parse", `${head}^{tree}`]);
    const relativeTranscript = relative4(repo, transcriptPath) || transcript;
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
      policy: { minVerified, strict, source: policySource, sha256: policy.sha256 },
      repository: { ...remote ? { remote } : {}, ...tree ? { tree } : {} },
      reproduction
    });
    if (options.signingKey) report = signReport(report, resolve5(options.signingKey));
    writeOutputs(report, options);
    if (options.portableOutput) {
      const portable = createPortableReceipt(report, resolve5(options.signingKey));
      const portablePath = resolve5(repo, options.portableOutput);
      mkdirSync3(dirname2(portablePath), { recursive: true });
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
    return realpathSync2(process.argv[1]) === realpathSync2(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isMainModule()) process.exit(run());
export {
  run
};
