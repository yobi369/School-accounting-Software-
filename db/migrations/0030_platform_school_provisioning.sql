-- The first school administrator is the platform owner for school provisioning.
-- Only this identity can create additional school workspaces.
CREATE TABLE platform_administrators (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill under the bootstrap school's RLS context. FORCE ROW LEVEL SECURITY
-- also applies to table owners, so the migration must set the tenant context.
DO $$
DECLARE
  bootstrap_school uuid;
  initial_admin uuid;
BEGIN
  SELECT school_id INTO bootstrap_school
  FROM system_bootstrap_state
  WHERE singleton = true;

  IF bootstrap_school IS NOT NULL THEN
    PERFORM set_config('app.school_id', bootstrap_school::text, true);
    SELECT m.user_id INTO initial_admin
    FROM school_memberships m
    JOIN roles r ON r.id = m.role_id AND r.school_id = m.school_id
    WHERE m.school_id = bootstrap_school
      AND m.status = 'active'
      AND r.name = 'school_admin'
    ORDER BY m.created_at ASC, m.id ASC
    LIMIT 1;

    IF initial_admin IS NOT NULL THEN
      INSERT INTO platform_administrators (user_id, created_by)
      VALUES (initial_admin, initial_admin)
      ON CONFLICT (user_id) DO NOTHING;
    END IF;
  END IF;
END $$;

-- The runtime can check platform-owner status but cannot grant or revoke it.
REVOKE ALL ON platform_administrators FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shuleledger_app') THEN
    GRANT SELECT ON platform_administrators TO shuleledger_app;
  END IF;
END $$;
