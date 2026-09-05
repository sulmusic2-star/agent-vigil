import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import { runProtectedRunCommand } from "../src/run-cli.ts";
import {
  executeProtectedRun,
  recomputeProtectedRunHash,
  type ProtectedRunInput,
  type ProtectedRunResult,
} from "../src/run-supervisor.ts";
import { MAX_TRANSCRIPT_BYTES } from "../src/transcript.ts";

const test = process.platform === "win32" ? nodeTest.skip : nodeTest;

function root(): string {
  return mkdtempSync(join(tmpdir(), "vigil-run-"));
}

function protectedEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // Killed fixture processes can leave partial V8 JSON and corrupt the parent coverage report.
  delete environment.NODE_V8_COVERAGE;
  return environment;
}

function coverageHarnessEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function protectedCliHarness(args: string[]): string {
  const runCliUrl = new URL("../src/run-cli.ts", import.meta.url).href;
  return `
    const { runProtectedRunCommand } = await import(${JSON.stringify(runCliUrl)});
    const environment = { ...process.env };
    delete environment.NODE_V8_COVERAGE;
    process.exitCode = await runProtectedRunCommand(${JSON.stringify(args)}, environment);
  `;
}

function input(args: string[], overrides: Partial<ProtectedRunInput> = {}): ProtectedRunInput {
  return {
    executable: process.execPath,
    args,
    cwd: process.cwd(),
    environment: protectedEnvironment(),
    timeLimitMs: 2_000,
    terminationGraceMs: 100,
    trajectoryLimits: {},
    telemetryGraceMs: 200,
    ...overrides,
  };
}

function pidCanExecute(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const state = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/)[0] : undefined;
    return state !== "Z" && state !== "X" && state !== "x";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ESRCH";
  }
}

async function waitForPidToStopExecuting(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (pidCanExecute(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  return !pidCanExecute(pid);
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
  assert.equal(result.receipt.command.executableIdentityStable, true);
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
  assert.equal(result.receipt.stop?.code, "TIME_LIMIT", JSON.stringify(result.receipt));
  assert.equal(result.receipt.process.termSent, true);
  assert.equal(result.receipt.process.killSent, true);
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
  assert.ok(result.receipt.stop!.observed! >= 250);
});

nodeTest("a zombie process leader cannot hide a runnable worker thread", {
  skip: process.platform !== "linux",
  timeout: 8_000,
}, async (context) => {
  const directory = root();
  const executable = join(directory, "zombie-leader-worker");
  const heartbeat = join(directory, "worker.heartbeat");
  const fixture = fileURLToPath(new URL("fixtures/zombie-leader-worker.c", import.meta.url));
  const compiled = spawnSync("cc", ["-std=c11", "-O2", "-pthread", fixture, "-o", executable], {
    encoding: "utf8",
  });
  if (compiled.error && (compiled.error as NodeJS.ErrnoException).code === "ENOENT") {
    if (process.env.AGENT_VIGIL_REQUIRE_LINUX_THREAD_FIXTURE === "true") {
      assert.fail("the required Linux C compiler is unavailable");
    }
    context.skip("requires a Linux C compiler");
    return;
  }
  assert.equal(compiled.error, undefined);
  assert.equal(compiled.status, 0, compiled.stderr);

  let processGroupId: number | undefined;
  try {
    const result = await executeProtectedRun(input([], {
      executable,
      args: [heartbeat],
      timeLimitMs: 250,
      terminationGraceMs: 50,
    }));
    processGroupId = result.receipt.process.processGroupId;
    assert.equal(result.exitCode, 124);
    assert.equal(result.receipt.state, "STOPPED");
    assert.equal(result.receipt.stop?.code, "TIME_LIMIT", JSON.stringify(result.receipt));
    assert.equal(result.receipt.process.termSent, true);
    assert.equal(result.receipt.process.killSent, true);
    assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);

    const heartbeatSize = statSync(heartbeat).size;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(statSync(heartbeat).size, heartbeatSize, "worker thread continued after the supervisor returned");
  } finally {
    if (processGroupId) {
      try { process.kill(-processGroupId, "SIGKILL"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
});

test("unconfirmed process-group termination is a supervisor error", { timeout: 6_000 }, () => {
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    (async () => {
      const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
      const fs = (await import("node:fs")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const originalKill = process.kill.bind(process);
      const originalReaddirSync = fs.readdirSync;
      let killSent = false;
      process.kill = (pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === 0 && killSent) return true;
        const result = originalKill(pid, signal);
        if (typeof pid === "number" && pid < 0 && signal === "SIGKILL") killSent = true;
        return result;
      };
      fs.readdirSync = (...args) => {
        if (args[0] === "/proc" && killSent) {
          throw Object.assign(new Error("simulated unavailable process-state evidence"), { code: "EACCES" });
        }
        return originalReaddirSync(...args);
      };
      syncBuiltinESMExports();
      const environment = { ...process.env };
      delete environment.NODE_V8_COVERAGE;
      try {
        const result = await executeProtectedRun({
          executable: process.execPath,
          args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
          cwd: process.cwd(),
          environment,
          timeLimitMs: 100,
          terminationGraceMs: 0,
          trajectoryLimits: {},
          telemetryGraceMs: 200,
        });
        process.stdout.write(JSON.stringify(result));
      } finally {
        process.kill = originalKill;
        fs.readdirSync = originalReaddirSync;
        syncBuiltinESMExports();
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const observed = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    timeout: 5_000,
  });
  assert.equal(observed.error, undefined);
  assert.equal(observed.status, 0, observed.stderr);
  const result = JSON.parse(observed.stdout) as ProtectedRunResult;
  assert.equal(result.exitCode, 125);
  assert.equal(result.receipt.state, "ERROR");
  assert.equal(result.receipt.stop?.code, "SUPERVISOR_ERROR");
  assert.equal(result.receipt.process.killSent, true);
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, false);
  assert.equal(recomputeProtectedRunHash(result.receipt), result.receipt.receiptHash);
});

nodeTest("hidepid-inaccessible processes require a stable pre-launch identity", {
  skip: process.platform !== "linux",
  timeout: 12_000,
}, () => {
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    (async () => {
      const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
      const fs = (await import("node:fs")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const originalKill = process.kill.bind(process);
      const originalReaddirSync = fs.readdirSync;
      const originalReadFileSync = fs.readFileSync;
      const originalStatSync = fs.statSync;
      let groupPid;
      let killSent = false;
      const inaccessiblePid = 4_000_000;
      let baselineMode = "stable";
      const directory = (name) => ({ name: String(name), isDirectory: () => true });
      const fakeStat = (pid) => {
        const fields = [
          "Z", "1", String(groupPid), "1", "1", "0", "0", "0", "0", "0",
          "0", "0", "0", "0", "0", "0", "0", "1", "0", "100",
        ];
        return String(pid) + " (hidepid-target) " + fields.join(" ");
      };
      process.kill = (pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === 0 && killSent) return true;
        const result = originalKill(pid, signal);
        if (typeof pid === "number" && pid < 0 && signal === "SIGKILL") {
          groupPid = -pid;
          killSent = true;
        }
        return result;
      };
      fs.readdirSync = (...args) => {
        const path = String(args[0]);
        if (path === "/proc") {
          if (!killSent) return baselineMode === "new" ? [] : [directory(inaccessiblePid)];
          return [directory(inaccessiblePid), directory(groupPid)];
        }
        if (killSent && path === "/proc/" + groupPid + "/task") {
          return [directory(groupPid)];
        }
        return originalReaddirSync(...args);
      };
      fs.readFileSync = (...args) => {
        const path = String(args[0]);
        if (path === "/proc/" + inaccessiblePid + "/stat") {
          throw Object.assign(new Error("simulated hidepid denial"), { code: "EACCES" });
        }
        if (killSent && (path === "/proc/" + groupPid + "/stat"
          || path === "/proc/" + groupPid + "/task/" + groupPid + "/stat")) {
          return fakeStat(groupPid);
        }
        return originalReadFileSync(...args);
      };
      fs.statSync = (...args) => {
        const path = String(args[0]);
        if (path === "/proc/" + inaccessiblePid) {
          return {
            isDirectory: () => true,
            dev: 1n,
            ino: BigInt(inaccessiblePid),
            uid: 0n,
            ctimeNs: baselineMode === "changed" && killSent ? 2n : 1n,
          };
        }
        return originalStatSync(...args);
      };
      syncBuiltinESMExports();
      const environment = { ...process.env };
      delete environment.NODE_V8_COVERAGE;
      try {
        const run = () => executeProtectedRun({
          executable: process.execPath,
          args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
          cwd: process.cwd(),
          environment,
          timeLimitMs: 100,
          terminationGraceMs: 0,
          trajectoryLimits: {},
          telemetryGraceMs: 200,
        });
        const unrelated = await run();
        groupPid = undefined;
        killSent = false;
        baselineMode = "changed";
        const changedIdentity = await run();
        groupPid = undefined;
        killSent = false;
        baselineMode = "new";
        const possibleMember = await run();
        process.stdout.write(JSON.stringify({ unrelated, changedIdentity, possibleMember }));
      } finally {
        process.kill = originalKill;
        fs.readdirSync = originalReaddirSync;
        fs.readFileSync = originalReadFileSync;
        fs.statSync = originalStatSync;
        syncBuiltinESMExports();
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const observed = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    timeout: 10_000,
  });
  assert.equal(observed.error, undefined);
  assert.equal(observed.status, 0, observed.stderr);
  const result = JSON.parse(observed.stdout) as {
    unrelated: ProtectedRunResult;
    changedIdentity: ProtectedRunResult;
    possibleMember: ProtectedRunResult;
  };
  assert.equal(result.unrelated.exitCode, 124);
  assert.equal(result.unrelated.receipt.state, "STOPPED");
  assert.equal(result.unrelated.receipt.stop?.code, "TIME_LIMIT");
  assert.equal(result.unrelated.receipt.process.killSent, true);
  assert.equal(result.unrelated.receipt.process.processGroupTerminationConfirmed, true);
  assert.equal(recomputeProtectedRunHash(result.unrelated.receipt), result.unrelated.receipt.receiptHash);

  for (const possibleMember of [result.changedIdentity, result.possibleMember]) {
    assert.equal(possibleMember.exitCode, 125);
    assert.equal(possibleMember.receipt.state, "ERROR");
    assert.equal(possibleMember.receipt.stop?.code, "SUPERVISOR_ERROR");
    assert.equal(possibleMember.receipt.process.killSent, true);
    assert.equal(possibleMember.receipt.process.processGroupTerminationConfirmed, false);
    assert.equal(recomputeProtectedRunHash(possibleMember.receipt), possibleMember.receipt.receiptHash);
  }
});

nodeTest("changing Linux task membership is not accepted as zombie-only", {
  skip: process.platform !== "linux",
  timeout: 6_000,
}, () => {
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    (async () => {
      const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
      const fs = (await import("node:fs")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const originalKill = process.kill.bind(process);
      const originalReaddirSync = fs.readdirSync;
      const originalReadFileSync = fs.readFileSync;
      let groupPid;
      let killSent = false;
      let taskDirectoryReads = 0;
      const directory = (name) => ({ name: String(name), isDirectory: () => true });
      const fakeStat = (pid, state, threadCount, startTime) => {
        const fields = [
          state, "1", String(groupPid), "1", "1", "0", "0", "0", "0", "0",
          "0", "0", "0", "0", "0", "0", "0", String(threadCount), "0", String(startTime),
        ];
        return String(pid) + " (membership-race) " + fields.join(" ");
      };
      process.kill = (pid, signal) => {
        if (typeof pid === "number" && pid < 0 && signal === 0 && killSent) return true;
        const result = originalKill(pid, signal);
        if (typeof pid === "number" && pid < 0 && signal === "SIGKILL") {
          groupPid = -pid;
          killSent = true;
        }
        return result;
      };
      fs.readdirSync = (...args) => {
        const path = String(args[0]);
        if (killSent && path === "/proc") {
          return [directory(groupPid)];
        }
        if (killSent && path === "/proc/" + groupPid + "/task") {
          taskDirectoryReads += 1;
          return taskDirectoryReads === 1
            ? [directory(groupPid), directory(groupPid + 1)]
            : [directory(groupPid), directory(groupPid + 2)];
        }
        return originalReaddirSync(...args);
      };
      fs.readFileSync = (...args) => {
        const path = String(args[0]);
        if (killSent && path === "/proc/" + groupPid + "/stat") {
          return fakeStat(groupPid, "Z", 2, 100);
        }
        if (killSent && path === "/proc/" + groupPid + "/task/" + groupPid + "/stat") {
          return fakeStat(groupPid, "Z", 2, 100);
        }
        if (killSent && path === "/proc/" + groupPid + "/task/" + (groupPid + 1) + "/stat") {
          return fakeStat(groupPid + 1, "Z", 2, 101);
        }
        if (killSent && path === "/proc/" + groupPid + "/task/" + (groupPid + 2) + "/stat") {
          return fakeStat(groupPid + 2, "S", 2, 102);
        }
        return originalReadFileSync(...args);
      };
      syncBuiltinESMExports();
      const environment = { ...process.env };
      delete environment.NODE_V8_COVERAGE;
      try {
        const result = await executeProtectedRun({
          executable: process.execPath,
          args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
          cwd: process.cwd(),
          environment,
          timeLimitMs: 100,
          terminationGraceMs: 0,
          trajectoryLimits: {},
          telemetryGraceMs: 200,
        });
        process.stdout.write(JSON.stringify(result));
      } finally {
        process.kill = originalKill;
        fs.readdirSync = originalReaddirSync;
        fs.readFileSync = originalReadFileSync;
        syncBuiltinESMExports();
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const observed = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    timeout: 5_000,
  });
  assert.equal(observed.error, undefined);
  assert.equal(observed.status, 0, observed.stderr);
  const result = JSON.parse(observed.stdout) as ProtectedRunResult;
  assert.equal(result.exitCode, 125);
  assert.equal(result.receipt.state, "ERROR");
  assert.equal(result.receipt.stop?.code, "SUPERVISOR_ERROR");
  assert.equal(result.receipt.process.killSent, true);
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, false);
  assert.equal(recomputeProtectedRunHash(result.receipt), result.receipt.receiptHash);
});

test("wall limit remains live during post-launch executable verification", async () => {
  const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const startedAt = Date.now();
  const result = await executeProtectedRun(input(["-e", script], {
    timeLimitMs: 100,
    terminationGraceMs: 50,
  }));
  assert.equal(result.receipt.stop?.code, "TIME_LIMIT", JSON.stringify(result.receipt));
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
  assert.ok(Date.now() - startedAt < 1_500, "verification must not postpone deadline enforcement");
});

test("a normal child exit is not relabeled as a timeout by slow identity verification", () => {
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const { open } = await import("node:fs/promises");
    const sample = await open(process.execPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(sample);
    await sample.close();
    const originalRead = fileHandlePrototype.read;
    let delayed = false;
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    fileHandlePrototype.read = async function (...args) {
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return originalRead.apply(this, args);
    };
    try {
      const result = await executeProtectedRun({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 500,
        terminationGraceMs: 50,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
      });
      process.stdout.write(JSON.stringify(result));
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout) as ProtectedRunResult;
  assert.equal(observed.exitCode, 0);
  assert.equal(observed.receipt.state, "EXITED");
  assert.equal(observed.receipt.stop, undefined);
  assert.equal(observed.receipt.process.exitCode, 0);
  assert.equal(observed.receipt.command.executableIdentityStable, true);
});

test("slow capture persistence cannot delay wall-limit enforcement", { timeout: 8_000 }, () => {
  const directory = root();
  const transcript = join(directory, "slow-capture.jsonl");
  const resultPath = join(directory, "result.json");
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const row = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const harness = `(async () => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const originalWrite = fs.write;
    fs.write = (...args) => setTimeout(() => originalWrite(...args), 400);
    syncBuiltinESMExports();
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    try {
      const result = await executeProtectedRun({
        executable: process.execPath,
        args: ["-e", ${JSON.stringify(`process.stdout.write(${JSON.stringify(row)});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`) }],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 100,
        terminationGraceMs: 50,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
        transcript: { path: ${JSON.stringify(transcript)}, transport: "supervisor-captured-stdout" },
      });
      fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
    } finally {
      fs.write = originalWrite;
      syncBuiltinESMExports();
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(resultPath, "utf8")) as ProtectedRunResult;
  assert.equal(observed.receipt.stop?.code, "TIME_LIMIT");
  assert.ok(observed.receipt.stop!.observed! >= 100 && observed.receipt.stop!.observed! < 300);
  assert.equal(observed.receipt.process.processGroupTerminationConfirmed, true);
  assert.equal(readFileSync(transcript, "utf8"), row);
});

test("slow stdout relay cannot delay wall-limit enforcement", { timeout: 8_000 }, () => {
  const directory = root();
  const transcript = join(directory, "slow-relay.jsonl");
  const resultPath = join(directory, "result.json");
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const row = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const harness = `(async () => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const originalWrite = fs.write;
    fs.write = (descriptor, ...args) => descriptor === 1
      ? setTimeout(() => originalWrite(descriptor, ...args), 400)
      : originalWrite(descriptor, ...args);
    syncBuiltinESMExports();
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    try {
      const result = await executeProtectedRun({
        executable: process.execPath,
        args: ["-e", ${JSON.stringify(`process.stdout.write(${JSON.stringify(row)});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`) }],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 100,
        terminationGraceMs: 50,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
        transcript: { path: ${JSON.stringify(transcript)}, transport: "supervisor-captured-stdout" },
      });
      fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
    } finally {
      fs.write = originalWrite;
      syncBuiltinESMExports();
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(resultPath, "utf8")) as ProtectedRunResult;
  assert.equal(observed.receipt.stop?.code, "TIME_LIMIT");
  assert.ok(observed.receipt.stop!.observed! >= 100 && observed.receipt.stop!.observed! < 300);
  assert.equal(observed.receipt.process.processGroupTerminationConfirmed, true);
  assert.equal(readFileSync(transcript, "utf8"), row);
});

test("stdout relay retries transient EAGAIN backpressure", { timeout: 8_000 }, () => {
  const directory = root();
  const transcript = join(directory, "relay-eagain.jsonl");
  const resultPath = join(directory, "result.json");
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const row = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const harness = `(async () => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const originalWrite = fs.write;
    let retries = 0;
    fs.write = (descriptor, ...args) => {
      if (descriptor === 1 && retries < 4) {
        retries += 1;
        const callback = args.at(-1);
        const error = Object.assign(new Error("try again"), { code: "EAGAIN" });
        setTimeout(() => callback(error, 0, args[0]), 5);
        return;
      }
      return originalWrite(descriptor, ...args);
    };
    syncBuiltinESMExports();
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    try {
      const result = await executeProtectedRun({
        executable: process.execPath,
        args: ["-e", ${JSON.stringify(`process.stdout.write(${JSON.stringify(row)})`) }],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 2_000,
        terminationGraceMs: 50,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
        transcript: { path: ${JSON.stringify(transcript)}, transport: "supervisor-captured-stdout" },
      });
      fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ result, retries }));
    } finally {
      fs.write = originalWrite;
      syncBuiltinESMExports();
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(resultPath, "utf8")) as { result: ProtectedRunResult; retries: number };
  assert.equal(observed.retries, 4);
  assert.equal(observed.result.exitCode, 0);
  assert.equal(observed.result.receipt.state, "EXITED");
  assert.equal(readFileSync(transcript, "utf8"), row);
});

test("capture retry deadline cancels persistence and overrides an earlier limit stop", { timeout: 12_000 }, () => {
  const directory = root();
  const transcript = join(directory, "drain-failure.jsonl");
  const resultPath = join(directory, "result.json");
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const row = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const harness = `(async () => {
    const fs = (await import("node:fs")).default;
    const { syncBuiltinESMExports } = await import("node:module");
    const originalWrite = fs.write;
    fs.write = (descriptor, ...args) => {
      if (descriptor === 1) return originalWrite(descriptor, ...args);
      const callback = args.at(-1);
      const error = Object.assign(new Error("try again"), { code: "EAGAIN" });
      setTimeout(() => callback(error, 0, args[0]), 5);
    };
    syncBuiltinESMExports();
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    try {
      const result = await executeProtectedRun({
        executable: process.execPath,
        args: ["-e", ${JSON.stringify(`process.stdout.write(${JSON.stringify(row)});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`) }],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 100,
        terminationGraceMs: 50,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
        transcript: { path: ${JSON.stringify(transcript)}, transport: "supervisor-captured-stdout" },
      });
      fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
    } finally {
      fs.write = originalWrite;
      syncBuiltinESMExports();
    }
  })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(resultPath, "utf8")) as ProtectedRunResult;
  assert.equal(observed.exitCode, 125);
  assert.equal(observed.receipt.state, "ERROR");
  assert.equal(observed.receipt.stop?.code, "SUPERVISOR_ERROR");
  assert.equal(observed.receipt.process.processGroupTerminationConfirmed, true);
});

test("a transcript-size breach never persists bytes beyond the capture cap", { timeout: 30_000 }, () => {
  const directory = root();
  const transcript = join(directory, "bounded-capture.jsonl");
  const resultPath = join(directory, "result.json");
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const emittedBytes = MAX_TRANSCRIPT_BYTES + 64 * 1024;
  const command = `
    const row = JSON.stringify({ type: "session_meta", payload: { id: "run", padding: "x".repeat(64 * 1024) } }) + "\\n";
    let sent = 0;
    const send = () => {
      while (sent <= ${emittedBytes}) {
        sent += Buffer.byteLength(row);
        if (!process.stdout.write(row)) {
          process.stdout.once("drain", send);
          return;
        }
      }
    };
    send();
  `;
  const harness = `(async () => {
    const { writeFileSync } = await import("node:fs");
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    const result = await executeProtectedRun({
      executable: process.execPath,
      args: ["-e", ${JSON.stringify(command)}],
      cwd: process.cwd(),
      environment: protectedEnvironment,
      timeLimitMs: 20_000,
      terminationGraceMs: 50,
      trajectoryLimits: {},
      telemetryGraceMs: 5_000,
      transcript: { path: ${JSON.stringify(transcript)}, transport: "supervisor-captured-stdout" },
    });
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 25_000,
  });
  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(readFileSync(resultPath, "utf8")) as ProtectedRunResult;
    assert.equal(observed.exitCode, 124);
    assert.equal(observed.receipt.state, "STOPPED");
    assert.equal(observed.receipt.stop?.code, "TRANSCRIPT_SIZE");
    assert.ok(statSync(transcript).size <= MAX_TRANSCRIPT_BYTES);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stdout backpressure cannot discard captured tail telemetry", { timeout: 8_000 }, () => {
  const directory = root();
  const transcript = join(directory, "relay-tail.jsonl");
  const resultPath = join(directory, "result.json");
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const firstRow = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const finalRow = `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 3, output_tokens: 5 } } } })}\n`;
  const command = `${`process.stdout.write(${JSON.stringify(firstRow)})`};setTimeout(()=>{process.stdout.write(${JSON.stringify(finalRow)});process.exit(0)},25)`;
  const harness = `(async () => {
    process.stdout.write = () => false;
    const { writeFileSync } = await import("node:fs");
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    const result = await executeProtectedRun({
      executable: process.execPath,
      args: ["-e", ${JSON.stringify(command)}],
      cwd: process.cwd(),
      environment: protectedEnvironment,
      timeLimitMs: 2_000,
      terminationGraceMs: 50,
      trajectoryLimits: { maxObservedTokens: 8 },
      telemetryGraceMs: 200,
      transcript: { path: ${JSON.stringify(transcript)}, transport: "supervisor-captured-stdout" },
    });
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", harness], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(resultPath, "utf8")) as ProtectedRunResult;
  assert.equal(observed.exitCode, 0);
  assert.equal(observed.receipt.state, "EXITED");
  assert.equal(observed.receipt.telemetry?.observedTokens, 8);
  assert.equal(readFileSync(transcript, "utf8"), `${firstRow}${finalRow}`);
});

test("a closed stdout consumer stops and cleans up the protected process group", { timeout: 8_000 }, async () => {
  const directory = root();
  const transcript = join(directory, "closed-relay.jsonl");
  const resultPath = join(directory, "result.json");
  const pidPath = join(directory, "leader.pid");
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const firstRow = `${JSON.stringify({ type: "session_meta", payload: { id: "run" } })}\n`;
  const nextRow = `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } } })}\n`;
  const command = [
    "const fs=require('node:fs')",
    "fs.writeFileSync(process.argv[1],String(process.pid))",
    `process.stdout.write(${JSON.stringify(firstRow)})`,
    "process.on('SIGTERM',()=>{})",
    `setInterval(()=>process.stdout.write(${JSON.stringify(nextRow)}),5)`,
  ].join(";");
  const harness = `(async () => {
    const { writeFileSync } = await import("node:fs");
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    const result = await executeProtectedRun({
      executable: process.execPath,
      args: ["-e", ${JSON.stringify(command)}, ${JSON.stringify(pidPath)}],
      cwd: process.cwd(),
      environment: protectedEnvironment,
      timeLimitMs: 5_000,
      terminationGraceMs: 50,
      trajectoryLimits: {},
      telemetryGraceMs: 200,
      transcript: { path: ${JSON.stringify(transcript)}, transport: "supervisor-captured-stdout" },
    });
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  const outer = spawn(process.execPath, ["--import", "tsx", "-e", harness], {
    cwd: process.cwd(),
    env: coverageHarnessEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  outer.stderr!.setEncoding("utf8");
  outer.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
    outer.once("error", rejectClose);
    outer.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  await new Promise<void>((resolveOutput, rejectOutput) => {
    outer.stdout!.once("data", () => resolveOutput());
    outer.once("error", rejectOutput);
  });
  outer.stdout!.destroy();
  const outerResult = await closed;
  assert.equal(outerResult.signal, null, stderr);
  assert.equal(outerResult.code, 0, stderr);
  const observed = JSON.parse(readFileSync(resultPath, "utf8")) as ProtectedRunResult;
  const leaderPid = Number(readFileSync(pidPath, "utf8"));
  assert.equal(observed.exitCode, 125);
  assert.equal(observed.receipt.state, "ERROR");
  assert.equal(observed.receipt.stop?.code, "SUPERVISOR_ERROR");
  assert.equal(observed.receipt.process.processGroupTerminationConfirmed, true);
  assert.equal(await waitForPidToStopExecuting(leaderPid), true);
});

test("an interrupted post-launch executable verification remains explicitly not checked", () => {
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const { open } = await import("node:fs/promises");
    const sample = await open(process.execPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(sample);
    await sample.close();
    const originalRead = fileHandlePrototype.read;
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    fileHandlePrototype.read = async function (...args) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return originalRead.apply(this, args);
    };
    try {
      const result = await executeProtectedRun({
        executable: process.execPath,
        args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 100,
        terminationGraceMs: 50,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
      });
      process.stdout.write(JSON.stringify(result));
    } finally {
      fileHandlePrototype.read = originalRead;
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout) as ProtectedRunResult;
  assert.equal(observed.exitCode, 124);
  assert.equal(observed.receipt.stop?.code, "TIME_LIMIT");
  assert.equal(observed.receipt.command.executableIdentityStable, "NOT_CHECKED");
  assert.equal(recomputeProtectedRunHash(observed.receipt), observed.receipt.receiptHash);
});

test("a signal after child exit keeps interrupted executable verification not checked", () => {
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
    const { open } = await import("node:fs/promises");
    const sample = await open(process.execPath, "r");
    const fileHandlePrototype = Object.getPrototypeOf(sample);
    await sample.close();
    const originalRead = fileHandlePrototype.read;
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    fileHandlePrototype.read = async function (...args) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return originalRead.apply(this, args);
    };
    const interrupt = setTimeout(() => process.kill(process.pid, "SIGINT"), 200);
    try {
      const result = await executeProtectedRun({
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 2_000,
        terminationGraceMs: 50,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
      });
      process.stdout.write(JSON.stringify(result));
    } finally {
      clearTimeout(interrupt);
      fileHandlePrototype.read = originalRead;
    }
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout) as ProtectedRunResult;
  assert.equal(observed.exitCode, 130);
  assert.equal(observed.receipt.state, "STOPPED");
  assert.equal(observed.receipt.stop?.code, "SUPERVISOR_SIGNAL");
  assert.equal(observed.receipt.stop?.signal, "SIGINT");
  assert.equal(observed.receipt.process.exitCode, 0, "the child must have exited before verification was interrupted");
  assert.equal(observed.receipt.command.executableIdentityStable, "NOT_CHECKED");
  assert.equal(recomputeProtectedRunHash(observed.receipt), observed.receipt.receiptHash);
});

test("wall limit is not extended when the wall clock moves backward", () => {
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    import { executeProtectedRun } from ${JSON.stringify(supervisorUrl)};
    const protectedEnvironment = { ...process.env };
    delete protectedEnvironment.NODE_V8_COVERAGE;
    const wallNow = Date.now.bind(Date);
    const rewind = setTimeout(() => { Date.now = () => wallNow() - 3_600_000; }, 25);
    const emergency = setTimeout(() => process.kill(process.pid, "SIGINT"), 1_000);
    const result = await executeProtectedRun({
      executable: process.execPath,
      args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      environment: protectedEnvironment,
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
    env: coverageHarnessEnvironment(),
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

test("protected-run schema binds stop evidence to the receipt state", () => {
  const schema = JSON.parse(readFileSync(join(process.cwd(), "docs/protected-run-v1.schema.json"), "utf8"));
  const exited = schema.allOf.find((condition: any) => condition.if?.properties?.state?.const === "EXITED");
  const interrupted = schema.allOf.find((condition: any) => condition.if?.properties?.state?.enum);
  assert.deepEqual(exited.then.not.required, ["stop"]);
  assert.deepEqual(interrupted.if.properties.state.enum, ["STOPPED", "ERROR"]);
  assert.deepEqual(interrupted.then.required, ["stop"]);
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
  assert.equal(result.receipt.stop?.code, "TIME_LIMIT", JSON.stringify(result.receipt));
  assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
  assert.equal(await waitForPidToStopExecuting(descendantPid), true);
});

test("CLI SIGINT handler terminates the protected group and retains a receipt", { timeout: 8_000 }, async () => {
  const directory = root();
  const pidPath = join(directory, "leader.pid");
  const receiptPath = join(directory, "interrupt.json");
  const supervised = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const cliArgs = [
    "--time-limit", "5s", "--termination-grace", "100ms", "--output", receiptPath,
    "--", process.execPath, "-e", supervised, pidPath,
  ];
  const cli = spawn(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", protectedCliHarness(cliArgs),
  ], { cwd: process.cwd(), env: coverageHarnessEnvironment(), stdio: "ignore" });
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
    if (leaderPid && cli.exitCode === null && cli.signalCode === null && pidCanExecute(leaderPid)) {
      try { process.kill(-leaderPid, "SIGKILL"); } catch { /* Best-effort fixture cleanup. */ }
    }
    if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
  }
});

type PreLaunchSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
type PreLaunchSignalObserved = { emitted?: boolean; launched: boolean; result: ProtectedRunResult };

function runPreLaunchSignalFixture(signal: PreLaunchSignal, transcriptContents?: string): PreLaunchSignalObserved {
  const directory = root();
  const markerPath = join(directory, "launched.txt");
  const transcriptPath = join(directory, "external.jsonl");
  if (transcriptContents !== undefined) writeFileSync(transcriptPath, transcriptContents);
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    (async () => {
      const { existsSync } = await import("node:fs");
      const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
      const protectedEnvironment = { ...process.env };
      delete protectedEnvironment.NODE_V8_COVERAGE;
      const pending = executeProtectedRun({
        executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'launched')", ${JSON.stringify(markerPath)}],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 2_000,
        terminationGraceMs: 100,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
        transcript: { path: ${JSON.stringify(transcriptPath)}, transport: "external-file" },
      });
      process.emit(${JSON.stringify(signal)});
      const result = await pending;
      process.stdout.write(JSON.stringify({ result, launched: existsSync(${JSON.stringify(markerPath)}) }));
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as PreLaunchSignalObserved;
}

function assertPreLaunchSignalResult(
  observed: PreLaunchSignalObserved,
  signal: PreLaunchSignal,
  exitCode: number,
): void {
  assert.equal(observed.launched, false);
  assert.equal(observed.result.exitCode, exitCode);
  assert.equal(observed.result.receipt.state, "STOPPED");
  const stop = observed.result.receipt.stop;
  assert.ok(stop);
  assert.equal(stop.code, "SUPERVISOR_SIGNAL");
  assert.equal(stop.signal, signal);
  assert.equal(observed.result.receipt.process.leaderPid, undefined);
  assert.equal(observed.result.receipt.process.termSent, false);
  assert.equal(observed.result.receipt.process.killSent, false);
  assert.equal(observed.result.receipt.process.processGroupTerminationConfirmed, true);
  assert.equal(observed.result.receipt.command.executableIdentityStable, "NOT_CHECKED");
  assert.equal(recomputeProtectedRunHash(observed.result.receipt), observed.result.receipt.receiptHash);
}

test("a supervisor signal during telemetry initialization prevents command launch", () => {
  assertPreLaunchSignalResult(runPreLaunchSignalFixture("SIGINT"), "SIGINT", 130);
});

test("a telemetry initialization error cannot overwrite an earlier supervisor signal", () => {
  assertPreLaunchSignalResult(runPreLaunchSignalFixture("SIGTERM", "{not-json\n"), "SIGTERM", 143);
});

test("signal handlers are active while the executable is hashed", () => {
  const directory = root();
  const markerPath = join(directory, "launched.txt");
  const supervisorUrl = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const script = `
    (async () => {
      const { executeProtectedRun } = await import(${JSON.stringify(supervisorUrl)});
      const protectedEnvironment = { ...process.env };
      delete protectedEnvironment.NODE_V8_COVERAGE;
      const fs = (await import("node:fs")).default;
      const { syncBuiltinESMExports } = await import("node:module");
      const originalReadSync = fs.readSync;
      let emitted = false;
      fs.readSync = (...args) => {
        const count = originalReadSync(...args);
        if (!emitted) {
          emitted = true;
          process.emit("SIGHUP");
        }
        return count;
      };
      syncBuiltinESMExports();
      const { existsSync } = await import("node:fs");
      const result = await executeProtectedRun({
        executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync(process.argv[1], 'launched')", ${JSON.stringify(markerPath)}],
        cwd: process.cwd(),
        environment: protectedEnvironment,
        timeLimitMs: 2_000,
        terminationGraceMs: 100,
        trajectoryLimits: {},
        telemetryGraceMs: 200,
      });
      fs.readSync = originalReadSync;
      syncBuiltinESMExports();
      process.stdout.write(JSON.stringify({ result, emitted, launched: existsSync(${JSON.stringify(markerPath)}) }));
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: coverageHarnessEnvironment(),
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout) as PreLaunchSignalObserved;
  assert.equal(observed.emitted, true);
  assertPreLaunchSignalResult(observed, "SIGHUP", 129);
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
  assert.equal(await waitForPidToStopExecuting(descendantPid), true);
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
    assert.equal(pidCanExecute(escapedPid), true);
    assert.match(result.receipt.evidenceBoundary.join(" "), /escape by creating a new session/);
  } finally {
    if (escapedPid && pidCanExecute(escapedPid)) process.kill(escapedPid, "SIGKILL");
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

function assertStalledTelemetryShutdown(mode: "ready" | "ready-signal" | "in-flight" | "final" | "close"): void {
  const directory = root();
  const transcriptPath = join(directory, "external.jsonl");
  const receiptPath = join(directory, "receipt.json");
  const pidPath = join(directory, "child.pid");
  const interceptedPath = join(directory, "intercepted.json");
  writeFileSync(transcriptPath, "");
  const runCliUrl = new URL("../src/run-cli.ts", import.meta.url).href;
  const script = `
    (async () => {
    const { Worker } = await import("node:worker_threads");
    const { writeFileSync } = await import("node:fs");
    const postMessage = Worker.prototype.postMessage;
    const terminate = Worker.prototype.terminate;
    const emit = Worker.prototype.emit;
    let intercepted = false;
    Worker.prototype.emit = function(event, ...args) {
      if (event === "message" && args[0]?.kind === "ready" && ${JSON.stringify(mode)}.startsWith("ready")) {
        intercepted = true;
        if (${JSON.stringify(mode)} === "ready-signal") setImmediate(() => process.emit("SIGINT"));
        return false;
      }
      return emit.call(this, event, ...args);
    };
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.kind === "poll" && (
        ${JSON.stringify(mode)} === "in-flight" ||
        (${JSON.stringify(mode)} === "final" && message.terminal)
      )) {
        intercepted = true;
        return;
      }
      return postMessage.call(this, message, ...args);
    };
    if (${JSON.stringify(mode)} === "close") {
      Worker.prototype.terminate = function() {
        intercepted = true;
        return new Promise(() => {});
      };
    }
    const { runProtectedRunCommand } = await import(${JSON.stringify(runCliUrl)});
    const environment = { ...process.env };
    delete environment.NODE_V8_COVERAGE;
    const code = await runProtectedRunCommand([
      "--transcript", ${JSON.stringify(transcriptPath)},
      "--time-limit", "250ms", "--termination-grace", "100ms",
      "--output", ${JSON.stringify(receiptPath)},
      "--", process.execPath, "-e",
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid));setInterval(()=>{},1000)",
      ${JSON.stringify(pidPath)},
    ], environment);
    writeFileSync(${JSON.stringify(interceptedPath)}, JSON.stringify({ intercepted }));
    Worker.prototype.postMessage = postMessage;
    Worker.prototype.terminate = terminate;
    Worker.prototype.emit = emit;
    process.exitCode = code;
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: coverageHarnessEnvironment(),
      timeout: 9_000,
      killSignal: "SIGKILL",
    });
    assert.equal(result.error, undefined, `${mode}: ${result.stderr}`);
    assert.equal(result.status, mode === "ready-signal" ? 130 : 125, `${mode}: ${result.stderr}`);
    assert.equal(JSON.parse(readFileSync(interceptedPath, "utf8")).intercepted, true);
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(receipt.state, mode === "ready-signal" ? "STOPPED" : "ERROR");
    assert.equal(receipt.stop?.code, mode === "ready-signal" ? "SUPERVISOR_SIGNAL" : "SUPERVISOR_ERROR");
    assert.equal(receipt.process.processGroupTerminationConfirmed, true);
    assert.equal(recomputeProtectedRunHash(receipt), receipt.receiptHash);
    if (mode.startsWith("ready")) {
      assert.equal(existsSync(pidPath), false);
      assert.equal(receipt.process.leaderPid, undefined);
      if (mode === "ready-signal") assert.equal(receipt.stop.signal, "SIGINT");
    } else {
      assert.equal(pidCanExecute(Number(readFileSync(pidPath, "utf8"))), false);
    }
  } finally {
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, "utf8"));
      if (pidCanExecute(pid)) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* Best-effort fixture cleanup. */ }
      }
    }
  }
}

test("a stalled telemetry baseline cannot prevent an error receipt before launch", { timeout: 12_000 }, () => {
  assertStalledTelemetryShutdown("ready");
});

test("a signal interrupts stalled telemetry initialization before launch", { timeout: 12_000 }, () => {
  assertStalledTelemetryShutdown("ready-signal");
});

test("a stalled in-flight telemetry poll cannot prevent the final receipt", { timeout: 12_000 }, () => {
  assertStalledTelemetryShutdown("in-flight");
});

test("a stalled final telemetry poll cannot prevent the final receipt", { timeout: 12_000 }, () => {
  assertStalledTelemetryShutdown("final");
});

test("a stalled telemetry worker close cannot prevent the final receipt or CLI exit", { timeout: 12_000 }, () => {
  assertStalledTelemetryShutdown("close");
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

test("malformed token counters cannot satisfy a requested token cap", async () => {
  const invalidCounters: Array<[string, Record<string, unknown>]> = [
    ["numeric string", { input_tokens: "12", output_tokens: 0 }],
    ["negative", { input_tokens: -1, output_tokens: 0 }],
    ["fractional", { input_tokens: 1.5, output_tokens: 0 }],
    ["unsafe integer", { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 }],
    ["aggregate overflow", { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }],
    ["invalid alias", { input_tokens: 1, cached_input_tokens: 1, cache_read_input_tokens: "1", output_tokens: 0 }],
    ["conflicting alias", { input_tokens: 1, cached_input_tokens: 0, cache_read_input_tokens: 1_000, output_tokens: 0, total_tokens: 1 }],
    ["conflicting write alias", { input_tokens: 1, cache_write_input_tokens: 0, cache_creation_input_tokens: 1_000, output_tokens: 0, total_tokens: 1 }],
    ["contradictory reported total", { input_tokens: 1_000, output_tokens: 1, total_tokens: 1 }],
    ["missing counters", {}],
  ];
  for (const [label, counters] of invalidCounters) {
    const directory = root();
    const transcript = join(directory, `${label.replace(" ", "-")}.jsonl`);
    const rows = [
      { type: "session_meta", payload: { id: "run" } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: counters } } },
    ];
    const output = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const result = await executeProtectedRun(input(["-e", `process.stdout.write(${JSON.stringify(output)})`], {
      trajectoryLimits: { maxObservedTokens: 100 },
      telemetryGraceMs: 5_000,
      transcript: { path: transcript, transport: "supervisor-captured-stdout" },
    }));
    assert.equal(result.exitCode, 124, JSON.stringify({ label, receipt: result.receipt }));
    assert.equal(result.receipt.state, "STOPPED", label);
    assert.equal(result.receipt.stop?.code, "TELEMETRY_UNREADABLE", label);
    assert.equal(result.receipt.telemetry?.parserStatus, "UNREADABLE", label);
    assert.equal(result.receipt.telemetry?.observedTokens, undefined, label);
    assert.ok(result.receipt.telemetry?.parseErrorSha256?.startsWith("sha256:"), label);
  }
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
  assert.equal(result.receipt.stop?.code, "TIME_LIMIT", JSON.stringify(result.receipt));
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
  assert.equal(result.receipt.stop?.code, "NO_PROGRESS", JSON.stringify(result.receipt));
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
  assert.equal(result.receipt.stop?.code, "NO_PROGRESS", JSON.stringify(result.receipt));
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
    assert.equal(result.exitCode, 124, JSON.stringify(result.receipt));
    assert.equal(result.receipt.stop?.code, scenario.code, JSON.stringify(result.receipt));
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
  ], protectedEnvironment());
  assert.equal(code, 0);
  assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
  const serialized = readFileSync(receiptPath, "utf8");
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(JSON.parse(serialized).state, "EXITED");
});

test("CLI preserves the terminal receipt and returns 125 when private output fails after execution", async () => {
  const directory = root();
  const parent = join(directory, "receipt-parent");
  const receiptPath = join(parent, "receipt.json");
  mkdirSync(parent);
  const script = "const fs=require('node:fs');fs.rmdirSync(process.argv[1]);fs.writeFileSync(process.argv[1],'blocked')";
  const cliArgs = [
    "--time-limit", "2s", "--format", "json", "--output", receiptPath,
    "--", process.execPath, "-e", script, parent,
  ];
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "--input-type=module", "-e", protectedCliHarness(cliArgs),
  ], { cwd: process.cwd(), encoding: "utf8", env: coverageHarnessEnvironment(), timeout: 5_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 125, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.state, "EXITED");
  assert.equal(receipt.process.exitCode, 0);
  assert.equal(existsSync(receiptPath), false);
  assert.match(result.stderr, /private receipt could not be written/);
  assert.doesNotMatch(result.stderr, /Usage:/);
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
  ], protectedEnvironment());
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
  ], protectedEnvironment());
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
  ], protectedEnvironment());
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
  ], protectedEnvironment());
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
  ], protectedEnvironment());
  assert.equal(code, 2);
  assert.equal(existsSync(marker), false);
});

test("CLI rejects malformed run option combinations before launching", async () => {
  const directory = root();
  const marker = join(directory, "launched.txt");
  const existingCapture = join(directory, "existing.jsonl");
  const sharedOutput = join(directory, "shared.jsonl");
  writeFileSync(existingCapture, "");
  const command = ["--", process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1],'launched')", marker];
  const scenarios = [
    ["--time-limit", "1s"],
    ["--time-limit", "1s", "--"],
    ["unexpected", ...command],
    ["--time-limit", "1s", "--time-limit", "2s", ...command],
    ["--time-limit", "--json", ...command],
    ["--json", "--json", "--time-limit", "1s", ...command],
    ["--unknown", "value", "--time-limit", "1s", ...command],
    [...command],
    ["--time-limit", "1", ...command],
    ["--time-limit", "1ms", ...command],
    ["--time-limit", "169h", ...command],
    ["--time-limit", "1s", "--max-tool-calls", "-1", ...command],
    ["--time-limit", "1s", "--transcript", "input.jsonl", "--capture-jsonl", "capture.jsonl", ...command],
    ["--time-limit", "1s", "--max-tool-calls", "1", ...command],
    ["--time-limit", "1s", "--capture-jsonl", existingCapture, ...command],
    ["--time-limit", "1s", "--capture-jsonl", "capture.txt", ...command],
    ["--time-limit", "1s", "--transcript", "transcript.txt", ...command],
    ["--time-limit", "1s", "--transcript", sharedOutput, "--output", sharedOutput, ...command],
    ["--time-limit", "1s", "--format", "yaml", ...command],
  ];
  const originalError = console.error;
  console.error = () => undefined;
  try {
    for (const args of scenarios) assert.equal(await runProtectedRunCommand(args, protectedEnvironment()), 2);
  } finally {
    console.error = originalError;
  }
  assert.equal(existsSync(marker), false);
});

test("CLI help is available without a command boundary", async () => {
  const originalLog = console.log;
  let output = "";
  console.log = (value?: unknown) => { output += String(value); };
  try {
    assert.equal(await runProtectedRunCommand(["--help"], protectedEnvironment()), 0);
  } finally {
    console.log = originalLog;
  }
  assert.match(output, /vigil run --time-limit/);
});
