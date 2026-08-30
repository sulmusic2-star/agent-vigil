import { chmodSync, closeSync, constants, type Dirent, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_POLICY_FILE, loadPolicy, maintainerPolicyTemplate, policyTemplate } from "./config.ts";
import { inferTestCommand, isHostedDirectTestCommand, isHostedHermeticTestCommand, isHostedTestHarnessPath } from "./detectors/reality.ts";
import { loadTranscript } from "./transcript.ts";
import { trustedGit } from "./trusted-git.ts";
const CHECKOUT_ACTION_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_ACTION_SHA = "820762786026740c76f36085b0efc47a31fe5020";
const HOSTED_NODE_VERSION = "22.23.2";
const DOWNLOAD_ARTIFACT_ACTION_SHA = "634f93cb2916e3fdff6788551b99b062d0335ce0";
const UPLOAD_ARTIFACT_ACTION_SHA = "ea165f8d65b6e75b540449e92b4886f43607fa02";
import { authorityContractTemplate, loadAuthorityContract } from "./authority.ts";

type InitResult = { created: string[]; kept: string[] };
type DoctorCheck = { status: "PASS" | "WARN" | "FAIL"; label: string; detail: string };
export type SetupProfile = "default" | "maintainer" | "authority" | "protect";
export type HostedRunnerOverride = { image: string; testCommand: string };
const HOSTED_RUNNER_FILE = ".agent-vigil-runner.json";
const IMMUTABLE_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/;

function evidenceWorkflow(mode: "transcript" | "portable" | "maintainer" | "authority", actionSha: string, setupCommand?: string, candidateImage?: string): string { return `name: Agent Vigil

on:
  # The base branch selects these workflow bytes. Candidate code is checked out
  # only after the job has entered the credential-free isolation contract.
  pull_request_target:
    types: [opened, synchronize, reopened, edited]

permissions:
  contents: read
  pull-requests: read

jobs:
  evidence:
    name: Agent Vigil evidence
    if: github.event.pull_request.state == 'open'
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/setup-node@${SETUP_NODE_ACTION_SHA} # v7
        with:
          node-version: ${HOSTED_NODE_VERSION}
          package-manager-cache: false
      - uses: actions/checkout@${CHECKOUT_ACTION_SHA} # v7.0.1
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false
          allow-unsafe-pr-checkout: true
      - id: vigil
        uses: sulmusic2-star/agent-vigil@${actionSha} # reviewed Agent Vigil runtime
        with:
          ${mode === "portable" ? "receipt: .agent-vigil/receipt.json" : mode === "maintainer" ? "mode: maintainer" : mode === "authority" ? "transcript: .agent-vigil/session.jsonl\n          authority-contract: .agent-vigil-authority.json\n          authority-contract-ref: ${{ github.event.pull_request.base.sha }}" : "transcript: .agent-vigil/session.md"}
          policy: .agent-vigil.json
          policy-ref: \${{ github.event.pull_request.base.sha }}
          repo: .
          base: \${{ github.event.pull_request.base.sha }}
          head: \${{ github.event.pull_request.head.sha }}
          isolate-candidate: true
${setupCommand ? `          candidate-setup-cmd: ${setupCommand}\n` : ""}${candidateImage ? `          candidate-image: ${candidateImage}\n` : ""}      - name: Retain auditable Agent Vigil receipt
        if: always() && steps.vigil.outputs.report != ''
        uses: actions/upload-artifact@${UPLOAD_ARTIFACT_ACTION_SHA} # v4
        with:
          name: agent-vigil-receipt
          path: |
            \${{ steps.vigil.outputs.report }}
            \${{ steps.vigil.outputs.sarif }}
            \${{ steps.vigil.outputs.value-card }}
            \${{ steps.vigil.outputs.github-evidence }}
          if-no-files-found: error
          retention-days: 30
`; }

function outcomeWorkflow(actionSha: string): string { return `name: Agent Vigil outcomes

on:
  workflow_run:
    workflows: [Agent Vigil]
    types: [completed]

permissions:
  actions: read
  contents: read
  pull-requests: read

jobs:
  outcome:
    if: github.event.workflow_run.event == 'pull_request_target'
    runs-on: ubuntu-24.04
    steps:
      - name: Select the exact trusted host Node.js runtime
        uses: actions/setup-node@${SETUP_NODE_ACTION_SHA} # v7
        with:
          node-version: ${HOSTED_NODE_VERSION}
          package-manager-cache: false
      - id: source
        name: Locate the completed evidence run
        env:
          EVENT_RUN_ID: \${{ github.event.workflow_run.id }}
        run: |
          run_id="$EVENT_RUN_ID"
          if [[ ! "$run_id" =~ ^[0-9]+$ ]]; then
            echo "The completed Agent Vigil evidence run ID is invalid." >&2
            exit 2
          fi
          echo "run_id=$run_id" >> "$GITHUB_OUTPUT"
      - name: Download the immutable receipt artifact
        uses: actions/download-artifact@${DOWNLOAD_ARTIFACT_ACTION_SHA} # v5
        with:
          name: agent-vigil-receipt
          path: .agent-vigil-prior
          github-token: \${{ github.token }}
          run-id: \${{ steps.source.outputs.run_id }}
      - id: outcome
        uses: sulmusic2-star/agent-vigil@${actionSha} # reviewed Agent Vigil runtime
        with:
          mode: outcome
          outcome-receipt: .agent-vigil-prior/agent-vigil-report.json
          actions-run-id: \${{ steps.source.outputs.run_id }}
          github-token: \${{ github.token }}
      - name: Retain the post-run Value Card
        if: always() && steps.outcome.outputs.value-card != ''
        uses: actions/upload-artifact@${UPLOAD_ARTIFACT_ACTION_SHA} # v4
        with:
          name: agent-vigil-outcome-\${{ steps.source.outputs.run_id }}
          path: |
            \${{ steps.outcome.outputs.value-card }}
            \${{ steps.outcome.outputs.github-evidence }}
          retention-days: 30
`; }

const MAINTAINER_PR_TEMPLATE = `## Agent Vigil pull request evidence

- AI assistance: assisted
- Linked issue: #REPLACE
- Known limitations: none known

Agent Vigil uses the policy from the base commit. It checks the exact Git range,
scope, fresh tests, integrity rules, and whether the changed regression test
fails against base source and passes against the candidate. The generated
hosted workflow runs those commands in one-shot candidate-only containers over
a private exact-commit clone. Local CLI runs retain the local operator's
execution boundary. This does not claim that a person reviewed or understands
the change.
`;

const SESSION_TEMPLATE = `# Agent change receipt

Replace this file with the coding agent's final summary or point
\`.agent-vigil.json\` at a supported exported transcript.

Agent Vigil will independently compare checkable claims with the selected Git
range and fresh verification. This placeholder intentionally contains no claims,
so strict verification remains INCONCLUSIVE until real evidence is supplied.
`;

const AUTHORITY_SESSION_TEMPLATE = `{"type":"session_meta","payload":{"id":"replace-with-exported-structured-session"}}
`;

const LOCAL_README = `# Agent Vigil evidence input

The workflow reads \`session.md\` by default. Replace it with the agent's actual
final summary, or change \`transcript\` in \`../.agent-vigil.json\` to an exported
Codex, Claude Code, Cursor, Gemini CLI, GitHub Copilot CLI, OpenCode, or Aider
transcript.

Transcripts can contain source code, prompts, paths, and secrets. Review them
before committing or uploading. Agent Vigil reads evidence locally and does not
upload it.
`;

function writeScaffold(root: string, path: string, content: string, force: boolean, result: InitResult): void {
  const normalized = repositoryInputPath(root, path);
  if (!normalized || normalized !== path.split(sep).join("/")) throw new Error(`refusing unsafe scaffold path ${path}`);
  const components = normalized.split("/");
  const parents: Array<{ path: string; dev: bigint; ino: bigint }> = [];
  let parent = root;
  const rootStat = lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("repository root must be a canonical non-symlink directory");
  parents.push({ path: root, dev: rootStat.dev, ino: rootStat.ino });
  for (const component of components.slice(0, -1)) {
    const next = join(parent, component);
    try {
      const stat = lstatSync(next, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`scaffold parent ${relative(root, next)} must be a non-symlink directory`);
      parents.push({ path: next, dev: stat.dev, ino: stat.ino });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(next, { mode: 0o755 });
      const stat = lstatSync(next, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`scaffold parent ${relative(root, next)} must be a non-symlink directory`);
      parents.push({ path: next, dev: stat.dev, ino: stat.ino });
    }
    parent = next;
  }

  const target = join(parent, components.at(-1)!);
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(target, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1n)) {
    throw new Error(`scaffold target ${path} must be a regular non-symlink single-link file`);
  }
  if (existing && !force) { result.kept.push(path); return; }

  let descriptor: number | undefined;
  try {
    const createFlags = existing ? 0 : constants.O_CREAT | constants.O_EXCL;
    descriptor = openSync(
      target,
      constants.O_WRONLY | createFlags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      0o644,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const linked = lstatSync(target, { bigint: true });
    if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink() || opened.nlink !== 1n || linked.nlink !== 1n
      || opened.dev !== linked.dev || opened.ino !== linked.ino) {
      throw new Error(`scaffold target ${path} changed or is not a regular non-symlink file`);
    }
    for (const expected of parents) {
      const current = lstatSync(expected.path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
        throw new Error(`scaffold parent ${relative(root, expected.path) || "."} changed or is unsafe`);
      }
    }
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, content);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  result.created.push(path);
}

function inferProtectCommands(_root: string, testCommand?: string): string[] {
  // Hosted automated review may execute only the same finite direct-runner
  // grammar as fresh verification. Arbitrary npm dispatchers remain local-only.
  return testCommand && isHostedDirectTestCommand(testCommand) ? [testCommand] : [];
}

const UNSUPPORTED_ROOT_LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"] as const;
const NPM_ROOT_LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json"] as const;
const TEST_TOOLCHAIN_PATHS = [
  "pytest.ini", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "gradlew.bat", "gradlew",
  "build.gradle", "build.gradle.kts", "Gemfile", "composer.json", "global.json", "Directory.Build.props",
  ".npmrc", "tsconfig.json",
] as const;
const HOSTED_SETUP_FIXED_PATHS = [
  HOSTED_RUNNER_FILE, "package.json", ...NPM_ROOT_LOCKFILES, ...UNSUPPORTED_ROOT_LOCKFILES, ...TEST_TOOLCHAIN_PATHS,
] as const;

type RepositoryEntry = { mode: string; oid?: string };
type RepositoryView = {
  commit?: string;
  entries: Map<string, RepositoryEntry>;
  readText(path: string): string;
};
type HostedRepositoryContract = {
  setupCommand?: string;
  testCommand?: string;
  hasRootPackage: boolean;
  candidateImage?: string;
  customRunner?: boolean;
};

function validateRunnerOverride(value: HostedRunnerOverride): HostedRunnerOverride {
  if (!IMMUTABLE_IMAGE.test(value.image)) {
    throw new Error("the hermetic hosted runner image must be a lowercase registry/repository reference pinned with @sha256:<64 hex>");
  }
  if (!isHostedHermeticTestCommand(value.testCommand)) {
    throw new Error("the hermetic hosted runner requires one bounded direct test command from the documented Python, Rust, Go, Java, Ruby, PHP, .NET, Node, pnpm, Yarn, or Bun grammar");
  }
  return value;
}

function runnerOverrideFromView(view: RepositoryView): HostedRunnerOverride | undefined {
  if (!view.entries.has(HOSTED_RUNNER_FILE)) return undefined;
  let value: unknown;
  try { value = JSON.parse(view.readText(HOSTED_RUNNER_FILE)); }
  catch { throw new Error(`${HOSTED_RUNNER_FILE} must contain valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${HOSTED_RUNNER_FILE} must contain one JSON object`);
  const row = value as Record<string, unknown>;
  if (row.schemaVersion !== 1 || typeof row.image !== "string" || typeof row.testCommand !== "string"
    || Object.keys(row).some((key) => !new Set(["schemaVersion", "image", "testCommand"]).has(key))) {
    throw new Error(`${HOSTED_RUNNER_FILE} must contain only schemaVersion 1, image, and testCommand`);
  }
  return validateRunnerOverride({ image: row.image, testCommand: row.testCommand });
}

function isRegularGitBlobMode(mode: string): boolean {
  return mode === "100644" || mode === "100755";
}

function requiredGit(root: string, args: string[], failure: string): string {
  try {
    return trustedGit(root, args, 16 * 1024 * 1024);
  } catch {
    throw new Error(failure);
  }
}

function requiredGitBuffer(root: string, args: string[], failure: string): Buffer {
  try {
    return Buffer.from(trustedGit(root, args, 16 * 1024 * 1024), "utf8");
  } catch {
    throw new Error(failure);
  }
}

function workingRepositoryView(root: string): RepositoryView {
  const entries = new Map<string, RepositoryEntry>();
  const indexed = requiredGit(
    root,
    ["ls-files", "--stage", "-z"],
    "the generated hosted workflow could not verify the repository's Git entry types",
  );
  for (const record of indexed.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const metadata = tab < 0 ? [] : record.slice(0, tab).split(" ");
    if (tab < 0 || metadata.length !== 3 || metadata[2] !== "0") {
      throw new Error("the generated hosted workflow received malformed or conflicted Git index metadata");
    }
    const path = record.slice(tab + 1);
    if (metadata[0] === "160000") {
      entries.set(path, { mode: metadata[0], oid: metadata[1] });
      continue;
    }
    try {
      const stat = lstatSync(resolve(root, path));
      const mode = stat.isSymbolicLink()
        ? "120000"
        : stat.isFile()
        ? metadata[0]
        : "040000";
      entries.set(path, { mode, oid: metadata[1] });
    } catch {
      // A tracked deletion is absent from the prospective worktree contract.
    }
  }
  const untracked = requiredGit(
    root,
    ["ls-files", "-z", "--others", "--exclude-standard"],
    "the generated hosted workflow could not verify Git-visible untracked paths",
  );
  for (const path of untracked.split("\0").filter(isSetupRelevantPath)) {
    try {
      const stat = lstatSync(resolve(root, path));
      entries.set(path, { mode: stat.isSymbolicLink() ? "120000" : stat.isFile() ? "100644" : "040000" });
    } catch {
      throw new Error(`the generated hosted workflow could not read Git-visible path ${path}`);
    }
  }
  return {
    entries,
    readText(path: string): string {
      const entry = entries.get(path);
      if (!entry || !isRegularGitBlobMode(entry.mode)) {
        throw new Error(`the generated hosted workflow requires ${path} to be a regular Git file`);
      }
      try {
        return readRegularSnapshot(resolve(root, path)).toString("utf8");
      } catch {
        throw new Error(`the generated hosted workflow could not read ${path}`);
      }
    },
  };
}

function headRepositoryView(root: string): RepositoryView {
  const head = requiredGit(
    root,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    "the generated hosted workflow requires a committed HEAD before its exact-tree contract can be verified",
  ).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) {
    throw new Error("the generated hosted workflow received an invalid committed HEAD identity");
  }
  const entries = new Map<string, RepositoryEntry>();
  const tree = requiredGit(
    root,
    ["ls-tree", "-r", "-z", "--full-tree", head],
    "the generated hosted workflow could not read the committed HEAD tree",
  );
  for (const record of tree.split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const metadata = tab < 0 ? [] : record.slice(0, tab).split(" ");
    if (tab < 0 || metadata.length !== 3 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(metadata[2])) {
      throw new Error("the generated hosted workflow received malformed committed-tree metadata");
    }
    entries.set(record.slice(tab + 1), { mode: metadata[0], oid: metadata[2] });
  }
  return {
    commit: head,
    entries,
    readText(path: string): string {
      const entry = entries.get(path);
      if (!entry?.oid || !isRegularGitBlobMode(entry.mode)) {
        throw new Error(`the generated hosted workflow requires committed ${path} to be a regular Git file`);
      }
      return requiredGit(
        root,
        ["cat-file", "blob", entry.oid],
        `the generated hosted workflow could not read committed ${path}`,
      );
    },
  };
}

function repositoryInputPath(root: string, input: string): string | undefined {
  const path = relative(root, resolve(root, input));
  if (!path || path === ".." || path.startsWith(`..${sep}`)) return undefined;
  return path.split(sep).join("/");
}

type CommittedInputSnapshot = { path?: string; bytes?: Buffer; text?: string; error?: string };

function readRegularSnapshot(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("is not a regular file");
    if (before.size > BigInt(16 * 1024 * 1024)) throw new Error("exceeds 16 MiB");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("changed while being read");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new Error("changed while being read");
    }
    const pathAfter = lstatSync(path, { bigint: true });
    if (!pathAfter.isFile() || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      throw new Error("path is not the regular file that was read");
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function committedInputSnapshot(root: string, headView: RepositoryView | undefined, headError: string | undefined, input: string): CommittedInputSnapshot {
  const path = repositoryInputPath(root, input);
  if (!path) return { error: `${input} is outside the repository and cannot be bound to committed HEAD` };
  if (!headView) return { path, error: `${path} cannot be bound to committed HEAD: ${headError ?? "the committed tree is unavailable"}` };
  const headEntry = headView.entries.get(path);
  if (!headEntry?.oid || !isRegularGitBlobMode(headEntry.mode)) return { path, error: `${path} is absent from committed HEAD as a regular file` };

  let indexed: string;
  try {
    indexed = requiredGit(
      root,
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", path],
      `the Git index entry for ${path} could not be verified`,
    );
  } catch (error) {
    return { path, error: (error as Error).message };
  }
  const records = indexed.split("\0").filter(Boolean);
  if (records.length !== 1) return { path, error: `${path} is not present as one conflict-free Git index entry` };
  const tab = records[0].indexOf("\t");
  const metadata = tab < 0 ? [] : records[0].slice(0, tab).split(" ");
  if (tab < 0 || metadata.length !== 3 || metadata[2] !== "0") return { path, error: `${path} has malformed or conflicted Git index metadata` };
  if (metadata[0] !== headEntry.mode || metadata[1] !== headEntry.oid) return { path, error: `${path} in the Git index is not identical to committed HEAD` };

  const absolute = resolve(root, path);
  let live: Buffer;
  try {
    live = readRegularSnapshot(absolute);
  } catch (error) {
    return { path, error: `${path} is missing or unsafe in the worktree: ${(error as Error).message}` };
  }
  let committed: Buffer;
  try {
    committed = requiredGitBuffer(root, ["cat-file", "blob", headEntry.oid], `committed ${path} could not be read`);
  } catch (error) {
    return { path, error: (error as Error).message };
  }
  return live.equals(committed)
    ? { path, bytes: live, text: live.toString("utf8") }
    : { path, error: `${path} in the worktree is not identical to committed HEAD` };
}

function loadTranscriptSnapshot(sourcePath: string, bytes: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), "agent-vigil-doctor-"));
  chmodSync(directory, 0o700);
  const suffix = new Set([".json", ".jsonl", ".ndjson", ".md"]).has(extname(sourcePath).toLowerCase())
    ? extname(sourcePath).toLowerCase()
    : ".txt";
  const snapshotName = sourcePath.toLowerCase().endsWith(".aider.chat.history.md")
    ? ".aider.chat.history.md"
    : `transcript${suffix}`;
  const snapshotPath = join(directory, snapshotName);
  try {
    writeFileSync(snapshotPath, bytes, { flag: "wx", mode: 0o600 });
    return loadTranscript(snapshotPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function isSetupRelevantPath(path: string): boolean {
  return (HOSTED_SETUP_FIXED_PATHS as readonly string[]).includes(path)
    || (path !== "package.json" && path.endsWith("/package.json"))
    || path === "spec"
    || path.startsWith("spec/")
    || isHostedTestHarnessPath(path);
}

function listedPaths(root: string, args: string[], failure: string): string[] {
  return requiredGit(root, args, failure).split("\0").filter(Boolean);
}

const IGNORED_SCAN_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".cache", ".pnpm", ".yarn", "build", "coverage", "dist", "node_modules", "out", "vendor",
]);

function ignoredNestedNpmConfigs(root: string, ignored: string[]): string[] {
  const found: string[] = [];
  const pending = ignored
    .filter((path) => path.endsWith("/") && !path.split("/").some((part) => IGNORED_SCAN_EXCLUDED_DIRECTORIES.has(part)))
    .map((path) => resolve(root, path));
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    if (++visited > 20_000) throw new Error("the generated hosted workflow could not safely bound ignored repository configuration discovery");
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
    } catch {
      throw new Error("the generated hosted workflow could not inspect an ignored repository directory safely");
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.name === ".npmrc") found.push(path);
      else if (entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_SCAN_EXCLUDED_DIRECTORIES.has(entry.name)) pending.push(absolute);
    }
  }
  return found;
}

function ignoredSetupInputs(root: string): string[] {
  const ignored = listedPaths(
    root,
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    "the generated hosted workflow could not verify ignored setup inputs",
  );
  return [...new Set([...ignored.filter(isSetupRelevantPath), ...ignoredNestedNpmConfigs(root, ignored)])].sort();
}

function uncommittedSetupInputs(root: string): string[] {
  const paths = new Set<string>();
  const queries: string[][] = [
    ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD"],
    ["diff", "--cached", "--no-ext-diff", "--no-renames", "--name-only", "-z", "HEAD"],
    ["ls-files", "-z", "--others", "--exclude-standard"],
  ];
  for (const args of queries) {
    for (const path of listedPaths(root, args, "the generated hosted workflow could not compare setup inputs with committed HEAD")) {
      if (isSetupRelevantPath(path)) paths.add(path);
    }
  }
  for (const path of ignoredSetupInputs(root)) paths.add(path);
  return [...paths].sort();
}

function directNpmTestCommand(packageManifest: Record<string, unknown>): string | undefined {
  const settings = packageManifest.agentVigil;
  if (settings !== undefined && (!settings || typeof settings !== "object" || Array.isArray(settings))) {
    throw new Error("the generated hosted workflow requires package.json agentVigil to be an object when present");
  }
  const hostedOverride = (settings as Record<string, unknown> | undefined)?.hostedTestCommand;
  if (hostedOverride !== undefined) {
    if (typeof hostedOverride !== "string" || !isHostedDirectTestCommand(hostedOverride)) {
      throw new Error("the generated hosted workflow requires package.json agentVigil.hostedTestCommand to be one bounded direct `node --test` command");
    }
    return hostedOverride;
  }
  const script = (packageManifest?.scripts as Record<string, unknown> | undefined)?.test;
  if (script === undefined || script === "" || (typeof script === "string" && /no test specified/i.test(script))) return undefined;
  if (typeof script !== "string" || !script.trim() || Buffer.byteLength(script) > 1024) {
    throw new Error("the generated hosted workflow requires package.json scripts.test to be one bounded direct test-runner command");
  }
  const command = script.trim();
  const tokens = command.split(/\s+/);
  const runner = tokens[0];
  if (runner === "node") {
    if (!isHostedDirectTestCommand(command)) throw new Error("the generated hosted workflow supports only direct `node --test` with bounded spec/tap reporter, concurrency, timeout, and repository-relative test-path arguments; preload and loader flags are not allowed");
    return command;
  }
  throw new Error("the generated hosted workflow supports only direct `node --test` commands in package.json scripts.test");
}

function inferredTestCommand(view: RepositoryView, packageManifest?: Record<string, unknown>): string | undefined {
  if (packageManifest) {
    const direct = directNpmTestCommand(packageManifest);
    if (direct) return direct;
  }
  if (view.entries.has("pytest.ini") || view.entries.has("pyproject.toml")) return "python3 -m pytest -q";
  if (view.entries.has("Cargo.toml")) return "cargo test --quiet";
  if (view.entries.has("go.mod")) return "go test -json ./...";
  if (view.entries.has("pom.xml")) return "mvn test";
  if (process.platform === "win32" && view.entries.has("gradlew.bat")) return "gradlew.bat test";
  if (view.entries.has("gradlew")) return "./gradlew test";
  if (view.entries.has("build.gradle") || view.entries.has("build.gradle.kts")) return "gradle test";
  const hasSpec = [...view.entries.keys()].some((path) => path === "spec" || path.startsWith("spec/"));
  if (view.entries.has("Gemfile") && hasSpec) return "bundle exec rspec";
  if (view.entries.has("composer.json")) return "./vendor/bin/phpunit";
  if (view.entries.has("global.json") || view.entries.has("Directory.Build.props")) return "dotnet test";
  return undefined;
}

function validateHostedRepositoryContract(view: RepositoryView, requestedRunner?: HostedRunnerOverride): HostedRepositoryContract {
  const gitlink = [...view.entries].find(([, entry]) => entry.mode === "160000")?.[0];
  if (gitlink) {
    throw new Error(`the generated hosted workflow does not support Git submodules or gitlinks (${gitlink}); use a repository without submodules or the local CLI`);
  }
  const unsafeSetupLink = [...view.entries].find(([path, entry]) => isSetupRelevantPath(path) && entry.mode === "120000")?.[0];
  if (unsafeSetupLink) {
    throw new Error(`the generated hosted workflow requires setup input ${unsafeSetupLink} to be a regular Git file, not a symbolic link`);
  }
  const unsafeSetupMode = [...view.entries].find(([path, entry]) => isSetupRelevantPath(path) && !isRegularGitBlobMode(entry.mode))?.[0];
  if (unsafeSetupMode) {
    throw new Error(`the generated hosted workflow requires setup input ${unsafeSetupMode} to be a regular 100644 or 100755 Git blob`);
  }
  const runner = requestedRunner ? validateRunnerOverride(requestedRunner) : runnerOverrideFromView(view);
  if (runner) {
    return {
      testCommand: runner.testCommand,
      hasRootPackage: view.entries.has("package.json"),
      candidateImage: runner.image,
      customRunner: true,
    };
  }
  const npmConfig = [...view.entries.keys()].find((path) => path.split("/").at(-1) === ".npmrc");
  if (npmConfig) {
    throw new Error(`the generated hosted workflow does not support repository .npmrc (${npmConfig}) because registry, certificate, and install indirection are outside the hosted trust closure`);
  }
  const unsupportedLock = UNSUPPORTED_ROOT_LOCKFILES.find((path) => view.entries.has(path));
  if (unsupportedLock) {
    throw new Error(`the generated hosted workflow does not support root ${unsupportedLock}; use the local CLI or an explicit digest-pinned hermetic runner`);
  }

  const hasRootPackage = view.entries.has("package.json");
  const setupCommand = NPM_ROOT_LOCKFILES.some((path) => view.entries.has(path)) ? "npm ci --ignore-scripts" : undefined;
  let manifest: Record<string, unknown> | undefined;
  if (!hasRootPackage) {
    if (setupCommand) {
      throw new Error("the generated hosted workflow requires a root package.json beside an npm lockfile");
    }
    const nestedPackage = [...view.entries.keys()].find((path) => path !== "package.json" && path.endsWith("/package.json"));
    if (nestedPackage) {
      throw new Error(`the generated hosted workflow does not support a nested package.json-only layout (${nestedPackage}); use a root npm package, the local CLI, or an explicit digest-pinned hermetic runner`);
    }
  } else {
    let packageManifest: unknown;
    try {
      packageManifest = JSON.parse(view.readText("package.json"));
    } catch {
      throw new Error("the generated hosted workflow requires root package.json to contain valid JSON");
    }
    if (!packageManifest || typeof packageManifest !== "object" || Array.isArray(packageManifest)) {
      throw new Error("the generated hosted workflow requires root package.json to contain a JSON object");
    }
    const packageManager = (packageManifest as Record<string, unknown>).packageManager;
    if (packageManager !== undefined
      && (typeof packageManager !== "string" || !(packageManager === "npm" || /^npm@[^\s]+$/.test(packageManager)))) {
      throw new Error("the generated hosted workflow requires packageManager to select npm when that field is present");
    }
    manifest = packageManifest as Record<string, unknown>;
    let requiresInstall = false;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const value = manifest[field];
      if (value === undefined) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.values(value as Record<string, unknown>).some((entry) => typeof entry !== "string")) {
        throw new Error(`the generated hosted workflow requires package.json ${field} to be an object of package specifier strings`);
      }
      if (Object.keys(value).length > 0) requiresInstall = true;
    }
    for (const field of ["bundledDependencies", "bundleDependencies"]) {
      const value = manifest[field];
      if (value === undefined) continue;
      if (typeof value === "boolean") {
        requiresInstall ||= value;
        continue;
      }
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`the generated hosted workflow requires package.json ${field} to be a boolean or an array of package names`);
      }
      if (value.length > 0) requiresInstall = true;
    }
    const workspaces = manifest.workspaces;
    if (workspaces !== undefined) {
      if (!Array.isArray(workspaces) || workspaces.some((entry) => typeof entry !== "string")) {
        throw new Error("the generated hosted workflow requires package.json workspaces to be an array of path patterns");
      }
      if (workspaces.length > 0) requiresInstall = true;
    }
    if (!setupCommand && requiresInstall) {
      throw new Error("the generated hosted workflow requires package-lock.json or npm-shrinkwrap.json when root package.json declares dependencies or workspaces");
    }
  }
  const inferred = inferredTestCommand(view, manifest);
  if (inferred && !inferred.startsWith("node --test")) {
    throw new Error("the generated isolated GitHub workflow needs a bounded direct node --test command; use the local CLI or configure an explicit digest-pinned hermetic runner for another toolchain");
  }
  return { setupCommand, testCommand: inferred, hasRootPackage };
}

export function initRepository(
  repo: string,
  force = false,
  portableSignerKeyId?: string,
  profile: SetupProfile = "default",
  attest = false,
  actionSha?: string,
  runnerOverride?: HostedRunnerOverride,
): InitResult {
  const requestedRoot = resolve(repo);
  let root: string;
  try {
    root = realpathSync(requestedRoot);
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("not a directory");
    if (trustedGit(root, ["rev-parse", "--is-inside-work-tree"], 1024).trim() !== "true") throw new Error("not a worktree");
  } catch { throw new Error(`not a Git repository: ${requestedRoot}`); }
  if (attest) {
    throw new Error("init --attest is disabled for candidate-executing workflows until a separately controlled signer is available; use vigil certify install-action for non-candidate control-proof attestation");
  }
  if (!/^[0-9a-f]{40}$/.test(actionSha ?? "")) {
    throw new Error("init requires an exact lowercase 40-hex Agent Vigil Action SHA for generated hosted workflows");
  }
  const ignoredInputs = ignoredSetupInputs(root);
  if (ignoredInputs.length) {
    throw new Error(`the generated hosted workflow cannot use ignored setup input(s) omitted from Git: ${ignoredInputs.slice(0, 5).join(", ")}${ignoredInputs.length > 5 ? ", …" : ""}`);
  }
  const hostedContract = validateHostedRepositoryContract(workingRepositoryView(root), runnerOverride);
  const setupCommand = hostedContract.setupCommand;
  const result: InitResult = { created: [], kept: [] };
  const inferred = hostedContract.testCommand;
  const mode = profile === "maintainer" || profile === "protect" ? "maintainer" : profile === "authority" ? "authority" : portableSignerKeyId ? "portable" : "transcript";
  const defaultPolicy = policyTemplate(inferred, portableSignerKeyId);
  const authorityPolicy = defaultPolicy.replace('"transcript": ".agent-vigil/session.md"', '"transcript": ".agent-vigil/session.jsonl"');
  const protectCommands = profile === "protect" ? inferProtectCommands(root, inferred) : undefined;
  if (runnerOverride) {
    writeScaffold(root, HOSTED_RUNNER_FILE, `${JSON.stringify({ schemaVersion: 1, ...runnerOverride }, null, 2)}\n`, force, result);
  }
  writeScaffold(root, DEFAULT_POLICY_FILE, mode === "maintainer" ? maintainerPolicyTemplate(inferred, setupCommand, protectCommands) : mode === "authority" ? authorityPolicy : defaultPolicy, force, result);
  if (mode === "transcript" || mode === "authority") {
    writeScaffold(root, mode === "authority" ? ".agent-vigil/session.jsonl" : ".agent-vigil/session.md", mode === "authority" ? AUTHORITY_SESSION_TEMPLATE : SESSION_TEMPLATE, force, result);
    writeScaffold(root, ".agent-vigil/README.md", LOCAL_README, force, result);
  }
  if (mode === "authority") writeScaffold(root, ".agent-vigil-authority.json", authorityContractTemplate(), force, result);
  if (mode === "maintainer") writeScaffold(root, ".github/pull_request_template.md", MAINTAINER_PR_TEMPLATE, force, result);
  writeScaffold(root, ".github/workflows/agent-vigil.yml", evidenceWorkflow(mode, actionSha!, setupCommand, hostedContract.candidateImage), force, result);
  writeScaffold(root, ".github/workflows/agent-vigil-outcomes.yml", outcomeWorkflow(actionSha!), force, result);
  return result;
}

function git(repo: string, args: string[]): string | undefined {
  try { return trustedGit(repo, args, 16 * 1024 * 1024).trim(); }
  catch { return undefined; }
}

function actionRefs(workflowText: string): string[] {
  return [...workflowText.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
}

function exactActionPin(reference: string): boolean {
  return /@[0-9a-f]{40}$/.test(reference);
}

function legacyPullRequestTrigger(workflowText: string): boolean {
  return /^\s+pull_request:\s*(?:#.*)?$/m.test(workflowText);
}

export function doctorRepository(repo: string, requestedPolicy?: string, requestedTranscript?: string): DoctorCheck[] {
  const root = resolve(repo);
  const checks: DoctorCheck[] = [];
  const workflow = resolve(root, ".github/workflows/agent-vigil.yml");
  const outcomeObserver = resolve(root, ".github/workflows/agent-vigil-outcomes.yml");
  let headView: RepositoryView | undefined;
  let headViewError: string | undefined;
  try {
    headView = headRepositoryView(root);
  } catch (error) {
    headViewError = (error as Error).message;
  }
  const inputSnapshot = (input: string) => committedInputSnapshot(root, headView, headViewError, input);
  const headHas = (input: string) => Boolean(headView?.entries.has(input));
  const workflowExpected = existsSync(workflow) || headHas(".github/workflows/agent-vigil.yml");
  const outcomeExpected = existsSync(outcomeObserver) || headHas(".github/workflows/agent-vigil-outcomes.yml");
  const generatedScaffoldExpected = existsSync(resolve(root, ".agent-vigil/README.md"))
    || headHas(".agent-vigil/README.md");
  const workflowSnapshot = workflowExpected ? inputSnapshot(".github/workflows/agent-vigil.yml") : {};
  const outcomeSnapshot = outcomeExpected ? inputSnapshot(".github/workflows/agent-vigil-outcomes.yml") : {};
  const installedWorkflow = workflowSnapshot.text ?? "";
  const installedOutcome = outcomeSnapshot.text ?? "";
  const workflowBindingError = workflowSnapshot.error;
  const outcomeBindingError = outcomeSnapshot.error;
  const authorityMatch = installedWorkflow.match(/^\s*authority-contract:\s*(\S+)\s*$/m);
  const workflowPolicyMatch = installedWorkflow.match(/^\s*policy:\s*(\S+)\s*$/m);
  const workflowTranscriptMatch = installedWorkflow.match(/^\s*transcript:\s*(\S+)\s*$/m);
  const workflowReceiptMatch = installedWorkflow.match(/^\s*receipt:\s*(\S+)\s*$/m);
  const authorityConfigured = Boolean(authorityMatch);
  const workflowPolicySnapshot = workflowPolicyMatch ? inputSnapshot(workflowPolicyMatch[1]) : {};
  const authoritySnapshot = authorityMatch ? inputSnapshot(authorityMatch[1]) : {};
  const authorityScaffoldExpected = existsSync(resolve(root, ".agent-vigil-authority.json")) || headHas(".agent-vigil-authority.json");
  const authorityScaffoldSnapshot = authorityScaffoldExpected
    ? inputSnapshot(".agent-vigil-authority.json")
    : {};
  const workflowPolicyBindingError = workflowPolicySnapshot.error;
  const authorityBindingError = authoritySnapshot.error;
  const authorityScaffoldBindingError = authorityScaffoldSnapshot.error;
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    status: nodeMajor >= 20 ? "PASS" : "FAIL",
    label: "Node.js",
    detail: `${process.versions.node}${nodeMajor >= 20 ? " satisfies Node 20+" : " is unsupported; install Node 20+"}`,
  });
  checks.push({
    status: outcomeExpected ? outcomeBindingError ? "FAIL" : "PASS" : workflowExpected || generatedScaffoldExpected ? "FAIL" : "WARN",
    label: "Outcome observer",
    detail: outcomeBindingError
      ?? (outcomeExpected
      ? "workflow-run observer retains post-evidence Actions and pull-request state without re-executing candidate code; it does not claim later close or merge observation"
      : workflowExpected || generatedScaffoldExpected
      ? "committed evidence installation is missing .github/workflows/agent-vigil-outcomes.yml"
      : "outcome workflow is missing; rerun vigil init to add post-run evidence closure"),
  });
  const gitRoot = git(root, ["rev-parse", "--show-toplevel"]);
  checks.push({
    status: gitRoot ? "PASS" : "FAIL",
    label: "Git repository",
    detail: gitRoot ?? `${root} is not inside a readable Git repository`,
  });

  let hostedContract: HostedRepositoryContract | undefined;
  let hostedContractError: string | undefined;
  try {
    if (!headView) throw new Error(headViewError ?? "the committed HEAD tree is unavailable");
    const pendingInputs = uncommittedSetupInputs(root);
    if (pendingInputs.length) {
      throw new Error(`setup-relevant input(s) are not identical to committed HEAD: ${pendingInputs.slice(0, 5).join(", ")}${pendingInputs.length > 5 ? ", …" : ""}; commit them before treating the hosted workflow as safe`);
    }
    // Re-check Git-visible entry types so a newly staged gitlink cannot hide
    // behind an otherwise unrelated path name.
    validateHostedRepositoryContract(workingRepositoryView(root));
    hostedContract = validateHostedRepositoryContract(headView);
  } catch (error) {
    hostedContractError = (error as Error).message;
  }
  checks.push({
    status: hostedContractError ? "FAIL" : "PASS",
    label: "Hosted repository contract",
    detail: hostedContractError
      ?? (hostedContract?.customRunner
        ? `hermetic custom runner is pinned by digest for ${hostedContract.testCommand}`
        : hostedContract?.hasRootPackage
        ? `root npm repository is supported${hostedContract.setupCommand ? ` with base-owned ${hostedContract.setupCommand}` : " without an install step"}`
        : "plain repository has no inferred non-Node toolchain; local CLI inference remains available"),
  });

  const workflowTranscript = workflowTranscriptMatch?.[1];
  const workflowReceipt = workflowReceiptMatch?.[1];
  const requestedTranscriptPath = requestedTranscript ? repositoryInputPath(root, requestedTranscript) : undefined;
  const workflowTranscriptPath = workflowTranscript ? repositoryInputPath(root, workflowTranscript) : undefined;
  const transcriptOverrideError = requestedTranscript && workflowExpected
    ? workflowTranscriptPath
      ? requestedTranscriptPath === workflowTranscriptPath
        ? undefined
        : `--transcript ${requestedTranscript} does not match hosted workflow input ${workflowTranscript}`
      : `--transcript ${requestedTranscript} cannot replace the hosted workflow's ${workflowReceipt ? "portable receipt" : "selected evidence mode"}`
    : undefined;
  let transcript = workflowTranscript ?? requestedTranscript;
  let portableReceipt: string | undefined;
  let maintainer = false;
  let configuredMode: "transcript" | "portable" | "maintainer" | "authority" = authorityScaffoldExpected ? "authority" : "transcript";
  let maintainerReviewMode: "human" | "automated" | "legacy" = "legacy";
  let policyBindingError: string | undefined;
  let evidenceInputBindingError: string | undefined;
  let evidenceSnapshot: CommittedInputSnapshot | undefined;
  try {
    const workflowPolicy = workflowPolicyMatch?.[1];
    const requestedPolicyPath = requestedPolicy ? repositoryInputPath(root, requestedPolicy) : undefined;
    const workflowPolicyPath = workflowPolicy ? repositoryInputPath(root, workflowPolicy) : undefined;
    const policyOverrideError = requestedPolicy && workflowPolicyPath && requestedPolicyPath !== workflowPolicyPath
      ? `--policy ${requestedPolicy} does not match hosted workflow input ${workflowPolicy}`
      : undefined;
    const policyInput = workflowPolicy ?? requestedPolicy ?? DEFAULT_POLICY_FILE;
    const policyPath = repositoryInputPath(root, policyInput);
    const shouldBindPolicy = Boolean(requestedPolicy || existsSync(resolve(root, policyInput)) || workflowExpected || (policyPath && headHas(policyPath)));
    const policySnapshot = shouldBindPolicy ? inputSnapshot(policyInput) : {};
    policyBindingError = policySnapshot.error;
    if (policyBindingError) throw new Error(policyBindingError);
    const policy = shouldBindPolicy
      ? loadPolicy(root, policySnapshot.path, headView?.commit)
      : loadPolicy(root, requestedPolicy);
    if (workflowExpected && policy.value.testCommand !== hostedContract?.testCommand) {
      throw new Error(`committed policy testCommand must equal the exact hosted direct-runner command ${JSON.stringify(hostedContract?.testCommand ?? null)}; regenerate with vigil init`);
    }
    const workflowEvidencePolicyError = workflowReceipt && policy.value.portableReceipt !== workflowReceipt
      ? `committed policy portableReceipt must equal hosted workflow input ${workflowReceipt}`
      : workflowTranscript && policy.value.transcript !== workflowTranscript
      ? `committed policy transcript must equal hosted workflow input ${workflowTranscript}`
      : undefined;
    const policyReadinessError = policyOverrideError ?? workflowEvidencePolicyError;
    checks.push({
      status: policyReadinessError ? "FAIL" : shouldBindPolicy ? "PASS" : "WARN",
      label: "Policy",
      detail: policyReadinessError ?? (shouldBindPolicy ? `${policySnapshot.path} · ${policy.sha256}` : `no ${DEFAULT_POLICY_FILE}; CLI defaults will be used`),
    });
    transcript ??= policy.value.transcript;
    portableReceipt = workflowReceipt ?? policy.value.portableReceipt;
    maintainer = Boolean(policy.value.maintainer);
    configuredMode = maintainer ? "maintainer" : workflowReceipt || portableReceipt ? "portable" : configuredMode;
    if (policy.value.maintainer?.reviewMode) maintainerReviewMode = policy.value.maintainer.reviewMode;
    const command = policy.value.testCommand ?? inferTestCommand(root);
    const placeholder = command === "REPLACE_WITH_TEST_COMMAND";
    checks.push({
      status: policyReadinessError || placeholder ? "FAIL" : command ? "PASS" : "WARN",
      label: "Fresh verification",
      detail: policyReadinessError
        ? `test command is not trusted for hosted readiness: ${policyReadinessError}`
        : placeholder
        ? "replace REPLACE_WITH_TEST_COMMAND in .agent-vigil.json"
        : command
        ? `test command: ${command}`
        : "no test command inferred; use policy testCommand or --test-cmd",
    });
    policyBindingError = policyReadinessError;
    if (portableReceipt) {
      const signerCount = policy.value.trustedSignerKeyIds?.length ?? 0;
      checks.push({
        status: signerCount ? "PASS" : "FAIL",
        label: "Portable signer",
        detail: signerCount ? `${signerCount} signer key ID(s) pinned by policy` : "portable receipt mode requires trustedSignerKeyIds",
      });
    }
  } catch (error) {
    policyBindingError = (error as Error).message;
    checks.push({ status: "FAIL", label: "Policy", detail: policyBindingError });
    checks.push({ status: "FAIL", label: "Fresh verification", detail: `test command is not trusted because policy readiness failed: ${policyBindingError}` });
  }

  if (portableReceipt) {
    const path = resolve(root, portableReceipt);
    const committedPath = repositoryInputPath(root, portableReceipt);
    const presentAtHead = Boolean(committedPath && headView?.entries.has(committedPath));
    if (workflowExpected || generatedScaffoldExpected || existsSync(path) || presentAtHead) {
      evidenceSnapshot = inputSnapshot(portableReceipt);
      evidenceInputBindingError = evidenceSnapshot.error;
    }
    evidenceInputBindingError ??= transcriptOverrideError;
    checks.push({
      status: evidenceInputBindingError ? "FAIL" : existsSync(path) ? "PASS" : "WARN",
      label: "Portable receipt",
      detail: evidenceInputBindingError
        ?? (existsSync(path)
        ? `${portableReceipt} is present; run vigil gate to verify it`
        : `${portableReceipt} will be created after the next signed code change; raw transcript remains local`),
    });
  } else if (maintainer) {
    evidenceInputBindingError = transcriptOverrideError;
    if (transcriptOverrideError) checks.push({ status: "FAIL", label: "Transcript", detail: transcriptOverrideError });
    const template = resolve(root, ".github/pull_request_template.md");
    const templateExpected = existsSync(template) || headHas(".github/pull_request_template.md");
    const templateBindingError = templateExpected ? inputSnapshot(".github/pull_request_template.md").error : undefined;
    checks.push({
      status: templateExpected && !templateBindingError ? "PASS" : "FAIL",
      label: "Pull request evidence",
      detail: templateBindingError ?? (templateExpected ? "AI-assistance, linked-issue, and limitations template is installed" : "maintainer profile requires .github/pull_request_template.md"),
    });
    checks.push({
      status: policyBindingError ? "FAIL" : maintainerReviewMode === "automated" ? "PASS" : maintainerReviewMode === "human" ? "PASS" : "WARN",
      label: "Review mode",
      detail: policyBindingError ?? (maintainerReviewMode === "automated"
        ? "base policy runs explicit automated-review commands in credential-free candidate-only containers over the exact commit"
        : maintainerReviewMode === "human"
        ? "base policy requires named human review declarations"
        : "legacy policy does not name a reviewMode; set human or automated explicitly"),
    });
  } else if (!transcript) {
    checks.push({ status: "WARN", label: "Transcript", detail: "no transcript configured; pass a path or run vigil init" });
  } else {
    const path = resolve(root, transcript);
    const committedPath = repositoryInputPath(root, transcript);
    const presentAtHead = Boolean(committedPath && headView?.entries.has(committedPath));
    if (workflowExpected || generatedScaffoldExpected || existsSync(path) || presentAtHead) {
      evidenceSnapshot = inputSnapshot(transcript);
      evidenceInputBindingError = evidenceSnapshot.error;
    }
    if (evidenceInputBindingError) checks.push({ status: "FAIL", label: "Transcript", detail: evidenceInputBindingError });
    else if (!existsSync(path)) checks.push({ status: "WARN", label: "Transcript", detail: `${transcript} does not exist yet` });
    else {
      try {
        if (!evidenceSnapshot?.bytes) throw new Error(`${transcript} has no committed snapshot to inspect`);
        const loaded = loadTranscriptSnapshot(transcript, evidenceSnapshot.bytes);
        checks.push({
          status: transcriptOverrideError || (authorityConfigured && loaded.toolCalls.length === 0) ? "FAIL" : "PASS",
          label: "Transcript",
          detail: transcriptOverrideError
            ?? (authorityConfigured && loaded.toolCalls.length === 0
            ? `${transcript} is ${loaded.format} with no structured tool calls; authority mode requires a supported structured export`
            : `${transcript} detected as ${loaded.format}; ${loaded.toolCalls.length} tool call(s)`),
        });
        evidenceInputBindingError ??= transcriptOverrideError;
      } catch (error) {
        checks.push({ status: "FAIL", label: "Transcript", detail: (error as Error).message });
      }
    }
  }

  const evidenceControlBindingError = workflowBindingError
    ?? workflowPolicyBindingError
    ?? policyBindingError
    ?? evidenceInputBindingError
    ?? authorityBindingError
    ?? authorityScaffoldBindingError;
  const workflowRequired = workflowExpected
    || outcomeExpected
    || generatedScaffoldExpected
    || authorityScaffoldExpected
    || maintainer
    || Boolean(portableReceipt)
    || existsSync(resolve(root, ".agent-vigil/session.md"))
    || existsSync(resolve(root, ".agent-vigil/session.jsonl"))
    || headHas(".agent-vigil/session.md")
    || headHas(".agent-vigil/session.jsonl");
  checks.push({
    status: workflowExpected ? workflowBindingError ? "FAIL" : "PASS" : workflowRequired ? "FAIL" : "WARN",
    label: "GitHub Action",
    detail: workflowBindingError
      ?? (workflowExpected
      ? "evidence workflow is installed; its job name alone is not an enforceable workflow identity"
      : workflowRequired
      ? "Agent Vigil evidence inputs exist but .github/workflows/agent-vigil.yml is missing from the committed installation"
      : "workflow not installed; run vigil init"),
  });
  if (workflowExpected) {
    const text = installedWorkflow;
    const evidenceSelfReferences = actionRefs(text).filter((reference) => reference.startsWith("sulmusic2-star/agent-vigil@"));
    const outcomeSelfReferences = actionRefs(installedOutcome).filter((reference) => reference.startsWith("sulmusic2-star/agent-vigil@"));
    const installedSelfSha = evidenceSelfReferences.length === 1 ? evidenceSelfReferences[0].split("@")[1] : "";
    const sharedExactSelfPin = /^[0-9a-f]{40}$/.test(installedSelfSha)
      && outcomeSelfReferences.length === 1
      && outcomeSelfReferences[0] === evidenceSelfReferences[0];
    const expectedWorkflow = sharedExactSelfPin && !hostedContractError && !evidenceControlBindingError
      ? evidenceWorkflow(configuredMode, installedSelfSha, hostedContract?.setupCommand, hostedContract?.candidateImage)
      : "";
    const exactGeneratedWorkflow = sharedExactSelfPin && text === expectedWorkflow;
    const baseSelectedTrigger = /^\s+pull_request_target:\s*(?:#.*)?$/m.test(text)
      && !legacyPullRequestTrigger(text);
    checks.push({
      status: baseSelectedTrigger && !workflowBindingError ? "PASS" : "FAIL",
      label: "Workflow trigger",
      detail: workflowBindingError ?? (baseSelectedTrigger
        ? "evidence workflow is base-selected with pull_request_target"
        : "candidate-selected pull_request workflow bytes cannot define the evidence pipeline; regenerate with vigil init"),
    });
    checks.push({
      status: exactGeneratedWorkflow && !hostedContractError && !evidenceControlBindingError ? "PASS" : "FAIL",
      label: "Candidate isolation",
      detail: hostedContractError
        ? `unsupported hosted repository shape: ${hostedContractError}`
        : evidenceControlBindingError
        ? `hosted security input is not committed: ${evidenceControlBindingError}`
        : exactGeneratedWorkflow
        ? "workflow matches the credential-free exact-head checkout and nested candidate-isolation template"
        : "workflow must match the generated exact-head checkout, persist-credentials:false, isolate-candidate:true, base-owned setup, read-only permissions, and immutable steps",
    });
    const unsafeCandidatePrivileges = /^\s*attest:\s*true\s*$/m.test(text)
      || /^\s*(?:[a-z][a-z-]*):\s*write\s*$/m.test(text)
      || /^\s*github-token:\s*\S+/m.test(text);
    checks.push({
      status: unsafeCandidatePrivileges || Boolean(workflowBindingError) ? "FAIL" : "PASS",
      label: "Credential boundary",
      detail: workflowBindingError ?? (unsafeCandidatePrivileges
        ? "candidate-executing evidence workflows cannot receive GitHub tokens, OIDC, attestation, or write permissions"
        : "candidate evidence has read-only metadata permissions and no explicit GitHub token or signing authority"),
    });
    const references = [...actionRefs(text), ...actionRefs(installedOutcome)];
    const mutableReferences = references.filter((reference) => !exactActionPin(reference));
    checks.push({
      status: references.length > 0 && mutableReferences.length === 0 && sharedExactSelfPin && !workflowBindingError && !outcomeBindingError ? "PASS" : "FAIL",
      label: "Action pins",
      detail: workflowBindingError ?? outcomeBindingError ?? (mutableReferences.length === 0 && references.length > 0 && sharedExactSelfPin
        ? "every Action is immutable and evidence plus outcome use the same exact Agent Vigil runtime"
        : !sharedExactSelfPin
        ? "evidence and outcome must each use the same exact lowercase 40-hex Agent Vigil runtime"
        : `mutable or missing Action reference(s): ${mutableReferences.join(", ") || "none found"}`),
    });
    if (outcomeExpected) {
      const exactOutcome = sharedExactSelfPin && installedOutcome === outcomeWorkflow(installedSelfSha);
      const unsafeOutcomePrivileges = /^\s*(?:[a-z][a-z-]*):\s*write\s*$/m.test(installedOutcome)
        || /^\s*attest:\s*true\s*$/m.test(installedOutcome)
        || /actions\/checkout@/.test(installedOutcome);
      checks.push({
        status: exactOutcome && !unsafeOutcomePrivileges && !outcomeBindingError ? "PASS" : "FAIL",
        label: "Outcome isolation",
        detail: outcomeBindingError ?? (exactOutcome && !unsafeOutcomePrivileges
          ? "outcome workflow is unprivileged and does not check out or execute candidate code"
          : "outcome workflow must match the generated unprivileged, non-checkout, immutable observer template"),
      });
    }
    const exactRange = /pull_request\.base\.sha/.test(text) && /pull_request\.head\.sha/.test(text);
    checks.push({
      status: workflowBindingError ? "FAIL" : exactRange ? "PASS" : "WARN",
      label: "Git range",
      detail: workflowBindingError ?? (exactRange ? "workflow pins the pull request base and head SHAs" : "workflow does not visibly pin both pull request SHAs"),
    });
    const exactCheckout = /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/.test(text);
    checks.push({
      status: workflowBindingError ? "FAIL" : exactCheckout ? "PASS" : "WARN",
      label: "Checkout identity",
      detail: workflowBindingError ?? (exactCheckout ? "workflow checks out the exact pull request head SHA" : "workflow may verify GitHub's synthetic merge commit instead of the selected head"),
    });
    const anchoredPolicy = /policy-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/.test(text);
    checks.push({
      status: workflowBindingError || workflowPolicyBindingError || policyBindingError ? "FAIL" : anchoredPolicy ? "PASS" : "WARN",
      label: "Policy trust",
      detail: workflowBindingError ?? workflowPolicyBindingError ?? policyBindingError ?? (anchoredPolicy ? "workflow loads policy from the pull request base commit" : "workflow policy may be controlled by the candidate change"),
    });
    const repositoryOwnedMergeQueue = /^\s+merge_group:\s*(?:#.*)?$/m.test(text) || /github\.event\.merge_group/.test(text);
    checks.push({
      status: repositoryOwnedMergeQueue || Boolean(workflowBindingError) ? "FAIL" : "PASS",
      label: "Merge queue",
      detail: workflowBindingError ?? (repositoryOwnedMergeQueue
        ? "repository-owned merge_group workflow bytes are candidate-selected; use an externally trusted required workflow or ruleset"
        : "repository-owned merge_group is disabled because queue verification requires an externally trusted workflow or ruleset"),
    });
    if (maintainer) {
      const modeInstalled = /mode:\s*maintainer/.test(text);
      const artifactInstalled = /name:\s*agent-vigil-receipt/.test(text);
      checks.push({
        status: modeInstalled && artifactInstalled && !workflowBindingError && !policyBindingError ? "PASS" : "FAIL",
        label: "Maintainer workflow",
        detail: workflowBindingError ?? policyBindingError ?? (modeInstalled && artifactInstalled ? "maintainer mode and receipt artifact retention are installed" : "workflow must enable maintainer mode and retain agent-vigil-receipt"),
      });
    }
    if (authorityMatch) {
      try {
        const contractBindingError = authorityBindingError ?? authorityScaffoldBindingError;
        if (contractBindingError) throw new Error(contractBindingError);
        if (!authoritySnapshot.path || !headView?.commit) throw new Error("authority contract has no committed snapshot");
        const contract = loadAuthorityContract(root, authoritySnapshot.path, headView.commit);
        const placeholder = contract.value.taskId === "REPLACE_WITH_TASK_OR_TICKET_ID";
        const expired = Boolean(contract.value.expiresAt && Date.now() > new Date(contract.value.expiresAt).getTime());
        const anchored = /^\s*authority-contract-ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}\s*$/m.test(text);
        checks.push({
          status: placeholder || expired || !anchored ? "FAIL" : "PASS",
          label: "Task authority",
          detail: placeholder ? "replace the generated taskId before use" : expired ? `contract expired at ${contract.value.expiresAt}` : !anchored ? "workflow must load authority from the GitHub event base" : `${contract.value.taskId} · ${contract.sha256} · base-anchored`,
        });
      } catch (error) {
        checks.push({ status: "FAIL", label: "Task authority", detail: (error as Error).message });
      }
    }
  }
  if (authorityScaffoldExpected && !authorityMatch) {
    checks.push({
      status: "FAIL",
      label: "Task authority",
      detail: authorityScaffoldBindingError
        ?? workflowBindingError
        ?? "an authority scaffold exists but the committed evidence workflow does not select it",
    });
  }
  return checks;
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const icon = { PASS: "✓", WARN: "!", FAIL: "✗" } as const;
  const lines = ["Agent Vigil doctor", ""];
  for (const check of checks) lines.push(`${icon[check.status]} ${check.status.padEnd(4)} ${check.label}: ${check.detail}`);
  const failed = checks.filter((check) => check.status === "FAIL").length;
  const warned = checks.filter((check) => check.status === "WARN").length;
  lines.push("", `${failed} failure(s) · ${warned} warning(s)`);
  return lines.join("\n");
}
