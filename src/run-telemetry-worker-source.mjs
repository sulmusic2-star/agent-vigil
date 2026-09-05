// Node 20 cannot apply tsx directly to a TypeScript Worker entry point.
import { register } from "tsx/esm/api";

register();
await import("./run-telemetry-worker.ts");
