import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runContinuityCommand } from "../src/continuity/cli.ts";

type Manifest = {
  bindings: {
    expectedReceiptHash: string;
    expectedHead: string;
    expectedEnvironment: string;
    expectedPolicySha256: string;
    expectedChainTip: string;
    minimumSequence: number;
  };
  times: { freshVerification: string; expiredVerification: string };
};

const vectors = join(process.cwd(), "test-vectors/continuity-staple/v1");
const manifest = JSON.parse(readFileSync(join(vectors, "manifest.json"), "utf8")) as Manifest;

function silent(operation: () => number): number {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return operation(); }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

type TerraformFixtureMode = "valid" | "empty-changes" | "mutate" | "malformed" | "invalid-document" | "invalid-version" | "invalid-actions" | "unsupported-actions" | "nonzero";

function fakeTerraform(root: string, mode: TerraformFixtureMode = "valid"): { executable: string; invocation: string } {
  const executable = join(root, `terraform-${mode}.mjs`);
  const invocation = join(root, `terraform-${mode}.invoked`);
  writeFileSync(executable, [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(invocation)},"invoked\\n");`,
    'const plan=process.argv.at(-1);',
    ...(mode === "mutate" ? ['writeFileSync(plan,"changed during terraform show\\n");'] : []),
    ...(mode === "nonzero" ? ["process.exit(7);"] : []),
    ...(mode === "malformed" ? ['process.stdout.write("not json");'] : []),
    ...(mode === "invalid-document" ? ['process.stdout.write("[]");'] : []),
    ...(mode === "invalid-version" ? ['process.stdout.write(JSON.stringify({format_version:"2.0",terraform_version:"1.14.1",resource_changes:[]}));'] : []),
    ...(mode === "invalid-actions" ? ['process.stdout.write(JSON.stringify({format_version:"1.2",terraform_version:"1.14.1",resource_changes:[{}]}));'] : []),
    ...(mode === "unsupported-actions" ? ['process.stdout.write(JSON.stringify({format_version:"1.2",terraform_version:"1.14.1",resource_changes:[{change:{actions:["create","update"]}}]}));'] : []),
    ...(mode === "empty-changes" ? ['process.stdout.write(JSON.stringify({format_version:"1.2",terraform_version:"1.14.1"}));'] : []),
    ...(mode === "valid" || mode === "mutate" ? [
      'process.stdout.write(JSON.stringify({format_version:"1.2",terraform_version:"1.14.1",resource_changes:[{change:{actions:["no-op"]}},{change:{actions:["create"]}},{change:{actions:["read"]}},{change:{actions:["update"]}},{change:{actions:["delete"]}},{change:{actions:["delete","create"]}},{change:{actions:["create","delete"]}}],planned_values:{root_module:{resources:[{values:{password:"must-not-be-retained"}}]}}}));',
    ] : []),
  ].join("\n") + "\n");
  chmodSync(executable, 0o700);
  return { executable, invocation };
}

function args(root: string, terraform: string, plan: string, staple = "current.staple.json", now = manifest.times.freshVerification): { values: string[]; output: string } {
  const output = join(root, "terraform-gate.json");
  return {
    output,
    values: [
      "terraform-plan-gate", plan,
      "--staple", join(vectors, staple),
      "--terraform-executable", terraform,
      "--public-key", join(vectors, "authority-public.pem"),
      "--expected-receipt-hash", manifest.bindings.expectedReceiptHash,
      "--expected-head", manifest.bindings.expectedHead,
      "--environment", manifest.bindings.expectedEnvironment,
      "--expected-policy-sha256", manifest.bindings.expectedPolicySha256,
      "--expected-chain-tip", manifest.bindings.expectedChainTip,
      "--minimum-sequence", String(manifest.bindings.minimumSequence),
      "--now", now,
      "--timeout-ms", "5000",
      "--format", "json",
      "--output", output,
    ],
  };
}

test("a CURRENT staple permits only the exact inspected saved Terraform plan", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-gate-"));
  const plan = join(root, "tfplan");
  writeFileSync(plan, "opaque saved plan fixture\n");
  const terraform = fakeTerraform(root);
  const command = args(root, terraform.executable, plan);
  assert.equal(silent(() => runContinuityCommand(command.values)), 0);
  const result = JSON.parse(readFileSync(command.output, "utf8"));
  assert.equal(result.decision.authorization, "ALLOW");
  assert.equal(result.decision.continuity, "CURRENT");
  assert.equal(result.plan.resourceChanges, 7);
  assert.deepEqual(result.plan.actions, { noOp: 1, create: 1, read: 1, update: 1, delete: 1, replaceDeleteCreate: 1, replaceCreateDelete: 1 });
  assert.equal(result.verifier.networkCalls, 0);
  assert.equal(existsSync(terraform.invocation), true);
  const serialized = readFileSync(command.output, "utf8");
  for (const privateValue of [root, plan, "must-not-be-retained"]) assert.equal(serialized.includes(privateValue), false);
});

test("expired or revoked authorization stops before Terraform is invoked", { skip: process.platform === "win32" }, () => {
  const expiredRoot = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-expired-"));
  const expiredPlan = join(expiredRoot, "tfplan");
  writeFileSync(expiredPlan, "opaque plan\n");
  const expiredTerraform = fakeTerraform(expiredRoot);
  const expiredCommand = args(expiredRoot, expiredTerraform.executable, expiredPlan, "current.staple.json", manifest.times.expiredVerification);
  assert.equal(silent(() => runContinuityCommand(expiredCommand.values)), 4);
  assert.equal(JSON.parse(readFileSync(expiredCommand.output, "utf8")).decision.authorization, "DENY");
  assert.equal(existsSync(expiredTerraform.invocation), false);

  const revokedRoot = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-revoked-"));
  const revokedPlan = join(revokedRoot, "tfplan");
  writeFileSync(revokedPlan, "opaque plan\n");
  const revokedTerraform = fakeTerraform(revokedRoot);
  const revokedCommand = args(revokedRoot, revokedTerraform.executable, revokedPlan, "revoked.staple.json", manifest.times.expiredVerification);
  assert.equal(silent(() => runContinuityCommand(revokedCommand.values)), 1);
  assert.equal(JSON.parse(readFileSync(revokedCommand.output, "utf8")).decision.continuity, "REVOKED");
  assert.equal(existsSync(revokedTerraform.invocation), false);
});

test("the Terraform gate refuses mutation, malformed show output, and symbolic plans", { skip: process.platform === "win32" }, () => {
  const mutateRoot = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-mutate-"));
  const mutatePlan = join(mutateRoot, "tfplan");
  writeFileSync(mutatePlan, "opaque plan\n");
  const mutator = fakeTerraform(mutateRoot, "mutate");
  assert.equal(silent(() => runContinuityCommand(args(mutateRoot, mutator.executable, mutatePlan).values)), 2);

  const malformedRoot = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-malformed-"));
  const malformedPlan = join(malformedRoot, "tfplan");
  writeFileSync(malformedPlan, "opaque plan\n");
  const malformed = fakeTerraform(malformedRoot, "malformed");
  assert.equal(silent(() => runContinuityCommand(args(malformedRoot, malformed.executable, malformedPlan).values)), 2);

  const symlinkRoot = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-symlink-"));
  const realPlan = join(symlinkRoot, "real-plan");
  const linkedPlan = join(symlinkRoot, "linked-plan");
  writeFileSync(realPlan, "opaque plan\n");
  symlinkSync(realPlan, linkedPlan);
  const terraform = fakeTerraform(symlinkRoot);
  assert.equal(silent(() => runContinuityCommand(args(symlinkRoot, terraform.executable, linkedPlan).values)), 2);
  assert.equal(existsSync(terraform.invocation), false);
});

test("the Terraform gate rejects unsafe plan and Terraform output shapes", { skip: process.platform === "win32" }, () => {
  for (const mode of ["invalid-document", "invalid-version", "invalid-actions", "unsupported-actions", "nonzero"] as const) {
    const root = mkdtempSync(join(tmpdir(), `agent-vigil-terraform-${mode}-`));
    const plan = join(root, "tfplan");
    writeFileSync(plan, "opaque plan\n");
    const terraform = fakeTerraform(root, mode);
    assert.equal(silent(() => runContinuityCommand(args(root, terraform.executable, plan).values)), 2, mode);
  }

  const emptyChangesRoot = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-empty-changes-"));
  const emptyChangesPlan = join(emptyChangesRoot, "tfplan");
  writeFileSync(emptyChangesPlan, "opaque plan\n");
  const emptyChangesTerraform = fakeTerraform(emptyChangesRoot, "empty-changes");
  const emptyChangesCommand = args(emptyChangesRoot, emptyChangesTerraform.executable, emptyChangesPlan);
  assert.equal(silent(() => runContinuityCommand(emptyChangesCommand.values)), 0);
  assert.equal(JSON.parse(readFileSync(emptyChangesCommand.output, "utf8")).plan.resourceChanges, 0);

  const emptyPlanRoot = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-empty-plan-"));
  const emptyPlan = join(emptyPlanRoot, "tfplan");
  writeFileSync(emptyPlan, "");
  const emptyPlanTerraform = fakeTerraform(emptyPlanRoot);
  assert.equal(silent(() => runContinuityCommand(args(emptyPlanRoot, emptyPlanTerraform.executable, emptyPlan).values)), 2);
  assert.equal(existsSync(emptyPlanTerraform.invocation), false);

  const directoryRoot = mkdtempSync(join(tmpdir(), "agent-vigil-terraform-directory-plan-"));
  const directoryPlan = join(directoryRoot, "tfplan");
  mkdirSync(directoryPlan);
  const directoryTerraform = fakeTerraform(directoryRoot);
  assert.equal(silent(() => runContinuityCommand(args(directoryRoot, directoryTerraform.executable, directoryPlan).values)), 2);
  assert.equal(existsSync(directoryTerraform.invocation), false);
});
