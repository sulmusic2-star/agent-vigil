import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

const temporaryPaths: string[] = [];
type HostedNodeFixture = {
  digestVariable: string;
  root: string;
  rootVariable: string;
};
let cachedHostedNodeFixture: HostedNodeFixture | undefined;

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

function hostedNodeFixture(): HostedNodeFixture {
  if (cachedHostedNodeFixture) return cachedHostedNodeFixture;

  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "vigil-action-node-source-")));
  temporaryPaths.push(fixture);
  const hostedNodeRoot = join(fixture, "node");
  const architecture = process.platform === "darwin" ? process.arch : "x64";
  assert.ok(architecture === "x64" || architecture === "arm64", `unsupported hosted Node fixture architecture: ${architecture}`);
  const source = join(hostedNodeRoot, process.versions.node, architecture, "bin", "node");
  mkdirSync(dirname(source), { recursive: true });
  // A hard link changes the live Node inode's ctime/link count and can race a
  // concurrent integrity checkpoint. One private clone per test process keeps
  // the real executable bytes and process.execPath behavior without repeatedly
  // consuming another full Node binary for every generated Action script.
  copyFileSync(process.execPath, source, constants.COPYFILE_FICLONE);
  // setup-node's GitHub-hosted toolcache exposes the selected Node binary as
  // 0777. Exercise the digest-bound exception instead of the generic immutable
  // host-file path.
  chmodSync(source, 0o777);
  cachedHostedNodeFixture = process.platform === "darwin"
    ? {
        digestVariable: architecture === "arm64"
          ? "VIGIL_PINNED_MACOS_ARM64_NODE_SHA256"
          : "VIGIL_PINNED_MACOS_X64_NODE_SHA256",
        root: hostedNodeRoot,
        rootVariable: "VIGIL_MACOS_HOSTED_NODE_ROOT",
      }
    : {
        digestVariable: "VIGIL_PINNED_LINUX_X64_NODE_SHA256",
        root: hostedNodeRoot,
        rootVariable: "VIGIL_HOSTED_NODE_ROOT",
      };
  return cachedHostedNodeFixture;
}

/** Build the real composite script with a private, deterministic hosted-Node source. */
export function compositeActionScript(root = process.cwd()): string {
  const action = readFileSync(join(root, "action.yml"), "utf8");
  const block = action.match(/      run: \|\n([\s\S]*?)\n    - id: prepare_attestation/)?.[1];
  assert.ok(block, "composite Action run script is present");

  const fixture = hostedNodeFixture();
  const fixtureNodeSha256 = createHash("sha256").update(readFileSync(process.execPath)).digest("hex");

  return block
    .split("\n")
    .map((line) => line.startsWith("        ") ? line.slice(8) : line)
    .join("\n")
    .replace(
      new RegExp(`readonly ${fixture.rootVariable}='[^']+'`),
      `readonly ${fixture.rootVariable}=${shellQuote(fixture.root)}`,
    )
    .replace(
      "readonly VIGIL_PINNED_NODE_VERSION='22.23.2'",
      `readonly VIGIL_PINNED_NODE_VERSION=${shellQuote(process.versions.node)}`,
    )
    .replace(
      new RegExp(`readonly ${fixture.digestVariable}='[0-9a-f]{64}'`),
      `readonly ${fixture.digestVariable}=${shellQuote(fixtureNodeSha256)}`,
    );
}
