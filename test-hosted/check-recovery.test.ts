import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { DeliveryLedger } from "../hosted/public-app/src/index.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const env = {
  GITHUB_APP_ID: "1001", GITHUB_APP_PRIVATE_KEY: pem,
  CONTROL_APP_ID: "1002", CONTROL_APP_PRIVATE_KEY: pem,
  CONTROL_INSTALLATION_ID: "1003", CONTROL_REPOSITORY: "sulmusic2-star/agent-vigil",
  CONTROL_WORKFLOW: "public-app-gate.yml", CONTROL_REF: "main",
  DISPATCH_SECRET: "a-test-dispatch-secret-with-at-least-thirty-two-characters",
};
const target = {
  deliveryId: "550e8400-e29b-41d4-a716-446655440000",
  repository: "test-owner/test-repository", installationId: "23456",
  event: "pull_request", number: "17", baseSha: "1".repeat(40),
  headSha: "2".repeat(40), baseRef: "main", headRef: "",
};
function request(value = target) {
  return new Request("https://ledger.internal/dispatch", { method: "POST", body: JSON.stringify(value) });
}

// A transactional fake, not a Cloudflare runtime or a customer installation.
function state() {
  const data = new Map<string, any>();
  let wake: number | null = null;
  let tail = Promise.resolve();
  const storage = {
    async get(key: string) { return structuredClone(data.get(key)); },
    async put(key: string, value: any) { data.set(key, structuredClone(value)); },
    async setAlarm(time: number) { wake = time; },
    async getAlarm() { return wake; },
    async deleteAll() { data.clear(); wake = null; },
    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      const before = structuredClone(data), oldWake = wake;
      try { return await fn(storage); }
      catch (error) { data.clear(); for (const [key, value] of before) data.set(key, value); wake = oldWake; throw error; }
      finally { release(); }
    },
  };
  return { storage, data, wake: () => wake };
}

test("accepted delivery is durable before acknowledgement, with no GitHub network work", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("network must not run before acknowledgement"); });
  const s = state();
  const response = await new DeliveryLedger(s, env).fetch(request());
  assert.equal(response.status, 202);
  assert.equal(calls, 0);
  assert.equal(s.data.get("dispatch").status, "queued");
  assert.deepEqual(s.data.get("target"), target);
  assert.ok(s.wake() !== null);
});

function harness(t: any, override?: (url: string, init: RequestInit | undefined, body: any) => Response | Promise<Response> | undefined) {
  const s = state();
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const calls: Array<{ url: string; method: string; body: any }> = [];
  const check = { id: 34567, name: "Agent Vigil", app: { id: 1001 }, head_sha: target.headSha,
    external_id: `${target.event}:${target.deliveryId}:${target.headSha}`, status: "queued" };
  t.mock.method(globalThis, "fetch", async (input: any, init?: RequestInit) => {
    const url = String(input), body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    const replaced = await override?.(url, init, body);
    if (replaced) return replaced;
    assert.ok(init?.signal, "all remote calls must have an abort signal");
    if (url.includes("/access_tokens")) return Response.json({ token: "test-token-xxxxxxxxxxxxxxxxxxxxxxxx" });
    if (url.includes("/commits/")) return Response.json({ total_count: 1, check_runs: [check] });
    if (url.endsWith("/check-runs") && init?.method === "POST") return Response.json(check, { status: 201 });
    if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
    if (url.endsWith("/check-runs/34567")) return Response.json(check);
    throw new Error(`unexpected request ${url}`);
  });
  return {
    ...s, calls, check,
    queue: () => new DeliveryLedger(s, env).fetch(request()),
    // Reconstruct the object for every alarm: no process-local job state is kept.
    async next() { assert.notEqual(s.wake(), null); now = s.wake()!; await new DeliveryLedger(s, env).alarm(); },
    writes: (suffix: string) => calls.filter((c) => c.url.endsWith(suffix) && c.method === "POST"),
  };
}

test("a persisted delivery survives restart and dispatches once; early alarms and redeliveries do not duplicate work", async (t) => {
  const h = harness(t);
  await h.queue();
  const deadline = h.data.get("dispatch").deadline_at;
  await new DeliveryLedger(h, env).alarm();
  assert.equal(h.calls.length, 0, "early alarm must not run the queued job");
  await Promise.all([h.queue(), h.queue(), h.queue()]);
  await h.next();
  assert.equal(h.writes("/check-runs").length, 1);
  assert.equal(h.writes("/dispatches").length, 1);
  assert.equal(h.data.get("target").checkRunId, "34567");
  assert.equal(h.data.get("dispatch").status, "dispatched");
  assert.equal(h.wake(), deadline);
  await h.queue();
  await new DeliveryLedger(h, env).alarm();
  assert.equal(h.writes("/dispatches").length, 1);
  assert.equal(h.wake(), deadline);
});

test("a reused delivery cannot change repository, installation, event, refs or commit identity", async (t) => {
  const h = harness(t); await h.queue();
  for (const [key, changed] of Object.entries({ deliveryId: "other", repository: "other/repo", installationId: "42",
    event: "merge_group", baseSha: "3".repeat(40), headSha: "4".repeat(40), number: "18", baseRef: "release", headRef: "queue" })) {
    assert.equal((await new DeliveryLedger(h, env).fetch(request({ ...target, [key]: changed }))).status, 409, key);
  }
  assert.deepEqual(h.data.get("target"), target);
});

test("acknowledgement fails when scheduling cannot be committed; no partial job or remote effect remains", async (t) => {
  const h = harness(t);
  t.mock.method(h.storage, "setAlarm", async () => { throw new Error("storage unavailable"); });
  await assert.rejects(h.queue, /storage unavailable/);
  assert.equal(h.data.size, 0);
  assert.equal(h.calls.length, 0);
});

test("temporary token failure retries safely without asking for another commit", async (t) => {
  let failures = 1;
  const h = harness(t, (url) => { if (url.includes("/access_tokens") && failures-- > 0) throw new Error("temporary outage"); });
  await h.queue(); await h.next();
  assert.equal(h.data.get("dispatch").status, "queued");
  assert.equal(h.writes("/check-runs").length, 0);
  await h.next();
  assert.equal(h.data.get("dispatch").status, "dispatched");
  assert.equal(h.writes("/check-runs").length, 1);
});

test("an ongoing permission failure stops after three attempts and requests operator help", async (t) => {
  const h = harness(t, (url) => url.includes("/access_tokens") ? Response.json({ message: "denied" }, { status: 401 }) : undefined);
  await h.queue(); for (let i = 0; i < 3; i++) await h.next();
  assert.equal(h.calls.length, 3);
  assert.equal(h.data.get("dispatch").terminal_status, "needs_operator");
  assert.equal(h.writes("/check-runs").length, 0);
  await h.queue(); assert.equal(h.calls.length, 3);
});

test("lost check-create response is reconciled by App, external ID and SHA, not another POST", async (t) => {
  const h = harness(t, (url, init) => { if (url.endsWith("/check-runs") && init?.method === "POST") throw new Error("response lost after remote creation"); });
  await h.queue(); await h.next();
  assert.equal(h.data.get("dispatch").status, "creating");
  await h.next();
  assert.equal(h.writes("/check-runs").length, 1);
  assert.equal(h.writes("/dispatches").length, 1);
});

for (const kind of ["missing", "duplicate", "wrong-app", "wrong-sha", "wrong-delivery", "wrong-name", "truncated", "short-page"] as const) {
  test(`uncertain check creation stays blocked when recovery is ${kind}`, async (t) => {
    const h = harness(t, (url, init) => {
      if (url.endsWith("/check-runs") && init?.method === "POST") throw new Error("lost response");
      if (!url.includes("/commits/")) return;
      const check = { ...h.check };
      if (kind === "wrong-app") check.app = { id: 9999 };
      if (kind === "wrong-sha") check.head_sha = "9".repeat(40);
      if (kind === "wrong-delivery") check.external_id = "another delivery";
      if (kind === "wrong-name") check.name = "Not Agent Vigil";
      return Response.json({ total_count: kind === "truncated" ? 51 : ["duplicate", "short-page"].includes(kind) ? 2 : kind === "missing" ? 0 : 1,
        check_runs: kind === "missing" ? [] : kind === "duplicate" ? [check, { ...check, id: 34568 }] : [check] });
    });
    await h.queue(); for (let i = 0; i < 3; i++) await h.next();
    assert.equal(h.writes("/check-runs").length, 1);
    assert.equal(h.writes("/dispatches").length, 0);
    assert.equal(h.data.get("dispatch").terminal_status, "needs_operator");
  });
}

test("check-created checkpoint survives a failed write and is safely reconciled", async (t) => {
  const h = harness(t); await h.queue();
  const put = h.storage.put;
  let fail = true;
  t.mock.method(h.storage, "put", async (key: string, value: any) => {
    if (fail && key === "dispatch" && value.status === "check_created") { fail = false; throw new Error("lost storage write"); }
    return put(key, value);
  });
  await h.next(); await h.next();
  assert.equal(h.writes("/check-runs").length, 1);
  assert.equal(h.writes("/dispatches").length, 1);
});

test("control-token failure resumes the known check without creating a replacement", async (t) => {
  let fail = true;
  const h = harness(t, (url) => { if (fail && url.includes("/installations/1003/")) { fail = false; throw new Error("control token lost"); } });
  await h.queue(); await h.next(); await h.next();
  assert.equal(h.writes("/check-runs").length, 1);
  assert.equal(h.writes("/dispatches").length, 1);
});

for (const lost of ["network", "http-503", "checkpoint"] as const) {
  test(`uncertain workflow dispatch (${lost}) is not repeated and times out as NOT CHECKED`, async (t) => {
    const h = harness(t, (url) => {
      if (!url.endsWith("/dispatches")) return;
      if (lost === "network") throw new Error("response lost");
      if (lost === "http-503") return Response.json({ message: "unavailable" }, { status: 503 });
    });
    if (lost === "checkpoint") {
      const put = h.storage.put; let fail = true;
      t.mock.method(h.storage, "put", async (key: string, value: any) => {
        if (fail && key === "dispatch" && value.status === "dispatched") { fail = false; throw new Error("storage failed"); }
        return put(key, value);
      });
    }
    await h.queue(); await h.next();
    assert.equal(h.data.get("dispatch").status, "dispatching");
    await h.next();
    assert.equal(h.data.get("dispatch").status, "dispatched");
    assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 0, "do not overwrite a possibly running result immediately");
    await h.next();
    assert.equal(h.writes("/dispatches").length, 1);
    const writes = h.calls.filter((c) => c.method === "PATCH");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].body.conclusion, "failure");
    assert.equal(writes[0].body.output.title, "NOT CHECKED");
    assert.equal(h.data.get("dispatch").terminal_status, "timed_out");
  });
}

test("completed results are preserved, retained against replay, and cleaned only when due", async (t) => {
  const h = harness(t); await h.queue(); await h.next(); h.check.status = "completed";
  await h.next(); await h.queue();
  assert.equal(h.data.get("dispatch").terminal_status, "completed");
  assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 0);
  await new DeliveryLedger(h, env).alarm(); assert.notEqual(h.data.size, 0);
  await h.next(); assert.equal(h.data.size, 0);
});

test("failed timeout write has a durable retry instead of a permanently pending check", async (t) => {
  let fail = true;
  const h = harness(t, (_url, init) => { if (fail && init?.method === "PATCH") { fail = false; throw new Error("write unavailable"); } });
  await h.queue(); await h.next(); await h.next();
  assert.equal(h.data.get("dispatch").status, "dispatched");
  await h.next(); assert.equal(h.data.get("dispatch").terminal_status, "timed_out");
  assert.ok(h.calls.filter((c) => c.method === "PATCH").every((c) => c.body.conclusion === "failure"));
});

test("a watchdog never updates a check owned by another App", async (t) => {
  const h = harness(t); await h.queue(); await h.next(); h.check.app.id = 9999;
  for (let i = 0; i < 3; i++) await h.next();
  assert.equal(h.calls.filter((c) => c.method === "PATCH").length, 0);
  assert.equal(h.data.get("dispatch").terminal_status, "needs_operator");
});

for (const oldStatus of ["pending", "failed"]) {
  test(`legacy ${oldStatus} redelivery reconciles but never redispatches possibly executed work`, async (t) => {
    const h = harness(t);
    h.data.set("dispatch", { status: oldStatus, delivery_id: target.deliveryId });
    await h.queue(); await h.next();
    assert.equal(h.data.get("dispatch").status, "dispatched");
    assert.equal(h.writes("/check-runs").length, 0);
    assert.equal(h.writes("/dispatches").length, 0);
  });
}

test("recovery does not dispatch a check already observed completed", async (t) => {
  const h = harness(t, (url, init) => { if (url.endsWith("/check-runs") && init?.method === "POST") throw new Error("lost creation"); });
  await h.queue(); await h.next(); h.check.status = "completed"; await h.next();
  assert.equal(h.data.get("dispatch").terminal_status, "completed");
  assert.equal(h.writes("/dispatches").length, 0);
});

for (const stuck of ["headers", "body"]) {
  test(`the GitHub timeout also bounds stalled ${stuck} and leaves a retry scheduled`, async (t) => {
    const originalTimeout = setTimeout;
    t.mock.method(globalThis, "setTimeout", (fn: any, ms: number, ...args: any[]) => originalTimeout(fn, ms === 15_000 ? 5 : ms, ...args));
    const h = harness(t, async (_url, init) => {
      assert.ok(init?.signal);
      if (stuck === "headers") return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"token":'));
        init.signal!.addEventListener("abort", () => controller.error(init.signal!.reason), { once: true });
      } }));
    });
    await h.queue(); await h.next();
    assert.equal(h.data.get("dispatch").status, "queued");
    assert.equal(h.data.get("dispatch").failures, 1);
    assert.equal(h.writes("/check-runs").length, 0);
    assert.ok(h.wake()! > Date.now());
  });
}

test("a recovered check on a later complete page is found without duplicate creation", async (t) => {
  const h = harness(t, (url, init) => {
    if (url.endsWith("/check-runs") && init?.method === "POST") throw new Error("lost create response");
    if (!url.includes("/commits/")) return;
    const page = new URL(url).searchParams.get("page");
    return Response.json({ total_count: 11, check_runs: page === "1"
      ? Array.from({ length: 10 }, (_, i) => ({ ...h.check, id: i + 1, external_id: `another-${i}` })) : [h.check] });
  });
  await h.queue(); await h.next(); await h.next();
  assert.equal(h.data.get("dispatch").status, "dispatched");
  assert.equal(h.writes("/check-runs").length, 1);
  assert.equal(h.writes("/dispatches").length, 1);
});
