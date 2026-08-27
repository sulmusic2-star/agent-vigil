import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PINNED_CANDIDATE_IMAGE } from "../src/candidate-command.ts";
import { loadPolicy } from "../src/config.ts";
import { checkTestHarnessBinding, checkTestsPass, checkWorkspaceBinding, isHostedDirectTestCommand } from "../src/detectors/reality.ts";
import {
  buildMaintainerChecks,
  checkAutomatedReview,
  checkAttestations,
  checkChangeScope,
  checkDifferentialTest,
  collectDiffEvidence,
  loadPullRequestEvidence,
  pathMatches,
  type PullRequestEvidence,
} from "../src/maintainer.ts";
import { run } from "../src/cli.ts";

function temp(prefix = "vigil-maintainer-"): string { return mkdtempSync(join(tmpdir(), prefix)); }
function git(repo: string, ...args: string[]): string { return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim(); }
function commit(repo: string, message: string): string { git(repo, "add", "-A"); git(repo, "commit", "-qm", message); return git(repo, "rev-parse", "HEAD"); }
function withEnvironment<T>(values: Record<string, string>, action: () => T): T {
  const prior = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { return action(); }
  finally {
    for (const key of Object.keys(values)) {
      const value = prior.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
function body(login = "alice", issue = "#42"): string { return `## Agent Vigil maintainer evidence

- Responsible human: @${login}
- [x] I reviewed every changed line.
- [x] I can explain and maintain this change.
- AI assistance: agent
- Linked issue: ${issue}
- Known limitations: none known
`; }

function event(path: string, base: string, head: string, prBody = body()): string {
  const eventPath = join(temp("vigil-event-"), "event.json");
  writeFileSync(eventPath, JSON.stringify({ pull_request: { user: { login: "alice" }, body: prBody, base: { sha: base }, head: { sha: head } }, repository: { full_name: "example/repo" } }));
  return eventPath;
}

function regressionRepo(catching = true, reviewMode: "human" | "automated" = "human", testScript = "node --test test/*.test.js"): { repo: string; base: string; head: string; event: string } {
  const repo = temp();
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: testScript } }));
  writeFileSync(join(repo, "math.js"), "exports.add=(a,b)=>a-b;\n");
  writeFileSync(join(repo, "test", "smoke.test.js"), "const test=require('node:test');const assert=require('node:assert/strict');test('module',()=>assert.equal(typeof require('../math').add,'function'));\n");
  writeFileSync(join(repo, ".agent-vigil.json"), JSON.stringify({
    schemaVersion: 1,
    testCommand: "npm test --silent",
    strict: true,
    minVerified: 1,
    maintainer: {
      ...(reviewMode === "automated" ? {
        reviewMode: "automated",
        requireHumanAttestation: false,
        automatedReview: { commands: [testScript === "node --test test/*.test.js" ? testScript : "npm test --silent"], timeoutSeconds: 30 },
      } : { requireHumanAttestation: true }),
      requireLinkedIssue: true,
      requireAiDisclosure: true,
      maxChangedFiles: 5,
      maxChangedLines: 100,
      requireTestChange: true,
      protectedPaths: [".github/workflows/**", ".agent-vigil.json"],
      testPathPatterns: ["test/**"],
      differentialTest: { command: "npm test --silent", timeoutSeconds: 30, overlayChangedTests: true },
    },
  }, null, 2));
  const base = commit(repo, "base");
  if (catching) writeFileSync(join(repo, "math.js"), "exports.add=(a,b)=>a+b;\n");
  else writeFileSync(join(repo, "README.md"), "unrelated\n");
  writeFileSync(join(repo, "test", "regression.test.js"), `const test=require('node:test');const assert=require('node:assert/strict');test('regression',()=>assert.equal(require('../math').add(2,1),${catching ? 3 : 1}));\n`);
  const head = commit(repo, "candidate");
  const prBody = reviewMode === "automated" ? "- AI assistance: agent\n- Linked issue: #42\n" : body();
  return { repo, base, head, event: event(repo, base, head, prBody) };
}

test("path patterns match nested and root test conventions without substring leaks", () => {
  assert.equal(pathMatches("src/math.test.ts", ["**/*.test.*"]), true);
  assert.equal(pathMatches("test/a.js", ["test/**"]), true);
  assert.equal(pathMatches("contest/a.js", ["test/**"]), false);
  assert.equal(pathMatches("src\\outside.ts", ["src/**"]), false, "literal Git backslashes are filename bytes, not separators");
  assert.equal(pathMatches("src/inside.ts", ["src\\**"]), true, "legacy pattern separators remain normalized");
});

test("pull request event parser rejects non-PR event payloads", () => {
  const path = join(temp(), "event.json"); writeFileSync(path, "{}");
  assert.throws(() => loadPullRequestEvidence(path), /pull_request/);
});

test("attestation checks bind the responsible human to the event author", () => {
  const evidence: PullRequestEvidence = { author: "alice", body: body() };
  const checks = checkAttestations(evidence, { requireHumanAttestation: true, requireLinkedIssue: true, requireAiDisclosure: true });
  assert.equal(checks.every((check) => check.verdict === "verified"), true);
  assert.match(checks[0].evidence, /not understanding/);
});

test("attestation checks fail closed on a different login, unchecked review, and missing issue", () => {
  const evidence: PullRequestEvidence = { author: "alice", body: body("mallory", "not-applicable").replace("[x] I reviewed", "[ ] I reviewed") };
  const checks = checkAttestations(evidence, { requireHumanAttestation: true, requireLinkedIssue: true, requireAiDisclosure: true });
  assert.ok(checks.some((check) => check.ruleId === "responsible-human" && check.verdict === "contradicted"));
  assert.ok(checks.some((check) => check.ruleId === "human-review-attestation" && check.verdict === "contradicted"));
  assert.ok(checks.some((check) => check.ruleId === "linked-issue" && check.verdict === "contradicted"));
});

test("automated review mode does not require human declarations", () => {
  const evidence: PullRequestEvidence = { author: "alice", body: "- AI assistance: agent\n- Linked issue: #42\n" };
  const checks = checkAttestations(evidence, { reviewMode: "automated", requireLinkedIssue: true, requireAiDisclosure: true });
  assert.equal(checks.some((check) => check.ruleId?.startsWith("human-") || check.ruleId === "responsible-human"), false);
  assert.equal(checks.every((check) => check.verdict === "verified"), true);
});

test("scope gate counts exact files and lines, requires tests, and protects paths", () => {
  const checks = checkChangeScope({ paths: ["src/a.ts", ".agent-vigil.json"], testPaths: [], changedLines: 19, binaryPaths: [] }, {
    maxChangedFiles: 1, maxChangedLines: 10, requireTestChange: true, protectedPaths: [".agent-vigil.json"],
  });
  assert.equal(checks.filter((check) => check.verdict === "contradicted").length, 4);
});

test("scope evidence counts protected deletions while excluding deleted tests from overlays", () => {
  const repo = temp("vigil-protected-deletion-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, ".github", "workflows", "agent-vigil.yml"), "name: Agent Vigil\n");
  writeFileSync(join(repo, ".agent-vigil.json"), '{"schemaVersion":1}\n');
  writeFileSync(join(repo, "test", "old.test.js"), "// old\n");
  const base = commit(repo, "base protected paths");
  unlinkSync(join(repo, ".github", "workflows", "agent-vigil.yml"));
  unlinkSync(join(repo, ".agent-vigil.json"));
  unlinkSync(join(repo, "test", "old.test.js"));
  const head = commit(repo, "delete protected paths");

  const diff = collectDiffEvidence(repo, base, head, ["test/**"]);
  assert.deepEqual(diff.paths.sort(), [".agent-vigil.json", ".github/workflows/agent-vigil.yml", "test/old.test.js"]);
  assert.deepEqual(diff.testPaths, []);
  const protectedCheck = checkChangeScope(diff, { protectedPaths: [".github/workflows/**", ".agent-vigil.json"] })
    .find((check) => check.ruleId === "protected-path");
  assert.equal(protectedCheck?.verdict, "contradicted");
  assert.match(protectedCheck?.evidence ?? "", /\.agent-vigil\.json/);
  assert.match(protectedCheck?.evidence ?? "", /\.github\/workflows\/agent-vigil\.yml/);
});

test("scope evidence preserves odd Git paths and protects both sides of a rename", () => {
  const repo = temp("vigil-odd-scope-paths-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  mkdirSync(join(repo, "protected"));
  mkdirSync(join(repo, "docs"));
  const oddPaths = process.platform === "win32"
    ? ["protected/unicode-é.ts"]
    : ["protected/back\\slash.ts", "protected/tab\tname.ts", "protected/new\nline.ts"];
  const binaryPath = process.platform === "win32" ? "protected/binary-é.dat" : "protected/binary\tvalue.dat";
  writeFileSync(join(repo, "protected", "guard.ts"), "export const guard = true;\n");
  for (const path of oddPaths) writeFileSync(join(repo, path), "export const value = 1;\n");
  writeFileSync(join(repo, binaryPath), Buffer.from([0, 1, 2]));
  const base = commit(repo, "odd path baseline");
  git(repo, "mv", "protected/guard.ts", "docs/guard.ts");
  writeFileSync(join(repo, "docs", "guard.ts"), "export const guard = false;\n");
  for (const path of oddPaths) writeFileSync(join(repo, path), "export const value = 2;\n");
  writeFileSync(join(repo, binaryPath), Buffer.from([0, 3, 4]));
  const head = commit(repo, "odd path changes and rename");

  const diff = collectDiffEvidence(repo, base, head);
  for (const path of [...oddPaths, "protected/guard.ts", "docs/guard.ts", binaryPath]) {
    assert.ok(diff.paths.includes(path), `missing exact Git path ${JSON.stringify(path)}`);
  }
  assert.deepEqual(diff.binaryPaths, [binaryPath]);
  assert.equal(diff.changedLines, undefined);
  const protectedCheck = checkChangeScope(diff, { protectedPaths: ["protected/**"] })
    .find((check) => check.ruleId === "protected-path");
  assert.equal(protectedCheck?.verdict, "contradicted");
  assert.match(protectedCheck?.evidence ?? "", /protected\/guard\.ts/);
});

test("binary diffs make a changed-line budget inconclusive instead of pretending to count", () => {
  const check = checkChangeScope({ paths: ["image.png"], testPaths: [], binaryPaths: ["image.png"] }, { maxChangedLines: 10 })[0];
  assert.equal(check.verdict, "unverifiable");
  assert.equal(check.blocksPass, true);
});

test("differential proof passes only when candidate tests fail on base source and pass on head", () => {
  const fixture = regressionRepo(true);
  const diff = collectDiffEvidence(fixture.repo, fixture.base, fixture.head, ["test/**"]);
  const check = checkDifferentialTest(fixture.repo, fixture.base, fixture.head, diff.testPaths, { command: "npm test --silent", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "verified");
  assert.match(check.evidence, /base source failed/);
});

test("differential proof rejects a new test that already passes on base", () => {
  const fixture = regressionRepo(false);
  const diff = collectDiffEvidence(fixture.repo, fixture.base, fixture.head, ["test/**"]);
  const check = checkDifferentialTest(fixture.repo, fixture.base, fixture.head, diff.testPaths, { command: "npm test --silent", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "contradicted");
  assert.equal(check.ruleId, "differential-base-fail");
});

test("differential setup failures are inconclusive rather than false failures", () => {
  const fixture = regressionRepo(true);
  const diff = collectDiffEvidence(fixture.repo, fixture.base, fixture.head, ["test/**"]);
  const check = checkDifferentialTest(fixture.repo, fixture.base, fixture.head, diff.testPaths, { command: "npm test --silent", setupCommand: "exit 17", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "unverifiable");
  assert.equal(check.ruleId, "differential-setup");
  assert.equal(check.blocksPass, true);
});

test("differential base failure can be pinned to a trusted output pattern", () => {
  const fixture = regressionRepo(true);
  const diff = collectDiffEvidence(fixture.repo, fixture.base, fixture.head, ["test/**"]);
  const check = checkDifferentialTest(fixture.repo, fixture.base, fixture.head, diff.testPaths, { command: "npm test --silent", baseFailurePattern: "does-not-occur", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "contradicted");
  assert.equal(check.ruleId, "differential-failure-pattern");
});

test("symlink test overlays fail closed", {
  skip: process.platform === "win32" ? "Git does not preserve symlink blobs in an unprivileged Windows checkout" : false,
}, () => {
  const fixture = regressionRepo(true);
  symlinkSync("../math.js", join(fixture.repo, "test", "linked.test.js"));
  const head = commit(fixture.repo, "symlink test");
  const check = checkDifferentialTest(fixture.repo, fixture.head, head, ["test/linked.test.js"], { command: "npm test --silent", overlayChangedTests: true, timeoutSeconds: 30 });
  assert.equal(check.verdict, "unverifiable");
  assert.match(check.evidence, /symlink/);
});

test("differential overlays reject a trusted-base symlink ancestor before writing outside the worktree", {
  skip: process.platform === "win32" ? "Git does not preserve symlink blobs in an unprivileged Windows checkout" : false,
}, () => {
  const root = temp("vigil-overlay-target-ancestor-");
  try {
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "vigil@example.test");
    git(repo, "config", "user.name", "Vigil Test");
    symlinkSync(outside, join(repo, "test"));
    const base = commit(repo, "base symlink");
    unlinkSync(join(repo, "test"));
    mkdirSync(join(repo, "test"));
    writeFileSync(join(repo, "test", "regression.test.js"), "candidate bytes\n");
    const head = commit(repo, "replace symlink with test");
    const outsideTarget = join(outside, "regression.test.js");
    writeFileSync(outsideTarget, "trusted bytes\n");
    const diff = collectDiffEvidence(repo, base, head, ["test/**"]);
    assert.deepEqual(diff.testPaths, ["test/regression.test.js"]);

    const check = checkDifferentialTest(repo, base, head, diff.testPaths, { command: "true", overlayChangedTests: true, timeoutSeconds: 30 });
    assert.equal(check.verdict, "unverifiable");
    assert.equal(check.blocksPass, true);
    assert.match(check.evidence, /symlink target ancestor/);
    assert.equal(readFileSync(outsideTarget, "utf8"), "trusted bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("differential overlays reject a non-directory target ancestor", () => {
  const root = temp("vigil-overlay-target-file-ancestor-");
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "vigil@example.test");
    git(repo, "config", "user.name", "Vigil Test");
    writeFileSync(join(repo, "test"), "trusted file ancestor\n");
    const base = commit(repo, "base file ancestor");
    unlinkSync(join(repo, "test"));
    mkdirSync(join(repo, "test"));
    writeFileSync(join(repo, "test", "regression.test.js"), "candidate bytes\n");
    const head = commit(repo, "replace file with test directory");

    const check = checkDifferentialTest(repo, base, head, ["test/regression.test.js"], { command: "true", overlayChangedTests: true, timeoutSeconds: 30 });
    assert.equal(check.verdict, "unverifiable");
    assert.equal(check.blocksPass, true);
    assert.match(check.evidence, /non-directory target ancestor/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("differential overlays reject a candidate source ancestor symlink", {
  skip: process.platform === "win32" ? "Git does not preserve symlink blobs in an unprivileged Windows checkout" : false,
}, () => {
  const root = temp("vigil-overlay-source-ancestor-");
  try {
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "vigil@example.test");
    git(repo, "config", "user.name", "Vigil Test");
    mkdirSync(join(repo, "test"));
    writeFileSync(join(repo, "test", "smoke.test.js"), "base bytes\n");
    const base = commit(repo, "base directory");
    rmSync(join(repo, "test"), { recursive: true });
    writeFileSync(join(outside, "injected.test.js"), "outside bytes\n");
    symlinkSync(outside, join(repo, "test"));
    const head = commit(repo, "candidate source symlink");

    const check = checkDifferentialTest(repo, base, head, ["test/injected.test.js"], { command: "true", overlayChangedTests: true, timeoutSeconds: 30 });
    assert.equal(check.verdict, "unverifiable");
    assert.equal(check.blocksPass, true);
    assert.match(check.evidence, /symlink source ancestor/);
    assert.equal(readFileSync(join(outside, "injected.test.js"), "utf8"), "outside bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("differential overlays reject an existing symlink target", {
  skip: process.platform === "win32" ? "Git does not preserve symlink blobs in an unprivileged Windows checkout" : false,
}, () => {
  const root = temp("vigil-overlay-target-leaf-");
  try {
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(repo);
    mkdirSync(outside);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "vigil@example.test");
    git(repo, "config", "user.name", "Vigil Test");
    mkdirSync(join(repo, "test"));
    const outsideTarget = join(outside, "trusted.test.js");
    writeFileSync(outsideTarget, "trusted bytes\n");
    symlinkSync(outsideTarget, join(repo, "test", "regression.test.js"));
    const base = commit(repo, "base target symlink");
    unlinkSync(join(repo, "test", "regression.test.js"));
    writeFileSync(join(repo, "test", "regression.test.js"), "candidate bytes\n");
    const head = commit(repo, "replace target symlink");

    const check = checkDifferentialTest(repo, base, head, ["test/regression.test.js"], { command: "true", overlayChangedTests: true, timeoutSeconds: 30 });
    assert.equal(check.verdict, "unverifiable");
    assert.equal(check.blocksPass, true);
    assert.match(check.evidence, /replace symlink test path/);
    assert.equal(readFileSync(outsideTarget, "utf8"), "trusted bytes\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("automated review runs base-policy setup and commands in the exact isolated candidate", () => {
  const fixture = regressionRepo(true);
  const checks = checkAutomatedReview(fixture.repo, fixture.head, {
    setupCommand: `node -e "require('node:fs').writeFileSync('setup.tmp','ready')"`,
    commands: [
      `node -e "if(require('node:fs').readFileSync('setup.tmp','utf8')!=='ready')process.exit(1)"`,
      `node -e "if(require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!=='${fixture.head}')process.exit(1)"`,
    ],
    timeoutSeconds: 30,
  });
  assert.equal(checks.filter((check) => check.ruleId === "automated-review-command" && check.verdict === "verified").length, 2);
  assert.equal(checks.some((check) => check.verdict !== "verified"), false);
  assert.match(checks[0].evidence, /not human understanding/);
});

test("local candidate commands use the checkpoint PATH without inheriting verifier credentials", { skip: Boolean(process.env.NODE_V8_COVERAGE) || process.platform === "win32" }, () => {
  const fixture = regressionRepo(true);
  const root = temp("vigil-maintainer-env-");
  const childPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const childHome = join(root, "home");
  const observed = join(root, "observed.json");
  mkdirSync(childHome);
  const fixtureScript = join(root, "capture-environment.cjs");
  writeFileSync(fixtureScript, `require("node:fs").writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.env));\n`);

  const checks = withEnvironment({
    AGENT_VIGIL_INTERNAL_TEST_PATH: childPath,
    AGENT_VIGIL_INTERNAL_TEST_HOME: childHome,
    AGENT_VIGIL_INTERNAL_GIT_BIN: "/usr/bin/git",
    VIGIL_GITHUB_TOKEN: "must-not-cross",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-cross",
    GITHUB_OUTPUT: join(root, "github-output"),
    GITHUB_ACTION_PATH: join(root, "action-bundle"),
    RUNNER_TEMP: join(root, "runner-temp"),
  }, () => checkAutomatedReview(fixture.repo, fixture.head, {
    commands: [`node ${JSON.stringify(fixtureScript)}`],
    timeoutSeconds: 30,
  }));

  assert.equal(checks.some((check) => check.verdict !== "verified"), false, JSON.stringify(checks, null, 2));
  const child = JSON.parse(readFileSync(observed, "utf8")) as Record<string, string>;
  const allowed = new Set(["CI", "HOME", "LANG", "LC_ALL", "PATH", "PWD", "SHLVL", "TZ", "_", "__CF_USER_TEXT_ENCODING"]);
  assert.deepEqual(Object.keys(child).filter((key) => !allowed.has(key)), []);
  assert.equal(child.PATH, childPath);
  assert.equal(child.HOME, childHome);
  for (const key of ["VIGIL_GITHUB_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "GITHUB_OUTPUT", "GITHUB_ACTION_PATH", "RUNNER_TEMP"]) {
    assert.equal(child[key], undefined, `${key} leaked into a candidate command`);
  }
});

test("local candidate commands use the native Windows command processor", { skip: process.platform !== "win32" }, () => {
  const repo = temp("vigil-windows-command-");
  const checks = checkTestsPass([
    { kind: "tests_pass", quote: "the Windows local command passed", subject: "Windows local shell" },
  ], repo, 'node -e "console.log(\'# tests 1\\n# pass 1\\n# fail 0\')"');
  assert.equal(checks[0]?.verdict, "verified");
});

test("Action candidate isolation uses a private digest-pinned container with minimal authority and deterministic cleanup", { skip: process.platform === "win32" }, () => {
  const fixture = regressionRepo(true);
  writeFileSync(join(fixture.repo, "history-secret.txt"), "prior committed secret must not cross\n");
  const historySecretCommit = commit(fixture.repo, "temporary historical secret");
  const historySecretBlob = git(fixture.repo, "rev-parse", `${historySecretCommit}:history-secret.txt`);
  unlinkSync(join(fixture.repo, "history-secret.txt"));
  const sourceHead = commit(fixture.repo, "remove historical secret");
  git(fixture.repo, "checkout", "-qb", "candidate-other-ref");
  writeFileSync(join(fixture.repo, "branch-secret.txt"), "other ref secret must not cross\n");
  const branchSecretCommit = commit(fixture.repo, "other ref secret");
  const branchSecretBlob = git(fixture.repo, "rev-parse", `${branchSecretCommit}:branch-secret.txt`);
  git(fixture.repo, "checkout", "-q", "--detach", sourceHead);
  const root = temp("vigil-fake-docker-");
  const home = join(root, "trusted-home");
  const candidateRoot = join(root, "candidate-sandboxes");
  const log = join(root, "docker.jsonl");
  const docker = join(root, "docker");
  mkdirSync(home);
  mkdirSync(candidateRoot, { mode: 0o700 });
  writeFileSync(docker, `#!${process.execPath}\nconst fs=require("node:fs");\nconst cp=require("node:child_process");\nconst args=process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args,env:process.env})+"\\n");\nif(args[0]==="run"){const mount=args[args.indexOf("--mount")+1];const sandbox=/source=(.+),target=\\/workspace(?:,readonly)?$/.exec(mount)[1];for(const object of ${JSON.stringify([historySecretCommit, historySecretBlob, branchSecretCommit, branchSecretBlob])}){if(cp.spawnSync("git",["-C",sandbox,"cat-file","-e",object]).status===0)process.exit(12);}if(cp.execFileSync("git",["-C",sandbox,"rev-list","--count","HEAD"],{encoding:"utf8"}).trim()!=="1")process.exit(13);if(cp.execFileSync("git",["-C",sandbox,"for-each-ref","--format=%(refname)"],{encoding:"utf8"}).trim())process.exit(14);const command=args.at(-2);if(command==="npm ci --ignore-scripts")fs.writeFileSync(sandbox+"/setup.marker","ready");if(command==="node --test test.js"&&!fs.existsSync(sandbox+"/setup.marker"))process.exit(9);process.stdout.write("# tests 1\\n# pass 1\\n# fail 0\\n");process.exit(0);}\nif(args[0]==="container"&&args[1]==="inspect")process.stderr.write("Error: No such container: "+args[2]+"\\n");\nprocess.exit(1);\n`);
  chmodSync(docker, 0o500);

  const claim = { kind: "tests_pass" as const, quote: "isolated test", subject: "candidate tests" };
  const verdicts = withEnvironment({
    AGENT_VIGIL_INTERNAL_ISOLATE_CANDIDATE: "true",
    AGENT_VIGIL_INTERNAL_DOCKER_BIN: realpathSync(docker),
    AGENT_VIGIL_INTERNAL_CANDIDATE_IMAGE: PINNED_CANDIDATE_IMAGE,
    AGENT_VIGIL_INTERNAL_CANDIDATE_ROOT: realpathSync(candidateRoot),
    AGENT_VIGIL_INTERNAL_CANDIDATE_SETUP_COMMAND: "npm ci --ignore-scripts",
    AGENT_VIGIL_INTERNAL_TEST_HOME: home,
    VIGIL_GITHUB_TOKEN: "must-not-enter-docker-or-candidate-env",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-enter-docker-or-candidate-env",
    GITHUB_OUTPUT: join(root, "github-output"),
    GITHUB_ACTION_PATH: join(root, "action-bundle"),
    RUNNER_TEMP: join(root, "runner-temp"),
    GITHUB_WORKSPACE: realpathSync(fixture.repo),
  }, () => [
    checkTestsPass([claim], fixture.repo, "node --test test.js", undefined, sourceHead, sourceHead)[0].verdict,
    checkTestsPass([claim], fixture.repo, "node --test test.js", undefined, sourceHead, sourceHead)[0].verdict,
  ]);
  assert.deepEqual(verdicts, ["verified", "verified"]);

  writeFileSync(join(fixture.repo, "host-only-secret.txt"), "untracked secret must not cross\n");
  const untracked = withEnvironment({
    AGENT_VIGIL_INTERNAL_ISOLATE_CANDIDATE: "true",
    AGENT_VIGIL_INTERNAL_DOCKER_BIN: realpathSync(docker),
    AGENT_VIGIL_INTERNAL_CANDIDATE_IMAGE: PINNED_CANDIDATE_IMAGE,
    AGENT_VIGIL_INTERNAL_CANDIDATE_ROOT: realpathSync(candidateRoot),
    AGENT_VIGIL_INTERNAL_TEST_HOME: home,
    GITHUB_WORKSPACE: realpathSync(fixture.repo),
  }, () => checkTestsPass([claim], fixture.repo, "node --test test.js", undefined, sourceHead, sourceHead)[0]);
  assert.equal(untracked.verdict, "unverifiable");
  assert.match(untracked.evidence, /outside the exact commit/);
  unlinkSync(join(fixture.repo, "host-only-secret.txt"));

  writeFileSync(join(fixture.repo, "math.js"), "tracked secret must not cross\n");
  const modified = withEnvironment({
    AGENT_VIGIL_INTERNAL_ISOLATE_CANDIDATE: "true",
    AGENT_VIGIL_INTERNAL_DOCKER_BIN: realpathSync(docker),
    AGENT_VIGIL_INTERNAL_CANDIDATE_IMAGE: PINNED_CANDIDATE_IMAGE,
    AGENT_VIGIL_INTERNAL_CANDIDATE_ROOT: realpathSync(candidateRoot),
    AGENT_VIGIL_INTERNAL_TEST_HOME: home,
    GITHUB_WORKSPACE: realpathSync(fixture.repo),
  }, () => checkTestsPass([claim], fixture.repo, "node --test test.js", undefined, sourceHead, sourceHead)[0]);
  assert.equal(modified.verdict, "unverifiable");
  assert.match(modified.evidence, /outside the exact commit/);
  git(fixture.repo, "checkout", "--", "math.js");

  const rows = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; env: Record<string, string> });
  const runs = rows.filter((row) => row.args[0] === "run");
  assert.equal(runs.length, 3, "dependency setup should run once and the isolated test twice");
  assert.deepEqual(runs.map((row) => row.args.at(-2)), ["npm ci --ignore-scripts", "node --test test.js", "node --test test.js"]);
  for (const [index, row] of runs.entries()) {
    const args = row.args;
    const option = (name: string): string => args[args.indexOf(name) + 1];
    assert.ok(args.includes("--rm"));
    assert.equal(option("--pull"), "never");
    assert.equal(option("--network"), index === 0 ? "bridge" : "none");
    assert.ok(args.includes("--read-only"));
    assert.equal(option("--cap-drop"), "ALL");
    assert.equal(option("--security-opt"), "no-new-privileges");
    assert.equal(option("--user"), "1001:1001");
    assert.equal(args.some((argument) => argument === "--pid" || argument.startsWith("--pid=")), false,
      "Docker's default private PID namespace must remain in effect");
    assert.equal(option("--ipc"), "private");
    assert.equal(option("--pids-limit"), "512");
    assert.equal(option("--entrypoint"), "/usr/bin/env");
    assert.ok(args.includes(PINNED_CANDIDATE_IMAGE));

    const mounts = args.flatMap((value, position) => value === "--mount" ? [args[position + 1]] : []);
    assert.equal(mounts.length, 2);
    const sandbox = /^type=bind,source=(.+),target=\/workspace(?:,readonly)?$/.exec(mounts[0])?.[1];
    assert.ok(sandbox);
    assert.equal(mounts[0].endsWith(",readonly"), index !== 0, "only dependency setup receives a writable workspace mount");
    assert.equal(dirname(sandbox), realpathSync(candidateRoot));
    assert.notEqual(sandbox, realpathSync(fixture.repo));
    assert.equal(mounts[1], `type=bind,source=${join(sandbox, ".git")},target=/workspace/.git,readonly`);

    assert.equal(args.includes("--env"), false, "the entrypoint must clear image ENV before candidate code runs");
    const imageIndex = args.indexOf(PINNED_CANDIDATE_IMAGE);
    const candidateEnvironment = args.slice(imageIndex + 1, imageIndex + 9);
    assert.deepEqual(candidateEnvironment, [
      "-i", "CI=true", "HOME=/home/candidate", "LANG=C", "LC_ALL=C", "NPM_CONFIG_CACHE=/tmp/npm-cache", "TZ=UTC",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ]);
    assert.equal(args[imageIndex + 9], "/usr/local/bin/node");
    assert.equal(Object.keys(row.env).some((key) => key.startsWith("AGENT_VIGIL_") || key.startsWith("GITHUB_") || key.startsWith("ACTIONS_")), false);
    assert.equal(Object.values(row.env).includes("must-not-enter-docker-or-candidate-env"), false);

    const name = option("--name");
    assert.match(name, /^agent-vigil-candidate-\d+-[a-f0-9]{20}$/);
    assert.ok(rows.some((candidate) => candidate.args.join("\0") === ["rm", "--force", "--volumes", name].join("\0")));
    assert.ok(rows.some((candidate) => candidate.args.join("\0") === ["container", "inspect", name].join("\0")));
  }
  assert.equal(new Set(runs.map((row) => row.args[row.args.indexOf("--name") + 1])).size, 3);
});

test("trusted parent Git disables a candidate-controlled core.fsmonitor hook", { skip: process.platform === "win32" }, () => {
  const fixture = regressionRepo(true);
  const root = temp("vigil-fsmonitor-canary-");
  const marker = join(root, "fsmonitor-ran");
  const canary = join(root, "fsmonitor");
  writeFileSync(canary, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nprintf '\\n'\n`);
  chmodSync(canary, 0o500);
  git(fixture.repo, "config", "core.fsmonitor", canary);

  git(fixture.repo, "status", "--porcelain=v1");
  assert.equal(existsSync(marker), true, "control Git invocation must demonstrate the canary is executable");
  unlinkSync(marker);

  const binding = checkWorkspaceBinding(fixture.repo, fixture.head);
  assert.equal(binding[0].verdict, "verified", JSON.stringify(binding));
  assert.equal(existsSync(marker), false, "hardened Git must override repository core.fsmonitor");
});

test("automated review fails a nonzero command instead of approving it", () => {
  const fixture = regressionRepo(true);
  const checks = checkAutomatedReview(fixture.repo, fixture.head, { commands: [`node -e "process.exit(7)"`], timeoutSeconds: 30 });
  assert.ok(checks.some((check) => check.ruleId === "automated-review-command" && check.verdict === "contradicted"));
});

test("automated review is inconclusive when a command times out", () => {
  const fixture = regressionRepo(true);
  const checks = checkAutomatedReview(fixture.repo, fixture.head, { commands: [`node -e "setTimeout(()=>{},10000)"`], timeoutSeconds: 1 });
  assert.ok(checks.some((check) => check.ruleId === "automated-review-command" && check.verdict === "unverifiable" && check.blocksPass));
});

test("automated review rejects tracked-file mutation", () => {
  const fixture = regressionRepo(true);
  const checks = checkAutomatedReview(fixture.repo, fixture.head, {
    commands: [`node -e "require('node:fs').writeFileSync('math.js','tampered')"`], timeoutSeconds: 30,
  });
  assert.ok(checks.some((check) => check.ruleId === "automated-review-worktree" && check.verdict === "contradicted"));
});

test("automated review rejects a command that moves HEAD", () => {
  const fixture = regressionRepo(true);
  const checks = checkAutomatedReview(fixture.repo, fixture.head, { commands: ["git checkout --detach HEAD~1"], timeoutSeconds: 30 });
  assert.ok(checks.some((check) => check.ruleId === "automated-review-head" && check.verdict === "unverifiable" && check.blocksPass));
});

test("maintainer checks catch over-broad and non-catching PRs as separate contradictions", () => {
  const fixture = regressionRepo(false);
  const policy = loadPolicy(fixture.repo, ".agent-vigil.json", fixture.base).value.maintainer!;
  const evidence = loadPullRequestEvidence(fixture.event);
  const checks = buildMaintainerChecks(fixture.repo, fixture.base, fixture.head, evidence, { ...policy, maxChangedFiles: 1 });
  assert.ok(checks.some((check) => check.ruleId === "changed-file-budget" && check.verdict === "contradicted"));
  assert.ok(checks.some((check) => check.ruleId === "differential-base-fail" && check.verdict === "contradicted"));
});

test("maintainer refuses a candidate-modified package test dispatcher before executing review commands", () => {
  const fixture = regressionRepo(true, "automated");
  writeFileSync(join(fixture.repo, "package.json"), JSON.stringify({
    scripts: { test: "node -e \"console.log('# tests 1\\n# pass 1\\n# fail 0')\"" },
  }));
  const head = commit(fixture.repo, "forge candidate test dispatcher");
  const policy = loadPolicy(fixture.repo, ".agent-vigil.json", fixture.base).value.maintainer!;
  const evidence = loadPullRequestEvidence(event(fixture.repo, fixture.base, head, "- AI assistance: agent\n- Linked issue: #42\n"));
  const checks = buildMaintainerChecks(fixture.repo, fixture.base, head, evidence, policy, "npm test --silent");
  const harness = checks.find((check) => check.ruleId === "test-harness-unbound");
  assert.equal(harness?.verdict, "unverifiable");
  assert.equal(harness?.blocksPass, true);
  assert.equal(checks.some((check) => check.ruleId === "differential-test" || check.ruleId === "automated-review-command"), false);
});

test("hosted direct-test grammar rejects dispatchers and shell-controlled execution", () => {
  for (const command of [
    "node --test",
    "node --test test.js",
    "node --test --test-reporter=tap --test-concurrency=4 test/*.test.js",
  ]) assert.equal(isHostedDirectTestCommand(command), true, command);
  for (const command of [
    "npm test --silent",
    "npx tsx --test test/*.test.ts",
    "./node_modules/.bin/tsx --test test/*.test.ts",
    "node scripts/test.js",
    "node --test scripts/forged-runner.js",
    "node --test package.json",
    "node --import ./candidate-loader.js --test",
    "node --test *.test.js",
    "./node_modules/.bin/tsx --test *.test.ts",
    "node --test --import=candidate-loader.test.js",
    "node --test test/*.test.js && echo pass",
    "./node_modules/.bin/tsx --test",
    "./node_modules/.bin/tsx --test ../outside.test.ts",
    "node --test --test-reporter=./candidate-reporter.js test/*.test.js",
  ]) assert.equal(isHostedDirectTestCommand(command), false, command);
});

test("hosted verification refuses npm and repository-wrapper dispatch before candidate execution", () => {
  const fixture = regressionRepo(true, "automated");
  const claim = { kind: "tests_pass" as const, quote: "tests pass", subject: "fresh tests" };
  const directCheck = withEnvironment({ AGENT_VIGIL_INTERNAL_ISOLATE_CANDIDATE: "true" }, () =>
    checkTestsPass([claim], fixture.repo, "npm test --silent", undefined, fixture.base, fixture.head));
  assert.equal(directCheck[0]?.ruleId, "test-harness-unbound");
  assert.equal(directCheck[0]?.blocksPass, true);

  const basePolicy = loadPolicy(fixture.repo, ".agent-vigil.json", fixture.base).value.maintainer!;
  const evidence = loadPullRequestEvidence(fixture.event);
  const maintainerChecks = withEnvironment({ AGENT_VIGIL_INTERNAL_ISOLATE_CANDIDATE: "true" }, () =>
    buildMaintainerChecks(fixture.repo, fixture.base, fixture.head, evidence, {
      ...basePolicy,
      differentialTest: undefined,
      automatedReview: { commands: ["node scripts/lint.js"], timeoutSeconds: 30 },
    }, "node --test test/*.test.js"));
  assert.ok(maintainerChecks.some((check) => check.ruleId === "test-harness-unbound" && check.blocksPass));
  assert.equal(maintainerChecks.some((check) => check.ruleId === "automated-review-command"), false);
});

test("test harness binding rejects version changes under npm and permits them under a direct runner", () => {
  const repo = temp("vigil-harness-version-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    name: "example",
    version: "0.19.0",
    scripts: { test: "node --test test/*.test.js" },
    devDependencies: { typescript: "5.9.2" },
  }));
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify({
    name: "example",
    version: "0.19.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "example", version: "0.19.0", devDependencies: { typescript: "5.9.2" } },
      "node_modules/typescript": { version: "5.9.2" },
    },
  }));
  const base = commit(repo, "base release metadata");
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  manifest.version = "0.19.1";
  writeFileSync(join(repo, "package.json"), JSON.stringify(manifest));
  const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
  lock.version = "0.19.1";
  lock.packages[""].version = "0.19.1";
  writeFileSync(join(repo, "package-lock.json"), JSON.stringify(lock));
  const head = commit(repo, "release version only");

  const dispatcher = checkTestHarnessBinding(repo, base, head, ["npm test --silent"], true);
  assert.equal(dispatcher.verdict, "unverifiable");
  assert.equal(dispatcher.ruleId, "test-harness-unbound");
  const direct = checkTestHarnessBinding(repo, base, head, ["node --test test/*.test.js"], true);
  assert.equal(direct.verdict, "verified");
  assert.equal(direct.ruleId, "test-harness-bound");
});

test("test harness binding rejects a nested workspace test dispatcher change", () => {
  const repo = temp("vigil-harness-workspace-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  mkdirSync(join(repo, "packages", "widget"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    scripts: { test: "node --test packages/*/test/*.test.js" },
    workspaces: ["packages/*"],
  }));
  writeFileSync(join(repo, "packages", "widget", "package.json"), JSON.stringify({
    name: "@example/widget",
    scripts: { test: "node --test test/*.test.js" },
  }));
  const base = commit(repo, "base workspace harness");
  writeFileSync(join(repo, "packages", "widget", "package.json"), JSON.stringify({
    name: "@example/widget",
    scripts: { test: "node -e \"console.log('# tests 1\\n# pass 1\\n# fail 0')\"" },
  }));
  const head = commit(repo, "forge nested dispatcher");

  const result = checkTestHarnessBinding(repo, base, head, ["node --test test/*.test.js"], true);
  assert.equal(result.verdict, "unverifiable");
  assert.equal(result.ruleId, "test-harness-unbound");
  assert.match(result.evidence, /packages\/widget\/package\.json/);
});

test("hosted harness binding rejects symlinked package inputs and repository npm configuration", () => {
  const repo = temp("vigil-harness-symlink-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  mkdirSync(join(repo, "config"));
  writeFileSync(join(repo, "config", "manifest.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  symlinkSync("config/manifest.json", join(repo, "package.json"));
  const base = commit(repo, "base symlinked harness");
  writeFileSync(join(repo, "feature.js"), "export const value = 1;\n");
  const head = commit(repo, "candidate source");
  const symlinked = checkTestHarnessBinding(repo, base, head, ["node --test"], true);
  assert.equal(symlinked.verdict, "unverifiable");
  assert.match(symlinked.evidence, /regular Git files/);

  unlinkSync(join(repo, "package.json"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  writeFileSync(join(repo, ".npmrc"), "cafile=config/candidate-ca.pem\n");
  const npmBase = commit(repo, "base npm config");
  writeFileSync(join(repo, "config", "candidate-ca.pem"), "candidate controlled\n");
  const npmHead = commit(repo, "change npm config target");
  const npmConfig = checkTestHarnessBinding(repo, npmBase, npmHead, ["node --test"], true, ["npm ci --ignore-scripts"]);
  assert.equal(npmConfig.verdict, "unverifiable");
  assert.match(npmConfig.evidence, /does not accept repository \.npmrc/);
});

test("CLI maintainer mode emits a PASS receipt for a bounded catching regression", () => {
  const fixture = regressionRepo(true);
  const output = join(temp(), "report.json");
  assert.equal(run(["maintainer", "--event", fixture.event, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 0);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.summary.status, "PASS");
  assert.equal(report.transcriptFormat, "pull-request-evidence");
  assert.ok(report.results.some((check: { ruleId: string }) => check.ruleId === "differential-test"));
});

test("required maintainer receipt blocks an unapproved agent server", () => {
  const fixture = regressionRepo(true);
  writeFileSync(join(fixture.repo, ".mcp.json"), JSON.stringify({ mcpServers: { deploy: { url: "https://deploy.example.com/mcp" } } }));
  const head = commit(fixture.repo, "grant deploy server");
  const eventPath = event(fixture.repo, fixture.base, head);
  const output = join(temp(), "report.json");
  assert.equal(run(["maintainer", "--event", eventPath, "--repo", fixture.repo, "--base", fixture.base, "--head", head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 1);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.summary.status, "FAIL");
  assert.ok(report.results.some((check: { ruleId: string; claim: { subject: string } }) => check.ruleId === "authority-server" && /mcp:deploy/.test(check.claim.subject)));
  assert.ok(report.results.some((check: { ruleId: string }) => check.ruleId === "authority-network"));
});

test("CLI automated review emits PASS without human review declarations", () => {
  const fixture = regressionRepo(true, "automated");
  const output = join(temp(), "report.json");
  assert.equal(run(["maintainer", "--event", fixture.event, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 0);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(report.summary.status, "PASS");
  assert.equal(report.results.some((check: { ruleId: string }) => check.ruleId === "human-review-attestation"), false);
  assert.ok(report.results.some((check: { ruleId: string; verdict: string }) => check.ruleId === "automated-review-command" && check.verdict === "verified"));
});

test("CLI maintainer reuses an exact automated-review test result instead of running it twice", () => {
  const root = temp("vigil-exact-automated-test-");
  const counter = join(root, "runs");
  const counterScript = join(root, "counter.cjs");
  writeFileSync(counterScript, `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "run\\n");\n`);
  const script = `node ${JSON.stringify(counterScript)} && node --test test/*.test.js`;
  const fixture = regressionRepo(true, "automated", script);
  const output = join(root, "report.json");
  assert.equal(run(["maintainer", "--event", fixture.event, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 0);
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 3, "two differential runs plus one automated-review run; no duplicate top-level run");
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.ok(report.results.some((check: { ruleId: string; verdict: string; evidence: string }) =>
    check.ruleId === "tests-pass" && check.verdict === "verified" && /with 2 tests/.test(check.evidence)));
});

test("a failing exact automated-review test remains blocking without a duplicate rerun", () => {
  const root = temp("vigil-failing-automated-test-");
  const counter = join(root, "runs");
  const counterScript = join(root, "counter.cjs");
  writeFileSync(counterScript, `require("node:fs").appendFileSync(${JSON.stringify(counter)}, "run\\n");\n`);
  const script = `node ${JSON.stringify(counterScript)} && node --test test/*.test.js && node -e "process.exit(7)"`;
  const fixture = regressionRepo(true, "automated", script);
  const output = join(root, "report.json");
  assert.equal(run(["maintainer", "--event", fixture.event, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 1);
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 3, "failing command is not retried outside automated review");
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.ok(report.results.some((check: { ruleId: string; verdict: string }) => check.ruleId === "tests-pass" && check.verdict === "contradicted"));
});

test("an exit-zero automated test with a failing summary cannot be reused as passing", () => {
  const root = temp("vigil-failing-summary-");
  const summaryScript = join(root, "failing-summary.cjs");
  writeFileSync(summaryScript, `console.log("# tests 1\\n# pass 0\\n# fail 1");\n`);
  const fixture = regressionRepo(true, "automated", `node ${JSON.stringify(summaryScript)}`);
  const output = join(root, "report.json");
  assert.equal(run(["maintainer", "--event", fixture.event, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 1);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.ok(report.results.some((check: { ruleId: string; verdict: string; evidence: string }) =>
    check.ruleId === "tests-pass" && check.verdict === "contradicted" && /reported 1 failed test/.test(check.evidence)));
});

test("a failing summary after redacted candidate output cannot be hidden by an earlier PASS", () => {
  const root = temp("vigil-long-failing-summary-");
  const summaryScript = join(root, "long-failing-summary.cjs");
  writeFileSync(summaryScript, `process.stdout.write("# tests 1\\n# pass 1\\n# fail 0\\n" + "x".repeat(13000) + "\\n# tests 1\\n# pass 0\\n# fail 1\\n");\n`);
  const fixture = regressionRepo(true, "automated", `node ${JSON.stringify(summaryScript)}`);
  const output = join(root, "report.json");
  assert.equal(run(["maintainer", "--event", fixture.event, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base, "--output", output]), 1);
  const report = JSON.parse(readFileSync(output, "utf8"));
  assert.ok(report.results.some((check: { ruleId: string; verdict: string; evidence: string }) =>
    check.ruleId === "tests-pass" && check.verdict === "contradicted" && /reported 1 failed test/.test(check.evidence)));
});

test("CLI maintainer mode rejects a forged event Git range", () => {
  const fixture = regressionRepo(true);
  const forged = event(fixture.repo, fixture.head, fixture.head);
  assert.equal(run(["maintainer", "--event", forged, "--repo", fixture.repo, "--base", fixture.base, "--head", fixture.head, "--policy", ".agent-vigil.json", "--policy-ref", fixture.base]), 2);
});

test("maintainer policy rejects unknown nested controls and invalid regex", () => {
  const fixture = regressionRepo(true);
  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: { magic: true } }));
  assert.throws(() => loadPolicy(fixture.repo), /maintainer contains unknown/);
  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: { differentialTest: { command: "test", baseFailurePattern: "[" } } }));
  assert.throws(() => loadPolicy(fixture.repo), /valid regular expression/);
});

test("maintainer policy validates explicit automated review without weakening legacy policies", () => {
  const fixture = regressionRepo(true);
  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: {
    reviewMode: "automated", requireHumanAttestation: false,
    automatedReview: { commands: ["node --test"], timeoutSeconds: 30 },
  } }));
  assert.equal(loadPolicy(fixture.repo).value.maintainer?.reviewMode, "automated");

  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: { reviewMode: "automated" } }));
  assert.throws(() => loadPolicy(fixture.repo), /requires maintainer\.automatedReview/);
  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: {
    reviewMode: "automated", requireHumanAttestation: true, automatedReview: { commands: ["node --test"] },
  } }));
  assert.throws(() => loadPolicy(fixture.repo), /conflicts/);
  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: {
    reviewMode: "automated", automatedReview: { commands: [] },
  } }));
  assert.throws(() => loadPolicy(fixture.repo), /non-empty array/);
  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: {
    automatedReview: { commands: ["node --test"] },
  } }));
  assert.throws(() => loadPolicy(fixture.repo), /requires reviewMode automated/);

  writeFileSync(join(fixture.repo, ".agent-vigil.json"), JSON.stringify({ schemaVersion: 1, maintainer: { requireHumanAttestation: false } }));
  assert.equal(loadPolicy(fixture.repo).value.maintainer?.requireHumanAttestation, false);
});
