-- Grant access to tables added after the initial runtime grants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON fee_waivers, budgets TO shuleledger_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shuleledger_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shuleledger_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO shuleledger_app;
  END IF;
END $$;
