import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const SELF_PIN_FILES = [
  ".github/workflows/agent-vigil.yml",
  ".github/workflows/agent-vigil-merge-group.yml",
  ".github/workflows/agent-vigil-outcomes.yml",
  ".github/workflows/control-proof-weekly.yml",
  "hosted/public-app/control-workflow.yml",
];
const RUNTIME_PATHS = new Set([
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "src/adoption.ts",
  "src/report.ts",
]);
const FINAL_PATHS = new Set([
  ...SELF_PIN_FILES,
  "README.md",
  "docs/INSTALL_WITHOUT_NPM_ACCOUNT.md",
  "docs/check.js",
  "docs/public-install-state.json",
  "docs/COMPETITOR_COMPARISON.md",
  "benchmarks/comparative/v0234-exact-results.json",
  "benchmarks/comparative/v0234-exact-results.md",
  "test-hosted/competitor-comparison.test.ts",
  "test-hosted/adoption-conversion.test.ts",
  "test-hosted/browser-pr-checker.test.ts",
  "test-hosted/first-use-source.test.ts",
  "test-hosted/five-minute-onboarding.test.ts",
  "test-hosted/merge-queue-dispatcher.test.ts",
  "test-hosted/public-install-state.test.ts",
  "test-hosted/repository-contract.test.ts",
  "test/adoption-links.test.ts",
  "test/control-proof-attestation.test.ts",
  "test/outcome.test.ts",
  "test/package-surface.test.ts",
  "test/protect.test.ts",
]);

function git(repo: string, args: string[], encoding: BufferEncoding | "buffer" = "utf8"): string | Buffer {
  return execFileSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: repo,
    encoding: encoding === "buffer" ? null : encoding,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function one(repo: string, args: string[]): string {
  return String(git(repo, args)).trim();
}

function changed(repo: string, from: string, to: string): string[] {
  return String(git(repo, ["diff", "--name-only", "-z", from, to])).split("\0").filter(Boolean).sort();
}

function assertAllowed(paths: string[], allowed: Set<string>, phase: string): void {
  const unexpected = paths.filter((path) => !allowed.has(path) && !(phase === "runtime" && path.startsWith("dist/")));
  if (unexpected.length) throw new Error(`${phase} commit changes unexpected path(s): ${unexpected.join(", ")}`);
}

function blob(repo: string, commit: string, path: string): string {
  return String(git(repo, ["show", `${commit}:${path}`]));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function files(root: string, directory = root): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...files(root, path));
    else if (entry.isFile()) output.push(relative(root, path));
    else throw new Error(`release build produced a non-regular dist entry: ${relative(root, path)}`);
  }
  return output.sort();
}

function verifyReproducibleDist(repo: string, head: string): void {
  const root = resolve(repo);
  const modules = join(root, "node_modules");
  if (!statSync(modules).isDirectory()) throw new Error("node_modules is required for the local reproducible-build check");
  const temporary = mkdtempSync(join(tmpdir(), "agent-vigil-release-assembly-"));
  try {
    const archive = git(root, ["archive", "--format=tar", head], "buffer") as Buffer;
    execFileSync("tar", ["-xf", "-", "-C", temporary], { input: archive, maxBuffer: 128 * 1024 * 1024 });
    cpSync(modules, join(temporary, "node_modules"), { recursive: true, dereference: true });
    execFileSync("npm", ["run", "build"], { cwd: temporary, stdio: "pipe", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    const trackedDist = files(join(root, "dist"));
    const rebuiltDist = files(join(temporary, "dist"));
    if (trackedDist.join("\n") !== rebuiltDist.join("\n")) throw new Error("tracked and rebuilt dist file lists differ");
    for (const path of trackedDist) {
      if (sha256(join(root, "dist", path)) !== sha256(join(temporary, "dist", path))) {
        throw new Error(`dist/${path} is not the deterministic output of the reviewed source`);
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyReleaseAssembly(options: { repo: string; base: string; runtime: string; head: string; version: string }): void {
  const repo = resolve(options.repo);
  for (const [name, value] of [["base", options.base], ["runtime", options.runtime], ["head", options.head]] as const) {
    if (!SHA.test(value)) throw new Error(`${name} must be a full lowercase commit SHA`);
    one(repo, ["cat-file", "-e", `${value}^{commit}`]);
  }
  if (!VERSION.test(options.version)) throw new Error("version must be plain semver");
  if (one(repo, ["rev-parse", `${options.runtime}^`]) !== options.base) throw new Error("runtime commit must be the only commit after base");
  if (one(repo, ["rev-parse", `${options.head}^`]) !== options.runtime) throw new Error("pin commit must immediately follow the runtime commit");
  assertAllowed(changed(repo, options.base, options.runtime), RUNTIME_PATHS, "runtime");
  assertAllowed(changed(repo, options.runtime, options.head), FINAL_PATHS, "pin");
  if (Number(one(repo, ["rev-list", "--count", `${options.base}..${options.head}`])) !== 2) throw new Error("release assembly must contain exactly two commits");

  const manifest = JSON.parse(blob(repo, options.head, "package.json"));
  const lock = JSON.parse(blob(repo, options.head, "package-lock.json"));
  if (manifest.version !== options.version || lock.version !== options.version || lock.packages?.[""]?.version !== options.version) {
    throw new Error("package and lockfile versions do not match the requested release");
  }
  const escapedVersion = options.version.replaceAll(".", "\\.");
  if (!new RegExp(`export const VERSION = "${escapedVersion}";`).test(blob(repo, options.head, "src/report.ts"))) {
    throw new Error("src/report.ts does not expose the requested release version");
  }
  if (String(git(repo, ["diff", "--name-only", options.runtime, options.head, "--", "action.yml", "src", "dist"])).trim()) {
    throw new Error("action, source, or dist changed after the reviewed runtime commit");
  }
  for (const path of SELF_PIN_FILES) {
    const references = [...blob(repo, options.head, path).matchAll(/sulmusic2-star\/agent-vigil@([0-9a-f]{40})/g)].map((match) => match[1]);
    if (references.length !== 1 || references[0] !== options.runtime) throw new Error(`${path} must pin the reviewed runtime commit exactly once`);
  }
  verifyReproducibleDist(repo, options.head);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const repo = option("--repo") ?? ".";
  const base = option("--base");
  const runtime = option("--runtime");
  const head = option("--head");
  const version = option("--version");
  if (!base || !runtime || !head || !version) {
    throw new Error("usage: tsx scripts/verify_release_assembly.ts --base <sha> --runtime <sha> --head <sha> --version <x.y.z> [--repo <path>]");
  }
  verifyReleaseAssembly({ repo, base, runtime, head, version });
  process.stdout.write(`Release assembly PASS: ${version} ${base} -> ${runtime} -> ${head}\n`);
}
