import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { trustedGit } from "./trusted-git.ts";
import { terminalSafe } from "./upgrade/presentation.ts";

export const REGRESSION_IMAGE = "node@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3";
export const REGRESSION_FILE = ".vigil-regressions.json";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RegressionCase = { id: string; module: string; export: string; args: Json[]; expect: Json };
export type RegressionContract = { version: 1; files: string[]; cases: RegressionCase[] };
export type RegressionObservation = { state: "value"; value: Json; machineMs: number } | { state: "unavailable"; reason: string; machineMs: number };
export type RegressionVerdict = "PASS" | "FAIL" | "NOT CHECKED";
export type RegressionRow = { id: string; module: string; verdict: RegressionVerdict; expected: Json; baseline: RegressionObservation[]; candidate: RegressionObservation[]; reason: string };
export type RegressionReceipt = {
  schema: "agent-vigil-regression/v1"; base: string; head: string; contractPath: string;
  contractSha256?: string; runnerImage: string; verdict: RegressionVerdict; reason: string;
  rows: RegressionRow[]; files: { path: string; baseSha256: string; headSha256: string }[];
  changedFiles: { status: string; path: string }[]; requiredCases: number; machineMs: number;
  scope: string; reproduceCommand?: string;
};
const MAX_BLOB = 1024 * 1024;
export const regressionHash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function keys(v: Record<string, unknown>, expected: string[]) {
  if (Object.keys(v).sort().join("|") !== [...expected].sort().join("|")) throw new Error("Unexpected or missing contract fields.");
}
function jsonValue(v: unknown, depth = 0): v is Json {
  if (depth > 20) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v) && !Object.is(v, -0);
  if (Array.isArray(v)) return v.every(item => jsonValue(item, depth + 1));
  return object(v) && Object.entries(v).every(([key, value]) => !["__proto__", "constructor", "prototype"].includes(key) && jsonValue(value, depth + 1));
}
export function validateRegressionPath(path: string): void {
  if (path.length > 200 || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.cjs$/.test(path) || path.split("/").some(part => /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error("Use a simple repository-relative .cjs path; no traversal, hidden files or platform device names.");
  }
}
export function parseRegressionContract(text: string): RegressionContract {
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Contract exceeds 64 KiB.");
  const v: unknown = JSON.parse(text);
  if (!object(v)) throw new Error("Contract must be an object.");
  keys(v, ["version", "files", "cases"]);
  if (v.version !== 1 || !Array.isArray(v.files) || v.files.length < 1 || v.files.length > 20 || !Array.isArray(v.cases) || v.cases.length < 1 || v.cases.length > 32) throw new Error("Version 1 requires 1–20 files and 1–32 cases.");
  const paths = new Set<string>();
  for (const path of v.files) {
    if (typeof path !== "string") throw new Error("Files must be paths.");
    validateRegressionPath(path);
    if (paths.has(path.toLowerCase())) throw new Error("Duplicate or case-colliding file path.");
    paths.add(path.toLowerCase());
  }
  const ids = new Set<string>();
  for (const item of v.cases) {
    if (!object(item)) throw new Error("Each case must be an object.");
    keys(item, ["id", "module", "export", "args", "expect"]);
    if (typeof item.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || ids.has(item.id)) throw new Error("Case IDs must be unique, short lowercase names.");
    ids.add(item.id);
    if (typeof item.module !== "string" || !v.files.includes(item.module) || typeof item.export !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(item.export) || ["__proto__", "constructor", "prototype"].includes(item.export)) throw new Error("Each case needs an allowed module and named function export.");
    if (!Array.isArray(item.args) || !jsonValue(item.args) || !jsonValue(item.expect) || JSON.stringify(item).length > 16384) throw new Error("Use bounded JSON arguments and expectations; no undefined, non-finite numbers or special object keys.");
  }
  return v as RegressionContract;
}
function blob(repo: string, sha: string, path: string): string {
  const entry = trustedGit(repo, ["ls-tree", "-z", sha, "--", path], 4096);
  const match = /^(100644|100755) blob [0-9a-f]{40}\t([^\0]+)\0$/.exec(entry);
  if (!match || match[2] !== path) throw new Error(`Missing regular Git blob: ${path}`);
  const source = trustedGit(repo, ["show", `${sha}:${path}`], MAX_BLOB);
  if (source.includes("\ufffd") || source.includes("\0")) throw new Error(`Unsupported non-UTF-8 or binary source: ${path}`);
  return source;
}

// Expected answers and Git metadata never enter the candidate process. The
// controller treats everything returned by that process as untrusted data.
export const REGRESSION_LAUNCHER = `const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const write = process.stdout.write.bind(process.stdout);
const encode = JSON.stringify;
const exit = process.exit.bind(process);
const ownKeys = Reflect.ownKeys, descriptor = Object.getOwnPropertyDescriptor;
const prototype = Object.getPrototypeOf, isArray = Array.isArray;
const finite = Number.isFinite, same = Object.is;
const objectPrototype = Object.prototype, arrayPrototype = Array.prototype;
const isProxy = require('node:util').types.isProxy;
let visited = 0;
function wire(value, depth = 0) {
  if (++visited > 16384 || depth > 20) throw Error('Result exceeds limits');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return encode(value);
  if (typeof value === 'number') {
    if (!finite(value) || same(value, -0)) throw Error('Unsupported number');
    return encode(value);
  }
  if (typeof value !== 'object' || isProxy(value)) throw Error('Unsupported result');
  const array = isArray(value), proto = prototype(value), keys = ownKeys(value);
  if (array ? proto !== arrayPrototype : proto !== objectPrototype && proto !== null) throw Error('Unsupported object');
  const length = array ? descriptor(value, 'length').value : keys.length;
  if (length > 16384 || (array && keys.length !== length + 1)) throw Error('Sparse or extended array');
  let text = array ? '[' : '{';
  for (let i = 0; i < length; i++) {
    const key = array ? '' + i : keys[i];
    if (typeof key !== 'string' || key === '__proto__' || key === 'constructor' || key === 'prototype') throw Error('Unsupported key');
    const field = descriptor(value, key);
    if (!field || !field.enumerable || !descriptor(field, 'value')) throw Error('Accessor or missing field');
    if (i) text += ',';
    if (!array) text += encode(key) + ':';
    text += wire(field.value, depth + 1);
    if (text.length > 65536) throw Error('Result exceeds output limit');
  }
  return text + (array ? ']' : '}');
}
(async () => {
  const module = require('/work/' + request.module);
  if (!Object.prototype.hasOwnProperty.call(module, request.export) || typeof module[request.export] !== 'function') throw Error('Missing named function');
  const value = await module[request.export](...request.args);
  // Serialize plain JSON data ourselves: JSON.stringify would silently turn
  // NaN into null, drop undefined fields and invoke user-defined toJSON.
  let serialized;
  try { serialized = wire(value); } catch { exit(71); return; }
  write('{"value":' + serialized + '}\\n');
})().catch(() => exit(70));`;

export function regressionDockerArgs(directory: string, name: string): string[] {
  if (directory.includes(",") || /[\r\n\0]/.test(directory)) throw new Error("Docker snapshot path contains unsupported characters.");
  return ["run", "--rm", "--name", name, "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--user=65534:65534", "--pids-limit=32", "--memory=128m", "--memory-swap=128m", "--cpus=1",
    "--no-healthcheck", "--ulimit", "nofile=128:128", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m,mode=1777", "--workdir=/work",
    "--mount", `type=bind,source=${directory},target=/work,readonly`, "--env", "HOME=/tmp", "--env", "NODE_OPTIONS=", "--env", "NODE_PATH=",
    "--entrypoint=node", "-i", REGRESSION_IMAGE, "--input-type=commonjs", "-e", REGRESSION_LAUNCHER];
}
export function parseRegressionObservation(status: number | null, error: boolean, stdout: string, machineMs: number): RegressionObservation {
  if (!error && status === 71) return { state: "unavailable", reason: "Function returned unsupported JSON data. Use plain JSON values, without NaN, negative zero, missing fields or custom serialization.", machineMs };
  if (error || status !== 0) return { state: "unavailable", reason: "Runner failed, timed out, or exceeded its output limit.", machineMs };
  try {
    const value: unknown = JSON.parse(stdout);
    if (!object(value) || Object.keys(value).join() !== "value" || !jsonValue(value.value)) throw new Error();
    return { state: "value", value: value.value, machineMs };
  } catch { return { state: "unavailable", reason: "Runner did not return one valid JSON value envelope.", machineMs }; }
}
export function observeRegression(directory: string, item: RegressionCase): RegressionObservation {
  const name = `vigil-regression-${randomUUID()}`;
  const start = performance.now();
  // Client configuration may select the user's Docker daemon. No host env,
  // Docker socket, credentials, Git directory or expected answers are mounted
  // or forwarded into the candidate. The Docker daemon remains trusted.
  const result = spawnSync("docker", regressionDockerArgs(directory, name), {
    input: JSON.stringify({ module: item.module, export: item.export, args: item.args }),
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL",
  });
  if (result.error || result.signal) {
    const cleanup = spawnSync("docker", ["rm", "--force", name], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    if (cleanup.error || (cleanup.status !== 0 && !cleanup.stderr.includes("No such container"))) return { state: "unavailable", reason: `Runner interrupted; confirm container ${name} was removed.`, machineMs: performance.now() - start };
  }
  return parseRegressionObservation(result.status, !!result.error || !!result.signal, result.stdout ?? "", performance.now() - start);
}

export function judgeRegressionCase(item: RegressionCase, baseline: RegressionObservation[], candidate: RegressionObservation[]): RegressionRow {
  const row: RegressionRow = { id: item.id, module: item.module, expected: item.expect, baseline, candidate, verdict: "NOT CHECKED", reason: "Baseline did not reproduce the approved answer twice." };
  const matches = (o: RegressionObservation) => o.state === "value" && isDeepStrictEqual(o.value, item.expect);
  if (baseline.length !== 2 || !baseline.every(matches)) return row;
  if (candidate.length !== 2 || candidate.some(o => o.state !== "value")) return { ...row, reason: "Candidate result is missing; this is not proof of a behavior regression." };
  const values = candidate as Extract<RegressionObservation, { state: "value" }>[];
  if (!isDeepStrictEqual(values[0].value, values[1].value)) return { ...row, reason: "Candidate returned different answers on repeat runs." };
  return candidate.every(matches) ? { ...row, verdict: "PASS", reason: "Both runs matched the protected answer." } : { ...row, verdict: "FAIL", reason: "Both runs returned the same wrong answer for a protected case." };
}

export function runRegression(options: { repo: string; base: string; head: string }, observe: typeof observeRegression = observeRegression): RegressionReceipt {
  const start = performance.now();
  const receipt: RegressionReceipt = { schema: "agent-vigil-regression/v1", base: options.base, head: options.head, contractPath: REGRESSION_FILE, runnerImage: REGRESSION_IMAGE,
    verdict: "NOT CHECKED", reason: "Required evidence has not run.", rows: [], files: [], changedFiles: [], requiredCases: 0, machineMs: 0,
    scope: "Protected JSON input/output cases for explicitly listed dependency-free CommonJS files. Local evidence only, not a signed App check, complete test suite, or proof of all behavior. Two repeats do not prove absence of flakiness." };
  let temporary: string | undefined;
  try {
    for (const sha of [options.base, options.head]) {
      if (!/^[0-9a-f]{40}$/.test(sha) || trustedGit(options.repo, ["rev-parse", "--verify", `${sha}^{commit}`]).trim() !== sha) throw new Error("Use exact existing 40-character commit SHAs.");
    }
    const changes = trustedGit(options.repo, ["diff", "--name-status", "--no-renames", "-z", options.base, options.head]).split("\0");
    changes.pop();
    for (let i = 0; i < changes.length; i += 2) receipt.changedFiles.push({ status: changes[i], path: changes[i + 1] });
    const contractText = blob(options.repo, options.base, REGRESSION_FILE);
    receipt.contractSha256 = regressionHash(contractText);
    const contract = parseRegressionContract(contractText);
    receipt.requiredCases = contract.cases.length;
    if (blob(options.repo, options.head, REGRESSION_FILE) !== contractText) throw new Error("Protected expectations changed. Review the contract update separately; this run cannot approve its own new answers.");
    // Read both complete allowlists before executing anything. Working-tree
    // edits, submodules, symlinks and unlisted files never become inputs.
    const sources = contract.files.map(path => ({ path, base: blob(options.repo, options.base, path), head: blob(options.repo, options.head, path) }));
    receipt.files = sources.map(file => ({ path: file.path, baseSha256: regressionHash(file.base), headSha256: regressionHash(file.head) }));
    temporary = mkdtempSync(join(homedir(), ".agent-vigil-regression-"));
    chmodSync(temporary, 0o700);
    for (const side of ["base", "head"] as const) {
      const directory = join(temporary, side); mkdirSync(directory, { mode: 0o755 });
      for (const file of sources) { const destination = join(directory, file.path); mkdirSync(dirname(destination), { recursive: true, mode: 0o755 }); writeFileSync(destination, file[side], { flag: "wx", mode: 0o444 }); }
    }
    for (const item of contract.cases) {
      const twice = (side: "base" | "head") => {
        const observations = [observe(join(temporary!, side), item)];
        if (observations[0].state === "value") observations.push(observe(join(temporary!, side), item));
        return observations;
      };
      const baseline = twice("base");
      const baselineOk = baseline.length === 2 && baseline.every(o => o.state === "value" && isDeepStrictEqual(o.value, item.expect));
      const candidate = baselineOk ? twice("head") : [];
      receipt.rows.push(judgeRegressionCase(item, baseline, candidate));
      if ([...baseline, ...candidate].some(o => o.state === "unavailable")) break;
    }
    const gaps = receipt.rows.length !== contract.cases.length || receipt.rows.some(row => row.verdict === "NOT CHECKED");
    receipt.verdict = receipt.rows.some(row => row.verdict === "FAIL") ? "FAIL" : gaps ? "NOT CHECKED" : "PASS";
    receipt.reason = receipt.verdict === "FAIL" ? "A protected behavior changed. Fix the implementation or request a separate contract review." : receipt.verdict === "NOT CHECKED" ? "Not all protected cases produced dependable evidence. Inspect the case details." : "Every selected case matched its protected answer twice. Other behavior was not checked.";
  } catch (error) {
    // Git stderr can contain hostile repository text; do not echo it into a terminal.
    receipt.reason = error instanceof Error && !('stderr' in error) ? error.message : "Could not read exact Git inputs. Check commit availability and the tracked contract.";
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    receipt.machineMs = performance.now() - start;
  }
  return receipt;
}

export function regressionJson(value: unknown, pretty = false): string {
  return (JSON.stringify(value, null, pretty ? 2 : undefined) ?? "null").replace(/[\u007f-\u009f\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu,
    character => character.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

export function renderRegression(receipt: RegressionReceipt): string {
  const safe = regressionJson;
  const unavailable = (row: RegressionRow) => (["baseline", "candidate"] as const).flatMap(side =>
    [...new Set(row[side].flatMap(o => o.state === "unavailable" ? [o.reason] : []))].map(reason => `  ${side === "baseline" ? "Baseline" : "Candidate"}: ${terminalSafe(reason)}`));
  return [`Agent Vigil: ${receipt.verdict}`, receipt.verdict === "PASS" ? "Selected behaviors match; this does not authorize merging." : "Do not use this result as merge approval.", terminalSafe(receipt.reason),
    `Base: ${safe(receipt.base)}`, `Head: ${safe(receipt.head)}`,
    ...receipt.rows.flatMap(row => [`${row.verdict}  ${safe(row.id)} (${safe(row.module)})`, `  ${terminalSafe(row.reason)}`, ...unavailable(row), ...(row.verdict === "FAIL" ? [`  Expected: ${safe(row.expected)}`, `  Observed: ${safe(row.candidate.map(o => o.state === "value" ? o.value : null))}`] : [])]),
    `Cases checked: ${receipt.rows.filter(row => row.verdict !== "NOT CHECKED").length}/${receipt.requiredCases}`, "Use --json for exact file hashes, case observations and timings.",
    ...(receipt.reproduceCommand ? [`Reproduce with this same local CLI: ${terminalSafe(receipt.reproduceCommand)}`] : []),
  ].join("\n");
}
