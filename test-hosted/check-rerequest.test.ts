import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import worker, { DeliveryLedger, webhookSignature, parseCheckRerequestPayload } from "../hosted/public-app/src/index.mjs";

const originalId = "550e8400-e29b-41d4-a716-446655440000";
const retryId = "650e8400-e29b-41d4-a716-446655440001";
const target = { deliveryId: originalId, repository: "test-owner/test-repo", installationId: "23456",
  event: "pull_request", number: "17", baseSha: "1".repeat(40), headSha: "2".repeat(40), baseRef: "main", headRef: "", checkRunId: "34567" };
const secret = "test-webhook-secret-xxxxxxxxxxxxxxxxxxxxxxxxxx";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = { WEBHOOK_SECRET: secret, DISPATCH_SECRET: secret, GITHUB_APP_ID: "1001", GITHUB_APP_PRIVATE_KEY: pem,
  CONTROL_APP_ID: "1002", CONTROL_APP_PRIVATE_KEY: pem, CONTROL_INSTALLATION_ID: "1003",
  CONTROL_REPOSITORY: "sulmusic2-star/agent-vigil", CONTROL_WORKFLOW: "public-app-gate.yml", CONTROL_REF: "main" };
function payload() {
  return { action: "rerequested", repository: { full_name: target.repository }, installation: { id: 23456 },
    sender: { login: "maintainer", id: 77, type: "User" }, check_run: { id: 34567, name: "Agent Vigil", app: { id: 1001 },
      head_sha: target.headSha, external_id: `pull_request:${originalId}:${target.headSha}` } };
}
async function webhook(value = payload(), id = retryId, valid = true) {
  const body = new TextEncoder().encode(JSON.stringify(value));
  return new Request("https://app.example/github/webhook", { method: "POST", body,
    headers: { "content-type": "application/json", "x-github-event": "check_run", "x-github-delivery": id,
      "x-hub-signature-256": valid ? await webhookSignature(secret, body) : `sha256=${"0".repeat(64)}` } });
}

test("signed GitHub Re-run is durably queued instead of silently ignored", async () => {
  let queued: any;
  const env = { ...config, DELIVERY_LEDGER: { idFromName(id: string) { return id; }, get(id: string) {
    return { async fetch(_url: string, init: RequestInit) { queued = { id, value: JSON.parse(String(init.body)) }; return Response.json({ status: "retry_queued" }, { status: 202 }); } };
  } } };
  const response = await worker.fetch(await webhook(), env);
  assert.equal(response.status, 202);
  assert.equal(queued?.id, retryId);
  assert.equal(queued?.value.originalDeliveryId, originalId);
  assert.equal(queued?.value.senderId, "77");
});

function store() {
  const data = new Map<string, any>();
  let alarm: number | null = null, tail = Promise.resolve();
  const storage = {
    async get(key: string) { return structuredClone(data.get(key)); },
    async put(key: string, value: any) { data.set(key, structuredClone(value)); },
    async setAlarm(value: number) { alarm = value; },
    async getAlarm() { return alarm; },
    async deleteAll() { data.clear(); alarm = null; },
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const previous = tail; let done!: () => void;
      tail = new Promise<void>((resolve) => { done = resolve; }); await previous;
      const before = structuredClone(data), oldAlarm = alarm;
      try { return await fn(storage); }
      catch (e) { data.clear(); for (const [key, value] of before) data.set(key, value); alarm = oldAlarm; throw e; }
      finally { done(); }
    },
  };
  return { storage, data, alarm: () => alarm };
}

function harness(t: any, original = target) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const objects = new Map<string, ReturnType<typeof store>>();
  const state = (id: string) => { if (!objects.has(id)) objects.set(id, store()); return objects.get(id)!; };
  const env = { ...config, DELIVERY_LEDGER: { idFromName(id: string) { return id; }, get(id: string) {
    return { fetch(input: string, init: RequestInit) { return new DeliveryLedger(state(id), env).fetch(new Request(input, init)); } };
  } } };
  const old = state(originalId);
  old.data.set("target", structuredClone(original));
  old.data.set("dispatch", { status: "dispatched", delivery_id: originalId, check_run_id: original.checkRunId,
    deadline_at: now + 3_600_000, wake_at: now + 3_600_000 });
  const check = { id: 34567, name: "Agent Vigil", app: { id: 1001 }, head_sha: original.headSha,
    external_id: `${original.event}:${originalId}:${original.headSha}`, status: "completed", conclusion: "failure", output: { title: "NOT CHECKED" } };
  const permission = { permission: "write", role_name: "maintain", user: { id: 77, login: "maintainer" } };
  const pull = { number: 17, state: "open", merged: false, draft: false,
    base: { sha: "3".repeat(40), ref: "main", repo: { full_name: target.repository } }, head: { sha: target.headSha } };
  const refs = new Map([[original.headRef, original.headSha], [original.baseRef, original.baseSha]]);
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const failures = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (input: any, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET", body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body }); assert.ok(init?.signal);
    for (const [suffix, left] of failures) if (left > 0 && url.endsWith(suffix)) { failures.set(suffix, left - 1); throw new Error("simulated outage"); }
    if (url.endsWith("/access_tokens")) return Response.json({ token: "local-test-token-xxxxxxxxxxxxxxxxxxxxx" });
    if (url.endsWith("/collaborators/maintainer/permission")) return Response.json(permission);
    if (url.endsWith("/check-runs/34567")) return Response.json(check);
    if (url.endsWith("/pulls/17")) return Response.json(pull);
    if (url.includes("/git/ref/")) { const ref = `refs/${decodeURIComponent(url.split("/git/ref/")[1])}`; return Response.json({ ref, object: { type: "commit", sha: refs.get(ref) } }); }
    if (url.endsWith("/check-runs") && method === "POST") return Response.json({ ...check, id: 34568, status: "queued", head_sha: body.head_sha, external_id: body.external_id });
    if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${url}`);
  });
  const requestPayload = () => ({ ...payload(), check_run: { ...payload().check_run, external_id: check.external_id } });
  return { env, old, check, permission, pull, refs, calls, failures, state, requestPayload,
    async queue(id = retryId) { return worker.fetch(await webhook(requestPayload(), id), env); },
    async next(id = retryId) { now = Math.max(now, state(id).alarm()!); await new DeliveryLedger(state(id), env).alarm(); },
    writes() { return calls.filter(c => c.method === "PATCH" || c.url.endsWith("/dispatches") || c.url.endsWith("/check-runs")); },
  };
}

test("valid retry uses fresh base evidence, creates a new check and never rewrites the old result", async (t) => {
  const h = harness(t);
  assert.equal((await h.queue()).status, 202); assert.equal(h.calls.length, 0);
  await h.next();
  assert.equal(h.state(retryId).data.get("dispatch").status, "queued");
  assert.equal(h.state(retryId).data.get("target").baseSha, h.pull.base.sha);
  assert.equal(h.state(retryId).data.get("target").headSha, target.headSha);
  assert.equal(h.writes().length, 0);
  await h.next();
  const dispatch = h.calls.find(c => c.url.endsWith("/dispatches"))!.body;
  const value = JSON.parse(Buffer.from(dispatch.inputs.envelope, "base64url").toString());
  assert.equal(value.event, "pull_request"); assert.equal(value.deliveryId, retryId);
  assert.equal(value.checkRunId, "34568"); assert.equal(value.baseSha, h.pull.base.sha);
  assert.match(dispatch.inputs.dispatchSignature, /^sha256=[0-9a-f]{64}$/);
  assert.equal(h.calls.filter(c => c.method === "PATCH").length, 0);
  assert.equal(h.old.data.get("target").checkRunId, "34567");
  assert.equal(h.old.data.get("retry_claim").deliveryId, retryId);
});

test("retry redelivery remains idempotent after its stored target becomes a normal PR dispatch", async (t) => {
  const h = harness(t); await h.queue(); await h.next(); await h.next();
  assert.equal((await h.queue()).status, 202);
  assert.equal(h.calls.filter(c => c.url.endsWith("/dispatches")).length, 1);
});

test("a delivery ID cannot be replayed with a different sender after its target changes", async (t) => {
  const h = harness(t); await h.queue(); await h.next();
  const changed = h.requestPayload(); changed.sender.id = 78;
  assert.equal((await worker.fetch(await webhook(changed), h.env)).status, 409);
  assert.equal(h.state(retryId).data.get("request").senderId, "77");
  assert.equal(h.writes().length, 0);
});

test("concurrent Re-run deliveries for one old check admit only one new run", async (t) => {
  const h = harness(t), secondId = "750e8400-e29b-41d4-a716-446655440002";
  await Promise.all([h.queue(), h.queue(secondId)]);
  await Promise.all([h.next(), h.next(secondId)]);
  const statuses = [h.state(retryId).data.get("dispatch"), h.state(secondId).data.get("dispatch")];
  assert.equal(statuses.filter(d => d.status === "queued").length, 1);
  assert.equal(statuses.filter(d => d.terminal_status === "retry_rejected").length, 1);
  const winner = statuses[0].status === "queued" ? retryId : secondId;
  await h.next(winner);
  assert.equal(h.calls.filter(c => c.url.endsWith("/dispatches")).length, 1);
});

for (const denied of ["read", "none", "custom-role-without-write", "changed-user-id", "changed-login"]) {
  test(`retry refuses ${denied} before creating any check or reserving the original`, async (t) => {
    const h = harness(t); await h.queue();
    if (denied === "changed-user-id") h.permission.user.id = 78;
    else if (denied === "changed-login") h.permission.user.login = "someone-else";
    else { h.permission.permission = denied === "custom-role-without-write" ? "read" : denied; h.permission.role_name = "admin"; }
    await h.next();
    assert.equal(h.state(retryId).data.get("dispatch").rejection_reason, "write_access_required");
    assert.equal(h.writes().length, 0); assert.equal(h.old.data.has("retry_claim"), false);
  });
}

for (const invalid of ["wrong-app", "wrong-head", "wrong-check", "wrong-name", "wrong-delivery", "still-running", "passed", "actual-failure"]) {
  test(`fresh check lookup rejects ${invalid}`, async (t) => {
    const h = harness(t); await h.queue();
    if (invalid === "wrong-app") h.check.app.id = 9999;
    if (invalid === "wrong-head") h.check.head_sha = "9".repeat(40);
    if (invalid === "wrong-check") h.check.id = 34569;
    if (invalid === "wrong-name") h.check.name = "Some other check";
    if (invalid === "wrong-delivery") h.check.external_id = `pull_request:${retryId}:${target.headSha}`;
    if (invalid === "still-running") h.check.status = "in_progress";
    if (invalid === "passed") h.check.conclusion = "success";
    if (invalid === "actual-failure") h.check.output.title = "FAIL";
    await h.next(); assert.equal(h.state(retryId).data.get("dispatch").terminal_status, "retry_rejected");
    assert.equal(h.writes().length, 0); assert.equal(h.old.data.has("retry_claim"), false);
  });
}

for (const invalid of ["closed", "merged", "draft", "new-head", "retargeted", "wrong-repository", "wrong-number"]) {
  test(`a ${invalid} PR cannot reuse its old check`, async (t) => {
    const h = harness(t); await h.queue();
    if (invalid === "closed") h.pull.state = "closed";
    if (invalid === "merged") h.pull.merged = true;
    if (invalid === "draft") h.pull.draft = true;
    if (invalid === "new-head") h.pull.head.sha = "4".repeat(40);
    if (invalid === "retargeted") h.pull.base.ref = "release";
    if (invalid === "wrong-repository") h.pull.base.repo.full_name = "different/repository";
    if (invalid === "wrong-number") h.pull.number = 18;
    await h.next(); assert.equal(h.state(retryId).data.get("dispatch").rejection_reason, "pull_request_changed_or_is_not_open");
    assert.equal(h.writes().length, 0);
  });
}

for (const invalid of ["missing", "expired", "wrong-installation", "wrong-repository", "wrong-head", "wrong-check"]) {
  test(`a ${invalid} original delivery cannot authorize recovery`, async (t) => {
    const h = harness(t); await h.queue();
    if (invalid === "missing") h.old.data.clear();
    if (invalid === "expired") h.old.data.set("dispatch", { ...h.old.data.get("dispatch"), status: "retained", wake_at: 0 });
    if (invalid === "wrong-installation") h.old.data.get("target").installationId = "3456";
    if (invalid === "wrong-repository") h.old.data.get("target").repository = "different/repo";
    if (invalid === "wrong-head") h.old.data.get("target").headSha = "4".repeat(40);
    if (invalid === "wrong-check") h.old.data.get("target").checkRunId = "1234";
    await h.next(); assert.equal(h.state(retryId).data.get("dispatch").terminal_status, "retry_rejected");
    assert.equal(h.calls.length, 0);
  });
}

test("permission API outage retries, but an unavailable permission never becomes approval", async (t) => {
  const h = harness(t); h.failures.set("/permission", 3);
  await h.queue(); for (let i = 0; i < 3; i++) await h.next();
  assert.equal(h.state(retryId).data.get("dispatch").terminal_status, "needs_operator");
  assert.equal(h.writes().length, 0); assert.equal(h.old.data.has("retry_claim"), false);
});

test("lost claim acknowledgement resumes the same retry rather than consuming a second one", async (t) => {
  const h = harness(t), get = h.env.DELIVERY_LEDGER.get;
  let fail = true;
  t.mock.method(h.env.DELIVERY_LEDGER, "get", (id: string) => {
    const stub = get(id);
    return { async fetch(input: string, init: RequestInit) {
      const response = await stub.fetch(input, init);
      if (fail && input.endsWith("/retry-claim")) { fail = false; throw new Error("reply lost after durable claim"); }
      return response;
    } };
  });
  await h.queue(); await h.next(); await h.next(); await h.next();
  assert.equal(h.calls.filter(c => c.url.endsWith("/dispatches")).length, 1);
});

test("a failed local write after claiming recovery resumes without duplicate work", async (t) => {
  const h = harness(t); await h.queue();
  const storage = h.state(retryId).storage, put = storage.put;
  let fail = true;
  t.mock.method(storage, "put", async (key: string, value: any) => {
    if (fail && key === "dispatch" && value.status === "queued") {
      fail = false; throw new Error("local write failed after the original delivery was claimed");
    }
    await put(key, value);
  });
  await h.next();
  assert.equal(h.old.data.get("retry_claim").deliveryId, retryId);
  assert.equal(h.state(retryId).data.get("dispatch").status, "retry_queued");
  assert.equal(h.writes().length, 0);
  await h.next(); await h.next();
  assert.equal(h.calls.filter(c => c.url.endsWith("/dispatches")).length, 1);
});

test("resuming a lost claim response rechecks permission instead of trusting the earlier grant", async (t) => {
  const h = harness(t), get = h.env.DELIVERY_LEDGER.get;
  let fail = true;
  t.mock.method(h.env.DELIVERY_LEDGER, "get", (id: string) => {
    const stub = get(id);
    return { async fetch(input: string, init: RequestInit) {
      const response = await stub.fetch(input, init);
      if (fail && input.endsWith("/retry-claim")) { fail = false; throw new Error("claim reply lost"); }
      return response;
    } };
  });
  await h.queue(); await h.next(); h.permission.permission = "read";
  await h.next();
  assert.equal(h.state(retryId).data.get("dispatch").rejection_reason, "write_access_required");
  assert.equal(h.writes().length, 0);
});

test("expired retry requests cannot spend money starting verification", async (t) => {
  const h = harness(t); await h.queue(); h.state(retryId).data.get("dispatch").deadline_at = 0;
  await h.next(); assert.equal(h.state(retryId).data.get("dispatch").rejection_reason, "retry_request_expired");
  assert.equal(h.calls.length, 0);
});

for (const changed of ["unchanged", "head", "base"]) {
  test(`merge-queue retry validates both live refs (${changed})`, async (t) => {
    const original = { ...target, event: "merge_group", number: "", baseRef: "refs/heads/main", headRef: "refs/heads/gh-readonly-queue/main/pr-17" };
    const h = harness(t, original); await h.queue();
    if (changed !== "unchanged") h.refs.set(changed === "head" ? original.headRef : original.baseRef, "9".repeat(40));
    await h.next();
    if (changed === "unchanged") {
      await h.next(); const body = h.calls.find(c => c.url.endsWith("/dispatches"))!.body;
      const value = JSON.parse(Buffer.from(body.inputs.envelope, "base64url").toString());
      assert.equal(value.event, "merge_group"); assert.equal(value.baseSha, original.baseSha); assert.equal(value.headSha, original.headSha);
    } else { assert.equal(h.state(retryId).data.get("dispatch").rejection_reason, "merge_queue_commit_changed"); assert.equal(h.writes().length, 0); }
  });
}

test("invalid signatures and unrelated check events do not reach the recovery ledger", async (t) => {
  const h = harness(t);
  assert.equal((await worker.fetch(await webhook(payload(), retryId, false), h.env)).status, 401);
  assert.equal((await worker.fetch(await webhook({ ...payload(), action: "completed" }), h.env)).status, 202);
  assert.equal(h.state(retryId).data.size, 0); assert.equal(h.calls.length, 0);
  for (const path of ["/retry-source", "/retry-claim"]) {
    const response = await worker.fetch(new Request(`https://app.example${path}`, { method: "POST", body: "{}" }), h.env);
    assert.equal(response.status, 404);
  }
});

test("rerequest parser rejects forged origins, unsafe IDs, bots and hostile path text", () => {
  const edits: Array<(p: any) => void> = [
    p => p.check_run.app.id = 9999, p => p.check_run.name = "Other", p => p.check_run.id = Number.MAX_SAFE_INTEGER + 1,
    p => p.check_run.head_sha = "bad", p => p.check_run.external_id = `pull_request:bad:${target.headSha}`,
    p => p.check_run.external_id = `deployment_protection_rule:${originalId}:${target.headSha}`,
    p => p.sender.type = "Bot", p => p.sender.id = -1, p => p.sender.login = "../permissions",
    p => p.sender.login = "name\nspoof", p => p.repository.full_name = "../repo", p => p.installation.id = 0,
  ];
  for (const edit of edits) { const p = payload(); edit(p); assert.throws(() => parseCheckRerequestPayload(p, retryId, "1001")); }
  assert.throws(() => parseCheckRerequestPayload(payload(), originalId, "1001"));
});
