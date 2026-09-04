import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { buildSync } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WORKFLOW_DIRECTORY = new URL("../.github/workflows/", import.meta.url);
const REVIEWED_RUNTIME_PLACEHOLDER = "REVIEWED_40_HEX_AGENT_VIGIL_COMMIT";

function workflowSources(): Array<{ name: string; text: string }> {
  return readdirSync(WORKFLOW_DIRECTORY)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({
      name,
      text: readFileSync(new URL(name, WORKFLOW_DIRECTORY), "utf8").replaceAll("\r\n", "\n"),
    }));
}

function actionReferences(text: string, sourceName: string): string[] {
  const references: string[] = [];
  let blockScalarIndent: number | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    const indentation = line.length - line.trimStart().length;
    if (blockScalarIndent !== undefined) {
      if (line.trim().length === 0 || indentation > blockScalarIndent) continue;
      blockScalarIndent = undefined;
    }
    if (line.trimStart().startsWith("#")) continue;
    if (/:\s*[|>](?:(?:[1-9][+-]?)|(?:[+-][1-9]?))?\s*(?:#.*)?$/.test(line)) {
      blockScalarIndent = indentation;
      continue;
    }
    if (!/^\s*(?:-\s*)?(?:uses|["']uses["'])\s*:/.test(line)) continue;
    const match = /^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(?:#.*)?$/.exec(line);
    assert.ok(match, `${sourceName}:${index + 1} must use canonical, unquoted uses: syntax`);
    references.push(match[1]);
  }
  return references;
}

function jobBlocks(text: string, sourceName = "workflow"): Array<{ name: string; text: string }> {
  const lines = text.split("\n");
  const jobs = lines.findIndex((line) => line === "jobs:");
  if (jobs < 0) return [];
  const blocks: Array<{ name: string; text: string }> = [];
  const names = new Set<string>();
  let current: { name: string; lines: string[] } | undefined;
  for (const line of lines.slice(jobs + 1)) {
    const match = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) {
      if (current) blocks.push({ name: current.name, text: current.lines.join("\n") });
      assert.ok(!names.has(match[1]), `${sourceName} repeats the ${match[1]} job`);
      names.add(match[1]);
      current = { name: match[1], lines: [line] };
    } else if (/^  \S/.test(line) && !line.trimStart().startsWith("#")) {
      assert.fail(`${sourceName} has a non-canonical job declaration: ${line.trim()}`);
    } else if (/^\S/.test(line)) {
      break;
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) blocks.push({ name: current.name, text: current.lines.join("\n") });
  return blocks;
}

type PermissionAccess = "read" | "write" | "none";
type PermissionMap = Record<string, PermissionAccess>;

function canonicalPermissions(
  text: string,
  indentation: number,
  sourceName: string,
): PermissionMap | undefined {
  const lines = text.split("\n");
  const prefix = " ".repeat(indentation);
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => new RegExp(`^${prefix}permissions\\s*:`).test(line));
  assert.ok(candidates.length <= 1, `${sourceName} must declare permissions at most once`);
  if (candidates.length === 0) return undefined;

  const [{ line, index }] = candidates;
  if (line === `${prefix}permissions: {}`) return {};
  assert.equal(line, `${prefix}permissions:`, `${sourceName} permissions must use a canonical block map or {}`);

  const permissions: PermissionMap = {};
  for (const candidate of lines.slice(index + 1)) {
    if (candidate.trim().length === 0 || candidate.trimStart().startsWith("#")) continue;
    const leading = candidate.length - candidate.trimStart().length;
    if (leading <= indentation) break;
    assert.equal(leading, indentation + 2, `${sourceName} has a nested or non-canonical permission entry`);
    const match = new RegExp(`^${" ".repeat(indentation + 2)}([a-z][a-z-]*): (read|write|none)$`).exec(candidate);
    assert.ok(match, `${sourceName} has a non-canonical permission entry: ${candidate.trim()}`);
    assert.ok(!(match[1] in permissions), `${sourceName} repeats the ${match[1]} permission`);
    permissions[match[1]] = match[2] as PermissionAccess;
  }
  return permissions;
}

function permissionSignature(permissions: PermissionMap): string[] {
  return Object.entries(permissions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, access]) => `${name}:${access}`);
}

function stepBlocks(jobText: string, sourceName: string): string[] {
  const lines = jobText.split("\n");
  const stepsIndex = lines.findIndex((line) => line === "    steps:");
  assert.ok(stepsIndex >= 0, `${sourceName} must declare a canonical steps block`);
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines.slice(stepsIndex + 1)) {
    if (/^      - (?:id|name|run|uses):/.test(line)) {
      if (current) blocks.push(current);
      current = [line];
      continue;
    }
    if (!current) {
      if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
      assert.fail(`${sourceName} has content before its first canonical step`);
    }
    current.push(line);
  }
  if (current) blocks.push(current);
  assert.ok(blocks.length > 0, `${sourceName} must contain at least one step`);
  return blocks.map((block) => block.join("\n").trimEnd());
}

function stepFingerprint(step: string, sourceName: string): string {
  const lines = step.split("\n");
  const uses = lines
    .map((line) => /^\s*(?:-\s*)?uses:\s*([^\s#]+)\s*(?:#.*)?$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  const runs = lines.filter((line) => /^\s*(?:-\s*)?run:\s*(?:\||>[-+]?)?\s*$/.test(line));
  assert.equal(uses.length + runs.length, 1, `${sourceName} steps must contain exactly one uses or block-run entry`);
  const kind = uses.length === 1 ? `uses=${uses[0]}` : "run";
  const digest = createHash("sha256").update(step).digest("hex");
  return `${kind}|${digest}`;
}

function packedPackagePaths(): string[] {
  const npmArguments = ["pack", "--json", "--dry-run", "--ignore-scripts"];
  const options = {
    cwd: ROOT,
    encoding: "utf8" as const,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_ignore_scripts: "true",
    },
    maxBuffer: 16 * 1024 * 1024,
  };
  const npmExecPath = process.env.npm_execpath;
  const output = npmExecPath
    ? execFileSync(process.execPath, [npmExecPath, ...npmArguments], options)
    : process.platform === "win32"
      ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${npmArguments.join(" ")}`], options)
      : execFileSync("npm", npmArguments, options);
  const result = JSON.parse(output) as unknown;
  assert.ok(Array.isArray(result) && result.length === 1, "npm pack --dry-run must describe exactly one package");
  const entry = result[0] as { files?: unknown };
  assert.ok(Array.isArray(entry.files), "npm pack --dry-run must return its concrete file manifest");
  return entry.files.map((file, index) => {
    const path = (file as { path?: unknown }).path;
    if (typeof path !== "string") assert.fail(`npm pack manifest entry ${index} must have a string path`);
    return path;
  });
}

function manifestEntryCoversPath(entry: string, path: string): boolean {
  const normalized = entry.replace(/\/+$/, "");
  return path === normalized || path.startsWith(`${normalized}/`);
}

test("npm package surface excludes internal product and commercial working documents", () => {
  const packageDocument = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    contentPolicy?: unknown;
    files?: unknown;
    publishConfig?: unknown;
  };
  assert.deepEqual(packageDocument.contentPolicy, { class: "dual-use" });
  assert.deepEqual(packageDocument.publishConfig, { access: "public", provenance: true });
  const disclosure = new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(new URL("../DISCLOSURE", import.meta.url)),
  );
  assert.match(disclosure, /defensive security and change-control utility/);
  assert.match(disclosure, /only on systems and repositories\s+you own or are explicitly authorized to assess/);
  assert.doesNotMatch(disclosure, /\0/, "DISCLOSURE must contain only text");
  assert.ok(Array.isArray(packageDocument.files));
  const files = packageDocument.files as string[];
  for (const [index, entry] of files.entries()) {
    assert.equal(typeof entry, "string", `package.json files[${index}] must be a string`);
    assert.ok(entry.length > 0 && !entry.startsWith("/") && !entry.includes("\\"), `${entry} must be a relative POSIX path`);
    assert.doesNotMatch(entry, /(?:^|\/)\.\.?(?:\/|$)/, `${entry} must not contain traversal segments`);
    for (const metacharacter of ["*", "?", "[", "]", "{", "}", "!"]) {
      assert.ok(!entry.includes(metacharacter), `${entry} must not use a package-surface glob`);
    }
  }

  assert.ok(!files.includes("docs"), "the whole docs tree must not be published");
  const internalPaths = [
    "docs/COMMERCIAL_GATES.md",
    "docs/CONTROL_PLANE.md",
    "docs/IMPLEMENTED_DIFFERENTIATION_2026-08-22.md",
    "docs/MARKET_RADAR_2026-08-22.md",
    "docs/PRODUCT_DISCOVERY_2026-08-22.md",
    "docs/PUBLISHING.md",
    "docs/RESEARCH.md",
    "docs/research",
    "docs/index.html",
  ];
  for (const internalPath of internalPaths) {
    assert.ok(
      !files.some((entry) => manifestEntryCoversPath(entry, internalPath)),
      `${internalPath} must remain outside the npm package`,
    );
  }

  const allowedPublishedDocs = [
    "docs/60_SECOND_DEMO.md",
    "docs/ADOPTION_EVIDENCE.md",
    "docs/AGENT_VALUE_CARD.md",
    "docs/AGENT_CONTROL_ADMISSION.md",
    "docs/AGENT_CONTROL_RELEASE_GATE_RUNBOOK.md",
    "docs/AI_CHANGE_EPISODE_V1.md",
    "docs/AI_CHANGE_RECEIPT.md",
    "docs/assets/outcome-verifier-demo.html",
    "docs/ATTESTED_RECEIPTS.md",
    "docs/AUTHORITY_PLAN.md",
    "docs/AUTHORITY_RECONCILIATION.md",
    "docs/BENCHMARKS.md",
    "docs/COMPATIBILITY.md",
    "docs/CONTINUITY.md",
    "docs/CONTINUITY_LAB.md",
    "docs/CONTINUITY_STAPLE.md",
    "docs/CONTROL_PROOF.md",
    "docs/EXACT_COST_EVIDENCE.md",
    "docs/GITHUB_MARKER.md",
    "docs/GITHUB_OUTCOME_EVIDENCE.md",
    "docs/GUARD_COMPATIBILITY.md",
    "docs/GUARD_CONTINUITY.md",
    "docs/HOSTED_SECURITY_CONTRACT.md",
    "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md",
    "docs/KUBERNETES_ADMISSION.md",
    "docs/LIVE_HOST_ROUTE.md",
    "docs/MERGE_QUEUES.md",
    "docs/NOTARY_APP.md",
    "docs/OUTCOME_OBSERVER.md",
    "docs/PRIVATE_RECEIPT_GATE.md",
    "docs/HOSTED_OUTCOME_PRICING.md",
    "docs/OUTCOME_MANDATES.md",
    "docs/PROOF_COMMENT.md",
    "docs/PROTECTED_RUN.md",
    "docs/PUBLIC_PR_RECEIPT.md",
    "docs/PUBLIC_RELEASE_POLICY.md",
    "docs/RECEIPT_DELTAS.md",
    "docs/RECEIPTS.md",
    "docs/RUN_AUTOPSY.md",
    "docs/TERRAFORM_PLAN_GATE.md",
    "docs/TEST_INTEGRITY_GUARD.md",
    "docs/THREAT_MODEL.md",
    "docs/TYPESCRIPT_CONTINUITY_LIBRARY.md",
    "docs/UPGRADE_GUARD.md",
    "docs/VALUE_COMPARISONS.md",
    "docs/ai-change-receipt-predicate-v1.schema.json",
    "docs/assets/agent-value-card-demo.html",
    "docs/assets/agent-value-comparison-demo.html",
    "docs/assets/agent-value-comparison-demo.json",
    "docs/assets/agent-vigil-demo.gif",
    "docs/authority-contract-v1.schema.json",
    "docs/adoption-evidence-v1.schema.json",
    "docs/authority-plan-policy-v1.schema.json",
    "docs/authority-plan-v1.schema.json",
    "docs/compatibility-entry-v1.schema.json",
    "docs/continuity-event-v1.schema.json",
    "docs/continuity-policy-v1.schema.json",
    "docs/control-certificate-v1.schema.json",
    "docs/control-certificate-v2.schema.json",
    "docs/control-corpus-entry-v1.schema.json",
    "docs/control-corpus-entry-v2.schema.json",
    "docs/control-policy-v1.schema.json",
    "docs/control-proof-predicate-v1.schema.json",
    "docs/control-status-v1.schema.json",
    "docs/continuity-staple-v1.schema.json",
    "docs/guard-compatibility-v1.schema.json",
    "docs/guard-environment-binding-v1.schema.json",
    "docs/guard-environment-v1.schema.json",
    "docs/guard-policy-files-v1.schema.json",
    "docs/guard-route-envelope-v1.schema.json",
    "docs/guard-route-diff-v1.schema.json",
    "docs/guard-control-challenge-v1.schema.json",
    "docs/guard-control-observation-v1.schema.json",
    "docs/guard-control-isolation-v1.schema.json",
    "docs/guard-control-admission-v1.schema.json",
    "docs/guard-deployment-authorization-v1.schema.json",
    "docs/guard-deployment-registration-v1.schema.json",
    "docs/live-host-route-v1.schema.json",
    "docs/live-host-route-v2.schema.json",
    "docs/notary-app-manifest.example.json",
    "docs/policy.schema.json",
    "docs/portable-receipt-v1.schema.json",
    "docs/public-pr-receipt-v1.schema.json",
    "docs/protected-run-v1.schema.json",
    "docs/outcome-mandate-v0.1.schema.json",
    "docs/outcome-receipt-v0.1.schema.json",
    "docs/receipt-v2.schema.json",
    "docs/run-autopsy-v1.schema.json",
    "docs/signed-control-proof-v1.schema.json",
    "docs/upgrade-canary-v1.schema.json",
    "docs/upgrade-config-v1.schema.json",
    "docs/upgrade-receipt-v1.schema.json",
  ];
  const allowedPublishedHosted = [
    "hosted/merge-queue-dispatcher/README.md",
    "hosted/merge-queue-dispatcher/github-app-manifest.example.json",
    "hosted/merge-queue-dispatcher/src/index.mjs",
    "hosted/merge-queue-dispatcher/wrangler.jsonc",
  ];
  const allowedPublishedWorkflows = [
    ".github/workflows/agent-vigil-merge-group.yml",
    ".github/workflows/public-app-gate.yml",
  ];
  const allowedPublishedHostedTests = [
    "test-hosted/merge-queue-dispatcher.test.ts",
  ];
  const requiredPublicPaths = [
    "DISCLOSURE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    ...allowedPublishedDocs,
    "proof/README.md",
    "proof/cases",
    "proof/outcome-cases",
    "hosted/merge-queue-dispatcher",
    ...allowedPublishedWorkflows,
    ...allowedPublishedHostedTests,
  ];
  for (const publicPath of requiredPublicPaths) {
    assert.ok(files.includes(publicPath), `${publicPath} must ship with the npm package`);
    assert.ok(existsSync(join(ROOT, publicPath)), `${publicPath} must exist before publishing`);
  }

  const packedPaths = packedPackagePaths();
  assert.equal(new Set(packedPaths).size, packedPaths.length, "npm pack manifest paths must be unique");
  assert.ok(packedPaths.includes("DISCLOSURE"), "DISCLOSURE must be at the root of the concrete npm package");
  assert.ok(packedPaths.includes("dist/run-telemetry-worker.js"), "the protected-run telemetry worker must ship with the CLI");
  for (const packedPath of packedPaths) {
    assert.ok(
      packedPath === "package.json" || files.some((entry) => manifestEntryCoversPath(entry, packedPath)),
      `${packedPath} is not authorized by the exact package files manifest`,
    );
    assert.ok(
      !internalPaths.some((internalPath) => manifestEntryCoversPath(internalPath, packedPath)),
      `${packedPath} is an internal document and must not be packed`,
    );
    if (packedPath.startsWith("docs/")) {
      assert.ok(allowedPublishedDocs.includes(packedPath), `${packedPath} is not in the reviewed public-doc allowlist`);
    }
    if (packedPath.startsWith("hosted/")) {
      assert.ok(allowedPublishedHosted.includes(packedPath), `${packedPath} is not in the reviewed hosted-source allowlist`);
    }
    if (packedPath.startsWith(".github/workflows/")) {
      assert.ok(allowedPublishedWorkflows.includes(packedPath), `${packedPath} is not in the reviewed workflow allowlist`);
    }
    if (packedPath.startsWith("test-hosted/")) {
      assert.ok(allowedPublishedHostedTests.includes(packedPath), `${packedPath} is not in the reviewed hosted-test allowlist`);
    }
  }
  for (const publicDocument of allowedPublishedDocs) {
    assert.ok(packedPaths.includes(publicDocument), `${publicDocument} must appear in the concrete npm pack manifest`);
  }
  for (const hostedPath of allowedPublishedHosted) {
    assert.ok(packedPaths.includes(hostedPath), `${hostedPath} must appear in the concrete npm pack manifest`);
  }
  for (const workflowPath of allowedPublishedWorkflows) {
    assert.ok(packedPaths.includes(workflowPath), `${workflowPath} must appear in the concrete npm pack manifest`);
  }
  for (const testPath of allowedPublishedHostedTests) {
    assert.ok(packedPaths.includes(testPath), `${testPath} must appear in the concrete npm pack manifest`);
  }
});

test("repository protection runs one direct offline test contract after bounded setup", () => {
  const policy = JSON.parse(readFileSync(new URL("../.agent-vigil.json", import.meta.url), "utf8")) as {
    integrityMode?: unknown;
    testCommand?: unknown;
    maintainer?: {
      protectedPaths?: unknown;
      differentialTest?: { command?: unknown; setupCommand?: unknown };
      automatedReview?: { commands?: unknown; setupCommand?: unknown };
    };
  };
  const directTest = "node --test --test-concurrency=1 test-hosted/*.test.ts";
  assert.equal(policy.integrityMode, "calibrated");
  assert.equal(policy.testCommand, directTest);
  assert.equal(policy.maintainer?.differentialTest?.command, directTest);
  assert.equal(policy.maintainer?.differentialTest?.setupCommand, "npm ci --ignore-scripts");
  assert.deepEqual(policy.maintainer?.automatedReview?.commands, [directTest]);
  assert.equal(policy.maintainer?.automatedReview?.setupCommand, "npm ci --ignore-scripts");
  assert.ok(Array.isArray(policy.maintainer?.protectedPaths));
  assert.ok((policy.maintainer?.protectedPaths as string[]).includes(".agent-vigil.json"));
  assert.ok((policy.maintainer?.protectedPaths as string[]).includes(".github/workflows/**"));
  assert.ok((policy.maintainer?.protectedPaths as string[]).includes("dist/cli.js"));
  assert.ok((policy.maintainer?.protectedPaths as string[]).includes("dist/run-telemetry-worker.js"));
  assert.ok((policy.maintainer?.protectedPaths as string[]).includes("scripts/build_cli.mjs"));
  assert.ok((policy.maintainer?.protectedPaths as string[]).includes("test/package-surface.test.ts"));
});

test("repository workflows and the composite Action use immutable dependencies", () => {
  const sources = [
    ...workflowSources(),
    { name: "action.yml", text: readFileSync(new URL("../action.yml", import.meta.url), "utf8") },
  ];
  const pendingSelfPins: string[] = [];
  let referenceCount = 0;

  for (const source of sources) {
    for (const reference of actionReferences(source.text, source.name)) {
      referenceCount += 1;
      assert.doesNotMatch(reference, /^\.\.?(?:\/|$)/, `${source.name} must not execute a local Action`);
      if (reference === `sulmusic2-star/agent-vigil@${REVIEWED_RUNTIME_PLACEHOLDER}`) {
        assert.ok(
          source.name === "agent-vigil.yml" || source.name === "agent-vigil-outcomes.yml" || source.name === "control-proof-weekly.yml",
          `${source.name} must not use the pending reviewed-runtime placeholder`,
        );
        pendingSelfPins.push(source.name);
        continue;
      }
      assert.match(reference, /@[0-9a-f]{40}$/, `${source.name} has a mutable Action reference: ${reference}`);
    }
  }

  assert.ok(referenceCount > 0, "expected at least one Action dependency");
  if (pendingSelfPins.length > 0) {
    assert.deepEqual(
      pendingSelfPins.sort(),
      ["agent-vigil-outcomes.yml", "agent-vigil.yml", "control-proof-weekly.yml"],
      "the unresolved self pin must be identical and limited to the evidence, outcome, and weekly proof workflows",
    );
  }
});

test("candidate CI never masquerades as trusted Agent Vigil evidence", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(ci, /^\s*(?:-\s*)?uses:\s*\.\/?\s*$/m);
  assert.doesNotMatch(ci, /name:\s*Agent Vigil evidence/);
  assert.match(ci, /not trusted evidence/);
  assert.match(ci, /AGENT_VIGIL_REQUIRE_REAL_DOCKER:\s*"true"/);
  assert.match(ci, /node@sha256:[0-9a-f]{64}/);
  assert.match(ci, /docker image inspect/);
  assert.match(ci, /Run protected group regression under a non-reaping PID 1/);
  assert.match(ci, /docker exec "\$container" node --import tsx --test --test-concurrency=1/);
  assert.match(
    ci,
    /- name: Exercise the packed package\n\s+if: matrix\.node == 20 \|\| matrix\.node == 22\n\s+run: npm run test:package/,
    "the minimum supported Node runtime exercises the generated package worker",
  );
  const portability = ci.match(/\n  portability:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n)/)?.[1];
  assert.ok(portability, "candidate CI retains its portability job");
  const textContract = portability.indexOf("git config --global core.autocrlf false");
  const checkout = portability.indexOf("uses: actions/checkout@");
  assert.ok(textContract >= 0 && checkout > textContract, "Windows fixture text is stabilized before checkout");
});

test("workflow permissions and privileged steps are exact fail-closed contracts", () => {
  const expectedTopLevelPermissions: Record<string, string[]> = {
    "adoption-census.yml": ["contents:read"],
    "agent-vigil-continuity-lab.yml": ["contents:read"],
    "agent-vigil-merge-group.yml": ["contents:read"],
    "agent-vigil-outcomes.yml": ["actions:read", "contents:read", "pull-requests:read"],
    "agent-vigil.yml": ["contents:read", "pull-requests:read"],
    "ci.yml": ["contents:read"],
    "codeql.yml": ["contents:read"],
    "control-proof-weekly.yml": [],
    "cross-corpus-benchmark.yml": ["contents:read"],
    "publish-hermetic-runner.yml": ["contents:read", "packages:write"],
    "publish.yml": [],
    "public-app-gate.yml": ["contents:read"],
  };
  const expectedEffectiveJobPermissions: Record<string, string[]> = {
    "adoption-census.yml:census": ["contents:read"],
    "agent-vigil-continuity-lab.yml:blocked-deployment": ["contents:read"],
    "agent-vigil-continuity-lab.yml:demonstration": ["contents:read"],
    "agent-vigil-continuity-lab.yml:repaired-action": ["contents:read"],
    "agent-vigil-merge-group.yml:authenticate": ["contents:read"],
    "agent-vigil-merge-group.yml:evidence": ["contents:read"],
    "agent-vigil-merge-group.yml:governed-queue-check": ["contents:read"],
    "agent-vigil-outcomes.yml:outcome": ["actions:read", "contents:read", "pull-requests:read"],
    "agent-vigil.yml:evidence": ["contents:read", "pull-requests:read"],
    "agent-vigil.yml:governed-head-check": ["pull-requests:read"],
    "ci.yml:candidate-ci": ["contents:read"],
    "ci.yml:candidate-isolation-regression": ["contents:read"],
    "ci.yml:portability": ["contents:read"],
    "codeql.yml:analyze": ["contents:read", "security-events:write"],
    "control-proof-weekly.yml:attest-proof": [
      "actions:read",
      "artifact-metadata:write",
      "attestations:write",
      "contents:read",
      "id-token:write",
    ],
    "control-proof-weekly.yml:build-proof": ["contents:read"],
    "cross-corpus-benchmark.yml:benchmark": ["contents:read"],
    "publish-hermetic-runner.yml:publish": ["contents:read", "packages:write"],
    "publish.yml:publish": ["actions:read", "id-token:write"],
    "publish.yml:verify-and-pack": ["contents:read"],
    "public-app-gate.yml:authenticate": ["contents:read"],
    "public-app-gate.yml:evidence": ["contents:read"],
    "public-app-gate.yml:publish": ["contents:read"],
  };
  const expectedPrivilegedSteps: Record<string, string[]> = {
    "control-proof-weekly.yml:attest-proof": [
      "uses=actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0|64b4f35dc6780d7f02680763767ffd7d41558dd154caa597dfab69172ebf9e8e",
      "run|65e96cd6e94e1883dae07be73530634729c027b30e27ab8af34eaf932bf2734f",
      "uses=actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6|c9cc1d7163a258c94d57165041142cf6f605c61b17d49ec16581ad0a9be84dd9",
      "uses=actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02|16faa1e3dec4a01308913952efc4fea320aaf88c4b41d614d2633dfff71238ca",
    ],
    "publish.yml:publish": [
      "uses=actions/setup-node@820762786026740c76f36085b0efc47a31fe5020|67e07e2dfa04f8a7834dbd56f20be3c32ae679f3b5b9f0ce3476c9864f72a265",
      "uses=actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0|72a8e30d016a37162721c9d6a45a2d0594c127a2b8b2cf6ed3c5ee1fab47ad2b",
      "run|e31d77739bfdb506f1376095aa907f5218db62499f504f1ef40d816c4af661e1",
    ],
  };
  const expectedPrivilegedWorkflowDigests: Record<string, string> = {
    "control-proof-weekly.yml": "9fd3e022901f9e990fa02467b12e9d7c9fa1000e7d4e2d506882b3cfd74c6fb2",
    "publish.yml": "94658e1c855256cdc26b8964fce044c1f89cbfbc8612bd75e60eda4b7112cc71",
  };

  const workflows = workflowSources();
  assert.deepEqual(
    workflows.map(({ name }) => name),
    Object.keys(expectedTopLevelPermissions).sort(),
    "every workflow must have an enumerated permission contract",
  );

  const actualEffectiveJobPermissions: Record<string, string[]> = {};
  const actualPrivilegedSteps: Record<string, string[]> = {};
  for (const workflow of workflows) {
    for (const [index, line] of workflow.text.split("\n").entries()) {
      if (line.trimStart().startsWith("#") || !/\bpermissions\b/.test(line)) continue;
      assert.match(line, /^\s*permissions:\s*(?:\{\})?\s*$/, `${workflow.name}:${index + 1} has a hidden or non-canonical permissions key`);
    }
    assert.doesNotMatch(workflow.text, /^\s*permissions\s*:\s*(?:read-all|write-all)\s*$/m, `${workflow.name} must not use scalar permissions`);
    assert.doesNotMatch(
      workflow.text,
      /^\s*(?:<<\s*:|[A-Za-z0-9_-]+\s*:\s*[&*][A-Za-z0-9_-]+)\s*$/m,
      `${workflow.name} must not hide permissions or steps behind YAML aliases`,
    );
    const topLevel = canonicalPermissions(workflow.text, 0, workflow.name);
    assert.ok(topLevel, `${workflow.name} must declare top-level permissions explicitly`);
    assert.deepEqual(permissionSignature(topLevel), expectedTopLevelPermissions[workflow.name]);

    const expectedWorkflowDigest = expectedPrivilegedWorkflowDigests[workflow.name];
    if (expectedWorkflowDigest) {
      const actualWorkflowDigest = createHash("sha256").update(workflow.text.trimEnd()).digest("hex");
      assert.equal(actualWorkflowDigest, expectedWorkflowDigest, `${workflow.name} privileged workflow contract changed`);
    }

    for (const job of jobBlocks(workflow.text, workflow.name)) {
      const key = `${workflow.name}:${job.name}`;
      const declared = canonicalPermissions(job.text, 4, key);
      const effective = declared ?? topLevel;
      const signature = permissionSignature(effective);
      actualEffectiveJobPermissions[key] = signature;
      if (effective["id-token"] === "write") {
        actualPrivilegedSteps[key] = stepBlocks(job.text, key).map((step) => stepFingerprint(step, key));
      }
    }
  }

  assert.deepEqual(
    Object.keys(actualEffectiveJobPermissions).sort(),
    Object.keys(expectedEffectiveJobPermissions).sort(),
    "every workflow job must have an enumerated effective permission contract",
  );
  for (const [job, permissions] of Object.entries(expectedEffectiveJobPermissions)) {
    assert.deepEqual(actualEffectiveJobPermissions[job], permissions, `${job} permissions changed`);
  }
  assert.deepEqual(
    Object.keys(actualPrivilegedSteps).sort(),
    Object.keys(expectedPrivilegedSteps).sort(),
    "only the two reviewed jobs may receive an OIDC token",
  );
  for (const [job, fingerprints] of Object.entries(expectedPrivilegedSteps)) {
    assert.deepEqual(actualPrivilegedSteps[job], fingerprints, `${job} steps or commands changed`);
  }
});

test("privileged workflows bind event identity and validate bounded artifacts", () => {
  const publish = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const controlProof = readFileSync(new URL("../.github/workflows/control-proof-weekly.yml", import.meta.url), "utf8");

  assert.doesNotMatch(publish, /^  release:/m, "npm staging must precede the public GitHub release");
  assert.doesNotMatch(publish, /workflow_dispatch/, "publishing must not execute branch-selected workflow bytes");
  assert.match(publish, /^  push:\n    tags:\n      - "v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"$/m);
  assert.equal(
    (publish.match(/github\.event_name == 'push'/g) ?? []).length,
    2,
    "both jobs must require the immutable stable-tag push used to stage npm before the public GitHub release",
  );
  assert.equal((publish.match(/github\.ref_type == 'tag'/g) ?? []).length, 2);
  assert.equal((publish.match(/startsWith\(github\.ref, 'refs\/tags\/v'\)/g) ?? []).length, 2);
  assert.match(publish, /git merge-base --is-ancestor "\$GITHUB_SHA" "refs\/remotes\/origin\/\$DEFAULT_BRANCH"/);
  assert.match(publish, /ref:\s*\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(publish, /ref:\s*\$\{\{ steps\.release\.outputs\.tag \}\}/);
  assert.match(publish, /^\s{4}environment:\s*npm-publish\s*$/m);
  assert.match(publish, /same environment in npm Trusted Publisher/);
  assert.match(publish, /release-envelope\.json/);
  assert.match(publish, /tarball exceeds the 16 MiB bound/);
  assert.match(publish, /unpacked size exceeds the 64 MiB bound/);
  assert.match(publish, /file count exceeds the 512-file bound/);
  assert.match(publish, /package manifest is invalid or exceeds the 256 KiB bound/);
  const artifactPreflight = publish.indexOf("release artifact root must be a regular non-symlink directory");
  const archiveParser = publish.indexOf('const { gunzipSync } = require("node:zlib")');
  assert.ok(artifactPreflight >= 0 && archiveParser > artifactPreflight, "outer artifact type and size checks must precede archive parsing");
  assert.doesNotMatch(publish, /^\s*tar\s/m, "the privileged job must not delegate tar validation to a path-only listing");
  assert.match(publish, /links, devices, FIFOs, and PAX headers are forbidden/);
  assert.match(publish, /release archive paths or sizes do not match npm-pack\.json/);
  assert.match(publish, /maxOutputLength: MAX_TAR_STREAM_BYTES/);
  assert.match(publish, /--registry=https:\/\/registry\.npmjs\.org/);
  assert.match(publish, /release archive must contain a root DISCLOSURE file exactly once/);
  assert.match(publish, /package manifest must declare the exact dual-use content policy/);
  assert.match(publish, /package manifest must require public access and provenance/);
  for (const jobName of ["verify-and-pack", "publish"]) {
    const job = jobBlocks(publish, "publish.yml").find(({ name }) => name === jobName);
    assert.ok(job, `publish.yml must retain the ${jobName} job`);
    assert.match(job.text, /npm 11\.15\.0 or newer is required/);
    assert.match(job.text, /major < 11 \|\| \(major === 11 && minor < 15\)/);
  }
  assert.match(publish, /npm stage publish "\$TARBALL" --ignore-scripts --access public --tag latest --provenance --registry=https:\/\/registry\.npmjs\.org/);
  assert.doesNotMatch(publish, /npm publish "\$TARBALL"/, "the OIDC job must not publish directly");
  assert.doesNotMatch(publish, /Registry verification attempt|sleep 10/, "the staging job must not pretend the package is already public");

  assert.equal(
    (controlProof.match(/github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/g) ?? []).length,
    2,
    "both control-proof jobs must be restricted to the repository default branch",
  );
  assert.doesNotMatch(controlProof, /workflow_dispatch|npm\s|dist\/cli\.js|control-certificate|control-corpus|control-policy|control-status/);
  const unprivilegedControlProof = controlProof.slice(controlProof.indexOf("  build-proof:"), controlProof.indexOf("  attest-proof:"));
  assert.match(unprivilegedControlProof, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/);
  assert.match(unprivilegedControlProof, /sulmusic2-star\/agent-vigil@[0-9a-f]{40}/);
  assert.match(unprivilegedControlProof, /mode:\s*prove/);
  assert.match(unprivilegedControlProof, /attest:\s*false/);
  const privilegedControlProof = controlProof.slice(controlProof.indexOf("  attest-proof:"));
  assert.match(privilegedControlProof, /must contain exactly the proof and predicate/);
  assert.match(privilegedControlProof, /constants\.O_NOFOLLOW/);
  assert.match(privilegedControlProof, /proof\.sourceCommit !== expectedSourceCommit/);
  assert.match(privilegedControlProof, /control proof receipt hash is invalid/);
  assert.match(privilegedControlProof, /predicate\.proof\.fileSha256 !== sha256\(proofBytes\)/);
  assert.match(privilegedControlProof, /predicate\.proof\.challengeSetSha256 !== sha256\(canonical\(challengeSet\)\)/);
  assert.doesNotMatch(privilegedControlProof, /actions\/checkout@|actions\/setup-node@|sulmusic2-star\/agent-vigil@|npm\s|dist\/cli\.js/);
});

test("weekly signer rejects a bounded predicate forged away from its proof", () => {
  const workflow = readFileSync(new URL("../.github/workflows/control-proof-weekly.yml", import.meta.url), "utf8")
    .replaceAll("\r\n", "\n");
  const embedded = / {10}node <<'NODE'\n([\s\S]*?)\n {10}NODE/.exec(workflow);
  assert.ok(embedded, "weekly workflow must expose one extractable semantic validator");
  const validatorSource = embedded[1]
    .split("\n")
    .map((line) => {
      assert.match(line, /^ {10}/, "embedded validator lines must retain canonical YAML indentation");
      return line.slice(10);
    })
    .join("\n");

  const temporary = mkdtempSync(join(tmpdir(), "agent-vigil-weekly-validator-"));
  const proofDirectory = join(temporary, "proof");
  mkdirSync(proofDirectory);
  const validatorPath = join(temporary, "validator.cjs");
  const proofPath = join(proofDirectory, "agent-vigil-report.json");
  const predicatePath = join(proofDirectory, "agent-vigil-control-proof-predicate.json");
  writeFileSync(validatorPath, validatorSource);

  const sourceCommit = "1".repeat(40);
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) as string;
  };
  const sha256 = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const challenge = {
    id: "bounded-forgery",
    claim: "The bounded predicate must describe this exact proof.",
    expected: "BLOCK",
    actual: "BLOCK",
    passed: true,
    base: "2".repeat(40),
    head: "3".repeat(40),
    evidence: "A deterministic validation fixture.",
  };
  const proofPayload = {
    schemaVersion: "agent-vigil-control-proof/v1",
    vigilVersion: "test-version",
    status: "PASS",
    sourceCommit,
    generatedAt: "2026-08-25T12:00:00.000Z",
    challenges: [challenge],
    summary: { passed: 1, total: 1 },
    reproduction: "agent-vigil bounded validator fixture",
    limits: [],
  };
  const proof = { ...proofPayload, receiptHash: sha256(canonical(proofPayload)) };
  const proofBytes = `${JSON.stringify(proof)}\n`;
  writeFileSync(proofPath, proofBytes);
  const challengeSet = [{ id: challenge.id, expected: challenge.expected, actual: challenge.actual, passed: challenge.passed }];
  const predicate = {
    predicateVersion: "1",
    proof: {
      schemaVersion: proof.schemaVersion,
      receiptHash: proof.receiptHash,
      fileSha256: sha256(proofBytes),
      status: proof.status,
      sourceCommit: proof.sourceCommit,
      generatedAt: proof.generatedAt,
      vigilVersion: proof.vigilVersion,
      passed: proof.summary.passed,
      total: proof.summary.total,
      challengeSetSha256: sha256(canonical(challengeSet)),
    },
    privacy: { claimsIncluded: false, evidenceIncluded: false, repositoryPathIncluded: false },
  };
  const runValidator = () => spawnSync(process.execPath, [validatorPath], {
    encoding: "utf8",
    env: { ...process.env, PROOF_DIRECTORY: proofDirectory, EXPECTED_SOURCE_COMMIT: sourceCommit },
  });

  writeFileSync(predicatePath, `${JSON.stringify(predicate)}\n`);
  const valid = runValidator();
  assert.equal(valid.status, 0, valid.stderr);

  predicate.proof.fileSha256 = `sha256:${"0".repeat(64)}`;
  writeFileSync(predicatePath, `${JSON.stringify(predicate)}\n`);
  const forged = runValidator();
  assert.notEqual(forged.status, 0, "a bounded but forged predicate must fail before signing");
  assert.match(forged.stderr, /control proof predicate is not bound to the exact proof/);
});

test("trusted PR evidence and outcome observation retain separate least-privilege contracts", () => {
  const evidence = readFileSync(new URL("../.github/workflows/agent-vigil.yml", import.meta.url), "utf8");
  const outcome = readFileSync(new URL("../.github/workflows/agent-vigil-outcomes.yml", import.meta.url), "utf8");

  assert.match(evidence, /^\s{2}pull_request_target:\s*$/m);
  assert.doesNotMatch(evidence, /^\s{2}(?:pull_request|merge_group):/m);
  assert.match(evidence, /runs-on:\s*ubuntu-24\.04/);
  assert.match(evidence, /node-version:\s*22\.23\.2/);
  assert.doesNotMatch(evidence, /^\s*node-version:\s*22\s*$/m);
  assert.ok(
    evidence.indexOf("actions/setup-node@") < evidence.indexOf("actions/checkout@"),
    "trusted Node selection must precede candidate checkout",
  );
  assert.match(evidence, /persist-credentials:\s*false/);
  assert.match(evidence, /package-manager-cache:\s*false/);
  assert.match(evidence, /policy-ref:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(evidence, /base:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(evidence, /head:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(evidence, /isolate-candidate:\s*true/);
  assert.match(evidence, /candidate-setup-cmd:\s*npm ci --ignore-scripts/);
  assert.doesNotMatch(evidence, /github-token:|attest:\s*true|id-token:\s*write|attestations:\s*write|artifact-metadata:\s*write/);

  assert.match(outcome, /^\s{2}workflow_run:\s*$/m);
  assert.doesNotMatch(outcome, /^\s{2}(?:pull_request|pull_request_target|merge_group):/m);
  assert.doesNotMatch(outcome, /actions\/checkout@/);
  assert.match(outcome, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(outcome, /node-version:\s*22\.23\.2/);
  assert.doesNotMatch(outcome, /^\s*node-version:\s*22\s*$/m);
  assert.ok(
    outcome.indexOf("actions/setup-node@") < outcome.indexOf("actions/download-artifact@"),
    "outcome runtime selection must precede evidence download",
  );
  assert.match(outcome, /mode:\s*outcome/);
  assert.match(outcome, /github-token:\s*\$\{\{ github\.token \}\}/);
  assert.doesNotMatch(outcome, /attest:\s*true|id-token:\s*write|attestations:\s*write|artifact-metadata:\s*write/);
});

test("README keeps first use simple and delegates the low-level Action contract", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /## Add it to a repository/);
  assert.match(readme, /PASS[\s\S]*FAIL[\s\S]*NOT CHECKED/);
  assert.match(readme, /hosted security contract/);
  assert.doesNotMatch(readme, /## GitHub Action/);
  assert.doesNotMatch(readme, /actions\/setup-node@|package-manager-cache:/);
});

test("the concise README points to the exact hosted-runtime security contract", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const contract = readFileSync(new URL("../docs/HOSTED_SECURITY_CONTRACT.md", import.meta.url), "utf8");
  assert.match(readme, /\[hosted security contract\]\(docs\/HOSTED_SECURITY_CONTRACT\.md\)/);
  assert.match(contract, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020|commit-pinned `setup-node` Action/);
  assert.match(contract, /Node\.js `22\.23\.2`/);
  assert.match(contract, /package-manager-cache:\s*false|no ambient or system Node fallback/);
  assert.match(contract, /fresh GitHub-hosted job with no prior untrusted step/);
  assert.match(contract, /must not execute repository code, package lifecycle scripts, or another\s+untrusted process before Agent Vigil/);
});

test("reviewed self pin and source-dist identity are a visible release gate", (context) => {
  const selfReferences = workflowSources()
    .flatMap((source) => actionReferences(source.text, source.name))
    .filter((reference) => reference.startsWith("sulmusic2-star/agent-vigil@"))
    .map((reference) => reference.slice(reference.indexOf("@") + 1));

  assert.equal(selfReferences.length, 5, "pull-request evidence, merge-queue evidence, outcomes, weekly proof, and the public App gate must each use the reviewed runtime once");
  if (selfReferences.every((reference) => reference === REVIEWED_RUNTIME_PLACEHOLDER)) {
    context.todo("replace REVIEWED_40_HEX_AGENT_VIGIL_COMMIT with the frozen reviewed runtime commit before release");
    return;
  }

  assert.ok(selfReferences.every((reference) => /^[0-9a-f]{40}$/.test(reference)), "self references must all be exact lowercase commit SHAs");
  assert.equal(new Set(selfReferences).size, 1, "evidence, outcome, and weekly proof must use the same reviewed runtime commit");
  const runtimeCommit = selfReferences[0];
  execFileSync("git", ["cat-file", "-e", `${runtimeCommit}^{commit}`], { cwd: ROOT, stdio: "pipe" });
  execFileSync("git", ["merge-base", "--is-ancestor", runtimeCommit, "HEAD"], { cwd: ROOT, stdio: "pipe" });
  execFileSync("git", [
    "diff", "--quiet", runtimeCommit, "--",
    "action.yml", "src", "dist/cli.js", "dist/run-telemetry-worker.js", "scripts/build_cli.mjs", "package.json",
  ], { cwd: ROOT, stdio: "pipe" });

  const temporary = mkdtempSync(join(tmpdir(), "agent-vigil-package-surface-"));
  buildSync({
    entryPoints: {
      cli: join(ROOT, "src", "cli.ts"),
      "run-telemetry-worker": join(ROOT, "src", "run-telemetry-worker.ts"),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outdir: temporary,
    entryNames: "[name]",
    define: { __AGENT_VIGIL_BUILD_SHA__: JSON.stringify("") },
    logLevel: "silent",
  });
  const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  for (const filename of ["cli.js", "run-telemetry-worker.js"]) {
    assert.equal(
      sha256(join(ROOT, "dist", filename)),
      sha256(join(temporary, filename)),
      `dist/${filename} must be the deterministic bundle of the pinned source`,
    );
  }
});

test("CodeQL scans maintained source while excluding deterministic bundles and hostile fixtures", () => {
  const workflow = readFileSync(new URL("../.github/workflows/codeql.yml", import.meta.url), "utf8");
  const config = readFileSync(new URL("../.github/codeql/codeql-config.yml", import.meta.url), "utf8");
  assert.match(workflow, /^\s{2}merge_group:\s*$/m);
  assert.match(workflow, /types:\s*\[checks_requested\]/);
  assert.match(workflow, /github\/codeql-action\/init@cdf488f595d80d6e07e03d4674febd5ab45fa938/);
  assert.match(workflow, /github\/codeql-action\/analyze@cdf488f595d80d6e07e03d4674febd5ab45fa938/);
  assert.match(config, /^\s{2}- src\s*$/m);
  assert.match(config, /^\s{2}- scripts\s*$/m);
  assert.match(config, /^\s{2}- hosted\s*$/m);
  assert.match(config, /^\s{2}- dist\s*$/m);
  assert.match(config, /^\s{2}- test\s*$/m);
  assert.match(config, /^\s{2}- test-hosted\s*$/m);
});
