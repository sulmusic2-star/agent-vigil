import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.24.3";
const releaseCommit = "b09fc9ed05d9ca9c9be801a366439ffa1f92c8e1";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "586e48f45030aa34c42107a0dc418a2f905c79186c8eebca3aebfbc376defe18";
const registryIntegrity = "sha512-jLAH7Bl83WzYdawZ1cSnJZGkOsSiOotDi+9K/F3JCtQiQqj1Kw+Fa3y1W4XMXsVi9n+9Q9ADp5lRNqrjPflc6Q==";

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
  assert.ok(guide.includes("https://github.com/sulmusic2-star/agent-vigil/releases/download/v0.24.3/sulmusic-agent-vigil-0.24.3.tgz"));
  assert.match(guide, /shasum -a 256 -c .* &&/);
  assert.match(guide, /same\s+immutable v0\.24\.3 GitHub package/s);
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
  assert.equal(state.npm_registry.observed_version, "0.24.3");
  assert.equal(state.npm_registry.observed_integrity, registryIntegrity);
  assert.equal(state.npm_registry.observed_published_at, "2026-09-04T23:02:09.650Z");
  assert.equal(state.npm_registry.target_published, true);
});

test("the five-minute guide preserves one complete value path", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");
  const orderedSteps = [
    "sulmusic-agent-vigil-0.24.3.tgz protect",
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
