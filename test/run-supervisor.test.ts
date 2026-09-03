import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { runProtectedRunCommand } from "../src/run-cli.ts";
import { executeProtectedRun, recomputeProtectedRunHash, type ProtectedRunInput } from "../src/run-supervisor.ts";

const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

function root(): string {
  return mkdtempSync(join(tmpdir(), "vigil-run-"));
}

function input(args: string[], overrides: Partial<ProtectedRunInput> = {}): ProtectedRunInput {
  return {
    executable: process.execPath,
    args,
    cwd: process.cwd(),
    environment: process.env,
    timeLimitMs: 2_000,
    terminationGraceMs: 100,
    trajectoryLimits: {},
    telemetryGraceMs: 200,
    ...overrides,
  };
}

function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitForPidExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (pidExists(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return !pidExists(pid);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!existsSync(path)) throw new Error(`timed out waiting for ${path}`);
}

nodeTest("protected run explicitly refuses unsupported Windows execution", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(
    () => executeProtectedRun(input(["-e", "process.exit(0)"])),
    /requires POSIX process-group controls/,
  );
});

test("protected run propagates a normal child exit without calling it earned", async () => {
  const secret = "private prompt never serialized";
  const result = await executeProtectedRun(input(["-e", "process.exit(Number(process.argv[1]))", "7", secret]));
  assert.equal(result.exitCode, 7);
  assert.equal(result.receipt.state, "EXITED");
  assert.equal(result.receipt.process.exitCode, 7);
  assert.equal(result.receipt.outcome.commandCompletion, "OBSERVED_ONLY");
  assert.equal(result.receipt.outcome.economicResult, "NOT_CHECKED");
  assert.equal(result.receipt.command.launchedWithoutShell, true);
  assert.equal(recomputeProtectedRunHash(result.receipt), result.receipt.receiptHash);
  assert.doesNotMatch(JSON.stringify(result.receipt), new RegExp(secret));
});

test("protected run passes argv directly instead of interpreting shell syntax", async () => {
  const directory = root();
  const output = join(directory, "literal.txt");
  const injected = join(directory, "injected.txt");
  const literal = `literal; touch ${injected}`;
  const script = "require('node:fs').writeFileSync(process.argv[1], process.argv[2])";
  const result = await executeProtectedRun(input(["-e", script, output, literal]));
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(output, "utf8"), literal);
  assert.equal(existsSync(injected), false);
});

test("wall limit escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const result = await executeProtectedRun(input(["-e", script], {
    timeLimitMs: 250,
    terminationGraceMs: 100,
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.state, "STOPPED");
  assert.equal(result.receipt.stop?.code, "TIME_LIMIT");
  assert.equal(result.receipt.process.termSent, true);
  assert.equal(result.receipt.process.killSent, true);
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
  assert.ok(result.receipt.stop!.observed! >= 250);
});

test("wall limit remains live during post-launch executable verification", async () => {
  const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const startedAt = Date.now();
  const result = await executeProtectedRun(input(["-e", script], {
    timeLimitMs: 100,
    terminationGraceMs: 50,
  }));
  assert.equal(result.receipt.stop?.code, "TIME_LIMIT");
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
  assert.ok(Date.now() - startedAt < 1_500, "verification must not postpone deadline enforcement");
});

test("wall limit is not extended when the wall clock moves backward", () => {
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    import { executeProtectedRun } from ${JSON.stringify(supervisorUrl)};
    const wallNow = Date.now.bind(Date);
    const rewind = setTimeout(() => { Date.now = () => wallNow() - 3_600_000; }, 25);
    const emergency = setTimeout(() => process.kill(process.pid, "SIGINT"), 1_000);
    const result = await executeProtectedRun({
      executable: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      environment: process.env,
      timeLimitMs: 150,
      terminationGraceMs: 50,
      trajectoryLimits: {},
      telemetryGraceMs: 200,
    });
    clearTimeout(rewind);
    clearTimeout(emergency);
    process.stdout.write(JSON.stringify({ exitCode: result.exitCode, stop: result.receipt.stop }));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.exitCode, 124);
  assert.equal(observed.stop.code, "TIME_LIMIT");
  assert.ok(observed.stop.observed >= 150 && observed.stop.observed < 750);
});

test("receipt executable names support Unicode and normalize control characters", async () => {
  const directory = root();
  const schema = JSON.parse(readFileSync(join(process.cwd(), "docs/protected-run-v1.schema.json"), "utf8"));
  const basenamePattern = new RegExp(schema.properties.command.properties.executableBasename.pattern);
  for (const [name, expected] of [
    ["vigil-\u96ea", "vigil-\u96ea"],
    ["vigil-\n-run", "vigil-\uFFFD-run"],
  ]) {
    const executable = join(directory, name);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const result = await executeProtectedRun(input([], { executable, cwd: directory }));
    assert.equal(result.exitCode, 0);
    assert.equal(result.receipt.command.executableBasename, expected);
    assert.match(result.receipt.command.executableBasename, basenamePattern);
  }
});

test("wall limit terminates an ordinary descendant in the same process group", async () => {
  const directory = root();
  const pidPath = join(directory, "descendant.pid");
  const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const leader = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    "writeFileSync(process.argv[1],String(child.pid))",
    "process.on('SIGTERM',()=>{})",
    "setInterval(()=>{},1000)",
  ].join(";");
  const result = await executeProtectedRun(input(["-e", leader, pidPath], {
    timeLimitMs: 350,
    terminationGraceMs: 100,
  }));
  const descendantPid = Number(readFileSync(pidPath, "utf8"));
  assert.equal(result.receipt.stop?.code, "TIME_LIMIT");
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
  assert.equal(await waitForPidExit(descendantPid), true);
});

test("CLI SIGINT handler terminates the protected group and retains a receipt", { timeout: 8_000 }, async () => {
  const directory = root();
  const pidPath = join(directory, "leader.pid");
  const receiptPath = join(directory, "interrupt.json");
  const supervised = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const cli = spawn(process.execPath, [
    "--import", "tsx", join(process.cwd(), "src/cli.ts"),
    "run", "--time-limit", "5s", "--termination-grace", "100ms", "--output", receiptPath,
    "--", process.execPath, "-e", supervised, pidPath,
  ], { cwd: process.cwd(), stdio: "ignore" });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
    cli.once("error", rejectClose);
    cli.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  let leaderPid: number | undefined;
  try {
    await waitForFile(pidPath);
    leaderPid = Number(readFileSync(pidPath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    cli.kill("SIGINT");
    const result = await closed;
    assert.equal(result.code, 130);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.state, "STOPPED");
    assert.equal(receipt.stop.code, "SUPERVISOR_SIGNAL");
    assert.equal(receipt.stop.signal, "SIGINT");
    assert.equal(receipt.process.processGroupTerminationConfirmed, true);
  } finally {
    if (leaderPid && cli.exitCode === null && cli.signalCode === null && pidExists(leaderPid)) {
      try { process.kill(-leaderPid, "SIGKILL"); } catch { /* Best-effort fixture cleanup. */ }
    }
    if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
  }
});

test("a leader cannot leave an ordinary same-group descendant behind", async () => {
  const directory = root();
  const pidPath = join(directory, "orphan.pid");
  const descendant = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const leader = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    "writeFileSync(process.argv[1],String(child.pid))",
    "setTimeout(()=>process.exit(0),75)",
  ].join(";");
  const result = await executeProtectedRun(input(["-e", leader, pidPath], { terminationGraceMs: 100 }));
  const descendantPid = Number(readFileSync(pidPath, "utf8"));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.state, "STOPPED");
  assert.equal(result.receipt.stop?.code, "ORPHANED_DESCENDANTS");
  assert.equal(await waitForPidExit(descendantPid), true);
});

test("receipt does not claim containment of a hostile descendant that creates a new session", async () => {
  const directory = root();
  const pidPath = join(directory, "escaped.pid");
  const escaped = "setInterval(()=>{},1000)";
  const leader = [
    "const {spawn}=require('node:child_process')",
    "const {writeFileSync}=require('node:fs')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(escaped)}],{detached:true,stdio:'ignore'})`,
    "child.unref()",
    "writeFileSync(process.argv[1],String(child.pid))",
  ].join(";");
  let escapedPid: number | undefined;
  try {
    const result = await executeProtectedRun(input(["-e", leader, pidPath]));
    escapedPid = Number(readFileSync(pidPath, "utf8"));
    assert.equal(result.receipt.state, "EXITED");
    assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
    assert.equal(pidExists(escapedPid), true);
    assert.match(result.receipt.evidenceBoundary.join(" "), /escape by creating a new session/);
  } finally {
    if (escapedPid && pidExists(escapedPid)) process.kill(escapedPid, "SIGKILL");
  }
});

test("captured JSONL stops at the first exceeded tool-call limit and stays private", async () => {
  const directory = root();
  const transcript = join(directory, "captured.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "run" } },
    { type: "response_item", payload: { type: "function_call", call_id: "one", name: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "one", output: JSON.stringify({ exit_code: 0 }) } },
    { type: "response_item", payload: { type: "function_call", call_id: "two", name: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }) } },
  ];
  const script = `process.stdout.write(${JSON.stringify(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)});setInterval(()=>{},1000)`;
  const result = await executeProtectedRun(input(["-e", script, "private argument"], {
    trajectoryLimits: { maxToolCalls: 1 },
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.stop?.code, "TOOL_CALL_LIMIT");
  assert.equal(result.receipt.stop?.observed, 2);
  assert.equal(result.receipt.telemetry?.authority, "child-controlled");
  assert.equal(result.receipt.telemetry?.transport, "supervisor-captured-stdout");
  assert.equal(statSync(transcript).mode & 0o777, 0o600);
  assert.match(readFileSync(transcript, "utf8"), /session_meta/);
  assert.doesNotMatch(JSON.stringify(result.receipt), /private argument|session_meta|exec_command/);
});

test("final buffered telemetry rejects a fast command that already crossed its cap", async () => {
  const directory = root();
  const transcript = join(directory, "fast.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "run" } },
    { type: "response_item", payload: { type: "function_call", call_id: "one", name: "exec_command", arguments: "{}" } },
    { type: "response_item", payload: { type: "function_call", call_id: "two", name: "exec_command", arguments: "{}" } },
  ];
  const script = `process.stdout.write(${JSON.stringify(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)})`;
  const result = await executeProtectedRun(input(["-e", script], {
    trajectoryLimits: { maxToolCalls: 1 },
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.state, "STOPPED");
  assert.equal(result.receipt.stop?.code, "TOOL_CALL_LIMIT");
  assert.equal(result.receipt.process.termSent, false);
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
});

test("final telemetry rejects malformed EOF without waiting out the grace period", async () => {
  const directory = root();
  const transcript = join(directory, "fast-invalid.jsonl");
  const result = await executeProtectedRun(input(["-e", "process.stdout.write('{not-json\\n')"], {
    telemetryGraceMs: 5_000,
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.state, "STOPPED");
  assert.equal(result.receipt.stop?.code, "TELEMETRY_UNREADABLE");
  assert.equal(result.receipt.telemetry?.parserStatus, "UNREADABLE");
  assert.ok(result.receipt.elapsedMs < 5_000);
});

test("final telemetry rejects missing requested token usage at EOF", async () => {
  const directory = root();
  const transcript = join(directory, "fast-no-usage.jsonl");
  const row = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const result = await executeProtectedRun(input(["-e", `process.stdout.write(${JSON.stringify(row)})`], {
    trajectoryLimits: { maxObservedTokens: 100 },
    telemetryGraceMs: 5_000,
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.state, "STOPPED");
  assert.equal(result.receipt.stop?.code, "TOKEN_USAGE_UNAVAILABLE");
  assert.equal(result.receipt.telemetry?.observedTokens, undefined);
  assert.ok(result.receipt.elapsedMs < 5_000);
});

test("large transcript parsing cannot delay wall-limit enforcement", { timeout: 15_000 }, async () => {
  const directory = root();
  const transcript = join(directory, "large-external.jsonl");
  const baseline = `${JSON.stringify({
    type: "session_meta",
    payload: { id: "run", padding: "x".repeat(49 * 1024 * 1024) },
  })}\n`;
  writeFileSync(transcript, baseline);
  const appended = `${JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", call_id: "one", name: "exec_command", arguments: "{}" },
  })}\n`;
  const script = "require('node:fs').appendFileSync(process.argv[1],process.argv[2]);process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const result = await executeProtectedRun(input(["-e", script, transcript, appended], {
    timeLimitMs: 150,
    terminationGraceMs: 50,
    trajectoryLimits: { maxToolCalls: 5 },
    telemetryGraceMs: 1_000,
    transcript: { path: transcript, transport: "external-file" },
  }));
  assert.equal(result.receipt.stop?.code, "TIME_LIMIT");
  assert.ok(result.receipt.stop!.observed! >= 150 && result.receipt.stop!.observed! < 750);
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
});

test("an exact trajectory maximum is allowed", async () => {
  const directory = root();
  const transcript = join(directory, "exact.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "run" } },
    { type: "response_item", payload: { type: "function_call", call_id: "one", name: "exec_command", arguments: "{}" } },
  ];
  const script = `process.stdout.write(${JSON.stringify(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)})`;
  const result = await executeProtectedRun(input(["-e", script], {
    trajectoryLimits: { maxToolCalls: 1 },
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.state, "EXITED");
  assert.equal(result.receipt.telemetry?.toolCalls, 1);
});

test("completed write evidence resets the no-progress clock once", async () => {
  const directory = root();
  const transcript = join(directory, "progress.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "run" } },
    { type: "response_item", payload: { type: "function_call", call_id: "write", name: "apply_patch", arguments: "*** Begin Patch\n*** End Patch" } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "write", output: "Done" } },
  ];
  const payload = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  const script = `setTimeout(()=>process.stdout.write(${JSON.stringify(payload)}),125);setInterval(()=>{},1000)`;
  const result = await executeProtectedRun(input(["-e", script], {
    timeLimitMs: 1_500,
    trajectoryLimits: { noProgressMs: 250 },
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.receipt.stop?.code, "NO_PROGRESS");
  assert.equal(result.receipt.telemetry?.completedProgressActions, 1);
  assert.ok(result.receipt.elapsedMs >= 350);
  assert.ok(result.receipt.elapsedMs < 1_500);
});

test("a completed read does not reset the no-progress clock", async () => {
  const directory = root();
  const transcript = join(directory, "read-only.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "run" } },
    { type: "response_item", payload: { type: "function_call", call_id: "read", name: "exec_command", arguments: JSON.stringify({ cmd: "pwd" }) } },
    { type: "response_item", payload: { type: "function_call_output", call_id: "read", output: JSON.stringify({ exit_code: 0 }) } },
  ];
  const script = `process.stdout.write(${JSON.stringify(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)});setInterval(()=>{},1000)`;
  const result = await executeProtectedRun(input(["-e", script], {
    trajectoryLimits: { noProgressMs: 250 },
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.receipt.stop?.code, "NO_PROGRESS");
  assert.equal(result.receipt.telemetry?.completedProgressActions, 0);
});

for (const scenario of [
  { name: "failed call", limits: { maxFailedToolCalls: 1 }, code: "FAILED_TOOL_CALL_LIMIT" },
  { name: "identical call", limits: { maxIdenticalToolCalls: 1 }, code: "IDENTICAL_TOOL_CALL_LIMIT" },
  { name: "consecutive failure", limits: { maxConsecutiveFailures: 1 }, code: "CONSECUTIVE_FAILURE_LIMIT" },
] as const) {
  test(`${scenario.name} limits stop on the first value above the maximum`, async () => {
    const directory = root();
    const transcript = join(directory, `${scenario.name.replaceAll(" ", "-")}.jsonl`);
    const rows: unknown[] = [{ type: "session_meta", payload: { id: "run" } }];
    for (const id of ["one", "two"]) {
      rows.push({ type: "response_item", payload: { type: "function_call", call_id: id, name: "exec_command", arguments: JSON.stringify({ cmd: "false" }) } });
      rows.push({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: JSON.stringify({ exit_code: 1 }) } });
    }
    const script = `process.stdout.write(${JSON.stringify(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)});setInterval(()=>{},1000)`;
    const result = await executeProtectedRun(input(["-e", script], {
      trajectoryLimits: scenario.limits,
      transcript: { path: transcript, transport: "supervisor-captured-stdout" },
    }));
    assert.equal(result.exitCode, 124);
    assert.equal(result.receipt.stop?.code, scenario.code);
    assert.equal(result.receipt.stop?.observed, 2);
    assert.equal(result.receipt.stop?.limit, 1);
  });
}

test("persistently malformed captured telemetry fails closed after its grace period", async () => {
  const directory = root();
  const transcript = join(directory, "invalid.jsonl");
  const script = "process.stdout.write('{not-json\\n');setInterval(()=>{},1000)";
  const result = await executeProtectedRun(input(["-e", script], {
    telemetryGraceMs: 150,
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.stop?.code, "TELEMETRY_UNREADABLE");
  assert.equal(result.receipt.telemetry?.parserStatus, "UNREADABLE");
  assert.ok(result.receipt.telemetry?.parseErrorSha256?.startsWith("sha256:"));
});

test("a partial JSONL row can complete inside the telemetry grace period", async () => {
  const directory = root();
  const transcript = join(directory, "partial-completes.jsonl");
  const marker = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const call = JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "one", name: "exec_command", arguments: "{}" } });
  const midpoint = Math.floor(call.length / 2);
  const script = [
    `process.stdout.write(${JSON.stringify(marker + call.slice(0, midpoint))})`,
    `setTimeout(()=>process.stdout.write(${JSON.stringify(`${call.slice(midpoint)}\n`)}),75)`,
    "setTimeout(()=>process.exit(0),175)",
  ].join(";");
  const result = await executeProtectedRun(input(["-e", script], {
    trajectoryLimits: { maxToolCalls: 1 },
    telemetryGraceMs: 250,
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.receipt.telemetry?.parserStatus, "READY");
  assert.equal(result.receipt.telemetry?.toolCalls, 1);
});

test("a partial JSONL row that never completes fails closed", async () => {
  const directory = root();
  const transcript = join(directory, "partial-stalls.jsonl");
  const marker = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const script = `process.stdout.write(${JSON.stringify(`${marker}{"type":"response_`)});setInterval(()=>{},1000)`;
  const result = await executeProtectedRun(input(["-e", script], {
    trajectoryLimits: { maxToolCalls: 5 },
    telemetryGraceMs: 150,
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.stop?.code, "TELEMETRY_UNREADABLE");
  assert.equal(result.receipt.telemetry?.parserStatus, "PARTIAL");
});

test("a requested token cap fails closed when the transcript exposes no usage", async () => {
  const directory = root();
  const transcript = join(directory, "no-usage.jsonl");
  const row = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const script = `process.stdout.write(${JSON.stringify(row)});setInterval(()=>{},1000)`;
  const result = await executeProtectedRun(input(["-e", script], {
    trajectoryLimits: { maxObservedTokens: 100 },
    telemetryGraceMs: 150,
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.stop?.code, "TOKEN_USAGE_UNAVAILABLE");
  assert.equal(result.receipt.telemetry?.observedTokens, undefined);
});

test("transcript-observed token usage stops only after the declared cap is exceeded", async () => {
  const directory = root();
  const transcript = join(directory, "tokens.jsonl");
  const rows = [
    { type: "session_meta", payload: { id: "run" } },
    { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 80, output_tokens: 21 } } } },
  ];
  const script = `process.stdout.write(${JSON.stringify(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)});setInterval(()=>{},1000)`;
  const result = await executeProtectedRun(input(["-e", script], {
    trajectoryLimits: { maxObservedTokens: 100 },
    transcript: { path: transcript, transport: "supervisor-captured-stdout" },
  }));
  assert.equal(result.receipt.stop?.code, "OBSERVED_TOKEN_LIMIT");
  assert.equal(result.receipt.stop?.observed, 101);
  assert.equal(result.receipt.telemetry?.observedTokens, 101);
});

test("a missing requested telemetry stream fails closed", async () => {
  const directory = root();
  const transcript = join(directory, "missing.jsonl");
  const result = await executeProtectedRun(input(["-e", "setInterval(()=>{},1000)"], {
    trajectoryLimits: { maxToolCalls: 5 },
    telemetryGraceMs: 150,
    transcript: { path: transcript, transport: "external-file" },
  }));
  assert.equal(result.receipt.stop?.code, "TELEMETRY_MISSING");
  assert.equal(result.receipt.telemetry?.parserStatus, "WAITING");
});

test("rewriting an externally observed transcript is an integrity stop", async () => {
  const directory = root();
  const transcript = join(directory, "external.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "before" } })}\n`);
  const replacement = `${JSON.stringify({ type: "session_meta", payload: { id: "after" } })}\n`;
  const script = `setTimeout(()=>require('node:fs').writeFileSync(process.argv[1],${JSON.stringify(replacement)}),125);setInterval(()=>{},1000)`;
  const result = await executeProtectedRun(input(["-e", script, transcript], {
    transcript: { path: transcript, transport: "external-file" },
  }));
  assert.equal(result.exitCode, 124);
  assert.equal(result.receipt.stop?.code, "TELEMETRY_INTEGRITY");
  assert.equal(result.receipt.telemetry?.appendOnly, false);
});

test("deleting an established external transcript is an integrity stop", async () => {
  const directory = root();
  const transcript = join(directory, "deleted.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "session_meta", payload: { id: "before" } })}\n`);
  const script = "setTimeout(()=>require('node:fs').unlinkSync(process.argv[1]),125);setInterval(()=>{},1000)";
  const result = await executeProtectedRun(input(["-e", script, transcript], {
    transcript: { path: transcript, transport: "external-file" },
  }));
  assert.equal(result.receipt.stop?.code, "TELEMETRY_INTEGRITY");
  assert.equal(existsSync(transcript), false);
});

test("CLI writes an owner-only receipt without retaining raw arguments", async () => {
  const directory = root();
  const receiptPath = join(directory, "receipt.json");
  const secret = "sensitive prompt text";
  const code = await runProtectedRunCommand([
    "--time-limit", "2s",
    "--output", receiptPath,
    "--", process.execPath, "-e", "process.exit(0)", secret,
  ]);
  assert.equal(code, 0);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  const serialized = readFileSync(receiptPath, "utf8");
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(JSON.parse(serialized).state, "EXITED");
});

test("an unsafe receipt destination is rejected before command launch", async (context) => {
  if (process.platform === "win32") { context.skip("symlink fixture requires POSIX semantics"); return; }
  const directory = root();
  const marker = join(directory, "launched.txt");
  const target = join(directory, "target.json");
  const output = join(directory, "receipt.json");
  writeFileSync(target, "unchanged");
  symlinkSync(target, output);
  const script = "require('node:fs').writeFileSync(process.argv[1],'launched')";
  const code = await runProtectedRunCommand([
    "--time-limit", "1s",
    "--output", output,
    "--", process.execPath, "-e", script, marker,
  ]);
  assert.equal(code, 2);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test("a captured transcript cannot traverse a symbolic-link parent", async (context) => {
  if (process.platform === "win32") { context.skip("symlink fixture requires POSIX semantics"); return; }
  const directory = root();
  const realParent = join(directory, "real");
  const linkedParent = join(directory, "linked");
  const marker = join(directory, "launched.txt");
  mkdirSync(realParent);
  symlinkSync(realParent, linkedParent);
  const script = "require('node:fs').writeFileSync(process.argv[1],'launched')";
  const code = await runProtectedRunCommand([
    "--time-limit", "1s",
    "--capture-jsonl", join(linkedParent, "captured.jsonl"),
    "--", process.execPath, "-e", script, marker,
  ]);
  assert.equal(code, 125);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(realParent, "captured.jsonl")), false);
});

test("a command-side --help argument is passed through", async () => {
  const directory = root();
  const marker = join(directory, "argument.txt");
  const script = "require('node:fs').writeFileSync(process.argv[2],process.argv[1])";
  const code = await runProtectedRunCommand([
    "--time-limit", "1s",
    "--", process.execPath, "-e", script, "--", "--help", marker,
  ]);
  assert.equal(code, 0);
  assert.equal(readFileSync(marker, "utf8"), "--help");
});

test("ambiguous receipt format options are rejected before launch", async () => {
  const directory = root();
  const marker = join(directory, "launched.txt");
  const script = "require('node:fs').writeFileSync(process.argv[1],'launched')";
  const code = await runProtectedRunCommand([
    "--time-limit", "1s", "--json", "--format", "text",
    "--", process.execPath, "-e", script, marker,
  ]);
  assert.equal(code, 2);
  assert.equal(existsSync(marker), false);
});

test("dollar budget option refuses before launching the command", async () => {
  const directory = root();
  const marker = join(directory, "launched.txt");
  const script = "require('node:fs').writeFileSync(process.argv[1],'launched')";
  const code = await runProtectedRunCommand([
    "--time-limit", "1s",
    "--budget-usd", "1",
    "--", process.execPath, "-e", script, marker,
  ]);
  assert.equal(code, 2);
  assert.equal(existsSync(marker), false);
});
