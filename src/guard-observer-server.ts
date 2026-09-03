import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import {
  buildGuardControlObservation,
  canaryBody,
  classifyObserverRequest,
  issueGuardControlChallenge,
  type GuardControlPlan,
  type GuardObservedRequest,
} from "./guard-control-protocol.ts";
import { awsKmsEd25519GuardSigner, localGuardSigner, type GuardSigner } from "./guard-signing.ts";
import { writePrivateFileAtomic } from "./safe-output.ts";
import type { GuardHost } from "./guard-compat.ts";

const MAX_REQUEST_BYTES = 4 * 1024;

type Parsed = { values: Map<string, string>; flags: Set<string> };

function parse(args: string[]): Parsed {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (!name.startsWith("--")) throw new Error(`unexpected positional argument: ${name}`);
    if (name === "--help") { flags.add(name); continue; }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values.has(name)) throw new Error(`${name} was provided more than once`);
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

function usage(): string {
  return `Agent Vigil independent control observer

Usage:
  vigil guard-observer \\
    --host claude|codex \\
    --host-version <exact-version> \\
    --host-executable-sha256 <sha256:...> \\
    --managed-environment-sha256 <sha256:...> \\
    --runner-node <absolute-worker-node-path> \\
    (--challenge-key <ed25519-private.pem> | --challenge-kms-key <aws-kms-key-id>) \\
    (--observer-key <ed25519-private.pem> | --observer-kms-key <aws-kms-key-id>) \\
    --challenge-output <challenge.dsse.json> \\
    --observation-output <observation.dsse.json> \\
    [--listen 127.0.0.1] [--port 0] [--public-origin <https-origin>] \\
    [--duration-ms 120000] [--ready-output <ready.json>] [--aws-cli <absolute-path>] [--aws-region <region>]

The observer runs outside the candidate worker, issues a short-lived signed
challenge, records exact one-time network effects, and signs the observation.
Use two distinct keys. AWS KMS mode uses the AWS CLI credential chain, including
OIDC web identity, and never accepts an AWS secret as an argument. KMS mode also
requires --aws-cli to name an absolute executable selected before candidate code runs.`;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`guard-observer requires ${name} <value>`);
  return value;
}

function roleSigner(input: {
  values: Map<string, string>;
  localName: string;
  kmsName: string;
}): GuardSigner {
  const local = input.values.get(input.localName);
  const kms = input.values.get(input.kmsName);
  if (Boolean(local) === Boolean(kms)) {
    throw new Error(`provide exactly one of ${input.localName} or ${input.kmsName}`);
  }
  if (local) return localGuardSigner(resolve(local));
  return awsKmsEd25519GuardSigner({
    keyId: kms!,
    awsExecutable: required(input.values, "--aws-cli"),
    ...(input.values.get("--aws-region") ? { region: input.values.get("--aws-region")! } : {}),
  });
}

function digest(value: string, label: string): string {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 identifier`);
  return value;
}

function requestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error("canary request exceeded the body limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function respond(response: ServerResponse, status: number, body = ""): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function listen(server: ReturnType<typeof createServer>, host: string, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("observer did not receive a TCP address"));
      resolvePort(address.port);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

export async function runGuardObserverCommand(args: string[]): Promise<number> {
  try {
    const parsed = parse(args);
    if (parsed.flags.has("--help")) { console.log(usage()); return 0; }
    const allowed = new Set([
      "--host", "--host-version", "--host-executable-sha256", "--managed-environment-sha256",
      "--runner-node",
      "--challenge-key", "--challenge-kms-key", "--observer-key", "--observer-kms-key",
      "--challenge-output", "--observation-output", "--listen", "--port", "--public-origin",
      "--duration-ms", "--ready-output", "--aws-cli", "--aws-region",
    ]);
    for (const name of parsed.values.keys()) if (!allowed.has(name)) throw new Error(`unknown guard-observer option: ${name}`);
    const host = required(parsed.values, "--host") as GuardHost;
    if (host !== "claude" && host !== "codex") throw new Error("guard-observer --host must be claude or codex");
    const listenHost = parsed.values.get("--listen") ?? "127.0.0.1";
    if (isIP(listenHost) === 0 && listenHost !== "localhost") throw new Error("guard-observer --listen must be an IP address or localhost");
    const port = Number(parsed.values.get("--port") ?? "0");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("guard-observer port is invalid");
    const durationMs = Number(parsed.values.get("--duration-ms") ?? "120000");
    if (!Number.isInteger(durationMs) || durationMs < 100 || durationMs > 14 * 60 * 1000) {
      throw new Error("guard-observer duration must be 100 to 840000 milliseconds");
    }
    const challengeSigner = roleSigner({ values: parsed.values, localName: "--challenge-key", kmsName: "--challenge-kms-key" });
    const observerSigner = roleSigner({ values: parsed.values, localName: "--observer-key", kmsName: "--observer-kms-key" });
    if (challengeSigner.keyId === observerSigner.keyId) throw new Error("challenge and observer keys must be distinct");
    const challengeOutput = resolve(required(parsed.values, "--challenge-output"));
    const observationOutput = resolve(required(parsed.values, "--observation-output"));
    if (challengeOutput === observationOutput) throw new Error("challenge and observation outputs must be distinct");

    let plan: GuardControlPlan | undefined;
    let openedAt = "";
    const events: GuardObservedRequest[] = [];
    const server = createServer(async (request, response) => {
      let path = "/";
      let recorded = false;
      try {
        path = new URL(request.url ?? "/", "http://observer.invalid").pathname;
        if (request.method === "GET" && path === "/healthz") { respond(response, 200, "ok\n"); return; }
        if (!plan) { respond(response, 503, "observer not ready\n"); return; }
        const body = await requestBody(request);
        const event = classifyObserverRequest({ plan, path, method: request.method ?? "UNKNOWN", body });
        if (events.length < 8) events.push(event);
        recorded = true;
        const accepted = event.route !== "UNEXPECTED" && event.method === "POST" && body.equals(Buffer.from(canaryBody(), "utf8"));
        respond(response, accepted ? 204 : 400, accepted ? "" : "invalid canary\n");
      } catch {
        if (plan && !recorded) {
          if (events.length < 8) events.push(classifyObserverRequest({ plan, path, method: request.method ?? "UNKNOWN", body: Buffer.alloc(0) }));
        }
        if (!response.destroyed && !response.headersSent) respond(response, 400, "invalid canary\n");
      }
    });
    const actualPort = await listen(server, listenHost, port);
    openedAt = new Date().toISOString();
    const localOriginHost = listenHost.includes(":") ? `[${listenHost}]` : listenHost;
    const origin = parsed.values.get("--public-origin") ?? `http://${localOriginHost}:${actualPort}`;
    const expiresAt = new Date(Date.parse(openedAt) + durationMs + 1_000).toISOString();
    const issued = issueGuardControlChallenge({
      origin,
      host,
      version: required(parsed.values, "--host-version"),
      executableSha256: digest(required(parsed.values, "--host-executable-sha256"), "host executable digest"),
      managedEnvironmentSha256: digest(required(parsed.values, "--managed-environment-sha256"), "managed environment digest"),
      nodeExecutable: required(parsed.values, "--runner-node"),
      signer: challengeSigner,
      issuedAt: openedAt,
      expiresAt,
    });
    plan = issued.plan;
    writePrivateFileAtomic(challengeOutput, `${JSON.stringify(issued.envelope, null, 2)}\n`);
    if (parsed.values.get("--ready-output")) {
      writePrivateFileAtomic(resolve(parsed.values.get("--ready-output")!), `${JSON.stringify({
        origin: issued.challenge.observer.origin,
        challengeHash: issued.challenge.challengeHash,
        challengeSignerKeyId: challengeSigner.keyId,
        observerSignerKeyId: observerSigner.keyId,
      }, null, 2)}\n`);
    }
    console.log(`Agent Vigil observer ready: ${issued.challenge.challengeHash}`);
    await new Promise((resolveTimer) => setTimeout(resolveTimer, durationMs));
    await close(server);
    const closedAt = new Date().toISOString();
    const observed = buildGuardControlObservation({
      challenge: issued.challenge,
      events,
      openedAt,
      closedAt,
      signer: observerSigner,
    });
    writePrivateFileAtomic(observationOutput, `${JSON.stringify(observed.envelope, null, 2)}\n`);
    console.log(`Agent Vigil observer ${observed.observation.status}: ${observed.observation.observationHash}`);
    return observed.observation.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(`agent-vigil: ${(error as Error).message}\n\n${usage()}`);
    return 2;
  }
}
