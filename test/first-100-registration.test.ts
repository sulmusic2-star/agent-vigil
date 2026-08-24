import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const repository = process.cwd();
const frequencySource = join(repository, "proof", "update-pair-corpus", "frequency");
const registrationId = "d0a44ad6-acfc-4542-a5fa-84c68ff37067";
const registrationSha256 = "9a62537bf1bb047a1d971ee81d37bf1e35ffb7d8e7a76e2d29dd779c5ae1f2da";
const adapterVersion = "trusted-acquisition-adapter-v1";
const temporaryFixtures = new Set<string>();

type Entry = Record<string, any>;
type PrincipalStatus = "ACTIVE" | "SUSPENDED" | "REVOKED";
type Operator = { privateKey: KeyObject; publicKey: KeyObject; keyId: string };
type TrustFixture = {
  manifestPath: string;
  headPath: string;
  publicKeyPath: string;
  chunkPaths: string[];
  operator: Operator;
};

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function operatorFixture(): Operator {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = digest(publicKey.export({ type: "spki", format: "der" }));
  return { privateKey, publicKey, keyId };
}

function signedDocument(schemaVersion: string, payload: Record<string, unknown>, operator: Operator): Record<string, unknown> {
  const message = canonical({ schemaVersion, payload });
  return {
    schemaVersion,
    payload,
    signature: {
      algorithm: "Ed25519",
      keyId: operator.keyId,
      value: sign(null, Buffer.from(message), operator.privateKey).toString("base64"),
    },
  };
}

function publisherKeyId(index: number): string {
  return digest(`publisher-${index}`);
}

function adapterKeyId(index: number): string {
  return digest(`adapter-${index}`);
}

function uuid(prefix: number, index: number): string {
  return `${prefix.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function completeEntries(): Entry[] {
  return Array.from({ length: 100 }, (_, index) => {
    const sequence = index + 1;
    const occurredAt = new Date(Date.UTC(2026, 7, 24, 0, 0, 0, sequence)).toISOString();
    const material = sequence <= 3;
    return {
      schemaVersion: "diffwitness-first-100-entry/v1",
      kind: "pair",
      registrationId,
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

function completeEntriesWithLeadingExclusion(): Entry[] {
  const included: Entry[] = completeEntries().map((entry): Entry => ({
    ...entry,
    ingestionSequence: entry.ingestionSequence + 1,
  }));
  const excluded: Entry = {
    ...included[0],
    ingestionSequence: 1,
    receivedAt: "2026-08-24T00:00:00.000Z",
    eligibility: { decision: "EXCLUDED", decidedAt: "2026-08-24T00:00:00.000Z", reason: "DUPLICATE_PAIR" },
    pair: {
      ...included[0]!.pair,
      componentIdentity: "excluded-component",
      currentExactIdentity: `sha256:${"8".repeat(64)}`,
      candidateExactIdentity: `sha256:${"9".repeat(64)}`,
    },
  };
  delete excluded.evaluation;
  return [excluded, ...included];
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
  statuses: PrincipalStatus[] = entries.map(() => "ACTIVE"),
  options: {
    adapterStatuses?: Array<"ACTIVE" | "REVOKED">;
    issuedAt?: string;
    checkpointSequence?: number;
    operator?: Operator;
    transformRecords?: (records: Entry[]) => void;
  } = {},
): TrustFixture {
  assert.equal(statuses.length, entries.length);
  const adapterStatuses = options.adapterStatuses ?? entries.map(() => "ACTIVE" as const);
  assert.equal(adapterStatuses.length, entries.length);
  const anchor = JSON.parse(readFileSync(join(frequencySource, "first-100-ledger.jsonl"), "utf8").trim());
  const ledger = `${[anchor, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`;
  const records = entries.map((entry, index) => {
    const publisherStatus = statuses[index]!;
    const adapterStatus = adapterStatuses[index]!;
    const active = publisherStatus === "ACTIVE" && adapterStatus === "ACTIVE";
    const included = entry.eligibility.decision === "INCLUDED";
    return {
      schemaVersion: "agent-vigil-first-100-provenance/v2",
      kind: "publisher-provenance",
      registrationId: anchor.registrationId,
      ingestionSequence: entry.ingestionSequence,
      publisher: {
        keyId: publisherKeyId(entry.ingestionSequence),
        status: publisherStatus,
        statusUpdatedAt: entry.receivedAt,
      },
      frozenEligibility: { decision: entry.eligibility.decision, reason: entry.eligibility.reason },
      effectiveEligibility: active
        ? { decision: entry.eligibility.decision, reason: entry.eligibility.reason, gateEligible: included }
        : {
            decision: "QUARANTINED",
            reason: publisherStatus === "REVOKED" ? "PUBLISHER_REVOKED"
              : publisherStatus === "SUSPENDED" ? "PUBLISHER_SUSPENDED" : "ADAPTER_REVOKED",
            gateEligible: false,
          },
      acquisition: {
        handle: uuid(0x10000000, entry.ingestionSequence),
        rawEventSha256: digest(`raw-acquisition-${entry.ingestionSequence}`),
        trustedAdapter: {
          keyId: adapterKeyId(entry.ingestionSequence),
          version: adapterVersion,
          eventId: uuid(0x20000000, entry.ingestionSequence),
          observedAt: entry.receivedAt,
          status: adapterStatus,
        },
        registeredBeforeArtifactAccess: true,
        artifactAccessGrantedAt: included ? entry.receivedAt : null,
      },
      chronologyMutable: false,
    };
  });
  options.transformRecords?.(records);
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
  const provenance = `${JSON.stringify(provenanceAnchor)}\n${recordBytes}`;
  writeFileSync(join(directory, "first-100-ledger.jsonl"), ledger);
  writeFileSync(join(directory, "first-100-provenance.jsonl"), provenance);

  const operator = options.operator ?? operatorFixture();
  const issuedAt = options.issuedAt ?? new Date(Date.now() - 1_000).toISOString();
  const expiresAt = new Date(Date.parse(issuedAt) + 5 * 60_000).toISOString();
  const checkpointSequence = options.checkpointSequence ?? entries.length;
  const checkpoint = {
    sequence: checkpointSequence,
    eventId: checkpointSequence === 0 ? "GENESIS" : uuid(0x30000000, checkpointSequence),
    eventSha256: digest(canonical({ registrationId, checkpointSequence })),
  };
  const publisherStates = records.map((record) => ({
    keyId: record.publisher.keyId,
    status: record.publisher.status,
    updatedAt: record.publisher.statusUpdatedAt,
  })).sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0);
  const adapterStates = entries.map((entry, index) => ({
    keyId: adapterKeyId(entry.ingestionSequence),
    version: adapterVersion,
    status: adapterStatuses[index]!,
    updatedAt: entry.receivedAt,
  })).sort((left, right) => left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0);
  const descriptors: Entry[] = [];
  let previousChunkSha256: string | null = null;
  for (let offset = 0; offset < entries.length; offset += 100) {
    const rawRows = entries.slice(offset, offset + 100);
    const provenanceRows = records.slice(offset, offset + 100);
    const unsignedDescriptor: Entry = {
      index: descriptors.length,
      cursorAfter: offset === 0 ? 0 : entries[offset - 1]!.ingestionSequence,
      firstSequence: rawRows[0]?.ingestionSequence ?? null,
      lastSequence: rawRows.at(-1)?.ingestionSequence ?? null,
      rowCount: rawRows.length,
      rawRecordsSha256: digest(rawRows.length === 0 ? "" : `${rawRows.map((entry) => JSON.stringify(entry)).join("\n")}\n`),
      provenanceRecordsSha256: digest(provenanceRows.length === 0 ? "" : `${provenanceRows.map((record) => JSON.stringify(record)).join("\n")}\n`),
      previousChunkSha256,
    };
    const descriptor: Entry = { ...unsignedDescriptor, chunkSha256: digest(canonical(unsignedDescriptor)) };
    descriptors.push(descriptor);
    previousChunkSha256 = descriptor.chunkSha256;
  }
  const stopEvents: Entry[] = [];
  const manifestPayload = {
    registrationId,
    registrationSha256,
    issuedAt,
    expiresAt,
    moderationCheckpoint: checkpoint,
    publisherStates,
    adapterStates,
    publisherStateSha256: digest(canonical(publisherStates)),
    adapterStateSha256: digest(canonical(adapterStates)),
    operatorDutySeparated: true,
    rawLedgerSha256: digest(ledger),
    rawLedgerPairEntries: entries.length,
    provenanceSha256: digest(provenance),
    provenanceRecords: records.length,
    chunkRowsMaximum: 100,
    chunks: descriptors,
    chunkRootSha256: previousChunkSha256 ?? digest(canonical([])),
    stopEvents,
    stopEventsSha256: digest(canonical(stopEvents)),
    globalRowCap: 1_000,
    channelRowCap: 500,
    publisherRowCap: 400,
  };
  const manifest = signedDocument("agent-vigil-first-100-export-manifest/v1", manifestPayload, operator);
  const manifestPayloadSha256 = digest(canonical(manifestPayload));
  const headPayload = {
    registrationId,
    registrationSha256,
    issuedAt,
    expiresAt,
    manifestPayloadSha256,
    rawLedgerSha256: manifestPayload.rawLedgerSha256,
    provenanceSha256: manifestPayload.provenanceSha256,
    chunkRootSha256: manifestPayload.chunkRootSha256,
    stopEventsSha256: manifestPayload.stopEventsSha256,
    moderationCheckpoint: checkpoint,
    publisherStateSha256: manifestPayload.publisherStateSha256,
    adapterStateSha256: manifestPayload.adapterStateSha256,
    operatorDutySeparated: true,
  };
  const head = signedDocument("agent-vigil-first-100-trusted-head/v1", headPayload, operator);

  const trustDirectory = mkdtempSync(join(tmpdir(), "agent-vigil-first100-trust-"));
  temporaryFixtures.add(trustDirectory);
  const manifestPath = join(trustDirectory, "manifest.json");
  const headPath = join(trustDirectory, "head.json");
  const publicKeyPath = join(trustDirectory, "operator-public.pem");
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  writeFileSync(headPath, `${JSON.stringify(head)}\n`);
  writeFileSync(publicKeyPath, operator.publicKey.export({ type: "spki", format: "pem" }));
  const chunkPaths = descriptors.map((descriptor, index) => {
    const payload = {
      registrationId,
      issuedAt,
      expiresAt,
      manifestPayloadSha256,
      descriptor,
      entries: entries.slice(index * 100, index * 100 + 100),
      provenance: records.slice(index * 100, index * 100 + 100),
    };
    const path = join(trustDirectory, `chunk-${index.toString().padStart(3, "0")}.json`);
    writeFileSync(path, `${JSON.stringify(signedDocument("agent-vigil-first-100-export-chunk/v1", payload, operator))}\n`);
    return path;
  });
  return { manifestPath, headPath, publicKeyPath, chunkPaths, operator };
}

function validate(
  directory: string,
  trust?: TrustFixture,
  overrides: Partial<Pick<TrustFixture, "manifestPath" | "headPath" | "publicKeyPath" | "chunkPaths">> = {},
): { status: number | null; stdout: string; stderr: string } {
  const args = [join(directory, "validate-first-100.mjs")];
  if (trust) {
    const effective = { ...trust, ...overrides };
    args.push("--manifest", effective.manifestPath, "--trusted-head", effective.headPath, "--operator-public-key", effective.publicKeyPath);
    for (const chunkPath of effective.chunkPaths) args.push("--chunk", chunkPath);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: directory,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertSubset(actual: Record<string, unknown>, expected: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
}

test("the published first-100 frame is signed, frozen before R0, and empty", () => {
  const output = execFileSync(process.execPath, ["proof/first-100/verify.mjs"], {
    cwd: repository,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.deepEqual(JSON.parse(output), {
    registrationId,
    registrationSha256,
    pairEntries: 0,
    provenanceBound: true,
    verified: true,
  });
});

test("zero state remains insufficient and cannot claim a trusted gate", () => {
  const result = validate(frequencySource);
  assert.equal(result.status, 0, result.stderr);
  assertSubset(JSON.parse(result.stdout), {
    pairEntries: 0,
    frequencyVerdict: "INSUFFICIENT_DISTRIBUTION_VOLUME",
    gateAuthorized: false,
    trustVerdict: "TRUSTED_HEAD_REQUIRED",
  });
});

test("a nonzero static corpus cannot pass without an independently supplied trusted head", () => {
  const directory = fixture();
  writeBundle(directory, completeEntries());
  const result = validate(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trusted.*head|required.*trust/i);
});

test("a fresh, signed, current ACTIVE export passes only with exact chunks", () => {
  const directory = fixture();
  const trust = writeBundle(directory, completeEntries());
  const result = validate(directory, trust);
  assert.equal(result.status, 0, result.stderr);
  assertSubset(JSON.parse(result.stdout), {
    included: 100,
    evaluated: 100,
    conclusive: 100,
    material: 3,
    falseCompatible: 0,
    frequencyVerdict: "FREQUENCY_GATE_PASS",
    gateAuthorized: true,
    trustVerdict: "TRUSTED_CURRENT_HEAD",
  });
});

test("complete signed exports still fail closed for incomplete and contradictory outcomes", () => {
  const incompleteDirectory = fixture();
  const incomplete = completeEntries();
  for (const entry of incomplete.slice(3)) delete entry.evaluation;
  const incompleteTrust = writeBundle(incompleteDirectory, incomplete);
  const incompleteResult = validate(incompleteDirectory, incompleteTrust);
  assert.equal(incompleteResult.status, 0, incompleteResult.stderr);
  assert.equal(JSON.parse(incompleteResult.stdout).frequencyVerdict, "INCOMPLETE_EVALUATIONS");

  const contradictionDirectory = fixture();
  const contradiction = completeEntries();
  contradiction[0]!.evaluation.verdict = "SAFE";
  contradiction[0]!.evaluation.falseCompatible = false;
  const contradictionTrust = writeBundle(contradictionDirectory, contradiction);
  const contradictionResult = validate(contradictionDirectory, contradictionTrust);
  assert.notEqual(contradictionResult.status, 0);
  assert.match(contradictionResult.stderr, /false-compatible coherence/);

  const falseCompatibleDirectory = fixture();
  const falseCompatible = completeEntries();
  falseCompatible[0]!.evaluation.verdict = "SAFE";
  falseCompatible[0]!.evaluation.falseCompatible = true;
  const falseCompatibleTrust = writeBundle(falseCompatibleDirectory, falseCompatible);
  const falseCompatibleResult = validate(falseCompatibleDirectory, falseCompatibleTrust);
  assert.equal(falseCompatibleResult.status, 0, falseCompatibleResult.stderr);
  assertSubset(JSON.parse(falseCompatibleResult.stdout), {
    falseCompatible: 1,
    frequencyVerdict: "FREQUENCY_GATE_FAIL",
    gateAuthorized: true,
  });
});

test("post-inspection decisions and rows after the 100th inclusion remain invalid even when signed", () => {
  const postInspectionDirectory = fixture();
  const postInspection = completeEntries();
  postInspection[0]!.inspectionStarted = true;
  const postInspectionTrust = writeBundle(postInspectionDirectory, postInspection);
  const postInspectionResult = validate(postInspectionDirectory, postInspectionTrust);
  assert.notEqual(postInspectionResult.status, 0);
  assert.match(postInspectionResult.stderr, /precede inspection|inspectionStarted/i);

  const postCloseDirectory = fixture();
  const postClose = completeEntries();
  const extra: Entry = {
    ...postClose.at(-1),
    ingestionSequence: 101,
    receivedAt: "2026-08-24T00:00:00.101Z",
    eligibility: { decision: "EXCLUDED", decidedAt: "2026-08-24T00:00:00.101Z", reason: "DUPLICATE_PAIR" },
    pair: { ...postClose.at(-1)!.pair, candidateExactIdentity: `sha256:${"e".repeat(64)}` },
  };
  delete extra.evaluation;
  postClose.push(extra);
  const postCloseTrust = writeBundle(postCloseDirectory, postClose);
  const postCloseResult = validate(postCloseDirectory, postCloseTrust);
  assert.notEqual(postCloseResult.status, 0);
  assert.match(postCloseResult.stderr, /after the frozen sample closed|sample closed/i);
});

test("signed publisher and adapter authority state quarantines revoked rows", () => {
  const directory = fixture();
  const statuses: PrincipalStatus[] = completeEntries().map(() => "ACTIVE");
  statuses[0] = "REVOKED";
  statuses[1] = "SUSPENDED";
  const trust = writeBundle(directory, completeEntries(), statuses, { checkpointSequence: 102 });
  const result = validate(directory, trust);
  assert.equal(result.status, 0, result.stderr);
  assertSubset(JSON.parse(result.stdout), {
    frozenIncluded: 100,
    included: 98,
    quarantined: 2,
    frequencyVerdict: "INSUFFICIENT_DISTRIBUTION_VOLUME",
  });

  const adapterDirectory = fixture();
  const adapterStatuses: Array<"ACTIVE" | "REVOKED"> = completeEntries().map(() => "ACTIVE");
  adapterStatuses[0] = "REVOKED";
  const adapterTrust = writeBundle(adapterDirectory, completeEntries(), undefined, { adapterStatuses, checkpointSequence: 101 });
  const adapterResult = validate(adapterDirectory, adapterTrust);
  assert.equal(adapterResult.status, 0, adapterResult.stderr);
  assertSubset(JSON.parse(adapterResult.stdout), {
    included: 99,
    quarantined: 1,
    frequencyVerdict: "INSUFFICIENT_DISTRIBUTION_VOLUME",
  });
});

test("an old ACTIVE envelope is rejected against a newer REVOKED trusted head", () => {
  const operator = operatorFixture();
  const activeDirectory = fixture();
  const activeTrust = writeBundle(activeDirectory, completeEntries(), undefined, { operator, checkpointSequence: 100 });
  const revokedDirectory = fixture();
  const revokedStatuses: PrincipalStatus[] = completeEntries().map(() => "ACTIVE");
  revokedStatuses[0] = "REVOKED";
  const revokedTrust = writeBundle(revokedDirectory, completeEntries(), revokedStatuses, { operator, checkpointSequence: 101 });
  const result = validate(activeDirectory, activeTrust, { headPath: revokedTrust.headPath });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest|checkpoint|provenance|state/i);
});

test("wrong-key, future, expired, and rollback combinations are rejected", () => {
  const wrongKeyDirectory = fixture();
  const wrongKeyTrust = writeBundle(wrongKeyDirectory, completeEntries());
  const wrongKey = operatorFixture();
  const wrongKeyDirectoryPath = mkdtempSync(join(tmpdir(), "agent-vigil-wrong-key-"));
  temporaryFixtures.add(wrongKeyDirectoryPath);
  const wrongKeyPath = join(wrongKeyDirectoryPath, "wrong.pem");
  writeFileSync(wrongKeyPath, wrongKey.publicKey.export({ type: "spki", format: "pem" }));
  const wrongResult = validate(wrongKeyDirectory, wrongKeyTrust, { publicKeyPath: wrongKeyPath });
  assert.notEqual(wrongResult.status, 0);
  assert.match(wrongResult.stderr, /key|signature/i);

  const futureDirectory = fixture();
  const futureTrust = writeBundle(futureDirectory, completeEntries(), undefined, {
    issuedAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const futureResult = validate(futureDirectory, futureTrust);
  assert.notEqual(futureResult.status, 0);
  assert.match(futureResult.stderr, /future|issued/i);

  const expiredDirectory = fixture();
  const expiredTrust = writeBundle(expiredDirectory, completeEntries(), undefined, {
    issuedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  });
  const expiredResult = validate(expiredDirectory, expiredTrust);
  assert.notEqual(expiredResult.status, 0);
  assert.match(expiredResult.stderr, /expired|expiry/i);

  const operator = operatorFixture();
  const currentDirectory = fixture();
  const current = writeBundle(currentDirectory, completeEntries(), undefined, { operator, checkpointSequence: 101 });
  const rollbackDirectory = fixture();
  const rollback = writeBundle(rollbackDirectory, completeEntries(), undefined, { operator, checkpointSequence: 100 });
  const rollbackResult = validate(currentDirectory, current, { headPath: rollback.headPath });
  assert.notEqual(rollbackResult.status, 0);
  assert.match(rollbackResult.stderr, /manifest|checkpoint|rollback/i);
});

test("chunk omission, duplication, reordering, and tampering are rejected", () => {
  const omittedDirectory = fixture();
  const omittedTrust = writeBundle(omittedDirectory, completeEntriesWithLeadingExclusion());
  const omitted = validate(omittedDirectory, omittedTrust, { chunkPaths: [omittedTrust.chunkPaths[0]!] });
  assert.notEqual(omitted.status, 0);
  assert.match(omitted.stderr, /chunk/i);

  const duplicateDirectory = fixture();
  const duplicateTrust = writeBundle(duplicateDirectory, completeEntriesWithLeadingExclusion());
  const duplicate = validate(duplicateDirectory, duplicateTrust, {
    chunkPaths: [duplicateTrust.chunkPaths[0]!, duplicateTrust.chunkPaths[0]!, duplicateTrust.chunkPaths[1]!],
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /chunk|duplicate/i);

  const reorderedDirectory = fixture();
  const reorderedTrust = writeBundle(reorderedDirectory, completeEntriesWithLeadingExclusion());
  const reorderedPaths = validate(reorderedDirectory, reorderedTrust, {
    chunkPaths: [...reorderedTrust.chunkPaths].reverse(),
  });
  assert.notEqual(reorderedPaths.status, 0);
  assert.match(reorderedPaths.stderr, /chunk|order|index/i);
  const reorderedChunk = JSON.parse(readFileSync(reorderedTrust.chunkPaths[0]!, "utf8"));
  reorderedChunk.payload.entries.reverse();
  writeFileSync(
    reorderedTrust.chunkPaths[0]!,
    `${JSON.stringify(signedDocument(reorderedChunk.schemaVersion, reorderedChunk.payload, reorderedTrust.operator))}\n`,
  );
  const reordered = validate(reorderedDirectory, reorderedTrust);
  assert.notEqual(reordered.status, 0);
  assert.match(reordered.stderr, /chunk|order|record/i);

  const tamperedDirectory = fixture();
  const tamperedTrust = writeBundle(tamperedDirectory, completeEntriesWithLeadingExclusion());
  const tamperedChunk = JSON.parse(readFileSync(tamperedTrust.chunkPaths[0]!, "utf8"));
  tamperedChunk.payload.entries[0].pair.componentIdentity = "tampered-component";
  writeFileSync(tamperedTrust.chunkPaths[0]!, `${JSON.stringify(tamperedChunk)}\n`);
  const tampered = validate(tamperedDirectory, tamperedTrust);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /signature|chunk|tamper/i);
});

test("even an operator-signed INCLUDED row is rejected without a trusted pre-inspection adapter fact", () => {
  const directory = fixture();
  const trust = writeBundle(directory, completeEntries(), undefined, {
    transformRecords(records) {
      records[0]!.acquisition.trustedAdapter = null;
    },
  });
  const result = validate(directory, trust);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /adapter|acquisition|untrusted/i);
});

test("the first-100 component cap remains one lowercase global identity across ecosystems", () => {
  const directory = fixture();
  const entries = completeEntries();
  for (const [index, entry] of entries.slice(0, 21).entries()) {
    entry.pair.componentIdentity = "global-component";
    entry.pair.ecosystem = index % 2 === 0 ? "apm" : "skills";
  }
  const trust = writeBundle(directory, entries);
  const result = validate(directory, trust);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /global component cap/);
});
