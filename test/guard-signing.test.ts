import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { awsKmsEd25519GuardSigner } from "../src/guard-signing.ts";

const posixFixture = process.platform === "win32" ? "fake AWS executable uses a POSIX shebang" : false;

test("AWS KMS signer uses the ambient credential chain and verifies every returned Ed25519 signature", { skip: posixFixture }, () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-fake-kms-"));
  const executable = join(directory, "aws");
  const keyPath = join(directory, "key.pem");
  const logPath = join(directory, "calls.jsonl");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, pair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({args,env:process.env}) + "\\n");
const key = crypto.createPrivateKey(fs.readFileSync(${JSON.stringify(keyPath)}));
if (args.includes("get-public-key")) {
  const der = crypto.createPublicKey(key).export({format:"der",type:"spki"});
  process.stdout.write(JSON.stringify({PublicKey:der.toString("base64"),SigningAlgorithms:["ED25519_SHA_512"]}));
} else if (args.includes("sign")) {
  const spec = args[args.indexOf("--message") + 1];
  const bytes = fs.readFileSync(spec.slice("fileb://".length));
  process.stdout.write(JSON.stringify({Signature:crypto.sign(null,bytes,key).toString("base64")}));
} else process.exit(2);
`);
  chmodSync(executable, 0o700);
  const previous = { token: process.env.AWS_WEB_IDENTITY_TOKEN_FILE, unrelated: process.env.AGENT_VIGIL_TEST_SECRET };
  process.env.AWS_WEB_IDENTITY_TOKEN_FILE = "/private/workload-identity-token";
  process.env.AGENT_VIGIL_TEST_SECRET = "must-not-reach-kms-child";
  try {
    const signer = awsKmsEd25519GuardSigner({ keyId: "alias/agent-vigil-admission", awsExecutable: executable, region: "us-east-1" });
    const message = Buffer.from("fresh DSSE payload");
    const signature = signer.sign(message);
    assert.equal(signer.provider, "aws-kms-ed25519");
    assert.equal(verify(null, message, pair.publicKey, signature), true);
    const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
      args: string[];
      env: NodeJS.ProcessEnv;
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes("get-public-key"));
    assert.ok(calls[1].args.includes("sign"));
    assert.ok(calls.every(({ args }) => !args.includes(process.env.AWS_WEB_IDENTITY_TOKEN_FILE!)));
    assert.ok(calls.every(({ args }) => args.includes("--no-cli-pager") && args.includes("us-east-1")));
    assert.ok(calls.every(({ env }) => env.AWS_WEB_IDENTITY_TOKEN_FILE === "/private/workload-identity-token"));
    assert.ok(calls.every(({ env }) => env.AGENT_VIGIL_TEST_SECRET === undefined));
    assert.throws(() => signer.sign(Buffer.alloc(4097)), /4096-byte API limit/);
  } finally {
    if (previous.token === undefined) delete process.env.AWS_WEB_IDENTITY_TOKEN_FILE; else process.env.AWS_WEB_IDENTITY_TOKEN_FILE = previous.token;
    if (previous.unrelated === undefined) delete process.env.AGENT_VIGIL_TEST_SECRET; else process.env.AGENT_VIGIL_TEST_SECRET = previous.unrelated;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("AWS KMS signer rejects an algorithm mismatch before signing", { skip: posixFixture }, () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-fake-kms-algorithm-"));
  const executable = join(directory, "aws");
  writeFileSync(executable, `#!${process.execPath}
process.stdout.write(JSON.stringify({PublicKey:"AA==",SigningAlgorithms:["ECDSA_SHA_256"]}));
`);
  chmodSync(executable, 0o700);
  try {
    assert.throws(() => awsKmsEd25519GuardSigner({ keyId: "alias/wrong", awsExecutable: executable }), /must support ED25519_SHA_512/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("AWS KMS signer requires an absolute non-symbolic-link executable", () => {
  assert.throws(
    () => awsKmsEd25519GuardSigner({ keyId: "alias/unsafe", awsExecutable: "aws" }),
    /absolute normalized path/,
  );
  const directory = mkdtempSync(join(tmpdir(), "vigil-fake-kms-link-"));
  const executable = join(directory, "aws-real");
  const link = join(directory, "aws");
  writeFileSync(executable, `#!${process.execPath}\nprocess.exit(2);\n`, { mode: 0o700 });
  symlinkSync(executable, link);
  try {
    assert.throws(
      () => awsKmsEd25519GuardSigner({ keyId: "alias/unsafe", awsExecutable: link }),
      /non-symbolic-link/,
    );
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("AWS KMS signer rejects executable mutation during a call", { skip: posixFixture }, () => {
  const directory = mkdtempSync(join(tmpdir(), "vigil-fake-kms-mutation-"));
  const executable = join(directory, "aws");
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(executable, `#!${process.execPath}
const fs = require("node:fs");
const crypto = require("node:crypto");
const key = crypto.createPrivateKey(${JSON.stringify(pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString())});
const der = crypto.createPublicKey(key).export({format:"der",type:"spki"});
fs.appendFileSync(${JSON.stringify(executable)}, "\\n// changed");
process.stdout.write(JSON.stringify({PublicKey:der.toString("base64"),SigningAlgorithms:["ED25519_SHA_512"]}));
`, { mode: 0o700 });
  try {
    assert.throws(
      () => awsKmsEd25519GuardSigner({ keyId: "alias/mutated", awsExecutable: executable }),
      /changed during/,
    );
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
