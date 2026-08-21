import type { CheckResult } from "./report.ts";

export type IntegrityMode = "advisory" | "blocking";

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
  return {
    results: checks.filter((check) => check.verdict !== "contradicted"),
    advisories: checks.filter((check) => check.verdict === "contradicted"),
  };
}
