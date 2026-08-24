INSERT OR IGNORE INTO organizations (id, slug, display_name, status, created_at)
VALUES ('org_local', 'local-team', 'Local Team', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT OR IGNORE INTO organization_members
  (org_id, user_id, role, identity_kind, active, created_at, updated_at)
VALUES
  ('org_local', 'user_owner', 'owner', 'human', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('org_local', 'user_member', 'member', 'human', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
