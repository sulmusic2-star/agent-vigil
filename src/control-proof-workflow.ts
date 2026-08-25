import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { writePrivateFileAtomicWithin } from "./safe-output.ts";

const CHECKOUT_COMMIT = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_COMMIT = "820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_COMMIT = "ea165f8d65b6e75b540449e92b4886f43607fa02";
const DOWNLOAD_COMMIT = "634f93cb2916e3fdff6788551b99b062d0335ce0";
const ATTEST_COMMIT = "1e69f48acb82d1966a394da916b4c1698aa569d6";
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const MANAGED_MARKER = /^# agent-vigil-keyless-control-proof\/v[0-9]+\n/;
const MAXIMUM_EXISTING_WORKFLOW_BYTES = 1024 * 1024;

export type InstallControlProofActionResult = {
  created: string[];
  kept: string[];
  actionCommit: string;
  workflow: string;
};

function keylessControlProofWorkflow(actionCommit: string): string {
  return `# agent-vigil-keyless-control-proof/v1
name: Agent Vigil control proof

on:
  schedule:
    - cron: "17 9 * * 1"

permissions: {}

jobs:
  build-proof:
    name: Build the control proof without OIDC
    if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - name: Check out the exact scheduled commit without credentials
        uses: actions/checkout@${CHECKOUT_COMMIT}
        with:
          ref: \${{ github.sha }}
          fetch-depth: 0
          persist-credentials: false
      - name: Select trusted Node.js 22 without dependency caching
        uses: actions/setup-node@${SETUP_NODE_COMMIT}
        with:
          node-version: 22
          package-manager-cache: false
      - id: vigil
        name: Challenge the installed control without signing authority
        uses: sulmusic2-star/agent-vigil@${actionCommit}
        with:
          mode: prove
          attest: false
          repo: .
          head: \${{ github.sha }}
      - name: Validate the prepared proof outputs
        if: always()
        shell: /bin/bash --noprofile --norc -euo pipefail {0}
        env:
          CONTROL_PROOF: \${{ steps.vigil.outputs.report }}
          CONTROL_PROOF_PREDICATE: \${{ steps.vigil.outputs.control-proof-predicate }}
        run: |
          [[ -n "$CONTROL_PROOF" && -f "$CONTROL_PROOF" && ! -L "$CONTROL_PROOF" && -s "$CONTROL_PROOF" ]]
          [[ -n "$CONTROL_PROOF_PREDICATE" && -f "$CONTROL_PROOF_PREDICATE" && ! -L "$CONTROL_PROOF_PREDICATE" && -s "$CONTROL_PROOF_PREDICATE" ]]
      - name: Upload only the unsigned proof and predicate
        if: always() && steps.vigil.outputs.report != '' && steps.vigil.outputs.control-proof-predicate != ''
        uses: actions/upload-artifact@${UPLOAD_COMMIT}
        with:
          name: agent-vigil-control-proof-unsigned-\${{ github.run_id }}-\${{ github.run_attempt }}
          if-no-files-found: error
          retention-days: 1
          path: |
            \${{ steps.vigil.outputs.report }}
            \${{ steps.vigil.outputs.control-proof-predicate }}

  attest-proof:
    name: Attest the prepared proof without repository code
    needs: build-proof
    if: always() && needs.build-proof.result != 'cancelled' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch)
    runs-on: ubuntu-24.04
    permissions:
      actions: read
      contents: read
      id-token: write
      attestations: write
      artifact-metadata: write
    steps:
      - name: Download the exact prepared proof artifact
        uses: actions/download-artifact@${DOWNLOAD_COMMIT}
        with:
          name: agent-vigil-control-proof-unsigned-\${{ github.run_id }}-\${{ github.run_attempt }}
          path: \${{ runner.temp }}/agent-vigil-control-proof
      - name: Validate the bounded proof artifact before signing
        env:
          PROOF_DIRECTORY: \${{ runner.temp }}/agent-vigil-control-proof
          EXPECTED_SOURCE_COMMIT: \${{ github.sha }}
        run: |
          set -euo pipefail
          node <<'NODE'
          const { createHash } = require("node:crypto");
          const { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } = require("node:fs");
          const { join } = require("node:path");
          const directory = process.env.PROOF_DIRECTORY;
          const expectedSourceCommit = process.env.EXPECTED_SOURCE_COMMIT;
          const limits = new Map([
            ["agent-vigil-report.json", 16 * 1024 * 1024],
            ["agent-vigil-control-proof-predicate.json", 1024 * 1024],
          ]);
          const expected = [...limits.keys()].sort();
          const actual = readdirSync(directory).sort();
          if (actual.join("\\n") !== expected.join("\\n")) {
            throw new Error("control-proof artifact must contain exactly the proof and predicate");
          }
          function boundedRegularFile(name, maximumBytes) {
            const path = join(directory, name);
            const before = lstatSync(path, { bigint: true });
            if (!before.isFile() || before.isSymbolicLink() || before.size < 2n || before.size > BigInt(maximumBytes)) {
              throw new Error(name + " must be a bounded regular non-symlink file");
            }
            const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const opened = fstatSync(descriptor, { bigint: true });
              if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
                throw new Error(name + " changed while it was opened");
              }
              const bytes = readFileSync(descriptor);
              const after = fstatSync(descriptor, { bigint: true });
              const finalPath = lstatSync(path, { bigint: true });
              if (BigInt(bytes.length) !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
                || after.size !== opened.size || finalPath.isSymbolicLink() || !finalPath.isFile()
                || finalPath.dev !== opened.dev || finalPath.ino !== opened.ino || finalPath.size !== opened.size) {
                throw new Error(name + " changed while it was read");
              }
              return bytes;
            } finally {
              closeSync(descriptor);
            }
          }
          function exactKeys(value, keys) {
            if (!value || typeof value !== "object" || Array.isArray(value)) return false;
            const actual = Object.keys(value).sort();
            const expected = [...keys].sort();
            return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
          }
          function plain(value, maximum) {
            if (typeof value !== "string" || !value || value.length > maximum) return false;
            for (const character of value) {
              const point = character.codePointAt(0);
              if (point <= 31 || point === 127 || (point >= 0x202a && point <= 0x202e) || (point >= 0x2066 && point <= 0x2069)) return false;
            }
            return true;
          }
          function canonical(value) {
            if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
            if (value && typeof value === "object") {
              const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
              return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}";
            }
            return JSON.stringify(value);
          }
          function sha256(value) {
            return "sha256:" + createHash("sha256").update(value).digest("hex");
          }
          const proofBytes = boundedRegularFile("agent-vigil-report.json", limits.get("agent-vigil-report.json"));
          const predicateBytes = boundedRegularFile("agent-vigil-control-proof-predicate.json", limits.get("agent-vigil-control-proof-predicate.json"));
          const proof = JSON.parse(proofBytes.toString("utf8"));
          const predicate = JSON.parse(predicateBytes.toString("utf8"));
          const proofKeys = ["schemaVersion", "vigilVersion", "status", "sourceCommit", "generatedAt", "receiptHash", "challenges", "summary", "reproduction", "limits"];
          if (!exactKeys(proof, proofKeys) || proof.schemaVersion !== "agent-vigil-control-proof/v1"
            || !["PASS", "HOLD"].includes(proof.status) || !/^[0-9a-f]{40}$/.test(proof.sourceCommit)
            || proof.sourceCommit !== expectedSourceCommit || !plain(proof.vigilVersion, 80)
            || !plain(proof.generatedAt, 40) || new Date(proof.generatedAt).toISOString() !== proof.generatedAt
            || !/^sha256:[0-9a-f]{64}$/.test(proof.receiptHash) || !plain(proof.reproduction, 400)
            || !Array.isArray(proof.challenges) || proof.challenges.length < 1 || proof.challenges.length > 100
            || !Array.isArray(proof.limits) || proof.limits.length > 32 || proof.limits.some((value) => !plain(value, 600))) {
            throw new Error("control proof structure or source commit is invalid");
          }
          const ids = new Set();
          for (const challenge of proof.challenges) {
            if (!exactKeys(challenge, ["id", "claim", "expected", "actual", "passed", "base", "head", "evidence"])
              || !plain(challenge.id, 80) || !/^[A-Za-z0-9_.-]+$/.test(challenge.id) || ids.has(challenge.id)
              || !plain(challenge.claim, 400) || !plain(challenge.evidence, 1000)
              || !["PASS", "BLOCK", "HOLD"].includes(challenge.expected)
              || !["PASS", "BLOCK", "HOLD", "ERROR"].includes(challenge.actual)
              || typeof challenge.passed !== "boolean" || challenge.passed !== (challenge.actual === challenge.expected)
              || !/^[0-9a-f]{40}$/.test(challenge.base) || !/^[0-9a-f]{40}$/.test(challenge.head)) {
              throw new Error("control proof challenge is invalid");
            }
            ids.add(challenge.id);
          }
          const passed = proof.challenges.filter((challenge) => challenge.passed).length;
          if (!exactKeys(proof.summary, ["passed", "total"])
            || !Number.isSafeInteger(proof.summary.passed) || !Number.isSafeInteger(proof.summary.total)
            || proof.summary.passed !== passed || proof.summary.total !== proof.challenges.length
            || proof.status !== (passed === proof.challenges.length ? "PASS" : "HOLD")) {
            throw new Error("control proof summary is invalid");
          }
          const { receiptHash, ...proofPayload } = proof;
          if (sha256(canonical(proofPayload)) !== receiptHash) throw new Error("control proof receipt hash is invalid");
          if (!exactKeys(predicate, ["predicateVersion", "proof", "privacy"]) || predicate.predicateVersion !== "1"
            || !exactKeys(predicate.proof, ["schemaVersion", "receiptHash", "fileSha256", "status", "sourceCommit", "generatedAt", "vigilVersion", "passed", "total", "challengeSetSha256"])
            || !exactKeys(predicate.privacy, ["claimsIncluded", "evidenceIncluded", "repositoryPathIncluded"])) {
            throw new Error("control proof predicate structure is invalid");
          }
          const challengeSet = proof.challenges.map(({ id, expected, actual, passed }) => ({ id, expected, actual, passed }));
          if (predicate.proof.schemaVersion !== proof.schemaVersion || predicate.proof.receiptHash !== proof.receiptHash
            || predicate.proof.fileSha256 !== sha256(proofBytes) || predicate.proof.status !== proof.status
            || predicate.proof.sourceCommit !== proof.sourceCommit || predicate.proof.generatedAt !== proof.generatedAt
            || predicate.proof.vigilVersion !== proof.vigilVersion || predicate.proof.passed !== proof.summary.passed
            || predicate.proof.total !== proof.summary.total || predicate.proof.challengeSetSha256 !== sha256(canonical(challengeSet))
            || predicate.privacy.claimsIncluded !== false || predicate.privacy.evidenceIncluded !== false
            || predicate.privacy.repositoryPathIncluded !== false) {
            throw new Error("control proof predicate is not bound to the exact proof");
          }
          NODE
      - id: attestation
        name: Sign the exact control proof with GitHub OIDC
        uses: actions/attest@${ATTEST_COMMIT}
        with:
          subject-path: \${{ runner.temp }}/agent-vigil-control-proof/agent-vigil-report.json
          predicate-type: https://sulmusic2-star.github.io/agent-vigil/control-proof-predicate-v1.schema.json
          predicate-path: \${{ runner.temp }}/agent-vigil-control-proof/agent-vigil-control-proof-predicate.json
      - name: Retain the proof, predicate, and attestation bundle
        if: always()
        uses: actions/upload-artifact@${UPLOAD_COMMIT}
        with:
          name: agent-vigil-control-proof-\${{ github.run_id }}-\${{ github.run_attempt }}
          if-no-files-found: error
          retention-days: 90
          path: |
            \${{ runner.temp }}/agent-vigil-control-proof/agent-vigil-report.json
            \${{ runner.temp }}/agent-vigil-control-proof/agent-vigil-control-proof-predicate.json
            \${{ steps.attestation.outputs.bundle-path }}
`;
}

function repositoryRoot(repo: string): string {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!root) throw new Error("missing repository root");
    return realpathSync(root);
  } catch {
    throw new Error(`not a Git repository: ${repo}`);
  }
}

function readExistingWorkflow(root: string, workflow: string): string | undefined {
  let current = root;
  const components = dirname(workflow).split(sep).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`Refusing to traverse unsafe control-proof workflow parent: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  const target = join(root, workflow);
  let expected: ReturnType<typeof lstatSync>;
  try {
    expected = lstatSync(target, { bigint: true });
    if (expected.isSymbolicLink() || !expected.isFile()) {
      throw new Error(`Refusing to replace unsafe control-proof workflow: ${target}`);
    }
    if (expected.size > BigInt(MAXIMUM_EXISTING_WORKFLOW_BYTES)) {
      throw new Error(`Existing control-proof workflow exceeds ${MAXIMUM_EXISTING_WORKFLOW_BYTES} bytes: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error(`Control-proof workflow changed while it was opened: ${target}`);
    }
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`Control-proof workflow changed while it was read: ${target}`);
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const finalPath = lstatSync(target, { bigint: true });
    if (BigInt(bytes.length) !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
      || finalPath.isSymbolicLink() || !finalPath.isFile() || finalPath.dev !== opened.dev
      || finalPath.ino !== opened.ino || finalPath.size !== opened.size
      || finalPath.mtimeNs !== opened.mtimeNs || finalPath.ctimeNs !== opened.ctimeNs) {
      throw new Error(`Control-proof workflow changed while it was read: ${target}`);
    }
    return bytes.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function installKeylessControlProofAction(repo: string, actionCommit: string, force = false): InstallControlProofActionResult {
  const requested = realpathSync(resolve(repo));
  const root = repositoryRoot(requested);
  if (!FULL_COMMIT.test(actionCommit)) throw new Error("--action-ref must be a full lowercase Agent Vigil commit SHA");
  const workflow = ".github/workflows/agent-vigil-control-proof.yml";
  const result: InstallControlProofActionResult = { created: [], kept: [], actionCommit, workflow };
  const desired = keylessControlProofWorkflow(actionCommit);
  const existing = readExistingWorkflow(root, workflow);
  if (existing !== undefined && !force) {
    if (MANAGED_MARKER.test(existing) && existing !== desired) {
      throw new Error("existing managed Agent Vigil control-proof workflow is not the requested split-job topology; rerun with --force to migrate it");
    }
    result.kept.push(workflow);
    return result;
  }
  writePrivateFileAtomicWithin(root, workflow, desired);
  result.created.push(workflow);
  return result;
}
