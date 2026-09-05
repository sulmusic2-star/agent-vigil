import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const directCommand = "node --test --test-concurrency=1 test-hosted/*.test.ts";

function assertBefore(text, earlier, later, label) {
  const left = text.indexOf(earlier);
  const right = text.indexOf(later);
  assert.ok(left >= 0 && right >= 0 && left < right, label);
}

test("the required check uses the dedicated hosted regression lane", () => {
  const policy = JSON.parse(readFileSync(".agent-vigil.json", "utf8"));
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));

  assert.equal(policy.testCommand, directCommand);
  assert.deepEqual(policy.maintainer.testPathPatterns, ["test-hosted/**"]);
  assert.deepEqual(policy.maintainer.automatedReview.commands, [directCommand]);
  assert.equal(policy.maintainer.differentialTest.command, directCommand);
  assert.equal(manifest.agentVigil.hostedTestCommand, directCommand);
  assert.equal(manifest.scripts.test, "node scripts/run_tests.mjs");
  assert.equal(manifest.scripts["test:hosted"], directCommand);
  assert.equal(manifest.scripts["test:coverage"], "node scripts/run_tests.mjs --coverage");
  assert.ok(policy.maintainer.protectedPaths.includes("test-hosted/repository-contract.test.ts"));
});

test("the hosted Action accepts only the reviewed Node runtime before first execution", () => {
  const action = readFileSync("action.yml", "utf8");
  const firstNodeExecution = action.indexOf(
    'observed_node_version=$("$VIGIL_ENV_BIN" -i LANG=C LC_ALL=C TZ=UTC "$VIGIL_NODE_BIN"',
  );

  assert.match(action, /readonly VIGIL_PINNED_NODE_VERSION='22\.23\.2'/);
  assert.match(
    action,
    /readonly VIGIL_PINNED_LINUX_X64_NODE_SHA256='3517c2df0b2f8cd7f422b4b8450ef81c6889f08eb03e281d6de9079b15e6a327'/,
  );
  assert.match(
    action,
    /readonly VIGIL_PINNED_MACOS_X64_NODE_SHA256='0b4f059915f3bf3c6cbb02422f4a529bfb21cbbec2d29851c9a5d833f78a04f6'/,
  );
  assert.match(
    action,
    /readonly VIGIL_PINNED_MACOS_ARM64_NODE_SHA256='18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572'/,
  );
  assert.match(action, /canonical_pinned_hosted_node_file\(\)/);
  assert.doesNotMatch(action, /canonical_node_source\(\)/);
  assert.doesNotMatch(action, /(?:VIGIL_HOSTED_NODE_ROOT|VIGIL_MACOS_HOSTED_NODE_ROOT)"\/\*\//);
  assert.doesNotMatch(action, /\/usr\/(?:local\/bin|bin)\/node/);
  assert.ok(firstNodeExecution > 0);
  for (const checkpoint of [
    'expected_node_source_sha=$(expected_hosted_node_sha256 "$VIGIL_NODE_SOURCE") || exit 2',
    '[[ "$node_source_sha" == "$expected_node_source_sha" ]] || exit 2',
    '[[ "$node_checkpoint_sha" == "$expected_node_source_sha" ]] || exit 2',
    '"$VIGIL_CMP_BIN" -s "$VIGIL_NODE_SOURCE" "$VIGIL_NODE_BIN" || exit 2',
  ]) {
    const checkpointIndex = action.indexOf(checkpoint);
    assert.ok(checkpointIndex > 0 && checkpointIndex < firstNodeExecution, checkpoint);
  }

  const evidence = readFileSync(".github/workflows/agent-vigil.yml", "utf8");
  const outcome = readFileSync(".github/workflows/agent-vigil-outcomes.yml", "utf8");
  const control = readFileSync(".github/workflows/control-proof-weekly.yml", "utf8");
  for (const workflow of [evidence, outcome, control]) {
    assert.match(workflow, /node-version:\s*22\.23\.2/);
    assert.doesNotMatch(workflow, /^\s*node-version:\s*22\s*$/m);
  }
  assertBefore(evidence, "actions/setup-node@", "actions/checkout@", "evidence selects Node before checkout");
  assertBefore(outcome, "actions/setup-node@", "actions/download-artifact@", "outcome selects Node before artifacts");
  assertBefore(control, "actions/setup-node@", "actions/checkout@", "control proof selects Node before checkout");

  const generator = readFileSync("src/setup.ts", "utf8");
  assert.match(generator, /const HOSTED_NODE_VERSION = "22\.23\.2"/);
  assertBefore(generator, "actions/setup-node@", "actions/checkout@", "generated evidence selects Node before checkout");
});

test("the released package and public channels keep explicit version identities", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const report = readFileSync("src/report.ts", "utf8");
  const setup = readFileSync("src/setup.ts", "utf8");
  const readme = readFileSync("README.md", "utf8");
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const installState = JSON.parse(readFileSync("docs/public-install-state.json", "utf8"));

  assert.equal(manifest.version, "0.24.4");
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.match(report, /VERSION = "0\.24\.4"/);
  assert.doesNotMatch(setup, /generated v0\.22\.0 hosted workflow/);
  assert.equal(installState.latest_github_release.version, "0.24.3");
  assert.equal(installState.latest_github_release.commit, "b09fc9ed05d9ca9c9be801a366439ffa1f92c8e1");
  assert.deepEqual(installState.source_release_candidate, { version: "0.24.4", github_release_published: false, npm_published: false });
  assert.equal(installState.npm_registry.observed_version, "0.24.3");
  assert.equal(installState.npm_registry.target_version, "0.24.3");
  assert.equal(installState.npm_registry.target_published, true);
  assert.match(readme, /--package=@sulmusic\/agent-vigil@0\.24\.4 agent-vigil protect --repo \./);
  assert.doesNotMatch(readme, /source release candidate/);
  assert.match(readme, /--runner common/);
  assert.doesNotMatch(readme, /node dist\/cli\.js protect --action-sha/);
  assert.match(readme, /releases\/download\/v0\.24\.4\/sulmusic-agent-vigil-0\.24\.4\.tgz/);
  assert.doesNotMatch(readme, /@sulmusic\/agent-vigil@0\.23\.2/);
  assert.match(changelog, /^## Unreleased$/m);
  assertBefore(
    changelog,
    "## Unreleased",
    "## 0.24.3 - 2026-09-04",
    "unreleased changes precede the latest released version",
  );
  assert.match(changelog, /## 0\.21\.2 - 2026-08-28/);
});

test("the disposable test runner resolves file URLs portably", () => {
  const runner = readFileSync("scripts/run_tests.mjs", "utf8");
  assert.match(runner, /fileURLToPath\(new URL\("\.\."/);
  assert.doesNotMatch(runner, /import\.meta\.url\)\.pathname/);
});

test("the hermetic runner publisher binds release tags to package identity", () => {
  const workflow = readFileSync(".github/workflows/publish-hermetic-runner.yml", "utf8");
  assert.match(workflow, /tags="\$repository:sha-\$\{GITHUB_SHA\}"/);
  assert.match(workflow, /\^v\(\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\)\$/);
  assert.match(workflow, /\[\[ "\$package_version" == "\$version" \]\]/);
  assert.match(workflow, /tags: \$\{\{ steps\.image-tags\.outputs\.value \}\}/);
  assert.doesNotMatch(workflow, /agent-vigil-runner:0\.23\.0/);
});
