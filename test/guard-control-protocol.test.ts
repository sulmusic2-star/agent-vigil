import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  buildGuardControlObservation,
  canaryBody,
  classifyObserverRequest,
  issueGuardControlChallenge,
  openGuardControlChallenge,
  openGuardControlObservation,
  validateGuardControlChallenge,
} from "../src/guard-control-protocol.ts";
import { guardDigest } from "../src/guard-compat.ts";
import type { GuardSigner } from "../src/guard-signing.ts";
import { publicKeyDer, signingKeyId } from "../src/signature.ts";

function signer(): GuardSigner {
  const keys = generateKeyPairSync("ed25519");
  return {
    provider: "local-ed25519",
    keyId: signingKeyId(publicKeyDer(keys.publicKey)),
    publicKey: keys.publicKey,
    sign: (message) => sign(null, message, keys.privateKey),
  };
}

function challenge() {
  const authority = signer();
  const issued = issueGuardControlChallenge({
    origin: "http://127.0.0.1:43119",
    host: "codex",
    version: "future-1",
    executableSha256: guardDigest("candidate"),
    managedEnvironmentSha256: guardDigest("environment"),
    nodeExecutable: process.execPath,
    signer: authority,
    issuedAt: "2026-09-03T18:00:00.000Z",
    expiresAt: "2026-09-03T18:10:00.000Z",
    nonce: "protocol-test-nonce-0001",
  });
  return { authority, issued };
}

test("a signed challenge and one exact allow effect produce a signed PASS observation", () => {
  const { authority, issued } = challenge();
  assert.equal(openGuardControlChallenge(issued.envelope, authority.publicKey).challenge.challengeHash, issued.challenge.challengeHash);
  const observer = signer();
  const event = classifyObserverRequest({
    plan: issued.plan,
    path: issued.plan.allowPath,
    method: "POST",
    body: Buffer.from(canaryBody()),
    observedAt: "2026-09-03T18:01:00.000Z",
  });
  const result = buildGuardControlObservation({
    challenge: issued.challenge,
    events: [event],
    openedAt: "2026-09-03T18:00:30.000Z",
    closedAt: "2026-09-03T18:01:30.000Z",
    signer: observer,
  });
  assert.equal(result.observation.status, "PASS");
  assert.equal(openGuardControlObservation(result.envelope, observer.publicKey).observation.observationHash, result.observation.observationHash);
});

test("duplicate effects and a tampered envelope fail closed", () => {
  const { authority, issued } = challenge();
  const event = classifyObserverRequest({ plan: issued.plan, path: issued.plan.allowPath, method: "POST", body: Buffer.from(canaryBody()) });
  assert.equal(buildGuardControlObservation({
    challenge: issued.challenge,
    events: [event, event],
    openedAt: "2026-09-03T18:00:30.000Z",
    closedAt: "2026-09-03T18:01:30.000Z",
    signer: signer(),
  }).observation.status, "FAIL");
  const tampered = structuredClone(issued.envelope);
  tampered.payload = Buffer.from("{}", "utf8").toString("base64");
  assert.throws(() => openGuardControlChallenge(tampered, authority.publicKey), /signature is invalid/);
});

test("challenge validation binds the fixed body and accepts IPv6 loopback", () => {
  const { issued } = challenge();
  const changed = structuredClone(issued.challenge);
  changed.observer.bodySha256 = guardDigest("substituted-body");
  const { challengeHash: _ignored, ...unsigned } = changed;
  changed.challengeHash = guardDigest(unsigned);
  assert.throws(() => validateGuardControlChallenge(changed), /fixed canary body/);
  assert.doesNotThrow(() => issueGuardControlChallenge({
    origin: "http://[::1]:43119", host: "codex", version: "future-1",
    executableSha256: guardDigest("candidate"), managedEnvironmentSha256: guardDigest("environment"),
    nodeExecutable: process.execPath, signer: signer(),
    issuedAt: "2026-09-03T18:00:00.000Z", expiresAt: "2026-09-03T18:10:00.000Z",
  }));
});

test("an ALLOW label with the wrong signed path digest cannot pass", () => {
  const { issued } = challenge();
  const event = classifyObserverRequest({
    plan: issued.plan, path: issued.plan.allowPath, method: "POST", body: Buffer.from(canaryBody()),
    observedAt: "2026-09-03T18:01:00.000Z",
  });
  event.pathSha256 = guardDigest("/unrelated/path");
  const result = buildGuardControlObservation({
    challenge: issued.challenge, events: [event], openedAt: "2026-09-03T18:00:30.000Z",
    closedAt: "2026-09-03T18:01:30.000Z", signer: signer(),
  });
  assert.equal(result.observation.status, "FAIL");
  assert.ok(result.observation.reasonCodes.includes("REQUEST_PATH_MISMATCH"));
});
