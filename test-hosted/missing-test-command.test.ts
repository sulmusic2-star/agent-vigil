import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const sha = "a".repeat(40);
const shapes = [
  ["plain Git", undefined],
  ["Node without scripts", { name: "no-tests" }],
  ["Node with only lint", { name: "no-tests", scripts: { lint: "eslint ." } }],
] as const;

for (const [name, manifest] of shapes) {
  for (const profile of ["protect", "maintainer"] as const) {
    test(`${profile} rejects ${name} before writing placeholder controls`, () => {
      const repo = mkdtempSync(join(tmpdir(), "vigil-no-tests-"));
      try {
        execFileSync("git", ["init", "-q"], { cwd: repo });
        if (manifest) writeFileSync(join(repo, "package.json"), JSON.stringify(manifest));
        const args = profile === "protect" ? ["protect"] : ["init", "--profile", "maintainer"];
        const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args,
          "--repo", repo, "--action-sha", sha], { cwd: root, encoding: "utf8", timeout: 20_000 });
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert.match(result.stderr, /No test command found/);
        assert.match(result.stderr, /--runner common --test-cmd/);
        assert.doesNotMatch(result.stdout, /READY|scaffold prepared|ready to add/);
        assert.equal(existsSync(join(repo, ".agent-vigil.json")), false);
        assert.equal(existsSync(join(repo, ".github")), false);
      } finally { rmSync(repo, { recursive: true, force: true }); }
    });
  }
}

test("a refused forced install preserves an existing policy", () => {
  const repo = mkdtempSync(join(tmpdir(), "vigil-no-tests-existing-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    const file = join(repo, ".agent-vigil.json");
    const sentinel = '{"schemaVersion":1,"testCommand":"keep this policy"}\n';
    writeFileSync(file, sentinel);
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "protect",
      "--repo", repo, "--action-sha", sha, "--force"], { cwd: root, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /No test command found/);
    assert.equal(readFileSync(file, "utf8"), sentinel);
    assert.equal(existsSync(join(repo, ".github")), false);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
