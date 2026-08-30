import assert from "node:assert/strict";
import { execFileSync, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { run } from "../src/cli.ts";
import { generateSigningKey, publicKeyId } from "../src/signature.ts";
import { compositeActionRuntimeUnavailable, compositeActionScript } from "./action-runtime-fixture.ts";

const PINNED_CANDIDATE_IMAGE = "node@sha256:46e94f8cf91baab69a2deb3153e74eeffd73c20c7cc1d8432f5b96469eaa0322";
const ACTION_REJECTION_TIMEOUT_MS = 120_000;
const temporaryPaths: string[] = [];

after(() => {
  for (const selected of temporaryPaths.reverse()) rmSync(selected, { force: true, recursive: true });
});

function temporary(prefix: string): string {
  const selected = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryPaths.push(selected);
  return selected;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function invalidatePinnedNodeDigests(script: string): string {
  return script.replace(
    /(readonly VIGIL_PINNED_(?:LINUX_X64|MACOS_X64|MACOS_ARM64)_NODE_SHA256=)'[0-9a-f]{64}'/g,
    `$1'${"0".repeat(64)}'`,
  );
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

function baseActionEnvironment(root: string, repo: string): NodeJS.ProcessEnv {
  const runner = join(root, "runner");
  const commands = join(root, "commands");
  mkdirSync(runner);
  mkdirSync(commands);
  const output = join(commands, "output");
  const summary = join(commands, "summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  return {
    ...process.env,
    GITHUB_ACTION_PATH: realpathSync(process.cwd()),
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "pull_request_target",
    GITHUB_EVENT_PATH: "",
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "owner/repository",
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_WORKSPACE: realpathSync(repo),
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: realpathSync(runner),
    VIGIL_ACTIONS_RUN_ID: "",
    VIGIL_ATTEST: "false",
    VIGIL_AUTHORITY_CONTRACT: "",
    VIGIL_AUTHORITY_CONTRACT_REF: "",
    VIGIL_BASE: "HEAD~1",
    VIGIL_CANDIDATE_SETUP_COMMAND: "",
    VIGIL_CANDIDATE_IMAGE_INPUT: "",
    VIGIL_CONTINUITY_CHAIN: "",
    VIGIL_CONTINUITY_ENVIRONMENT: "production",
    VIGIL_GITHUB_TOKEN: "",
    VIGIL_HAS_GITHUB_TOKEN: "false",
    VIGIL_HEAD: "HEAD",
    VIGIL_HOTFIX_EVIDENCE: "",
    VIGIL_INCIDENT_EVIDENCE: "",
    VIGIL_ISOLATE_CANDIDATE: "false",
    VIGIL_MIN_VERIFIED: "1",
    VIGIL_MERGE_GROUP_EVENT: "",
    VIGIL_MODE: "",
    VIGIL_OUTCOME_RECEIPT: "",
    VIGIL_POLICY: "",
    VIGIL_POLICY_REF: "",
    VIGIL_RECEIPT: "",
    VIGIL_REPO: realpathSync(repo),
    VIGIL_REVERT_EVIDENCE: "",
    VIGIL_STRICT: "true",
    VIGIL_TEST_CMD: "",
    VIGIL_TRANSCRIPT: "",
    VIGIL_VALUE_BUDGET_USD: "",
    VIGIL_VALUE_COST_EVIDENCE: "",
    VIGIL_VALUE_COST_SOURCE: "",
    VIGIL_VALUE_COST_USD: "",
    VIGIL_VALUE_REVIEW_MINUTES: "",
    VIGIL_VALUE_TASK_CLASS: "",
  };
}

function runRejectedAction(
  overrides: NodeJS.ProcessEnv,
  transformScript: (script: string) => string = (script) => script,
): SpawnSyncReturns<string> {
  const root = temporary("vigil-action-rejection-");
  const repo = join(root, "repo");
  mkdirSync(repo);
  const script = join(root, "action.sh");
  writeFileSync(script, transformScript(compositeActionScript()));
  const env = { ...baseActionEnvironment(root, repo), ...overrides };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_V8_COVERAGE;
  return spawnSync("/bin/bash", [script], {
    cwd: repo,
    encoding: "utf8",
    env,
    timeout: ACTION_REJECTION_TIMEOUT_MS,
  });
}

test("Action leaves strictness and the evidence minimum under trusted-policy control by default", () => {
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  const strictInput = action.match(/\n  strict:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n)/)?.[1];
  const minimumInput = action.match(/\n  min-verified:\n([\s\S]*?)(?=\n  [a-z][a-z-]*:\n)/)?.[1];
  assert.ok(strictInput && minimumInput);
  assert.doesNotMatch(strictInput, /\bdefault:/);
  assert.doesNotMatch(minimumInput, /\bdefault:/);
  assert.match(action, /if \[\[ -n "\$VIGIL_MIN_VERIFIED" \]\]; then args\+=\(--min-verified "\$VIGIL_MIN_VERIFIED"\); fi/);
  assert.match(action, /if \[\[ "\$VIGIL_STRICT" == "true" \]\]; then args\+=\(--strict\); fi/);
  assert.match(action, /O_RDONLY \| fs\.constants\.O_NOFOLLOW \| fs\.constants\.O_NONBLOCK/);
  const postVerificationNode = action.match(/post_verification_node\(\) \{([\s\S]*?)(?=\n        post_verification_node_empty\(\))/)?.[1];
  const postVerificationNodeEmpty = action.match(/post_verification_node_empty\(\) \{([\s\S]*?)(?=\n\n        if \[\[ -n "\$VIGIL_MODE")/)?.[1];
  assert.ok(postVerificationNode && postVerificationNodeEmpty);
  assert.match(postVerificationNode, /\( cd "\$VIGIL_RUNTIME_DIR" && "\$VIGIL_NODE_BIN" "\$@" \)/);
  assert.match(postVerificationNodeEmpty, /\( cd "\$VIGIL_RUNTIME_DIR" && "\$VIGIL_ENV_BIN" -i LANG=C LC_ALL=C TZ=UTC "\$VIGIL_NODE_BIN" "\$@" \)/);
  assert.match(action, /"GITHUB_EVENT_NAME=\$\{GITHUB_EVENT_NAME-\}"/);
  assert.match(action, /GITHUB_EVENT_NAME:-}" != "pull_request_target"/);
  assert.match(action, /GITHUB_EVENT_NAME:-}" != "workflow_dispatch"/);
  assert.match(action, /merge-group verification requires a bounded event exactly matching base, head, and policy-ref/);
  assert.match(action, /merge-group mode requires an authenticated merge-group-event and a base-anchored policy and policy-ref/);
  const snapshotReader = action.match(/snapshot_regular_json\(\) \{([\s\S]*?)(?=\n        event_snapshot_fingerprint=)/)?.[1];
  assert.ok(snapshotReader);
  assert.match(snapshotReader, /Buffer\.alloc\(Number\(opened\.size\)\)/);
  assert.match(snapshotReader, /fs\.readSync\(descriptor, raw,/);
  assert.match(snapshotReader, /opened\.mtimeNs !== before\.mtimeNs \|\| opened\.ctimeNs !== before\.ctimeNs/);
  assert.match(snapshotReader, /finalPath\.dev !== opened\.dev \|\| finalPath\.ino !== opened\.ino/);
  const reportReader = action.match(/read_report_metadata\(\) \{([\s\S]*?)(?=\n        report_file=)/)?.[1];
  assert.ok(reportReader);
  assert.match(reportReader, /O_RDONLY \| fs\.constants\.O_NOFOLLOW \| fs\.constants\.O_NONBLOCK/);
  assert.match(reportReader, /Buffer\.alloc\(Number\(opened\.size\)\)/);
  assert.match(reportReader, /fs\.readSync\(descriptor, raw,/);
  assert.match(reportReader, /opened\.mtimeNs !== before\.mtimeNs \|\| opened\.ctimeNs !== before\.ctimeNs/);
  assert.match(reportReader, /finalPath\.dev !== opened\.dev \|\| finalPath\.ino !== opened\.ino/);
  assert.match(action, /else\n          echo "agent-vigil: verifier produced no bounded regular report" >&2\n          code=2\n          status=/);
  assert.doesNotMatch(action, /const e\s*=\s*require\(require\("node:path"\)\.resolve\(process\.argv\[1\]\)\)/);
  assert.match(action, /VIGIL_CANDIDATE_IMAGE_INPUT.*@sha256:\[0-9a-f\]\{64\}/);
  assert.match(action, /a custom candidate-image must be hermetic; candidate-setup-cmd is not allowed/);
});

test("Action binds writable setup-node bytes to an exact reviewed runtime before execution", () => {
  const action = readFileSync(join(process.cwd(), "action.yml"), "utf8");
  assert.match(action, /readonly VIGIL_PINNED_NODE_VERSION='22\.23\.2'/);
  assert.match(action, /readonly VIGIL_PINNED_LINUX_X64_NODE_SHA256='3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327'/);
  assert.match(action, /readonly VIGIL_PINNED_MACOS_X64_NODE_SHA256='0b4f059915f3bf3c6cbb02422f4a529bfb21cbbec2d29851c9a5d833f78a04f6'/);
  assert.match(action, /readonly VIGIL_PINNED_MACOS_ARM64_NODE_SHA256='18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572'/);

  const genericValidator = action.match(/canonical_host_file\(\) \{([\s\S]*?)(?=\n        valid_node_source\(\))/)?.[1];
  const pinnedValidator = action.match(/canonical_pinned_hosted_node_file\(\) \{([\s\S]*?)(?=\n        VIGIL_NODE_SOURCE=)/)?.[1];
  assert.ok(genericValidator && pinnedValidator);
  assert.match(genericValidator, /\(\( \(8#\$mode & 022\) == 0 \)\)/, "generic host executables stay non-writable");
  assert.match(pinnedValidator, /valid_node_source "\$selected"/);
  assert.match(pinnedValidator, /expected_sha=\$\(expected_hosted_node_sha256 "\$selected"\)/);
  assert.match(pinnedValidator, /observed_sha=\$\(host_file_sha256 "\$selected"\)/);
  assert.match(pinnedValidator, /"\$before" == "\$after" && "\$observed_sha" == "\$expected_sha"/);
  assert.doesNotMatch(pinnedValidator, /printf '%s' "\$selected"[\s\S]*host_file_sha256/);
  const digestMap = action.match(/expected_hosted_node_sha256\(\) \{([\s\S]*?)(?=\n        canonical_pinned_hosted_node_file\(\))/)?.[1];
  assert.ok(digestMap);
  assert.match(digestMap, /VIGIL_HOSTED_NODE_ROOT\/\$VIGIL_PINNED_NODE_VERSION\/x64\/bin\/node"\)[\s\S]*VIGIL_PINNED_LINUX_X64_NODE_SHA256/);
  assert.match(digestMap, /VIGIL_MACOS_HOSTED_NODE_ROOT\/\$VIGIL_PINNED_NODE_VERSION\/x64\/bin\/node"\)[\s\S]*VIGIL_PINNED_MACOS_X64_NODE_SHA256/);
  assert.match(digestMap, /VIGIL_MACOS_HOSTED_NODE_ROOT\/\$VIGIL_PINNED_NODE_VERSION\/arm64\/bin\/node"\)[\s\S]*VIGIL_PINNED_MACOS_ARM64_NODE_SHA256/);
  assert.match(action, /"\$VIGIL_HOSTED_NODE_ROOT\/\$VIGIL_PINNED_NODE_VERSION\/x64\/bin\/node"/);
  assert.doesNotMatch(action, /VIGIL_HOSTED_NODE_ROOT"\/\*\/x64\/bin\/node/);
  assert.doesNotMatch(action, /\/usr\/bin\/node\|\/usr\/local\/bin\/node/);
  assert.doesNotMatch(action, /for candidate in \/usr\/bin\/node \/usr\/local\/bin\/node/);

  const sourceDigest = action.indexOf('node_source_sha=$(host_file_sha256 "$VIGIL_NODE_SOURCE")');
  const sourceBinding = action.indexOf('[[ "$node_source_sha" == "$expected_node_source_sha" ]]');
  const checkpointDigest = action.indexOf('node_checkpoint_sha=$(host_file_sha256 "$VIGIL_NODE_BIN")');
  const checkpointBinding = action.indexOf('[[ "$node_checkpoint_sha" == "$expected_node_source_sha" ]]');
  const firstNodeExecution = action.indexOf('observed_node_version=$("$VIGIL_ENV_BIN" -i LANG=C LC_ALL=C TZ=UTC "$VIGIL_NODE_BIN"');
  assert.ok(sourceDigest >= 0 && sourceBinding > sourceDigest);
  assert.ok(checkpointDigest > sourceBinding && checkpointBinding > checkpointDigest);
  assert.ok(firstNodeExecution > checkpointBinding, "the exact checkpoint digest is verified before the first Node invocation");
});

test("candidate, prove, and outcome modes reject a digest-mismatched hosted Node without system fallback", {
  skip: compositeActionRuntimeUnavailable,
}, () => {
  for (const environment of [
    { VIGIL_ISOLATE_CANDIDATE: "true", VIGIL_MODE: "maintainer" },
    { VIGIL_ISOLATE_CANDIDATE: "false", VIGIL_MODE: "prove" },
    { VIGIL_ISOLATE_CANDIDATE: "false", VIGIL_MODE: "outcome" },
  ]) {
    const result = runRejectedAction(environment, invalidatePinnedNodeDigests);
    assert.equal(result.status, 2, `${environment.VIGIL_MODE}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /trusted host runtime is unavailable:.* node/);
  }
});

test("Action rejects a missing exact Node version and a symlinked exact Node path", {
  skip: compositeActionRuntimeUnavailable,
}, () => {
  const missingVersion = runRejectedAction(
    { VIGIL_ISOLATE_CANDIDATE: "false", VIGIL_MODE: "prove" },
    (script) => script.replace(
      /readonly VIGIL_PINNED_NODE_VERSION='[^']+'/,
      "readonly VIGIL_PINNED_NODE_VERSION='0.0.0'",
    ),
  );
  assert.equal(missingVersion.status, 2, `${missingVersion.stdout}\n${missingVersion.stderr}`);
  assert.match(missingVersion.stderr, /trusted host runtime is unavailable:.* node/);

  const fixture = temporary("vigil-action-symlinked-node-");
  const rootVariable = process.platform === "darwin" ? "VIGIL_MACOS_HOSTED_NODE_ROOT" : "VIGIL_HOSTED_NODE_ROOT";
  const inactiveRootVariable = process.platform === "darwin" ? "VIGIL_HOSTED_NODE_ROOT" : "VIGIL_MACOS_HOSTED_NODE_ROOT";
  const architecture = process.platform === "darwin" ? process.arch : "x64";
  const source = join(fixture, process.versions.node, architecture, "bin", "node");
  mkdirSync(join(fixture, process.versions.node, architecture, "bin"), { recursive: true });
  symlinkSync(process.execPath, source);
  const linked = runRejectedAction(
    { VIGIL_ISOLATE_CANDIDATE: "false", VIGIL_MODE: "prove" },
    (script) => script.replace(
      new RegExp(`readonly ${rootVariable}='[^']+'`),
      `readonly ${rootVariable}=${shellQuote(fixture)}`,
    ).replace(
      new RegExp(`readonly ${inactiveRootVariable}='[^']+'`),
      `readonly ${inactiveRootVariable}=${shellQuote(join(fixture, "inactive-root"))}`,
    ),
  );
  assert.equal(linked.status, 2, `${linked.stdout}\n${linked.stderr}`);
  assert.match(linked.stderr, /trusted host runtime is unavailable:.* node/);
});

test("Action verifies the private Node checkpoint before a poisoned destination can execute", {
  skip: compositeActionRuntimeUnavailable,
}, () => {
  const fixture = temporary("vigil-action-poisoned-copy-");
  const fakeCopy = join(fixture, "cp");
  const executionMarker = join(fixture, "poison-executed");
  writeFileSync(fakeCopy, [
    "#!/bin/bash",
    `printf '%s\\n' '#!/bin/bash' ${shellQuote(`printf executed > ${shellQuote(executionMarker)}`)} > "$2"`,
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(fakeCopy, 0o555);

  const result = runRejectedAction(
    { VIGIL_ISOLATE_CANDIDATE: "false", VIGIL_MODE: "prove" },
    (script) => script.replace(
      "for candidate in /usr/bin/cp /bin/cp; do",
      `for candidate in ${shellQuote(fakeCopy)}; do`,
    ),
  );
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(executionMarker), false, "digest-mismatched checkpoint bytes must never execute");
});

test("Action snapshots GitHub event JSON without executing or following caller files", {
  skip: compositeActionRuntimeUnavailable,
}, () => {
  const root = temporary("vigil-action-event-source-");
  const marker = join(root, "executed-marker");
  const executableEvent = join(root, "event.cjs");
  writeFileSync(executableEvent, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); module.exports = {};\n`);
  const common = {
    GITHUB_EVENT_PATH: executableEvent,
    VIGIL_MODE: "plan",
    VIGIL_ISOLATE_CANDIDATE: "false",
  };
  const regular = runRejectedAction(common);
  assert.equal(regular.status, 2, `${regular.stdout}\n${regular.stderr}`);
  assert.match(regular.stderr, /GitHub event must be one bounded regular JSON file/);
  assert.equal(existsSync(marker), false, "event path is parsed as data and never loaded as JavaScript");

  const eventLink = join(root, "event.json");
  symlinkSync(executableEvent, eventLink);
  const linked = runRejectedAction({ ...common, GITHUB_EVENT_PATH: eventLink });
  assert.equal(linked.status, 2, `${linked.stdout}\n${linked.stderr}`);
  assert.match(linked.stderr, /GitHub event must be one bounded regular JSON file/);
  assert.equal(existsSync(marker), false, "event symlink is rejected before it can be executed");
});

test("Action rejects unsafe credential and candidate-execution combinations before verification", {
  skip: compositeActionRuntimeUnavailable,
}, () => {
  const cases: Array<{ env: NodeJS.ProcessEnv; message: RegExp }> = [
    {
      env: { VIGIL_MODE: "", VIGIL_TRANSCRIPT: "summary.md", VIGIL_ISOLATE_CANDIDATE: "false" },
      message: /repository-executing modes require isolate-candidate: true/,
    },
    {
      env: { VIGIL_MODE: "prove", VIGIL_HAS_GITHUB_TOKEN: "true" },
      message: /GitHub token is restricted to the non-executing outcome mode/,
    },
    {
      env: { VIGIL_MODE: "outcome", VIGIL_ATTEST: "true" },
      message: /attestation is restricted to the non-candidate prove mode/,
    },
    {
      env: { VIGIL_MODE: "plan", VIGIL_CANDIDATE_SETUP_COMMAND: "npm ci" },
      message: /candidate-setup-cmd requires candidate isolation/,
    },
    {
      env: { VIGIL_MODE: "outcome", VIGIL_OUTCOME_RECEIPT: "receipt.json", VIGIL_TRANSCRIPT: "summary.md" },
      message: /outcome mode cannot be combined with another evidence input/,
    },
    {
      env: { VIGIL_MODE: "plan", VIGIL_OUTCOME_RECEIPT: "receipt.json" },
      message: /outcome-receipt and actions-run-id are restricted to outcome mode/,
    },
    {
      env: { VIGIL_MODE: "prove", VIGIL_ACTIONS_RUN_ID: "99" },
      message: /outcome-receipt and actions-run-id are restricted to outcome mode/,
    },
    {
      env: { VIGIL_MODE: "prove", VIGIL_CONTINUITY_CHAIN: "chain" },
      message: /continuity-chain is restricted to continuity mode/,
    },
    {
      env: { VIGIL_MODE: "prove", VIGIL_MERGE_GROUP_EVENT: "merge-group.json" },
      message: /merge-group-event is restricted to merge-group mode/,
    },
    {
      env: { VIGIL_MODE: "prove", VIGIL_AUTHORITY_CONTRACT_REF: "a".repeat(40) },
      message: /authority-contract-ref requires authority-contract/,
    },
  ];
  for (const value of cases) {
    const result = runRejectedAction(value.env);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(`${result.stdout}\n${result.stderr}`, value.message);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /candidate-head-injection/);
  }
});

test("Action rejects candidate-selected pull_request workflow provenance", {
  skip: compositeActionRuntimeUnavailable || !existsSync("/usr/bin/docker"),
}, () => {
  const root = temporary("vigil-action-event-provenance-");
  const event = join(root, "pull-request.json");
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  const result = runRejectedAction({
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: event,
    VIGIL_BASE: base,
    VIGIL_HEAD: head,
    VIGIL_ISOLATE_CANDIDATE: "true",
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: base,
    VIGIL_TRANSCRIPT: ".agent-vigil/session.md",
  });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /requires the base-selected pull_request_target event/);
});

test("Action rejects merge-group envelopes outside authenticated dispatch and exact commit binding", {
  skip: compositeActionRuntimeUnavailable || !existsSync("/usr/bin/docker"),
}, () => {
  const root = temporary("vigil-action-merge-group-provenance-");
  const event = join(root, "merge-group.json");
  const base = "1".repeat(40);
  const head = "2".repeat(40);
  writeFileSync(event, JSON.stringify({ merge_group: { base_sha: base, head_sha: head } }));

  const wrongTrigger = runRejectedAction({
    GITHUB_EVENT_NAME: "pull_request_target",
    VIGIL_BASE: base,
    VIGIL_HEAD: head,
    VIGIL_ISOLATE_CANDIDATE: "true",
    VIGIL_MERGE_GROUP_EVENT: event,
    VIGIL_MODE: "merge-group",
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: base,
  });
  assert.equal(wrongTrigger.status, 2, `${wrongTrigger.stdout}\n${wrongTrigger.stderr}`);
  assert.match(wrongTrigger.stderr, /requires an externally authenticated workflow_dispatch/);

  const wrongHead = runRejectedAction({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    VIGIL_BASE: base,
    VIGIL_HEAD: "3".repeat(40),
    VIGIL_ISOLATE_CANDIDATE: "true",
    VIGIL_MERGE_GROUP_EVENT: event,
    VIGIL_MODE: "merge-group",
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: base,
  });
  assert.equal(wrongHead.status, 2, `${wrongHead.stdout}\n${wrongHead.stderr}`);
  assert.match(wrongHead.stderr, /exactly matching base, head, and policy-ref/);
});

test("Action validates candidate commit IDs before printing or using them", () => {
  const script = compositeActionScript();
  assert.match(script, /candidate verification requires full lowercase base and head commit IDs/);
  assert.match(script, /candidate verification requires an Action bundle outside the candidate workspace/);
  assert.match(script, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(script, /\^\[0-9a-f\]\{64\}\$/);
});

test("Action refuses candidate verification from a local Action bundle inside the candidate checkout", {
  skip: compositeActionRuntimeUnavailable || !existsSync("/usr/bin/docker") ? "requires the Linux hosted Action runtime" : false,
}, () => {
  const root = temporary("vigil-action-local-bundle-");
  const repo = join(root, "repo");
  mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(join(repo, "dist", "cli.js"), readFileSync(join(process.cwd(), "dist", "cli.js")));
  const script = join(root, "action.sh");
  writeFileSync(script, compositeActionScript());
  const environment: NodeJS.ProcessEnv = {
    ...baseActionEnvironment(root, repo),
    GITHUB_ACTION_PATH: realpathSync(repo),
    VIGIL_BASE: "a".repeat(40),
    VIGIL_HEAD: "b".repeat(40),
    VIGIL_ISOLATE_CANDIDATE: "true",
    VIGIL_TRANSCRIPT: "summary.md",
  };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_V8_COVERAGE;
  const result = spawnSync("/bin/bash", [script], { cwd: repo, encoding: "utf8", env: environment, timeout: 30_000 });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /candidate verification requires an Action bundle outside the candidate workspace/);
});

test("Action rejects a candidate workspace whose exact HEAD differs from the selected commit", {
  skip: compositeActionRuntimeUnavailable || !existsSync("/usr/bin/docker") ? "requires the Linux hosted Action runtime" : false,
}, () => {
  const root = temporary("vigil-action-head-binding-");
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  writeFileSync(join(repo, "summary.md"), "The test suite passes.\n");
  const checkedOut = commit(repo, "candidate fixture");
  const selected = checkedOut === "a".repeat(40) ? "b".repeat(40) : "a".repeat(40);
  const script = join(root, "action.sh");
  writeFileSync(script, compositeActionScript());
  const environment: NodeJS.ProcessEnv = {
    ...baseActionEnvironment(root, repo),
    VIGIL_BASE: checkedOut,
    VIGIL_HEAD: selected,
    VIGIL_ISOLATE_CANDIDATE: "true",
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: checkedOut,
    VIGIL_TRANSCRIPT: "summary.md",
  };
  const event = join(root, "commands", "event.json");
  writeFileSync(event, JSON.stringify({
    repository: { full_name: "owner/repository" },
    pull_request: { number: 7, base: { sha: checkedOut }, head: { sha: selected } },
  }));
  environment.GITHUB_EVENT_PATH = event;
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_V8_COVERAGE;
  const result = spawnSync("/bin/bash", [script], { cwd: repo, encoding: "utf8", env: environment, timeout: 30_000 });
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(`candidate workspace HEAD ${checkedOut} does not match selected head ${selected}`));
});

function realDockerPrerequisite(): { ready: boolean; reason: string } {
  if (compositeActionRuntimeUnavailable) return { ready: false, reason: "requires the Node 22 Action fixture" };
  if (process.platform !== "linux") return { ready: false, reason: "requires Linux" };
  if (typeof process.getuid !== "function" || process.getuid() !== 1001) {
    return { ready: false, reason: "requires the GitHub-hosted runner user identity" };
  }
  if (!existsSync("/usr/bin/docker")) return { ready: false, reason: "requires fixed /usr/bin/docker" };
  try {
    const platform = execFileSync("/usr/bin/docker", [
      "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", PINNED_CANDIDATE_IMAGE,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (platform !== "linux/amd64") return { ready: false, reason: `requires exact linux/amd64 image, observed ${platform}` };
  } catch {
    return { ready: false, reason: "requires the preloaded exact candidate image and a live Docker daemon" };
  }
  return { ready: true, reason: "" };
}

function candidateAttackProgram(forbiddenPaths: string[]): string {
  return `
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const allowedEnvironment = ["CI", "HOME", "LANG", "LC_ALL", "NODE_TEST_CONTEXT", "NPM_CONFIG_CACHE", "PATH", "TZ"];
const observedEnvironment = Object.keys(process.env).sort();
const extras = observedEnvironment.filter((key) => !allowedEnvironment.includes(key));
const missing = allowedEnvironment.filter((key) => !observedEnvironment.includes(key));
if (extras.length || missing.length) {
  throw new Error("candidate environment is not exact: extras=" + extras.join(",") + " missing=" + missing.join(","));
}
if (process.env.NODE_TEST_CONTEXT !== "child-v8") {
  throw new Error("candidate received an unexpected Node test-runner context");
}
for (const key of [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "GITHUB_ENV", "GITHUB_OUTPUT",
  "GITHUB_PATH", "GITHUB_STATE", "GITHUB_ACTION_PATH", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_WORKSPACE",
  "RUNNER_TEMP", "AGENT_VIGIL_AMBIENT_POISON", "AGENT_VIGIL_INTERNAL_CANDIDATE_ROOT",
  "AGENT_VIGIL_INTERNAL_DOCKER_BIN", "NODE_VERSION", "YARN_VERSION", "HOSTNAME",
]) {
  if (Object.hasOwn(process.env, key)) throw new Error("candidate received forbidden environment key: " + key);
}
const processOneEnvironment = fs.readFileSync("/proc/1/environ", "utf8").split("\\0").filter(Boolean);
for (const prefix of ["ACTIONS_ID_TOKEN_", "GITHUB_", "RUNNER_", "AGENT_VIGIL_", "VIGIL_"]) {
  if (processOneEnvironment.some((entry) => entry.startsWith(prefix))) {
    throw new Error("candidate PID 1 received forbidden environment prefix: " + prefix);
  }
}
for (const selected of ${JSON.stringify(forbiddenPaths)}) {
  if (fs.existsSync(selected)) throw new Error("candidate can see a runner control path: " + selected);
  try {
    fs.appendFileSync(selected, "candidate-write");
    throw new Error("candidate can write a runner control path: " + selected);
  } catch (error) {
    if (error && error.message && error.message.startsWith("candidate can write")) throw error;
  }
}
if (fs.existsSync("/var/run/docker.sock")) throw new Error("candidate can reach the Docker control socket");
const networkProbe = spawnSync(process.execPath, ["-e", [
  'const net = require("node:net");',
  'const socket = net.connect({ host: "1.1.1.1", port: 443 });',
  'const timer = setTimeout(() => { socket.destroy(); process.exit(0); }, 1500);',
  'socket.once("error", () => { clearTimeout(timer); process.exit(0); });',
  'socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(23); });',
].join("\\n")], { stdio: "ignore", timeout: 3000 });
if (networkProbe.error || networkProbe.status !== 0) {
  throw new Error("candidate established a direct network connection");
}
try {
  fs.renameSync("/workspace/src", "/workspace/src.agent-vigil-swap");
  fs.renameSync("/workspace/src.agent-vigil-swap", "/workspace/src");
  throw new Error("candidate workspace mount is writable");
} catch (error) {
  if (error && error.message === "candidate workspace mount is writable") throw error;
}
try {
  fs.writeFileSync("/agent-vigil-root-write", "candidate-write");
  throw new Error("candidate container root is writable");
} catch (error) {
  if (error && error.message === "candidate container root is writable") throw error;
}
process.stdout.write("# tests 1\\n# pass 1\\n# fail 0\\n");
process.stdout.write("##[add-mask]candidate-legacy-command\\n");
process.stdout.write("::add-mask::candidate-modern-command\\n");
`;
}

function candidateContainersForRunner(runner: string): string[] {
  const ids = execFileSync("/usr/bin/docker", [
    "ps", "-a", "--filter", "name=agent-vigil-candidate-", "--format", "{{.ID}}",
  ], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  return ids.filter((id) => {
    try {
      const mounts = JSON.parse(execFileSync("/usr/bin/docker", [
        "inspect", "--format", "{{json .Mounts}}", id,
      ], { encoding: "utf8" })) as Array<{ Source?: string }>;
      return mounts.some((mount) => mount.Source === runner || mount.Source?.startsWith(`${runner}/`));
    } catch {
      return false;
    }
  });
}

test("real candidate attack program compiles and includes the network-denial probe", () => {
  const program = candidateAttackProgram([]);
  assert.doesNotThrow(() => new Function(program));
  assert.match(program, /net\.connect/);
  assert.match(program, /candidate established a direct network connection/);
  assert.match(program, /candidate workspace mount is writable/);
});

const requireRealDocker = process.env.AGENT_VIGIL_REQUIRE_REAL_DOCKER === "true";
const realDocker = realDockerPrerequisite();

test("real isolated Action hides runner controls from candidate code", {
  skip: !requireRealDocker && !realDocker.ready ? realDocker.reason : false,
}, () => {
  assert.equal(realDocker.ready, true, realDocker.reason);
  const root = temporary("vigil-action-real-isolation-");
  const repo = join(root, "repo");
  const commands = join(root, "commands");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  writeFileSync(join(repo, ".agent-vigil-summary.md"), "The test suite passes.\n");
  writeFileSync(join(repo, ".agent-vigil.json"), `${JSON.stringify({ schemaVersion: 1, strict: true, minVerified: 1 }, null, 2)}\n`);
  writeFileSync(join(repo, "README.md"), "trusted base\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "trusted.txt"), "trusted source\n");
  const base = commit(repo, "trusted base");

  const environment = baseActionEnvironment(root, repo);
  const runner = environment.RUNNER_TEMP as string;
  const output = environment.GITHUB_OUTPUT as string;
  const commandFiles = [
    join(commands, "env"),
    join(commands, "path"),
    join(commands, "state"),
  ];
  for (const selected of commandFiles) writeFileSync(selected, "trusted-sentinel\n");
  const eventPath = join(commands, "event.json");
  const forbiddenPaths = [
    ...commandFiles,
    eventPath,
    output,
    environment.GITHUB_STEP_SUMMARY as string,
    environment.GITHUB_ACTION_PATH as string,
    runner,
    join(runner, "candidate-host-marker"),
  ];
  writeFileSync(join(repo, "candidate-test.test.cjs"), candidateAttackProgram(forbiddenPaths));
  const head = commit(repo, "candidate attack fixture");
  const eventBody = `${JSON.stringify({
    repository: { full_name: "owner/repository" },
    pull_request: { number: 7, base: { sha: base }, head: { sha: head } },
  })}\n`;
  writeFileSync(eventPath, eventBody);
  const script = join(root, "action.sh");
  writeFileSync(script, compositeActionScript());

  Object.assign(environment, {
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token-must-not-cross",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/must-not-cross",
    AGENT_VIGIL_AMBIENT_POISON: "ambient-secret-must-not-cross",
    GITHUB_ENV: commandFiles[0],
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_PATH: commandFiles[1],
    GITHUB_STATE: commandFiles[2],
    RUNNER_ENVIRONMENT: "github-hosted",
    RUNNER_OS: "Linux",
    VIGIL_BASE: base,
    VIGIL_HEAD: head,
    VIGIL_ISOLATE_CANDIDATE: "true",
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: base,
    VIGIL_TEST_CMD: "node --test candidate-test.test.cjs",
    VIGIL_TRANSCRIPT: ".agent-vigil-summary.md",
  });
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_V8_COVERAGE;

  const result = spawnSync("/bin/bash", [script], {
    cwd: repo,
    encoding: "utf8",
    env: environment,
    timeout: 180_000,
  });
  const resultOutputs = readFileSync(output, "utf8");
  const resultReport = resultOutputs.match(/^report=(.+)$/m)?.[1];
  const resultReportText = resultReport && existsSync(resultReport) ? readFileSync(resultReport, "utf8") : "";
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${resultOutputs}\n${resultReportText}`);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /candidate-(?:legacy|modern)-command/);
  const outputs = readFileSync(output, "utf8");
  assert.match(outputs, /^status=PASS$/m);
  const report = outputs.match(/^report=(.+)$/m)?.[1];
  assert.ok(report, "Action emits its private retained report");
  assert.ok(report.startsWith(`${runner}/agent-vigil-`), "report remains under the trusted runner temporary directory");
  assert.equal(existsSync(join(repo, "agent-vigil-report.json")), false, "verification does not write generated evidence into candidate source");
  for (const selected of commandFiles) {
    assert.equal(readFileSync(selected, "utf8"), "trusted-sentinel\n", `${selected} remains unchanged`);
  }
  assert.equal(readFileSync(eventPath, "utf8"), eventBody, "candidate cannot alter the trusted event source");
  assert.equal(existsSync(join(runner, "candidate-host-marker")), false);
  assert.deepEqual(candidateContainersForRunner(runner), [], "this Action leaves no candidate container behind");

  writeFileSync(join(repo, "candidate-test.test.cjs"), [
    'process.stdout.write("##[add-mask]candidate-legacy-failure\\n");',
    'process.stdout.write("::add-mask::candidate-modern-failure\\n");',
    "process.exit(1);",
    "",
  ].join("\n"));
  const failingHead = commit(repo, "candidate runner-command failure fixture");
  const failingEventBody = `${JSON.stringify({
    repository: { full_name: "owner/repository" },
    pull_request: { number: 7, base: { sha: base }, head: { sha: failingHead } },
  })}\n`;
  writeFileSync(eventPath, failingEventBody);
  writeFileSync(output, "");
  environment.VIGIL_HEAD = failingHead;
  const failingResult = spawnSync("/bin/bash", [script], {
    cwd: repo,
    encoding: "utf8",
    env: environment,
    timeout: 180_000,
  });
  assert.equal(failingResult.status, 1, `${failingResult.stdout}\n${failingResult.stderr}`);
  assert.doesNotMatch(`${failingResult.stdout}\n${failingResult.stderr}`, /candidate-(?:legacy|modern)-failure/);
  const failingOutputs = readFileSync(output, "utf8");
  assert.match(failingOutputs, /^status=FAIL$/m);
  const failingReport = failingOutputs.match(/^report=(.+)$/m)?.[1];
  assert.ok(failingReport, "Action emits its private failing report");
  const failingReportText = readFileSync(failingReport, "utf8");
  assert.doesNotMatch(failingReportText, /candidate-(?:legacy|modern)-failure/);
  const failingChecks = (JSON.parse(failingReportText) as {
    results: Array<{ evidence?: string; ruleId?: string; verdict?: string }>;
  }).results;
  assert.ok(failingChecks.some((check) => check.ruleId === "tests-pass"
    && check.verdict === "contradicted" && /exited 1/.test(check.evidence ?? "")));
  assert.equal(readFileSync(eventPath, "utf8"), failingEventBody, "failing candidate cannot alter the trusted event source");
  assert.deepEqual(candidateContainersForRunner(runner), [], "failing Action leaves no candidate container behind");

  rmSync(join(repo, ".agent-vigil-summary.md"));
  symlinkSync("/dev/zero", join(repo, ".agent-vigil-summary.md"));
  const symlinkTranscriptHead = commit(repo, "candidate transcript symlink fixture");
  writeFileSync(eventPath, `${JSON.stringify({
    repository: { full_name: "owner/repository" },
    pull_request: { number: 7, base: { sha: base }, head: { sha: symlinkTranscriptHead } },
  })}\n`);
  environment.VIGIL_HEAD = symlinkTranscriptHead;
  const symlinkTranscriptResult = spawnSync("/bin/bash", [script], {
    cwd: repo,
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
  });
  assert.equal(symlinkTranscriptResult.status, 2, `${symlinkTranscriptResult.stdout}\n${symlinkTranscriptResult.stderr}`);
  assert.match(symlinkTranscriptResult.stderr, /transcript must be one bounded regular blob from the exact head commit/);
  assert.doesNotMatch(`${symlinkTranscriptResult.stdout}\n${symlinkTranscriptResult.stderr}`, /dev\/zero/);
  assert.deepEqual(candidateContainersForRunner(runner), [], "rejected transcript symlink starts no candidate container");

  rmSync(join(repo, ".agent-vigil-summary.md"));
  writeFileSync(join(repo, ".agent-vigil-summary.md"), "The test suite passes.\n");
  const outsideReceipt = join(root, "outside-receipt.json");
  writeFileSync(outsideReceipt, '{"outside":"must-not-be-read"}\n');
  mkdirSync(join(repo, ".agent-vigil"));
  symlinkSync(outsideReceipt, join(repo, ".agent-vigil", "receipt.json"));
  const symlinkReceiptHead = commit(repo, "candidate receipt symlink fixture");
  writeFileSync(eventPath, `${JSON.stringify({
    repository: { full_name: "owner/repository" },
    pull_request: { number: 7, base: { sha: base }, head: { sha: symlinkReceiptHead } },
  })}\n`);
  Object.assign(environment, {
    VIGIL_HEAD: symlinkReceiptHead,
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: base,
    VIGIL_RECEIPT: ".agent-vigil/receipt.json",
    VIGIL_TEST_CMD: "",
    VIGIL_TRANSCRIPT: "",
  });
  const symlinkReceiptResult = spawnSync("/bin/bash", [script], {
    cwd: repo,
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
  });
  assert.equal(symlinkReceiptResult.status, 2, `${symlinkReceiptResult.stdout}\n${symlinkReceiptResult.stderr}`);
  assert.match(symlinkReceiptResult.stderr, /receipt must be one bounded regular blob from the exact head commit/);
  assert.doesNotMatch(`${symlinkReceiptResult.stdout}\n${symlinkReceiptResult.stderr}`, /must-not-be-read/);
  assert.equal(readFileSync(outsideReceipt, "utf8"), '{"outside":"must-not-be-read"}\n');
  assert.deepEqual(candidateContainersForRunner(runner), [], "rejected receipt symlink starts no candidate container");

  unlinkSync(join(repo, ".agent-vigil", "receipt.json"));
  symlinkSync("/dev/zero", join(repo, "package.json"));
  const inferredCommandHead = commit(repo, "candidate package manifest device fixture");
  writeFileSync(eventPath, `${JSON.stringify({
    repository: { full_name: "owner/repository" },
    pull_request: { number: 7, base: { sha: base }, head: { sha: inferredCommandHead } },
  })}\n`);
  writeFileSync(output, "");
  Object.assign(environment, {
    VIGIL_HEAD: inferredCommandHead,
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: base,
    VIGIL_RECEIPT: "",
    VIGIL_TEST_CMD: "",
    VIGIL_TRANSCRIPT: ".agent-vigil-summary.md",
  });
  const inferredCommandResult = spawnSync("/bin/bash", [script], {
    cwd: repo,
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
  });
  assert.equal(inferredCommandResult.status, 2, `${inferredCommandResult.stdout}\n${inferredCommandResult.stderr}`);
  assert.doesNotMatch(`${inferredCommandResult.stdout}\n${inferredCommandResult.stderr}`, /dev\/zero/);
  const inferredOutputs = readFileSync(output, "utf8");
  assert.match(inferredOutputs, /^status=INCONCLUSIVE$/m);
  const inferredReport = inferredOutputs.match(/^report=(.+)$/m)?.[1];
  assert.ok(inferredReport, "missing base-owned test command still emits a bounded report");
  assert.match(readFileSync(inferredReport, "utf8"), /explicit base-owned test command/);
  assert.deepEqual(candidateContainersForRunner(runner), [], "candidate manifest device starts no candidate container");
});

test("real isolated Action validates a private portable-receipt snapshot against its logical Git path", {
  skip: !requireRealDocker && !realDocker.ready ? realDocker.reason : false,
}, () => {
  assert.equal(realDocker.ready, true, realDocker.reason);
  const root = temporary("vigil-action-portable-isolation-");
  const repo = join(root, "repo");
  const keys = join(root, "keys");
  mkdirSync(repo);
  mkdirSync(keys);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "vigil@example.test");
  git(repo, "config", "user.name", "Vigil Test");
  const privateKey = join(keys, "private.pem");
  const publicKey = join(keys, "public.pem");
  generateSigningKey(privateKey, publicKey);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ scripts: { test: "node --test test.js" } }, null, 2)}\n`);
  writeFileSync(join(repo, "test.js"), "const{test}=require('node:test');test('portable',()=>{});\n");
  writeFileSync(join(repo, ".agent-vigil.json"), `${JSON.stringify({
    schemaVersion: 1,
    testCommand: "node --test test.js",
    strict: true,
    minVerified: 1,
    portableReceipt: ".agent-vigil/receipt.json",
    trustedSignerKeyIds: [publicKeyId(publicKey)],
  }, null, 2)}\n`);
  const base = commit(repo, "trusted portable policy");
  writeFileSync(join(repo, "README.md"), "candidate code head\n");
  const codeHead = commit(repo, "candidate code");
  const summary = join(keys, "summary.md");
  writeFileSync(summary, "The test suite passes.\n");
  assert.equal(run([
    summary, "--repo", repo, "--base", base, "--head", codeHead,
    "--policy", ".agent-vigil.json", "--policy-ref", base,
    "--signing-key", privateKey, "--portable-output", ".agent-vigil/receipt.json",
  ]), 0);
  const head = commit(repo, "attach portable receipt");

  const environment = baseActionEnvironment(root, repo);
  const event = join(root, "commands", "event.json");
  writeFileSync(event, `${JSON.stringify({
    repository: { full_name: "owner/repository" },
    pull_request: { number: 9, base: { sha: base }, head: { sha: head } },
  })}\n`);
  Object.assign(environment, {
    GITHUB_EVENT_PATH: event,
    VIGIL_BASE: base,
    VIGIL_HEAD: head,
    VIGIL_ISOLATE_CANDIDATE: "true",
    VIGIL_POLICY: ".agent-vigil.json",
    VIGIL_POLICY_REF: base,
    VIGIL_RECEIPT: ".agent-vigil/receipt.json",
  });
  delete environment.NODE_TEST_CONTEXT;
  delete environment.NODE_V8_COVERAGE;
  const script = join(root, "portable-action.sh");
  writeFileSync(script, compositeActionScript());
  const completed = spawnSync("/bin/bash", [script], { cwd: repo, encoding: "utf8", env: environment, timeout: 180_000 });
  const outputs = readFileSync(environment.GITHUB_OUTPUT as string, "utf8");
  const completedReport = outputs.match(/^report=(.+)$/m)?.[1];
  const completedReportText = completedReport && existsSync(completedReport) ? readFileSync(completedReport, "utf8") : "";
  assert.equal(completed.status, 0, `${completed.stdout}\n${completed.stderr}\n${outputs}\n${completedReportText}`);
  assert.match(outputs, /^status=PASS$/m);
  const report = outputs.match(/^report=(.+)$/m)?.[1];
  assert.ok(report);
  const parsed = JSON.parse(readFileSync(report, "utf8"));
  assert.equal(parsed.results.find((item: { ruleId: string }) => item.ruleId === "portable-path")?.verdict, "verified");
  assert.deepEqual(candidateContainersForRunner(environment.RUNNER_TEMP as string), []);
});
