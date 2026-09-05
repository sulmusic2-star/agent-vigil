import { build } from "esbuild";

const commit = process.env.AGENT_VIGIL_BUILD_SHA?.trim() ?? "";
if (commit && !/^[0-9a-f]{40}$/.test(commit)) {
  throw new Error("AGENT_VIGIL_BUILD_SHA must be a full lowercase Git commit SHA");
}

await build({
  entryPoints: {
    cli: "src/cli.ts",
    "run-telemetry-worker": "src/run-telemetry-worker.ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outdir: "dist",
  entryNames: "[name]",
  define: { __AGENT_VIGIL_BUILD_SHA__: JSON.stringify(commit) },
});
