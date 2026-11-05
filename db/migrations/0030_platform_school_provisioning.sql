-- The first school administrator is the platform owner for school provisioning.
-- Only this identity can create additional school workspaces.
CREATE TABLE platform_administrators (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Promote only the earliest administrator membership in the one-time bootstrap school.
INSERT INTO platform_administrators (user_id, created_by)
SELECT m.user_id, m.user_id
FROM system_bootstrap_state b
JOIN school_memberships m ON m.school_id = b.school_id AND m.status = 'active'
JOIN roles r ON r.id = m.role_id AND r.school_id = m.school_id AND r.name = 'school_admin'
WHERE b.singleton = true
ORDER BY m.created_at ASC, m.id ASC
LIMIT 1
ON CONFLICT (user_id) DO NOTHING;

-- The runtime can check platform-owner status but cannot grant or revoke it.
REVOKE ALL ON platform_administrators FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shuleledger_app') THEN
    GRANT SELECT ON platform_administrators TO shuleledger_app;
  END IF;
END $$;
