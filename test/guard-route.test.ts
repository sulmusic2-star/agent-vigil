import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DISPOSABLE_PROFILE_MARKER,
  GUARD_ROUTE_CHALLENGE_PACK,
  GUARD_ROUTE_SCHEMA,
  recomputeGuardRouteReceiptHash,
  runGuardRoute,
  type GuardRouteReport,
} from "../src/guard-route.ts";

type Fixture = {
  root: string;
  profile: string;
  host: string;
  ordinaryHome: string;
  cleanup: () => void;
};

function fixture(mode: "pass" | "extra" | "bypass-deny" | "same-id" | "unavailable" | "mutate-config" | "mutate-ordinary" | "require-user-environment" = "pass"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "vigil-live-route-test-"));
  const profile = join(root, "profile");
  const ordinaryHome = join(root, "ordinary-home");
  const host = join(root, "host.mjs");
  writeFileSync(join(root, "placeholder"), "test\n");
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(join(ordinaryHome, ".codex"), { mode: 0o700, recursive: true });
  writeFileSync(join(profile, ".agent-vigil-disposable-profile"), DISPOSABLE_PROFILE_MARKER, { mode: 0o600 });
  writeFileSync(host, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const mode = ${JSON.stringify(mode)};
if (mode === "unavailable") process.exit(1);
if (mode === "require-user-environment" && (process.env.USER !== "route-user" || process.env.LOGNAME !== "route-logname")) process.exit(1);
const hook = process.env.AGENT_VIGIL_ROUTE_HOOK_PATH;
const allow = process.env.AGENT_VIGIL_ROUTE_ALLOW_COMMAND;
const deny = process.env.AGENT_VIGIL_ROUTE_DENY_COMMAND;
const allowFile = process.env.AGENT_VIGIL_ROUTE_ALLOW_FILE;
const denyFile = process.env.AGENT_VIGIL_ROUTE_DENY_FILE;
const invoke = (command, id) => {
  const payload = JSON.stringify({
    session_id: "host-session-fixture",
    turn_id: "host-turn-fixture",
    transcript_path: null,
    cwd: process.cwd(),
    hook_event_name: "PreToolUse",
    model: "fixture",
    permission_mode: "dontAsk",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: id,
  });
  const result = spawnSync(process.execPath, [hook], { input: payload, encoding: "utf8" });
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
};
const token = (command) => command.match(/'([^']+)' > /)[1];
if (invoke(allow, "host-call-allow") === "allow") writeFileSync(allowFile, token(allow) + "\\n");
if (mode === "extra") invoke("printf '%s\\n' 'UNEXPECTED'", "host-call-extra");
const denyId = mode === "same-id" ? "host-call-allow" : "host-call-deny";
invoke(deny, denyId);
if (mode === "bypass-deny") writeFileSync(denyFile, token(deny) + "\\n");
if (mode === "mutate-config") writeFileSync(process.env.HOME + "/hooks.json", "{}\\n");
if (mode === "mutate-ordinary") writeFileSync(${JSON.stringify(join(ordinaryHome, ".codex", "hooks.json"))}, "{}\\n");
process.stdout.write(JSON.stringify({ result: "ROUTE_DRILL_COMPLETE" }));
`);
  chmodSync(host, 0o700);
  return { root, profile, host, ordinaryHome, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(selected: Fixture, host: "claude" | "codex" = "codex"): GuardRouteReport {
  return runGuardRoute({
    host,
    hostVersion: host === "codex" ? "0.149.1-fixture" : "2.1.245-fixture",
    hostExecutable: selected.host,
    profileHome: selected.profile,
    vigilVersion: "test",
    nonce: "0123456789abcdef0123456789abcdef",
    generatedAt: "2026-08-25T16:00:00.000Z",
    timeoutMs: 5_000,
  });
}

const unsupportedWindows = process.platform === "win32"
  ? "guard-route v1 supports macOS and Linux hosts only"
  : false;

test("real-host drill binds process and live evidence for Claude and Codex but keeps deployment on HOLD", { skip: unsupportedWindows }, () => {
  for (const host of ["claude", "codex"] as const) {
    const selected = fixture();
    try {
      const report = run(selected, host);
      assert.equal(report.schemaVersion, GUARD_ROUTE_SCHEMA);
      assert.equal(report.challengePack.id, GUARD_ROUTE_CHALLENGE_PACK);
      assert.equal(report.scope, "LIVE_HOST_ROUTING");
      assert.equal(report.status, "PASS");
      assert.equal(report.processConformance.status, "PASS");
      assert.deepEqual(report.challenges.map((item) => item.passed), [true, true]);
      assert.deepEqual(report.challenges.map((item) => item.observedExecution), [true, false]);
      assert.equal(report.challenges[0].sessionIdSha256, report.challenges[1].sessionIdSha256);
      assert.notEqual(report.challenges[0].toolUseIdSha256, report.challenges[1].toolUseIdSha256);
      assert.equal(report.deployment.state, "HOLD");
      assert.deepEqual(report.deployment.reasonCodes, ["OTHER_HOST_ROUTE_NOT_PROVEN", "NON_DEPLOYING_DRILL"]);
      assert.equal(report.nextGate.state, "ONE_HOST_PROVEN");
      assert.equal(report.cleanup.temporaryConfigurationRemoved, true);
      assert.equal(existsSync(join(selected.profile, host === "codex" ? "hooks.json" : "settings.json")), false);
      assert.equal(existsSync(join(selected.profile, "config.toml")), false);
      assert.equal(recomputeGuardRouteReceiptHash(report), report.receiptHash);
      const serialized = JSON.stringify(report);
      assert.equal(serialized.includes(selected.root), false);
      assert.equal(serialized.includes("AGENT_VIGIL_LIVE_HOST_ROUTE"), false);
      assert.equal(serialized.includes("ROUTE_DRILL_COMPLETE"), false);
    } finally { selected.cleanup(); }
  }
});

test("unexpected calls, a deny bypass, and reused host call ids fail closed", { skip: unsupportedWindows }, () => {
  for (const mode of ["extra", "bypass-deny", "same-id"] as const) {
    const selected = fixture(mode);
    try {
      const report = run(selected);
      assert.equal(report.status, "FAIL", mode);
      assert.equal(report.deployment.state, "HOLD", mode);
      assert.equal(report.nextGate.state, "BLOCKED", mode);
      if (mode === "extra") assert.equal(report.summary.unexpectedCalls, 1);
      if (mode === "bypass-deny") assert.equal(report.challenges[1].observedExecution, true);
    } finally { selected.cleanup(); }
  }
});

test("a host that exits before any routed call is inconclusive, never a route pass", { skip: unsupportedWindows }, () => {
  const selected = fixture("unavailable");
  try {
    const report = run(selected, "claude");
    assert.equal(report.status, "INCONCLUSIVE");
    assert.equal(report.summary.routedCalls, 0);
    assert.ok(report.deployment.reasonCodes.includes("HOST_UNAVAILABLE_BEFORE_ROUTE"));
    assert.equal(report.nextGate.state, "BLOCKED");
  } finally { selected.cleanup(); }
});

test("the live host receives the bounded user identity variables required for macOS keychain lookup", { skip: unsupportedWindows }, () => {
  const selected = fixture("require-user-environment");
  const originalUser = process.env.USER;
  const originalLogname = process.env.LOGNAME;
  try {
    process.env.USER = "route-user";
    process.env.LOGNAME = "route-logname";
    const report = run(selected, "claude");
    assert.equal(report.status, "PASS");
    assert.equal(JSON.stringify(report).includes("route-user"), false);
    assert.equal(JSON.stringify(report).includes("route-logname"), false);
  } finally {
    if (originalUser === undefined) delete process.env.USER;
    else process.env.USER = originalUser;
    if (originalLogname === undefined) delete process.env.LOGNAME;
    else process.env.LOGNAME = originalLogname;
    selected.cleanup();
  }
});

test("host-side configuration mutation is rejected and the temporary file is still removed", { skip: unsupportedWindows }, () => {
  const selected = fixture("mutate-config");
  try {
    assert.throws(() => run(selected), /configuration changed during/);
    assert.equal(existsSync(join(selected.profile, "hooks.json")), false);
    assert.equal(existsSync(join(selected.profile, "config.toml")), false);
  } finally { selected.cleanup(); }
});

test("an ordinary host configuration file that appears during the drill is rejected", { skip: unsupportedWindows }, () => {
  const selected = fixture("mutate-ordinary");
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = selected.ordinaryHome;
    assert.throws(() => run(selected), /ordinary hooks\.json appeared during/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    selected.cleanup();
  }
});

test("ordinary profiles, bad markers, and pre-existing route configuration are refused", { skip: unsupportedWindows }, () => {
  const selected = fixture();
  try {
    assert.throws(() => runGuardRoute({
      host: "codex",
      hostVersion: "fixture",
      hostExecutable: selected.host,
      profileHome: process.env.HOME!,
      vigilVersion: "test",
    }), /ordinary user profile/);
    writeFileSync(join(selected.profile, ".agent-vigil-disposable-profile"), "wrong\n");
    assert.throws(() => run(selected), /marker has unexpected content/);
    writeFileSync(join(selected.profile, ".agent-vigil-disposable-profile"), DISPOSABLE_PROFILE_MARKER);
    writeFileSync(join(selected.profile, "hooks.json"), "{}\n");
    assert.throws(() => run(selected), /already contains host configuration/);
  } finally { selected.cleanup(); }
});

test("the reduced receipt excludes host output, prompts, raw commands, paths, and profile contents", { skip: unsupportedWindows }, () => {
  const selected = fixture();
  try {
    writeFileSync(join(selected.profile, "auth.json"), '{"token":"DO_NOT_COPY_THIS_SECRET"}\n', { mode: 0o600 });
    const report = run(selected);
    const serialized = JSON.stringify(report);
    for (const forbidden of [
      "DO_NOT_COPY_THIS_SECRET",
      selected.profile,
      "Copy each command byte-for-byte",
      "printf '%s",
      ".agent-vigil-live-route-allow",
    ]) assert.equal(serialized.includes(forbidden), false, forbidden);
    assert.equal(readFileSync(join(selected.profile, "auth.json"), "utf8").includes("DO_NOT_COPY_THIS_SECRET"), true);
  } finally { selected.cleanup(); }
});
