#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const bytes = (name) => readFileSync(join(root, name));
const registrationBytes = bytes("first-100-registration.json");
const registration = JSON.parse(registrationBytes.toString("utf8"));
const signature = JSON.parse(bytes("first-100-registration.signature.json").toString("utf8"));
const schemaBytes = bytes("first-100-entry-v1.schema.json");
const ledgerBytes = bytes("first-100-ledger.jsonl");
const provenanceBytes = bytes("first-100-provenance.jsonl");
const publicKey = createPublicKey(bytes("first-100-registration-public.pem"));
const ledger = ledgerBytes.toString("utf8").trim().split("\n").map(JSON.parse);
const provenance = provenanceBytes.toString("utf8").trim().split("\n").map(JSON.parse);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

assert.equal(registration.state, "FROZEN_BEFORE_R0");
assert.equal(registration.releaseBoundary.r0Release, null);
assert.equal(registration.sample.targetEligiblePairs, 100);
assert.equal(registration.sample.minimumMaterialRegressions, 3);
assert.equal(registration.sample.stretchMaterialRegressions, 5);
assert.equal(registration.sample.falseCompatibleMaximum, 0);
assert.equal(sha256(registrationBytes), signature.registrationSha256);
assert.equal(signature.registrationSha256, "9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da");
assert.equal(sha256(schemaBytes), "db8311854812f7774b3da7f08b1981fccc2ce4c0fdf1cbc67e0d8e5e29bbd73c");
assert.equal(sha256(publicKey.export({ type: "spki", format: "der" })), signature.publicKeyDerSha256);
assert.equal(
  verify(null, registrationBytes, publicKey, Buffer.from(signature.signatureBase64, "base64")),
  true,
);
assert.deepEqual(ledger, [{
  schemaVersion: "diffwitness-first-100-ledger/v1",
  kind: "registration-anchor",
  registrationId: registration.registrationId,
  registrationSha256: signature.registrationSha256,
  pairEntries: 0,
}]);
assert.deepEqual(provenance, [{
  schemaVersion: "agent-vigil-first-100-provenance-ledger/v2",
  kind: "provenance-anchor",
  registrationId: registration.registrationId,
  registrationSha256: signature.registrationSha256,
  rawLedgerSha256: `sha256:${sha256(ledgerBytes)}`,
  rawLedgerPairEntries: 0,
  provenanceRecords: 0,
  provenanceRecordsSha256: `sha256:${sha256(Buffer.alloc(0))}`,
  rawLedgerGateEligibleWithoutProvenance: false,
  chronologyMutable: false,
}]);

process.stdout.write(`${JSON.stringify({
  registrationId: registration.registrationId,
  registrationSha256: signature.registrationSha256,
  pairEntries: 0,
  provenanceBound: true,
  verified: true,
}, null, 2)}\n`);
