import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  const operator = generateKeyPairSync("ed25519");
  const operatorPrivateKey = operator.privateKey.export({ type: "pkcs8", format: "der" });
  const operatorPublicKey = operator.publicKey.export({ type: "spki", format: "der" });
  const operatorKeyId = `sha256:${createHash("sha256").update(operatorPublicKey).digest("hex")}`;
  return {
    plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          ADMIN_TOKEN: "local-test-admin-token-32-bytes-minimum-only",
          TELEMETRY_HMAC_KEY: "local-test-hmac-key-32-bytes-minimum-only",
          LIFECYCLE_ISSUING_KEY: "local-test-lifecycle-issuing-key-32-bytes-minimum-only",
          FREQUENCY_OPERATOR_PRIVATE_KEY_PKCS8_B64: operatorPrivateKey.toString("base64"),
          FREQUENCY_OPERATOR_KEY_ID: operatorKeyId,
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
