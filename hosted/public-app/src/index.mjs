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

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
  if (!REPOSITORY.test(repository)) throw new Error("repository identity is invalid");
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

async function readBoundedBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_WEBHOOK_BYTES)) throw new Error("webhook body is too large");
  const body = await readStreamBounded(request.body, MAX_WEBHOOK_BYTES, "webhook body");
  if (body.length === 0 || body.length > MAX_WEBHOOK_BYTES) throw new Error("webhook body size is invalid");
  return body;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { status: "ok", service: "agent-vigil-public-app" });
    if (url.pathname !== "/github/webhook" || request.method !== "POST") return json(404, { error: "not found" });
    try {
      assertConfiguration(env);
      const event = request.headers.get("x-github-event") ?? "";
      if (event !== "pull_request" && event !== "merge_group") return json(202, { status: "ignored" });
      const deliveryId = request.headers.get("x-github-delivery") ?? "";
      const body = await readBoundedBody(request);
      if (!(await verifyWebhookSignature(env.WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256") ?? ""))) return json(401, { error: "invalid webhook signature" });
      let payload;
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
      catch { return json(400, { error: "invalid webhook JSON" }); }
      let value;
      try { value = event === "pull_request" ? parsePullRequestPayload(payload, deliveryId) : parseMergeGroupPayload(payload, deliveryId); }
      catch (error) {
        if (/verification trigger/.test(String(error))) return json(202, { status: "ignored" });
        throw error;
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
