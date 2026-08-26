import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { ChainVerification } from "../src/continuity/chain.ts";
import { canonicalSha256, type ContinuityEvent, type ContinuityRoot, type ContinuityState } from "../src/continuity/contracts.ts";
import type { ContinuityDecision } from "../src/continuity/decision.ts";
import { issueContinuityStaple } from "../src/continuity/staple.ts";
import type { TrustReport } from "../src/report.ts";
import { generateSigningKey } from "../src/signature.ts";

const index = process.argv.indexOf("--output");
if (index === -1 || !process.argv[index + 1]) throw new Error("--output is required");
const output = resolve(process.argv[index + 1]);
mkdirSync(output, { recursive: true });
const privateKeyPath = join(output, ".ephemeral-private.pem");
const publicKeyPath = join(output, "authority-public.pem");
generateSigningKey(privateKeyPath, publicKeyPath);

function digest(label: string): string { return canonicalSha256({ label }); }
const now = new Date();
const subject = {
  episodeReceiptHash: digest("kubernetes-lab-receipt"),
  repositoryHash: digest("kubernetes-lab-repository"),
  baseSha: "3".repeat(40),
  headSha: "4".repeat(40),
};
const rootHash = digest("kubernetes-lab-root");
const chainTip = digest("kubernetes-lab-chain-tip");
const policySha256 = digest("kubernetes-lab-policy");
const root: ContinuityRoot = {
  schemaVersion: "agent-vigil-continuity-root/v1",
  receiptFileSha256: digest("kubernetes-lab-receipt-file"),
  receiptHash: subject.episodeReceiptHash,
  rootHash,
  subject,
  historicalVerification: "PASS",
  createdAt: new Date(now.getTime() - 120_000).toISOString(),
};
const verification: ChainVerification = {
  valid: true,
  errors: [],
  root,
  report: {} as TrustReport,
  events: [{ sequence: 1 }, { sequence: 2 }] as ContinuityEvent[],
  chainTip,
  rootSignature: { present: true, valid: true, keyId: digest("kubernetes-lab-root-key") },
};
function staple(state: ContinuityState, evaluatedAt: Date, ttlSeconds: number) {
  const decision: ContinuityDecision = {
    schemaVersion: "agent-vigil-continuity-decision/v1",
    evaluatedAt: evaluatedAt.toISOString(),
    historicalVerification: "PASS",
    continuity: state,
    allowsProtectedAction: state === "CURRENT",
    protectedEnvironment: "production",
    rootHash,
    chainTip,
    eventCount: 2,
    policy: { sourceHash: digest("kubernetes-lab-policy-source"), sha256: policySha256 },
    outcomeFacts: [],
    reasons: [],
    decisionHash: digest(`kubernetes-lab-${state}-${evaluatedAt.toISOString()}`),
  };
  return issueContinuityStaple({ verification, decision, privateKeyPath, ttlSeconds });
}
const current = staple("CURRENT", now, 300);
const expired = staple("CURRENT", new Date(now.getTime() - 600_000), 60);
const revoked = staple("REVOKED", now, 300);
const tampered = structuredClone(current);
tampered.payload.subject.headSha = "9".repeat(40);
for (const [name, value] of Object.entries({ current, expired, revoked, tampered })) {
  writeFileSync(join(output, `${name}.staple.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
writeFileSync(join(output, "bindings.json"), `${JSON.stringify({
  expectedReceiptHash: subject.episodeReceiptHash,
  expectedHead: subject.headSha,
  expectedEnvironment: "production",
  expectedPolicySha256: policySha256,
  expectedChainTip: chainTip,
  minimumSequence: 2,
}, null, 2)}\n`, { mode: 0o600 });
rmSync(privateKeyPath, { force: true });
process.stdout.write(`${JSON.stringify({ generatedAt: now.toISOString(), privateKeyRetained: false })}\n`);
