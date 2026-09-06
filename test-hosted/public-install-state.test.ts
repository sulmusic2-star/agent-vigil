import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.24.4";
const releaseCommit = "29d3a6c8ac4f48baaa3f1702fdd9d297c6d328ee";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "0c05c2920a50478af0ad96dadecb43608ad1e8e1107aad277c948a5054dd985e";
const registryIntegrity = "sha512-MiwIeLrISgNQ4s4Ph6oryEUq4NysELi8BZGoFi28NhDIkWsFzvoNgI3qron2l3jL0+0BkvVXuz9V2pR/VwWIRQ==";

for (const filename of ["HOSTED_SECURITY_CONTRACT.md", "COMPATIBILITY.md"]) {
  test(`${filename} distinguishes test-required setup from transcript scaffolding`, () => {
    const guide = readFileSync(new URL(`../docs/${filename}`, import.meta.url), "utf8").replace(/\s+/g, " ");
    assert.match(guide, /`protect` and `init --profile maintainer` require a test command/);
    assert.match(guide, /without one[\s\S]*?rejected before any setup files are written/);
    assert.match(guide, /--runner common --test-cmd/);
    assert.match(guide, /transcript and authority profiles[\s\S]*?do not prove that tests ran/);
    assert.doesNotMatch(guide, /a plain (?:Git )?repository with no inferred non-Node/);
  });
}

test("the packaged guide uses an evergreen checksum-first install", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");
  assert.ok(guide.includes("https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.25.0/sulmusic-agent-vigil-0.25.0.tgz"));
  assert.match(guide, /shasum -a 256 -c .* &&/);
  assert.match(guide, /same\s+immutable v0\.25\.0 GitHub package/s);
  assert.doesNotMatch(guide, /source release candidate|verification snapshot/);
  assert.ok(!guide.includes(releaseSha256), "the tarball cannot embed its own future checksum");
  assert.ok(!guide.includes(releaseCommit), "the tarball cannot embed its own future commit");
});

test("the public install state keeps GitHub and npm publication separate", () => {
  const state = JSON.parse(
    readFileSync(new URL("../docs/public-install-state.json", import.meta.url), "utf8"),
  );

  assert.equal(state.schema_version, 1);
  assert.equal(state.latest_github_release.version, releaseVersion);
  assert.equal(state.latest_github_release.commit, releaseCommit);
  assert.equal(state.latest_github_release.asset_url, releaseUrl);
  assert.equal(state.latest_github_release.sha256, releaseSha256);
  assert.equal(state.latest_github_release.immutable, true);
  assert.deepEqual(state.source_release_candidate, { version: "0.25.0", github_release_published: false, npm_published: false });
  assert.equal(state.npm_registry.package, "@sulmusic/agent-vigil");
  assert.equal(state.npm_registry.target_version, releaseVersion);
  assert.equal(state.npm_registry.observed_version, "0.24.4");
  assert.equal(state.npm_registry.observed_integrity, registryIntegrity);
  assert.equal(state.npm_registry.observed_published_at, "2026-09-05T20:09:22.613Z");
  assert.equal(state.npm_registry.target_published, true);
});

test("the five-minute guide preserves one complete value path", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");
  const orderedSteps = [
    "sulmusic-agent-vigil-0.25.0.tgz agent-vigil protect",
    "One setup pull request",
    "PASS",
    "FAIL",
    "NOT CHECKED",
    "Enforcement",
    "## Remove it",
  ];

  let previous = -1;
  for (const step of orderedSteps) {
    const position = guide.indexOf(step);
    assert.ok(position > previous, `missing or out-of-order installation step: ${step}`);
    previous = position;
  }
  assert.doesNotMatch(guide, /node dist\/cli\.js (?:protect|doctor)/);
  assert.match(guide, /--runner common/);
  assert.match(guide, /centrally\s+operated Agent Vigil App/s);
  assert.match(guide, /successful install proves setup, not retained use/);
  assert.doesNotMatch(guide, /continuity demo|REVOKED ->/);
});


test("the README names the runtime actually pinned by the repository workflows and hosted template", () => {
  const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const readme = read("README.md");
  const match = /five repository workflows and the hosted App workflow template[\s\S]*?`([0-9a-f]{40})`/.exec(readme);
  assert.ok(match, "README must identify the pinned runtime");
  const workflows = [
    ".github/workflows/agent-vigil.yml", ".github/workflows/agent-vigil-outcomes.yml",
    ".github/workflows/control-proof-weekly.yml", ".github/workflows/agent-vigil-merge-group.yml",
    ".github/workflows/public-app-gate.yml", "hosted/public-app/control-workflow.yml",
  ];
  for (const file of workflows) {
    const pins = [...read(file).matchAll(/uses:\s*sulmusic2-star\/agent-vigil@([0-9a-f]{40})/g)];
    assert.ok(pins.length > 0, `${file} must pin Agent Vigil`);
    for (const pin of pins) assert.equal(pin[1], match[1], `${file} disagrees with README`);
  }
});
