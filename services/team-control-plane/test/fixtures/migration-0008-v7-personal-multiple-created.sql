PRAGMA foreign_keys = ON;

-- Mirror the ambiguous second creation in the personal lane. The existing
-- materialized creation is exact; a later unclaimed proof cannot be folded into
-- the same v7 incarnation.
INSERT INTO github_personal_deliveries
  (delivery_id, payload_sha256, event_name, action, installation_id, subject_token,
   account_type, event_created_at, result, received_at)
VALUES ('delivery_personal_created_later', lower(hex(randomblob(32))), 'installation', 'created',
        7002, 'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'User', 1787185080, 'applied', '2026-08-20T00:18:00.000Z');

INSERT INTO github_installation_provider_proofs
  (delivery_id, installation_id, github_account_node_id, account_type,
   verified_at, expires_at, consumed_at, consumed_by_lane)
VALUES ('delivery_personal_created_later', 7002, 'USER_NODE_LEGACY', 'User',
        '2026-08-20T00:18:00.000Z', '9999-12-31T23:59:59.999Z', NULL, NULL);
