import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const env: NodeJS.ProcessEnv = { ...process.env, npm_config_offline: "true", npm_config_registry: "http://127.0.0.1:9/" };
delete env.NODE_OPTIONS;

function invoke(args: string[], cwd: string) {
  return spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", timeout: 30_000 });
}

function copied(command: string, cwd: string) {
  const script = process.platform === "win32"
    ? "$ErrorActionPreference = 'Stop'; " + command + "; exit $LASTEXITCODE"
    : command;
  return spawnSync(process.platform === "win32" ? "powershell.exe" : "/bin/sh",
    process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
      : ["-c", script],
    { cwd, env, encoding: "utf8", timeout: 30_000 });
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
}

for (const kind of ["source", "bundle"] as const) {
  test(`${kind} CLI printed commands reuse the local runtime from another working directory`, () => {
    const lab = mkdtempSync(join(tmpdir(), "vigil-handoff-"));
    const repo = join(lab, "repo with ' quote $dollar `tick` & semi;");
    mkdirSync(repo);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "handoff@agent-vigil.invalid");
    git(repo, "config", "user.name", "Handoff Test");
    git(repo, "add", ".");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");

    const installed = join(lab, "CLI with ' quote $dollar `tick` & semi;");
    mkdirSync(installed);
    cpSync(join(root, "dist"), join(installed, "dist"), { recursive: true });
    cpSync(join(root, "package.json"), join(installed, "package.json"));
    const entry = kind === "source" ? join(root, "src/cli.ts") : join(installed, "dist/cli.js");
    const first = invoke([...(kind === "source" ? ["--import", "tsx"] : []), entry, "--help"], root);
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stdout, /releases\/download\/|npx --yes/);
    assert.match(first.stdout, /https:\/\/sulmusic2-star\.github\.io\/agent-vigil\/#install/);
    const protect = first.stdout.match(/^Start here[^\r\n]*:\r?\n  ([^\r\n]+)/m)?.[1];
    assert.ok(protect, first.stdout);
    if (process.platform === "win32") assert.match(first.stdout, /Start here \(PowerShell\)/);
    const setup = copied(protect, repo);
    assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
    assert.doesNotMatch(setup.stdout, /releases\/download\/|npx --yes/);
    const doctor = setup.stdout.match(/^After it merges, run this command[^\r\n]*:\r?\n  ([^\r\n]+)/m)?.[1];
    assert.ok(doctor, setup.stdout);
    assert.equal(copied(doctor, lab).status, 2, "uncommitted controls must not pass");
    git(repo, "add", ".");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "controls");
    const checked = copied(doctor, lab);
    assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    assert.match(checked.stdout, /0 failure\(s\)/);

    if (kind === "bundle") {
      renameSync(entry, entry + ".removed");
      const missing = copied(doctor, lab);
      assert.notEqual(missing.status, 0, "removed cached runtime must not switch to another package");
      assert.match(missing.stderr, /MODULE_NOT_FOUND|Cannot find module/);
    }
    assert.equal(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version,
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  });
}
