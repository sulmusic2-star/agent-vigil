import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const repository = process.cwd();
const frequencySource = join(repository, "proof", "update-pair-corpus", "frequency");
const publisherKeyId = `sha256:${"d".repeat(64)}`;
const temporaryFixtures = new Set<string>();

type Entry = Record<string, any>;

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function completeEntries(): Entry[] {
  return Array.from({ length: 100 }, (_, index) => {
    const sequence = index + 1;
    const occurredAt = new Date(Date.UTC(2026, 7, 24, 0, 0, 0, sequence)).toISOString();
    const material = sequence <= 3;
    return {
      schemaVersion: "diffwitness-first-100-entry/v1",
      kind: "pair",
      registrationId: "d0a44ad6-acfc-4542-a5fa-84c68ff37067",
      receivedAt: occurredAt,
      ingestionSequence: sequence,
      channel: "apm",
      external: true,
      optedIn: true,
      inspectionStarted: false,
      eligibility: { decision: "INCLUDED", decidedAt: occurredAt, reason: "ELIGIBLE" },
      pair: {
        ecosystem: "apm",
        componentIdentity: `component-${Math.floor(index / 20) + 1}`,
        currentExactIdentity: `sha256:${sequence.toString(16).padStart(64, "a")}`,
        candidateExactIdentity: `sha256:${(sequence + 1_000).toString(16).padStart(64, "b")}`,
        realUpdateIntent: true,
      },
      evaluation: {
        startedAt: occurredAt,
        completedAt: occurredAt,
        verdict: material ? "CHANGED" : "SAFE",
        receiptHash: `sha256:${sequence.toString(16).padStart(64, "c")}`,
        falseCompatible: false,
        materiality: {
          classification: material ? "MATERIAL" : "NON_MATERIAL",
          evidenceComplete: true,
          workflowConsequences: material ? ["REQUIRED_BEHAVIOR_UNAVAILABLE"] : [],
        },
      },
    };
  });
}

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-vigil-first100-fixed-"));
  temporaryFixtures.add(directory);
  cpSync(frequencySource, directory, { recursive: true });
  return directory;
}

after(() => {
  for (const directory of temporaryFixtures) rmSync(directory, { recursive: true, force: true });
});

function writeBundle(
  directory: string,
  entries: Entry[],
  statuses: Array<"ACTIVE" | "SUSPENDED" | "REVOKED"> = entries.map(() => "ACTIVE"),
): void {
  assert.equal(statuses.length, entries.length);
  const anchor = JSON.parse(readFileSync(join(frequencySource, "first-100-ledger.jsonl"), "utf8").trim());
  const ledger = `${[anchor, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`;
  const records = entries.map((entry, index) => {
    const status = statuses[index]!;
    const active = status === "ACTIVE";
    return {
      schemaVersion: "agent-vigil-first-100-provenance/v1",
      kind: "publisher-provenance",
      registrationId: anchor.registrationId,
      ingestionSequence: entry.ingestionSequence,
      publisher: { keyId: publisherKeyId, status, statusUpdatedAt: "2026-08-24T00:00:00.000Z" },
      frozenEligibility: { ...entry.eligibility, decidedAt: undefined },
      effectiveEligibility: active
        ? { decision: entry.eligibility.decision, reason: entry.eligibility.reason, gateEligible: entry.eligibility.decision === "INCLUDED" }
        : { decision: "QUARANTINED", reason: status === "REVOKED" ? "PUBLISHER_REVOKED" : "PUBLISHER_SUSPENDED", gateEligible: false },
      chronologyMutable: false,
    };
  });
  const recordBytes = records.length === 0 ? "" : `${records.map((value) => JSON.stringify(value)).join("\n")}\n`;
  const provenanceAnchor = {
    schemaVersion: "agent-vigil-first-100-provenance-ledger/v2",
    kind: "provenance-anchor",
    registrationId: anchor.registrationId,
    registrationSha256: anchor.registrationSha256,
    rawLedgerSha256: digest(ledger),
    rawLedgerPairEntries: entries.length,
    provenanceRecords: records.length,
    provenanceRecordsSha256: digest(recordBytes),
    rawLedgerGateEligibleWithoutProvenance: false,
    chronologyMutable: false,
  };
  writeFileSync(join(directory, "first-100-ledger.jsonl"), ledger);
  writeFileSync(join(directory, "first-100-provenance.jsonl"), `${JSON.stringify(provenanceAnchor)}\n${recordBytes}`);
}

function validate(directory: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(directory, "validate-first-100.mjs")], {
    cwd: directory,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the published first-100 frame is signed, frozen before R0, and empty", () => {
  const output = execFileSync(process.execPath, ["proof/first-100/verify.mjs"], {
    cwd: repository,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  const result = JSON.parse(output) as {
    registrationId: string;
    registrationSha256: string;
    pairEntries: number;
    provenanceBound: boolean;
    verified: boolean;
  };

  assert.deepEqual(result, {
    registrationId: "d0a44ad6-acfc-4542-a5fa-84c68ff37067",
    registrationSha256: "9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da",
    pairEntries: 0,
    provenanceBound: true,
    verified: true,
  });

  const registration = JSON.parse(readFileSync(
    join(repository, "proof", "first-100", "first-100-registration.json"),
    "utf8",
  )) as { releaseBoundary: { r0Release: unknown }; sample: { targetEligiblePairs: number } };
  assert.equal(registration.releaseBoundary.r0Release, null);
  assert.equal(registration.sample.targetEligiblePairs, 100);
});

test("the first-100 validator passes only a complete coherent 100-pair corpus", () => {
  const directory = fixture();
  writeBundle(directory, completeEntries());
  const result = validate(directory);
  assert.equal(result.status, 0, result.stderr);
  assertSubset(JSON.parse(result.stdout), {
    included: 100,
    evaluated: 100,
    conclusive: 100,
    material: 3,
    falseCompatible: 0,
    frequencyVerdict: "FREQUENCY_GATE_PASS",
  });
});

test("the first-100 validator fails closed for incomplete and contradictory outcomes", () => {
  const incompleteDirectory = fixture();
  const incomplete = completeEntries();
  for (const entry of incomplete.slice(3)) delete entry.evaluation;
  writeBundle(incompleteDirectory, incomplete);
  const incompleteResult = validate(incompleteDirectory);
  assert.equal(incompleteResult.status, 0, incompleteResult.stderr);
  assert.equal(JSON.parse(incompleteResult.stdout).frequencyVerdict, "INCOMPLETE_EVALUATIONS");

  const holdDirectory = fixture();
  const hold = completeEntries();
  hold[3]!.evaluation.verdict = "HOLD";
  hold[3]!.evaluation.falseCompatible = false;
  hold[3]!.evaluation.materiality = { classification: "INCONCLUSIVE", evidenceComplete: false, workflowConsequences: [] };
  writeBundle(holdDirectory, hold);
  const holdResult = validate(holdDirectory);
  assert.equal(holdResult.status, 0, holdResult.stderr);
  assert.equal(JSON.parse(holdResult.stdout).frequencyVerdict, "INCOMPLETE_EVALUATIONS");

  const contradictionDirectory = fixture();
  const contradiction = completeEntries();
  contradiction[0]!.evaluation.verdict = "SAFE";
  contradiction[0]!.evaluation.falseCompatible = false;
  writeBundle(contradictionDirectory, contradiction);
  const contradictionResult = validate(contradictionDirectory);
  assert.notEqual(contradictionResult.status, 0);
  assert.match(contradictionResult.stderr, /false-compatible coherence/);

  const falseCompatibleDirectory = fixture();
  const falseCompatible = completeEntries();
  falseCompatible[0]!.evaluation.verdict = "SAFE";
  falseCompatible[0]!.evaluation.falseCompatible = true;
  writeBundle(falseCompatibleDirectory, falseCompatible);
  const falseCompatibleResult = validate(falseCompatibleDirectory);
  assert.equal(falseCompatibleResult.status, 0, falseCompatibleResult.stderr);
  assertSubset(JSON.parse(falseCompatibleResult.stdout), {
    falseCompatible: 1,
    frequencyVerdict: "FREQUENCY_GATE_FAIL",
  });

  const postInspectionDirectory = fixture();
  const postInspection = completeEntries();
  postInspection.push({
    ...postInspection[99],
    ingestionSequence: 101,
    receivedAt: "2026-08-24T00:00:00.101Z",
    inspectionStarted: true,
    eligibility: { decision: "EXCLUDED", decidedAt: "2026-08-24T00:00:00.101Z", reason: "DUPLICATE_PAIR" },
    pair: { ...postInspection[99]!.pair, candidateExactIdentity: `sha256:${"e".repeat(64)}` },
    evaluation: undefined,
  });
  delete postInspection[100]!.evaluation;
  writeBundle(postInspectionDirectory, postInspection);
  const postInspectionResult = validate(postInspectionDirectory);
  assert.notEqual(postInspectionResult.status, 0);
  assert.match(postInspectionResult.stderr, /every decision must precede inspection/);

  const afterClosedDirectory = fixture();
  const afterClosed = completeEntries();
  afterClosed.push({
    ...afterClosed[99],
    ingestionSequence: 101,
    receivedAt: "2026-08-24T00:00:00.101Z",
    inspectionStarted: false,
    eligibility: { decision: "EXCLUDED", decidedAt: "2026-08-24T00:00:00.101Z", reason: "DUPLICATE_PAIR" },
    pair: { ...afterClosed[99]!.pair, candidateExactIdentity: `sha256:${"e".repeat(64)}` },
    evaluation: undefined,
  });
  delete afterClosed[100]!.evaluation;
  writeBundle(afterClosedDirectory, afterClosed);
  const afterClosedResult = validate(afterClosedDirectory);
  assert.notEqual(afterClosedResult.status, 0);
  assert.match(afterClosedResult.stderr, /after the frozen sample closed/);
});

test("the first-100 validator requires a matching complete provenance sidecar and quarantines inactive publishers", () => {
  const missingDirectory = fixture();
  const missing = spawnSync(process.execPath, [join(missingDirectory, "validate-first-100.mjs"), "--provenance", join(missingDirectory, "absent.jsonl")], {
    cwd: missingDirectory,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.notEqual(missing.status, 0);

  const staleDirectory = fixture();
  const staleEntries = completeEntries();
  writeBundle(staleDirectory, staleEntries);
  staleEntries[0]!.pair.candidateExactIdentity = `sha256:${"f".repeat(64)}`;
  const rawAnchor = JSON.parse(readFileSync(join(frequencySource, "first-100-ledger.jsonl"), "utf8").trim());
  writeFileSync(
    join(staleDirectory, "first-100-ledger.jsonl"),
    `${[rawAnchor, ...staleEntries].map((value) => JSON.stringify(value)).join("\n")}\n`,
  );
  const staleResult = validate(staleDirectory);
  assert.notEqual(staleResult.status, 0);
  assert.match(staleResult.stderr, /rawLedgerSha256/);

  const incompleteDirectory = fixture();
  writeBundle(incompleteDirectory, completeEntries());
  const incompleteLines = readFileSync(join(incompleteDirectory, "first-100-provenance.jsonl"), "utf8").trim().split("\n");
  const incompleteAnchor = JSON.parse(incompleteLines.shift()!);
  incompleteLines.pop();
  const incompleteRecords = `${incompleteLines.join("\n")}\n`;
  incompleteAnchor.provenanceRecords = incompleteLines.length;
  incompleteAnchor.provenanceRecordsSha256 = digest(incompleteRecords);
  writeFileSync(join(incompleteDirectory, "first-100-provenance.jsonl"), `${JSON.stringify(incompleteAnchor)}\n${incompleteRecords}`);
  const incompleteProvenance = validate(incompleteDirectory);
  assert.notEqual(incompleteProvenance.status, 0);
  assert.match(incompleteProvenance.stderr, /provenanceRecords/);

  const duplicateDirectory = fixture();
  writeBundle(duplicateDirectory, completeEntries());
  const duplicateLines = readFileSync(join(duplicateDirectory, "first-100-provenance.jsonl"), "utf8").trim().split("\n");
  const duplicateAnchor = JSON.parse(duplicateLines.shift()!);
  duplicateLines[1] = duplicateLines[0]!;
  const duplicateRecords = `${duplicateLines.join("\n")}\n`;
  duplicateAnchor.provenanceRecordsSha256 = digest(duplicateRecords);
  writeFileSync(join(duplicateDirectory, "first-100-provenance.jsonl"), `${JSON.stringify(duplicateAnchor)}\n${duplicateRecords}`);
  const duplicateProvenance = validate(duplicateDirectory);
  assert.notEqual(duplicateProvenance.status, 0);
  assert.match(duplicateProvenance.stderr, /sequence binding/);

  const quarantinedDirectory = fixture();
  const statuses: Array<"ACTIVE" | "SUSPENDED" | "REVOKED"> = completeEntries().map(() => "ACTIVE");
  statuses[0] = "REVOKED";
  statuses[1] = "SUSPENDED";
  writeBundle(quarantinedDirectory, completeEntries(), statuses);
  const quarantinedResult = validate(quarantinedDirectory);
  assert.equal(quarantinedResult.status, 0, quarantinedResult.stderr);
  assertSubset(JSON.parse(quarantinedResult.stdout), {
    frozenIncluded: 100,
    included: 98,
    quarantined: 2,
    frequencyVerdict: "INSUFFICIENT_DISTRIBUTION_VOLUME",
  });

  const inactiveExcludedDirectory = fixture();
  const inactiveExcluded = completeEntries().slice(0, 2);
  inactiveExcluded[1]!.eligibility = {
    decision: "EXCLUDED",
    decidedAt: inactiveExcluded[1]!.receivedAt,
    reason: "DUPLICATE_PAIR",
  };
  delete inactiveExcluded[1]!.evaluation;
  writeBundle(inactiveExcludedDirectory, inactiveExcluded, ["ACTIVE", "REVOKED"]);
  const inactiveExcludedResult = validate(inactiveExcludedDirectory);
  assert.equal(inactiveExcludedResult.status, 0, inactiveExcludedResult.stderr);
  assertSubset(JSON.parse(inactiveExcludedResult.stdout), {
    frozenIncluded: 1,
    included: 1,
    excluded: 1,
    quarantined: 1,
    frequencyVerdict: "INSUFFICIENT_DISTRIBUTION_VOLUME",
  });
});

test("the first-100 component cap is one lowercase global identity across ecosystems", () => {
  const directory = fixture();
  const entries = completeEntries();
  for (const [index, entry] of entries.slice(0, 21).entries()) {
    entry.pair.componentIdentity = "global-component";
    entry.pair.ecosystem = index % 2 === 0 ? "apm" : "skills";
  }
  writeBundle(directory, entries);
  const result = validate(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /global component cap/);
});

function assertSubset(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
}
