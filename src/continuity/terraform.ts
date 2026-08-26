import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { arch, platform } from "node:process";
import { canonicalSha256, type ContinuityState } from "./contracts.ts";
import { assertGuardFileUnchanged, hashGuardFile } from "../guard-compat.ts";
import { verifyContinuityStaple, type VerifyStapleOptions } from "./staple.ts";

export const TERRAFORM_PLAN_GATE_SCHEMA = "agent-vigil-terraform-plan-gate/v1" as const;
export const MAX_TERRAFORM_PLAN_BYTES = 512 * 1024 * 1024;
export const MAX_TERRAFORM_SHOW_BYTES = 64 * 1024 * 1024;

type TerraformActionCounts = {
  noOp: number;
  create: number;
  read: number;
  update: number;
  delete: number;
  replaceDeleteCreate: number;
  replaceCreateDelete: number;
};

export type TerraformPlanGateResult = {
  schemaVersion: typeof TERRAFORM_PLAN_GATE_SCHEMA;
  generatedAt: string;
  decision: {
    continuity: ContinuityState;
    authorization: "ALLOW" | "DENY";
    reasonCode: "CURRENT_STAPLE" | "EVIDENCE_HOLD" | "STAPLE_EXPIRED" | "LATER_EVIDENCE_REVOKED";
  };
  staple: {
    payloadHash: string;
    signerKeyId: string;
    expiresAt: string;
    sequence: number;
  };
  plan: null | {
    sha256: string;
    bytes: number;
    formatVersion: string;
    terraformVersion: string;
    resourceChanges: number;
    actions: TerraformActionCounts;
  };
  verifier: null | {
    terraformExecutableSha256: string;
    operatingSystem: string;
    architecture: string;
    networkCalls: 0;
  };
  authorizationHash: string;
  limitations: string[];
};

function reasonFor(state: ContinuityState): TerraformPlanGateResult["decision"]["reasonCode"] {
  if (state === "CURRENT") return "CURRENT_STAPLE";
  if (state === "REVOKED") return "LATER_EVIDENCE_REVOKED";
  if (state === "EXPIRED") return "STAPLE_EXPIRED";
  return "EVIDENCE_HOLD";
}

function shortVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(value) || value.length > 40) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function actionCounts(value: unknown): { changes: number; actions: TerraformActionCounts } {
  if (value === undefined) value = [];
  if (!Array.isArray(value) || value.length > 100_000) throw new Error("Terraform plan resource_changes is invalid or exceeds 100000 entries");
  const actions: TerraformActionCounts = { noOp: 0, create: 0, read: 0, update: 0, delete: 0, replaceDeleteCreate: 0, replaceCreateDelete: 0 };
  const mapping: Record<string, keyof TerraformActionCounts> = {
    "no-op": "noOp",
    create: "create",
    read: "read",
    update: "update",
    delete: "delete",
    "delete,create": "replaceDeleteCreate",
    "create,delete": "replaceCreateDelete",
  };
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Terraform plan contains a malformed resource change");
    const raw = (item as { change?: { actions?: unknown } }).change?.actions;
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) throw new Error("Terraform plan contains malformed actions");
    const selected = mapping[raw.join(",")];
    if (!selected) throw new Error("Terraform plan contains unsupported actions");
    actions[selected] += 1;
  }
  return { changes: value.length, actions };
}

function parseTerraformShow(value: string): { formatVersion: string; terraformVersion: string; resourceChanges: number; actions: TerraformActionCounts } {
  let selected: unknown;
  try { selected = JSON.parse(value); }
  catch { throw new Error("terraform show did not return valid JSON"); }
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new Error("terraform show returned an invalid document");
  const record = selected as Record<string, unknown>;
  const formatVersion = shortVersion(record.format_version, "Terraform plan format_version");
  if (!formatVersion.startsWith("1.")) throw new Error("Terraform plan format version is unsupported");
  const terraformVersion = shortVersion(record.terraform_version, "Terraform version");
  const counted = actionCounts(record.resource_changes);
  return { formatVersion, terraformVersion, resourceChanges: counted.changes, actions: counted.actions };
}

function unsignedResult(
  generatedAt: string,
  continuity: ContinuityState,
  staple: TerraformPlanGateResult["staple"],
  plan: TerraformPlanGateResult["plan"],
  verifier: TerraformPlanGateResult["verifier"],
): Omit<TerraformPlanGateResult, "authorizationHash"> {
  return {
    schemaVersion: TERRAFORM_PLAN_GATE_SCHEMA,
    generatedAt,
    decision: { continuity, authorization: continuity === "CURRENT" && plan !== null ? "ALLOW" : "DENY", reasonCode: reasonFor(continuity) },
    staple,
    plan,
    verifier,
    limitations: [
      "This command verifies and fingerprints a saved Terraform plan; it does not run terraform apply.",
      "The apply job must use this exact plan immediately, recompute its SHA-256, and refuse a mismatch.",
      "The minimized result contains counts and hashes only; raw Terraform plan values are not retained.",
    ],
  };
}

export function verifyTerraformSavedPlan(options: {
  planPath: string;
  terraformExecutable: string;
  staple: unknown;
  stapleOptions: VerifyStapleOptions;
  timeoutMs?: number;
}): TerraformPlanGateResult {
  const verification = verifyContinuityStaple(options.staple, options.stapleOptions);
  const staple = {
    payloadHash: verification.payloadHash,
    signerKeyId: verification.signerKeyId,
    expiresAt: verification.expiresAt,
    sequence: verification.sequence,
  };
  const generatedAt = (options.stapleOptions.now ?? new Date()).toISOString();
  if (!verification.allowsProtectedAction) {
    const unsigned = unsignedResult(generatedAt, verification.effectiveContinuity, staple, null, null);
    return { ...unsigned, authorizationHash: canonicalSha256(unsigned) };
  }

  const requestedPlan = resolve(options.planPath);
  const requestedStatus = lstatSync(requestedPlan);
  if (requestedStatus.isSymbolicLink() || !requestedStatus.isFile()) throw new Error("saved Terraform plan must be a regular file, not a symbolic link");
  const planIdentity = hashGuardFile(requestedPlan, "saved Terraform plan");
  if (planIdentity.size <= 0n || planIdentity.size > BigInt(MAX_TERRAFORM_PLAN_BYTES)) throw new Error("saved Terraform plan is empty or exceeds the byte limit");
  const executableIdentity = hashGuardFile(resolve(options.terraformExecutable), "Terraform executable");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("Terraform show timeout must be from 1000 through 120000 milliseconds");

  const environment: NodeJS.ProcessEnv = { ...process.env, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
  for (const name of Object.keys(environment)) if (name === "TF_CLI_ARGS" || name.startsWith("TF_CLI_ARGS_")) delete environment[name];
  const child = spawnSync(executableIdentity.realPath, ["show", "-json", "-no-color", planIdentity.realPath], {
    cwd: dirname(planIdentity.realPath),
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: MAX_TERRAFORM_SHOW_BYTES,
  });
  if (child.error || child.signal || child.status !== 0) throw new Error("terraform show could not inspect the saved plan");
  const parsed = parseTerraformShow(child.stdout);
  assertGuardFileUnchanged(planIdentity, "saved Terraform plan");
  assertGuardFileUnchanged(executableIdentity, "Terraform executable");

  const plan = {
    sha256: planIdentity.sha256,
    bytes: Number(planIdentity.size),
    formatVersion: parsed.formatVersion,
    terraformVersion: parsed.terraformVersion,
    resourceChanges: parsed.resourceChanges,
    actions: parsed.actions,
  };
  const verifier = {
    terraformExecutableSha256: executableIdentity.sha256,
    operatingSystem: platform,
    architecture: arch,
    networkCalls: 0 as const,
  };
  const unsigned = unsignedResult(generatedAt, verification.effectiveContinuity, staple, plan, verifier);
  return { ...unsigned, authorizationHash: canonicalSha256(unsigned) };
}
