// Only the protected publisher knows the signing secret. This is an authenticated
// service message, not a portable signature or evidence from candidate code.
export const RESULT_CONTEXT = "agent-vigil-check-result/v1\0";
const KEYS = ["schema", "deliveryId", "repository", "installationId", "baseSha", "headSha",
  "checkRunId", "runId", "runAttempt", "verdict", "receiptHash", "prBodySha256"];

export function parseCheckResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join() !== [...KEYS].sort().join()
    || KEYS.some((key) => typeof value[key] !== "string")) throw new Error("invalid result fields");
  if (value.schema !== "agent-vigil-check-result/v1"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.deliveryId)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) || value.repository.includes("..")
    || ![value.baseSha, value.headSha].every((sha) => /^[0-9a-f]{40}$/.test(sha)) || value.baseSha === value.headSha
    || ![value.installationId, value.checkRunId, value.runId, value.runAttempt]
      .every((id) => /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id)))
    || !["PASS", "FAIL", "NOT CHECKED"].includes(value.verdict)
    || (value.receiptHash !== "" && !/^sha256:[0-9a-f]{64}$/.test(value.receiptHash))
    || (value.prBodySha256 !== "" && !/^[0-9a-f]{64}$/.test(value.prBodySha256))
    || (value.verdict === "PASS" && !value.receiptHash)) throw new Error("invalid result identity or verdict");
  return Object.fromEntries(KEYS.map((key) => [key, value[key]]));
}

export function sameCheckResult(left, right) {
  return KEYS.every((key) => left?.[key] === right?.[key]);
}

export async function checkResultSignature(secret, bytes) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("result secret is missing or too short");
  const context = new TextEncoder().encode(RESULT_CONTEXT);
  const message = new Uint8Array(context.length + bytes.length);
  message.set(context); message.set(bytes, context.length);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  return `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyCheckResultSignature(secret, bytes, signature) {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = await checkResultSignature(secret, bytes);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return difference === 0;
}

export function resultOutput(verdict) {
  return { title: verdict, summary: verdict === "PASS"
    ? "Independent verification passed for the exact current commit."
    : verdict === "FAIL" ? "Independent verification found a blocking contradiction."
    : "Required verification was missing, stale or timed out. A repository maintainer can select Re-run for fresh verification; no new commit is needed." };
}
