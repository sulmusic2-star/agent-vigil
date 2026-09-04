import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("parallel release tests give Action rejection probes a bounded two-minute budget", () => {
  const source = readFileSync(new URL("../test/action-runtime-security.test.ts", import.meta.url), "utf8");

  assert.match(source, /const ACTION_REJECTION_TIMEOUT_MS = 120_000;/);
  assert.match(source, /timeout: ACTION_REJECTION_TIMEOUT_MS/);
});

test("parallel release tests give live-route fixtures a bounded thirty-second budget", () => {
  const source = readFileSync(new URL("../test/guard-route.test.ts", import.meta.url), "utf8");

  assert.match(source, /const ROUTE_TEST_TIMEOUT_MS = 30_000;/);
  assert.match(source, /timeoutMs: ROUTE_TEST_TIMEOUT_MS/);
});

test("published registry state remains valid during release assembly", () => {
  const publicSurfaceGate = readFileSync(
    new URL("../scripts/public_surface_gate.py", import.meta.url),
    "utf8",
  );
  const assemblyGate = readFileSync(
    new URL("../scripts/verify_release_assembly.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    publicSurfaceGate,
    /changed\["npm_registry"\]\["target_published"\] = False\s+changed\["npm_registry"\]\["observed_version"\]/,
  );
  assert.match(assemblyGate, /"docs\/PUBLISHING\.md"/);
});
