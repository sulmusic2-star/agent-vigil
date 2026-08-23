import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          ADMIN_TOKEN: "local-test-admin-token-32-bytes-minimum-only",
          TELEMETRY_HMAC_KEY: "local-test-hmac-key-32-bytes-minimum-only",
          LIFECYCLE_ISSUING_KEY: "local-test-lifecycle-issuing-key-32-bytes-minimum-only",
          PROOF_INGESTION_ENABLED: "true",
          LIFECYCLE_INGESTION_ENABLED: "true",
          FREQUENCY_INGESTION_ENABLED: "true",
          R0_RELEASED_AT: "2026-08-23T00:00:00.000Z",
          RELEASED_CHANNELS: "apm",
        },
      },
    })],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
