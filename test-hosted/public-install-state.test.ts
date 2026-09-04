import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.23.2";
const releaseCommit = "1c5544d84586249c452adda3f8432a9bdac2ca7a";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "85dd030bc638625ae75181030268e5561dc7483c32e74253bfb17bf76ad2b839";
const registryIntegrity = "sha512-svknWHc0DT9Jh77tatKFmvsr3lJr8dSDLBrXud1pr1DKkgW8Yx7uIvS1+Xkq72TQfyP091sWUZZzDH8ku6RjuA==";
const candidateVersion = "0.24.0";

test("the npm-free guide separates verified packages from the unpublished v0.24.0 candidate", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");

  assert.doesNotMatch(guide, new RegExp(`releases/download/v${candidateVersion}/sulmusic-agent-vigil-${candidateVersion}\\.tgz`));
  assert.doesNotMatch(guide, new RegExp(`@sulmusic/agent-vigil@${candidateVersion}`));
  assert.match(guide, new RegExp(releaseUrl.replaceAll(".", "\\.")));
  assert.match(guide, new RegExp(releaseSha256));
  assert.match(guide, new RegExp(releaseCommit));
  assert.match(
    guide,
    /v0\.24\.0 is a source release candidate until GitHub lists both the package and checksum assets\./,
  );
  assert.match(guide, /npm serves v0\.21\.1/);
  assert.match(guide, /Do not install a v0\.24\.0 URL or npm specifier/);
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
    version: candidateVersion,
    github_release_published: false,
    npm_published: false,
  });
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
    "sulmusic-agent-vigil-0.23.2.tgz protect",
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
