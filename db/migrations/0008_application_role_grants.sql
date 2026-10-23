-- Grant the application role object privileges without bypassing row-level security.
-- Create this role separately with NOSUPERUSER NOBYPASSRLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT USAGE ON SCHEMA public TO shuleledger_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shuleledger_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shuleledger_app;
  END IF;
END $$;
