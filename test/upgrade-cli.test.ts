import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
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
import { join, resolve } from "node:path";
import { run } from "../src/cli.ts";
import { runUpgradeCommand } from "../src/upgrade/cli.ts";
import { initUpgrade } from "../src/upgrade/setup.ts";
import { withoutInheritedNodeCoverage } from "./subprocess-env.ts";

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

function captured(operation: () => number): { status: number; stdout: string; stderr: string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...values: unknown[]) => { stdout.push(values.map(String).join(" ")); };
  console.error = (...values: unknown[]) => { stderr.push(values.map(String).join(" ")); };
  try { return { status: operation(), stdout: stdout.join("\n"), stderr: stderr.join("\n") }; }
  finally { console.log = log; console.error = error; }
}

test("upgrade help is non-mutating", () => {
  const repo = repository();
  const code = quiet(() => runUpgradeCommand(["init", "--help", "--repo", repo]));
  assert.equal(code, 0);
  assert.equal(existsSync(join(repo, ".agent-vigil")), false);
});

test("every upgrade subcommand help path is non-mutating", () => {
  for (const command of ["doctor", "plan", "preflight", "check", "verify", "evidence", "resolve", "enforce", "index"]) {
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
  assert.ok(second.kept.some((path) => path.endsWith(join(".agent-vigil", "upgrade", "canaries", "template-canary.mjs"))));
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
  assert.equal(quiet(() => runUpgradeCommand(["plan", "--repo", "."])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["verify"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["evidence"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["resolve"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["enforce"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["verify", "one.json", "two.json"])), 2);
  assert.equal(quiet(() => runUpgradeCommand(["index", "entry.json"])), 2);
});

test("rejected upgrade options never disclose attached or split values", () => {
  const directory = repository();
  const fixtures = [
    {
      label: "query",
      option: "--evidence-url=https://example.invalid/evidence?access_token=QUERY_CANARY",
      canary: "QUERY_CANARY",
      expected: "agent-vigil upgrade: unknown option: --evidence-url",
    },
    {
      label: "userinfo",
      option: "--evidence-url=https://USERINFO_CANARY@example.invalid/evidence",
      canary: "USERINFO_CANARY",
      expected: "agent-vigil upgrade: unknown option: --evidence-url",
    },
    {
      label: "path",
      option: "--evidence-url=https://example.invalid/PATH_CANARY/evidence",
      canary: "PATH_CANARY",
      expected: "agent-vigil upgrade: unknown option: --evidence-url",
    },
    {
      label: "arbitrary",
      option: "--token=TOKEN_CANARY",
      canary: "TOKEN_CANARY",
      expected: "agent-vigil upgrade: unknown option: --token",
    },
    {
      label: "controls",
      option: "--evidence-url=https://example.invalid/CONTROL_CANARY\u001b[2J\r\n\u202E\u200B\uFE0F",
      canary: "CONTROL_CANARY",
      expected: "agent-vigil upgrade: unknown option: --evidence-url",
    },
    {
      label: "hostile-option-name",
      option: "--evidence\u202E-url=OPTION_NAME_CANARY",
      canary: "OPTION_NAME_CANARY",
      expected: "agent-vigil upgrade: unknown option: --option",
    },
  ];

  for (const [index, fixture] of fixtures.entries()) {
    const output = join(directory, `${index}-${fixture.label}.json`);
    const args = ["resolve", fixture.option, "--output", output];
    const direct = captured(() => runUpgradeCommand(args));
    assert.equal(direct.status, 2, `direct: ${fixture.label}`);
    assert.equal(direct.stdout, "", `direct stdout: ${fixture.label}`);
    assert.equal(direct.stderr, fixture.expected, `direct stderr: ${fixture.label}`);
    assert.doesNotMatch(`${direct.stdout}${direct.stderr}`, new RegExp(fixture.canary));
    assert.equal(existsSync(output), false, `direct artifact: ${fixture.label}`);

    const source = captured(() => run(["upgrade", ...args]));
    assert.equal(source.status, 2, `source: ${fixture.label}`);
    assert.equal(source.stdout, "", `source stdout: ${fixture.label}`);
    assert.equal(source.stderr, fixture.expected, `source stderr: ${fixture.label}`);
    assert.doesNotMatch(`${source.stdout}${source.stderr}`, new RegExp(fixture.canary));
    assert.equal(existsSync(output), false, `source artifact: ${fixture.label}`);

    const bundled = spawnSync(process.execPath, [resolve("dist/cli.js"), "upgrade", ...args], {
      cwd: resolve("."),
      encoding: "utf8",
      env: withoutInheritedNodeCoverage(),
    });
    assert.equal(bundled.status, 2, `bundle: ${fixture.label}`);
    assert.equal(bundled.stdout, "", `bundle stdout: ${fixture.label}`);
    assert.equal(bundled.stderr.trim(), fixture.expected, `bundle stderr: ${fixture.label}`);
    assert.doesNotMatch(`${bundled.stdout}${bundled.stderr}`, new RegExp(fixture.canary));
    assert.equal(existsSync(output), false, `bundle artifact: ${fixture.label}`);
  }

  const splitCanary = "SPLIT_CANARY";
  const splitOutput = join(directory, "split.json");
  const splitArgs = [
    "resolve", "--evidence-url", `https://example.invalid/${splitCanary}`,
    "--output", splitOutput,
  ];
  for (const [label, invoke] of [
    ["direct", () => captured(() => runUpgradeCommand(splitArgs))],
    ["source", () => captured(() => run(["upgrade", ...splitArgs]))],
  ] as const) {
    const result = invoke();
    assert.equal(result.status, 2, label);
    assert.equal(result.stdout, "", `${label} stdout`);
    assert.equal(result.stderr, "agent-vigil upgrade: unknown option: --evidence-url", `${label} stderr`);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(splitCanary));
  }
  const bundledSplit = spawnSync(process.execPath, [resolve("dist/cli.js"), "upgrade", ...splitArgs], {
    cwd: resolve("."),
    encoding: "utf8",
    env: withoutInheritedNodeCoverage(),
  });
  assert.equal(bundledSplit.status, 2);
  assert.equal(bundledSplit.stdout, "");
  assert.equal(bundledSplit.stderr.trim(), "agent-vigil upgrade: unknown option: --evidence-url");
  assert.doesNotMatch(`${bundledSplit.stdout}${bundledSplit.stderr}`, new RegExp(splitCanary));
  assert.equal(existsSync(splitOutput), false);
});

test("upgrade and root parser diagnostics do not reflect commands, positionals, missing values, or duplicates", () => {
  const upgradeFixtures: Array<{ args: string[]; canary: string; expected: string }> = [
    {
      args: ["COMMAND_CANARY\u202E\u001b[2J"],
      canary: "COMMAND_CANARY",
      expected: "agent-vigil upgrade: unknown upgrade command",
    },
    {
      args: ["doctor", "POSITIONAL_CANARY\u202E\u001b[2J"],
      canary: "POSITIONAL_CANARY",
      expected: "agent-vigil upgrade: unexpected positional argument",
    },
    {
      args: ["doctor", "--repo", "--token=MISSING_VALUE_CANARY"],
      canary: "MISSING_VALUE_CANARY",
      expected: "agent-vigil upgrade: --repo requires a value",
    },
    {
      args: ["doctor", "--repo", ".", "--repo", "DUPLICATE_VALUE_CANARY"],
      canary: "DUPLICATE_VALUE_CANARY",
      expected: "agent-vigil upgrade: --repo may be supplied only once",
    },
  ];
  for (const fixture of upgradeFixtures) {
    const direct = captured(() => runUpgradeCommand(fixture.args));
    assert.equal(direct.status, 2);
    assert.equal(direct.stdout, "");
    assert.equal(direct.stderr, fixture.expected);
    assert.doesNotMatch(`${direct.stdout}${direct.stderr}`, new RegExp(fixture.canary));
  }

  const rootFixtures: Array<{ args: string[]; canary: string; expected: string }> = [
    {
      args: ["prove", "--token=ROOT_OPTION_CANARY"],
      canary: "ROOT_OPTION_CANARY",
      expected: "agent-vigil: unknown option: --token",
    },
    {
      args: ["prove", "ROOT_POSITIONAL_CANARY\u202E\u001b[2J"],
      canary: "ROOT_POSITIONAL_CANARY",
      expected: "agent-vigil: unexpected positional argument",
    },
    {
      args: ["prove", "--repo", "--token=ROOT_MISSING_CANARY"],
      canary: "ROOT_MISSING_CANARY",
      expected: "agent-vigil: --repo requires a value",
    },
    {
      args: ["--evidence-url=https://example.invalid/ROOT_DEFAULT_CANARY"],
      canary: "ROOT_DEFAULT_CANARY",
      expected: "agent-vigil: unknown option: --evidence-url",
    },
  ];
  for (const fixture of rootFixtures) {
    const source = captured(() => run(fixture.args));
    assert.equal(source.status, 2);
    assert.equal(source.stdout, "");
    assert.match(source.stderr, new RegExp(`^${fixture.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(`${source.stdout}${source.stderr}`, new RegExp(fixture.canary));

    const bundled = spawnSync(process.execPath, [resolve("dist/cli.js"), ...fixture.args], {
      cwd: resolve("."),
      encoding: "utf8",
      env: withoutInheritedNodeCoverage(),
    });
    assert.equal(bundled.status, 2);
    assert.equal(bundled.stdout, "");
    assert.match(bundled.stderr, new RegExp(`^${fixture.expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.doesNotMatch(`${bundled.stdout}${bundled.stderr}`, new RegExp(fixture.canary));
  }
});

test("accepted values that later fail never escape the shared root or upgrade error boundary", () => {
  const directory = repository();
  const rootArtifact = join(directory, "root-result.json");
  const upgradeArtifact = join(directory, "upgrade-result.json");
  const rootCases = [
    {
      label: "resolved repository path",
      args: ["prove", "--repo", "/tmp/PROVE_REPO_SECRET_CANARY_F9EDE9", "--output", rootArtifact],
      canaries: ["PROVE_REPO_SECRET_CANARY_F9EDE9"],
    },
    {
      label: "URL-shaped Git ref",
      args: ["prove", "--repo", directory, "--base", "https://REF_USER:REF_SECRET@example.invalid/revision", "--output", rootArtifact],
      canaries: ["REF_USER", "REF_SECRET", "example.invalid"],
    },
    {
      label: "malformed accepted option value",
      args: ["prove", "--repo", directory, "--format", "MALFORMED_FORMAT_VALUE_CANARY", "--output", rootArtifact],
      canaries: ["MALFORMED_FORMAT_VALUE_CANARY"],
    },
    {
      label: "accepted positional receipt path",
      args: ["proof-comment", "/tmp/ROOT_POSITIONAL_SECRET_CANARY_F9EDE9.json", "--output", rootArtifact],
      canaries: ["ROOT_POSITIONAL_SECRET_CANARY_F9EDE9"],
    },
    {
      label: "terminal and bidi repository path",
      args: ["prove", "--repo", "/tmp/ROOT_CONTROL_SECRET_CANARY_F9EDE9\u001b[2J\r\n\u202E\u200B"],
      canaries: ["ROOT_CONTROL_SECRET_CANARY_F9EDE9", "\u001b", "\u202E", "\u200B"],
    },
  ];

  for (const fixture of rootCases) {
    const source = captured(() => run(fixture.args));
    assert.equal(source.status, 2, `source: ${fixture.label}`);
    assert.equal(source.stdout, "", `source stdout: ${fixture.label}`);
    for (const canary of fixture.canaries) assert.equal(`${source.stdout}${source.stderr}`.includes(canary), false, `source canary: ${fixture.label}`);

    const bundled = spawnSync(process.execPath, [resolve("dist/cli.js"), ...fixture.args], {
      cwd: resolve("."),
      encoding: "utf8",
      env: withoutInheritedNodeCoverage(),
    });
    assert.equal(bundled.status, 2, `bundle: ${fixture.label}`);
    assert.equal(bundled.stdout, "", `bundle stdout: ${fixture.label}`);
    for (const canary of fixture.canaries) assert.equal(`${bundled.stdout}${bundled.stderr}`.includes(canary), false, `bundle canary: ${fixture.label}`);
    assert.equal(existsSync(rootArtifact), false, `root artifact: ${fixture.label}`);
  }

  const upgradeCases = [
    {
      label: "accepted verification path",
      args: ["verify", "/tmp/UPGRADE_PATH_SECRET_CANARY_F9EDE9.json"],
      canaries: ["UPGRADE_PATH_SECRET_CANARY_F9EDE9"],
    },
    {
      label: "accepted manager inputs",
      args: [
        "plan", "--manager", "apm",
        "--current", "/tmp/CURRENT_URL_USER:CURRENT_SECRET@example.invalid/current.lock",
        "--candidate", "/tmp/CANDIDATE_SECRET_CANARY_F9EDE9.lock",
        "--repo", directory, "--output", "upgrade-result.json",
      ],
      canaries: ["CURRENT_URL_USER", "CURRENT_SECRET", "CANDIDATE_SECRET_CANARY_F9EDE9"],
    },
    {
      label: "malformed accepted manager value",
      args: [
        "plan", "--manager", "MALFORMED_MANAGER_VALUE_CANARY",
        "--current", "/tmp/current.lock", "--candidate", "/tmp/candidate.lock",
        "--repo", directory, "--output", "upgrade-result.json",
      ],
      canaries: ["MALFORMED_MANAGER_VALUE_CANARY"],
    },
    {
      label: "terminal and bidi verification path",
      args: ["verify", "/tmp/UPGRADE_CONTROL_SECRET_CANARY_F9EDE9\u001b[2J\r\n\u202E\u2066.json"],
      canaries: ["UPGRADE_CONTROL_SECRET_CANARY_F9EDE9", "\u001b", "\u202E", "\u2066"],
    },
  ];

  for (const fixture of upgradeCases) {
    for (const [label, invoke] of [
      ["direct", () => captured(() => runUpgradeCommand(fixture.args))],
      ["source", () => captured(() => run(["upgrade", ...fixture.args]))],
    ] as const) {
      const result = invoke();
      assert.equal(result.status, 2, `${label}: ${fixture.label}`);
      assert.equal(result.stdout, "", `${label} stdout: ${fixture.label}`);
      for (const canary of fixture.canaries) assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false, `${label} canary: ${fixture.label}`);
    }

    const bundled = spawnSync(process.execPath, [resolve("dist/cli.js"), "upgrade", ...fixture.args], {
      cwd: resolve("."),
      encoding: "utf8",
      env: withoutInheritedNodeCoverage(),
    });
    assert.equal(bundled.status, 2, `bundle: ${fixture.label}`);
    assert.equal(bundled.stdout, "", `bundle stdout: ${fixture.label}`);
    for (const canary of fixture.canaries) assert.equal(`${bundled.stdout}${bundled.stderr}`.includes(canary), false, `bundle canary: ${fixture.label}`);
    assert.equal(existsSync(upgradeArtifact), false, `upgrade artifact: ${fixture.label}`);
  }
});
