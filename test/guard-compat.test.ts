import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GUARD_CHALLENGE_PACK,
  GUARD_COMPAT_SCHEMA,
  interpretGuardProcess,
  loadControlArguments,
  recomputeGuardCompatibilityReceiptHash,
  renderGuardCompatibility,
  runGuardCompatibility,
  type GuardHost,
} from "../src/guard-compat.ts";

type Fixture = {
  root: string;
  script: string;
  policy: string;
  configuration: string;
  capture: string;
  cleanup: () => void;
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vigil-guard-compat-test-"));
  const script = join(root, "control.mjs");
  const policy = join(root, "policy.json");
  const configuration = join(root, "host-config.json");
  const capture = join(root, "capture.jsonl");
  writeFileSync(policy, '{"denyMarker":"AGENT_VIGIL_PROCESS_CONFORMANCE_DENY_V1_"}\n');
  writeFileSync(configuration, '{"event":"PreToolUse","matcher":"Bash"}\n');
  writeFileSync(script, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const mode = process.argv[2] ?? "balanced";
const capture = process.argv[3];
const mutation = process.argv[4];
const raw = readFileSync(0, "utf8");
const data = JSON.parse(raw);
const command = data.tool_input?.command ?? "";
if (capture) appendFileSync(capture, JSON.stringify({
  event: data.hook_event_name,
  tool: data.tool_name,
  command,
  cwd: data.cwd,
  home: process.env.HOME,
  prompt: data.prompt_id,
  transcriptPresent: typeof data.transcript_path === "string" && existsSync(data.transcript_path),
  leaked: ["AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "HTTPS_PROXY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].some((name) => process.env[name] !== undefined),
}) + "\\n");
if (mode === "mutate" && mutation) writeFileSync(mutation, "changed\\n");
if (mode === "hang") await new Promise((resolve) => setTimeout(resolve, 10_000));
if (mode === "oversize") {
  await new Promise((resolve) => process.stdout.write("x".repeat(100_000), resolve));
  process.exit(0);
}
if (mode === "invalid") { process.stdout.write("{bad json"); process.exit(0); }
if (mode === "text") { process.stdout.write("no decision"); process.exit(0); }
if (mode === "empty") process.exit(0);
if (mode === "exit-two") process.exit(2);
if (mode === "unknown") { console.log('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"quarantine"}}'); process.exit(0); }
if (mode === "ask") { console.log('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}'); process.exit(0); }
if (mode === "conflict") { console.log('{"decision":"block","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'); process.exit(0); }
const deny = command.includes("AGENT_VIGIL_PROCESS_CONFORMANCE_DENY_V1_");
const decision = mode === "allow-all" ? "allow" : mode === "deny-all" ? "deny" : deny ? "deny" : "allow";
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } }));
if (mode === "exit-one-json") process.exit(1);
`);
  chmodSync(script, 0o700);
  return { root, script, policy, configuration, capture, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(host: GuardHost, selected: Fixture, mode = "balanced") {
  return runGuardCompatibility({
    host,
    hostVersion: host === "claude" ? "2.1.245" : "0.149.1",
    hostExecutable: process.execPath,
    controlName: "Fixture guard",
    controlVersion: "1.2.3",
    controlExecutable: process.execPath,
    controlArtifact: selected.script,
    controlArguments: [selected.script, mode, selected.capture],
    policyPath: selected.policy,
    configurationPath: selected.configuration,
    vigilVersion: "test",
    generatedAt: "2026-08-25T12:00:00.000Z",
    nonce: "0123456789abcdef0123456789abcdef",
    timeoutMs: mode === "hang" ? 50 : 2_000,
  });
}

test("guard compatibility passes exact harmless allow and deny decisions but keeps deployment on HOLD", () => {
  for (const host of ["claude", "codex"] as const) {
    const selected = fixture();
    try {
      const report = run(host, selected);
      assert.equal(report.schemaVersion, GUARD_COMPAT_SCHEMA);
      assert.equal(report.challengePack.id, GUARD_CHALLENGE_PACK);
      assert.equal(report.scope, "PROCESS_CONFORMANCE");
      assert.equal(report.status, "PASS");
      assert.deepEqual(report.challenges.map((item) => item.actual), ["ALLOW", "DENY"]);
      assert.deepEqual(report.summary.decisions, { ALLOW: 1, DENY: 1, DEFER: 0, ERROR: 0, UNKNOWN: 0 });
      assert.equal(report.deployment.state, "HOLD");
      assert.deepEqual(report.deployment.reasonCodes, ["LIVE_HOST_ROUTE_NOT_PROVEN"]);
      assert.match(report.host.executableSha256, /^sha256:[a-f0-9]{64}$/);
      assert.match(report.control.artifactSha256, /^sha256:[a-f0-9]{64}$/);
      assert.match(report.bindings.policySha256, /^sha256:[a-f0-9]{64}$/);
      assert.match(report.bindings.configurationSha256, /^sha256:[a-f0-9]{64}$/);
      assert.match(report.bindings.operatingSystem.machineIdentitySha256, /^sha256:[a-f0-9]{64}$/);
      assert.equal(recomputeGuardCompatibilityReceiptHash(report), report.receiptHash);
      assert.equal(JSON.stringify(report).includes(selected.root), false);
      assert.equal(JSON.stringify(report).includes("AGENT_VIGIL_PROCESS_CONFORMANCE"), false);
    } finally { selected.cleanup(); }
  }
});

test("canaries contain only printf markers and the control receives a reduced environment", () => {
  const selected = fixture();
  const previous = {
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  Object.assign(process.env, {
    AWS_SECRET_ACCESS_KEY: "planted",
    GITHUB_TOKEN: "planted",
    HTTPS_PROXY: "https://planted.invalid",
    OPENAI_API_KEY: "planted",
    ANTHROPIC_API_KEY: "planted",
  });
  try {
    assert.equal(run("claude", selected).status, "PASS");
    const captures = readFileSync(selected.capture, "utf8").trim().split("\n").map((row) => JSON.parse(row));
    assert.equal(captures.length, 2);
    assert.deepEqual(captures.map((row) => row.event), ["PreToolUse", "PreToolUse"]);
    assert.deepEqual(captures.map((row) => row.tool), ["Bash", "Bash"]);
    assert.ok(captures.every((row) => /^printf '%s\\n' 'AGENT_VIGIL_PROCESS_CONFORMANCE_(ALLOW|DENY)_V1_[a-f0-9]+'$/.test(row.command)));
    assert.ok(captures.every((row) => !/\brm\b|reset|\.ssh|rmtree|curl|wget/.test(row.command)));
    assert.ok(captures.every((row) => row.leaked === false));
    assert.ok(captures.every((row) => row.cwd && row.home && row.home.startsWith(row.cwd)));
    assert.ok(captures.every((row) => row.prompt?.startsWith("prompt-")));
    assert.ok(captures.every((row) => row.transcriptPresent === true));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    selected.cleanup();
  }
});

test("allow-all, deny-all, deferral, and malformed output cannot pass", () => {
  const cases = [
    ["allow-all", "FAIL", ["ALLOW", "ALLOW"]],
    ["deny-all", "FAIL", ["DENY", "DENY"]],
    ["empty", "FAIL", ["DEFER", "DEFER"]],
    ["text", "FAIL", ["DEFER", "DEFER"]],
    ["invalid", "FAIL", ["ERROR", "ERROR"]],
    ["conflict", "FAIL", ["ERROR", "ERROR"]],
    ["unknown", "INCONCLUSIVE", ["UNKNOWN", "UNKNOWN"]],
  ] as const;
  for (const [mode, status, decisions] of cases) {
    const selected = fixture();
    try {
      const report = run("claude", selected, mode);
      assert.equal(report.status, status, mode);
      assert.deepEqual(report.challenges.map((item) => item.actual), decisions, mode);
      assert.equal(report.deployment.state, "HOLD");
      assert.ok(report.deployment.reasonCodes.includes("PROCESS_CONFORMANCE_NOT_PROVEN"));
    } finally { selected.cleanup(); }
  }
});

test("host adapters apply only documented PreToolUse decision shapes", () => {
  const nested = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
  assert.equal(interpretGuardProcess({ host: "claude", status: 1, stdout: nested }).decision, "DENY");
  assert.deepEqual(
    interpretGuardProcess({ host: "codex", status: 1, stdout: nested }),
    { decision: "ERROR", rule: "CODEX_NONZERO_EXIT", process: "EXITED", exit: "OTHER", output: "JSON" },
  );
  assert.equal(interpretGuardProcess({ host: "claude", status: 2, stdout: "{bad" }).decision, "DENY");
  assert.equal(interpretGuardProcess({ host: "codex", status: 2, stdout: "" }).decision, "DENY");
  assert.equal(interpretGuardProcess({ host: "claude", status: 0, stdout: "plain" }).decision, "DEFER");
  assert.equal(interpretGuardProcess({ host: "codex", status: 0, stdout: "plain" }).decision, "DEFER");
  const ask = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } });
  assert.equal(interpretGuardProcess({ host: "claude", status: 0, stdout: ask }).decision, "DEFER");
  assert.equal(interpretGuardProcess({ host: "codex", status: 0, stdout: ask }).decision, "ERROR");
  assert.equal(interpretGuardProcess({ host: "claude", status: 0, stdout: '{"decision":"block"}' }).decision, "DENY");
  assert.equal(interpretGuardProcess({ host: "codex", status: 0, stdout: '{"decision":"block"}' }).decision, "DENY");
  assert.equal(interpretGuardProcess({ host: "codex", status: 0, stdout: '{"continue":false}' }).decision, "ERROR");
  assert.equal(interpretGuardProcess({ host: "codex", status: 0, stdout: "[]" }).decision, "ERROR");
  assert.equal(interpretGuardProcess({ host: "claude", status: 0, stdout: '{"permissionDecision":"allow"}' }).decision, "ERROR");
  assert.equal(interpretGuardProcess({ host: "codex", status: 0, stdout: '{"updatedInput":{"command":"echo wrong level"}}' }).decision, "ERROR");
  assert.equal(interpretGuardProcess({ host: "claude", status: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","decision":"allow"}}' }).decision, "ERROR");
  assert.equal(interpretGuardProcess({ host: "codex", status: 0, stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permission":"allow"}}' }).decision, "ERROR");
});

test("timeouts and excessive output are explicit ERROR decisions", () => {
  for (const mode of ["hang", "oversize"] as const) {
    const selected = fixture();
    try {
      const report = run("codex", selected, mode);
      assert.equal(report.status, "FAIL");
      assert.deepEqual(report.challenges.map((item) => item.actual), ["ERROR", "ERROR"], mode);
      assert.ok(report.challenges.every((item) => item.observation.process === (mode === "hang" ? "TIMED_OUT" : "OUTPUT_LIMIT")));
    } finally { selected.cleanup(); }
  }
});

test("receipt rendering neutralizes terminal controls and tampering changes the receipt hash", () => {
  const selected = fixture();
  try {
    const report = run("claude", selected);
    const unsafe = { ...report, control: { ...report.control, name: "bad\u001b[2J\u202ename" } };
    const rendered = renderGuardCompatibility(unsafe);
    assert.doesNotMatch(rendered, /\u001b|\u202e/u);
    assert.match(rendered, /Deployment: HOLD/);
    assert.notEqual(recomputeGuardCompatibilityReceiptHash(unsafe), report.receiptHash);
  } finally { selected.cleanup(); }
});

test("control argument files are bounded string arrays", () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-guard-args-"));
  try {
    const valid = join(root, "valid.json");
    const object = join(root, "object.json");
    const mixed = join(root, "mixed.json");
    writeFileSync(valid, '["one","--two"]');
    writeFileSync(object, '{"arg":"one"}');
    writeFileSync(mixed, '["one",2]');
    assert.deepEqual(loadControlArguments(valid), ["one", "--two"]);
    assert.throws(() => loadControlArguments(object), /JSON array/);
    assert.throws(() => loadControlArguments(mixed), /must be a string/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a separately named control artifact must be part of the exact invocation", () => {
  const selected = fixture();
  try {
    assert.throws(() => runGuardCompatibility({
      host: "codex",
      hostVersion: "0.149.1",
      hostExecutable: process.execPath,
      controlName: "Fixture guard",
      controlVersion: "1",
      controlExecutable: process.execPath,
      controlArtifact: selected.script,
      controlArguments: ["-e", "process.exit(0)"],
      policyPath: selected.policy,
      configurationPath: selected.configuration,
      vigilVersion: "test",
      nonce: "0123456789abcdef",
    }), /artifact must be named by a control argument/);
  } finally { selected.cleanup(); }
});

test("policy or configuration replacement during a run is rejected", () => {
  const selected = fixture();
  try {
    assert.throws(() => runGuardCompatibility({
      host: "claude",
      hostVersion: "2.1.245",
      hostExecutable: process.execPath,
      controlName: "Mutating fixture",
      controlVersion: "1",
      controlExecutable: process.execPath,
      controlArtifact: selected.script,
      controlArguments: [selected.script, "mutate", selected.capture, selected.policy],
      policyPath: selected.policy,
      configurationPath: selected.configuration,
      vigilVersion: "test",
      nonce: "0123456789abcdef",
    }), /policy changed during/);
  } finally { selected.cleanup(); }
});
