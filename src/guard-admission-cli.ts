import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { readBoundedJson, readBoundedRegularFile } from "./continuity/contracts.ts";
import { buildGuardControlAdmission } from "./guard-admission.ts";
import { gateGuardControlAdmission } from "./guard-control-protocol.ts";
import {
  buildGuardDeploymentAuthorization,
  buildGuardDeploymentRegistration,
  gateGuardDeploymentAuthorization,
} from "./guard-deployment-authorization.ts";
import { hashGuardFile } from "./guard-compat.ts";
import { loadGuardRouteEnvelope } from "./guard-route-seal.ts";
import { awsKmsEd25519GuardSigner, localGuardSigner, type GuardSigner } from "./guard-signing.ts";
import { writePrivateFileAtomic } from "./safe-output.ts";

const MAX_JSON = 2 * 1024 * 1024;
const MAX_KEY = 64 * 1024;
const MAX_RESPONSE = 64 * 1024;
const REGISTRATION_CONTEXT = "agent-vigil-deployment-registration/v1\0";

type Parsed = { values: Map<string, string>; help: boolean };

function parse(args: string[], allowed: Set<string>): Parsed {
  const values = new Map<string, string>();
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name === "--help") { help = true; continue; }
    if (!allowed.has(name)) throw new Error(`unknown option: ${name}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was provided more than once`);
    values.set(name, value);
    index += 1;
  }
  return { values, help };
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`requires ${name} <value>`);
  return value;
}

function key(values: Map<string, string>, name: string, label: string): Buffer {
  return readBoundedRegularFile(resolve(required(values, name)), MAX_KEY, label);
}

function admissionSigner(values: Map<string, string>): GuardSigner {
  const local = values.get("--admission-key");
  const kms = values.get("--admission-kms-key");
  if (Boolean(local) === Boolean(kms)) throw new Error("provide exactly one of --admission-key or --admission-kms-key");
  if (local) return localGuardSigner(resolve(local));
  return awsKmsEd25519GuardSigner({
    keyId: kms!,
    awsExecutable: required(values, "--aws-cli"),
    ...(values.get("--aws-region") ? { region: values.get("--aws-region")! } : {}),
  });
}

function deploymentSigner(values: Map<string, string>): GuardSigner {
  const local = values.get("--deployment-key");
  const kms = values.get("--deployment-kms-key");
  if (Boolean(local) === Boolean(kms)) throw new Error("provide exactly one of --deployment-key or --deployment-kms-key");
  if (local) return localGuardSigner(resolve(local));
  return awsKmsEd25519GuardSigner({
    keyId: kms!,
    awsExecutable: required(values, "--aws-cli"),
    ...(values.get("--aws-region") ? { region: values.get("--aws-region")! } : {}),
  });
}

function usage(): string {
  return `Agent Vigil independent control admission

Create a signed package/deployment decision:
  vigil guard-admit \\
    --current-route <route.dsse.json> --current-challenge <challenge.dsse.json> --current-observation <observation.dsse.json> --current-isolation <isolation.dsse.json> \\
    --candidate-route <route.dsse.json> --candidate-challenge <challenge.dsse.json> --candidate-observation <observation.dsse.json> --candidate-isolation <isolation.dsse.json> \\
    --environment-public-key <environment.pem> --route-public-key <route.pem> \\
    --challenge-public-key <challenge.pem> --observer-public-key <observer.pem> --isolation-public-key <isolation.pem> \\
    (--admission-key <private.pem> | --admission-kms-key <aws-kms-key-id>) \\
    --output <admission.dsse.json> [--evaluated-at <RFC3339>] [--valid-until <RFC3339>] [--aws-cli <absolute-path>] [--aws-region <region>]

Enforce the signed decision against exact bytes and environment:
  vigil guard-deploy-gate --admission <admission.dsse.json> --admission-public-key <admission.pem> \\
    --artifact <package-or-installer> --environment-sha256 <sha256:...> \\
    [--host claude|codex] [--version <exact-version>] [--as-of <RFC3339>]

Bind an approved control admission to one GitHub deployment:
  vigil guard-deploy-authorize --admission <admission.dsse.json> --admission-public-key <admission.pem> \\
    --repository <owner/name> --commit-sha <40-hex> --environment <name> \\
    (--deployment-key <private.pem> | --deployment-kms-key <aws-kms-key-id>) \\
    --output <authorization.dsse.json> [--issued-at <RFC3339>] [--valid-until <RFC3339>] \\
    [--aws-cli <absolute-path>] [--aws-region <region>]

Recheck both signatures, the GitHub identity, and the actual artifact bytes inside the deployment job:
  vigil guard-deploy-bound-gate --authorization <authorization.dsse.json> --deployment-public-key <deployment.pem> \\
    --admission <admission.dsse.json> --admission-public-key <admission.pem> --repository <owner/name> \\
    --commit-sha <40-hex> --environment <name> --artifact <package-or-installer> \\
    --environment-sha256 <sha256:...> [--as-of <RFC3339>]

Register the paired authorization and admission with the hosted App:
  AGENT_VIGIL_REGISTRATION_SECRET=<secret> vigil guard-deploy-register \\
    --authorization <authorization.dsse.json> --deployment-public-key <deployment.pem> \\
    --admission <admission.dsse.json> --admission-public-key <admission.pem> \\
    --url <https://app.example/deployment/authorizations> [--as-of <RFC3339>]

The gate exits zero only for a valid, unexpired APPROVE envelope bound to the
exact artifact bytes and environment digest. Missing, HOLD, forged, expired,
or mismatched evidence exits nonzero. KMS signing requires an absolute AWS CLI
path selected in the trusted job before candidate code runs.`;
}

function registrationUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== "/deployment/authorizations") {
    throw new Error("registration URL must be an HTTPS origin plus /deployment/authorizations");
  }
  return url.toString();
}

async function boundedResponse(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_RESPONSE)) {
    throw new Error("registration response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE) {
        await reader.cancel("registration response exceeded limit");
        throw new Error("registration response is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function runGuardDeployRegisterCommand(args: string[]): Promise<number> {
  try {
    const parsed = parse(args, new Set([
      "--authorization", "--deployment-public-key", "--admission", "--admission-public-key", "--url", "--as-of",
    ]));
    if (parsed.help) { console.log(usage()); return 0; }
    const values = parsed.values;
    const built = buildGuardDeploymentRegistration({
      authorizationEnvelope: readBoundedJson(resolve(required(values, "--authorization")), MAX_JSON, "deployment authorization"),
      deploymentPublicKey: key(values, "--deployment-public-key", "deployment public key"),
      admissionEnvelope: readBoundedJson(resolve(required(values, "--admission")), MAX_JSON, "control admission"),
      admissionPublicKey: key(values, "--admission-public-key", "admission public key"),
      ...(values.get("--as-of") ? { asOf: values.get("--as-of")! } : {}),
    });
    const secret = process.env.AGENT_VIGIL_REGISTRATION_SECRET;
    if (!secret || secret.length < 32) throw new Error("AGENT_VIGIL_REGISTRATION_SECRET must contain at least 32 characters");
    const body = Buffer.from(JSON.stringify(built.registration), "utf8");
    const signature = `sha256=${createHmac("sha256", secret).update(REGISTRATION_CONTEXT).update(body).digest("hex")}`;
    const response = await fetch(registrationUrl(required(values, "--url")), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-agent-vigil-registration-signature": signature,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const responseBody = await boundedResponse(response);
    let result: unknown;
    try { result = JSON.parse(responseBody); }
    catch { throw new Error(`registration service returned HTTP ${response.status} with invalid JSON`); }
    if (!response.ok || !result || typeof result !== "object" || Array.isArray(result)
      || (result as Record<string, unknown>).status !== "registered"
      || (result as Record<string, unknown>).authorization_hash !== built.authorization.authorizationHash) {
      throw new Error(`registration service rejected the authorization (HTTP ${response.status})`);
    }
    console.log("Agent Vigil deployment registration: REGISTERED");
    console.log(`Authorization: ${built.authorization.authorizationHash}`);
    return 0;
  } catch (error) {
    console.error(`Agent Vigil deployment registration: HOLD\nReason: ${(error as Error).message}`);
    return 1;
  }
}

export function runGuardDeployAuthorizeCommand(args: string[]): number {
  try {
    const parsed = parse(args, new Set([
      "--admission", "--admission-public-key", "--repository", "--commit-sha", "--environment",
      "--deployment-key", "--deployment-kms-key", "--output", "--issued-at", "--valid-until",
      "--aws-cli", "--aws-region",
    ]));
    if (parsed.help) { console.log(usage()); return 0; }
    const values = parsed.values;
    const output = resolve(required(values, "--output"));
    const inputs = ["--admission", "--admission-public-key", ...(values.get("--deployment-key") ? ["--deployment-key"] : [])]
      .map((name) => resolve(required(values, name)));
    if (inputs.includes(output)) throw new Error("deployment authorization output must be distinct from every input and key");
    const result = buildGuardDeploymentAuthorization({
      admissionEnvelope: readBoundedJson(resolve(required(values, "--admission")), MAX_JSON, "control admission"),
      admissionPublicKey: key(values, "--admission-public-key", "admission public key"),
      repository: required(values, "--repository"),
      commitSha: required(values, "--commit-sha"),
      environment: required(values, "--environment"),
      deploymentSigner: deploymentSigner(values),
      ...(values.get("--issued-at") ? { issuedAt: values.get("--issued-at")! } : {}),
      ...(values.get("--valid-until") ? { validUntil: values.get("--valid-until")! } : {}),
    });
    writePrivateFileAtomic(output, `${JSON.stringify(result.envelope, null, 2)}\n`);
    console.log("Agent Vigil deployment authorization: APPROVE");
    console.log(`Repository: ${result.authorization.repository}`);
    console.log(`Commit: ${result.authorization.commitSha}`);
    console.log(`Environment: ${result.authorization.environment}`);
    console.log(`Authorization: ${result.authorization.authorizationHash}`);
    console.log(`Written: ${output}`);
    return 0;
  } catch (error) {
    console.error(`Agent Vigil deployment authorization: HOLD\nReason: ${(error as Error).message}`);
    return 1;
  }
}

export function runGuardDeployBoundGateCommand(args: string[]): number {
  try {
    const parsed = parse(args, new Set([
      "--authorization", "--deployment-public-key", "--admission", "--admission-public-key",
      "--repository", "--commit-sha", "--environment", "--artifact", "--environment-sha256", "--as-of",
    ]));
    if (parsed.help) { console.log(usage()); return 0; }
    const values = parsed.values;
    const artifact = hashGuardFile(resolve(required(values, "--artifact")), "deployment artifact");
    const result = gateGuardDeploymentAuthorization({
      authorizationEnvelope: readBoundedJson(resolve(required(values, "--authorization")), MAX_JSON, "deployment authorization"),
      deploymentPublicKey: key(values, "--deployment-public-key", "deployment public key"),
      admissionEnvelope: readBoundedJson(resolve(required(values, "--admission")), MAX_JSON, "control admission"),
      admissionPublicKey: key(values, "--admission-public-key", "admission public key"),
      repository: required(values, "--repository"),
      commitSha: required(values, "--commit-sha"),
      environment: required(values, "--environment"),
      expectedArtifactSha256: artifact.sha256,
      expectedManagedEnvironmentSha256: required(values, "--environment-sha256"),
      ...(values.get("--as-of") ? { asOf: values.get("--as-of")! } : {}),
    });
    console.log("Agent Vigil bound deployment gate: APPROVE");
    console.log(`Authorization: ${result.authorizationHash}`);
    console.log(`Artifact: ${artifact.sha256}`);
    return 0;
  } catch (error) {
    console.error(`Agent Vigil bound deployment gate: HOLD\nReason: ${(error as Error).message}`);
    return 1;
  }
}

export function runGuardAdmissionCommand(args: string[]): number {
  try {
    const allowed = new Set([
      "--current-route", "--current-challenge", "--current-observation", "--current-isolation",
      "--candidate-route", "--candidate-challenge", "--candidate-observation", "--candidate-isolation",
      "--environment-public-key", "--route-public-key", "--challenge-public-key", "--observer-public-key", "--isolation-public-key",
      "--admission-key", "--admission-kms-key", "--output", "--evaluated-at", "--valid-until",
      "--aws-cli", "--aws-region",
    ]);
    const parsed = parse(args, allowed);
    if (parsed.help) { console.log(usage()); return 0; }
    const values = parsed.values;
    const output = resolve(required(values, "--output"));
    const inputPaths = [
      "--current-route", "--current-challenge", "--current-observation", "--current-isolation",
      "--candidate-route", "--candidate-challenge", "--candidate-observation", "--candidate-isolation",
      "--environment-public-key", "--route-public-key", "--challenge-public-key", "--observer-public-key", "--isolation-public-key",
      ...(values.get("--admission-key") ? ["--admission-key"] : []),
    ].map((name) => resolve(required(values, name)));
    if (inputPaths.includes(output)) throw new Error("admission output must be distinct from every input and key");
    const bundle = (prefix: "current" | "candidate") => ({
      route: loadGuardRouteEnvelope(resolve(required(values, `--${prefix}-route`))),
      challenge: readBoundedJson(resolve(required(values, `--${prefix}-challenge`)), MAX_JSON, `${prefix} challenge`),
      observation: readBoundedJson(resolve(required(values, `--${prefix}-observation`)), MAX_JSON, `${prefix} observation`),
      isolation: readBoundedJson(resolve(required(values, `--${prefix}-isolation`)), MAX_JSON, `${prefix} isolation attestation`),
    });
    const result = buildGuardControlAdmission({
      current: bundle("current"),
      candidate: bundle("candidate"),
      environmentPublicKey: key(values, "--environment-public-key", "environment public key"),
      routePublicKey: key(values, "--route-public-key", "route public key"),
      challengePublicKey: key(values, "--challenge-public-key", "challenge public key"),
      observerPublicKey: key(values, "--observer-public-key", "observer public key"),
      isolationPublicKey: key(values, "--isolation-public-key", "isolation public key"),
      admissionSigner: admissionSigner(values),
      ...(values.get("--evaluated-at") ? { evaluatedAt: values.get("--evaluated-at")! } : {}),
      ...(values.get("--valid-until") ? { validUntil: values.get("--valid-until")! } : {}),
    });
    writePrivateFileAtomic(output, `${JSON.stringify(result.envelope, null, 2)}\n`);
    console.log(`Agent Vigil control admission: ${result.admission.decision}`);
    console.log(`Artifact: ${result.admission.artifact.host} ${result.admission.artifact.version} ${result.admission.artifact.executableSha256}`);
    console.log(`Reason: ${result.admission.reasonCodes.join(", ")}`);
    console.log(`Admission: ${result.admission.admissionHash}`);
    console.log(`Written: ${output}`);
    return result.admission.decision === "APPROVE" ? 0 : 1;
  } catch (error) {
    console.error(`agent-vigil: ${(error as Error).message}\n\n${usage()}`);
    return 2;
  }
}

export function runGuardDeployGateCommand(args: string[]): number {
  try {
    const parsed = parse(args, new Set([
      "--admission", "--admission-public-key", "--artifact", "--environment-sha256", "--host", "--version", "--as-of",
    ]));
    if (parsed.help) { console.log(usage()); return 0; }
    const values = parsed.values;
    const artifactPath = resolve(required(values, "--artifact"));
    const artifact = hashGuardFile(artifactPath, "deployment artifact");
    const result = gateGuardControlAdmission({
      envelope: readBoundedJson(resolve(required(values, "--admission")), MAX_JSON, "control admission"),
      publicKey: key(values, "--admission-public-key", "admission public key"),
      expectedArtifactSha256: artifact.sha256,
      expectedEnvironmentSha256: required(values, "--environment-sha256"),
      ...(values.get("--as-of") ? { asOf: values.get("--as-of")! } : {}),
    });
    if (values.get("--host") && result.artifact.host !== values.get("--host")) throw new Error("control admission is for a different host");
    if (values.get("--version") && result.artifact.version !== values.get("--version")) throw new Error("control admission is for a different version");
    console.log(`Agent Vigil deployment gate: APPROVE`);
    console.log(`Artifact: ${artifact.sha256}`);
    console.log(`Admission: ${result.admissionHash}`);
    return 0;
  } catch (error) {
    console.error(`Agent Vigil deployment gate: HOLD\nReason: ${(error as Error).message}`);
    return 1;
  }
}
