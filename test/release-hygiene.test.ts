import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const UPLOAD_ARTIFACT_SHA = "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const OBSOLETE_RECEIPT_PATH = /^\s+(?:agent-vigil-report\.json|agent-vigil\.sarif|agent-vigil-value-card\.json|agent-vigil-github-evidence\.json)\s*$/m;

test("CI pins third-party Actions and uploads dogfood runner-owned outputs", () => {
  const workflow = source(".github/workflows/ci.yml");
  assert.equal(workflow.match(new RegExp(`actions/checkout@${CHECKOUT_SHA}`, "g"))?.length, 2);
  assert.equal(workflow.match(new RegExp(`actions/setup-node@${SETUP_NODE_SHA}`, "g"))?.length, 2);
  assert.equal(workflow.match(new RegExp(`actions/upload-artifact@${UPLOAD_ARTIFACT_SHA}`, "g"))?.length, 1);
  assert.doesNotMatch(workflow, /uses:\s+actions\/(?:checkout|setup-node|upload-artifact)@v\d/);
  assert.match(workflow, /name: Dogfood Agent Vigil\n\s+id: dogfood\n\s+uses: \.\//);
  for (const output of ["report", "sarif", "github-evidence", "value-card"]) {
    assert.match(workflow, new RegExp(`\\$\\{\\{ steps\\.dogfood\\.outputs\\.${output} \\}\\}`));
  }
  assert.match(workflow, /if: always\(\) && steps\.dogfood\.outputs\.report != ''/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.doesNotMatch(workflow, OBSOLETE_RECEIPT_PATH);
});

test("tracked evidence workflows retain the Action's emitted artifact paths", () => {
  const evidence = source(".github/workflows/agent-vigil.yml");
  const outcomes = source(".github/workflows/agent-vigil-outcomes.yml");
  assert.match(evidence, /uses: sulmusic2-star\/agent-vigil@v0\.15\.0/);
  assert.match(outcomes, /uses: sulmusic2-star\/agent-vigil@v0\.15\.0/);
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
    "npm audit",
  ]) {
    assert.match(workflow, new RegExp(`^\\s+${command}\\s*$`, "m"));
  }
  assert.match(workflow, /cp dist\/cli\.js "\$RUNNER_TEMP\/dist-cli\.committed\.js"/);
  assert.equal(workflow.match(/cmp -s "\$RUNNER_TEMP\/dist-cli\.committed\.js" dist\/cli\.js/g)?.length, 2);
  assert.match(workflow, /"scripts\/materialize-trusted-upgrade-inputs\.mjs"/);
  assert.match(workflow, /"docs\/APM_PREFLIGHT_ACTION\.md"/);
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
