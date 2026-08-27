import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessOutcome, createOutcomeMandate } from "../src/outcome.ts";
import { buildReport, type CheckResult } from "../src/report.ts";
import { generateSigningKey, publicKeyId } from "../src/signature.ts";

const directory = mkdtempSync(join(tmpdir(), "agent-vigil-outcome-demo-"));
const requesterPrivate = join(directory, "requester.pem");
const requesterPublic = join(directory, "requester.pub.pem");
const verifierPrivate = join(directory, "verifier.pem");
const verifierPublic = join(directory, "verifier.pub.pem");
generateSigningKey(requesterPrivate, requesterPublic);
generateSigningKey(verifierPrivate, verifierPublic);

const base = "1".repeat(40);
const head = "2".repeat(40);
const mandate = createOutcomeMandate({
  createdAt: "2026-08-26T12:00:00.000Z",
  expiresAt: "2026-09-26T12:00:00.000Z",
  requesterId: "demo/requester",
  providerId: "demo-agent",
  taskId: "retry-fix",
  taskClass: "code-change",
  description: "Fix the retry race and preserve its regression test",
  base,
  head,
  minMeaningfulVerified: 2,
  requiredRuleIds: ["tests-pass", "test-integrity"],
  verifierKeyIds: [publicKeyId(verifierPublic)],
  adapter: "generic",
  settlementReference: "demo-task-1",
}, requesterPrivate);

function check(ruleId: string, verdict: "verified" | "contradicted"): CheckResult {
  return {
    claim: { kind: "tests_pass", quote: ruleId, subject: ruleId },
    verdict,
    evidence: `${ruleId}: ${verdict}`,
    ruleId,
  };
}

function report(results: CheckResult[]) {
  return buildReport({
    transcript: "demo.jsonl",
    transcriptSha256: `sha256:${"a".repeat(64)}`,
    transcriptFormat: "jsonl",
    repo: "demo",
    base,
    head,
    results,
    reproduction: "npm run demo:outcome",
  });
}

const failed = assessOutcome(mandate, report([
  check("tests-pass", "verified"),
  check("test-integrity", "contradicted"),
]), verifierPrivate, { requesterPublicKeyPath: requesterPublic, issuedAt: "2026-08-27T12:00:00.000Z", attempts: 1 });

const passed = assessOutcome(mandate, report([
  check("tests-pass", "verified"),
  check("test-integrity", "verified"),
]), verifierPrivate, { requesterPublicKeyPath: requesterPublic, issuedAt: "2026-08-27T12:05:00.000Z", attempts: 2 });

console.log("Agent Vigil Outcome Mandate demo");
console.log("");
console.log(`Attempt 1: ${failed.verdict}`);
console.log(`Settlement signal: ${failed.settlementSignal.action} (dry run)`);
console.log(`Reason: ${failed.reasonCodes.join(", ")}`);
console.log("");
console.log(`Attempt 2: ${passed.verdict}`);
console.log(`Settlement signal: ${passed.settlementSignal.action} (dry run)`);
console.log(`Signed receipt: ${passed.outcomeHash}`);
console.log("");
console.log("No money moved and no network action was performed.");
