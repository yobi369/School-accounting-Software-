-- Additional referential integrity, fee waivers, and budget foundations.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_single_reversal_idx
  ON journal_entries (school_id, reversal_of_id) WHERE reversal_of_id IS NOT NULL;
ALTER TABLE roles ADD CONSTRAINT roles_school_id_id_unique UNIQUE (school_id,id);
ALTER TABLE school_memberships ADD CONSTRAINT memberships_role_same_school_fk
  FOREIGN KEY (school_id,role_id) REFERENCES roles(school_id,id) ON DELETE RESTRICT;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_school_id_unique UNIQUE (school_id,id);
ALTER TABLE bank_statement_lines ADD CONSTRAINT bank_statement_matched_line_same_school_fk
  FOREIGN KEY (school_id,matched_journal_line_id) REFERENCES journal_lines(school_id,id) ON DELETE RESTRICT;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_active_membership_fk
  FOREIGN KEY (school_id,user_id) REFERENCES school_memberships(school_id,user_id) ON DELETE RESTRICT;

CREATE TABLE fee_waivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  waiver_number text NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(trim(reason)) >= 3),
  waived_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  journal_entry_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id,invoice_id) REFERENCES fee_invoices(school_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,journal_entry_id) REFERENCES journal_entries(school_id,id) ON DELETE RESTRICT,
  UNIQUE (school_id,waiver_number),
  UNIQUE (school_id,id)
);
ALTER TABLE fee_waivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_waivers FORCE ROW LEVEL SECURITY;
CREATE POLICY fee_waivers_tenant_isolation ON fee_waivers
  USING (school_id=shuleledger_current_school_id())
  WITH CHECK (school_id=shuleledger_current_school_id());

CREATE TABLE budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  financial_year_id uuid NOT NULL,
  account_id uuid NOT NULL,
  name text NOT NULL,
  budget_amount numeric(14,2) NOT NULL CHECK (budget_amount >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','closed')),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id,financial_year_id) REFERENCES financial_years(school_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,account_id) REFERENCES accounts(school_id,id) ON DELETE RESTRICT,
  UNIQUE (school_id,financial_year_id,account_id,name),
  UNIQUE (school_id,id),
  CHECK ((status <> 'approved') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY budgets_tenant_isolation ON budgets
  USING (school_id=shuleledger_current_school_id())
  WITH CHECK (school_id=shuleledger_current_school_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON fee_waivers, budgets TO shuleledger_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shuleledger_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shuleledger_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO shuleledger_app;
  END IF;
END $$;
