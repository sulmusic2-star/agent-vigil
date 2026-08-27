import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runContinuityCommand } from "../src/continuity/cli.ts";
import { parseContinuityStapleJson, verifyContinuityStaple } from "../src/continuity-staple-library.ts";

type Manifest = {
  bindings: {
    expectedReceiptHash: string;
    expectedHead: string;
    expectedEnvironment: string;
    expectedPolicySha256: string;
    expectedChainTip: string;
    minimumSequence: number;
  };
  times: Record<string, string>;
  files: Record<string, string>;
  expectations: Array<{ file: string; time: string; result: string; allowsProtectedAction: boolean }>;
};

const root = join(process.cwd(), "test-vectors/continuity-staple/v1");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as Manifest;

function fileSha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function silent(operation: () => number): number {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return operation(); }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

test("the signed vector bytes match their manifest", () => {
  for (const [file, digest] of Object.entries(manifest.files)) assert.equal(fileSha256(join(root, file)), digest, file);
});

test("the TypeScript library and CLI produce identical vector decisions", () => {
  const publicKeyPath = join(root, "authority-public.pem");
  const publicKeyPem = readFileSync(publicKeyPath);
  const exits: Record<string, number> = { CURRENT: 0, REVOKED: 1, ERROR: 2, HOLD: 3, EXPIRED: 4 };
  for (const expectation of manifest.expectations) {
    const time = manifest.times[expectation.time];
    const staplePath = join(root, expectation.file);
    let libraryResult = "ERROR";
    let libraryAllowed = false;
    try {
      const verified = verifyContinuityStaple(parseContinuityStapleJson(readFileSync(staplePath, "utf8")), {
        publicKeyPem,
        ...manifest.bindings,
        now: new Date(time),
      });
      libraryResult = verified.effectiveContinuity;
      libraryAllowed = verified.allowsProtectedAction;
    } catch {
      libraryResult = "ERROR";
    }
    assert.equal(libraryResult, expectation.result, `${expectation.file} library result`);
    assert.equal(libraryAllowed, expectation.allowsProtectedAction, `${expectation.file} library permission`);

    const output = join(mkdtempSync(join(tmpdir(), "agent-vigil-vector-cli-")), "decision.json");
    const cliExit = silent(() => runContinuityCommand([
      "verify-staple", staplePath,
      "--public-key", publicKeyPath,
      "--expected-receipt-hash", manifest.bindings.expectedReceiptHash,
      "--expected-head", manifest.bindings.expectedHead,
      "--environment", manifest.bindings.expectedEnvironment,
      "--expected-policy-sha256", manifest.bindings.expectedPolicySha256,
      "--expected-chain-tip", manifest.bindings.expectedChainTip,
      "--minimum-sequence", String(manifest.bindings.minimumSequence),
      "--now", time,
      "--output", output,
    ]));
    assert.equal(cliExit, exits[expectation.result], `${expectation.file} CLI result`);
  }
});
