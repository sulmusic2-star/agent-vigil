import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const TEST_SECRETS = {
  TEAM_SESSION_HMAC_SECRET: "test-only-team-session-secret-32-bytes-minimum",
  STRIPE_WEBHOOK_SECRET: "test-only-stripe-webhook-secret-32-bytes-minimum",
  STRIPE_RECONCILIATION_HMAC_SECRET: "test-only-reconciliation-secret-32-bytes-minimum",
  GITHUB_WEBHOOK_SECRET: "test-only-github-webhook-secret-32-bytes-minimum",
  GITHUB_RECONCILIATION_HMAC_SECRET: "test-only-github-reconciliation-secret-32-bytes"
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
            GITHUB_APP_ID: "12345"
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
