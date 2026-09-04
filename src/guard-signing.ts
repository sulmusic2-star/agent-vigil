import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify,
  type KeyObject,
} from "node:crypto";
import { accessSync, constants, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readBoundedRegularFile } from "./continuity/contracts.ts";
import { assertGuardFileUnchanged, hashGuardFile, type FileIdentity } from "./guard-compat.ts";
import { publicKeyDer, signingKeyId } from "./signature.ts";

const MAX_KEY_BYTES = 64 * 1024;
const MAX_AWS_OUTPUT_BYTES = 256 * 1024;
const MAX_AWS_ED25519_RAW_BYTES = 4096;

const AWS_ENVIRONMENT_ALLOWLIST = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_STS_REGIONAL_ENDPOINTS",
  "SystemRoot",
  "WINDIR",
] as const;

export type GuardSigner = {
  provider: "local-ed25519" | "aws-kms-ed25519";
  keyId: string;
  publicKey: KeyObject;
  sign: (message: Buffer) => Buffer;
};

export function localGuardSigner(privateKeyPath: string): GuardSigner {
  const privateKey = createPrivateKey(readBoundedRegularFile(
    resolve(privateKeyPath),
    MAX_KEY_BYTES,
    "guard signing key",
  ));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("guard signing key must be Ed25519");
  const publicKey = createPublicKey(privateKey);
  return {
    provider: "local-ed25519",
    keyId: signingKeyId(publicKeyDer(publicKey)),
    publicKey,
    sign: (message) => nodeSign(null, message, privateKey),
  };
}

function awsEnvironment(): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = { AWS_EC2_METADATA_DISABLED: "true" };
  for (const name of AWS_ENVIRONMENT_ALLOWLIST) {
    if (process.env[name] !== undefined) selected[name] = process.env[name];
  }
  return selected;
}

function pinnedAwsExecutable(value: string): FileIdentity {
  if (!isAbsolute(value) || resolve(value) !== value) {
    throw new Error("AWS CLI executable must be an absolute normalized path");
  }
  const linked = lstatSync(value);
  if (linked.isSymbolicLink() || !linked.isFile()) {
    throw new Error("AWS CLI executable must be a regular non-symbolic-link file");
  }
  accessSync(value, constants.X_OK);
  return hashGuardFile(value, "AWS CLI executable");
}

function awsJson(awsExecutable: FileIdentity, args: string[]): Record<string, unknown> {
  assertGuardFileUnchanged(awsExecutable, "AWS CLI executable");
  const completed = spawnSync(awsExecutable.realPath, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: MAX_AWS_OUTPUT_BYTES,
    env: awsEnvironment(),
    windowsHide: true,
  });
  assertGuardFileUnchanged(awsExecutable, "AWS CLI executable");
  if (completed.error) throw new Error(`AWS KMS signer could not start: ${completed.error.message}`);
  if (completed.status !== 0) {
    const detail = (completed.stderr || completed.stdout || "unknown AWS CLI error").trim().slice(0, 500);
    throw new Error(`AWS KMS signer failed: ${detail}`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(completed.stdout); }
  catch { throw new Error("AWS KMS signer returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("AWS KMS signer returned an invalid response");
  }
  return parsed as Record<string, unknown>;
}

function canonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
    || Buffer.from(value, "base64").toString("base64") !== value) {
    throw new Error(`${label} is not canonical base64`);
  }
  return Buffer.from(value, "base64");
}

/**
 * Uses the AWS CLI credential provider chain. In CI this can be backed by
 * OIDC web identity; no AWS secret is accepted by Agent Vigil itself.
 */
export function awsKmsEd25519GuardSigner(input: {
  keyId: string;
  awsExecutable: string;
  region?: string;
}): GuardSigner {
  if (!input.keyId.trim() || Buffer.byteLength(input.keyId, "utf8") > 2048) {
    throw new Error("AWS KMS key ID must be non-empty and bounded");
  }
  const awsExecutable = pinnedAwsExecutable(input.awsExecutable);
  const common = ["--no-cli-pager", ...(input.region ? ["--region", input.region] : [])];
  const response = awsJson(awsExecutable, [
    ...common,
    "kms", "get-public-key",
    "--key-id", input.keyId,
    "--output", "json",
  ]);
  const algorithms = response.SigningAlgorithms;
  if (!Array.isArray(algorithms) || !algorithms.includes("ED25519_SHA_512")) {
    throw new Error("AWS KMS key must support ED25519_SHA_512");
  }
  const publicDer = canonicalBase64(response.PublicKey, "AWS KMS public key");
  const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
  if (publicKey.asymmetricKeyType !== "ed25519") throw new Error("AWS KMS public key must be Ed25519");
  const keyId = signingKeyId(publicKeyDer(publicKey));
  return {
    provider: "aws-kms-ed25519",
    keyId,
    publicKey,
    sign(message) {
      if (message.length > MAX_AWS_ED25519_RAW_BYTES) {
        throw new Error("AWS KMS Ed25519 RAW signing input exceeds the 4096-byte API limit");
      }
      const directory = mkdtempSync(join(tmpdir(), "agent-vigil-kms-sign-"));
      const messagePath = join(directory, "message.bin");
      try {
        writeFileSync(messagePath, message, { mode: 0o600, flag: "wx" });
        const signed = awsJson(awsExecutable, [
          ...common,
          "kms", "sign",
          "--key-id", input.keyId,
          "--message", `fileb://${messagePath}`,
          "--message-type", "RAW",
          "--signing-algorithm", "ED25519_SHA_512",
          "--output", "json",
        ]);
        const signature = canonicalBase64(signed.Signature, "AWS KMS signature");
        if (!verify(null, message, publicKey, signature)) {
          throw new Error("AWS KMS returned a signature that does not verify against its public key");
        }
        return signature;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
