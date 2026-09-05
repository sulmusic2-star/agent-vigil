import { parentPort, workerData } from "node:worker_threads";
import {
  RunTelemetryCore,
  type RunTelemetryWorkerInput,
  type RunTelemetryWorkerRequest,
  type RunTelemetryWorkerResponse,
} from "./run-telemetry.ts";

if (!parentPort) throw new Error("telemetry worker requires a parent message port");

const port = parentPort;
let monitor: RunTelemetryCore;

try {
  monitor = new RunTelemetryCore(workerData as RunTelemetryWorkerInput);
  port.postMessage({ kind: "ready" } satisfies RunTelemetryWorkerResponse);
} catch (error) {
  port.postMessage({
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
  } satisfies RunTelemetryWorkerResponse);
  process.exitCode = 1;
  throw error;
}

port.on("message", (message: RunTelemetryWorkerRequest) => {
  try {
    if (message.kind === "append") {
      monitor.appendCaptured(Buffer.from(message.bytes));
      return;
    }
    if (message.kind === "start") {
      monitor.start(message.startedAtMs);
      return;
    }
    const result = monitor.poll(message.nowMs, message.enforce, message.terminal);
    port.postMessage({ kind: "result", id: message.id, result } satisfies RunTelemetryWorkerResponse);
  } catch (error) {
    port.postMessage({
      kind: "error",
      ...(message.kind === "poll" ? { id: message.id } : {}),
      message: error instanceof Error ? error.message : String(error),
    } satisfies RunTelemetryWorkerResponse);
  }
});
