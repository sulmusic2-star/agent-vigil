import assert from "node:assert/strict";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

const temporaryPaths: string[] = [];
let cachedHostedNodeRoot: string | undefined;

export const compositeActionRuntimeUnavailable = Boolean(process.env.NODE_V8_COVERAGE)
  || process.platform === "win32"
  || (process.platform === "linux" && process.env.RUNNER_ENVIRONMENT !== "github-hosted")
  || Number(process.versions.node.split(".")[0]) !== 22;

export const compositeActionIsolationUnavailable = compositeActionRuntimeUnavailable
  || process.platform !== "linux"
  || typeof process.getuid !== "function"
  || process.getuid() !== 1001
  || !existsSync("/usr/bin/docker");

after(() => {
  for (const selected of temporaryPaths.reverse()) rmSync(selected, { force: true, recursive: true });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function hostedNodeRootFixture(): string {
  if (cachedHostedNodeRoot) return cachedHostedNodeRoot;

  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "vigil-action-node-source-")));
  temporaryPaths.push(fixture);
  const hostedNodeRoot = join(fixture, "node");
  const source = join(hostedNodeRoot, process.versions.node, "x64", "bin", "node");
  mkdirSync(dirname(source), { recursive: true });
  // A hard link changes the live Node inode's ctime/link count and can race a
  // concurrent integrity checkpoint. One private clone per test process keeps
  // the real executable bytes and process.execPath behavior without repeatedly
  // consuming another full Node binary for every generated Action script.
  copyFileSync(process.execPath, source, constants.COPYFILE_FICLONE);
  // GitHub's setup-node cache currently exposes the selected regular Node
  // binary as 0777. Mirror that hosted contract so tests exercise the narrow
  // tool-cache exception rather than an unrealistically immutable fixture.
  chmodSync(source, 0o777);
  cachedHostedNodeRoot = hostedNodeRoot;
  return hostedNodeRoot;
}

/** Build the real composite script with a private, deterministic hosted-Node source. */
export function compositeActionScript(root = process.cwd()): string {
  const action = readFileSync(join(root, "action.yml"), "utf8");
  const block = action.match(/      run: \|\n([\s\S]*?)\n    - id: prepare_attestation/)?.[1];
  assert.ok(block, "composite Action run script is present");

  const hostedNodeRoot = hostedNodeRootFixture();

  return block
    .split("\n")
    .map((line) => line.startsWith("        ") ? line.slice(8) : line)
    .join("\n")
    .replace(
      "readonly VIGIL_HOSTED_NODE_ROOT='/opt/hostedtoolcache/node'",
      `readonly VIGIL_HOSTED_NODE_ROOT=${shellQuote(hostedNodeRoot)}`,
    );
}
