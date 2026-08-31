import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const releaseVersion = "0.23.2";
const releaseCommit = "1c5544d84586249c452adda3f8432a9bdac2ca7a";
const releaseAsset = `sulmusic-agent-vigil-${releaseVersion}.tgz`;
const releaseUrl = `https://github.com/sulmusic2-star/agent-vigil/releases/download/v${releaseVersion}/${releaseAsset}`;
const releaseSha256 = "85dd030bc638625ae75181030268e5561dc7483c32e74253bfb17bf76ad2b839";
const registryIntegrity = "sha512-svknWHc0DT9Jh77tatKFmvsr3lJr8dSDLBrXud1pr1DKkgW8Yx7uIvS1+Xkq72TQfyP091sWUZZzDH8ku6RjuA==";
const candidateVersion = "0.23.3";

test("the npm-free guide separates the verified v0.23.2 package from the v0.23.3 candidate", () => {
  const guide = readFileSync(new URL("../docs/INSTALL_WITHOUT_NPM_ACCOUNT.md", import.meta.url), "utf8");

  assert.match(guide, new RegExp(`releases/download/v${candidateVersion}/sulmusic-agent-vigil-${candidateVersion}\\.tgz`));
  assert.match(guide, new RegExp(`sulmusic-agent-vigil-${candidateVersion}\\.tgz\\.sha256`));
  assert.match(guide, /shasum -a 256 -c/);
  assert.match(guide, new RegExp(releaseUrl.replaceAll(".", "\\.")));
  assert.match(guide, new RegExp(releaseSha256));
  assert.match(guide, new RegExp(releaseCommit));
  assert.match(
    guide,
    /v0\.23\.3 is a source release candidate until GitHub lists both the package and checksum assets\./,
  );
  assert.match(guide, /npm registry separately reports public version 0\.21\.1/);
  assert.match(guide, /npm publication\s+of v0\.23\.3 is not claimed/);
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
    'npx --yes "$AGENT_VIGIL_PACKAGE" protect',
    "git status --short",
    "git add .agent-vigil.json",
    'git commit -m "Install Agent Vigil"',
    'npx --yes "$AGENT_VIGIL_PACKAGE" doctor',
    'npx --yes "$AGENT_VIGIL_PACKAGE" continuity demo --json',
    "PASS -> CURRENT -> REVOKED -> REVOKED -> CURRENT",
    "## Remove it",
  ];

  let previous = -1;
  for (const step of orderedSteps) {
    const position = guide.indexOf(step);
    assert.ok(position > previous, `missing or out-of-order installation step: ${step}`);
    previous = position;
  }
  assert.doesNotMatch(guide, /node dist\/cli\.js (?:protect|doctor)/);
  assert.match(guide, /doctor` fails its readiness checks while the controls are uncommitted/);
  assert.match(guide, /does not make the\s+check required in GitHub/);
  assert.match(guide, /root of a Git repository/);
  assert.match(guide, /direct Node test command/);
  assert.match(guide, /REPLACE_WITH_TEST_COMMAND/);
  assert.match(guide, /doctor` fails closed/);
  assert.doesNotMatch(guide, /protect\s+\\\s+--action-sha/);
  assert.match(guide, /--runner common/);
  assert.match(guide, /\.agent-vigil-runner\.json \(only with --runner or --runner-image\)/);
  assert.match(guide, /if \[ -f \.agent-vigil-runner\.json \]/);
  assert.match(guide, /npm publication of v0\.23\.3\s+is not claimed/);
});
