import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const privateRoot = join(tmpdir(), "agent-vigil-test-runs");
mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
const runRoot = mkdtempSync(join(privateRoot, "tests-"));

const files = ["test", "test-hosted"].flatMap((directory) =>
  readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".test.ts"))
    .sort()
    .map((name) => join(directory, name)),
);
const requested = process.argv.slice(2);
const coverage = requested[0] === "--coverage";
const forwarded = coverage ? requested.slice(1) : requested;
const args = ["--import", "tsx"];
if (coverage) {
  args.push(
    "--experimental-test-coverage",
    "--test-coverage-include=src/**/*.ts",
    "--test-coverage-lines=90",
    "--test-coverage-branches=80",
    "--test-coverage-functions=90",
  );
}
args.push("--test", ...forwarded, ...files);

let result;
try {
  result = spawnSync(process.execPath, args, {
    cwd: root,
    env: { ...process.env, TMPDIR: runRoot, TMP: runRoot, TEMP: runRoot },
    stdio: "inherit",
  });
} finally {
  rmSync(runRoot, { recursive: true, force: true });
  try { rmSync(privateRoot); } catch { /* another test run still owns it */ }
}

if (result.error) {
  console.error(result.error.message);
  process.exit(2);
}
if (result.signal) {
  console.error(`test process ended by ${result.signal}`);
  process.exit(2);
}
process.exit(result.status ?? 2);
