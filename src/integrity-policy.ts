import type { CheckResult } from "./report.ts";

export type IntegrityMode = "advisory" | "calibrated" | "blocking";

// These rules describe direct weakening or a test that cannot discriminate a
// broken implementation. Broader code-shape heuristics remain advisory in
// calibrated mode because their repository-level precision is not established.
export const CALIBRATED_BLOCKING_RULES = new Set([
  "coverage-weakened",
  "ghost-loader",
  "oracle-falsify",
  "render-gate",
  "test-count-drop",
  "test-empty-added",
  "test-file-deleted",
  "test-oracle-constant",
  "test-skip-added",
  "verification-bypass",
]);

/**
 * Static diff heuristics are useful leads, but their real-world precision is
 * not high enough to block by default. Parse failures remain blocking context
 * errors; verified scans remain ordinary passive evidence.
 */
export function routeIntegrity(
  checks: CheckResult[],
  mode: IntegrityMode = "advisory",
): { results: CheckResult[]; advisories: CheckResult[] } {
  if (mode === "blocking") return { results: checks, advisories: [] };
  if (mode === "calibrated") {
    return {
      results: checks.filter((check) => check.verdict !== "contradicted" || CALIBRATED_BLOCKING_RULES.has(check.ruleId ?? "")),
      advisories: checks.filter((check) => check.verdict === "contradicted" && !CALIBRATED_BLOCKING_RULES.has(check.ruleId ?? "")),
    };
  }
  return {
    results: checks.filter((check) => check.verdict !== "contradicted"),
    advisories: checks.filter((check) => check.verdict === "contradicted"),
  };
}
