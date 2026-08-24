#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMPONENT = /^[a-z0-9@][a-z0-9@/._-]*$/;
const ECOSYSTEM = /^[a-z0-9][a-z0-9._-]*$/;
const EXACT_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9@:+._-]*$/;
const ADAPTER_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const SCHEMA_SHA256 = "db8311854812f7774b3da7f08b1981fccc2ce4c0fdf1cbc67e0d8e5e29bbd73c";
const GLOBAL_ROW_CAP = 1_000;
const CHANNEL_ROW_CAP = 500;
const PUBLISHER_ROW_CAP = 400;
const CHUNK_ROWS_MAXIMUM = 100;
const EXPORT_TTL_MS = 5 * 60_000;
const FUTURE_ALLOWANCE_MS = 5_000;

function usage() {
  return [
    "Usage: validate-first-100.mjs [--ledger PATH] [--provenance PATH]",
    "  [--manifest PATH --trusted-head PATH --operator-public-key PATH]",
    "  [--chunk PATH ... | --chunks-dir DIRECTORY]",
  ].join("\n");
}

function parseArguments(argv) {
  const values = {
    ledger: join(root, "first-100-ledger.jsonl"),
    provenance: join(root, "first-100-provenance.jsonl"),
    manifest: null,
    trustedHead: null,
    operatorPublicKey: null,
    chunks: [],
    chunksDir: null,
  };
  const singletons = new Map([
    ["--ledger", "ledger"],
    ["--provenance", "provenance"],
    ["--manifest", "manifest"],
    ["--trusted-head", "trustedHead"],
    ["--operator-public-key", "operatorPublicKey"],
    ["--chunks-dir", "chunksDir"],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (name === "--chunk") {
      const value = argv[++index];
      assert.ok(value && !value.startsWith("--"), "--chunk requires a path");
      values.chunks.push(resolve(value));
      continue;
    }
    const property = singletons.get(name);
    assert.ok(property, `unknown option ${name}\n${usage()}`);
    assert.equal(seen.has(name), false, `${name} may be supplied only once`);
    seen.add(name);
    const value = argv[++index];
    assert.ok(value && !value.startsWith("--"), `${name} requires a path`);
    values[property] = resolve(value);
  }
  assert.ok(values.chunks.length === 0 || values.chunksDir === null, "use repeatable --chunk or --chunks-dir, not both");
  assert.equal(new Set(values.chunks).size, values.chunks.length, "duplicate --chunk path");
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Prefixed(value) {
  return `sha256:${sha256(value)}`;
}

function canonical(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
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

function safeInteger(value, minimum, maximum, label) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label}: safe integer required`);
  return value;
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

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is unavailable or invalid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function decodeCanonicalBase64(value, label) {
  boundedText(value, 1, 512, label);
  assert.match(value, /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, `${label}: canonical base64`);
  const bytes = Buffer.from(value, "base64");
  assert.equal(bytes.toString("base64"), value, `${label}: canonical base64`);
  return bytes;
}

function readOperatorPublicKey(path) {
  const bytes = readFileSync(path);
  let key;
  if (bytes.toString("ascii").includes("-----BEGIN")) {
    assert.match(bytes.toString("ascii"), /-----BEGIN PUBLIC KEY-----/, "operator key must be a public SPKI key");
    key = createPublicKey(bytes);
  } else {
    key = createPublicKey({ key: bytes, format: "der", type: "spki" });
  }
  assert.equal(key.asymmetricKeyType, "ed25519", "operator SPKI must contain an Ed25519 public key");
  const der = key.export({ type: "spki", format: "der" });
  return { key, keyId: sha256Prefixed(der) };
}

function verifySignedDocument(value, schemaVersion, operator, label) {
  const document = exact(value, ["schemaVersion", "payload", "signature"], [], label);
  assert.equal(document.schemaVersion, schemaVersion, `${label}: schema`);
  const payload = object(document.payload, `${label} payload`);
  const signature = exact(document.signature, ["algorithm", "keyId", "value"], [], `${label} signature`);
  assert.equal(signature.algorithm, "Ed25519", `${label}: algorithm`);
  assert.equal(signature.keyId, operator.keyId, `${label}: operator key ID`);
  const signatureBytes = decodeCanonicalBase64(signature.value, `${label} signature value`);
  assert.equal(signatureBytes.length, 64, `${label}: Ed25519 signature length`);
  assert.ok(verify(
    null,
    Buffer.from(canonical({ schemaVersion, payload }), "utf8"),
    operator.key,
    signatureBytes,
  ), `${label}: signature invalid`);
  return payload;
}

function validateFreshWindow(issuedAtValue, expiresAtValue, now, label) {
  const issuedAt = timestamp(issuedAtValue, `${label} issuedAt`);
  const expiresAt = timestamp(expiresAtValue, `${label} expiresAt`);
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  assert.ok(expires > issued && expires - issued <= EXPORT_TTL_MS, `${label}: validity window exceeds five minutes`);
  assert.ok(issued <= now + FUTURE_ALLOWANCE_MS, `${label}: issuedAt is more than five seconds in the future`);
  assert.ok(expires > now, `${label}: trusted current head is expired`);
  return { issuedAt, expiresAt };
}

function validateCheckpoint(value, registrationId) {
  const checkpoint = exact(value, ["sequence", "eventId", "eventSha256"], [], "manifest moderation checkpoint");
  safeInteger(checkpoint.sequence, 0, Number.MAX_SAFE_INTEGER, "manifest checkpoint sequence");
  boundedText(checkpoint.eventSha256, 71, 71, "manifest checkpoint hash", SHA256);
  if (checkpoint.sequence === 0) {
    assert.equal(checkpoint.eventId, "GENESIS", "genesis checkpoint event ID");
    assert.equal(checkpoint.eventSha256, sha256Prefixed(canonical({ registrationId, genesis: true })), "genesis checkpoint hash");
  } else {
    boundedText(checkpoint.eventId, 36, 36, "manifest checkpoint event ID", UUID_V4);
  }
  return checkpoint;
}

function validateStopEvents(values, registration, permittedChannels, now, operatorKeyId) {
  assert.ok(Array.isArray(values) && values.length <= 1_024, "manifest stop events are invalid or unbounded");
  const identities = new Set();
  const scopeKeys = new Set();
  const eventIds = new Set();
  let previousSequence = 0;
  for (const [index, raw] of values.entries()) {
    const event = exact(raw, [
      "stopSequence", "eventId", "scopeType", "scopeId", "reason", "publisherKeyId",
      "channel", "requestId", "requestBodySha256", "observedAt",
    ], [], `manifest stop event ${index}`);
    const sequence = safeInteger(event.stopSequence, 1, Number.MAX_SAFE_INTEGER, `manifest stop event ${index} sequence`);
    assert.ok(sequence > previousSequence, `manifest stop event ${index}: sequence order`);
    previousSequence = sequence;
    boundedText(event.eventId, 36, 36, `manifest stop event ${index} event ID`, UUID_V4);
    assert.equal(eventIds.has(event.eventId), false, `manifest stop event ${index}: duplicate event ID`);
    eventIds.add(event.eventId);
    assert.ok(["GLOBAL", "CHANNEL", "PUBLISHER", "SAMPLE"].includes(event.scopeType), `manifest stop event ${index}: scope type`);
    assert.ok(["GLOBAL_ROW_CAP", "CHANNEL_ROW_CAP", "PUBLISHER_ROW_CAP", "INCLUDED_SAMPLE_CLOSED"].includes(event.reason), `manifest stop event ${index}: reason`);
    boundedText(event.publisherKeyId, 71, 71, `manifest stop event ${index} publisher`, SHA256);
    assert.notEqual(event.publisherKeyId, operatorKeyId, `manifest stop event ${index}: operator/publisher duty conflict`);
    identities.add(event.publisherKeyId);
    assert.ok(permittedChannels.has(event.channel), `manifest stop event ${index}: channel`);
    boundedText(event.requestId, 36, 36, `manifest stop event ${index} request ID`, UUID_V4);
    boundedText(event.requestBodySha256, 71, 71, `manifest stop event ${index} request hash`, SHA256);
    const observedAt = timestamp(event.observedAt, `manifest stop event ${index} observedAt`);
    assert.ok(Date.parse(observedAt) <= now + FUTURE_ALLOWANCE_MS, `manifest stop event ${index}: future observation`);
    const scopeKey = `${event.scopeType}\0${event.scopeId}\0${event.reason}`;
    assert.equal(scopeKeys.has(scopeKey), false, `manifest stop event ${index}: duplicate scope marker`);
    scopeKeys.add(scopeKey);
    if (event.scopeType === "GLOBAL") {
      assert.deepEqual({ scopeId: event.scopeId, reason: event.reason }, { scopeId: registration.registrationId, reason: "GLOBAL_ROW_CAP" }, `manifest stop event ${index}: global binding`);
    } else if (event.scopeType === "CHANNEL") {
      assert.deepEqual({ scopeId: event.scopeId, reason: event.reason }, { scopeId: event.channel, reason: "CHANNEL_ROW_CAP" }, `manifest stop event ${index}: channel binding`);
    } else if (event.scopeType === "PUBLISHER") {
      assert.deepEqual({ scopeId: event.scopeId, reason: event.reason }, { scopeId: event.publisherKeyId, reason: "PUBLISHER_ROW_CAP" }, `manifest stop event ${index}: publisher binding`);
    } else {
      assert.deepEqual({ scopeId: event.scopeId, reason: event.reason }, { scopeId: registration.registrationId, reason: "INCLUDED_SAMPLE_CLOSED" }, `manifest stop event ${index}: sample binding`);
    }
  }
  return identities;
}

function chunkPaths(argumentsValue) {
  if (argumentsValue.chunksDir === null) return argumentsValue.chunks;
  const directoryEntries = readdirSync(argumentsValue.chunksDir, { withFileTypes: true });
  const files = directoryEntries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(argumentsValue.chunksDir, entry.name))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  assert.equal(files.length, directoryEntries.filter((entry) => entry.isFile()).length, "chunks directory contains a non-JSON file");
  return files;
}

function validateTrustBundle(context, argumentsValue) {
  const trustPaths = [argumentsValue.manifest, argumentsValue.trustedHead, argumentsValue.operatorPublicKey];
  const supplied = trustPaths.filter((value) => value !== null).length;
  const chunkArgumentsPresent = argumentsValue.chunks.length > 0 || argumentsValue.chunksDir !== null;
  if (supplied === 0) {
    assert.equal(chunkArgumentsPresent, false, "trusted current head required before chunk validation");
    assert.equal(context.entries.length, 0, "trusted current head required for nonzero corpus");
    return {
      gateAuthorized: false,
      trustVerdict: "TRUSTED_HEAD_REQUIRED",
      operatorKeyId: null,
      issuedAt: null,
      expiresAt: null,
      manifestPayloadSha256: null,
    };
  }
  assert.equal(supplied, 3, "trusted current head required: supply --manifest, --trusted-head, and --operator-public-key together");

  const now = Date.now();
  const operator = readOperatorPublicKey(argumentsValue.operatorPublicKey);
  const manifestPayload = verifySignedDocument(readJson(argumentsValue.manifest, "signed manifest"), "agent-vigil-first-100-export-manifest/v1", operator, "signed manifest");
  exact(manifestPayload, [
    "registrationId", "registrationSha256", "issuedAt", "expiresAt", "moderationCheckpoint",
    "publisherStates", "adapterStates", "publisherStateSha256", "adapterStateSha256",
    "operatorDutySeparated", "rawLedgerSha256", "rawLedgerPairEntries", "provenanceSha256",
    "provenanceRecords", "chunkRowsMaximum", "chunks", "chunkRootSha256", "stopEvents",
    "stopEventsSha256", "globalRowCap", "channelRowCap", "publisherRowCap",
  ], [], "signed manifest payload");
  assert.equal(manifestPayload.registrationId, context.registration.registrationId, "manifest registration ID");
  assert.equal(manifestPayload.registrationSha256, context.registrationSha256, "manifest registration digest");
  const window = validateFreshWindow(manifestPayload.issuedAt, manifestPayload.expiresAt, now, "signed manifest");
  validateCheckpoint(manifestPayload.moderationCheckpoint, context.registration.registrationId);
  assert.equal(manifestPayload.operatorDutySeparated, true, "manifest operator duty separation");
  assert.equal(manifestPayload.rawLedgerSha256, sha256Prefixed(context.ledgerBytes), "manifest raw-ledger binding");
  assert.equal(manifestPayload.rawLedgerPairEntries, context.entries.length, "manifest raw-ledger count");
  assert.equal(manifestPayload.provenanceSha256, sha256Prefixed(context.provenanceBytes), "manifest provenance binding");
  assert.equal(manifestPayload.provenanceRecords, context.provenanceRecords.length, "manifest provenance count");
  assert.equal(manifestPayload.chunkRowsMaximum, CHUNK_ROWS_MAXIMUM, "manifest chunk maximum");
  assert.equal(manifestPayload.globalRowCap, GLOBAL_ROW_CAP, "manifest global row cap");
  assert.equal(manifestPayload.channelRowCap, CHANNEL_ROW_CAP, "manifest channel row cap");
  assert.equal(manifestPayload.publisherRowCap, PUBLISHER_ROW_CAP, "manifest publisher row cap");
  for (const [key, label] of [
    ["publisherStateSha256", "publisher-state"], ["adapterStateSha256", "adapter-state"],
    ["chunkRootSha256", "chunk-root"], ["stopEventsSha256", "stop-events"],
  ]) boundedText(manifestPayload[key], 71, 71, `manifest ${label} hash`, SHA256);

  const publisherStates = manifestPayload.publisherStates;
  assert.ok(Array.isArray(publisherStates) && publisherStates.length <= GLOBAL_ROW_CAP, "manifest publisher states are invalid or unbounded");
  const publisherStateKeys = [];
  let previousPublisherKey = "";
  for (const [index, raw] of publisherStates.entries()) {
    const state = exact(raw, ["keyId", "status", "updatedAt"], [], `manifest publisher state ${index}`);
    boundedText(state.keyId, 71, 71, `manifest publisher state ${index} key`, SHA256);
    assert.ok(state.keyId > previousPublisherKey, `manifest publisher state ${index}: keys must be sorted and unique`);
    previousPublisherKey = state.keyId;
    assert.ok(["ACTIVE", "SUSPENDED", "REVOKED"].includes(state.status), `manifest publisher state ${index}: status`);
    const updatedAt = timestamp(state.updatedAt, `manifest publisher state ${index} updatedAt`);
    assert.ok(Date.parse(updatedAt) <= now + FUTURE_ALLOWANCE_MS, `manifest publisher state ${index}: future update`);
    assert.notEqual(state.keyId, operator.keyId, `manifest publisher state ${index}: operator duty conflict`);
    const observed = context.publisherStates.get(state.keyId);
    assert.ok(observed, `manifest publisher state ${index}: principal is not referenced by provenance`);
    assert.deepEqual({ status: state.status, updatedAt: state.updatedAt }, observed, `manifest publisher state ${index}: provenance mismatch`);
    publisherStateKeys.push(state.keyId);
  }
  assert.deepEqual(publisherStateKeys, [...context.publisherStates.keys()].sort(), "manifest publisher-state set mismatch");
  assert.equal(manifestPayload.publisherStateSha256, sha256Prefixed(canonical(publisherStates)), "manifest publisher-state digest");

  const adapterStates = manifestPayload.adapterStates;
  assert.ok(Array.isArray(adapterStates) && adapterStates.length <= GLOBAL_ROW_CAP, "manifest adapter states are invalid or unbounded");
  const adapterStateKeys = [];
  let previousAdapterKey = "";
  for (const [index, raw] of adapterStates.entries()) {
    const state = exact(raw, ["keyId", "version", "status", "updatedAt"], [], `manifest adapter state ${index}`);
    boundedText(state.keyId, 71, 71, `manifest adapter state ${index} key`, SHA256);
    assert.ok(state.keyId > previousAdapterKey, `manifest adapter state ${index}: keys must be sorted and unique`);
    previousAdapterKey = state.keyId;
    boundedText(state.version, 1, 80, `manifest adapter state ${index} version`, ADAPTER_VERSION);
    assert.ok(["ACTIVE", "REVOKED"].includes(state.status), `manifest adapter state ${index}: status`);
    const updatedAt = timestamp(state.updatedAt, `manifest adapter state ${index} updatedAt`);
    assert.ok(Date.parse(updatedAt) <= now + FUTURE_ALLOWANCE_MS, `manifest adapter state ${index}: future update`);
    assert.notEqual(state.keyId, operator.keyId, `manifest adapter state ${index}: operator duty conflict`);
    assert.equal(context.publisherStates.has(state.keyId), false, `manifest adapter state ${index}: publisher/adapter duty conflict`);
    const observed = context.adapterStates.get(state.keyId);
    assert.ok(observed, `manifest adapter state ${index}: principal is not referenced by provenance`);
    assert.deepEqual({ version: state.version, status: state.status }, { version: observed.version, status: observed.status }, `manifest adapter state ${index}: provenance mismatch`);
    for (const observedAt of observed.observedAt) {
      if (state.status === "ACTIVE") assert.ok(Date.parse(updatedAt) <= Date.parse(observedAt), `manifest adapter state ${index}: active registration follows observation`);
      else assert.ok(Date.parse(updatedAt) >= Date.parse(observedAt), `manifest adapter state ${index}: revocation precedes observation`);
    }
    adapterStateKeys.push(state.keyId);
  }
  assert.deepEqual(adapterStateKeys, [...context.adapterStates.keys()].sort(), "manifest adapter-state set mismatch");
  assert.equal(manifestPayload.adapterStateSha256, sha256Prefixed(canonical(adapterStates)), "manifest adapter-state digest");
  for (const publisherKey of publisherStateKeys) assert.equal(context.adapterStates.has(publisherKey), false, "publisher/adapter duty conflict");
  for (const time of context.snapshotTimes) assert.ok(Date.parse(time) <= now + FUTURE_ALLOWANCE_MS, "provenance contains a future status or grant time");

  validateStopEvents(manifestPayload.stopEvents, context.registration, context.permittedChannels, now, operator.keyId);
  assert.equal(manifestPayload.stopEventsSha256, sha256Prefixed(canonical(manifestPayload.stopEvents)), "manifest stop-events digest");

  assert.ok(Array.isArray(manifestPayload.chunks), "manifest chunks must be an array");
  const descriptors = manifestPayload.chunks;
  assert.equal(descriptors.length, Math.ceil(context.entries.length / CHUNK_ROWS_MAXIMUM), "manifest chunk count");
  assert.ok(descriptors.length <= Math.ceil(GLOBAL_ROW_CAP / CHUNK_ROWS_MAXIMUM), "manifest chunk count exceeds global bound");
  let previousChunkSha256 = null;
  for (const [index, raw] of descriptors.entries()) {
    const descriptor = exact(raw, [
      "index", "cursorAfter", "firstSequence", "lastSequence", "rowCount", "rawRecordsSha256",
      "provenanceRecordsSha256", "previousChunkSha256", "chunkSha256",
    ], [], `manifest chunk descriptor ${index}`);
    assert.equal(descriptor.index, index, `manifest chunk descriptor ${index}: index`);
    safeInteger(descriptor.cursorAfter, 0, Number.MAX_SAFE_INTEGER, `manifest chunk descriptor ${index} cursor`);
    assert.ok(descriptor.firstSequence === null || Number.isSafeInteger(descriptor.firstSequence), `manifest chunk descriptor ${index}: first sequence`);
    assert.ok(descriptor.lastSequence === null || Number.isSafeInteger(descriptor.lastSequence), `manifest chunk descriptor ${index}: last sequence`);
    safeInteger(descriptor.rowCount, 1, CHUNK_ROWS_MAXIMUM, `manifest chunk descriptor ${index} row count`);
    boundedText(descriptor.rawRecordsSha256, 71, 71, `manifest chunk descriptor ${index} raw hash`, SHA256);
    boundedText(descriptor.provenanceRecordsSha256, 71, 71, `manifest chunk descriptor ${index} provenance hash`, SHA256);
    assert.equal(descriptor.previousChunkSha256, previousChunkSha256, `manifest chunk descriptor ${index}: hash chain`);
    const unsigned = {
      index: descriptor.index,
      cursorAfter: descriptor.cursorAfter,
      firstSequence: descriptor.firstSequence,
      lastSequence: descriptor.lastSequence,
      rowCount: descriptor.rowCount,
      rawRecordsSha256: descriptor.rawRecordsSha256,
      provenanceRecordsSha256: descriptor.provenanceRecordsSha256,
      previousChunkSha256: descriptor.previousChunkSha256,
    };
    assert.equal(descriptor.chunkSha256, sha256Prefixed(canonical(unsigned)), `manifest chunk descriptor ${index}: descriptor hash`);
    previousChunkSha256 = descriptor.chunkSha256;
  }
  assert.equal(manifestPayload.chunkRootSha256, previousChunkSha256 ?? sha256Prefixed(canonical([])), "manifest chunk-root binding");

  const manifestPayloadSha256 = sha256Prefixed(canonical(manifestPayload));
  const headPayload = verifySignedDocument(readJson(argumentsValue.trustedHead, "trusted current head"), "agent-vigil-first-100-trusted-head/v1", operator, "trusted current head");
  exact(headPayload, [
    "registrationId", "registrationSha256", "issuedAt", "expiresAt", "manifestPayloadSha256",
    "rawLedgerSha256", "provenanceSha256", "chunkRootSha256", "stopEventsSha256",
    "moderationCheckpoint", "publisherStateSha256", "adapterStateSha256", "operatorDutySeparated",
  ], [], "trusted current head payload");
  assert.equal(headPayload.registrationId, context.registration.registrationId, "trusted head registration ID");
  assert.equal(headPayload.registrationSha256, context.registrationSha256, "trusted head registration digest");
  validateFreshWindow(headPayload.issuedAt, headPayload.expiresAt, now, "trusted current head");
  assert.equal(headPayload.issuedAt, window.issuedAt, "manifest/head issuedAt binding");
  assert.equal(headPayload.expiresAt, window.expiresAt, "manifest/head expiresAt binding");
  assert.equal(headPayload.manifestPayloadSha256, manifestPayloadSha256, "trusted head manifest binding");
  for (const key of ["rawLedgerSha256", "provenanceSha256", "chunkRootSha256", "stopEventsSha256", "publisherStateSha256", "adapterStateSha256", "operatorDutySeparated"]) {
    assert.deepEqual(headPayload[key], manifestPayload[key], `manifest/head ${key} binding`);
  }
  assert.deepEqual(headPayload.moderationCheckpoint, manifestPayload.moderationCheckpoint, "manifest/head checkpoint binding");

  const paths = chunkPaths(argumentsValue);
  assert.equal(paths.length, descriptors.length, "signed chunk files are missing or duplicated");
  const reconstructedEntries = [];
  const reconstructedProvenance = [];
  let previousLastSequence = 0;
  for (const [index, path] of paths.entries()) {
    const chunkPayload = verifySignedDocument(readJson(path, `signed chunk ${index}`), "agent-vigil-first-100-export-chunk/v1", operator, `signed chunk ${index}`);
    exact(chunkPayload, ["registrationId", "issuedAt", "expiresAt", "manifestPayloadSha256", "descriptor", "entries", "provenance"], [], `signed chunk ${index} payload`);
    assert.equal(chunkPayload.registrationId, context.registration.registrationId, `signed chunk ${index}: registration`);
    assert.equal(chunkPayload.issuedAt, window.issuedAt, `signed chunk ${index}: issuedAt`);
    assert.equal(chunkPayload.expiresAt, window.expiresAt, `signed chunk ${index}: expiresAt`);
    assert.equal(chunkPayload.manifestPayloadSha256, manifestPayloadSha256, `signed chunk ${index}: manifest binding`);
    assert.deepEqual(chunkPayload.descriptor, descriptors[index], `signed chunk ${index}: descriptor binding or order`);
    assert.ok(Array.isArray(chunkPayload.entries) && Array.isArray(chunkPayload.provenance), `signed chunk ${index}: record arrays`);
    const descriptor = descriptors[index];
    assert.equal(chunkPayload.entries.length, descriptor.rowCount, `signed chunk ${index}: entry count`);
    assert.equal(chunkPayload.provenance.length, descriptor.rowCount, `signed chunk ${index}: provenance count`);
    const rawRecords = `${chunkPayload.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const provenanceRecordsText = `${chunkPayload.provenance.map((record) => JSON.stringify(record)).join("\n")}\n`;
    assert.equal(descriptor.rawRecordsSha256, sha256Prefixed(rawRecords), `signed chunk ${index}: raw-record digest`);
    assert.equal(descriptor.provenanceRecordsSha256, sha256Prefixed(provenanceRecordsText), `signed chunk ${index}: provenance-record digest`);
    const firstSequence = chunkPayload.entries[0]?.ingestionSequence ?? null;
    const lastSequence = chunkPayload.entries.at(-1)?.ingestionSequence ?? null;
    assert.equal(descriptor.cursorAfter, index === 0 ? 0 : previousLastSequence, `signed chunk ${index}: cursor`);
    assert.equal(descriptor.firstSequence, firstSequence, `signed chunk ${index}: first sequence`);
    assert.equal(descriptor.lastSequence, lastSequence, `signed chunk ${index}: last sequence`);
    for (const [rowIndex, record] of chunkPayload.provenance.entries()) {
      assert.equal(record?.ingestionSequence, chunkPayload.entries[rowIndex]?.ingestionSequence, `signed chunk ${index} row ${rowIndex}: sequence binding`);
    }
    previousLastSequence = lastSequence;
    reconstructedEntries.push(...chunkPayload.entries);
    reconstructedProvenance.push(...chunkPayload.provenance);
  }
  assert.deepEqual(reconstructedEntries, context.entries, "signed chunks omit, duplicate, reorder, or alter raw entries");
  assert.deepEqual(reconstructedProvenance, context.provenanceRecords, "signed chunks omit, duplicate, reorder, or alter provenance records");
  const reconstructedRawBytes = reconstructedEntries.length === 0 ? "" : `${reconstructedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const reconstructedProvenanceBytes = reconstructedProvenance.length === 0 ? "" : `${reconstructedProvenance.map((record) => JSON.stringify(record)).join("\n")}\n`;
  assert.equal(reconstructedRawBytes, context.rawRecordsBytes.toString("utf8"), "signed chunk/raw-ledger exact-byte reconstruction");
  assert.equal(reconstructedProvenanceBytes, context.provenanceRecordsBytes.toString("utf8"), "signed chunk/provenance exact-byte reconstruction");

  return {
    gateAuthorized: true,
    trustVerdict: "TRUSTED_CURRENT_HEAD",
    operatorKeyId: operator.keyId,
    issuedAt: window.issuedAt,
    expiresAt: window.expiresAt,
    manifestPayloadSha256,
  };
}

const argumentsValue = parseArguments(process.argv.slice(2));
const registrationBytes = readFileSync(join(root, "first-100-registration.json"));
const registration = JSON.parse(registrationBytes.toString("utf8"));
const signature = JSON.parse(readFileSync(join(root, "first-100-registration.signature.json"), "utf8"));
const schemaBytes = readFileSync(join(root, "first-100-entry-v1.schema.json"));
const publicKey = createPublicKey(readFileSync(join(root, "first-100-registration-public.pem")));
const ledgerBytes = readFileSync(argumentsValue.ledger);
const provenanceBytes = readFileSync(argumentsValue.provenance);
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
assert.equal(signature.publicKeyDerSha256, sha256(publicKey.export({ type: "spki", format: "der" })), "public-key digest mismatch");
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
assert.ok(entries.length <= GLOBAL_ROW_CAP, "ledger exceeds global all-row cap");
const ledgerFirstNewline = ledgerBytes.indexOf(0x0a);
assert.ok(ledgerFirstNewline >= 0, "ledger: anchor newline required");
const rawRecordsBytes = ledgerBytes.subarray(ledgerFirstNewline + 1);

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
const channelCounts = new Map();
const publisherCounts = new Map();
const publisherStates = new Map();
const adapterStates = new Map();
const acquisitionHandles = new Set();
const adapterEventIds = new Set();
const snapshotTimes = [];
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
  channelCounts.set(entry.channel, (channelCounts.get(entry.channel) ?? 0) + 1);
  assert.ok(channelCounts.get(entry.channel) <= CHANNEL_ROW_CAP, `line ${line}: channel all-row cap`);
  assert.equal(typeof entry.external, "boolean", `line ${line}: external type`);
  assert.equal(typeof entry.optedIn, "boolean", `line ${line}: consent type`);
  assert.equal(entry.inspectionStarted, false, `line ${line}: every decision must precede inspection`);

  const eligibility = exact(entry.eligibility, ["decision", "decidedAt", "reason"], [], `line ${line}: eligibility`);
  assert.ok(eligibility.decision === "INCLUDED" || eligibility.decision === "EXCLUDED", `line ${line}: decision`);
  const decidedAt = timestamp(eligibility.decidedAt, `line ${line}: decidedAt`);
  assert.ok(decidedAt >= receivedAt, `line ${line}: decision before receipt`);
  assert.ok(eligibility.reason === "ELIGIBLE" || exclusionReasons.has(eligibility.reason), `line ${line}: reason`);

  const pair = exact(entry.pair, ["ecosystem", "componentIdentity", "currentExactIdentity", "candidateExactIdentity", "realUpdateIntent"], [], `line ${line}: pair`);
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
    evaluation = exact(entry.evaluation, ["startedAt", "completedAt", "verdict", "receiptHash", "falseCompatible", "materiality"], [], `line ${line}: evaluation`);
    const startedAt = timestamp(evaluation.startedAt, `line ${line}: startedAt`);
    const completedAt = timestamp(evaluation.completedAt, `line ${line}: completedAt`);
    assert.ok(startedAt >= decidedAt, `line ${line}: inspected before decision`);
    assert.ok(completedAt >= startedAt, `line ${line}: completion order`);
    assert.ok(["SAFE", "CHANGED", "HOLD"].includes(evaluation.verdict), `line ${line}: verdict`);
    boundedText(evaluation.receiptHash, 71, 71, `line ${line}: receipt hash`, SHA256);
    assert.equal(typeof evaluation.falseCompatible, "boolean", `line ${line}: false-compatible type`);
    const materialityRecord = exact(evaluation.materiality, ["classification", "evidenceComplete", "workflowConsequences"], [], `line ${line}: materiality`);
    assert.ok(["MATERIAL", "NON_MATERIAL", "INCONCLUSIVE"].includes(materialityRecord.classification), `line ${line}: classification`);
    assert.equal(typeof materialityRecord.evidenceComplete, "boolean", `line ${line}: evidence completeness type`);
    assert.ok(Array.isArray(materialityRecord.workflowConsequences) && materialityRecord.workflowConsequences.length <= 6, `line ${line}: consequences`);
    assert.equal(new Set(materialityRecord.workflowConsequences).size, materialityRecord.workflowConsequences.length, `line ${line}: duplicate consequence`);
    assert.ok(materialityRecord.workflowConsequences.every((item) => consequences.has(item)), `line ${line}: unsupported consequence`);
    if (materialityRecord.classification === "MATERIAL") {
      assert.notEqual(evaluation.verdict, "HOLD", `line ${line}: HOLD cannot be material`);
      assert.equal(materialityRecord.evidenceComplete, true, `line ${line}: material evidence`);
      assert.ok(materialityRecord.workflowConsequences.length > 0, `line ${line}: material consequence`);
      assert.equal(evaluation.falseCompatible, evaluation.verdict === "SAFE", `line ${line}: false-compatible coherence`);
    } else if (materialityRecord.classification === "NON_MATERIAL") {
      assert.notEqual(evaluation.verdict, "HOLD", `line ${line}: HOLD cannot be non-material`);
      assert.equal(materialityRecord.evidenceComplete, true, `line ${line}: non-material evidence`);
      assert.equal(materialityRecord.workflowConsequences.length, 0, `line ${line}: non-material consequence`);
      assert.equal(evaluation.falseCompatible, false, `line ${line}: non-material false-compatible`);
    } else {
      assert.equal(evaluation.verdict, "HOLD", `line ${line}: inconclusive verdict`);
      assert.equal(materialityRecord.evidenceComplete, false, `line ${line}: inconclusive evidence`);
      assert.equal(materialityRecord.workflowConsequences.length, 0, `line ${line}: inconclusive consequence`);
      assert.equal(evaluation.falseCompatible, false, `line ${line}: inconclusive false-compatible`);
    }
  }

  const provenanceLine = index + 2;
  const sidecar = exact(provenanceRecords[index], [
    "schemaVersion", "kind", "registrationId", "ingestionSequence", "publisher", "frozenEligibility",
    "effectiveEligibility", "acquisition", "chronologyMutable",
  ], [], `provenance line ${provenanceLine}`);
  assert.equal(sidecar.schemaVersion, "agent-vigil-first-100-provenance/v2", `provenance line ${provenanceLine}: schema`);
  assert.equal(sidecar.kind, "publisher-provenance", `provenance line ${provenanceLine}: kind`);
  assert.equal(sidecar.registrationId, registration.registrationId, `provenance line ${provenanceLine}: registration`);
  assert.equal(sidecar.ingestionSequence, entry.ingestionSequence, `provenance line ${provenanceLine}: sequence binding`);
  assert.equal(sidecar.chronologyMutable, false, `provenance line ${provenanceLine}: chronology`);

  const publisher = exact(sidecar.publisher, ["keyId", "status", "statusUpdatedAt"], [], `provenance line ${provenanceLine}: publisher`);
  boundedText(publisher.keyId, 71, 71, `provenance line ${provenanceLine}: publisher key`, SHA256);
  assert.ok(["ACTIVE", "SUSPENDED", "REVOKED"].includes(publisher.status), `provenance line ${provenanceLine}: publisher status`);
  timestamp(publisher.statusUpdatedAt, `provenance line ${provenanceLine}: statusUpdatedAt`);
  snapshotTimes.push(publisher.statusUpdatedAt);
  const existingPublisher = publisherStates.get(publisher.keyId);
  const publisherState = { status: publisher.status, updatedAt: publisher.statusUpdatedAt };
  if (existingPublisher) assert.deepEqual(publisherState, existingPublisher, `provenance line ${provenanceLine}: publisher state consistency`);
  else publisherStates.set(publisher.keyId, publisherState);
  publisherCounts.set(publisher.keyId, (publisherCounts.get(publisher.keyId) ?? 0) + 1);
  assert.ok(publisherCounts.get(publisher.keyId) <= PUBLISHER_ROW_CAP, `provenance line ${provenanceLine}: publisher all-row cap`);

  const frozen = exact(sidecar.frozenEligibility, ["decision", "reason"], [], `provenance line ${provenanceLine}: frozen eligibility`);
  assert.deepEqual(frozen, { decision: eligibility.decision, reason: eligibility.reason }, `provenance line ${provenanceLine}: frozen binding`);
  const effective = exact(sidecar.effectiveEligibility, ["decision", "reason", "gateEligible"], [], `provenance line ${provenanceLine}: effective eligibility`);
  assert.equal(typeof effective.gateEligible, "boolean", `provenance line ${provenanceLine}: gate eligibility type`);

  const acquisition = exact(sidecar.acquisition, ["handle", "rawEventSha256", "trustedAdapter", "registeredBeforeArtifactAccess", "artifactAccessGrantedAt"], [], `provenance line ${provenanceLine}: acquisition`);
  boundedText(acquisition.handle, 36, 36, `provenance line ${provenanceLine}: acquisition handle`, UUID_V4);
  assert.equal(acquisitionHandles.has(acquisition.handle), false, `provenance line ${provenanceLine}: duplicate acquisition handle`);
  acquisitionHandles.add(acquisition.handle);
  boundedText(acquisition.rawEventSha256, 71, 71, `provenance line ${provenanceLine}: raw event hash`, SHA256);
  assert.equal(typeof acquisition.registeredBeforeArtifactAccess, "boolean", `provenance line ${provenanceLine}: access-order type`);
  let trustedAdapter = null;
  if (acquisition.trustedAdapter !== null) {
    trustedAdapter = exact(acquisition.trustedAdapter, ["keyId", "version", "eventId", "observedAt", "status"], [], `provenance line ${provenanceLine}: trusted adapter`);
    boundedText(trustedAdapter.keyId, 71, 71, `provenance line ${provenanceLine}: adapter key`, SHA256);
    assert.notEqual(trustedAdapter.keyId, publisher.keyId, `provenance line ${provenanceLine}: publisher/adapter duty conflict`);
    boundedText(trustedAdapter.version, 1, 80, `provenance line ${provenanceLine}: adapter version`, ADAPTER_VERSION);
    boundedText(trustedAdapter.eventId, 36, 36, `provenance line ${provenanceLine}: adapter event`, UUID_V4);
    assert.equal(adapterEventIds.has(trustedAdapter.eventId), false, `provenance line ${provenanceLine}: duplicate adapter event`);
    adapterEventIds.add(trustedAdapter.eventId);
    const observedAt = timestamp(trustedAdapter.observedAt, `provenance line ${provenanceLine}: adapter observedAt`);
    assert.ok(Date.parse(observedAt) <= Date.parse(receivedAt), `provenance line ${provenanceLine}: adapter observed after registration`);
    assert.ok(Date.parse(observedAt) >= Date.parse(receivedAt) - EXPORT_TTL_MS, `provenance line ${provenanceLine}: stale adapter observation`);
    assert.ok(["ACTIVE", "REVOKED"].includes(trustedAdapter.status), `provenance line ${provenanceLine}: adapter status`);
    const existingAdapter = adapterStates.get(trustedAdapter.keyId);
    if (existingAdapter) {
      assert.deepEqual({ version: trustedAdapter.version, status: trustedAdapter.status }, { version: existingAdapter.version, status: existingAdapter.status }, `provenance line ${provenanceLine}: adapter state consistency`);
      existingAdapter.observedAt.push(observedAt);
    } else {
      adapterStates.set(trustedAdapter.keyId, { version: trustedAdapter.version, status: trustedAdapter.status, observedAt: [observedAt] });
    }
  } else {
    assert.equal(eligibility.decision, "EXCLUDED", `provenance line ${provenanceLine}: untrusted included row`);
    assert.equal(eligibility.reason, "MALFORMED_PREINSPECTION_RECORD", `provenance line ${provenanceLine}: untrusted reason`);
  }

  let accessGrantedAt = null;
  if (acquisition.artifactAccessGrantedAt !== null) {
    accessGrantedAt = timestamp(acquisition.artifactAccessGrantedAt, `provenance line ${provenanceLine}: access grant`);
    snapshotTimes.push(accessGrantedAt);
    assert.equal(eligibility.decision, "INCLUDED", `provenance line ${provenanceLine}: grant for excluded row`);
    assert.ok(trustedAdapter, `provenance line ${provenanceLine}: grant without trusted adapter`);
    assert.ok(Date.parse(accessGrantedAt) >= Date.parse(receivedAt), `provenance line ${provenanceLine}: grant precedes registration`);
  }
  assert.equal(acquisition.registeredBeforeArtifactAccess, accessGrantedAt === null || Date.parse(receivedAt) <= Date.parse(accessGrantedAt), `provenance line ${provenanceLine}: access-order binding`);
  assert.equal(acquisition.registeredBeforeArtifactAccess, true, `provenance line ${provenanceLine}: registration must precede access`);
  if (eligibility.decision === "INCLUDED") assert.ok(trustedAdapter, `provenance line ${provenanceLine}: included row requires an adapter`);
  else assert.equal(accessGrantedAt, null, `provenance line ${provenanceLine}: excluded row cannot have access`);
  if (evaluation) {
    assert.ok(accessGrantedAt, `provenance line ${provenanceLine}: evaluation without access grant`);
    assert.ok(Date.parse(evaluation.startedAt) >= Date.parse(accessGrantedAt), `provenance line ${provenanceLine}: evaluation precedes access grant`);
  }

  const adapterRevoked = trustedAdapter !== null && trustedAdapter.status === "REVOKED";
  const quarantinedRow = publisher.status !== "ACTIVE" || adapterRevoked;
  const expectedEffective = quarantinedRow ? {
    decision: "QUARANTINED",
    reason: publisher.status === "REVOKED" ? "PUBLISHER_REVOKED" : publisher.status === "SUSPENDED" ? "PUBLISHER_SUSPENDED" : "ADAPTER_REVOKED",
    gateEligible: false,
  } : {
    decision: eligibility.decision,
    reason: eligibility.reason,
    gateEligible: eligibility.decision === "INCLUDED",
  };
  assert.deepEqual(effective, expectedEffective, `provenance line ${provenanceLine}: effective eligibility semantics`);
  if (quarantinedRow) quarantined += 1;

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
if (hundredthIncludedIndex >= 0) assert.equal(hundredthIncludedIndex, entries.length - 1, "ledger contains rows after the frozen sample closed");
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

const trust = validateTrustBundle({
  registration,
  registrationSha256: signature.registrationSha256,
  ledgerBytes,
  provenanceBytes,
  rawRecordsBytes,
  provenanceRecordsBytes,
  entries,
  provenanceRecords,
  permittedChannels,
  publisherStates,
  adapterStates,
  snapshotTimes,
  frequencyVerdict,
}, argumentsValue);

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
  gateAuthorized: trust.gateAuthorized,
  trustVerdict: trust.trustVerdict,
  ...(trust.operatorKeyId === null ? {} : {
    operatorKeyId: trust.operatorKeyId,
    headIssuedAt: trust.issuedAt,
    headExpiresAt: trust.expiresAt,
    manifestPayloadSha256: trust.manifestPayloadSha256,
  }),
}, null, 2)}\n`);
