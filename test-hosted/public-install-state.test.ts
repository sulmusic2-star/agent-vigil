import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.21.1";
const releaseCommit = "963f9070be9ac5e8e5cdf0b58ea703f151dba748";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "19084c6981b19d60b89f902a8583f1f1db955fdcb71be3e3449db44fd5eeed91";
const registryIntegrity = "sha512-svknWHc0DT9Jh77tatKFmvsr3lJr8dSDLBrXud1pr1DKkgW8Yx7uIvS1+Xkq72TQfyP091sWUZZzDH8ku6RjuA==";

test("the npm-free guide binds the immutable v0.21.1 GitHub package", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");

  assert.match(guide, new RegExp(releaseUrl.replaceAll(".", "\\.")));
  assert.match(guide, new RegExp(releaseSha256));
  assert.match(guide, new RegExp(releaseCommit));
  assert.match(guide, /npm registry reports version 0\.21\.1/);
  assert.match(guide, /npm publication of v0\.21\.1 is public and separately verified/);
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
  assert.deepEqual(state.source_release_candidate, {
    version: "0.21.2",
    github_release_published: false,
    npm_published: false,
  });
  assert.equal(state.npm_registry.package, "@sulmusic/agent-vigil");
  assert.equal(state.npm_registry.target_version, releaseVersion);
  assert.equal(state.npm_registry.observed_version, releaseVersion);
  assert.equal(state.npm_registry.observed_integrity, registryIntegrity);
  assert.equal(state.npm_registry.observed_published_at, "2026-08-28T16:01:40.782Z");
  assert.equal(state.npm_registry.target_published, true);
});
