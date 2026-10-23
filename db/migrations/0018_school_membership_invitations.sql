CREATE TABLE school_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  role_id uuid NOT NULL,
  token_hash char(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  FOREIGN KEY (school_id,role_id) REFERENCES roles(school_id,id) ON DELETE RESTRICT,
  UNIQUE (school_id,token_hash),
  UNIQUE (school_id,id),
  CHECK (expires_at>created_at)
);
CREATE UNIQUE INDEX school_invitations_one_open_email_idx ON school_invitations(school_id,lower(email)) WHERE accepted_at IS NULL;
ALTER TABLE school_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY school_invitations_tenant_isolation ON school_invitations
  USING (school_id=shuleledger_current_school_id())
  WITH CHECK (school_id=shuleledger_current_school_id());
