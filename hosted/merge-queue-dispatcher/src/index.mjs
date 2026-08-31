const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_GITHUB_RESPONSE_BYTES = 64 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

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

function utf8Base64Url(value) {
  return base64Url(new TextEncoder().encode(value));
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function concatBytes(...values) {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
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

export function canonicalDispatch(value) {
  return [
    "agent-vigil-merge-group-v1",
    value.deliveryId,
    value.repository,
    value.baseSha,
    value.headSha,
    value.baseRef,
    value.headRef,
  ].join("\n");
}

export async function dispatchSignature(secret, value) {
  return `sha256=${bytesToHex(await hmac(secret, new TextEncoder().encode(canonicalDispatch(value))))}`;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is missing`);
  return value;
}

export function parseMergeGroupPayload(payload, deliveryId, expectedRepository, expectedBaseRef) {
  if (!DELIVERY.test(deliveryId)) throw new Error("delivery ID is invalid");
  if (payload?.action !== "checks_requested") throw new Error("merge_group action is not checks_requested");

  const repository = requiredString(payload?.repository?.full_name, "repository.full_name");
  const baseSha = requiredString(payload?.merge_group?.base_sha, "merge_group.base_sha");
  const headSha = requiredString(payload?.merge_group?.head_sha, "merge_group.head_sha");
  const baseRef = requiredString(payload?.merge_group?.base_ref, "merge_group.base_ref");
  const headRef = requiredString(payload?.merge_group?.head_ref, "merge_group.head_ref");
  const installationId = String(payload?.installation?.id ?? "");

  if (!REPOSITORY.test(repository) || repository !== expectedRepository) throw new Error("repository is not allowed");
  if (!SHA.test(baseSha) || !SHA.test(headSha) || baseSha === headSha) throw new Error("merge-group commit identity is invalid");
  if (baseRef !== expectedBaseRef) throw new Error("merge-group base ref is not allowed");
  const queuePrefix = `refs/heads/gh-readonly-queue/${expectedBaseRef.replace("refs/heads/", "")}/`;
  if (!headRef.startsWith(queuePrefix) || headRef.length > 255 || /[\u0000-\u001f\u007f]/.test(headRef)) {
    throw new Error("merge-group head ref is invalid");
  }
  if (!POSITIVE_INTEGER.test(installationId) || !Number.isSafeInteger(Number(installationId))) {
    throw new Error("installation ID is invalid");
  }

  return { deliveryId, repository, baseSha, headSha, baseRef, headRef, installationId };
}

function derLength(length) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("DER length is invalid");
  if (length < 128) return new Uint8Array([length]);
  const bytes = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value % 256);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag, value) {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

export function githubPrivateKeyPkcs8Bytes(pem) {
  const pkcs8 = pem.match(/-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/);
  if (pkcs8) return decodeBase64(pkcs8[1].replace(/\s/g, ""));

  const pkcs1 = pem.match(/-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/);
  if (!pkcs1) {
    throw new Error("GitHub App private key must be unencrypted PKCS#8 or RSA PKCS#1 PEM");
  }
  const rsaPrivateKey = decodeBase64(pkcs1[1].replace(/\s/g, ""));
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaEncryptionAlgorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  return der(0x30, concatBytes(version, rsaEncryptionAlgorithm, der(0x04, rsaPrivateKey)));
}

async function appJwt(appId, privateKey) {
  if (!POSITIVE_INTEGER.test(appId)) throw new Error("GitHub App ID is invalid");
  const now = Math.floor(Date.now() / 1000);
  const header = utf8Base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = utf8Base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    githubPrivateKeyPkcs8Bytes(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function github(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "agent-vigil-merge-queue-dispatcher/1",
      "x-github-api-version": "2026-03-10",
      ...options.headers,
    },
  });
  const body = new TextDecoder().decode(await readStreamBounded(response.body, MAX_GITHUB_RESPONSE_BYTES, "GitHub response"));
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}: ${body.slice(0, 256)}`);
  }
  return body.length > 0 ? JSON.parse(body) : undefined;
}

async function installationToken(env, value) {
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const result = await github(`/app/installations/${value.installationId}/access_tokens`, jwt, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permissions: { actions: "write", checks: "write", contents: "read" } }),
  });
  if (typeof result?.token !== "string" || result.token.length < 20) throw new Error("GitHub did not return an installation token");
  return result.token;
}

export async function dispatchMergeGroup(env, value) {
  const token = await installationToken(env, value);
  const signature = await dispatchSignature(env.DISPATCH_SECRET, value);
  const [owner, repository] = value.repository.split("/");
  await github(`/repos/${owner}/${repository}/actions/workflows/${encodeURIComponent(env.WORKFLOW_FILE)}/dispatches`, token, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ref: env.TRUSTED_REF,
      inputs: {
        delivery_id: value.deliveryId,
        repository: value.repository,
        base_sha: value.baseSha,
        head_sha: value.headSha,
        base_ref: value.baseRef,
        head_ref: value.headRef,
        dispatch_signature: signature,
      },
    }),
  });
}

function assertConfiguration(env) {
  const required = [
    "WEBHOOK_SECRET",
    "DISPATCH_SECRET",
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "ALLOWED_REPOSITORY",
    "ALLOWED_BASE_REF",
    "WORKFLOW_FILE",
    "TRUSTED_REF",
  ];
  for (const name of required) {
    if (typeof env[name] !== "string" || env[name].length === 0) throw new Error(`missing Worker binding ${name}`);
  }
  if (env.WEBHOOK_SECRET.length < 32 || env.DISPATCH_SECRET.length < 32) throw new Error("dispatcher secrets must contain at least 32 characters");
  if (!REPOSITORY.test(env.ALLOWED_REPOSITORY)) throw new Error("ALLOWED_REPOSITORY is invalid");
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(env.ALLOWED_BASE_REF)) throw new Error("ALLOWED_BASE_REF is invalid");
  if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(env.WORKFLOW_FILE)) throw new Error("WORKFLOW_FILE is invalid");
  if (!/^[A-Za-z0-9._/-]+$/.test(env.TRUSTED_REF)) throw new Error("TRUSTED_REF is invalid");
}

async function readBoundedBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_WEBHOOK_BYTES)) {
    throw new Error("webhook body is too large");
  }
  const body = await readStreamBounded(request.body, MAX_WEBHOOK_BYTES, "webhook body");
  if (body.length === 0 || body.length > MAX_WEBHOOK_BYTES) throw new Error("webhook body size is invalid");
  return body;
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
      if (total > limit) {
        await reader.cancel(`${label} exceeded ${limit} bytes`);
        throw new Error(`${label} is too large`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export class DeliveryLedger {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    if (request.method !== "POST") return json(405, { error: "method not allowed" });
    const value = await request.json();
    const prior = await this.state.storage.get("dispatch");
    if (prior?.status === "dispatched" || prior?.status === "pending") {
      return json(202, { status: prior.status, delivery_id: value.deliveryId });
    }

    await this.state.storage.put("dispatch", { status: "pending", at: new Date().toISOString() });
    try {
      await dispatchMergeGroup(this.env, value);
      await this.state.storage.put("dispatch", { status: "dispatched", at: new Date().toISOString() });
      return json(202, { status: "dispatched", delivery_id: value.deliveryId });
    } catch (error) {
      await this.state.storage.put("dispatch", { status: "failed", at: new Date().toISOString() });
      throw error;
    }
  }
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/health") return json(200, { status: "ok" });
    if (new URL(request.url).pathname !== "/github/merge-group" || request.method !== "POST") {
      return json(404, { error: "not found" });
    }

    try {
      assertConfiguration(env);
      if (request.headers.get("x-github-event") !== "merge_group") return json(400, { error: "unsupported GitHub event" });
      const deliveryId = request.headers.get("x-github-delivery") ?? "";
      const signature = request.headers.get("x-hub-signature-256") ?? "";
      const body = await readBoundedBody(request);
      if (!(await verifyWebhookSignature(env.WEBHOOK_SECRET, body, signature))) return json(401, { error: "invalid webhook signature" });

      let payload;
      try {
        payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        return json(400, { error: "invalid webhook JSON" });
      }
      const value = parseMergeGroupPayload(payload, deliveryId, env.ALLOWED_REPOSITORY, env.ALLOWED_BASE_REF);
      const id = env.DELIVERY_LEDGER.idFromName(value.deliveryId.toLowerCase());
      return await env.DELIVERY_LEDGER.get(id).fetch("https://ledger.internal/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    } catch (error) {
      console.error(JSON.stringify({ event: "merge_group_dispatch_failed", message: String(error) }));
      return json(500, { error: "merge-group dispatch failed" });
    }
  },
};
