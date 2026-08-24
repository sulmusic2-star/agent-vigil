#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const validation = JSON.parse(
  readFileSync(join(root, "metadata/corpus-validation.json"), "utf8"),
);

assert.equal(validation.schemaVersion, "agent-vigil-corpus-validation/v1");
assert.equal(validation.status, "PASS");

const commitments = validation.durableFileSha256;
assert.equal(Object.keys(commitments).length, 10);

for (const [relativePath, expected] of Object.entries(commitments)) {
  assert.match(relativePath, /^(?:MANIFEST\.md|pairs\.json|metadata\/[^/]+|regressions\/[^/]+)$/);
  assert.match(expected, /^[0-9a-f]{64}$/);
  const actual = createHash("sha256")
    .update(readFileSync(join(root, relativePath)))
    .digest("hex");
  assert.equal(actual, expected, `${relativePath} SHA-256 mismatch`);
}

process.stdout.write(
  `PASS ${Object.keys(commitments).length} durable corpus commitments; ` +
    "historical tarballs, receipts, and runtime executions were not replayed\n",
);
