import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

export const DEFAULT_POLICY_FILE = ".agent-vigil.json";

export type VigilPolicy = {
  schemaVersion: 1;
  transcript?: string;
  testCommand?: string;
  strict?: boolean;
  minVerified?: number;
};

export type LoadedPolicy = {
  path?: string;
  gitPath?: string;
  ref?: string;
  sha256: string;
  value: VigilPolicy;
};

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validatePolicy(input: unknown): VigilPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("policy must be a JSON object");
  const value = input as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "transcript", "testCommand", "strict", "minVerified"]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`policy contains unknown field(s): ${unknown.join(", ")}`);
  if (value.schemaVersion !== 1) throw new Error("policy schemaVersion must be 1");
  if (value.transcript !== undefined && (typeof value.transcript !== "string" || !value.transcript.trim())) {
    throw new Error("policy transcript must be a non-empty string");
  }
  if (value.testCommand !== undefined && (typeof value.testCommand !== "string" || !value.testCommand.trim())) {
    throw new Error("policy testCommand must be a non-empty string");
  }
  if (value.strict !== undefined && typeof value.strict !== "boolean") throw new Error("policy strict must be boolean");
  if (value.minVerified !== undefined && (!Number.isInteger(value.minVerified) || Number(value.minVerified) < 1)) {
    throw new Error("policy minVerified must be a positive integer");
  }
  return value as VigilPolicy;
}

function parsePolicy(raw: string, source: string): VigilPolicy {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error(`policy is not valid JSON: ${source}`); }
  return validatePolicy(parsed);
}

export function loadPolicy(repo: string, requested?: string, ref?: string): LoadedPolicy {
  const gitPath = requested ?? DEFAULT_POLICY_FILE;
  if (ref) {
    const clean = normalize(gitPath).replace(/^\.\//, "");
    if (isAbsolute(gitPath) || clean === ".." || clean.startsWith("../")) throw new Error("policy-ref requires a repository-relative policy path");
    let raw: string;
    try {
      raw = execFileSync("git", ["show", `${ref}:${clean}`], {
        cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024,
      });
    } catch { throw new Error(`policy not found at ${ref}:${clean}`); }
    const value = parsePolicy(raw, `${ref}:${clean}`);
    return {
      gitPath: clean,
      ref,
      sha256: `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`,
      value,
    };
  }
  const candidate = requested ? resolve(repo, requested) : resolve(repo, DEFAULT_POLICY_FILE);
  if (!existsSync(candidate)) {
    if (requested) throw new Error(`policy not found: ${candidate}`);
    const value: VigilPolicy = { schemaVersion: 1 };
    return { sha256: `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`, value };
  }
  const raw = readFileSync(candidate, "utf8");
  const value = parsePolicy(raw, candidate);
  return {
    path: candidate,
    sha256: `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`,
    value,
  };
}

export function policyTemplate(testCommand?: string): string {
  const value: VigilPolicy = {
    schemaVersion: 1,
    transcript: ".agent-vigil/session.md",
    ...(testCommand ? { testCommand } : {}),
    strict: true,
    minVerified: 1,
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}
