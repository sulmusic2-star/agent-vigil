import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { basename, join, parse, resolve, sep } from "node:path";
import { canonical, recomputeReceiptHash, validateTrustReport, type TrustReport } from "../report.ts";
import { publicKeyDer, signingKeyId } from "../signature.ts";
import { writePrivateFileAtomic, writePrivateFileExclusive } from "../safe-output.ts";
import {
  canonicalSha256,
  readBoundedJson,
  readBoundedRegularFile,
  sha256,
  validateContinuityRoot,
  validateEventDraft,
  validateStoredEvent,
  type ContinuityEvent,
  type ContinuityEventDraft,
  type ContinuityRoot,
  type ContinuitySubject,
} from "./contracts.ts";

const ROOT_DOMAIN = "agent-vigil-continuity-root/v1\0";
const EVENT_DOMAIN = "agent-vigil-continuity-event/v1\0";
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS = 100_000;

export type RootSignatureState = {
  present: boolean;
  valid: boolean;
  keyId?: string;
};

export type ChainVerification = {
  valid: boolean;
  errors: string[];
  root: ContinuityRoot;
  report: TrustReport;
  events: ContinuityEvent[];
  chainTip: string;
  rootSignature: RootSignatureState;
};

type ContinuityTip = {
  schemaVersion: "agent-vigil-continuity-tip/v1";
  sequence: number;
  eventHash: string;
  updatedAt: string;
};

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function ensurePrivateDirectory(requested: string, mustBeNew = false): string {
  const absolute = resolve(requested);
  const root = parse(absolute).root;
  const rootStatus = lstatSync(root);
  let current = root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    const next = join(current, component);
    try {
      const status = lstatSync(next);
      if (status.isSymbolicLink()) {
        const trustedRootAlias = index === 0 && status.uid === rootStatus.uid && (rootStatus.mode & 0o022) === 0;
        if (!trustedRootAlias) throw new Error("continuity directory may not traverse a symbolic link");
        const canonical = realpathSync(next);
        if (!lstatSync(canonical).isDirectory()) throw new Error("continuity directory parent is not a directory");
        current = canonical;
        continue;
      }
      if (!status.isDirectory()) throw new Error("continuity directory path contains a non-directory entry");
      if (mustBeNew && index === components.length - 1) throw new Error("continuity output already exists");
      current = next;
    } catch (error) {
      if (!isMissing(error)) throw error;
      mkdirSync(next, { mode: 0o700 });
      chmodSync(next, 0o700);
      current = next;
    }
  }
  return current;
}

function parseReport(bytes: Buffer): TrustReport {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Agent Vigil receipt is not valid JSON"); }
  const report = validateTrustReport(value);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(report.base) || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(report.head)) {
    throw new Error("continuity requires full base and head Git object IDs");
  }
  if (!report.repository.tree || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(report.repository.tree)) {
    throw new Error("continuity requires a committed head tree");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(report.receiptHash) || recomputeReceiptHash(report) !== report.receiptHash) {
    throw new Error("Agent Vigil receipt hash is invalid");
  }
  return report;
}

function subjectFor(report: TrustReport): ContinuitySubject {
  return {
    episodeReceiptHash: report.receiptHash,
    repositoryHash: canonicalSha256({ remote: report.repository.remote ?? null, tree: report.repository.tree }),
    baseSha: report.base,
    headSha: report.head,
  };
}

function rootHash(report: TrustReport): string {
  return sha256(`${ROOT_DOMAIN}${canonical(report)}`);
}

function unsignedEventPayload(event: ContinuityEvent): Omit<ContinuityEvent, "eventHash" | "signature"> {
  const { eventHash: _eventHash, signature: _signature, ...payload } = event;
  return payload;
}

export function computeEventHash(event: ContinuityEvent): string {
  return sha256(`${EVENT_DOMAIN}${event.predecessorHash}${canonical(unsignedEventPayload(event))}`);
}

function sameSubject(left: ContinuitySubject, right: ContinuitySubject): boolean {
  return canonical(left) === canonical(right);
}

function tip(sequence: number, eventHash: string, updatedAt: string): ContinuityTip {
  return { schemaVersion: "agent-vigil-continuity-tip/v1", sequence, eventHash, updatedAt };
}

function validateTip(value: unknown): ContinuityTip {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("continuity tip must be an object");
  const selected = value as Record<string, unknown>;
  const keys = Object.keys(selected).sort();
  if (canonical(keys) !== canonical(["eventHash", "schemaVersion", "sequence", "updatedAt"])) {
    throw new Error("continuity tip has unsupported or missing fields");
  }
  if (selected.schemaVersion !== "agent-vigil-continuity-tip/v1") throw new Error("unsupported continuity tip schema");
  if (!Number.isSafeInteger(selected.sequence) || Number(selected.sequence) < 0 || Number(selected.sequence) > MAX_EVENTS) {
    throw new Error("continuity tip sequence is invalid");
  }
  if (typeof selected.eventHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(selected.eventHash)) {
    throw new Error("continuity tip hash is invalid");
  }
  if (typeof selected.updatedAt !== "string" || !Number.isFinite(Date.parse(selected.updatedAt))
    || new Date(Date.parse(selected.updatedAt)).toISOString() !== selected.updatedAt) {
    throw new Error("continuity tip timestamp is invalid");
  }
  return tip(Number(selected.sequence), selected.eventHash, selected.updatedAt);
}

function rootSignatureState(report: TrustReport): RootSignatureState {
  if (!report.signature) return { present: false, valid: false };
  try {
    if (report.signature.algorithm !== "Ed25519") return { present: true, valid: false };
    const publicKey = createPublicKey({
      key: Buffer.from(report.signature.publicKey, "base64"),
      type: "spki",
      format: "der",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") return { present: true, valid: false };
    const keyId = signingKeyId(publicKeyDer(publicKey));
    return {
      present: true,
      valid: keyId === report.signature.keyId
        && verify(null, Buffer.from(report.receiptHash), publicKey, Buffer.from(report.signature.value, "base64")),
      keyId,
    };
  } catch {
    return { present: true, valid: false };
  }
}

function verifyEventSignature(event: ContinuityEvent): { valid: boolean; keyId?: string } {
  if (!event.signature) return { valid: true };
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(event.signature.publicKey, "base64"),
      type: "spki",
      format: "der",
    });
    if (publicKey.asymmetricKeyType !== "ed25519") return { valid: false };
    const keyId = signingKeyId(publicKeyDer(publicKey));
    return {
      valid: keyId === event.signature.keyId
        && verify(null, Buffer.from(event.eventHash), publicKey, Buffer.from(event.signature.value, "base64")),
      keyId,
    };
  } catch {
    return { valid: false };
  }
}

export function initializeContinuityChain(receiptPath: string, outputDirectory: string, now = new Date()): ContinuityRoot {
  const receiptBytes = readBoundedRegularFile(receiptPath, MAX_RECEIPT_BYTES, "Agent Vigil receipt");
  const report = parseReport(receiptBytes);
  const directory = ensurePrivateDirectory(outputDirectory, true);
  const eventsDirectory = ensurePrivateDirectory(join(directory, "events"), true);
  const root: ContinuityRoot = {
    schemaVersion: "agent-vigil-continuity-root/v1",
    receiptFileSha256: sha256(receiptBytes),
    receiptHash: report.receiptHash,
    rootHash: rootHash(report),
    subject: subjectFor(report),
    historicalVerification: report.summary.status,
    createdAt: now.toISOString(),
  };
  writePrivateFileExclusive(join(directory, "receipt.json"), receiptBytes.toString("utf8"));
  writePrivateFileExclusive(join(directory, "root.json"), `${JSON.stringify(root, null, 2)}\n`);
  writePrivateFileExclusive(join(directory, "tip.json"), `${JSON.stringify(tip(0, root.rootHash, root.createdAt), null, 2)}\n`);
  chmodSync(eventsDirectory, 0o700);
  return root;
}

function readChainFiles(chainDirectory: string): { root: ContinuityRoot; report: TrustReport; events: ContinuityEvent[]; receiptBytes: Buffer; tip: ContinuityTip } {
  const directory = resolve(chainDirectory);
  let status;
  try { status = lstatSync(directory); }
  catch { throw new Error("continuity chain directory is missing or unreadable"); }
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error("continuity chain must be a regular directory, not a symbolic link");
  const entries = readdirSync(directory).sort();
  if (canonical(entries) !== canonical(["events", "receipt.json", "root.json", "tip.json"])) throw new Error("continuity chain directory contains unsupported or missing entries");
  const eventsDirectory = join(directory, "events");
  const eventsStatus = lstatSync(eventsDirectory);
  if (eventsStatus.isSymbolicLink() || !eventsStatus.isDirectory()) throw new Error("continuity events must be stored in a regular directory");

  const root = validateContinuityRoot(readBoundedJson(join(directory, "root.json"), MAX_EVENT_BYTES, "continuity root"));
  const storedTip = validateTip(readBoundedJson(join(directory, "tip.json"), MAX_EVENT_BYTES, "continuity tip"));
  const receiptBytes = readBoundedRegularFile(join(directory, "receipt.json"), MAX_RECEIPT_BYTES, "Agent Vigil receipt");
  const report = parseReport(receiptBytes);
  const eventFiles = readdirSync(eventsDirectory).sort();
  if (eventFiles.length > MAX_EVENTS) throw new Error(`continuity chain exceeds ${MAX_EVENTS} events`);
  for (const file of eventFiles) if (!/^\d{8}\.json$/.test(file)) throw new Error("continuity events directory contains an unsupported entry");
  const events = eventFiles.map((file) => validateStoredEvent(readBoundedJson(join(eventsDirectory, file), MAX_EVENT_BYTES, "continuity event")));
  return { root, report, events, receiptBytes, tip: storedTip };
}

export function verifyContinuityChain(
  chainDirectory: string,
  options: {
    now?: Date;
    maxClockSkewSeconds?: number;
    pinnedEventKeyIds?: string[];
    expectedBase?: string;
    expectedHead?: string;
    repo?: string;
  } = {},
): ChainVerification {
  const errors: string[] = [];
  const now = options.now ?? new Date();
  const maximumFuture = now.getTime() + (options.maxClockSkewSeconds ?? 300) * 1000;
  const { root, report, events, receiptBytes, tip: storedTip } = readChainFiles(chainDirectory);
  if (root.receiptFileSha256 !== sha256(receiptBytes)) errors.push("original receipt bytes no longer match the continuity root");
  if (root.receiptHash !== report.receiptHash) errors.push("original receipt identity no longer matches the continuity root");
  if (root.rootHash !== rootHash(report)) errors.push("original receipt content no longer matches the continuity root hash");
  if (!sameSubject(root.subject, subjectFor(report))) errors.push("continuity root subject does not match the original receipt");
  if (options.expectedBase) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.expectedBase)) throw new Error("expected base must be a full lowercase Git object ID");
    if (root.subject.baseSha !== options.expectedBase) errors.push("continuity root does not match the policy base commit");
  }
  if (options.expectedHead) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.expectedHead)) throw new Error("expected head must be a full lowercase Git object ID");
    if (root.subject.headSha !== options.expectedHead) errors.push("continuity root does not match the expected deployment commit");
  }
  if (options.repo) {
    try {
      const head = execFileSync("git", ["rev-parse", "--verify", `${root.subject.headSha}^{commit}`], {
        cwd: resolve(options.repo), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const tree = execFileSync("git", ["rev-parse", "--verify", `${root.subject.headSha}^{tree}`], {
        cwd: resolve(options.repo), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      if (head !== root.subject.headSha) errors.push("repository resolved the recorded head to a different commit");
      if (tree !== report.repository.tree) errors.push("repository head tree does not match the original receipt");
      execFileSync("git", ["merge-base", "--is-ancestor", root.subject.baseSha, root.subject.headSha], {
        cwd: resolve(options.repo), stdio: ["ignore", "ignore", "ignore"],
      });
    } catch {
      errors.push("recorded base and head are not a verifiable ancestor range in this repository");
    }
  }
  if (root.historicalVerification !== report.summary.status) errors.push("historical verification verdict was changed");
  const receiptSignature = rootSignatureState(report);
  if (receiptSignature.present && !receiptSignature.valid) errors.push("original receipt signature is invalid");

  let predecessor = root.rootHash;
  let priorObserved = Number.NEGATIVE_INFINITY;
  let priorEffective = Number.NEGATIVE_INFINITY;
  const eventIds = new Set<string>();
  const deliveryIds = new Set<string>();
  for (const [index, event] of events.entries()) {
    const sequence = index + 1;
    if (event.sequence !== sequence) errors.push(`event ${sequence} has an unexpected sequence number`);
    if (event.predecessorHash !== predecessor) errors.push(`event ${sequence} does not extend the prior chain tip`);
    if (!sameSubject(event.subject, root.subject)) errors.push(`event ${sequence} is bound to a different receipt subject`);
    if (event.eventHash !== computeEventHash(event)) errors.push(`event ${sequence} content hash is invalid`);
    if (eventIds.has(event.eventId)) errors.push(`event ${sequence} reuses an earlier event ID`);
    eventIds.add(event.eventId);
    if (event.source.deliveryIdHash) {
      if (deliveryIds.has(event.source.deliveryIdHash)) errors.push(`event ${sequence} replays an earlier delivery ID`);
      deliveryIds.add(event.source.deliveryIdHash);
    }

    const observed = Date.parse(event.observedAt);
    const effective = Date.parse(event.effectiveAt);
    if (observed < effective) errors.push(`event ${sequence} was observed before it became effective`);
    if (observed < priorObserved || effective < priorEffective) errors.push(`event ${sequence} rolls the continuity clock backward`);
    if (observed > maximumFuture || effective > maximumFuture) errors.push(`event ${sequence} has an implausible future timestamp`);
    priorObserved = observed;
    priorEffective = effective;
    if (event.event.freshUntil && Date.parse(event.event.freshUntil) <= effective) {
      errors.push(`event ${sequence} has a freshness boundary that is not later than its effective time`);
    }

    const signature = verifyEventSignature(event);
    if (!signature.valid) errors.push(`event ${sequence} signature is invalid`);
    if (event.signature && event.source.issuer !== signature.keyId) errors.push(`event ${sequence} issuer does not match its signing key`);
    if (!event.signature && options.pinnedEventKeyIds?.length) errors.push(`event ${sequence} is unsigned but a pinned event key was required`);
    if (event.signature && options.pinnedEventKeyIds?.length && !options.pinnedEventKeyIds.includes(signature.keyId ?? "")) {
      errors.push(`event ${sequence} signer does not match the pinned public key`);
    }
    predecessor = event.eventHash;
  }
  const expectedTipTime = events.at(-1)?.observedAt ?? root.createdAt;
  if (storedTip.sequence !== events.length || storedTip.eventHash !== predecessor || storedTip.updatedAt !== expectedTipTime) {
    errors.push("continuity tip does not match the complete recorded event sequence");
  }

  return {
    valid: errors.length === 0,
    errors,
    root,
    report,
    events,
    chainTip: predecessor,
    rootSignature: receiptSignature,
  };
}

export function createStoredEvent(
  draftValue: unknown,
  root: ContinuityRoot,
  priorEvents: ContinuityEvent[],
  privateKeyPath?: string,
  now = new Date(),
): ContinuityEvent {
  const draft = validateEventDraft(draftValue);
  if (!sameSubject(draft.subject, root.subject)) throw new Error("continuity event subject does not match the chain root");
  if (priorEvents.some((event) => event.eventId === draft.eventId)) throw new Error("continuity event ID was already used");
  if (draft.source.deliveryIdHash && priorEvents.some((event) => event.source.deliveryIdHash === draft.source.deliveryIdHash)) {
    throw new Error("continuity delivery ID was already recorded");
  }
  const prior = priorEvents.at(-1);
  if (prior) {
    if (Date.parse(draft.observedAt) < Date.parse(prior.observedAt) || Date.parse(draft.effectiveAt) < Date.parse(prior.effectiveAt)) {
      throw new Error("continuity event rolls the chain clock backward");
    }
  }
  if (Date.parse(draft.observedAt) < Date.parse(draft.effectiveAt)) throw new Error("continuity event cannot be observed before it becomes effective");
  const maximumFuture = now.getTime() + 300_000;
  if (Date.parse(draft.observedAt) > maximumFuture || Date.parse(draft.effectiveAt) > maximumFuture) {
    throw new Error("continuity event has an implausible future timestamp");
  }
  if (draft.event.freshUntil && Date.parse(draft.event.freshUntil) <= Date.parse(draft.effectiveAt)) {
    throw new Error("continuity event freshness must extend beyond its effective time");
  }

  const event: ContinuityEvent = {
    ...draft,
    sequence: priorEvents.length + 1,
    predecessorHash: prior?.eventHash ?? root.rootHash,
    eventHash: "sha256:" + "0".repeat(64),
    signature: null,
  };
  event.eventHash = computeEventHash(event);
  if (privateKeyPath) {
    const privateKey = createPrivateKey(readBoundedRegularFile(privateKeyPath, 64 * 1024, "continuity signing key"));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("continuity signing key must be Ed25519");
    const publicKey = createPublicKey(privateKey);
    const der = publicKeyDer(publicKey);
    event.signature = {
      algorithm: "Ed25519",
      keyId: signingKeyId(der),
      publicKey: der.toString("base64"),
      value: sign(null, Buffer.from(event.eventHash), privateKey).toString("base64"),
    };
    if (event.source.issuer !== event.signature.keyId) throw new Error("continuity event issuer must match its signing key");
  }
  return event;
}

export function appendContinuityEvent(chainDirectory: string, draft: unknown, privateKeyPath?: string): ContinuityEvent {
  const verified = verifyContinuityChain(chainDirectory);
  if (!verified.valid) throw new Error(`continuity chain is invalid: ${verified.errors.join("; ")}`);
  const event = createStoredEvent(draft, verified.root, verified.events, privateKeyPath);
  const file = `${String(event.sequence).padStart(8, "0")}.json`;
  writePrivateFileExclusive(join(resolve(chainDirectory), "events", file), `${JSON.stringify(event, null, 2)}\n`);
  writePrivateFileAtomic(join(resolve(chainDirectory), "tip.json"), `${JSON.stringify(tip(event.sequence, event.eventHash, event.observedAt), null, 2)}\n`);
  const after = verifyContinuityChain(chainDirectory);
  if (!after.valid) throw new Error(`appended continuity event did not verify: ${after.errors.join("; ")}`);
  return event;
}

export function continuitySubjectTemplate(root: ContinuityRoot): ContinuitySubject {
  return { ...root.subject };
}

export function chainExists(path: string): boolean {
  return existsSync(resolve(path));
}

export function chainName(path: string): string {
  return basename(resolve(path));
}
