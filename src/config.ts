import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, normalize, resolve, win32 } from "node:path";

export const DEFAULT_POLICY_FILE = ".agent-vigil.json";

export type VigilPolicy = {
  schemaVersion: 1;
  transcript?: string;
  testCommand?: string;
  strict?: boolean;
  minVerified?: number;
  trustedSignerKeyIds?: string[];
  portableReceipt?: string;
  maintainer?: MaintainerPolicy;
};

export type DifferentialTestPolicy = {
  command: string;
  setupCommand?: string;
  timeoutSeconds?: number;
  baseFailurePattern?: string;
  overlayChangedTests?: boolean;
};

export type MaintainerPolicy = {
  requireHumanAttestation?: boolean;
  requireLinkedIssue?: boolean;
  requireAiDisclosure?: boolean;
  maxChangedFiles?: number;
  maxChangedLines?: number;
  requireTestChange?: boolean;
  protectedPaths?: string[];
  testPathPatterns?: string[];
  differentialTest?: DifferentialTestPolicy;
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
  const allowed = new Set(["schemaVersion", "transcript", "testCommand", "strict", "minVerified", "trustedSignerKeyIds", "portableReceipt", "maintainer"]);
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
  if (value.trustedSignerKeyIds !== undefined) {
    if (!Array.isArray(value.trustedSignerKeyIds) || value.trustedSignerKeyIds.length < 1) {
      throw new Error("policy trustedSignerKeyIds must be a non-empty array");
    }
    const ids = value.trustedSignerKeyIds;
    if (ids.some((id) => typeof id !== "string" || !/^sha256:[0-9a-f]{64}$/.test(id))) {
      throw new Error("policy trustedSignerKeyIds must contain SHA-256 key IDs");
    }
    if (new Set(ids).size !== ids.length) throw new Error("policy trustedSignerKeyIds must not contain duplicates");
  }
  if (value.portableReceipt !== undefined) {
    if (typeof value.portableReceipt !== "string" || !value.portableReceipt.trim()) {
      throw new Error("policy portableReceipt must be a non-empty repository-relative path");
    }
    const clean = normalize(value.portableReceipt).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isAbsolute(value.portableReceipt) || win32.isAbsolute(value.portableReceipt) || clean === ".." || clean.startsWith("../")) {
      throw new Error("policy portableReceipt must stay inside the repository");
    }
  }
  if (value.maintainer !== undefined) validateMaintainerPolicy(value.maintainer);
  return value as VigilPolicy;
}

function positiveInteger(value: unknown, label: string, maximum?: number): void {
  if (!Number.isInteger(value) || Number(value) < 1 || (maximum !== undefined && Number(value) > maximum)) {
    throw new Error(`policy ${label} must be a positive integer${maximum ? ` no greater than ${maximum}` : ""}`);
  }
}

function nonEmptyStrings(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.length < 1 || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`policy ${label} must be a non-empty array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`policy ${label} must not contain duplicates`);
}

function validateMaintainerPolicy(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("policy maintainer must be a JSON object");
  const value = input as Record<string, unknown>;
  const allowed = new Set([
    "requireHumanAttestation", "requireLinkedIssue", "requireAiDisclosure", "maxChangedFiles", "maxChangedLines",
    "requireTestChange", "protectedPaths", "testPathPatterns", "differentialTest",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`policy maintainer contains unknown field(s): ${unknown.join(", ")}`);
  for (const key of ["requireHumanAttestation", "requireLinkedIssue", "requireAiDisclosure", "requireTestChange"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`policy maintainer.${key} must be boolean`);
  }
  if (value.maxChangedFiles !== undefined) positiveInteger(value.maxChangedFiles, "maintainer.maxChangedFiles", 100000);
  if (value.maxChangedLines !== undefined) positiveInteger(value.maxChangedLines, "maintainer.maxChangedLines", 10000000);
  if (value.protectedPaths !== undefined) nonEmptyStrings(value.protectedPaths, "maintainer.protectedPaths");
  if (value.testPathPatterns !== undefined) nonEmptyStrings(value.testPathPatterns, "maintainer.testPathPatterns");
  if (value.differentialTest !== undefined) {
    if (!value.differentialTest || typeof value.differentialTest !== "object" || Array.isArray(value.differentialTest)) {
      throw new Error("policy maintainer.differentialTest must be a JSON object");
    }
    const differential = value.differentialTest as Record<string, unknown>;
    const differentialAllowed = new Set(["command", "setupCommand", "timeoutSeconds", "baseFailurePattern", "overlayChangedTests"]);
    const differentialUnknown = Object.keys(differential).filter((key) => !differentialAllowed.has(key));
    if (differentialUnknown.length) throw new Error(`policy maintainer.differentialTest contains unknown field(s): ${differentialUnknown.join(", ")}`);
    if (typeof differential.command !== "string" || !differential.command.trim()) throw new Error("policy maintainer.differentialTest.command must be a non-empty string");
    if (differential.setupCommand !== undefined && (typeof differential.setupCommand !== "string" || !differential.setupCommand.trim())) {
      throw new Error("policy maintainer.differentialTest.setupCommand must be a non-empty string");
    }
    if (differential.timeoutSeconds !== undefined) positiveInteger(differential.timeoutSeconds, "maintainer.differentialTest.timeoutSeconds", 3600);
    if (differential.baseFailurePattern !== undefined) {
      if (typeof differential.baseFailurePattern !== "string" || !differential.baseFailurePattern.trim() || differential.baseFailurePattern.length > 500) throw new Error("policy maintainer.differentialTest.baseFailurePattern must be a non-empty string of at most 500 characters");
      try { new RegExp(differential.baseFailurePattern); }
      catch { throw new Error("policy maintainer.differentialTest.baseFailurePattern must be a valid regular expression"); }
    }
    if (differential.overlayChangedTests !== undefined && typeof differential.overlayChangedTests !== "boolean") {
      throw new Error("policy maintainer.differentialTest.overlayChangedTests must be boolean");
    }
  }
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
    const clean = normalize(gitPath).replaceAll("\\", "/").replace(/^\.\//, "");
    if (isAbsolute(gitPath) || win32.isAbsolute(gitPath) || clean === ".." || clean.startsWith("../")) throw new Error("policy-ref requires a repository-relative policy path");
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

export function policyTemplate(testCommand?: string, portableSignerKeyId?: string): string {
  const value: VigilPolicy = {
    schemaVersion: 1,
    ...(portableSignerKeyId ? {
      portableReceipt: ".agent-vigil/receipt.json",
      trustedSignerKeyIds: [portableSignerKeyId],
    } : { transcript: ".agent-vigil/session.md" }),
    ...(testCommand ? { testCommand } : {}),
    strict: true,
    minVerified: 1,
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function maintainerPolicyTemplate(testCommand?: string, setupCommand?: string): string {
  const command = testCommand ?? "REPLACE_WITH_TEST_COMMAND";
  const value: VigilPolicy = {
    schemaVersion: 1,
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
        ...(setupCommand ? { setupCommand } : {}),
        timeoutSeconds: 300,
        overlayChangedTests: true,
      },
    },
  };
  return `${JSON.stringify(value, null, 2)}\n`;
}
