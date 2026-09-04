import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.24.0";
const releaseCommit = "ef583e6c9cac87941a7f283ef07af46187315912";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "49fc66f97e4ce1ae530513062430ae9a81dba94c3f722dd91bd3d1009e629151";
const registryIntegrity = "sha512-svknWHc0DT9Jh77tatKFmvsr3lJr8dSDLBrXud1pr1DKkgW8Yx7uIvS1+Xkq72TQfyP091sWUZZzDH8ku6RjuA==";

test("the npm-free guide identifies the exact v0.24.0 GitHub package", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");

  assert.match(guide, new RegExp(releaseUrl.replaceAll(".", "\\.")));
  assert.match(guide, new RegExp(releaseSha256));
  assert.match(guide, new RegExp(releaseCommit));
  assert.match(guide, /Marketplace listing also exposes v0\.24\.0/);
  assert.match(guide, /npm has staged v0\.24\.0/);
  assert.match(guide, /still serves\s+v0\.21\.1/s);
  assert.match(guide, /immutable tarball contains the earlier[\s\S]*pre-publication README and installation guide/);
  assert.match(guide, /Use this current web guide and the attached checksum/);
  assert.match(guide, /Controlled-trial limitation/);
  assert.match(guide, /prints an npm-based `doctor` command that is not currently available/);
  assert.match(guide, /A patch release must correct the embedded handoff/);
  assert.doesNotMatch(guide, /source release candidate/);
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
  assert.equal(state.source_release_candidate, undefined);
  assert.equal(state.npm_registry.package, "@sulmusic/agent-vigil");
  assert.equal(state.npm_registry.target_version, releaseVersion);
  assert.equal(state.npm_registry.observed_version, "0.21.1");
  assert.equal(state.npm_registry.observed_integrity, registryIntegrity);
  assert.equal(state.npm_registry.observed_published_at, "2026-08-28T16:01:40.782Z");
  assert.equal(state.npm_registry.target_published, false);
});

test("the five-minute guide preserves one complete value path", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");
  const orderedSteps = [
    "sulmusic-agent-vigil-0.24.0.tgz protect",
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
