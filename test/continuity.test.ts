import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendContinuityEvent,
  chainExists,
  chainName,
  continuitySubjectTemplate,
  computeEventHash,
  createStoredEvent,
  initializeContinuityChain,
  verifyContinuityChain,
  type ChainVerification,
} from "../src/continuity/chain.ts";
import {
  canonicalSha256,
  readBoundedRegularFile,
  sha256,
  validateContinuityPolicy,
  validateEventDraft,
  type ContinuityEventDraft,
  type ContinuityEventKind,
  type ContinuityPolicy,
  type ContinuityRoot,
  type LoadedContinuityPolicy,
} from "../src/continuity/contracts.ts";
import { evaluateContinuity } from "../src/continuity/decision.ts";
import { publicChainVerification } from "../src/continuity/presentation.ts";
import { buildReport, recomputeReceiptHash, type CheckResult, type TrustReport } from "../src/report.ts";
import { generateSigningKey, publicKeyId, signReport } from "../src/signature.ts";

const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "3".repeat(40);
const NOW = new Date("2026-08-23T12:30:00.000Z");
let eventSequence = 1;

function digest(seed: string): string {
  return sha256(seed);
}

function report(root: string, signed = false): { path: string; report: TrustReport; privateKey?: string; publicKey?: string } {
  const result: CheckResult = {
    claim: { kind: "tests_pass", quote: "one verified fixture", subject: "fixture" },
    verdict: "verified",
    evidence: "one deterministic fixture passed",
  };
  let value = buildReport({
    transcript: "private/session.jsonl",
    transcriptSha256: digest("private transcript"),
    transcriptFormat: "codex",
    repo: "/private/customer/repository",
    base: BASE,
    head: HEAD,
    results: [result],
    policy: { minVerified: 1, strict: true, source: ".agent-vigil.json", sha256: digest("receipt policy") },
    repository: { remote: "git@example.invalid:private/customer-repository.git", tree: TREE },
    reproduction: "secret command --token must-not-leak",
  });
  let privateKey: string | undefined;
  let publicKey: string | undefined;
  if (signed) {
    privateKey = join(root, "root-private.pem");
    publicKey = join(root, "root-public.pem");
    generateSigningKey(privateKey, publicKey);
    value = signReport(value, privateKey);
  }
  const path = join(root, "receipt.json");
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return { path, report: value, ...(privateKey ? { privateKey } : {}), ...(publicKey ? { publicKey } : {}) };
}

function fixture(signedRoot = false): { root: string; chain: string; continuityRoot: ContinuityRoot; receipt: ReturnType<typeof report> } {
  const root = mkdtempSync(join(tmpdir(), "vigil-continuity-"));
  const receipt = report(root, signedRoot);
  const chain = join(root, "chain");
  const continuityRoot = initializeContinuityChain(receipt.path, chain, new Date("2026-08-23T12:00:00.000Z"));
  return { root, chain, continuityRoot, receipt };
}

function event(
  root: ContinuityRoot,
  kind: ContinuityEventKind,
  sourceKind: string,
  at: string,
  options: Partial<ContinuityEventDraft["event"]> & {
    disposition?: ContinuityEventDraft["event"]["disposition"];
    issuer?: string;
    deliveryIdHash?: string | null;
    evidenceHash?: string;
  } = {},
): ContinuityEventDraft {
  const id = String(eventSequence++).padStart(12, "0");
  return {
    schemaVersion: "agent-vigil-continuity-event/v1",
    eventId: `urn:uuid:00000000-0000-4000-8000-${id}`,
    subject: { ...root.subject },
    source: {
      kind: sourceKind,
      issuer: options.issuer ?? digest(`issuer-${id}`),
      evidenceHash: options.evidenceHash ?? digest(`evidence-${id}`),
      deliveryIdHash: options.deliveryIdHash ?? null,
    },
    event: {
      kind,
      disposition: options.disposition ?? "affirm",
      reasonCode: options.reasonCode ?? `${kind}.fixture`,
      targetHash: options.targetHash === undefined ? digest(`target-${id}`) : options.targetHash,
      freshUntil: options.freshUntil === undefined ? "2026-08-23T13:30:00.000Z" : options.freshUntil,
      supersedesEventId: options.supersedesEventId ?? null,
    },
    observedAt: at,
    effectiveAt: at,
    privacyTier: "receipt",
  };
}

function policy(overrides: Partial<ContinuityPolicy> = {}): LoadedContinuityPolicy {
  const value = validateContinuityPolicy({
    schemaVersion: "agent-vigil-continuity-policy/v1",
    requiredSources: ["verification", "github-outcome"],
    maxAgeSeconds: { verification: 3600, "github-outcome": 3600 },
    denyOn: ["revert_observed", "incident_linked", "attestation_invalid", "credential_revoked"],
    allowRemediation: true,
    requireSignedRoot: false,
    requireSignedEvents: false,
    trustedRootKeyIds: [],
    trustedIssuerKeyIds: [],
    protectedEnvironments: ["production"],
    maxClockSkewSeconds: 300,
    ...overrides,
  });
  return { value, source: "/private/policy/path.json", sha256: canonicalSha256(value) };
}

function appendCurrentEvidence(value: ReturnType<typeof fixture>): void {
  appendContinuityEvent(value.chain, event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z"));
  appendContinuityEvent(value.chain, event(value.continuityRoot, "merge_observed", "github-outcome", "2026-08-23T12:01:00.000Z", { deliveryIdHash: digest("delivery-current") }));
}

function verification(value: ReturnType<typeof fixture>, now = NOW): ChainVerification {
  return verifyContinuityChain(value.chain, { now, maxClockSkewSeconds: 300 });
}

test("bounded regular-file snapshots preserve exact bytes and reject symbolic links", (context) => {
  const root = mkdtempSync(join(tmpdir(), "vigil-bounded-read-"));
  const source = join(root, "source.txt");
  const linked = join(root, "linked.txt");
  const expected = Buffer.from("bounded evidence\n");
  writeFileSync(source, expected);
  assert.deepEqual(readBoundedRegularFile(source, expected.length, "evidence"), expected);
  try { symlinkSync(source, linked); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "EACCES", "UNKNOWN"].includes(code ?? "")) {
      context.skip(`host does not permit symlinks (${code})`);
      return;
    }
    throw error;
  }
  assert.throws(() => readBoundedRegularFile(linked, 1024, "evidence"), /regular file, not a symbolic link/);
});

test("bounded regular-file snapshots reject named pipes without blocking", (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX named pipes are unavailable on Windows");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "vigil-bounded-fifo-"));
  const fifo = join(root, "evidence.fifo");
  execFileSync("mkfifo", [fifo]);
  assert.throws(() => readBoundedRegularFile(fifo, 1024, "evidence"), /regular file, not a symbolic link/);
});

test("bounded regular-file implementation binds the fixed-size read and final path snapshot", () => {
  const source = readFileSync(new URL("../src/continuity/contracts.ts", import.meta.url), "utf8");
  const implementation = source.match(/export function readBoundedRegularFile[\s\S]*?(?=\nexport function readBoundedJson)/)?.[0];
  assert.ok(implementation);
  assert.match(implementation, /O_RDONLY \| noFollow \| nonBlock/);
  assert.match(implementation, /Buffer\.alloc\(Number\(opened\.size\)\)/);
  assert.match(implementation, /readSync\(descriptor, bytes,/);
  assert.match(implementation, /opened\.mtimeNs !== expected\.mtimeNs \|\| opened\.ctimeNs !== expected\.ctimeNs/);
  assert.match(implementation, /finalPath\.dev !== opened\.dev \|\| finalPath\.ino !== opened\.ino/);
});

test("initializes an owner-only chain without changing original receipt bytes or verdict", () => {
  const value = fixture();
  assert.deepEqual(readFileSync(join(value.chain, "receipt.json")), readFileSync(value.receipt.path));
  const verified = verification(value);
  assert.equal(verified.valid, true);
  assert.equal(verified.root.historicalVerification, "PASS");
  assert.equal(verified.events.length, 0);
  assert.equal(verified.chainTip, verified.root.rootHash);
  assert.equal(verified.report.summary.status, "PASS");
  if (process.platform !== "win32") {
    assert.equal(lstatSync(value.chain).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(value.chain, "events")).mode & 0o777, 0o700);
    for (const file of ["receipt.json", "root.json", "tip.json"]) {
      assert.equal(lstatSync(join(value.chain, file)).mode & 0o777, 0o600);
    }
  }
  assert.equal(chainExists(value.chain), true);
  assert.equal(chainName(value.chain), "chain");
  assert.deepEqual(continuitySubjectTemplate(value.continuityRoot), value.continuityRoot.subject);
});

test("initialization rejects malformed, incomplete, and internally inconsistent receipts", () => {
  const cases: Array<[string | ((value: TrustReport) => unknown), RegExp]> = [
    ["{", /not valid JSON/],
    [() => [], /must be an object/],
    [(value) => ({ ...value, schemaVersion: "3" }), /schema.*version 2/],
    [(value) => ({ ...value, summary: { ...value.summary, status: "MAYBE" } }), /summary\.status.*unsupported/],
    [(value) => ({ ...value, results: null }), /receipt results must be an array/],
    [(value) => ({ ...value, base: "main" }), /full base and head/],
    [(value) => ({ ...value, head: "HEAD" }), /full base and head/],
    [(value) => ({ ...value, repository: { ...value.repository, tree: "tree" } }), /repository\.tree.*full lowercase Git object ID|committed head tree/],
    [(value) => ({ ...value, receiptHash: digest("wrong") }), /receipt hash is invalid/],
    [(value) => {
      const changed = structuredClone(value);
      changed.summary.verified += 1;
      assert.throws(() => recomputeReceiptHash(changed), /summary\.verified does not match/);
      return changed;
    }, /summary\.verified does not match/],
  ];
  for (const [mutation, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), "vigil-continuity-bad-receipt-"));
    const receiptValue = report(root);
    writeFileSync(receiptValue.path, typeof mutation === "string" ? mutation : JSON.stringify(mutation(receiptValue.report)));
    assert.throws(() => initializeContinuityChain(receiptValue.path, join(root, "chain")), pattern);
  }
});

test("chain storage rejects missing paths, wrong entry types, unsupported files, and malformed tips", (context) => {
  const missing = join(mkdtempSync(join(tmpdir(), "vigil-continuity-missing-")), "missing");
  assert.throws(() => verifyContinuityChain(missing), /missing or unreadable/);

  const regularRoot = mkdtempSync(join(tmpdir(), "vigil-continuity-file-"));
  const regular = join(regularRoot, "chain");
  writeFileSync(regular, "not a directory");
  assert.throws(() => verifyContinuityChain(regular), /regular directory/);

  const extra = fixture();
  writeFileSync(join(extra.chain, "extra.txt"), "unexpected");
  assert.throws(() => verification(extra), /unsupported or missing entries/);

  const wrongEvents = fixture();
  renameSync(join(wrongEvents.chain, "events"), join(wrongEvents.chain, "events-old"));
  writeFileSync(join(wrongEvents.chain, "events"), "not a directory");
  rmSync(join(wrongEvents.chain, "events-old"), { recursive: true });
  assert.throws(() => verification(wrongEvents), /events must be stored in a regular directory/);

  const unsupportedEvent = fixture();
  writeFileSync(join(unsupportedEvent.chain, "events", "notes.txt"), "unexpected");
  assert.throws(() => verification(unsupportedEvent), /events directory contains an unsupported entry/);

  const tips: Array<[unknown, RegExp]> = [
    [null, /tip must be an object/],
    [{}, /tip has unsupported or missing fields/],
    [{ schemaVersion: "future", sequence: 0, eventHash: digest("tip"), updatedAt: NOW.toISOString() }, /unsupported continuity tip schema/],
    [{ schemaVersion: "agent-vigil-continuity-tip/v1", sequence: -1, eventHash: digest("tip"), updatedAt: NOW.toISOString() }, /tip sequence is invalid/],
    [{ schemaVersion: "agent-vigil-continuity-tip/v1", sequence: 0, eventHash: "bad", updatedAt: NOW.toISOString() }, /tip hash is invalid/],
    [{ schemaVersion: "agent-vigil-continuity-tip/v1", sequence: 0, eventHash: digest("tip"), updatedAt: "2026-08-23" }, /tip timestamp is invalid/],
  ];
  for (const [tip, pattern] of tips) {
    const value = fixture();
    writeFileSync(join(value.chain, "tip.json"), JSON.stringify(tip));
    assert.throws(() => verification(value), pattern);
  }

  const linkRoot = mkdtempSync(join(tmpdir(), "vigil-continuity-read-link-"));
  const target = fixture().chain;
  const link = join(linkRoot, "chain");
  try { symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "EACCES", "UNKNOWN"].includes(code ?? "")) { context.skip(`host does not permit symlinks (${code})`); return; }
    throw error;
  }
  assert.throws(() => verifyContinuityChain(link), /regular directory, not a symbolic link/);
});

test("folds independently to HOLD, CURRENT, EXPIRED, and REVOKED", () => {
  const held = fixture();
  let decision = evaluateContinuity(verification(held), policy(), { now: NOW, environment: "production" });
  assert.equal(decision.continuity, "HOLD");
  assert.equal(decision.allowsProtectedAction, false);

  appendCurrentEvidence(held);
  decision = evaluateContinuity(verification(held), policy(), { now: NOW, environment: "production" });
  assert.equal(decision.continuity, "CURRENT");
  assert.equal(decision.allowsProtectedAction, true);
  assert.equal(decision.historicalVerification, "PASS");

  const expired = evaluateContinuity(verification(held, new Date("2026-08-23T15:00:00.000Z")), policy(), {
    now: new Date("2026-08-23T15:00:00.000Z"), environment: "production",
  });
  assert.equal(expired.continuity, "EXPIRED");
  assert.equal(expired.allowsProtectedAction, false);

  appendContinuityEvent(held.chain, event(held.continuityRoot, "attestation_invalid", "verification", "2026-08-23T12:02:00.000Z", { disposition: "revoke" }));
  decision = evaluateContinuity(verification(held), policy(), { now: NOW, environment: "production" });
  assert.equal(decision.continuity, "REVOKED");
  assert.equal(decision.allowsProtectedAction, false);
});

test("changed original receipt bytes invalidate the root even when JSON meaning is unchanged", () => {
  const value = fixture();
  writeFileSync(join(value.chain, "receipt.json"), `${readFileSync(join(value.chain, "receipt.json"), "utf8")}\n`);
  const verified = verification(value);
  assert.equal(verified.valid, false);
  assert.match(verified.errors.join("\n"), /receipt bytes/);
});

test("wrong repository or head subject is refused before append", () => {
  const value = fixture();
  const wrongHead = event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z");
  wrongHead.subject.headSha = "4".repeat(40);
  assert.throws(() => appendContinuityEvent(value.chain, wrongHead), /subject does not match/);
  const wrongRepository = event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z");
  wrongRepository.subject.repositoryHash = digest("other repository");
  assert.throws(() => appendContinuityEvent(value.chain, wrongRepository), /subject does not match/);
});

test("verification binds expected commits and refuses an unverifiable repository range", () => {
  const value = fixture();
  assert.throws(() => verifyContinuityChain(value.chain, { expectedBase: "main" }), /expected base must be a full lowercase/);
  assert.throws(() => verifyContinuityChain(value.chain, { expectedHead: "HEAD" }), /expected head must be a full lowercase/);
  const mismatched = verifyContinuityChain(value.chain, {
    expectedBase: "a".repeat(40),
    expectedHead: "b".repeat(40),
    repo: value.root,
  });
  assert.equal(mismatched.valid, false);
  assert.match(mismatched.errors.join("\n"), /policy base commit/);
  assert.match(mismatched.errors.join("\n"), /expected deployment commit/);
  assert.match(mismatched.errors.join("\n"), /not a verifiable ancestor range/);
});

test("deleted middle or tail events and reordered event files invalidate the chain", () => {
  const deleted = fixture();
  appendCurrentEvidence(deleted);
  rmSync(join(deleted.chain, "events", "00000001.json"));
  assert.equal(verification(deleted).valid, false);

  const truncated = fixture();
  appendCurrentEvidence(truncated);
  rmSync(join(truncated.chain, "events", "00000002.json"));
  const truncatedResult = verification(truncated);
  assert.equal(truncatedResult.valid, false);
  assert.match(truncatedResult.errors.join("\n"), /tip/);

  const reordered = fixture();
  appendCurrentEvidence(reordered);
  const first = readFileSync(join(reordered.chain, "events", "00000001.json"));
  const second = readFileSync(join(reordered.chain, "events", "00000002.json"));
  writeFileSync(join(reordered.chain, "events", "00000001.json"), second);
  writeFileSync(join(reordered.chain, "events", "00000002.json"), first);
  const result = verification(reordered);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /sequence|prior chain tip/);
});

test("duplicate sequence and forked predecessor remain invalid after attacker recomputes content hashes", () => {
  const duplicate = fixture();
  appendCurrentEvidence(duplicate);
  const secondPath = join(duplicate.chain, "events", "00000002.json");
  const second = JSON.parse(readFileSync(secondPath, "utf8"));
  second.sequence = 1;
  second.eventHash = computeEventHash(second);
  writeFileSync(secondPath, `${JSON.stringify(second, null, 2)}\n`);
  assert.match(verification(duplicate).errors.join("\n"), /sequence number/);

  const fork = fixture();
  appendCurrentEvidence(fork);
  const forkPath = join(fork.chain, "events", "00000002.json");
  const forked = JSON.parse(readFileSync(forkPath, "utf8"));
  forked.predecessorHash = fork.continuityRoot.rootHash;
  forked.eventHash = computeEventHash(forked);
  writeFileSync(forkPath, `${JSON.stringify(forked, null, 2)}\n`);
  assert.match(verification(fork).errors.join("\n"), /prior chain tip/);
});

test("verification detects duplicated identities, wrong subjects, invalid hashes, and impossible event times", () => {
  const mutations: Array<[((stored: any, first?: any) => void), RegExp, boolean]> = [
    [(stored) => { stored.subject.headSha = "4".repeat(40); stored.eventHash = computeEventHash(stored); }, /different receipt subject/, false],
    [(stored) => { stored.eventHash = digest("tampered"); }, /content hash is invalid/, false],
    [(stored, first) => { stored.eventId = first.eventId; stored.eventHash = computeEventHash(stored); }, /reuses an earlier event ID/, true],
    [(stored) => { stored.observedAt = "2026-08-23T11:59:00.000Z"; stored.eventHash = computeEventHash(stored); }, /observed before it became effective/, false],
    [(stored) => { stored.observedAt = "2099-01-01T00:00:00.000Z"; stored.effectiveAt = stored.observedAt; stored.eventHash = computeEventHash(stored); }, /implausible future timestamp/, false],
    [(stored) => { stored.event.freshUntil = stored.effectiveAt; stored.eventHash = computeEventHash(stored); }, /freshness boundary/, false],
  ];
  for (const [mutate, pattern, needsTwo] of mutations) {
    const value = fixture();
    appendContinuityEvent(value.chain, event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z"));
    if (needsTwo) appendContinuityEvent(value.chain, event(value.continuityRoot, "merge_observed", "github-outcome", "2026-08-23T12:01:00.000Z"));
    const first = JSON.parse(readFileSync(join(value.chain, "events", "00000001.json"), "utf8"));
    const targetPath = join(value.chain, "events", needsTwo ? "00000002.json" : "00000001.json");
    const stored = JSON.parse(readFileSync(targetPath, "utf8"));
    mutate(stored, first);
    writeFileSync(targetPath, `${JSON.stringify(stored, null, 2)}\n`);
    assert.match(verification(value).errors.join("\n"), pattern);
  }
});

test("invalid and untrusted Ed25519 signatures fail closed", () => {
  const value = fixture();
  const privateKey = join(value.root, "event-private.pem");
  const publicKey = join(value.root, "event-public.pem");
  generateSigningKey(privateKey, publicKey);
  const signedDraft = event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z", { issuer: publicKeyId(publicKey) });
  const stored = appendContinuityEvent(value.chain, signedDraft, privateKey);
  assert.equal(verification(value).valid, true);
  const untrusted = evaluateContinuity(verification(value), policy({ requiredSources: ["verification"], maxAgeSeconds: { verification: 3600 } }), { now: NOW });
  assert.equal(untrusted.continuity, "REVOKED");

  const eventPath = join(value.chain, "events", "00000001.json");
  const tampered = JSON.parse(readFileSync(eventPath, "utf8"));
  tampered.signature.value = Buffer.alloc(64, 7).toString("base64");
  writeFileSync(eventPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.match(verification(value).errors.join("\n"), /signature is invalid/);
  assert.equal(stored.source.issuer, stored.signature?.keyId);

  const unsigned = fixture();
  appendContinuityEvent(unsigned.chain, event(unsigned.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z"));
  assert.match(verifyContinuityChain(unsigned.chain, { pinnedEventKeyIds: [publicKeyId(publicKey)] }).errors.join("\n"), /unsigned/);

  const mismatched = fixture();
  const mismatchedDraft = event(mismatched.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z");
  assert.throws(() => appendContinuityEvent(mismatched.chain, mismatchedDraft, privateKey), /issuer must match/);
  assert.equal(verification(mismatched).events.length, 0);

  const otherKey = join(value.root, "other-public.pem");
  generateSigningKey(join(value.root, "other-private.pem"), otherKey);
  assert.match(verifyContinuityChain(value.chain, { pinnedEventKeyIds: [publicKeyId(otherKey)] }).errors.join("\n"), /signer does not match the pinned public key/);
});

test("event creation rejects duplicate IDs, impossible timing, stale evidence, and non-Ed25519 signing keys", () => {
  const value = fixture();
  const firstDraft = event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z");
  const first = createStoredEvent(firstDraft, value.continuityRoot, [], undefined, NOW);
  assert.throws(() => createStoredEvent(firstDraft, value.continuityRoot, [first], undefined, NOW), /event ID was already used/);

  const observedEarly = event(value.continuityRoot, "merge_observed", "github-outcome", "2026-08-23T12:01:00.000Z");
  observedEarly.effectiveAt = "2026-08-23T12:02:00.000Z";
  assert.throws(() => createStoredEvent(observedEarly, value.continuityRoot, [], undefined, NOW), /cannot be observed before/);

  const stale = event(value.continuityRoot, "merge_observed", "github-outcome", "2026-08-23T12:01:00.000Z", { freshUntil: "2026-08-23T12:01:00.000Z" });
  assert.throws(() => createStoredEvent(stale, value.continuityRoot, [], undefined, NOW), /freshness must extend/);

  const rsaPath = join(value.root, "rsa-private.pem");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(rsaPath, rsa.privateKey.export({ type: "pkcs8", format: "pem" }));
  assert.throws(() => createStoredEvent(
    event(value.continuityRoot, "merge_observed", "github-outcome", "2026-08-23T12:01:00.000Z"),
    value.continuityRoot,
    [],
    rsaPath,
    NOW,
  ), /signing key must be Ed25519/);
});

test("signed root and event become CURRENT only when policy pins both keys", () => {
  const value = fixture(true);
  const eventPrivate = join(value.root, "event-private.pem");
  const eventPublic = join(value.root, "event-public.pem");
  generateSigningKey(eventPrivate, eventPublic);
  appendContinuityEvent(value.chain, event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z", { issuer: publicKeyId(eventPublic) }), eventPrivate);
  const selected = policy({
    requiredSources: ["verification"],
    maxAgeSeconds: { verification: 3600 },
    requireSignedRoot: true,
    requireSignedEvents: true,
    trustedRootKeyIds: [publicKeyId(value.receipt.publicKey!)],
    trustedIssuerKeyIds: [publicKeyId(eventPublic)],
  });
  assert.equal(evaluateContinuity(verification(value), selected, { now: NOW }).continuity, "CURRENT");
});

test("replayed delivery IDs are refused and detected after storage tampering", () => {
  const value = fixture();
  const delivery = digest("delivery replay");
  appendContinuityEvent(value.chain, event(value.continuityRoot, "merge_observed", "github-outcome", "2026-08-23T12:00:00.000Z", { deliveryIdHash: delivery }));
  assert.throws(
    () => appendContinuityEvent(value.chain, event(value.continuityRoot, "deployment_observed", "github-outcome", "2026-08-23T12:01:00.000Z", { deliveryIdHash: delivery })),
    /delivery ID was already recorded/,
  );
  appendContinuityEvent(value.chain, event(value.continuityRoot, "deployment_observed", "github-outcome", "2026-08-23T12:01:00.000Z", { deliveryIdHash: digest("other delivery") }));
  const eventPath = join(value.chain, "events", "00000002.json");
  const tampered = JSON.parse(readFileSync(eventPath, "utf8"));
  tampered.source.deliveryIdHash = delivery;
  tampered.eventHash = computeEventHash(tampered);
  writeFileSync(eventPath, `${JSON.stringify(tampered, null, 2)}\n`);
  assert.match(verification(value).errors.join("\n"), /replays an earlier delivery ID/);
});

test("clock rollback and implausible future timestamps are refused", () => {
  const value = fixture();
  appendContinuityEvent(value.chain, event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:01:00.000Z"));
  assert.throws(
    () => appendContinuityEvent(value.chain, event(value.continuityRoot, "merge_observed", "github-outcome", "2026-08-23T12:00:00.000Z")),
    /rolls the chain clock backward/,
  );
  assert.throws(
    () => appendContinuityEvent(value.chain, event(value.continuityRoot, "merge_observed", "github-outcome", "2099-01-01T00:00:00.000Z")),
    /implausible future timestamp/,
  );
});

test("unsupported critical event kinds and extra fields are rejected", () => {
  const value = fixture();
  const draft = event(value.continuityRoot, "merge_observed", "github-outcome", "2026-08-23T12:00:00.000Z") as unknown as Record<string, unknown>;
  (draft.event as Record<string, unknown>).kind = "erase_history";
  assert.throws(() => validateEventDraft(draft), /event.kind is unsupported/);
  (draft.event as Record<string, unknown>).kind = "merge_observed";
  draft.prompt = "steal me";
  assert.throws(() => validateEventDraft(draft), /unsupported or missing fields/);
});

test("a later affirmation cannot erase a revocation", () => {
  const value = fixture();
  appendCurrentEvidence(value);
  appendContinuityEvent(value.chain, event(value.continuityRoot, "credential_revoked", "verification", "2026-08-23T12:02:00.000Z", { disposition: "revoke" }));
  appendContinuityEvent(value.chain, event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:03:00.000Z"));
  const selected = evaluateContinuity(verification(value), policy(), { now: NOW });
  assert.equal(selected.continuity, "REVOKED");
  assert.equal(selected.reasons.some((reason) => reason.ruleId === "effective-revocation"), true);
});

test("remediation requires fresh independent trusted signed verification", () => {
  const value = fixture();
  const revokePrivate = join(value.root, "revoke-private.pem");
  const revokePublic = join(value.root, "revoke-public.pem");
  const fixPrivate = join(value.root, "fix-private.pem");
  const fixPublic = join(value.root, "fix-public.pem");
  generateSigningKey(revokePrivate, revokePublic);
  generateSigningKey(fixPrivate, fixPublic);
  const revoked = appendContinuityEvent(value.chain, event(value.continuityRoot, "credential_revoked", "verification", "2026-08-23T12:00:00.000Z", {
    disposition: "revoke", issuer: publicKeyId(revokePublic),
  }), revokePrivate);
  appendContinuityEvent(value.chain, event(value.continuityRoot, "remediation_verified", "verification", "2026-08-23T12:01:00.000Z", {
    issuer: publicKeyId(fixPublic), supersedesEventId: revoked.eventId, freshUntil: null,
  }), fixPrivate);
  const selectedPolicy = policy({
    requiredSources: [], maxAgeSeconds: {}, requireSignedEvents: true,
    trustedIssuerKeyIds: [publicKeyId(revokePublic), publicKeyId(fixPublic)],
  });
  assert.equal(evaluateContinuity(verification(value), selectedPolicy, { now: NOW }).continuity, "REVOKED");

  const repaired = fixture();
  const revokedAgain = appendContinuityEvent(repaired.chain, event(repaired.continuityRoot, "credential_revoked", "verification", "2026-08-23T12:00:00.000Z", {
    disposition: "revoke", issuer: publicKeyId(revokePublic),
  }), revokePrivate);
  appendContinuityEvent(repaired.chain, event(repaired.continuityRoot, "remediation_verified", "verification", "2026-08-23T12:01:00.000Z", {
    issuer: publicKeyId(fixPublic), supersedesEventId: revokedAgain.eventId, freshUntil: "2026-08-23T13:00:00.000Z",
  }), fixPrivate);
  const recovered = evaluateContinuity(verification(repaired), selectedPolicy, { now: NOW });
  assert.equal(recovered.continuity, "CURRENT");
  assert.equal(recovered.reasons.some((reason) => reason.ruleId === "remediation-verified"), true);
});

test("an incident without explicit GitHub linkage holds and does not claim causation", () => {
  const value = fixture();
  appendCurrentEvidence(value);
  appendContinuityEvent(value.chain, event(value.continuityRoot, "incident_linked", "operator", "2026-08-23T12:02:00.000Z", {
    disposition: "observe", deliveryIdHash: null, targetHash: null,
  }));
  const decision = evaluateContinuity(verification(value), policy(), { now: NOW });
  assert.equal(decision.continuity, "HOLD");
  assert.equal(decision.reasons.some((reason) => reason.ruleId === "incident-linkage"), true);
  assert.equal(JSON.stringify(decision).includes("caused"), false);
});

test("no-known-event checkpoint cannot satisfy an outcome source", () => {
  const value = fixture();
  appendContinuityEvent(value.chain, event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z"));
  appendContinuityEvent(value.chain, event(value.continuityRoot, "monitor_checkpoint", "github-outcome", "2026-08-23T12:01:00.000Z", {
    disposition: "observe", reasonCode: "no_known_event_through",
  }));
  const decision = evaluateContinuity(verification(value), policy(), { now: NOW });
  assert.equal(decision.continuity, "HOLD");
  assert.equal(decision.outcomeFacts.some((fact) => fact.kind === "no_known_event_through"), true);
});

test("receipt-tier contracts reject prompts, paths, commands, tokens, emails, and repository names", () => {
  const value = fixture();
  const unsafe = [
    "raw prompt text", "/private/source/path", "npm test", "ghp_secret_token", "person@example.com", "owner/repository",
  ];
  for (const [index, leaked] of unsafe.entries()) {
    const draft = event(value.continuityRoot, "verification_refreshed", "verification", "2026-08-23T12:00:00.000Z") as unknown as Record<string, unknown>;
    (draft.event as Record<string, unknown>).reasonCode = leaked;
    assert.throws(() => validateEventDraft(draft), `unsafe value ${index} should be rejected`);
  }
  appendCurrentEvidence(value);
  const decision = evaluateContinuity(verification(value), policy(), { now: NOW });
  const serialized = JSON.stringify(decision);
  for (const secret of ["private/customer", "secret command", "must-not-leak", "example.invalid", value.root]) assert.equal(serialized.includes(secret), false);
  const projected = JSON.stringify(publicChainVerification(verification(value)));
  assert.equal(projected.includes("private/customer"), false);
  assert.equal(projected.includes(value.root), false);
});

test("adapter outage and webhook-authentication contradiction can never produce CURRENT", () => {
  const outage = fixture();
  appendCurrentEvidence(outage);
  appendContinuityEvent(outage.chain, event(outage.continuityRoot, "coverage_gap", "github-outcome", "2026-08-23T12:02:00.000Z", {
    disposition: "hold", reasonCode: "adapter.unavailable",
  }));
  const held = evaluateContinuity(verification(outage), policy(), { now: NOW });
  assert.equal(held.continuity, "HOLD");
  assert.equal(held.allowsProtectedAction, false);

  const webhook = fixture();
  appendCurrentEvidence(webhook);
  appendContinuityEvent(webhook.chain, event(webhook.continuityRoot, "attestation_invalid", "github-outcome", "2026-08-23T12:02:00.000Z", {
    disposition: "revoke", reasonCode: "app.webhook_signature_failure",
  }));
  const revoked = evaluateContinuity(verification(webhook), policy(), { now: NOW });
  assert.equal(revoked.continuity, "REVOKED");
  assert.equal(revoked.allowsProtectedAction, false);
});

test("unknown protected environments hold instead of falling through", () => {
  const value = fixture();
  appendCurrentEvidence(value);
  const decision = evaluateContinuity(verification(value), policy(), { now: NOW, environment: "unlisted" });
  assert.equal(decision.continuity, "HOLD");
  assert.equal(decision.allowsProtectedAction, false);
  assert.throws(() => evaluateContinuity(verification(value), policy(), { now: NOW, environment: "/private/environment" }), /privacy-safe/);
});

test("chain output refuses a symbolic-link destination", (context) => {
  const root = mkdtempSync(join(tmpdir(), "vigil-continuity-symlink-"));
  const target = join(root, "outside");
  const link = join(root, "chain");
  mkdirSync(target);
  try { symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "EACCES", "UNKNOWN"].includes(code ?? "")) { context.skip(`host does not permit symlinks (${code})`); return; }
    throw error;
  }
  const receiptValue = report(root);
  assert.throws(() => initializeContinuityChain(receiptValue.path, link), /symbolic link|already exists/);
});

test("policy is closed, bounded, and rejects duplicate trust roots", () => {
  const base = policy().value as unknown as Record<string, unknown>;
  assert.throws(() => validateContinuityPolicy({ ...base, extra: true }), /unsupported or missing fields/);
  assert.throws(() => validateContinuityPolicy({ ...base, trustedRootKeyIds: [digest("x"), digest("x")] }), /duplicate/);
  assert.throws(() => validateContinuityPolicy({ ...base, maxAgeSeconds: { verification: 0 } }), /integer/);
});

test("published continuity schemas are closed and examples satisfy the runtime contracts", () => {
  const eventSchema = JSON.parse(readFileSync(new URL("../docs/continuity-event-v1.schema.json", import.meta.url), "utf8"));
  const policySchema = JSON.parse(readFileSync(new URL("../docs/continuity-policy-v1.schema.json", import.meta.url), "utf8"));
  const stapleSchema = JSON.parse(readFileSync(new URL("../docs/continuity-staple-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(eventSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(eventSchema.$defs.draft.additionalProperties, false);
  assert.equal(eventSchema.$defs.stored.additionalProperties, false);
  assert.equal(policySchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(policySchema.additionalProperties, false);
  assert.equal(stapleSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(stapleSchema.additionalProperties, false);
  assert.equal(stapleSchema.$defs.payload.additionalProperties, false);
  assert.equal(stapleSchema.$defs.decision.additionalProperties, false);
  assert.equal(stapleSchema.$defs.evidence.additionalProperties, false);
  assert.equal(stapleSchema.$defs.signature.additionalProperties, false);
  validateEventDraft(JSON.parse(readFileSync(new URL("../examples/continuity/verification-refreshed.event.json", import.meta.url), "utf8")));
  validateContinuityPolicy(JSON.parse(readFileSync(new URL("../examples/continuity/policy.json", import.meta.url), "utf8")));
});
