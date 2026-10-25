-- The bootstrap endpoint is only for initial system provisioning.
-- A singleton row serializes competing setup requests and survives app restarts.
CREATE TABLE system_bootstrap_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
  completed_at timestamptz NOT NULL DEFAULT now(),
  school_id uuid NOT NULL REFERENCES schools(id) DEFERRABLE INITIALLY DEFERRED
);

-- If the deployment already contains a school, do not reopen initial bootstrap
-- simply because this migration was added after the first school was created.
INSERT INTO system_bootstrap_state (singleton, completed_at, school_id)
SELECT true, now(), id FROM schools ORDER BY id LIMIT 1
ON CONFLICT (singleton) DO NOTHING;

REVOKE ALL ON system_bootstrap_state FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shuleledger_app') THEN
    -- The runtime can claim the singleton but cannot read, change, or delete it.
    GRANT INSERT ON system_bootstrap_state TO shuleledger_app;
  END IF;
END $$;
