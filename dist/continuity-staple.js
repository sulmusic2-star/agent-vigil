// src/continuity/staple.ts
import { createPrivateKey as createPrivateKey2, createPublicKey as createPublicKey2, sign as sign2, verify as verify2 } from "node:crypto";

// src/signature.ts
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";

// src/report.ts
function canonical(value) {
  if (value === void 0) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

// src/signature.ts
function publicKeyDer(key) {
  return key.export({ type: "spki", format: "der" });
}
function signingKeyId(der) {
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

// src/continuity/contracts.ts
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createHash as createHash2 } from "node:crypto";
var CONTINUITY_STATES = ["CURRENT", "HOLD", "EXPIRED", "REVOKED"];
var SHA256 = /^sha256:[0-9a-f]{64}$/;
var GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,79}$/;
var CREDENTIAL_LIKE_IDENTIFIER = /^(?:gh[pousr]_|github_pat_|sk_(?:live|test)_|xox[baprs]-)/;
var MAX_EVENT_BYTES = 1024 * 1024;
var MAX_POLICY_BYTES = 1024 * 1024;
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}
function string(value, label, maximum = 240) {
  if (typeof value !== "string" || !value || value.length > maximum) throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  if (new RegExp("\\p{C}", "u").test(value)) throw new Error(`${label} contains control or format characters`);
  return value;
}
function digest(value, label) {
  const selected = string(value, label, 71);
  if (!SHA256.test(selected)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return selected;
}
function gitSha(value, label) {
  const selected = string(value, label, 64);
  if (!GIT_SHA.test(selected)) throw new Error(`${label} must be a full lowercase Git object ID`);
  return selected;
}
function safeIdentifier(value, label) {
  const selected = string(value, label, 80);
  if (!SAFE_IDENTIFIER.test(selected)) throw new Error(`${label} must be a privacy-safe machine identifier`);
  if (CREDENTIAL_LIKE_IDENTIFIER.test(selected)) throw new Error(`${label} must not contain a credential-like value`);
  return selected;
}
function validateProtectedEnvironment(value) {
  return safeIdentifier(value, "protected environment");
}
function validateContinuitySubject(value) {
  const selected = object(value, "subject");
  exactKeys(selected, ["episodeReceiptHash", "repositoryHash", "baseSha", "headSha"], "subject");
  return {
    episodeReceiptHash: digest(selected.episodeReceiptHash, "subject.episodeReceiptHash"),
    repositoryHash: digest(selected.repositoryHash, "subject.repositoryHash"),
    baseSha: gitSha(selected.baseSha, "subject.baseSha"),
    headSha: gitSha(selected.headSha, "subject.headSha")
  };
}
function sha256(value) {
  return `sha256:${createHash2("sha256").update(value).digest("hex")}`;
}
function canonicalSha256(value) {
  return sha256(canonical(value));
}
function readBoundedRegularFile(path, maximumBytes, label) {
  const absolute = resolve(path);
  const expected = lstatSync(absolute);
  if (expected.isSymbolicLink() || !expected.isFile()) throw new Error(`${label} must be a regular file, not a symbolic link`);
  if (expected.size > maximumBytes) throw new Error(`${label} exceeds the ${maximumBytes} byte limit`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(absolute, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error(`${label} changed while being read`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function readBoundedJson(path, maximumBytes, label) {
  const bytes = readBoundedRegularFile(path, maximumBytes, label);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

// src/continuity/staple.ts
var CONTINUITY_STAPLE_SCHEMA = "agent-vigil-continuity-staple/v1";
var MAX_STAPLE_TTL_SECONDS = 900;
var STAPLE_CLOCK_SKEW_SECONDS = 60;
var SHA2562 = /^sha256:[0-9a-f]{64}$/;
var GIT_SHA2 = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
var BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
var MAX_CONTINUITY_STAPLE_BYTES = 256 * 1024;
function object2(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function exactKeys2(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}
function digest2(value, label) {
  if (typeof value !== "string" || !SHA2562.test(value)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return value;
}
function gitSha2(value, label) {
  if (typeof value !== "string" || !GIT_SHA2.test(value)) throw new Error(`${label} must be a full lowercase Git object ID`);
  return value;
}
function timestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be canonical RFC3339 UTC`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} must be canonical RFC3339 UTC`);
  return value;
}
function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}
function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function base64(value, label, expectedBytes) {
  if (typeof value !== "string" || !value || value.length > 8192 || !BASE64.test(value)) throw new Error(`${label} must be canonical base64`);
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || expectedBytes !== void 0 && decoded.length !== expectedBytes) {
    throw new Error(`${label} has an invalid length or encoding`);
  }
  return decoded;
}
function state(value, label) {
  if (typeof value !== "string" || !CONTINUITY_STATES.includes(value)) throw new Error(`${label} is unsupported`);
  return value;
}
function ed25519PublicKey(der, label) {
  let key;
  try {
    key = createPublicKey2({ key: der, type: "spki", format: "der" });
  } catch {
    throw new Error(`${label} is not a valid public key`);
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${label} must be Ed25519`);
  return key;
}
function parsePayload(value) {
  const selected = object2(value, "continuity staple payload");
  exactKeys2(selected, ["schemaVersion", "subject", "decision", "evidence", "policy", "environment", "issuedAt", "expiresAt"], "continuity staple payload");
  if (selected.schemaVersion !== CONTINUITY_STAPLE_SCHEMA) throw new Error("unsupported continuity staple payload schema");
  const decision = object2(selected.decision, "continuity staple decision");
  exactKeys2(decision, ["continuity", "allowsProtectedAction", "evaluatedAt", "decisionHash"], "continuity staple decision");
  const continuity = state(decision.continuity, "continuity staple decision.continuity");
  const allowsProtectedAction = boolean(decision.allowsProtectedAction, "continuity staple decision.allowsProtectedAction");
  if (allowsProtectedAction !== (continuity === "CURRENT")) throw new Error("continuity staple decision fields are inconsistent");
  const evidence = object2(selected.evidence, "continuity staple evidence");
  exactKeys2(evidence, ["rootHash", "chainTip", "sequence", "eventCount"], "continuity staple evidence");
  const sequence = integer(evidence.sequence, "continuity staple evidence.sequence", 0, 1e5);
  const eventCount = integer(evidence.eventCount, "continuity staple evidence.eventCount", 0, 1e5);
  if (sequence !== eventCount) throw new Error("continuity staple evidence sequence must equal its complete event count");
  const policy = object2(selected.policy, "continuity staple policy");
  exactKeys2(policy, ["sourceHash", "sha256"], "continuity staple policy");
  const issuedAt = timestamp(selected.issuedAt, "continuity staple issuedAt");
  const evaluatedAt = timestamp(decision.evaluatedAt, "continuity staple decision.evaluatedAt");
  if (evaluatedAt !== issuedAt) throw new Error("continuity staple issue time must equal its evaluation time");
  const expiresAt = timestamp(selected.expiresAt, "continuity staple expiresAt");
  const lifetime = (Date.parse(expiresAt) - Date.parse(issuedAt)) / 1e3;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_STAPLE_TTL_SECONDS) {
    throw new Error(`continuity staple lifetime must be from 1 through ${MAX_STAPLE_TTL_SECONDS} seconds`);
  }
  return {
    schemaVersion: CONTINUITY_STAPLE_SCHEMA,
    subject: validateContinuitySubject(selected.subject),
    decision: {
      continuity,
      allowsProtectedAction,
      evaluatedAt,
      decisionHash: digest2(decision.decisionHash, "continuity staple decision.decisionHash")
    },
    evidence: {
      rootHash: digest2(evidence.rootHash, "continuity staple evidence.rootHash"),
      chainTip: digest2(evidence.chainTip, "continuity staple evidence.chainTip"),
      sequence,
      eventCount
    },
    policy: {
      sourceHash: digest2(policy.sourceHash, "continuity staple policy.sourceHash"),
      sha256: digest2(policy.sha256, "continuity staple policy.sha256")
    },
    environment: validateProtectedEnvironment(selected.environment),
    issuedAt,
    expiresAt
  };
}
function loadContinuityStaple(path) {
  return readBoundedJson(path, MAX_CONTINUITY_STAPLE_BYTES, "continuity staple");
}
function parseContinuityStapleJson(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_CONTINUITY_STAPLE_BYTES) {
    throw new Error("continuity staple JSON exceeds the byte limit");
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("continuity staple JSON is malformed");
  }
}
function pinnedPublicKey(options) {
  const hasPath = typeof options.publicKeyPath === "string" && options.publicKeyPath.length > 0;
  const hasPem = typeof options.publicKeyPem === "string" || options.publicKeyPem instanceof Uint8Array;
  if (hasPath === hasPem) throw new Error("provide exactly one pinned continuity public key source");
  let pinned;
  try {
    pinned = hasPath ? createPublicKey2(readBoundedRegularFile(options.publicKeyPath, 64 * 1024, "pinned continuity staple public key")) : createPublicKey2(typeof options.publicKeyPem === "string" ? options.publicKeyPem : Buffer.from(options.publicKeyPem));
  } catch {
    throw new Error("pinned continuity staple public key is invalid");
  }
  if (pinned.asymmetricKeyType !== "ed25519") throw new Error("pinned continuity staple public key must be Ed25519");
  return pinned;
}
function verifyContinuityStaple(input, options) {
  const selected = object2(input, "signed continuity staple");
  exactKeys2(selected, ["schemaVersion", "payload", "payloadHash", "signature"], "signed continuity staple");
  if (selected.schemaVersion !== CONTINUITY_STAPLE_SCHEMA) throw new Error("unsupported signed continuity staple schema");
  const payload = parsePayload(selected.payload);
  const payloadHash = digest2(selected.payloadHash, "continuity staple payloadHash");
  if (canonicalSha256(payload) !== payloadHash) throw new Error("continuity staple payload hash is invalid");
  const signature = object2(selected.signature, "continuity staple signature");
  exactKeys2(signature, ["algorithm", "keyId", "publicKey", "value"], "continuity staple signature");
  if (signature.algorithm !== "Ed25519") throw new Error("continuity staple signature algorithm must be Ed25519");
  const embeddedDer = base64(signature.publicKey, "continuity staple signature.publicKey");
  const embedded = ed25519PublicKey(embeddedDer, "continuity staple embedded key");
  const embeddedId = signingKeyId(publicKeyDer(embedded));
  const keyId = digest2(signature.keyId, "continuity staple signature.keyId");
  if (embeddedId !== keyId) throw new Error("continuity staple key ID does not match its embedded key");
  const pinned = pinnedPublicKey(options);
  if (signingKeyId(publicKeyDer(pinned)) !== keyId) throw new Error("continuity staple signer does not match the pinned public key");
  const signatureValue = base64(signature.value, "continuity staple signature.value", 64);
  if (!verify2(null, Buffer.from(payloadHash), pinned, signatureValue)) throw new Error("continuity staple signature is invalid");
  const expectedHead = gitSha2(options.expectedHead, "expected continuity staple head");
  if (payload.subject.headSha !== expectedHead) throw new Error("continuity staple belongs to a different head commit");
  const expectedReceiptHash = digest2(options.expectedReceiptHash, "expected continuity staple receipt hash");
  if (payload.subject.episodeReceiptHash !== expectedReceiptHash) throw new Error("continuity staple belongs to a different original receipt");
  const expectedEnvironment = validateProtectedEnvironment(options.expectedEnvironment);
  if (payload.environment !== expectedEnvironment) throw new Error("continuity staple belongs to a different protected environment");
  const expectedPolicy = digest2(options.expectedPolicySha256, "expected continuity staple policy hash");
  if (payload.policy.sha256 !== expectedPolicy) throw new Error("continuity staple was evaluated under a different policy");
  if (options.expectedChainTip && payload.evidence.chainTip !== digest2(options.expectedChainTip, "expected continuity staple chain tip")) {
    throw new Error("continuity staple does not match the expected chain tip");
  }
  if (options.minimumSequence !== void 0) {
    const minimumSequence = integer(options.minimumSequence, "minimum continuity staple sequence");
    if (payload.evidence.sequence < minimumSequence) throw new Error("continuity staple predates the minimum accepted evidence sequence");
  }
  const now = options.now ?? /* @__PURE__ */ new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("continuity staple verification time is invalid");
  if (Date.parse(payload.issuedAt) - now.getTime() > STAPLE_CLOCK_SKEW_SECONDS * 1e3) {
    throw new Error("continuity staple is implausibly future-dated");
  }
  const fresh = now.getTime() < Date.parse(payload.expiresAt);
  const effectiveContinuity = payload.decision.continuity === "REVOKED" ? "REVOKED" : fresh ? payload.decision.continuity : "EXPIRED";
  return {
    schemaVersion: "agent-vigil-continuity-staple-verification/v1",
    valid: true,
    fresh,
    signerPinned: true,
    embeddedContinuity: payload.decision.continuity,
    effectiveContinuity,
    allowsProtectedAction: fresh && effectiveContinuity === "CURRENT",
    subject: payload.subject,
    environment: payload.environment,
    policySha256: payload.policy.sha256,
    chainTip: payload.evidence.chainTip,
    sequence: payload.evidence.sequence,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    payloadHash,
    signerKeyId: keyId,
    limits: [
      "This is a short-lived point-in-time status statement, not proof that code is defect-free.",
      "An offline verifier cannot discover a newer status before this staple expires unless it also pins a newer chain tip or minimum sequence."
    ]
  };
}
export {
  CONTINUITY_STAPLE_SCHEMA,
  MAX_CONTINUITY_STAPLE_BYTES,
  STAPLE_CLOCK_SKEW_SECONDS,
  loadContinuityStaple,
  parseContinuityStapleJson,
  verifyContinuityStaple
};
