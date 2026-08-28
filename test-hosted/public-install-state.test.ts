import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.22.0";
const releaseCommit = "5925e8bcbaf97f08c8c840252f486e96bf3f9775";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "2beaba44fb5988d04b25605462a81c1bc0d4d229bcd0b2ba0852e2d2f32de7eb";
const registryIntegrity = "sha512-svknWHc0DT9Jh77tatKFmvsr3lJr8dSDLBrXud1pr1DKkgW8Yx7uIvS1+Xkq72TQfyP091sWUZZzDH8ku6RjuA==";

test("the npm-free guide binds the immutable v0.22.0 GitHub package", () => {
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
  assert.equal(state.source_release_candidate, undefined);
  assert.equal(state.npm_registry.package, "@sulmusic/agent-vigil");
  assert.equal(state.npm_registry.target_version, releaseVersion);
  assert.equal(state.npm_registry.observed_version, "0.21.1");
  assert.equal(state.npm_registry.observed_integrity, registryIntegrity);
  assert.equal(state.npm_registry.observed_published_at, "2026-08-28T16:01:40.782Z");
  assert.equal(state.npm_registry.target_published, false);
});
