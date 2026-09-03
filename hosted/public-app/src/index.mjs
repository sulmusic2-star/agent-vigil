const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 64 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ENVIRONMENT = /^[A-Za-z0-9_. /:@+-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DEPLOYMENT_AUTHORIZATION_SCHEMA = "agent-vigil-deployment-authorization/v1";
const DEPLOYMENT_AUTHORIZATION_PAYLOAD = "application/vnd.agent-vigil.deployment-authorization+json;version=1";
const CONTROL_ADMISSION_SCHEMA = "agent-vigil-control-admission/v1";
const CONTROL_ADMISSION_PAYLOAD = "application/vnd.agent-vigil.control-admission+json;version=1";
const DEPLOYMENT_REGISTRATION_SCHEMA = "agent-vigil-deployment-registration/v1";
const DEPLOYMENT_REGISTRATION_CONTEXT = "agent-vigil-deployment-registration/v1\0";

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonical(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return `sha256:${bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function safeText(value, label, maximum) {
  if (typeof value !== "string" || !value || value !== value.trim() || new TextEncoder().encode(value).length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function canonicalTimestamp(value, label) {
  const selected = safeText(value, label, 40);
  const epoch = Date.parse(selected);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== selected) throw new Error(`${label} is invalid`);
  return selected;
}

function canonicalBase64(value, label, maximum = MAX_WEBHOOK_BYTES) {
  if (typeof value !== "string" || !value || value.length > maximum || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  const bytes = decodeBase64(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  if (btoa(binary) !== value) throw new Error(`${label} is invalid`);
  return bytes;
}

function dssePae(payloadType, payload) {
  const type = new TextEncoder().encode(payloadType);
  return concatBytes(new TextEncoder().encode(`DSSEv1 ${type.length} `), type, new TextEncoder().encode(` ${payload.length} `), payload);
}

function deploymentKey(repository, commitSha, environment) {
  return `${repository}\n${commitSha}\n${environment}`;
}

function concatBytes(...values) {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, value));
}

export async function webhookSignature(secret, body) {
  return `sha256=${bytesToHex(await hmac(secret, body))}`;
}

export async function verifyWebhookSignature(secret, body, signature) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = await webhookSignature(secret, body);
  return constantTimeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(signature));
}

export async function registrationSignature(secret, body) {
  const context = new TextEncoder().encode(DEPLOYMENT_REGISTRATION_CONTEXT);
  return `sha256=${bytesToHex(await hmac(secret, concatBytes(context, body)))}`;
}

export async function verifyRegistrationSignature(secret, body, signature) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = await registrationSignature(secret, body);
  return constantTimeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(signature));
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is missing`);
  return value;
}

function installationId(payload) {
  const value = String(payload?.installation?.id ?? "");
  if (!POSITIVE_INTEGER.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("installation ID is invalid");
  return value;
}

function commonIdentity(payload, deliveryId) {
  if (!DELIVERY.test(deliveryId)) throw new Error("delivery ID is invalid");
  const repository = requiredString(payload?.repository?.full_name, "repository.full_name");
  if (!REPOSITORY.test(repository) || repository.includes("..")) throw new Error("repository identity is invalid");
  return { deliveryId, repository, installationId: installationId(payload) };
}

function validBranchName(value, maxLength = 255) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return false;
  if (value === "@" || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (/[\u0000-\u0020\u007f~^:?*\[\\]/.test(value) || value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  return value.split("/").every((component) => component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"));
}

export function parsePullRequestPayload(payload, deliveryId) {
  const baseWasEdited = payload?.action === "edited" && typeof payload?.changes?.base?.ref?.from === "string" && payload.changes.base.ref.from.length > 0;
  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(payload?.action) && !baseWasEdited) {
    throw new Error("pull_request action is not a verification trigger");
  }
  const common = commonIdentity(payload, deliveryId);
  const number = Number(payload?.number);
  const baseSha = requiredString(payload?.pull_request?.base?.sha, "pull_request.base.sha");
  const headSha = requiredString(payload?.pull_request?.head?.sha, "pull_request.head.sha");
  const baseRef = requiredString(payload?.pull_request?.base?.ref, "pull_request.base.ref");
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("pull request number is invalid");
  if (!SHA.test(baseSha) || !SHA.test(headSha) || baseSha === headSha) throw new Error("pull request commit identity is invalid");
  if (!validBranchName(baseRef)) throw new Error("pull request base ref is invalid");
  return { ...common, event: "pull_request", number: String(number), baseSha, headSha, baseRef, headRef: "" };
}

export function parseMergeGroupPayload(payload, deliveryId) {
  if (payload?.action !== "checks_requested") throw new Error("merge_group action is not checks_requested");
  const common = commonIdentity(payload, deliveryId);
  const baseSha = requiredString(payload?.merge_group?.base_sha, "merge_group.base_sha");
  const headSha = requiredString(payload?.merge_group?.head_sha, "merge_group.head_sha");
  const baseRef = requiredString(payload?.merge_group?.base_ref, "merge_group.base_ref");
  const headRef = requiredString(payload?.merge_group?.head_ref, "merge_group.head_ref");
  if (!SHA.test(baseSha) || !SHA.test(headSha) || baseSha === headSha) throw new Error("merge-group commit identity is invalid");
  if (!baseRef.startsWith("refs/heads/") || !validBranchName(baseRef.slice("refs/heads/".length))) throw new Error("merge-group base ref is invalid");
  const branch = baseRef.slice("refs/heads/".length);
  const queueBranch = headRef.startsWith("refs/heads/") ? headRef.slice("refs/heads/".length) : "";
  if (!queueBranch.startsWith(`gh-readonly-queue/${branch}/`) || !validBranchName(queueBranch, 1024)) {
    throw new Error("merge-group head ref is invalid");
  }
  return { ...common, event: "merge_group", number: "", baseSha, headSha, baseRef, headRef };
}

export function parseDeploymentProtectionPayload(payload, deliveryId) {
  if (payload?.action !== "requested") throw new Error("deployment protection rule action is not requested");
  const common = commonIdentity(payload, deliveryId);
  const environment = safeText(payload?.environment, "deployment environment", 255);
  const commitSha = safeText(payload?.sha, "deployment commit SHA", 40);
  const ref = safeText(payload?.ref, "deployment ref", 1024);
  const callback = new URL(safeText(payload?.deployment_callback_url, "deployment callback URL", 2048));
  const callbackMatch = callback.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/deployment_protection_rule$/);
  const runId = callbackMatch?.[3] ?? "";
  if (!ENVIRONMENT.test(environment) || environment.includes("..")) throw new Error("deployment environment is invalid");
  if (!SHA.test(commitSha)) throw new Error("deployment commit SHA is invalid");
  if (callback.origin !== "https://api.github.com" || callback.username || callback.password || callback.search || callback.hash
    || !callbackMatch || `${callbackMatch[1]}/${callbackMatch[2]}` !== common.repository
    || !POSITIVE_INTEGER.test(runId) || !Number.isSafeInteger(Number(runId))) {
    throw new Error("deployment callback URL is invalid");
  }
  if (!validBranchName(ref, 1024) && !(ref.startsWith("refs/heads/") && validBranchName(ref.slice("refs/heads/".length), 1024))) {
    throw new Error("deployment ref is invalid");
  }
  return { ...common, event: "deployment_protection_rule", environment, commitSha, runId, ref };
}

export async function verifyDeploymentAuthorizationEnvelope(value, publicKeyPem, asOf = new Date().toISOString()) {
  exactKeys(value, ["payloadType", "payload", "signatures"], "signed deployment authorization");
  if (value.payloadType !== DEPLOYMENT_AUTHORIZATION_PAYLOAD) throw new Error("deployment authorization payload type is invalid");
  if (!Array.isArray(value.signatures) || value.signatures.length !== 1) throw new Error("deployment authorization must have one signature");
  exactKeys(value.signatures[0], ["keyid", "sig"], "deployment authorization signature");
  const payloadBytes = canonicalBase64(value.payload, "deployment authorization payload");
  const signatureBytes = canonicalBase64(value.signatures[0].sig, "deployment authorization signature", 8192);
  const keyMatch = publicKeyPem.match(/-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/);
  if (!keyMatch) throw new Error("deployment public key must be SPKI PEM");
  const publicKeyDer = decodeBase64(keyMatch[1].replace(/\s/g, ""));
  const keyId = await sha256(publicKeyDer);
  if (value.signatures[0].keyid !== keyId || !DIGEST.test(value.signatures[0].keyid)) {
    throw new Error("deployment authorization key ID does not match the pinned key");
  }
  const key = await crypto.subtle.importKey("spki", publicKeyDer, { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("Ed25519", key, signatureBytes, dssePae(value.payloadType, payloadBytes)))) {
    throw new Error("deployment authorization signature is invalid");
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)); }
  catch { throw new Error("deployment authorization payload must be valid UTF-8 JSON"); }
  exactKeys(payload, [
    "schemaVersion", "issuedAt", "validUntil", "repository", "commitSha", "environment", "admissionHash",
    "artifact", "managedEnvironmentSha256", "trust", "authorizationHash",
  ], "deployment authorization");
  if (payload.schemaVersion !== DEPLOYMENT_AUTHORIZATION_SCHEMA) throw new Error("deployment authorization schema is invalid");
  const issuedAt = canonicalTimestamp(payload.issuedAt, "deployment authorization issuedAt");
  const validUntil = canonicalTimestamp(payload.validUntil, "deployment authorization validUntil");
  const checkedAt = canonicalTimestamp(asOf, "deployment authorization check time");
  const duration = Date.parse(validUntil) - Date.parse(issuedAt);
  if (duration <= 0 || duration > 60 * 60 * 1000) throw new Error("deployment authorization validity is invalid");
  if (Date.parse(checkedAt) < Date.parse(issuedAt) || Date.parse(checkedAt) > Date.parse(validUntil)) {
    throw new Error("deployment authorization is not currently valid");
  }
  const repository = safeText(payload.repository, "deployment repository", 201);
  const commitSha = safeText(payload.commitSha, "deployment commit SHA", 40);
  const environment = safeText(payload.environment, "deployment environment", 255);
  if (!REPOSITORY.test(repository) || repository.includes("..")) throw new Error("deployment repository is invalid");
  if (!SHA.test(commitSha)) throw new Error("deployment commit SHA is invalid");
  if (!ENVIRONMENT.test(environment) || environment.includes("..")) throw new Error("deployment environment is invalid");
  exactKeys(payload.artifact, ["host", "version", "executableSha256"], "deployment authorization artifact");
  if (!['claude', 'codex'].includes(payload.artifact.host)
    || !safeText(payload.artifact.version, "deployment authorization artifact version", 200)
    || !DIGEST.test(payload.artifact.executableSha256)) throw new Error("deployment authorization artifact is invalid");
  exactKeys(payload.trust, ["admissionSignerKeyId", "deploymentSignerKeyId"], "deployment authorization trust");
  if (!DIGEST.test(payload.admissionHash) || !DIGEST.test(payload.managedEnvironmentSha256)
    || !DIGEST.test(payload.trust.admissionSignerKeyId) || payload.trust.deploymentSignerKeyId !== keyId
    || payload.trust.admissionSignerKeyId === keyId || !DIGEST.test(payload.authorizationHash)) {
    throw new Error("deployment authorization trust binding is invalid");
  }
  const withoutHash = { ...payload };
  delete withoutHash.authorizationHash;
  if (payload.authorizationHash !== await sha256(canonical(withoutHash))) throw new Error("deployment authorization hash is invalid");
  return payload;
}

export async function verifyControlAdmissionEnvelope(value, publicKeyPem, asOf = new Date().toISOString()) {
  exactKeys(value, ["payloadType", "payload", "signatures"], "signed control admission");
  if (value.payloadType !== CONTROL_ADMISSION_PAYLOAD) throw new Error("control admission payload type is invalid");
  if (!Array.isArray(value.signatures) || value.signatures.length !== 1) throw new Error("control admission must have one signature");
  exactKeys(value.signatures[0], ["keyid", "sig"], "control admission signature");
  const payloadBytes = canonicalBase64(value.payload, "control admission payload");
  const signatureBytes = canonicalBase64(value.signatures[0].sig, "control admission signature", 8192);
  const keyMatch = publicKeyPem.match(/-----BEGIN PUBLIC KEY-----([\s\S]+?)-----END PUBLIC KEY-----/);
  if (!keyMatch) throw new Error("admission public key must be SPKI PEM");
  const publicKeyDer = decodeBase64(keyMatch[1].replace(/\s/g, ""));
  const keyId = await sha256(publicKeyDer);
  if (value.signatures[0].keyid !== keyId || !DIGEST.test(value.signatures[0].keyid)) {
    throw new Error("control admission key ID does not match the pinned key");
  }
  const key = await crypto.subtle.importKey("spki", publicKeyDer, { name: "Ed25519" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("Ed25519", key, signatureBytes, dssePae(value.payloadType, payloadBytes)))) {
    throw new Error("control admission signature is invalid");
  }
  let payload;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes)); }
  catch { throw new Error("control admission payload must be valid UTF-8 JSON"); }
  exactKeys(payload, [
    "schemaVersion", "evaluatedAt", "validUntil", "decision", "artifact", "environmentSha256", "evidence",
    "trust", "reasonCodes", "limitations", "admissionHash",
  ], "control admission");
  if (payload.schemaVersion !== CONTROL_ADMISSION_SCHEMA || payload.decision !== "APPROVE") {
    throw new Error("control admission is not an APPROVE decision");
  }
  const evaluatedAt = canonicalTimestamp(payload.evaluatedAt, "control admission evaluatedAt");
  const validUntil = canonicalTimestamp(payload.validUntil, "control admission validUntil");
  const checkedAt = canonicalTimestamp(asOf, "control admission check time");
  const duration = Date.parse(validUntil) - Date.parse(evaluatedAt);
  if (duration <= 0 || duration > 60 * 60 * 1000
    || Date.parse(checkedAt) < Date.parse(evaluatedAt) || Date.parse(checkedAt) > Date.parse(validUntil)) {
    throw new Error("control admission is not currently valid");
  }
  exactKeys(payload.artifact, ["host", "version", "executableSha256"], "control admission artifact");
  if (!['claude', 'codex'].includes(payload.artifact.host)
    || !safeText(payload.artifact.version, "control admission artifact version", 200)
    || !DIGEST.test(payload.artifact.executableSha256)) throw new Error("control admission artifact is invalid");
  if (!DIGEST.test(payload.environmentSha256) || !DIGEST.test(payload.admissionHash)) {
    throw new Error("control admission digest is invalid");
  }
  exactKeys(payload.evidence, ["current", "candidate", "routeDecisionHash"], "control admission evidence");
  for (const label of ["current", "candidate"]) {
    exactKeys(payload.evidence[label], ["challengeHash", "observationHash", "routeReceiptHash", "isolationHash"], `control admission ${label} evidence`);
    for (const name of ["challengeHash", "observationHash", "routeReceiptHash", "isolationHash"]) {
      if (!DIGEST.test(payload.evidence[label][name])) throw new Error("control admission evidence digest is invalid");
    }
  }
  if (!DIGEST.test(payload.evidence.routeDecisionHash)) throw new Error("control admission route decision digest is invalid");
  const trustKeys = ["challengeSignerKeyId", "observerSignerKeyId", "routeSignerKeyId", "environmentSignerKeyId", "isolationSignerKeyId", "admissionSignerKeyId"];
  exactKeys(payload.trust, trustKeys, "control admission trust");
  if (trustKeys.some((name) => !DIGEST.test(payload.trust[name]))
    || new Set(trustKeys.map((name) => payload.trust[name])).size !== trustKeys.length
    || payload.trust.admissionSignerKeyId !== keyId) throw new Error("control admission trust binding is invalid");
  if (!Array.isArray(payload.reasonCodes) || payload.reasonCodes.length !== 1
    || payload.reasonCodes[0] !== "EXACT_CONTROL_ADMISSION_PROVEN"
    || !Array.isArray(payload.limitations) || payload.limitations.length < 1 || payload.limitations.length > 32
    || payload.limitations.some((item) => { try { safeText(item, "control admission limitation", 2000); return false; } catch { return true; } })) {
    throw new Error("control admission explanation is invalid");
  }
  const withoutHash = { ...payload };
  delete withoutHash.admissionHash;
  if (payload.admissionHash !== await sha256(canonical(withoutHash))) throw new Error("control admission hash is invalid");
  return { payload, keyId };
}

export async function verifyDeploymentRegistration(value, deploymentPublicKeyPem, admissionPublicKeyPem, asOf = new Date().toISOString()) {
  exactKeys(value, ["schemaVersion", "authorization", "admission"], "deployment registration");
  if (value.schemaVersion !== DEPLOYMENT_REGISTRATION_SCHEMA) throw new Error("deployment registration schema is invalid");
  const authorization = await verifyDeploymentAuthorizationEnvelope(value.authorization, deploymentPublicKeyPem, asOf);
  const admission = await verifyControlAdmissionEnvelope(value.admission, admissionPublicKeyPem, asOf);
  if (Object.values(admission.payload.trust).includes(authorization.trust.deploymentSignerKeyId)) {
    throw new Error("deployment signer must be distinct from every admission trust role");
  }
  if (authorization.admissionHash !== admission.payload.admissionHash
    || authorization.trust.admissionSignerKeyId !== admission.keyId
    || authorization.artifact.host !== admission.payload.artifact.host
    || authorization.artifact.version !== admission.payload.artifact.version
    || authorization.artifact.executableSha256 !== admission.payload.artifact.executableSha256
    || authorization.managedEnvironmentSha256 !== admission.payload.environmentSha256
    || Date.parse(authorization.issuedAt) < Date.parse(admission.payload.evaluatedAt)
    || Date.parse(authorization.validUntil) > Date.parse(admission.payload.validUntil)) {
    throw new Error("deployment authorization does not match the pinned control admission");
  }
  return authorization;
}

export function canonicalDispatch(value) {
  return [
    "agent-vigil-public-app-v1",
    value.deliveryId,
    value.event,
    value.repository,
    value.installationId,
    value.number,
    value.baseSha,
    value.headSha,
    value.baseRef,
    value.headRef,
    value.checkRunId,
  ].join("\n");
}

export function dispatchEnvelope(value) {
  const payload = {
    schema: "agent-vigil-public-app-v1",
    deliveryId: value.deliveryId,
    event: value.event,
    repository: value.repository,
    installationId: value.installationId,
    number: value.number,
    baseSha: value.baseSha,
    headSha: value.headSha,
    baseRef: value.baseRef,
    headRef: value.headRef,
    checkRunId: value.checkRunId,
  };
  return base64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

export async function dispatchSignature(secret, value) {
  return `sha256=${bytesToHex(await hmac(secret, new TextEncoder().encode(dispatchEnvelope(value))))}`;
}

function derLength(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("DER length is invalid");
  if (length < 128) return new Uint8Array([length]);
  const bytes = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag, value) { return concatBytes(new Uint8Array([tag]), derLength(value.length), value); }

export function githubPrivateKeyPkcs8Bytes(pem) {
  const pkcs8 = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (pkcs8) return decodeBase64(pkcs8[1].replace(/\s/g, ""));
  const pkcs1 = pem.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/);
  if (!pkcs1) throw new Error("GitHub App private key must be unencrypted PKCS#8 or RSA PKCS#1 PEM");
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return der(0x30, concatBytes(version, algorithm, der(0x04, decodeBase64(pkcs1[1].replace(/\s/g, "")))));
}

async function appJwt(appId, privateKey) {
  if (!POSITIVE_INTEGER.test(appId)) throw new Error("GitHub App ID is invalid");
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => base64Url(new TextEncoder().encode(value));
  const unsigned = `${encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }))}`;
  const key = await crypto.subtle.importKey("pkcs8", githubPrivateKeyPkcs8Bytes(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function readStreamBounded(stream, limit, label) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel(`${label} exceeded ${limit} bytes`); throw new Error(`${label} is too large`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function github(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "agent-vigil-public-app/1", "x-github-api-version": "2026-03-10", ...options.headers },
  });
  const body = new TextDecoder().decode(await readStreamBounded(response.body, MAX_GITHUB_RESPONSE_BYTES, "GitHub response"));
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}: ${body.slice(0, 256)}`);
  return body ? JSON.parse(body) : undefined;
}

async function installationToken(appId, privateKey, id, permissions) {
  const jwt = await appJwt(appId, privateKey);
  const result = await github(`/app/installations/${id}/access_tokens`, jwt, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permissions }),
  });
  if (typeof result?.token !== "string" || result.token.length < 20) throw new Error("GitHub did not return an installation token");
  return result.token;
}

async function queueCheckAndDispatch(env, value) {
  const targetToken = await installationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, value.installationId, { checks: "write", contents: "read", pull_requests: "read" });
  const [owner, repository] = value.repository.split("/");
  const check = await github(`/repos/${owner}/${repository}/check-runs`, targetToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Agent Vigil",
      head_sha: value.headSha,
      status: "queued",
      external_id: `${value.event}:${value.deliveryId}:${value.headSha}`,
      output: { title: "NOT CHECKED", summary: "Agent Vigil is waiting for the independent exact-commit verification run." },
    }),
  });
  if (!POSITIVE_INTEGER.test(String(check?.id ?? ""))) throw new Error("GitHub did not return a check run ID");
  const dispatched = { ...value, checkRunId: String(check.id) };
  try {
    const controlToken = await installationToken(env.CONTROL_APP_ID, env.CONTROL_APP_PRIVATE_KEY, env.CONTROL_INSTALLATION_ID, { actions: "write" });
    const [controlOwner, controlRepository] = env.CONTROL_REPOSITORY.split("/");
    await github(`/repos/${controlOwner}/${controlRepository}/actions/workflows/${encodeURIComponent(env.CONTROL_WORKFLOW)}/dispatches`, controlToken, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ref: env.CONTROL_REF,
        inputs: { envelope: dispatchEnvelope(dispatched), dispatchSignature: await dispatchSignature(env.DISPATCH_SECRET, dispatched) },
      }),
    });
  } catch (error) {
    try {
      await github(`/repos/${owner}/${repository}/check-runs/${check.id}`, targetToken, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status: "completed",
          conclusion: "failure",
          output: {
            title: "NOT CHECKED",
            summary: "The independent verification run did not start. Push or reopen the pull request to retry.",
          },
        }),
      });
    } catch (completionError) {
      console.error(JSON.stringify({ event: "public_app_check_completion_failed", message: String(completionError), check_run_id: String(check.id) }));
    }
    throw error;
  }
  return dispatched;
}

function assertConfiguration(env) {
  for (const name of ["WEBHOOK_SECRET", "DISPATCH_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "CONTROL_APP_ID", "CONTROL_APP_PRIVATE_KEY", "CONTROL_INSTALLATION_ID", "CONTROL_REPOSITORY", "CONTROL_WORKFLOW", "CONTROL_REF"]) {
    if (typeof env[name] !== "string" || env[name].length === 0) throw new Error(`missing Worker binding ${name}`);
  }
  if (env.WEBHOOK_SECRET.length < 32 || env.DISPATCH_SECRET.length < 32) throw new Error("App secrets must contain at least 32 characters");
  if (!POSITIVE_INTEGER.test(env.CONTROL_INSTALLATION_ID)) throw new Error("CONTROL_INSTALLATION_ID is invalid");
  if (!REPOSITORY.test(env.CONTROL_REPOSITORY)) throw new Error("CONTROL_REPOSITORY is invalid");
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(env.CONTROL_WORKFLOW)) throw new Error("CONTROL_WORKFLOW is invalid");
  if (!/^[A-Za-z0-9._/-]+$/.test(env.CONTROL_REF)) throw new Error("CONTROL_REF is invalid");
}

function assertDeploymentConfiguration(env) {
  for (const name of ["WEBHOOK_SECRET", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "DEPLOYMENT_PUBLIC_KEY_PEM"]) {
    if (typeof env[name] !== "string" || env[name].length === 0) throw new Error(`missing Worker binding ${name}`);
  }
  if (env.WEBHOOK_SECRET.length < 32) throw new Error("App webhook secret must contain at least 32 characters");
  if (!env.DEPLOYMENT_AUTHORIZATIONS?.idFromName || !env.DEPLOYMENT_AUTHORIZATIONS?.get) {
    throw new Error("missing Worker binding DEPLOYMENT_AUTHORIZATIONS");
  }
}

function assertAuthorizationRegistrationConfiguration(env) {
  for (const name of ["DEPLOYMENT_PUBLIC_KEY_PEM", "ADMISSION_PUBLIC_KEY_PEM", "REGISTRATION_SECRET"]) {
    if (typeof env[name] !== "string" || !env[name]) throw new Error(`missing Worker binding ${name}`);
  }
  if (env.REGISTRATION_SECRET.length < 32) throw new Error("registration secret must contain at least 32 characters");
  if (!env.DEPLOYMENT_AUTHORIZATIONS?.idFromName || !env.DEPLOYMENT_AUTHORIZATIONS?.get) {
    throw new Error("missing Worker binding DEPLOYMENT_AUTHORIZATIONS");
  }
}

async function readBoundedBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_WEBHOOK_BYTES)) throw new Error("webhook body is too large");
  const body = await readStreamBounded(request.body, MAX_WEBHOOK_BYTES, "webhook body");
  if (body.length === 0 || body.length > MAX_WEBHOOK_BYTES) throw new Error("webhook body size is invalid");
  return body;
}

function hasJsonContentType(request) {
  const value = request.headers.get("content-type") ?? "";
  return /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(value);
}

export class DeliveryLedger {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    const value = await request.json();
    const prior = await this.state.storage.get("dispatch");
    if (prior?.status === "dispatched" || prior?.status === "pending") return json(202, prior);
    await this.state.storage.put("dispatch", { status: "pending", delivery_id: value.deliveryId });
    try {
      const dispatched = await queueCheckAndDispatch(this.env, value);
      const result = { status: "dispatched", delivery_id: value.deliveryId, check_run_id: dispatched.checkRunId };
      await this.state.storage.put("dispatch", result);
      return json(202, result);
    } catch (error) {
      await this.state.storage.put("dispatch", { status: "failed", delivery_id: value.deliveryId });
      throw error;
    }
  }
}

async function decideDeployment(env, event, authorization) {
  const now = new Date().toISOString();
  let state = "rejected";
  let comment = "Agent Vigil rejected this deployment because no current signed authorization matched the repository, commit, and environment.";
  if (authorization
    && authorization.repository === event.repository
    && authorization.commitSha === event.commitSha
    && authorization.environment === event.environment
    && Date.parse(now) >= Date.parse(authorization.issuedAt)
    && Date.parse(now) <= Date.parse(authorization.validUntil)) {
    state = "approved";
    comment = `Agent Vigil approved authorization ${authorization.authorizationHash} for this exact repository, commit, and environment. The deployment job must still verify the admitted artifact bytes.`;
  }
  const token = await installationToken(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, event.installationId, { actions: "read", deployments: "write" });
  const [owner, repository] = event.repository.split("/");
  await github(`/repos/${owner}/${repository}/actions/runs/${event.runId}/deployment_protection_rule`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment_name: event.environment, state, comment }),
  });
  console.log(JSON.stringify({
    event: "deployment_protection_decision",
    state,
    delivery_id: event.deliveryId,
    repository: event.repository,
    commit_sha: event.commitSha,
    environment: event.environment,
    run_id: event.runId,
    authorization_hash: authorization?.authorizationHash ?? null,
    decided_at: now,
  }));
  return { status: "decided", delivery_id: event.deliveryId, state, authorization_hash: authorization?.authorizationHash ?? null };
}

export class DeploymentAuthorizationLedger {
  constructor(state, env) { this.state = state; this.env = env; this.inFlight = new Map(); }
  async fetch(request) {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    const value = await request.json();
    if (value?.operation === "register") {
      const prior = await this.state.storage.get("authorization");
      if (prior && prior.authorizationHash !== value.authorization.authorizationHash
        && Date.parse(value.authorization.issuedAt) <= Date.parse(prior.issuedAt)) {
        return json(409, { error: "an equal or newer authorization is already registered for this deployment identity" });
      }
      await this.state.storage.put("authorization", value.authorization);
      if (this.state.storage.setAlarm) await this.state.storage.setAlarm(Date.parse(value.authorization.validUntil) + 24 * 60 * 60 * 1000);
      console.log(JSON.stringify({
        event: "deployment_authorization_registered",
        repository: value.authorization.repository,
        commit_sha: value.authorization.commitSha,
        environment: value.authorization.environment,
        authorization_hash: value.authorization.authorizationHash,
        issued_at: value.authorization.issuedAt,
        valid_until: value.authorization.validUntil,
      }));
      return json(201, { status: "registered", authorization_hash: value.authorization.authorizationHash });
    }
    if (value?.operation === "decide") {
      const decisionKey = `decision:${value.event.deliveryId}`;
      const prior = await this.state.storage.get(decisionKey);
      if (prior) return json(200, prior);
      const existing = this.inFlight.get(decisionKey);
      if (existing) return json(200, await existing);
      const pending = (async () => {
        const authorization = await this.state.storage.get("authorization");
        const result = await decideDeployment(this.env, value.event, authorization);
        await this.state.storage.put(decisionKey, result);
        return result;
      })();
      this.inFlight.set(decisionKey, pending);
      try { return json(200, await pending); }
      finally { this.inFlight.delete(decisionKey); }
    }
    return json(400, { error: "invalid deployment ledger operation" });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { status: "ok", service: "agent-vigil-public-app" });
    if (url.pathname === "/deployment/authorizations" && request.method === "POST") {
      try {
        assertAuthorizationRegistrationConfiguration(env);
        if (!hasJsonContentType(request)) return json(415, { error: "deployment registration must be application/json" });
        const body = await readBoundedBody(request);
        if (!(await verifyRegistrationSignature(
          env.REGISTRATION_SECRET,
          body,
          request.headers.get("x-agent-vigil-registration-signature") ?? "",
        ))) return json(401, { error: "invalid registration signature" });
        let registration;
        try { registration = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
        catch { return json(400, { error: "invalid authorization JSON" }); }
        const authorization = await verifyDeploymentRegistration(
          registration, env.DEPLOYMENT_PUBLIC_KEY_PEM, env.ADMISSION_PUBLIC_KEY_PEM,
        );
        const id = env.DEPLOYMENT_AUTHORIZATIONS.idFromName(deploymentKey(
          authorization.repository, authorization.commitSha, authorization.environment,
        ));
        return await env.DEPLOYMENT_AUTHORIZATIONS.get(id).fetch("https://deployment-ledger.internal/authorization", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "register", authorization }),
        });
      } catch (error) {
        console.error(JSON.stringify({ event: "deployment_authorization_registration_failed", message: String(error) }));
        return json(400, { error: "Agent Vigil rejected the deployment authorization" });
      }
    }
    if (url.pathname !== "/github/webhook" || request.method !== "POST") return json(404, { error: "not found" });
    try {
      const event = request.headers.get("x-github-event") ?? "";
      if (event !== "pull_request" && event !== "merge_group" && event !== "deployment_protection_rule") return json(202, { status: "ignored" });
      if (event === "deployment_protection_rule") assertDeploymentConfiguration(env);
      else assertConfiguration(env);
      if (!hasJsonContentType(request)) return json(415, { error: "GitHub webhook must be application/json" });
      const deliveryId = request.headers.get("x-github-delivery") ?? "";
      const body = await readBoundedBody(request);
      if (!(await verifyWebhookSignature(env.WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256") ?? ""))) return json(401, { error: "invalid webhook signature" });
      let payload;
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch { return json(400, { error: "invalid webhook JSON" }); }
      let value;
      try {
        value = event === "pull_request" ? parsePullRequestPayload(payload, deliveryId)
          : event === "merge_group" ? parseMergeGroupPayload(payload, deliveryId)
            : parseDeploymentProtectionPayload(payload, deliveryId);
      }
      catch (error) {
        if (/verification trigger/.test(String(error))) return json(202, { status: "ignored" });
        throw error;
      }
      if (event === "deployment_protection_rule") {
        const id = env.DEPLOYMENT_AUTHORIZATIONS.idFromName(deploymentKey(value.repository, value.commitSha, value.environment));
        return await env.DEPLOYMENT_AUTHORIZATIONS.get(id).fetch("https://deployment-ledger.internal/decision", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ operation: "decide", event: value }),
        });
      }
      const id = env.DELIVERY_LEDGER.idFromName(value.deliveryId.toLowerCase());
      return await env.DELIVERY_LEDGER.get(id).fetch("https://ledger.internal/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "public_app_dispatch_failed", message: String(error) }));
      return json(500, { error: "Agent Vigil dispatch failed" });
    }
  },
};
