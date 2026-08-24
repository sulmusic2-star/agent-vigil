#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMPONENT = /^[a-z0-9@][a-z0-9@/._-]*$/;
const ECOSYSTEM = /^[a-z0-9][a-z0-9._-]*$/;
const EXACT_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9@:+._-]*$/;
const SCHEMA_SHA256 = "db8311854812f7774b3da7f08b1981fccc2ce4c0fdf1cbc67e0d8e5e29bbd73c";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  assert.ok(process.argv[index + 1], `${name} requires a path`);
  return resolve(process.argv[index + 1]);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Prefixed(value) {
  return `sha256:${sha256(value)}`;
}

function object(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label}: object required`);
  return value;
}

function exact(value, required, optional, label) {
  const record = object(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) assert.ok(key in record, `${label}: missing ${key}`);
  for (const key of Object.keys(record)) assert.ok(allowed.has(key), `${label}: unknown ${key}`);
  return record;
}

function boundedText(value, minimum, maximum, label, pattern) {
  assert.equal(typeof value, "string", `${label}: string required`);
  assert.ok(value.length >= minimum && value.length <= maximum && !value.includes("\0"), `${label}: bounds`);
  if (pattern) assert.match(value, pattern, `${label}: format`);
  return value;
}

function timestamp(value, label) {
  const text = boundedText(value, 1, 64, label);
  assert.ok(Number.isFinite(Date.parse(text)) && new Date(text).toISOString() === text, `${label}: exact UTC timestamp`);
  return text;
}

function parseJsonl(bytes, label) {
  const text = bytes.toString("utf8");
  assert.ok(text.endsWith("\n"), `${label}: final newline required`);
  const lines = text.slice(0, -1).split("\n");
  assert.ok(lines.length >= 1 && lines.every((line) => line.length > 0), `${label}: blank line`);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`${label} line ${index + 1}: invalid JSON`);
    }
  });
}

const registrationBytes = readFileSync(join(root, "first-100-registration.json"));
const registration = JSON.parse(registrationBytes.toString("utf8"));
const signature = JSON.parse(readFileSync(join(root, "first-100-registration.signature.json"), "utf8"));
const schemaBytes = readFileSync(join(root, "first-100-entry-v1.schema.json"));
const publicKey = createPublicKey(readFileSync(join(root, "first-100-registration-public.pem")));
const ledgerPath = option("--ledger", join(root, "first-100-ledger.jsonl"));
const provenancePath = option("--provenance", join(root, "first-100-provenance.jsonl"));
const ledgerBytes = readFileSync(ledgerPath);
const provenanceBytes = readFileSync(provenancePath);
const ledger = parseJsonl(ledgerBytes, "ledger");
const provenance = parseJsonl(provenanceBytes, "provenance");

assert.equal(registration.schemaVersion, "diffwitness-first-100-registration/v1");
assert.equal(registration.state, "FROZEN_BEFORE_R0");
assert.equal(registration.releaseBoundary.r0Release, null);
assert.equal(registration.releaseBoundary.acceptBeforeR0, false);
assert.equal(registration.sample.targetEligiblePairs, 100);
assert.equal(registration.sample.componentCap, 20);
assert.equal(registration.sample.minimumMaterialRegressions, 3);
assert.equal(registration.sample.stretchMaterialRegressions, 5);
assert.equal(registration.sample.falseCompatibleMaximum, 0);

assert.equal(signature.schemaVersion, "diffwitness-detached-signature/v1");
assert.equal(signature.registrationId, registration.registrationId);
assert.equal(signature.algorithm, "Ed25519");
assert.equal(signature.registrationSha256, sha256(registrationBytes), "registration digest does not bind the exact bytes");
assert.equal(
  signature.publicKeyDerSha256,
  sha256(publicKey.export({ type: "spki", format: "der" })),
  "public-key digest mismatch",
);
assert.ok(verify(null, registrationBytes, publicKey, Buffer.from(signature.signatureBase64, "base64")), "registration signature is invalid");
assert.equal(sha256(schemaBytes), SCHEMA_SHA256, "entry schema digest mismatch");

const anchor = ledger[0];
assert.deepEqual(anchor, {
  schemaVersion: "diffwitness-first-100-ledger/v1",
  kind: "registration-anchor",
  registrationId: registration.registrationId,
  registrationSha256: signature.registrationSha256,
  pairEntries: 0,
});
const entries = ledger.slice(1);

const firstNewline = provenanceBytes.indexOf(0x0a);
assert.ok(firstNewline >= 0, "provenance: anchor newline required");
const provenanceRecordsBytes = provenanceBytes.subarray(firstNewline + 1);
const provenanceAnchor = provenance[0];
assert.deepEqual(provenanceAnchor, {
  schemaVersion: "agent-vigil-first-100-provenance-ledger/v2",
  kind: "provenance-anchor",
  registrationId: registration.registrationId,
  registrationSha256: signature.registrationSha256,
  rawLedgerSha256: sha256Prefixed(ledgerBytes),
  rawLedgerPairEntries: entries.length,
  provenanceRecords: entries.length,
  provenanceRecordsSha256: sha256Prefixed(provenanceRecordsBytes),
  rawLedgerGateEligibleWithoutProvenance: false,
  chronologyMutable: false,
});
const provenanceRecords = provenance.slice(1);
assert.equal(provenanceRecords.length, entries.length, "provenance: one record per raw pair required");

const permittedChannels = new Set(registration.permittedChannels);
const exclusionReasons = new Set(registration.excludeReasons);
const consequences = new Set(registration.materiality.atLeastOneWorkflowConsequence);
const dedup = new Set();
const includedByComponent = new Map();
let previousSequence = 0;
let previousReceivedAt = "";
let frozenIncluded = 0;
let effectiveIncluded = 0;
let evaluated = 0;
let conclusive = 0;
let material = 0;
let falseCompatible = 0;
let quarantined = 0;
let hundredthIncludedIndex = -1;

for (const [index, rawValue] of entries.entries()) {
  const line = index + 2;
  const entry = exact(rawValue, [
    "schemaVersion", "kind", "registrationId", "receivedAt", "ingestionSequence", "channel",
    "external", "optedIn", "inspectionStarted", "eligibility", "pair",
  ], ["evaluation"], `line ${line}`);
  assert.equal(entry.schemaVersion, "diffwitness-first-100-entry/v1", `line ${line}: schema`);
  assert.equal(entry.kind, "pair", `line ${line}: kind`);
  assert.equal(entry.registrationId, registration.registrationId, `line ${line}: registration`);
  assert.ok(Number.isSafeInteger(entry.ingestionSequence) && entry.ingestionSequence > previousSequence, `line ${line}: sequence order`);
  const receivedAt = timestamp(entry.receivedAt, `line ${line}: receivedAt`);
  assert.ok(receivedAt >= previousReceivedAt, `line ${line}: time order`);
  previousSequence = entry.ingestionSequence;
  previousReceivedAt = receivedAt;
  assert.ok(permittedChannels.has(entry.channel), `line ${line}: channel`);
  assert.equal(typeof entry.external, "boolean", `line ${line}: external type`);
  assert.equal(typeof entry.optedIn, "boolean", `line ${line}: consent type`);
  assert.equal(entry.inspectionStarted, false, `line ${line}: every decision must precede inspection`);

  const eligibility = exact(entry.eligibility, ["decision", "decidedAt", "reason"], [], `line ${line}: eligibility`);
  assert.ok(eligibility.decision === "INCLUDED" || eligibility.decision === "EXCLUDED", `line ${line}: decision`);
  const decidedAt = timestamp(eligibility.decidedAt, `line ${line}: decidedAt`);
  assert.ok(decidedAt >= receivedAt, `line ${line}: decision before receipt`);
  assert.ok(eligibility.reason === "ELIGIBLE" || exclusionReasons.has(eligibility.reason), `line ${line}: reason`);

  const pair = exact(entry.pair, [
    "ecosystem", "componentIdentity", "currentExactIdentity", "candidateExactIdentity", "realUpdateIntent",
  ], [], `line ${line}: pair`);
  boundedText(pair.ecosystem, 1, 64, `line ${line}: ecosystem`, ECOSYSTEM);
  boundedText(pair.componentIdentity, 1, 160, `line ${line}: component`, COMPONENT);
  boundedText(pair.currentExactIdentity, 8, 256, `line ${line}: current identity`, EXACT_IDENTITY);
  boundedText(pair.candidateExactIdentity, 8, 256, `line ${line}: candidate identity`, EXACT_IDENTITY);
  assert.equal(typeof pair.realUpdateIntent, "boolean", `line ${line}: update intent type`);

  const pairKey = [pair.ecosystem, pair.componentIdentity, pair.currentExactIdentity, pair.candidateExactIdentity].join("\u0000");
  if (eligibility.decision === "INCLUDED") {
    assert.equal(entry.external, true, `line ${line}: external`);
    assert.equal(entry.optedIn, true, `line ${line}: consent`);
    assert.equal(eligibility.reason, "ELIGIBLE", `line ${line}: eligible reason`);
    assert.equal(pair.realUpdateIntent, true, `line ${line}: update intent`);
    assert.notEqual(pair.currentExactIdentity, pair.candidateExactIdentity, `line ${line}: distinct pair`);
    assert.equal(dedup.has(pairKey), false, `line ${line}: duplicate included pair`);
    dedup.add(pairKey);
    const componentCount = (includedByComponent.get(pair.componentIdentity) ?? 0) + 1;
    assert.ok(componentCount <= registration.sample.componentCap, `line ${line}: global component cap`);
    includedByComponent.set(pair.componentIdentity, componentCount);
    frozenIncluded += 1;
    if (frozenIncluded === registration.sample.targetEligiblePairs) hundredthIncludedIndex = index;
  } else {
    assert.notEqual(eligibility.reason, "ELIGIBLE", `line ${line}: excluded reason`);
    assert.equal("evaluation" in entry, false, `line ${line}: excluded evaluation`);
  }

  let evaluation;
  if ("evaluation" in entry) {
    assert.equal(eligibility.decision, "INCLUDED", `line ${line}: evaluated exclusion`);
    evaluation = exact(entry.evaluation, [
      "startedAt", "completedAt", "verdict", "receiptHash", "falseCompatible", "materiality",
    ], [], `line ${line}: evaluation`);
    const startedAt = timestamp(evaluation.startedAt, `line ${line}: startedAt`);
    const completedAt = timestamp(evaluation.completedAt, `line ${line}: completedAt`);
    assert.ok(startedAt >= decidedAt, `line ${line}: inspected before decision`);
    assert.ok(completedAt >= startedAt, `line ${line}: completion order`);
    assert.ok(["SAFE", "CHANGED", "HOLD"].includes(evaluation.verdict), `line ${line}: verdict`);
    boundedText(evaluation.receiptHash, 71, 71, `line ${line}: receipt hash`, SHA256);
    assert.equal(typeof evaluation.falseCompatible, "boolean", `line ${line}: false-compatible type`);
    const materiality = exact(evaluation.materiality, [
      "classification", "evidenceComplete", "workflowConsequences",
    ], [], `line ${line}: materiality`);
    assert.ok(["MATERIAL", "NON_MATERIAL", "INCONCLUSIVE"].includes(materiality.classification), `line ${line}: classification`);
    assert.equal(typeof materiality.evidenceComplete, "boolean", `line ${line}: evidence completeness type`);
    assert.ok(Array.isArray(materiality.workflowConsequences) && materiality.workflowConsequences.length <= 6, `line ${line}: consequences`);
    assert.equal(new Set(materiality.workflowConsequences).size, materiality.workflowConsequences.length, `line ${line}: duplicate consequence`);
    assert.ok(materiality.workflowConsequences.every((item) => consequences.has(item)), `line ${line}: unsupported consequence`);
    if (materiality.classification === "MATERIAL") {
      assert.notEqual(evaluation.verdict, "HOLD", `line ${line}: HOLD cannot be material`);
      assert.equal(materiality.evidenceComplete, true, `line ${line}: material evidence`);
      assert.ok(materiality.workflowConsequences.length > 0, `line ${line}: material consequence`);
      assert.equal(evaluation.falseCompatible, evaluation.verdict === "SAFE", `line ${line}: false-compatible coherence`);
    } else if (materiality.classification === "NON_MATERIAL") {
      assert.notEqual(evaluation.verdict, "HOLD", `line ${line}: HOLD cannot be non-material`);
      assert.equal(materiality.evidenceComplete, true, `line ${line}: non-material evidence`);
      assert.equal(materiality.workflowConsequences.length, 0, `line ${line}: non-material consequence`);
      assert.equal(evaluation.falseCompatible, false, `line ${line}: non-material false-compatible`);
    } else {
      assert.equal(evaluation.verdict, "HOLD", `line ${line}: inconclusive verdict`);
      assert.equal(materiality.evidenceComplete, false, `line ${line}: inconclusive evidence`);
      assert.equal(materiality.workflowConsequences.length, 0, `line ${line}: inconclusive consequence`);
      assert.equal(evaluation.falseCompatible, false, `line ${line}: inconclusive false-compatible`);
    }
  }

  const provenanceLine = index + 2;
  const sidecar = exact(provenanceRecords[index], [
    "schemaVersion", "kind", "registrationId", "ingestionSequence", "publisher", "frozenEligibility",
    "effectiveEligibility", "chronologyMutable",
  ], [], `provenance line ${provenanceLine}`);
  assert.equal(sidecar.schemaVersion, "agent-vigil-first-100-provenance/v1", `provenance line ${provenanceLine}: schema`);
  assert.equal(sidecar.kind, "publisher-provenance", `provenance line ${provenanceLine}: kind`);
  assert.equal(sidecar.registrationId, registration.registrationId, `provenance line ${provenanceLine}: registration`);
  assert.equal(sidecar.ingestionSequence, entry.ingestionSequence, `provenance line ${provenanceLine}: sequence binding`);
  assert.equal(sidecar.chronologyMutable, false, `provenance line ${provenanceLine}: chronology`);
  const publisher = exact(sidecar.publisher, ["keyId", "status", "statusUpdatedAt"], [], `provenance line ${provenanceLine}: publisher`);
  boundedText(publisher.keyId, 71, 71, `provenance line ${provenanceLine}: publisher key`, SHA256);
  assert.ok(["ACTIVE", "SUSPENDED", "REVOKED"].includes(publisher.status), `provenance line ${provenanceLine}: publisher status`);
  timestamp(publisher.statusUpdatedAt, `provenance line ${provenanceLine}: statusUpdatedAt`);
  const frozen = exact(sidecar.frozenEligibility, ["decision", "reason"], [], `provenance line ${provenanceLine}: frozen eligibility`);
  assert.deepEqual(frozen, { decision: eligibility.decision, reason: eligibility.reason }, `provenance line ${provenanceLine}: frozen binding`);
  const effective = exact(sidecar.effectiveEligibility, ["decision", "reason", "gateEligible"], [], `provenance line ${provenanceLine}: effective eligibility`);
  assert.equal(typeof effective.gateEligible, "boolean", `provenance line ${provenanceLine}: gate eligibility type`);
  const active = publisher.status === "ACTIVE";
  if (active) {
    assert.deepEqual(effective, {
      decision: eligibility.decision,
      reason: eligibility.reason,
      gateEligible: eligibility.decision === "INCLUDED",
    }, `provenance line ${provenanceLine}: active semantics`);
  } else {
    assert.deepEqual(effective, {
      decision: "QUARANTINED",
      reason: publisher.status === "REVOKED" ? "PUBLISHER_REVOKED" : "PUBLISHER_SUSPENDED",
      gateEligible: false,
    }, `provenance line ${provenanceLine}: quarantine semantics`);
    quarantined += 1;
  }

  if (effective.gateEligible) {
    effectiveIncluded += 1;
    if (evaluation) {
      evaluated += 1;
      if (evaluation.verdict !== "HOLD") conclusive += 1;
      if (evaluation.materiality.classification === "MATERIAL") material += 1;
      if (evaluation.falseCompatible) falseCompatible += 1;
    }
  }
}

assert.ok(frozenIncluded <= registration.sample.targetEligiblePairs, "eligible sample exceeds 100");
if (hundredthIncludedIndex >= 0) {
  assert.equal(hundredthIncludedIndex, entries.length - 1, "ledger contains rows after the frozen sample closed");
}
const complete = effectiveIncluded === registration.sample.targetEligiblePairs
  && evaluated === registration.sample.targetEligiblePairs
  && conclusive === registration.sample.targetEligiblePairs;
const frequencyVerdict = effectiveIncluded < registration.sample.targetEligiblePairs
  ? "INSUFFICIENT_DISTRIBUTION_VOLUME"
  : !complete
    ? "INCOMPLETE_EVALUATIONS"
    : falseCompatible > registration.sample.falseCompatibleMaximum
      ? "FREQUENCY_GATE_FAIL"
      : material >= registration.sample.minimumMaterialRegressions
        ? "FREQUENCY_GATE_PASS"
        : "FREQUENCY_GATE_FAIL";

process.stdout.write(`${JSON.stringify({
  registrationId: registration.registrationId,
  registrationSha256: signature.registrationSha256,
  schemaSha256: SCHEMA_SHA256,
  rawLedgerSha256: sha256Prefixed(ledgerBytes),
  provenanceSha256: sha256Prefixed(provenanceBytes),
  pairEntries: entries.length,
  frozenIncluded,
  included: effectiveIncluded,
  excluded: entries.length - frozenIncluded,
  quarantined,
  evaluated,
  conclusive,
  material,
  falseCompatible,
  frequencyVerdict,
}, null, 2)}\n`);
