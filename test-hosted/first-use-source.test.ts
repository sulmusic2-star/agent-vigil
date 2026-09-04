import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("the source CLI gives a new user one start command and one decision vocabulary", () => {
  const first = run([]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /npx --yes @sulmusic\/agent-vigil@0\.24\.0 protect --repo \./);
  assert.match(first.stdout, /PASS\s+Ready to merge\./);
  assert.match(first.stdout, /FAIL\s+Do not merge yet\./);
  assert.match(first.stdout, /NOT CHECKED\s+No decision because required evidence is missing\./);
  assert.match(first.stdout, /Advanced commands: vigil help --all/);
  assert.doesNotMatch(first.stdout, /Register an outside trial|Optional workflow badge|Usage:/);

  const advanced = run(["help", "--all"]);
  assert.equal(advanced.status, 0, advanced.stderr);
  assert.match(advanced.stdout, /^agent-vigil \d+\.\d+\.\d+/);
  assert.match(advanced.stdout, /vigil maintainer --event/);
});
