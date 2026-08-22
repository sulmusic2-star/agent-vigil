import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("npm package surface excludes internal product and commercial working documents", () => {
  const packageDocument = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    files?: unknown;
  };
  assert.ok(Array.isArray(packageDocument.files));
  const files = packageDocument.files as string[];

  assert.ok(!files.includes("docs"), "the whole docs tree must not be published");
  for (const internalPath of [
    "docs/COMMERCIAL_GATES.md",
    "docs/CONTROL_PLANE.md",
    "docs/IMPLEMENTED_DIFFERENTIATION_2026-08-22.md",
    "docs/MARKET_RADAR_2026-08-22.md",
    "docs/PRODUCT_DISCOVERY_2026-08-22.md",
    "docs/PUBLISHING.md",
    "docs/RESEARCH.md",
    "docs/research",
  ]) {
    assert.ok(!files.includes(internalPath), `${internalPath} must remain outside the npm package`);
  }

  for (const publicPath of [
    "SECURITY.md",
    "CONTRIBUTING.md",
    "docs/UPGRADE_GUARD.md",
    "docs/THREAT_MODEL.md",
    "docs/upgrade-config-v1.schema.json",
    "docs/upgrade-canary-v1.schema.json",
    "docs/upgrade-receipt-v1.schema.json",
    "docs/compatibility-entry-v1.schema.json",
    "proof/README.md",
    "proof/cases",
  ]) {
    assert.ok(files.includes(publicPath), `${publicPath} must ship with the npm package`);
  }
});
