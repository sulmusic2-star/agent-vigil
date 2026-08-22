import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpgradeCommand } from "../src/upgrade/cli.ts";
import { initUpgrade } from "../src/upgrade/setup.ts";

function repository(): string {
  const path = mkdtempSync(join(tmpdir(), "vigil-upgrade-cli-test-"));
  execFileSync("git", ["init", "-q"], { cwd: path });
  return path;
}

function quiet<T>(operation: () => T): T {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try { return operation(); }
  finally { console.log = log; console.error = error; }
}

test("upgrade help is non-mutating", () => {
  const repo = repository();
  const code = quiet(() => runUpgradeCommand(["init", "--help", "--repo", repo]));
  assert.equal(code, 0);
  assert.equal(existsSync(join(repo, ".agent-vigil")), false);
});

test("every upgrade subcommand help path is non-mutating", () => {
  for (const command of ["doctor", "check", "verify", "index"]) {
    assert.equal(quiet(() => runUpgradeCommand([command, "--help"])), 0, command);
  }
});

test("upgrade init creates a private, ignored, fail-closed scaffold and preserves it by default", () => {
  const repo = repository();
  const first = quiet(() => runUpgradeCommand(["init", "--repo", repo]));
  assert.equal(first, 0);
  const root = join(repo, ".agent-vigil", "upgrade");
  const config = join(root, "config.json");
  const canary = join(root, "canaries", "template-canary.mjs");
  assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "*\n!.gitignore\n");
  assert.match(readFileSync(config, "utf8"), /replace-with-repository-canary/);
  assert.match(readFileSync(canary, "utf8"), /outcome: "FAIL"/);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(config).mode & 0o777, 0o600);
    assert.equal(lstatSync(canary).mode & 0o777, 0o600);
  }
  writeFileSync(canary, "user-owned canary\n");
  const second = initUpgrade(repo, false);
  assert.ok(second.kept.some((path) => path.endsWith("/.agent-vigil/upgrade/canaries/template-canary.mjs")));
  assert.equal(readFileSync(canary, "utf8"), "user-owned canary\n");
});

test("upgrade init refuses a symbolic-link scaffold target", (context) => {
  const repo = repository();
  const root = join(repo, ".agent-vigil", "upgrade");
  mkdirSync(root, { recursive: true });
  const outside = join(repo, "outside.json");
  writeFileSync(outside, "do not replace\n");
  try { symlinkSync(outside, join(root, "config.json")); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") { context.skip(`symlinks unavailable: ${code}`); return; }
    throw error;
  }
  assert.throws(() => initUpgrade(repo), /unsafe existing scaffold/);
  assert.equal(readFileSync(outside, "utf8"), "do not replace\n");
});

test("upgrade check requires both public output and its signing key", () => {
  const repo = repository();
  quiet(() => runUpgradeCommand(["init", "--repo", repo]));
  const current = join(repo, "current");
  const candidate = join(repo, "candidate");
  mkdirSync(current);
  mkdirSync(candidate);
  const code = quiet(() => runUpgradeCommand([
    "check", "--repo", repo, "--current", current, "--candidate", candidate,
    "--public-output", join(repo, "public.json"),
  ]));
  assert.equal(code, 2);
  assert.equal(existsSync(join(repo, "public.json")), false);
});

test("upgrade outputs cannot overwrite keys, inputs, or evaluated artifact trees", () => {
  const repo = repository();
  quiet(() => runUpgradeCommand(["init", "--repo", repo]));
  const current = join(repo, "current");
  const candidate = join(repo, "candidate");
  mkdirSync(current);
  mkdirSync(candidate);
  const privateKey = join(repo, "private.pem");
  writeFileSync(privateKey, "PRIVATE KEY MUST SURVIVE\n");

  const keyCollision = quiet(() => runUpgradeCommand([
    "check", "--repo", repo, "--current", current, "--candidate", candidate,
    "--public-output", privateKey, "--signing-key", privateKey,
  ]));
  assert.equal(keyCollision, 2);
  assert.equal(readFileSync(privateKey, "utf8"), "PRIVATE KEY MUST SURVIVE\n");

  const artifactOutput = join(current, "receipt.json");
  const artifactCollision = quiet(() => runUpgradeCommand([
    "check", "--repo", repo, "--current", current, "--candidate", candidate,
    "--output", artifactOutput,
  ]));
  assert.equal(artifactCollision, 2);
  assert.equal(existsSync(artifactOutput), false);
});

test("upgrade index cannot overwrite an entry or its pinned public key", () => {
  const repo = repository();
  const entry = join(repo, "entry.json");
  const publicKey = join(repo, "publisher.pem");
  writeFileSync(entry, "{}\n");
  writeFileSync(publicKey, "PINNED KEY MUST SURVIVE\n");
  const code = quiet(() => runUpgradeCommand([
    "index", entry, "--output", publicKey, "--public-key", publicKey,
  ]));
  assert.equal(code, 2);
  assert.equal(readFileSync(publicKey, "utf8"), "PINNED KEY MUST SURVIVE\n");
});

test("upgrade parser rejects unknown flags and commands", () => {
  assert.equal(quiet(() => runUpgradeCommand(["unknown"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["init", "--surprise"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["init", "unexpected-positional"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["doctor", "unexpected-positional"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["check", "unexpected-positional"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["doctor", "--repo"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["doctor", "--repo", ".", "--repo", "."])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["check", "--repo", "."])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["verify"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["verify", "one.json", "two.json"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["index", "entry.json"])), 2);
});
