PRAGMA foreign_keys = ON;

-- Add a second, later creation proof to the consistent v7 organization fixture.
-- v7 has no durable incarnation boundary, so migration 0008 must HOLD instead
-- of rebinding the materialized installation/claim to this unclaimed delivery.
INSERT INTO github_deliveries
  (delivery_id, payload_sha256, event_name, action, installation_id, org_id,
   event_created_at, result, received_at)
VALUES ('delivery_org_created_later', lower(hex(randomblob(32))), 'installation', 'created',
        7001, 'org_github', 1787185060, 'applied', '2026-08-20T00:17:40.000Z');

INSERT INTO github_installation_provider_proofs
  (delivery_id, installation_id, github_account_node_id, account_type,
   verified_at, expires_at, consumed_at, consumed_by_lane)
VALUES ('delivery_org_created_later', 7001, 'ORG_NODE_LEGACY', 'Organization',
        '2026-08-20T00:17:40.000Z', '9999-12-31T23:59:59.999Z', NULL, NULL);
