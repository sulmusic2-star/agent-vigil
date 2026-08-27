import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { generateSigningKey } from "../src/signature.ts";
import { canonicalSha256, type ContinuityEvent, type ContinuityRoot } from "../src/continuity/contracts.ts";
import type { ChainVerification } from "../src/continuity/chain.ts";
import type { ContinuityDecision } from "../src/continuity/decision.ts";
import {
  issueContinuityStaple,
  loadContinuityStaple,
  verifyContinuityStaple,
  type SignedContinuityStaple,
} from "../src/continuity/staple.ts";
import type { TrustReport } from "../src/report.ts";

type Protocol = {
  schemaVersion: number;
  iterations: { core: number; file: number; coldCli: number };
  warmups: { core: number; file: number; coldCli: number };
  budgets: {
    stapleBytesMaximum: number;
    coreP95MillisecondsMaximum: number;
    fileP95MillisecondsMaximum: number;
    coldCliP95MillisecondsMaximum: number;
  };
};

type Summary = {
  iterations: number;
  minimumMilliseconds: number;
  medianMilliseconds: number;
  meanMilliseconds: number;
  p95Milliseconds: number;
  p99Milliseconds: number;
  maximumMilliseconds: number;
  decisionsPerSecond: number;
};

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function digest(label: string): string {
  return canonicalSha256({ label });
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function percentile(sorted: number[], selected: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(selected * sorted.length) - 1))];
}

function summarize(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  return {
    iterations: sorted.length,
    minimumMilliseconds: round(sorted[0]),
    medianMilliseconds: round(percentile(sorted, 0.5)),
    meanMilliseconds: round(mean),
    p95Milliseconds: round(percentile(sorted, 0.95)),
    p99Milliseconds: round(percentile(sorted, 0.99)),
    maximumMilliseconds: round(sorted.at(-1)!),
    decisionsPerSecond: round(1000 / mean),
  };
}

function measure(iterations: number, warmups: number, run: () => void): Summary {
  for (let index = 0; index < warmups; index += 1) run();
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  return summarize(samples);
}

function gitSha(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = resolve(option("--protocol") ?? join(repoRoot, "benchmarks/continuity-staple-performance-protocol-v1.json"));
const outputPath = resolve(option("--output") ?? join(repoRoot, "benchmarks/continuity-staple-performance-result-v1.json"));
const protocol = JSON.parse(readFileSync(protocolPath, "utf8")) as Protocol;
if (protocol.schemaVersion !== 1) throw new Error("unsupported Continuity Staple performance protocol");
const enforce = process.argv.includes("--enforce");
const root = mkdtempSync(join(tmpdir(), "agent-vigil-staple-performance-"));

try {
  const privateKeyPath = join(root, "private.pem");
  const publicKeyPath = join(root, "public.pem");
  const staplePath = join(root, "staple.json");
  generateSigningKey(privateKeyPath, publicKeyPath);

  const subject = {
    episodeReceiptHash: digest("receipt"),
    repositoryHash: digest("repository"),
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
  };
  const rootHash = digest("root");
  const chainTip = digest("chain-tip");
  const policySha256 = digest("policy-bytes");
  const issuedAt = "2026-08-26T12:00:00.000Z";
  const continuityRoot: ContinuityRoot = {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: digest("receipt-file"),
    receiptHash: subject.episodeReceiptHash,
    rootHash,
    subject,
    historicalVerification: "PASS",
    createdAt: "2026-08-26T11:00:00.000Z",
  };
  const verification = {
    valid: true,
    errors: [],
    root: continuityRoot,
    report: {} as TrustReport,
    events: [{ sequence: 1 }, { sequence: 2 }] as ContinuityEvent[],
    chainTip,
    rootSignature: { present: true, valid: true, keyId: digest("root-key") },
  } satisfies ChainVerification;
  const decision = {
    schemaVersion: "agent-vigil-continuity-decision/v1",
    evaluatedAt: issuedAt,
    historicalVerification: "PASS",
    continuity: "CURRENT",
    allowsProtectedAction: true,
    protectedEnvironment: "production",
    rootHash,
    chainTip,
    eventCount: 2,
    policy: { sourceHash: digest("policy-source"), sha256: policySha256 },
    outcomeFacts: [],
    reasons: [],
    decisionHash: digest("decision"),
  } satisfies ContinuityDecision;
  const staple: SignedContinuityStaple = issueContinuityStaple({ verification, decision, privateKeyPath, ttlSeconds: 300 });
  const bytes = Buffer.from(`${JSON.stringify(staple, null, 2)}\n`);
  writeFileSync(staplePath, bytes, { mode: 0o600 });
  const now = new Date("2026-08-26T12:01:00.000Z");
  const verifyOptions = {
    publicKeyPath,
    expectedReceiptHash: subject.episodeReceiptHash,
    expectedHead: subject.headSha,
    expectedEnvironment: "production",
    expectedPolicySha256: policySha256,
    expectedChainTip: chainTip,
    minimumSequence: 2,
    now,
  };

  const core = measure(protocol.iterations.core, protocol.warmups.core, () => {
    const result = verifyContinuityStaple(staple, verifyOptions);
    if (!result.allowsProtectedAction) throw new Error("core benchmark unexpectedly denied");
  });
  const file = measure(protocol.iterations.file, protocol.warmups.file, () => {
    const result = verifyContinuityStaple(loadContinuityStaple(staplePath), verifyOptions);
    if (!result.allowsProtectedAction) throw new Error("file benchmark unexpectedly denied");
  });
  const cliArgs = [
    join(repoRoot, "dist/cli.js"), "continuity", "verify-staple", staplePath,
    "--public-key", publicKeyPath,
    "--expected-receipt-hash", subject.episodeReceiptHash,
    "--expected-head", subject.headSha,
    "--environment", "production",
    "--expected-policy-sha256", policySha256,
    "--expected-chain-tip", chainTip,
    "--minimum-sequence", "2",
    "--now", now.toISOString(),
    "--format", "json",
  ];
  const coldCli = measure(protocol.iterations.coldCli, protocol.warmups.coldCli, () => {
    const child = spawnSync(process.execPath, cliArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (child.status !== 0) throw new Error(`cold CLI benchmark failed: ${child.stderr.trim()}`);
    const result = JSON.parse(child.stdout) as { allowsProtectedAction?: boolean };
    if (!result.allowsProtectedAction) throw new Error("cold CLI benchmark unexpectedly denied");
  });

  const checks = {
    stapleBytes: { observed: bytes.length, maximum: protocol.budgets.stapleBytesMaximum, pass: bytes.length <= protocol.budgets.stapleBytesMaximum },
    coreP95Milliseconds: { observed: core.p95Milliseconds, maximum: protocol.budgets.coreP95MillisecondsMaximum, pass: core.p95Milliseconds <= protocol.budgets.coreP95MillisecondsMaximum },
    fileP95Milliseconds: { observed: file.p95Milliseconds, maximum: protocol.budgets.fileP95MillisecondsMaximum, pass: file.p95Milliseconds <= protocol.budgets.fileP95MillisecondsMaximum },
    coldCliP95Milliseconds: { observed: coldCli.p95Milliseconds, maximum: protocol.budgets.coldCliP95MillisecondsMaximum, pass: coldCli.p95Milliseconds <= protocol.budgets.coldCliP95MillisecondsMaximum },
  };
  const passed = Object.values(checks).every((check) => check.pass);
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tool: { name: "agent-vigil", sourceCommit: gitSha(repoRoot) },
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    protocol: { path: "benchmarks/continuity-staple-performance-protocol-v1.json", sha256: canonicalSha256(protocol) },
    subject: { state: "CURRENT", stapleBytes: bytes.length, signature: "Ed25519", networkCalls: 0 },
    results: { core, file, coldCli },
    checks,
    passed,
    limits: [
      "This is a maintainer-run single-machine microbenchmark, not an independent or competitor-comparative result.",
      "The cold CLI measurement includes Node.js process startup; embedded and long-lived consumers should use the core or file path.",
      "This benchmark does not measure chain issuance, network retrieval, Kubernetes API latency, adoption, willingness to pay, or revenue."
    ]
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write([
    `Continuity Staple performance: ${passed ? "PASS" : "FAIL"}`,
    `  staple: ${bytes.length} bytes`,
    `  core p95: ${core.p95Milliseconds} ms`,
    `  file p95: ${file.p95Milliseconds} ms`,
    `  cold CLI p95: ${coldCli.p95Milliseconds} ms`,
    `  output: ${outputPath}`,
    ""
  ].join("\n"));
  if (enforce && !passed) process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
