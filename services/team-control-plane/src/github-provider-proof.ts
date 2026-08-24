import { nowIso } from "./db.ts";
import { ApiError } from "./http.ts";

const PROVIDER_PROOF_TTL_MS = 15 * 60_000;

export async function recordGitHubProviderProof(
  db: D1Database,
  input: {
    deliveryId: string;
    installationId: number;
    accountNodeId: string;
    accountType: "Organization" | "User";
  }
): Promise<void> {
  const verifiedAt = nowIso();
  const expiresAt = new Date(Date.parse(verifiedAt) + PROVIDER_PROOF_TTL_MS).toISOString();
  await db.batch([
    db.prepare(
      `DELETE FROM github_installation_provider_proofs
        WHERE expires_at <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM github_installation_claims
             WHERE provider_proof_delivery_id = github_installation_provider_proofs.delivery_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM github_personal_installation_claims
             WHERE provider_proof_delivery_id = github_installation_provider_proofs.delivery_id
          )`
    ).bind(verifiedAt),
    db.prepare(
      `INSERT OR IGNORE INTO github_installation_provider_proofs
        (delivery_id, installation_id, github_account_node_id, account_type, verified_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      input.deliveryId,
      input.installationId,
      input.accountNodeId,
      input.accountType,
      verifiedAt,
      expiresAt
    )
  ]);
  const proof = await db.prepare(
    `SELECT installation_id, github_account_node_id, account_type
       FROM github_installation_provider_proofs WHERE delivery_id = ?1`
  )
    .bind(input.deliveryId)
    .first<{ installation_id: number; github_account_node_id: string; account_type: string }>();
  if (
    !proof ||
    proof.installation_id !== input.installationId ||
    proof.github_account_node_id !== input.accountNodeId ||
    proof.account_type !== input.accountType
  ) {
    throw new ApiError(409, "github_provider_proof_collision", "Verified GitHub delivery proof changed identity.");
  }
}
