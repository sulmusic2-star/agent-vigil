import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.24.2";
const releaseCommit = "3dbd10d64563f10cb6a45b5199fbb74ae744fbec";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "00267aa8bdd0612e3e9416523c4085d75e5594b8c5d584bf9e4279e2c833fb3b";
const registryIntegrity = "sha512-E2BScm2OAaXDtnbqpQV0hnOpUht8lyad/FzS625MOBHGuCKNxCW4FMmRUuxVd/jbSf9fEY/EXVJj5ltBAkVtxg==";

test("the packaged guide uses an evergreen checksum-first install", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");
  assert.ok(guide.includes(releaseUrl));
  assert.match(guide, /shasum -a 256 -c .* &&/);
  assert.match(guide, /same\s+immutable v0\.24\.2 GitHub package/s);
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
  assert.equal(state.source_release_candidate, undefined);
  assert.equal(state.npm_registry.package, "@sulmusic/agent-vigil");
  assert.equal(state.npm_registry.target_version, releaseVersion);
  assert.equal(state.npm_registry.observed_version, "0.24.2");
  assert.equal(state.npm_registry.observed_integrity, registryIntegrity);
  assert.equal(state.npm_registry.observed_published_at, "2026-09-04T19:31:49.601Z");
  assert.equal(state.npm_registry.target_published, true);
});

test("the five-minute guide preserves one complete value path", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");
  const orderedSteps = [
    "sulmusic-agent-vigil-0.24.2.tgz protect",
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
