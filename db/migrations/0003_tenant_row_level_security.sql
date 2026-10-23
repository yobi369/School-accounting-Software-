-- ShuleLedger tenant isolation with PostgreSQL Row-Level Security.
-- The API must authenticate the user, verify active school membership, then set
-- app.school_id with SET LOCAL inside each transaction. Never accept this value
-- directly from an untrusted request body/header.
-- The runtime database role must not be a superuser and must not have BYPASSRLS.

CREATE OR REPLACE FUNCTION shuleledger_current_school_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.school_id', true), '')::uuid
$$;

ALTER TABLE schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE schools FORCE ROW LEVEL SECURITY;
CREATE POLICY schools_tenant_isolation ON schools
  USING (id = shuleledger_current_school_id())
  WITH CHECK (id = shuleledger_current_school_id());

ALTER TABLE school_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_tenant_isolation ON school_memberships
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_tenant_isolation ON roles
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  USING (EXISTS (
    SELECT 1 FROM roles r
    WHERE r.id = role_id AND r.school_id = shuleledger_current_school_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM roles r
    WHERE r.id = role_id AND r.school_id = shuleledger_current_school_id()
  ));

ALTER TABLE financial_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_years FORCE ROW LEVEL SECURITY;
CREATE POLICY financial_years_tenant_isolation ON financial_years
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY accounting_periods_tenant_isolation ON accounting_periods
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY accounts_tenant_isolation ON accounts
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_entries_tenant_isolation ON journal_entries
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_lines_tenant_isolation ON journal_lines
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_isolation ON audit_events
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_records_tenant_isolation ON idempotency_records
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

-- users and permissions are global identity/catalog tables and intentionally do
-- not receive a school_id policy here. Their access must be restricted to the
-- authentication/authorization service role and explicit permission checks.
-- With FORCE RLS enabled, the migration owner is also subject to policies unless
-- it is a superuser. Test with the exact non-superuser runtime role before use.
