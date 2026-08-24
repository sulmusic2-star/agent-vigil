import { newId, nowIso } from "./db.ts";
import { ApiError } from "./http.ts";

const PROVIDER_PROOF_TTL_MS = 15 * 60_000;

export type GitHubLifecycleAction =
  | "created"
  | "added"
  | "removed"
  | "unsuspend"
  | "suspend"
  | "deleted"
  | "provider_not_found";

const GITHUB_LIFECYCLE_ACTION_RANK: Record<GitHubLifecycleAction, number> = {
  created: 1,
  added: 2,
  removed: 3,
  unsuspend: 4,
  suspend: 5,
  deleted: 6,
  provider_not_found: 7
};

export function isGitHubLifecycleAdvance(
  candidate: { deliveryId: string; eventCreatedAt: number; action: GitHubLifecycleAction },
  current: { deliveryId: string; eventCreatedAt: number; action: GitHubLifecycleAction }
): boolean {
  if (candidate.eventCreatedAt !== current.eventCreatedAt) {
    return candidate.eventCreatedAt > current.eventCreatedAt;
  }
  if (candidate.deliveryId === current.deliveryId) {
    return candidate.action === current.action;
  }
  return GITHUB_LIFECYCLE_ACTION_RANK[candidate.action] > GITHUB_LIFECYCLE_ACTION_RANK[current.action];
}

export async function recordGitHubProviderProof(
  db: D1Database,
  input: {
    deliveryId: string;
    installationId: number;
    accountNodeId: string;
    accountType: "Organization" | "User";
    action: Exclude<GitHubLifecycleAction, "provider_not_found">;
    eventCreatedAt: number;
  }
): Promise<void> {
  const verifiedAt = nowIso();
  const expiresAt = new Date(Date.parse(verifiedAt) + PROVIDER_PROOF_TTL_MS).toISOString();
  const terminal = input.action === "deleted" || input.action === "suspend";
  await db.prepare(
      `INSERT INTO github_installation_lifecycle_heads
        (installation_id, github_account_node_id, account_type, creation_delivery_id,
         latest_delivery_id, latest_event_created_at, latest_action, terminal, updated_at)
       VALUES (?1, ?2, ?3, CASE WHEN ?4 = 'created' THEN ?5 ELSE NULL END,
               ?5, ?6, ?4, ?7, ?8)
       ON CONFLICT(installation_id) DO UPDATE SET
         creation_delivery_id = CASE
           WHEN excluded.latest_action = 'created' THEN excluded.latest_delivery_id
           ELSE github_installation_lifecycle_heads.creation_delivery_id
         END,
         latest_delivery_id = excluded.latest_delivery_id,
         latest_event_created_at = excluded.latest_event_created_at,
         latest_action = excluded.latest_action,
         terminal = excluded.terminal,
         updated_at = excluded.updated_at
       WHERE excluded.github_account_node_id = github_installation_lifecycle_heads.github_account_node_id
         AND excluded.account_type = github_installation_lifecycle_heads.account_type
         AND (
           excluded.latest_event_created_at > github_installation_lifecycle_heads.latest_event_created_at OR
           (
             excluded.latest_event_created_at = github_installation_lifecycle_heads.latest_event_created_at AND
             (
               (
                 excluded.latest_delivery_id = github_installation_lifecycle_heads.latest_delivery_id AND
                 excluded.latest_action = github_installation_lifecycle_heads.latest_action
               ) OR
               (
                 excluded.latest_delivery_id <> github_installation_lifecycle_heads.latest_delivery_id AND
                 CASE excluded.latest_action
                   WHEN 'provider_not_found' THEN 7 WHEN 'deleted' THEN 6 WHEN 'suspend' THEN 5
                   WHEN 'unsuspend' THEN 4 WHEN 'removed' THEN 3 WHEN 'added' THEN 2 ELSE 1
                 END >
                 CASE github_installation_lifecycle_heads.latest_action
                   WHEN 'provider_not_found' THEN 7 WHEN 'deleted' THEN 6 WHEN 'suspend' THEN 5
                   WHEN 'unsuspend' THEN 4 WHEN 'removed' THEN 3 WHEN 'added' THEN 2 ELSE 1
                 END
               )
             )
           )
         )`
    ).bind(
      input.installationId,
      input.accountNodeId,
      input.accountType,
      input.action,
      input.deliveryId,
      input.eventCreatedAt,
      terminal ? 1 : 0,
      verifiedAt
    )
    .run();
  const head = await db.prepare(
    `SELECT github_account_node_id, account_type, latest_delivery_id, latest_event_created_at,
            latest_action, terminal, creation_delivery_id
       FROM github_installation_lifecycle_heads WHERE installation_id = ?1`
  )
    .bind(input.installationId)
    .first<{
      github_account_node_id: string;
      account_type: string;
      latest_delivery_id: string;
      latest_event_created_at: number;
      latest_action: string;
      terminal: number;
      creation_delivery_id: string | null;
    }>();
  if (
    !head ||
    head.github_account_node_id !== input.accountNodeId ||
    head.account_type !== input.accountType
  ) {
    throw new ApiError(409, "github_lifecycle_identity_collision", "Verified GitHub lifecycle identity changed.");
  }
  if (
    head.latest_delivery_id !== input.deliveryId ||
    head.latest_event_created_at !== input.eventCreatedAt ||
    head.latest_action !== input.action
  ) {
    throw new ApiError(409, "stale_github_lifecycle", "Older or ambiguously ordered GitHub lifecycle delivery was rejected.");
  }

  const receiptId = newId("integrity");
  const results = await db.batch([
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
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE ?7 = 'created'
          AND EXISTS (
            SELECT 1 FROM github_installation_lifecycle_heads
             WHERE installation_id = ?2 AND github_account_node_id = ?3 AND account_type = ?4
               AND creation_delivery_id = ?1 AND latest_delivery_id = ?1 AND terminal = 0
          )`
    ).bind(
      input.deliveryId,
      input.installationId,
      input.accountNodeId,
      input.accountType,
      verifiedAt,
      expiresAt,
      input.action
    ),
    db.prepare(
      `UPDATE github_installation_provider_proofs
          SET invalidated_at = ?1, invalidated_by_delivery_id = ?2
        WHERE installation_id = ?3 AND invalidated_at IS NULL
          AND ?4 = 1
          AND EXISTS (
            SELECT 1 FROM github_installation_lifecycle_heads
             WHERE installation_id = ?3 AND latest_delivery_id = ?2 AND terminal = 1
          )`
    ).bind(verifiedAt, input.deliveryId, input.installationId, terminal ? 1 : 0),
    db.prepare(
      `DELETE FROM github_installation_claims
        WHERE installation_id = ?1 AND status = 'claimed' AND ?2 = 1
          AND NOT EXISTS (
            SELECT 1 FROM github_installations
             WHERE installation_id = github_installation_claims.installation_id
          )
          AND EXISTS (
            SELECT 1 FROM github_installation_lifecycle_heads
             WHERE installation_id = ?1 AND latest_delivery_id = ?3 AND terminal = 1
          )`
    ).bind(input.installationId, terminal ? 1 : 0, input.deliveryId),
    db.prepare(
      `DELETE FROM github_personal_installation_claims
        WHERE installation_id = ?1 AND status = 'claimed' AND ?2 = 1
          AND NOT EXISTS (
            SELECT 1 FROM github_personal_installations
             WHERE installation_id = github_personal_installation_claims.installation_id
          )
          AND EXISTS (
            SELECT 1 FROM github_installation_lifecycle_heads
             WHERE installation_id = ?1 AND latest_delivery_id = ?3 AND terminal = 1
          )`
    ).bind(input.installationId, terminal ? 1 : 0, input.deliveryId),
    db.prepare(
      `INSERT INTO workflow_integrity_receipts (id, workflow_type, source_ref, valid, created_at)
       VALUES (?1, 'github_lifecycle_head_recorded', ?2,
         CASE WHEN
           EXISTS (
             SELECT 1 FROM github_installation_lifecycle_heads
              WHERE installation_id = ?3 AND github_account_node_id = ?4 AND account_type = ?5
                AND latest_delivery_id = ?2 AND latest_event_created_at = ?6
                AND latest_action = ?7 AND terminal = ?8
           )
           AND (
             ?7 <> 'created' OR EXISTS (
               SELECT 1 FROM github_installation_provider_proofs p
               JOIN github_installation_lifecycle_heads h
                 ON h.installation_id = p.installation_id
                AND h.creation_delivery_id = p.delivery_id
                AND h.latest_delivery_id = p.delivery_id
                AND h.terminal = 0
              WHERE p.delivery_id = ?2 AND p.installation_id = ?3
                AND p.github_account_node_id = ?4 AND p.account_type = ?5
                AND p.invalidated_at IS NULL AND p.expires_at > ?9
             )
           )
           AND (
             ?8 = 0 OR (
               NOT EXISTS (
                 SELECT 1 FROM github_installation_provider_proofs
                  WHERE installation_id = ?3 AND invalidated_at IS NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM github_installation_claims c
                  WHERE c.installation_id = ?3 AND c.status = 'claimed'
                    AND NOT EXISTS (
                      SELECT 1 FROM github_installations i
                       WHERE i.installation_id = c.installation_id
                    )
               )
               AND NOT EXISTS (
                 SELECT 1 FROM github_personal_installation_claims c
                  WHERE c.installation_id = ?3 AND c.status = 'claimed'
                    AND NOT EXISTS (
                      SELECT 1 FROM github_personal_installations i
                       WHERE i.installation_id = c.installation_id
                    )
               )
             )
           )
         THEN 1 ELSE 0 END, ?9)`
    ).bind(
      receiptId,
      input.deliveryId,
      input.installationId,
      input.accountNodeId,
      input.accountType,
      input.eventCreatedAt,
      input.action,
      terminal ? 1 : 0,
      verifiedAt
    )
  ]);
  if ((results.at(-1)?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "github_lifecycle_commit_conflict", "Verified GitHub lifecycle effects were not committed atomically.");
  }
  if (input.action === "created") {
    const proof = await db.prepare(
      `SELECT installation_id, github_account_node_id, account_type
         FROM github_installation_provider_proofs
        WHERE delivery_id = ?1 AND invalidated_at IS NULL`
    )
      .bind(input.deliveryId)
      .first<{ installation_id: number; github_account_node_id: string; account_type: string }>();
    if (
      !proof ||
      proof.installation_id !== input.installationId ||
      proof.github_account_node_id !== input.accountNodeId ||
      proof.account_type !== input.accountType ||
      head.creation_delivery_id !== input.deliveryId ||
      head.terminal !== 0
    ) {
      throw new ApiError(409, "github_provider_proof_collision", "Verified GitHub delivery proof changed identity.");
    }
  }
}
