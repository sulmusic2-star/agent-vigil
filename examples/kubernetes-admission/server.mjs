import { createServer } from "node:https";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { parseContinuityStapleJson, verifyContinuityStaple } from "./continuity-staple.mjs";

const MAX_REVIEW_BYTES = 1024 * 1024;
const MAX_ANNOTATION_BYTES = 16 * 1024;
const STAPLE_ANNOTATION = "agent-vigil.dev/continuity-staple";
const bindings = JSON.parse(readFileSync(process.env.BINDINGS_PATH, "utf8"));
const publicKeyPem = readFileSync(process.env.PUBLIC_KEY_PATH);

function response(uid, allowed, reasonCode, message) {
  return {
    apiVersion: "admission.k8s.io/v1",
    kind: "AdmissionReview",
    response: {
      uid,
      allowed,
      status: { code: allowed ? 200 : 403, reason: reasonCode, message },
      auditAnnotations: { "agent-vigil.dev/result": reasonCode },
    },
  };
}

function reasonFor(state) {
  if (state === "REVOKED") return ["LATER_EVIDENCE_REVOKED", "Later evidence revoked the earlier approval."];
  if (state === "EXPIRED") return ["STAPLE_EXPIRED", "The signed status is no longer fresh."];
  if (state === "HOLD") return ["EVIDENCE_HOLD", "Required evidence is unavailable or unresolved."];
  return ["CURRENT_STAPLE", "A fresh pinned status matches this exact change."];
}

function decodeStaple(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_ANNOTATION_BYTES) throw new Error("invalid annotation");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("invalid annotation");
  return parseContinuityStapleJson(bytes.toString("utf8"));
}

const server = createServer({
  key: readFileSync(process.env.TLS_KEY_PATH),
  cert: readFileSync(process.env.TLS_CERT_PATH),
}, (request, reply) => {
  const requestPath = new URL(request.url ?? "/", "https://localhost").pathname;
  if (request.method === "GET" && requestPath === "/healthz") {
    reply.writeHead(200, { "content-type": "text/plain" });
    reply.end("ok\n");
    return;
  }
  if (request.method !== "POST" || requestPath !== "/validate") {
    reply.writeHead(404, { "content-type": "text/plain" });
    reply.end("not found\n");
    return;
  }
  const started = performance.now();
  let size = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_REVIEW_BYTES) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    let uid = "";
    let result;
    let reasonCode = "STAPLE_INVALID";
    try {
      const review = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      uid = typeof review?.request?.uid === "string" ? review.request.uid : "";
      if (!uid) throw new Error("missing uid");
      const encoded = review?.request?.object?.metadata?.annotations?.[STAPLE_ANNOTATION];
      const verified = verifyContinuityStaple(decodeStaple(encoded), { publicKeyPem, ...bindings });
      [reasonCode] = reasonFor(verified.effectiveContinuity);
      result = response(uid, verified.allowsProtectedAction, reasonCode, `${reasonCode}: ${reasonFor(verified.effectiveContinuity)[1]}`);
    } catch {
      result = response(uid, false, reasonCode, `${reasonCode}: The signed status could not be verified.`);
    }
    const body = Buffer.from(JSON.stringify(result));
    reply.writeHead(200, { "content-type": "application/json", "content-length": String(body.length) });
    reply.end(body);
    process.stdout.write(`${JSON.stringify({ event: "admission", reasonCode, durationMilliseconds: Number((performance.now() - started).toFixed(4)) })}\n`);
  });
});

server.requestTimeout = 2_000;
server.headersTimeout = 2_000;
server.listen(8443, "0.0.0.0", () => process.stdout.write('{"event":"ready"}\n'));
