import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("release-source documents may name a disclosed GitHub candidate without allowing candidate npm installs", () => {
  const probe = spawnSync(
    "python3",
    [
      "-c",
      [
        "from scripts.public_surface_gate import candidate_disclosure_failures, install_reference_failures, release_asset_url",
        "released = '0.23.1'",
        "candidate = '0.23.2'",
        "text = release_asset_url(released) + '\\n' + release_asset_url(candidate)",
        "failures = install_reference_failures('fixture', text, released, candidate, '0.21.1', allow_candidate_release=True)",
        "assert failures == [], failures",
        "text += '\\n@sulmusic/agent-vigil@0.23.2'",
        "failures = install_reference_failures('fixture', text, released, candidate, '0.21.1', allow_candidate_release=True)",
        "assert any('unpublished source candidate' in failure for failure in failures), failures",
        "disclosure = 'v0.23.2 is a source release candidate until GitHub lists both the package and checksum assets.'",
        "assert candidate_disclosure_failures('fixture', disclosure, candidate) == []",
        "failures = candidate_disclosure_failures('fixture', disclosure, None)",
        "assert any('after promotion' in failure for failure in failures), failures",
      ].join("\n"),
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
});
