import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function runTests(root, requested = [], temporaryParent = tmpdir()) {
  const privateRoot = join(temporaryParent, "agent-vigil-test-runs");
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const runRoot = mkdtempSync(join(privateRoot, "tests-"));

  const files = ["test", "test-hosted"].flatMap((directory) =>
    readdirSync(join(root, directory))
      .filter((name) => name.endsWith(".test.ts"))
      .sort()
      .map((name) => join(directory, name)),
  );
  const coverage = requested[0] === "--coverage";
  const forwarded = coverage ? requested.slice(1) : requested;
  const args = ["--import", "tsx"];
  const coverageRoot = coverage ? join(runRoot, "coverage") : undefined;
  if (coverage) {
    mkdirSync(coverageRoot, { mode: 0o700 });
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
      env: {
        ...process.env, TMPDIR: runRoot, TMP: runRoot, TEMP: runRoot,
        ...(coverageRoot ? { NODE_V8_COVERAGE: coverageRoot } : {}),
      },
      stdio: "inherit",
    });
    if (result.error) console.error(result.error.message);
    if (result.signal) console.error(`test process ended by ${result.signal}`);
    return { exitCode: result.error || result.signal ? 2 : result.status ?? 2, runRoot, coverageRoot };
  } finally {
    if (result?.status === 0 && !result.error && !result.signal) {
      rmSync(runRoot, { recursive: true, force: true });
      try { rmSync(privateRoot); } catch { /* another test run still owns it */ }
    } else {
      // Keep the original V8 shards, including malformed ones. Retrying or
      // dropping a shard here could turn incomplete coverage into a false pass.
      console.error(`Test run failed; temporary evidence retained at ${runRoot}. No automatic retry.`);
      if (coverageRoot) console.error(`Raw coverage files: ${coverageRoot}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  process.exitCode = runTests(root, process.argv.slice(2)).exitCode;
}
