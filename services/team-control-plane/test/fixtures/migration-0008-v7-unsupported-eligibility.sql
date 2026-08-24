PRAGMA foreign_keys = ON;

-- v7 could persist eligibility after a separate refresh. Make that state
-- unsupported by replacing the current consent's exact source session while
-- retaining non-null eligibility. Migration 0008 must HOLD and preserve these
-- v7 rows instead of treating materialized eligibility as sufficient evidence.
UPDATE individual_identities
   SET eligible_at = '2026-08-20T00:17:03.000Z',
       updated_at = '2026-08-20T00:17:03.000Z'
 WHERE subject_token = 'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

UPDATE individual_consents
   SET updated_session_sha256 = '9999999999999999999999999999999999999999999999999999999999999999'
 WHERE subject_token = 'mind_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
