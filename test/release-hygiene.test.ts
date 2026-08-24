import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const ATTEST_SHA = "1e69f48acb82d1966a394da916b4c1698aa569d6";
const RUNTIME_SHA = "72a14ac05397f8fc815fbba5d913693a1ca14bdc";
const OBSOLETE_RECEIPT_PATH = /^\s+(?:agent-vigil-report\.json|agent-vigil\.sarif|agent-vigil-value-card\.json|agent-vigil-github-evidence\.json)\s*$/m;

function assertExactSelfAction(path: string): void {
  assert.match(RUNTIME_SHA, /^[0-9a-f]{40}$/, "reviewed runtime must be an exact Git SHA");
  const refs = [...source(path).matchAll(/uses:\s+sulmusic2-star\/agent-vigil@([^\s#]+)/g)]
    .map((match) => match[1]);
  assert.deepEqual(refs, [RUNTIME_SHA], `${path} must use the one reviewed runtime SHA`);
}

test("CI pins third-party Actions and uploads dogfood runner-owned outputs", () => {
  const workflow = source(".github/workflows/ci.yml");
  const action = source("action.yml");
  assert.equal(workflow.match(new RegExp(`actions/checkout@${CHECKOUT_SHA}`, "g"))?.length, 2);
  assert.equal(workflow.match(new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`, "g"))?.length, 2);
  assert.equal(workflow.match(new RegExp(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`, "g"))?.length, 1);
  assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node|upload-artifact)@v\d/);
  assert.match(action, new RegExp(`actions/attest@${ATTEST_SHA}`));
  assert.doesNotMatch(action, /uses:\s+actions\/attest@v\d/);
  assert.match(workflow, /name: Dogfood Agent Vigil\n\s+id: dogfood\n\s+uses: \.\//);
  for (const output of ["report", "sarif", "github-evidence", "value-card"]) {
    assert.match(workflow, new RegExp(`\\$\\{\\{ steps\\.dogfood\\.outputs\\.${output} \\}\\}`));
  }
  assert.match(workflow, /if: always\(\) && steps\.dogfood\.outputs\.report != ''/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(workflow, OBSOLETE_RECEIPT_PATH);
});

test("CI keeps Windows CLI portability separate from POSIX Action dogfood", () => {
  const workflow = source(".github/workflows/ci.yml");
  const portabilityStart = workflow.indexOf("  portability:");
  assert.notEqual(portabilityStart, -1);
  const portability = workflow.slice(portabilityStart);
  assert.match(portability, /os: \[macos-latest, windows-latest\]/);
  for (const command of ["npm ci", "npm test", "npm run build"]) {
    assert.match(portability, new RegExp(`^\\s+- run: ${command}$`, "m"));
  }
  assert.match(
    portability,
    /- name: Dogfood Agent Vigil \(POSIX Action\)\n\s+if: runner\.os != 'Windows'\n\s+uses: \.\//,
  );

  const linux = workflow.slice(0, portabilityStart);
  assert.match(linux, /name: Dogfood Agent Vigil\n\s+id: dogfood\n\s+uses: \.\//);
  assert.match(linux, /name: Dogfood malformed-transcript failure\n\s+id: malformed/);
  for (const output of ["report", "sarif", "github-evidence", "value-card"]) {
    assert.match(linux, new RegExp(`\\$\\{\\{ steps\\.dogfood\\.outputs\\.${output} \\}\\}`));
  }
});

test("high-trust workflows pin the exact runtime and retain emitted artifact paths", () => {
  const evidence = source(".github/workflows/agent-vigil.yml");
  const outcomes = source(".github/workflows/agent-vigil-outcomes.yml");
  const upgradeExample = source("examples/upgrade-guard/github-workflow.yml");
  const installedUpgrade = source(".github/workflows/agent-vigil-upgrade.yml");
  for (const path of [
    ".github/workflows/agent-vigil.yml",
    ".github/workflows/agent-vigil-outcomes.yml",
    "examples/upgrade-guard/github-workflow.yml",
    ".github/workflows/agent-vigil-upgrade.yml",
  ]) assertExactSelfAction(path);
  assert.equal(installedUpgrade, upgradeExample, "installed upgrade workflow must be byte-equivalent to its reviewed example");
  assert.match(installedUpgrade, /pull_request_target:/);
  assert.match(installedUpgrade, /runs-on: ubuntu-24\.04/);
  for (const output of ["report", "sarif", "value-card", "github-evidence"]) {
    assert.match(evidence, new RegExp(`\\$\\{\\{ steps\\.vigil\\.outputs\\.${output} \\}\\}`));
  }
  assert.match(evidence, /if-no-files-found: error/);

  const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
  for (const name of readdirSync(workflowDirectory).filter((entry) => /\.ya?ml$/.test(entry))) {
    assert.doesNotMatch(source(`.github/workflows/${name}`), OBSOLETE_RECEIPT_PATH, `${name} must use Action output paths`);
  }
});

test("publish workflow pins source Actions and enforces the complete exact-source release gate", () => {
  const workflow = source(".github/workflows/publish.yml");
  assert.match(workflow, new RegExp(`actions/checkout@${CHECKOUT_SHA}`));
  assert.match(workflow, new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`));
  assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node)@v\d/);
  for (const command of [
    "npm run typecheck",
    "npm run build",
    "npm test",
    "npm run test:coverage",
    "npm run smoke",
    "npm run review:public",
    "npm run test:package",
    "npm run proof:historical",
    "npm run proof:failure-corpus",
    "npm run proof:update-pair-corpus",
    "npm audit",
  ]) {
    assert.match(workflow, new RegExp(`^\\s+${command}\\s*$`, "m"));
  }
  assert.match(workflow, /cp dist\/cli\.js "\$RUNNER_TEMP\/dist-cli\.committed\.js"/);
  assert.equal(workflow.match(/cmp -s "\$RUNNER_TEMP\/dist-cli\.committed\.js" dist\/cli\.js/g)?.length, 2);
  assert.match(workflow, /"scripts\/materialize-trusted-upgrade-inputs\.mjs"/);
  assert.match(workflow, /"docs\/APM_PREFLIGHT_ACTION\.md"/);
  assert.match(workflow, /"proof\/update-pair-corpus\/MANIFEST\.md"/);
  assert.match(workflow, /"proof\/update-pair-corpus\/metadata\/corpus-validation\.json"/);
  assert.match(workflow, /path\.startsWith\("services\/"\)/);
});

test("Team Workers disable public routes and declare secrets outside Wrangler config", () => {
  for (const path of [
    "services/team-control-plane/wrangler.jsonc",
    "services/team-control-plane/wrangler.stripe-executor.jsonc",
    "services/team-control-plane/wrangler.stripe-reconciler.jsonc",
  ]) {
    const config = JSON.parse(source(path)) as Record<string, unknown>;
    assert.equal(config.workers_dev, false, `${path} must disable workers.dev`);
    assert.equal(config.preview_urls, false, `${path} must disable preview URLs`);
    assert.ok(!Object.hasOwn(config, "secrets"), `${path} must not use unsupported secrets.required configuration`);
  }
  assert.match(source("services/team-control-plane/README.md"), /Wrangler has no supported `secrets\.required` configuration field/);
});

test("security and publishing docs describe current exact-source boundaries", () => {
  const security = source("SECURITY.md");
  assert.match(security, /exact Git blobs through\nplumbing-only `ls-tree` and `cat-file` access/);
  assert.match(security, /creates no checkout or\nworktree, so checkout hooks and content filters do not participate/);
  assert.doesNotMatch(security, /loads config and canaries from a detached exact-base\nworktree/);

  const publishing = source("docs/PUBLISHING.md");
  assert.match(publishing, /PACKAGE_VERSION="\$\(npm view @sulmusic\/agent-vigil version\)"/);
  assert.doesNotMatch(publishing, /@sulmusic\/agent-vigil@0\.14\.0/);
});
