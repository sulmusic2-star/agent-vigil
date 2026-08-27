#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "agent-vigil-60s-"));
const started = Date.now();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    timeout: options.timeout ?? 20_000,
    env: { ...process.env, NO_COLOR: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

try {
  writeFileSync(join(temporary, "package.json"), JSON.stringify({
    name: "agent-vigil-disposable-demo",
    version: "1.0.0",
    private: true,
    scripts: { test: "node --test" },
  }, null, 2));
  run("git", ["init", "-q"], { cwd: temporary });
  run("git", ["config", "user.email", "demo@agent-vigil.invalid"], { cwd: temporary });
  run("git", ["config", "user.name", "Agent Vigil demo"], { cwd: temporary });
  run("git", ["add", "package.json"], { cwd: temporary });
  run("git", ["commit", "-qm", "demo base"], { cwd: temporary });

  const actionSha = run("git", ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(actionSha)) throw new Error("current checkout did not resolve to a full Git commit");
  const protectOutput = run(process.execPath, [join(root, "dist", "cli.js"), "protect", "--repo", temporary, "--action-sha", actionSha]);
  run("git", ["add", "-A"], { cwd: temporary });
  run("git", ["commit", "-qm", "install Agent Vigil"], { cwd: temporary });
  const doctorOutput = run(process.execPath, [join(root, "dist", "cli.js"), "doctor", "--repo", temporary]);
  const workflow = readFileSync(join(temporary, ".github", "workflows", "agent-vigil.yml"), "utf8");
  const setup = {
    protectPassed: /created/i.test(protectOutput),
    doctorPassed: /PASS/.test(doctorOutput) && !/FAIL/.test(doctorOutput),
    baseSelectedPullRequestGate: workflow.includes("pull_request_target:"),
    candidateIsolation: workflow.includes("isolate-candidate: true"),
    repositoryMergeQueueImpersonationRejected: !workflow.includes("merge_group:"),
    receiptRetention: workflow.includes("agent-vigil-receipt"),
    exactCommitAction: workflow.includes(`sulmusic2-star/agent-vigil@${actionSha}`),
  };
  if (Object.values(setup).some((value) => value !== true)) {
    throw new Error(`generated protection failed inspection: ${JSON.stringify(setup)}`);
  }

  run(process.execPath, [join(root, "scripts", "historical_proof.mjs")], { timeout: 40_000 });
  const historical = JSON.parse(readFileSync(join(root, "proof", "results.json"), "utf8"));
  if (historical.result !== "PASS" || historical.cases?.length !== 3) {
    throw new Error("historical failure replay did not reproduce all three cases");
  }

  const elapsedSeconds = Number(((Date.now() - started) / 1000).toFixed(2));
  if (elapsedSeconds > 60) throw new Error(`demo exceeded 60 seconds: ${elapsedSeconds}`);
  const result = {
    result: "PASS",
    elapsedSeconds,
    setup,
    historicalFailuresReplayed: historical.cases.map((item) => ({
      id: item.id,
      vulnerable: item.vulnerable,
      corrected: item.corrected,
      primaryEvidence: item.primaryEvidence,
    })),
    limits: [
      "The installation ran in a disposable local repository.",
      "The three failure cases are first-party historical records, not external adoption.",
      "This demonstration does not prove a required check, retention, payment, or revenue.",
    ],
  };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write("Agent Vigil 60-second proof: PASS\n");
    process.stdout.write("  setup: protect + doctor + base-selected pull request + exact Action pin + receipt retention\n");
    process.stdout.write(`  replay: ${historical.cases.length}/3 first-party historical failures\n`);
    for (const item of historical.cases) process.stdout.write(`    ${item.id}: ${item.vulnerable.slice(0, 12)} -> ${item.corrected.slice(0, 12)}\n`);
    process.stdout.write(`  elapsed: ${elapsedSeconds.toFixed(2)} seconds\n`);
    process.stdout.write("  boundary: disposable setup and first-party proof; no external adoption or revenue claim\n");
  }
} finally {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore" });
  } catch {}
  rmSync(temporary, { recursive: true, force: true });
}
