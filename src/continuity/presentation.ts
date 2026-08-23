import { terminalSafe } from "../upgrade/presentation.ts";
import type { ChainVerification } from "./chain.ts";
import type { ContinuityDecision } from "./decision.ts";

export type PublicChainVerification = {
  schemaVersion: "agent-vigil-continuity-verification/v1";
  valid: boolean;
  historicalVerification: "PASS" | "FAIL" | "INCONCLUSIVE";
  rootHash: string;
  chainTip: string;
  eventCount: number;
  rootSignature: { present: boolean; valid: boolean; keyId?: string };
  errors: string[];
};

export function publicChainVerification(value: ChainVerification): PublicChainVerification {
  return {
    schemaVersion: "agent-vigil-continuity-verification/v1",
    valid: value.valid,
    historicalVerification: value.root.historicalVerification,
    rootHash: value.root.rootHash,
    chainTip: value.chainTip,
    eventCount: value.events.length,
    rootSignature: value.rootSignature,
    errors: value.errors.map((error) => terminalSafe(error)),
  };
}

export function renderChainVerification(value: ChainVerification): string {
  const lines = [
    `Agent Vigil continuity chain: ${value.valid ? "VALID" : "INVALID"}`,
    `  historical verification: ${value.root.historicalVerification}`,
    `  events: ${value.events.length}`,
    `  root: ${value.root.rootHash}`,
    `  tip:  ${value.chainTip}`,
    `  root signature: ${value.rootSignature.present ? value.rootSignature.valid ? "valid" : "invalid" : "absent"}`,
  ];
  for (const error of value.errors) lines.push(`  ✗ ${terminalSafe(error)}`);
  return lines.join("\n");
}

export function renderContinuityDecision(value: ContinuityDecision): string {
  const lines = [
    `Agent Vigil continuity: ${value.continuity}`,
    `  historical verification: ${value.historicalVerification}`,
    `  protected action: ${value.allowsProtectedAction ? "ALLOW" : "DENY"}`,
    `  events: ${value.eventCount}`,
    `  root: ${value.rootHash}`,
    `  tip:  ${value.chainTip}`,
    `  policy: ${value.policy.sha256}`,
  ];
  for (const reason of value.reasons) {
    const marker = reason.disposition === "revoke" ? "✗" : reason.disposition === "expire" ? "⌛" : reason.disposition === "hold" ? "?" : "✓";
    lines.push(`  ${marker} [${terminalSafe(reason.ruleId)}] ${terminalSafe(reason.message)}`);
  }
  for (const fact of value.outcomeFacts) lines.push(`  • outcome: ${fact.kind} at ${fact.observedAt}`);
  lines.push(`  ${value.decisionHash}`);
  return lines.join("\n");
}
