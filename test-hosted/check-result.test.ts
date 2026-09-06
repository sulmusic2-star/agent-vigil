import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import worker, { DeliveryLedger, dispatchEnvelope, dispatchSignature, webhookSignature } from "../hosted/public-app/src/index.mjs";
import { checkResultSignature, parseCheckResult, verifyCheckResultSignature, resultOutput } from "../hosted/public-app/src/check-result.mjs";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = { GITHUB_APP_ID: "1001", GITHUB_APP_PRIVATE_KEY: pem, CONTROL_APP_ID: "1002", CONTROL_APP_PRIVATE_KEY: pem,
  CONTROL_INSTALLATION_ID: "1003", CONTROL_REPOSITORY: "test/control", CONTROL_WORKFLOW: "public-app-gate.yml", CONTROL_REF: "main",
  WEBHOOK_SECRET: "test-webhook-secret-with-at-least-thirty-two-characters", DISPATCH_SECRET: "test-result-secret-with-at-least-thirty-two-characters" };
const identity = { deliveryId: "550e8400-e29b-41d4-a716-446655440000", repository: "test/repo", installationId: "23456",
  event: "pull_request", number: "17", baseSha: "1".repeat(40), headSha: "2".repeat(40), baseRef: "main", headRef: "" };
const expected = { schema: "agent-vigil-check-result/v1", deliveryId: identity.deliveryId, repository: identity.repository,
  installationId: identity.installationId, baseSha: identity.baseSha, headSha: identity.headSha, checkRunId: "34567",
  runId: "98765", runAttempt: "1", verdict: "PASS", receiptHash: `sha256:${"3".repeat(64)}`,
  prBodySha256: createHash("sha256").update("reviewed body").digest("hex") };
const request = (value: any, path = "/result") => new Request(`https://ledger.internal${path}`, { method: "POST", body: JSON.stringify(value) });

// Transactional test storage; these tests are not a live GitHub or Workers result.
function storageState() {
  const data = new Map<string, any>(); let tail = Promise.resolve(), wake = 0;
  const storage = {
    async get(k: string) { return structuredClone(data.get(k)); },
    async put(k: string, v: any) { data.set(k, structuredClone(v)); },
    async setAlarm(v: number) { wake = v; },
    async getAlarm() { return wake; },
    async deleteAll() { data.clear(); wake = 0; },
    async transaction(fn: (tx: any) => any) {
      const previous = tail; let release!: () => void; tail = new Promise<void>((r) => { release = r; }); await previous;
      const old = structuredClone(data), oldWake = wake;
      try { return await fn(storage); }
      catch (e) { data.clear(); for (const [k, v] of old) data.set(k, v); wake = oldWake; throw e; }
      finally { release(); }
    },
  };
  return { data, storage, wake: () => wake };
}
function harness(t: any, override?: (url: string, init: any, body: any) => any) {
  const s = storageState(); let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const calls: any[] = [];
  const check: any = { id: 34567, name: "Agent Vigil", app: { id: 1001 }, head_sha: identity.headSha,
    external_id: `${identity.event}:${identity.deliveryId}:${identity.headSha}`, status: "queued" };
  const pull: any = { state: "open", merged: false, draft: false, number: 17, body: "reviewed body",
    base: { sha: identity.baseSha, ref: "main", repo: { full_name: identity.repository } }, head: { sha: identity.headSha } };
  const binding = { idFromName: (v: string) => v, get: () => ({ fetch: (url: any, init: any) => new DeliveryLedger(s, e).fetch(new Request(url, init)) }) };
  const e = { ...env, DELIVERY_LEDGER: binding };
  t.mock.method(globalThis, "fetch", async (input: any, init: any = {}) => {
    const url = String(input), body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? "GET", body });
    const altered = await override?.(url, init, body); if (altered) return altered;
    if (url.includes("/access_tokens")) return Response.json({ token: "fake-token-not-a-secret-xxxxxxxxxxxxxxx" });
    if (url.endsWith("/check-runs") && init.method === "POST") return Response.json(check, { status: 201 });
    if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
    if (url.endsWith("/check-runs/34567")) { if (init.method === "PATCH") Object.assign(check, body); return Response.json(check); }
    if (url.endsWith("/pulls/17")) return Response.json(pull);
    throw new Error(`unexpected mock request ${url}`);
  });
  return { ...s, calls, check, pull, e,
    setNow: (v: number) => { now = v; },
    queue: () => new DeliveryLedger(s, e).fetch(request(identity, "/dispatch")),
    result: (value: any = expected) => new DeliveryLedger(s, e).fetch(request(value)),
    next: async () => { now = s.wake(); await new DeliveryLedger(s, e).alarm(); },
    patches: () => calls.filter((v) => v.method === "PATCH"),
  };
}

test("result HMAC binds the exact bytes and cannot reuse a webhook or dispatch signature", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(expected));
  const signature = await checkResultSignature(env.DISPATCH_SECRET, bytes);
  assert.equal(await verifyCheckResultSignature(env.DISPATCH_SECRET, bytes, signature), true);
  assert.equal(await verifyCheckResultSignature(env.DISPATCH_SECRET, new TextEncoder().encode(JSON.stringify({ ...expected, verdict: "FAIL" })), signature), false);
  assert.equal(await verifyCheckResultSignature(env.DISPATCH_SECRET, bytes, await webhookSignature(env.DISPATCH_SECRET, bytes)), false);
  assert.equal(await verifyCheckResultSignature(env.DISPATCH_SECRET, bytes, await dispatchSignature(env.DISPATCH_SECRET, { ...identity, checkRunId: "34567" }, 2)), false);
  assert.equal(JSON.parse(Buffer.from(dispatchEnvelope({ ...identity, checkRunId: "34567" }, 2), "base64url").toString()).schema, "agent-vigil-public-app-v2");
});

for (const [key, value] of Object.entries({ schema: "v0", deliveryId: "x", repository: "../private", installationId: "9007199254740992", baseSha: identity.headSha,
  headSha: "bogus", checkRunId: "0", runId: "01", runAttempt: "-1", verdict: "SKIPPED", receiptHash: "", prBodySha256: "wrong" })) {
  test(`malformed result rejects ${key}`, () => assert.throws(() => parseCheckResult({ ...expected, [key]: value })));
}
test("missing and extra result fields cannot be ignored", () => {
  assert.throws(() => parseCheckResult({ ...expected, extra: "unexpected" }));
  const v: any = { ...expected }; delete v.verdict; assert.throws(() => parseCheckResult(v));
  assert.throws(() => parseCheckResult([]));
});

for (const verdict of ["PASS", "FAIL", "NOT CHECKED"]) {
  test(`a durable ${verdict} is published once across restart and repeated callbacks`, async (t) => {
    const h = harness(t); await h.queue(); await h.next();
    const result = { ...expected, verdict };
    const answers = await Promise.all([h.result(result), h.result(result), h.result(result)]);
    assert.ok(answers.every((r) => r.status === 202));
    assert.equal(h.patches().length, 0, "acknowledgement is durable, not an inline GitHub PATCH");
    await h.next();
    assert.equal(h.patches().length, 1); assert.equal(h.patches()[0].body.output.title, verdict);
    assert.deepEqual(await (await h.result(result)).json(), { status: "published", verdict });
    assert.equal((await h.result({ ...result, verdict: verdict === "PASS" ? "FAIL" : "PASS" })).status, 409);
    assert.equal((await h.result({ ...result, runAttempt: "2" })).status, 409);
    assert.equal(h.patches().length, 1);
  });
}

test("a timeout wins before a late PASS, including after restart", async (t) => {
  const h = harness(t); await h.queue(); await h.next(); await h.next();
  assert.equal(h.patches()[0].body.output.title, "NOT CHECKED");
  assert.equal((await h.result()).status, 409);
  assert.equal(h.patches().length, 1); assert.equal(h.data.get("decision").verdict, "NOT CHECKED");
});
test("a timely recorded result wins even when its alarm runs after the deadline", async (t) => {
  const h = harness(t); await h.queue(); await h.next();
  await h.result(); h.setNow(h.data.get("dispatch").deadline_at + 1);
  await new DeliveryLedger(h, h.e).alarm();
  assert.equal(h.patches()[0].body.output.title, "PASS");
});
test("a result at the exact deadline cannot reserve a PASS", async (t) => {
  const h = harness(t); await h.queue(); await h.next(); h.setNow(h.data.get("dispatch").deadline_at);
  assert.equal((await h.result()).status, 409); assert.equal(h.data.has("proposal"), false);
  await h.next(); assert.equal(h.patches()[0].body.output.title, "NOT CHECKED");
});
test("a callback while dispatch response is in flight cannot lose its wakeup", async (t) => {
  const h = harness(t, async (url) => {
    if (url.endsWith("/dispatches")) { assert.equal((await h.result()).status, 202); return new Response(null, { status: 204 }); }
  });
  await h.queue(); await h.next();
  assert.ok(h.wake() < h.data.get("dispatch").deadline_at);
  await h.next(); assert.equal(h.patches()[0].body.output.title, "PASS");
});
test("timeout reservation prevents a late callback while the token request is in flight", async (t) => {
  let race = false;
  const h = harness(t, async (url) => {
    if (race && url.includes("/access_tokens")) { race = false; assert.equal((await h.result()).status, 409); }
  });
  await h.queue(); await h.next(); race = true; await h.next();
  assert.equal(h.patches()[0].body.output.title, "NOT CHECKED");
});

for (const mismatch of ["repository", "installationId", "baseSha", "headSha", "checkRunId", "deliveryId"]) {
  test(`a validly shaped result cannot cross ${mismatch}`, async (t) => {
    const h = harness(t); await h.queue(); await h.next();
    const value = mismatch === "repository" ? "test/other" : mismatch.endsWith("Sha") ? "4".repeat(40)
      : mismatch === "deliveryId" ? "550e8400-e29b-41d4-a716-446655440001" : "999";
    assert.equal((await h.result({ ...expected, [mismatch]: value })).status, 409); assert.equal(h.data.has("proposal"), false);
  });
}
for (const changed of ["body", "head", "base", "ref", "draft", "closed", "merged", "repository"]) {
  test(`a ${changed} change after callback is NOT CHECKED before publishing`, async (t) => {
    const h = harness(t); await h.queue(); await h.next(); await h.result();
    if (changed === "body") h.pull.body = "changed";
    if (changed === "head" || changed === "base") h.pull[changed].sha = "4".repeat(40);
    if (changed === "ref") h.pull.base.ref = "release";
    if (changed === "draft" || changed === "merged") h.pull[changed] = true;
    if (changed === "closed") h.pull.state = "closed";
    if (changed === "repository") h.pull.base.repo.full_name = "test/other";
    await h.next(); assert.equal(h.patches()[0].body.output.title, "NOT CHECKED");
  });
}
test("lost PATCH response is reconciled without another write or a different decision", async (t) => {
  let lose = true;
  const h = harness(t, (_url, init, body) => {
    if (lose && init.method === "PATCH") { lose = false; Object.assign(h.check, body); throw new Error("response lost after commit"); }
  });
  await h.queue(); await h.next(); await h.result(); await h.next(); await h.next();
  assert.equal(h.patches().length, 1); assert.equal(h.data.get("dispatch").terminal_status, "completed");
});
test("storage failure cannot acknowledge an uncommitted proposal", async (t) => {
  const h = harness(t); await h.queue(); await h.next();
  t.mock.method(h.storage, "setAlarm", async () => { throw new Error("storage unavailable"); });
  await assert.rejects(h.result, /storage unavailable/); assert.equal(h.data.has("proposal"), false);
});
test("a foreign or conflicting completed check is not overwritten", async (t) => {
  const h = harness(t); await h.queue(); await h.next(); await h.result();
  Object.assign(h.check, { status: "completed", conclusion: "failure", output: resultOutput("FAIL") });
  for (let i = 0; i < 3; i++) await h.next();
  assert.equal(h.patches().length, 0); assert.equal(h.data.get("dispatch").terminal_status, "needs_operator");
  assert.equal((await h.result()).status, 409);
});
test("callbacks cannot adopt a legacy or missing delivery", async (t) => {
  const h = harness(t); assert.equal((await h.result()).status, 409); await h.queue(); await h.next();
  h.data.get("dispatch").protocol = 1; assert.equal((await h.result()).status, 409);
});
test("public result route authenticates before binding access and blocks malformed or oversized requests", async (t) => {
  const h = harness(t); await h.queue(); await h.next();
  let accesses = 0;
  const binding = { idFromName: (v: string) => { accesses++; return v; }, get: h.e.DELIVERY_LEDGER.get };
  const e = { ...h.e, DELIVERY_LEDGER: binding };
  const bytes = new TextEncoder().encode(JSON.stringify(expected));
  const send = (body: any, signature: string, contentType = "application/json") => worker.fetch(new Request("https://app.example/github/check-result", {
    method: "POST", headers: { "content-type": contentType, "x-agent-vigil-result-signature": signature }, body }), e);
  assert.equal((await send(bytes, "sha256=" + "0".repeat(64))).status, 401); assert.equal(accesses, 0);
  assert.equal((await send(bytes, "", "text/plain")).status, 415);
  assert.equal((await send(" ".repeat(4097), "")).status, 413);
  const invalid = new TextEncoder().encode("{");
  assert.equal((await send(invalid, await checkResultSignature(env.DISPATCH_SECRET, invalid))).status, 400);
  assert.equal(accesses, 0);
  assert.equal((await send(bytes, await checkResultSignature(env.DISPATCH_SECRET, bytes))).status, 202);
  assert.equal(accesses, 1);
});

for (const stale of ["neither", "base", "head"]) {
  test(`merge-group publication checks both refs: stale ${stale}`, async (t) => {
    const h = harness(t, (url) => {
      if (!url.includes("/git/ref/")) return;
      const base = url.endsWith("/heads/main");
      const changed = stale === (base ? "base" : "head");
      return Response.json({ object: { type: "commit", sha: changed ? "9".repeat(40) : base ? identity.baseSha : identity.headSha } });
    });
    await h.queue(); await h.next();
    Object.assign(h.data.get("target"), { event: "merge_group", number: "", baseRef: "refs/heads/main", headRef: "refs/heads/gh-readonly-queue/main/pr-17" });
    h.check.external_id = `merge_group:${identity.deliveryId}:${identity.headSha}`;
    await h.result({ ...expected, prBodySha256: "" }); await h.next();
    assert.equal(h.patches()[0].body.output.title, stale === "neither" ? "PASS" : "NOT CHECKED");
    assert.equal(h.calls.filter((v) => v.url.includes("/git/ref/")).length, 2);
  });
}
test("a NOT CHECKED publication does not fetch private PR content", async (t) => {
  const h = harness(t, (url) => { if (url.includes("/pulls/")) throw new Error("must not fetch a private PR body"); });
  await h.queue(); await h.next(); await h.result({ ...expected, verdict: "NOT CHECKED", prBodySha256: "", receiptHash: "" });
  await h.next(); assert.equal(h.patches()[0].body.output.title, "NOT CHECKED");
  assert.equal(h.calls.some((v) => v.url.includes("/pulls/")), false);
});
