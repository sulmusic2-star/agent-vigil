import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as diff from "../src/diff-evidence.ts";
import * as maintainer from "../src/maintainer.ts";

test("telemetry worker does not load repository verification or the JavaScript test parser", () => {
  const bundle = buildSync({
    absWorkingDir: fileURLToPath(new URL("..", import.meta.url)),
    entryPoints: ["src/run-telemetry-worker.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    metafile: true,
  });
  const inputs = Object.keys(bundle.metafile!.inputs).map((path) => path.replaceAll("\\", "/"));
  assert.ok(inputs.includes("src/transcript.ts"), "real transcript parsing must remain bundled");
  assert.ok(inputs.includes("src/authority.ts"), "action classification must remain bundled");
  const forbidden = inputs.filter((path) => path.startsWith("src/detectors/")
    || path === "src/maintainer.ts"
    || path === "src/candidate-command.ts"
    || path.startsWith("node_modules/acorn/"));
  assert.deepEqual(forbidden, [], "a telemetry worker must not import the repository verifier just to classify actions");
});

test("extracting diff helpers preserves the existing maintainer API", () => {
  assert.equal(maintainer.collectDiffEvidence, diff.collectDiffEvidence);
  assert.equal(maintainer.pathMatches, diff.pathMatches);
});
