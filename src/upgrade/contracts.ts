import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep, win32 } from "node:path";
import { TextDecoder } from "node:util";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

export const UPGRADE_CONFIG_SCHEMA = "agent-vigil-upgrade-config/v1" as const;
export const CANARY_SCHEMA = "agent-vigil-upgrade-canary/v1" as const;
export const PRIVATE_RECEIPT_SCHEMA = "agent-vigil-upgrade-receipt/v1" as const;
export const PUBLIC_ENTRY_SCHEMA = "agent-vigil-compatibility-entry/v1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type UpgradeVerdict = "SAFE" | "CHANGED" | "HOLD";

export type UpgradeComponentConfig = {
  ecosystem: string;
  name: string;
  manifestPath: string;
  identityField: string;
  versionField: string;
  capabilityFields: string[];
};

export type UpgradeRunnerConfig = {
  engine: "docker";
  image: string;
  trials: number;
  memoryMiB: number;
  cpus: number;
  pids: number;
};

export type UpgradeCanaryConfig = {
  id: string;
  publicId?: string;
  command: string[];
  timeoutSeconds: number;
};

export type UpgradeConfig = {
  schemaVersion: typeof UPGRADE_CONFIG_SCHEMA;
  component: UpgradeComponentConfig;
  runner: UpgradeRunnerConfig;
  canaryDirectory: string;
  canaries: UpgradeCanaryConfig[];
};

export type CanaryDocument = {
  schemaVersion: typeof CANARY_SCHEMA;
  outcome: "PASS" | "FAIL";
  observations: Record<string, JsonPrimitive>;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} contains unknown field(s): ${unknown.join(", ")}`);
}

function boundedString(value: unknown, label: string, maximum: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  if (pattern && !pattern.test(value)) throw new Error(`${label} has an unsupported value`);
  return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function numberValue(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a finite number from ${minimum} to ${maximum}`);
  }
  return value;
}

export function safeRelativePath(value: unknown, label: string): string {
  const path = boundedString(value, label, 512);
  if (isAbsolute(path) || win32.isAbsolute(path) || path.includes("\\")) {
    throw new Error(`${label} must be a portable repository-relative path`);
  }
  const normalized = normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new Error(`${label} must remain inside the selected repository`);
  }
  return path.split("/").join(sep);
}

function fieldPath(value: unknown, label: string): string {
  return boundedString(value, label, 128, /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/);
}

function imageDigest(value: unknown): string {
  return boundedString(
    value,
    "runner.image",
    320,
    /^[A-Za-z0-9][A-Za-z0-9._/:~-]{0,246}@sha256:[0-9a-f]{64}$/,
  );
}

export function validateUpgradeConfig(input: unknown): UpgradeConfig {
  const root = object(input, "upgrade config");
  exactKeys(root, ["schemaVersion", "component", "runner", "canaryDirectory", "canaries"], "upgrade config");
  if (root.schemaVersion !== UPGRADE_CONFIG_SCHEMA) {
    throw new Error(`upgrade config schemaVersion must be ${UPGRADE_CONFIG_SCHEMA}`);
  }

  const component = object(root.component, "component");
  exactKeys(component, ["ecosystem", "name", "manifestPath", "identityField", "versionField", "capabilityFields"], "component");
  const capabilityFields = component.capabilityFields;
  if (!Array.isArray(capabilityFields) || capabilityFields.length > 32) {
    throw new Error("component.capabilityFields must be an array of at most 32 field paths");
  }
  const parsedCapabilities = capabilityFields.map((item, index) => fieldPath(item, `component.capabilityFields[${index}]`));
  if (new Set(parsedCapabilities).size !== parsedCapabilities.length) {
    throw new Error("component.capabilityFields must not contain duplicates");
  }

  const runner = object(root.runner, "runner");
  exactKeys(runner, ["engine", "image", "trials", "memoryMiB", "cpus", "pids"], "runner");
  if (runner.engine !== "docker") throw new Error("runner.engine must be docker");

  if (!Array.isArray(root.canaries) || root.canaries.length < 1 || root.canaries.length > 32) {
    throw new Error("canaries must contain from 1 to 32 entries");
  }
  const canaries = root.canaries.map((item, index): UpgradeCanaryConfig => {
    const canary = object(item, `canaries[${index}]`);
    exactKeys(canary, ["id", "publicId", "command", "timeoutSeconds"], `canaries[${index}]`);
    const id = boundedString(canary.id, `canaries[${index}].id`, 80, /^[a-z0-9][a-z0-9._-]*$/);
    const publicId = canary.publicId === undefined
      ? undefined
      : boundedString(canary.publicId, `canaries[${index}].publicId`, 80, /^[a-z0-9][a-z0-9._-]*$/);
    if (!Array.isArray(canary.command) || canary.command.length < 1 || canary.command.length > 32) {
      throw new Error(`canaries[${index}].command must contain from 1 to 32 argv strings`);
    }
    const command = canary.command.map((value, argumentIndex) => boundedString(value, `canaries[${index}].command[${argumentIndex}]`, 512));
    return {
      id,
      ...(publicId ? { publicId } : {}),
      command,
      timeoutSeconds: integer(canary.timeoutSeconds, `canaries[${index}].timeoutSeconds`, 1, 300),
    };
  });
  if (new Set(canaries.map((canary) => canary.id)).size !== canaries.length) {
    throw new Error("canary IDs must be unique");
  }
  const publicIds = canaries.flatMap((canary) => canary.publicId ? [canary.publicId] : []);
  if (new Set(publicIds).size !== publicIds.length) throw new Error("canary public IDs must be unique");

  return {
    schemaVersion: UPGRADE_CONFIG_SCHEMA,
    component: {
      ecosystem: boundedString(component.ecosystem, "component.ecosystem", 80, /^[a-z0-9][a-z0-9._-]*$/),
      name: boundedString(component.name, "component.name", 160, /^[A-Za-z0-9@][A-Za-z0-9@/._-]*$/),
      manifestPath: safeRelativePath(component.manifestPath, "component.manifestPath"),
      identityField: fieldPath(component.identityField, "component.identityField"),
      versionField: fieldPath(component.versionField, "component.versionField"),
      capabilityFields: parsedCapabilities,
    },
    runner: {
      engine: "docker",
      image: imageDigest(runner.image),
      trials: integer(runner.trials, "runner.trials", 2, 5),
      memoryMiB: integer(runner.memoryMiB, "runner.memoryMiB", 128, 4096),
      cpus: numberValue(runner.cpus, "runner.cpus", 0.25, 4),
      pids: integer(runner.pids, "runner.pids", 16, 512),
    },
    canaryDirectory: safeRelativePath(root.canaryDirectory, "canaryDirectory"),
    canaries,
  };
}

export function readBoundedJson(path: string, maximumBytes: number, label: string): unknown {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
  if (status.size > maximumBytes) throw new Error(`${label} is ${status.size} bytes; maximum is ${maximumBytes}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function trustedRegularFileInside(repositoryPath: string, filePath: string, label: string): string {
  const requestedRepository = resolve(repositoryPath);
  const repositoryStatus = lstatSync(requestedRepository);
  if (repositoryStatus.isSymbolicLink() || !repositoryStatus.isDirectory()) {
    throw new Error("repository must be a regular directory, not a symbolic link");
  }
  const repository = realpathSync(requestedRepository);
  const requested = resolve(filePath);
  const rel = relative(requestedRepository, requested);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`${label} must remain inside the repository`);

  let current = requestedRepository;
  const parentRel = relative(requestedRepository, dirname(requested));
  for (const component of parentRel.split(sep).filter(Boolean)) {
    current = join(current, component);
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${label} and its parents must be regular entries without symbolic links`);
    }
  }
  const status = lstatSync(requested);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`${label} must be a regular non-symbolic-link file`);
  }
  const canonical = realpathSync(requested);
  const canonicalRel = relative(repository, canonical);
  if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`)) {
    throw new Error(`${label} resolved outside the repository`);
  }
  return canonical;
}

export function trustedDirectoryInside(repositoryPath: string, directoryPath: string, label: string): string {
  const requestedRepository = resolve(repositoryPath);
  const repositoryStatus = lstatSync(requestedRepository);
  if (repositoryStatus.isSymbolicLink() || !repositoryStatus.isDirectory()) {
    throw new Error("repository must be a regular directory, not a symbolic link");
  }
  const repository = realpathSync(requestedRepository);
  const requested = resolve(directoryPath);
  const rel = relative(requestedRepository, requested);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`${label} must remain inside the repository`);
  let current = requestedRepository;
  for (const component of rel.split(sep).filter(Boolean)) {
    current = join(current, component);
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`${label} and its parents must be regular directories without symbolic links`);
    }
  }
  const canonical = realpathSync(requested);
  const canonicalRel = relative(repository, canonical);
  if (canonicalRel === ".." || canonicalRel.startsWith(`..${sep}`)) {
    throw new Error(`${label} resolved outside the repository`);
  }
  return canonical;
}

export function loadUpgradeConfig(path: string): UpgradeConfig {
  return validateUpgradeConfig(readBoundedJson(path, 256 * 1024, "upgrade config"));
}

export function parseExactJson(
  bytes: Buffer,
  label: string,
  maximumNodes = 100_000,
  maximumDepth = 64,
): unknown {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
  try { JSON.parse(source); }
  catch { throw new Error(`${label} is not valid JSON`); }
  const document = parseDocument(source, { schema: "json", uniqueKeys: true });
  if (document.errors.length || document.contents === null) throw new Error(`${label} is invalid JSON`);
  let nodes = 0;
  const inspect = (node: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maximumNodes || depth > maximumDepth) throw new Error(`${label} exceeds structural bounds`);
    if (isScalar(node)) {
      if (typeof node.value === "number") {
        const lexical = node.source;
        if (typeof lexical !== "string" || !/^-?(?:0|[1-9][0-9]*)$/.test(lexical)
          || lexical === "-0" || !Number.isSafeInteger(Number(lexical))) {
          throw new Error(`${label} numbers must be exact safe integers`);
        }
      }
      return;
    }
    if (isSeq(node)) {
      for (const item of node.items) inspect(item, depth + 1);
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        inspect(pair.key, depth + 1);
        inspect(pair.value, depth + 1);
      }
      return;
    }
    throw new Error(`${label} contains an unsupported JSON node`);
  };
  inspect(document.contents, 0);
  return document.toJS({ maxAliasCount: 0 });
}

export function validateCanaryDocument(input: unknown): CanaryDocument {
  const root = object(input, "canary output");
  exactKeys(root, ["schemaVersion", "outcome", "observations"], "canary output");
  if (root.schemaVersion !== CANARY_SCHEMA) throw new Error(`canary output schemaVersion must be ${CANARY_SCHEMA}`);
  if (root.outcome !== "PASS" && root.outcome !== "FAIL") throw new Error("canary output outcome must be PASS or FAIL");
  const observations = object(root.observations, "canary observations");
  if (Object.keys(observations).length < 1) throw new Error("canary observations must contain at least one field");
  if (Object.keys(observations).length > 64) throw new Error("canary observations contain more than 64 fields");
  const parsed: Record<string, JsonPrimitive> = {};
  for (const [key, value] of Object.entries(observations)) {
    boundedString(key, "canary observation key", 80, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    if (value === null || typeof value === "boolean") parsed[key] = value;
    else if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) parsed[key] = value;
    else if (typeof value === "string" && value.length <= 512 && !value.includes("\0")) parsed[key] = value;
    else throw new Error(`canary observation ${key} must be a bounded JSON primitive`);
  }
  return { schemaVersion: CANARY_SCHEMA, outcome: root.outcome, observations: parsed };
}

export function parseCanaryDocument(bytes: Buffer): CanaryDocument {
  return validateCanaryDocument(parseExactJson(bytes, "canary output", 256, 8));
}
