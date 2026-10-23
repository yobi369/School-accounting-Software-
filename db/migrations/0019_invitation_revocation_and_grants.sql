ALTER TABLE school_invitations ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
DROP INDEX IF EXISTS school_invitations_one_open_email_idx;
CREATE UNIQUE INDEX school_invitations_one_open_email_idx ON school_invitations(school_id,lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON school_invitations TO shuleledger_app;
  END IF;
END $$;
