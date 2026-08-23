import { describe, expect, it } from "vitest";
import {
  hmacPseudonym,
  sanitizeLifecycleEvent,
  validateLifecycleEvent,
  validatePublicCompatibilityEntry,
  verifyPublicCompatibilityEntry,
} from "../src/contracts";
import { signedEntry, signingFixture } from "./fixtures";

function lifecycle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: "agent-vigil-lifecycle-event/v1",
    event_id: crypto.randomUUID(),
    event_name: "preflight_completed_v1",
    event_day: new Date().toISOString().slice(0, 10),
    release_version: "0.15.0",
    channel: "apm",
    external: true,
    demo: false,
    entity_scope: "INDIVIDUAL_INSTALLATION",
    installation_pseudo_id: "installation-1234567890",
    verdict: "SAFE",
    opaque_pair_token: `sha256:${"a".repeat(64)}`,
    shared_policy: false,
    required_gate: false,
    public_contribution: false,
    organization_context: false,
    ...overrides,
  };
}

describe("hosted proof contracts", () => {
  it("recomputes and verifies a root-compatible signed entry", async () => {
    const signer = await signingFixture();
    const entry = await signedEntry(signer);
    expect(validatePublicCompatibilityEntry(entry)).toEqual(entry);
    expect(await verifyPublicCompatibilityEntry(entry)).toBe(true);
    expect(await verifyPublicCompatibilityEntry({ ...entry, component: { ...entry.component, candidateVersion: "tampered" } })).toBe(false);
  });

  it("enforces individual and organization denominator separation", () => {
    expect(validateLifecycleEvent(lifecycle()).entity_scope).toBe("INDIVIDUAL_INSTALLATION");
    expect(() => validateLifecycleEvent(lifecycle({ organization_pseudo_id: "organization-1234567890" }))).toThrow();
    expect(() => validateLifecycleEvent(lifecycle({ entity_scope: "ORGANIZATION", organization_context: true }))).toThrow();
    const organization = validateLifecycleEvent(lifecycle({
      entity_scope: "ORGANIZATION",
      organization_context: true,
      organization_pseudo_id: "organization-1234567890",
    }));
    expect(organization.entity_scope).toBe("ORGANIZATION");
  });

  it("rejects privacy-canary fields rather than silently dropping them", () => {
    for (const [field, value] of [
      ["repository_name", "private-repo"],
      ["source", "const secret = 1"],
      ["prompt", "private prompt"],
      ["transcript", "private transcript"],
      ["file_path", "/Users/example/private"],
      ["argv", ["--token", "secret"]],
      ["environment_variables", { TOKEN: "secret" }],
      ["organization_domain", "private.example"],
      ["email", "person@example.com"],
      ["full_receipt", { source: "private" }],
    ] as const) {
      expect(() => validateLifecycleEvent(lifecycle({ [field]: value })), field).toThrow();
    }
  });

  it("stores only keyed pseudonyms in sanitized lifecycle values", async () => {
    const event = validateLifecycleEvent(lifecycle());
    const sanitized = await sanitizeLifecycleEvent(event, "test-hmac-secret-that-is-at-least-thirty-two-bytes");
    expect(canonicalJson(sanitized)).not.toContain(event.installation_pseudo_id);
    expect(sanitized.installation_pseudo_hash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(await hmacPseudonym("same", "test-hmac-secret-that-is-at-least-thirty-two-bytes"))
      .toBe(await hmacPseudonym("same", "test-hmac-secret-that-is-at-least-thirty-two-bytes"));
  });
});

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
