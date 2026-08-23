import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const targetRoot = realpathSync(process.env.VIGIL_TARGET || "/target");
const specId = process.argv[2];

if (!specId || !/^[a-z0-9][a-z0-9-]*$/.test(specId)) {
  throw new Error("a bounded corpus spec ID is required");
}

const specRoot = realpathSync(resolve("/canaries/specs"));
const specPath = resolve(specRoot, `${specId}.json`);
const specRelative = relative(specRoot, specPath);
if (specRelative === ".." || specRelative.startsWith(`..${sep}`)) {
  throw new Error("spec escaped the trusted canary directory");
}

const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (spec.schemaVersion !== "agent-vigil-corpus-check/v1" || !Array.isArray(spec.checks)) {
  throw new Error("unsupported corpus check specification");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function safeTargetPath(relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")) {
    throw new Error("check path must be a portable relative path");
  }
  const candidate = resolve(targetRoot, relativePath);
  const rel = relative(targetRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("check path escaped target");
  return candidate;
}

function readRegularText(relativePath) {
  const candidate = safeTargetPath(relativePath);
  const status = lstatSync(candidate);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`check path is not a regular file: ${relativePath}`);
  if (status.size > 4 * 1024 * 1024) throw new Error(`check text file exceeds 4 MiB: ${relativePath}`);
  const parent = realpathSync(dirname(candidate));
  if (parent !== targetRoot && !parent.startsWith(`${targetRoot}${sep}`)) throw new Error("check parent escaped target");
  return readFileSync(candidate, "utf8");
}

function lookup(value, field) {
  for (const segment of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function visitTextFiles(root = targetRoot) {
  const paths = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const candidate = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...visitTextFiles(candidate));
    else if (entry.isFile() && /\.(?:c?js|mjs|json|md|d\.ts)$/.test(entry.name)) paths.push(candidate);
  }
  return paths;
}

function anyTextContains(needle) {
  return visitTextFiles().some((candidate) => {
    const status = lstatSync(candidate);
    return status.size <= 4 * 1024 * 1024 && readFileSync(candidate, "utf8").includes(needle);
  });
}

function checkValue(check) {
  if (!check || typeof check !== "object" || Array.isArray(check)) throw new Error("check must be an object");
  if (check.kind === "exists") {
    const candidate = safeTargetPath(check.path);
    if (!existsSync(candidate)) return false;
    const status = lstatSync(candidate);
    return !status.isSymbolicLink() && status.isFile();
  }
  if (check.kind === "contains") return readRegularText(check.path).includes(check.needle);
  if (check.kind === "count") return readRegularText(check.path).split(check.needle).length - 1;
  if (check.kind === "anyContains") return anyTextContains(check.needle);
  if (check.kind === "jsonFieldHash") {
    const document = JSON.parse(readRegularText(check.path));
    return digest(canonical({ present: lookup(document, check.field) !== undefined, value: lookup(document, check.field) ?? null }));
  }
  throw new Error(`unsupported corpus check kind: ${check.kind}`);
}

const observations = {};
for (const check of spec.checks) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(check.key || "")) throw new Error("invalid observation key");
  observations[check.key] = checkValue(check);
}

process.stdout.write(JSON.stringify({
  schemaVersion: "agent-vigil-upgrade-canary/v1",
  outcome: "PASS",
  observations,
}));
