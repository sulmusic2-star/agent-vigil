import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyReleaseAssembly } from "../scripts/verify_release_assembly.ts";

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

test("release assembly rejects an unexpected runtime path before packaging", () => {
  const repo = mkdtempSync(join(tmpdir(), "agent-vigil-release-check-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "release-check@example.invalid");
  git(repo, "config", "user.name", "Release Check");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "unexpected.ts"), "export const bypass = true;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "runtime");
  const runtime = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "README.md"), "pin\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "pin");
  const head = git(repo, "rev-parse", "HEAD");
  assert.throws(
    () => verifyReleaseAssembly({ repo, base, runtime, head, version: "0.23.4" }),
    /runtime commit changes unexpected path.*unexpected\.ts/,
  );
});

test("release assembly binds five public Action pins and rebuilds every dist file", () => {
  const source = readFileSync("scripts/verify_release_assembly.ts", "utf8");
  for (const path of [
    ".github/workflows/agent-vigil.yml",
    ".github/workflows/agent-vigil-merge-group.yml",
    ".github/workflows/agent-vigil-outcomes.yml",
    ".github/workflows/control-proof-weekly.yml",
    "hosted/public-app/control-workflow.yml",
  ]) assert.match(source, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(source, /tracked and rebuilt dist file lists differ/);
  assert.match(source, /is not the deterministic output of the reviewed source/);
  assert.match(source, /release assembly must contain exactly two commits/);
});
