import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.21.1";
const releaseCommit = "963f9070be9ac5e8e5cdf0b58ea703f151dba748";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "19084c6981b19d60b89f902a8583f1f1db955fdcb71be3e3449db44fd5eeed91";

test("the npm-free guide binds the immutable v0.21.1 GitHub package", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");

  assert.match(guide, new RegExp(releaseUrl.replaceAll(".", "\\.")));
  assert.match(guide, new RegExp(releaseSha256));
  assert.match(guide, new RegExp(releaseCommit));
  assert.match(guide, /npm registry still reports version 0\.11\.3/);
  assert.doesNotMatch(guide, /@sulmusic\/agent-vigil@0\.21\.1/);
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
  assert.equal(state.npm_registry.package, "@sulmusic/agent-vigil");
  assert.equal(state.npm_registry.target_version, releaseVersion);
  assert.equal(state.npm_registry.observed_version, "0.11.3");
  assert.equal(state.npm_registry.target_published, false);
});
