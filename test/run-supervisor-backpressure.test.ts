import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A pipe consumer slower than the producer must apply backpressure; a healthy,
// finite command must not be killed merely because terminal output is slower.
test("a slow stdout consumer receives finite output without a supervisor error", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-relay-backpressure-"));
  const transcript = join(directory, "capture.jsonl");
  const resultPath = join(directory, "result.json");
  const row = `${JSON.stringify({ type: "session_meta", payload: { id: "run", padding: "x".repeat(64 * 1024) } })}\n`;
  const count = 32;
  const expectedBytes = Buffer.byteLength(row) * count;
  const expectedHash = createHash("sha256").update(row.repeat(count)).digest("hex");
  const producer = `const row=${JSON.stringify(row)}; let sent=0; function send() { while(sent<${count}) { sent++; if(!process.stdout.write(row)) { process.stdout.once("drain", send); return; } } } send();`;
  const supervisor = new URL("../src/run-supervisor.ts", import.meta.url).href;
  const harness = `(async () => {
    const { writeFileSync } = await import("node:fs");
    const { executeProtectedRun } = await import(${JSON.stringify(supervisor)});
    const environment = { ...process.env }; delete environment.NODE_V8_COVERAGE;
    const result = await executeProtectedRun({
      executable: process.execPath, args: ["-e", ${JSON.stringify(producer)}],
      cwd: process.cwd(), environment, timeLimitMs: 20_000,
      terminationGraceMs: 50, trajectoryLimits: {}, telemetryGraceMs: 5_000,
      transcript: { path: ${JSON.stringify(transcript)}, transport: "supervisor-captured-stdout" },
    });
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result));
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const outer = spawn(process.execPath, ["--import", "tsx", "-e", harness], {
    cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let receivedBytes = 0;
  const receivedHash = createHash("sha256");
  outer.stderr.setEncoding("utf8");
  outer.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    outer.once("error", reject);
    outer.once("close", (code, signal) => resolve({ code, signal }));
  });
  // Await stream exhaustion separately from process close: the child can exit
  // while bytes remain buffered in the parent's readable stream.
  const consumed = (async () => {
    for await (const chunk of outer.stdout) {
      const bytes = chunk as Buffer;
      receivedBytes += bytes.length;
      receivedHash.update(bytes);
      await new Promise(resolve => setTimeout(resolve, Math.ceil(bytes.length / 8192) * 2));
    }
  })();
  const deadline = setTimeout(() => outer.kill("SIGKILL"), 25_000);
  try {
    const [exit] = await Promise.all([closed, consumed]);
    assert.equal(exit.signal, null, stderr);
    assert.equal(exit.code, 0, stderr);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    assert.equal(result.exitCode, 0, JSON.stringify(result.receipt));
    assert.equal(result.receipt.state, "EXITED");
    assert.equal(result.receipt.process.processGroupTerminationConfirmed, true);
    const captured = readFileSync(transcript);
    assert.equal(captured.length, expectedBytes);
    assert.equal(receivedBytes, expectedBytes);
    assert.equal(createHash("sha256").update(captured).digest("hex"), expectedHash);
    assert.equal(receivedHash.digest("hex"), expectedHash);
  } finally {
    clearTimeout(deadline);
    if (outer.exitCode === null && outer.signalCode === null) outer.kill("SIGKILL");
    rmSync(directory, { recursive: true, force: true });
  }
});
