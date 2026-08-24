import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const TEST_SECRETS = {
  TEAM_SESSION_HMAC_SECRET: "test-only-team-session-secret-32-bytes-minimum",
  COMMERCIAL_ACTOR_HMAC_SECRET: "test-only-commercial-actor-secret-32-bytes-minimum",
  STRIPE_WEBHOOK_SECRET: "test-only-stripe-webhook-secret-32-bytes-minimum",
  STRIPE_RECONCILIATION_HMAC_SECRET: "test-only-reconciliation-secret-32-bytes-minimum",
  GITHUB_WEBHOOK_SECRET: "test-only-github-webhook-secret-32-bytes-minimum",
  GITHUB_RECONCILIATION_HMAC_SECRET: "test-only-github-reconciliation-secret-32-bytes",
  R0_MEASUREMENT_CONTROL_HMAC_SECRET: "test-only-r0-measurement-control-secret-32-bytes",
  R0_MEASUREMENT_IDENTITY_BRIDGE_HMAC_SECRET: "test-only-r0-identity-bridge-secret-32-bytes",
  R0_MEASUREMENT_ACTIVITY_BRIDGE_HMAC_SECRET: "test-only-r0-activity-bridge-secret-32-bytes",
  R0_MEASUREMENT_IDENTITY_HMAC_SECRET: "test-only-r0-measurement-identity-secret-32-bytes",
  R0_INDIVIDUAL_IDENTITY_HMAC_SECRET: "test-only-r0-individual-identity-secret-32-bytes",
  INDIVIDUAL_SESSION_HMAC_SECRET: "test-only-individual-session-secret-32-bytes-minimum"
} as const;

for (const [name, value] of Object.entries(TEST_SECRETS)) {
  process.env[name] = value;
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ...TEST_SECRETS,
            TEAM_SESSION_KEY_ID: "team-session-key-v1",
            STRIPE_PRICE_TEAM_MONTHLY: "price_team_monthly_test",
            STRIPE_PRICE_TEAM_ANNUAL: "price_team_annual_test",
            STRIPE_LIVEMODE: "false",
            GITHUB_APP_ID: "12345",
            R0_MEASUREMENT_ENABLED: "true",
            R0_MEASUREMENT_RELEASE_VERSION: "0.16.0",
            R0_MEASUREMENT_RELEASE_COMMIT_SHA: "0123456789abcdef0123456789abcdef01234567",
            R0_MEASUREMENT_RELEASE_CHANNEL: "github_app",
            R0_MEASUREMENT_ENVIRONMENT: "production",
            R0_MEASUREMENT_RELEASE_PUBLISHED_AT: "2026-05-01T00:00:00.000Z",
            R0_MEASUREMENT_STARTED_AT: "2026-05-01T00:00:00.000Z",
            R0_INDIVIDUAL_MEASUREMENT_ENABLED: "true",
            INDIVIDUAL_SESSION_ENABLED: "true",
            INDIVIDUAL_SESSION_ISSUER: "https://auth.example.test/",
            INDIVIDUAL_SESSION_AUDIENCE: "agent-vigil-team-control-plane",
            INDIVIDUAL_SESSION_KEY_ID: "individual-session-key-v1",
            R0_INDIVIDUAL_IDENTITY_HMAC_KEY_ID: "individual-identity-key-v1"
          }
        }
      })
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      testTimeout: 15_000
    }
  };
});
