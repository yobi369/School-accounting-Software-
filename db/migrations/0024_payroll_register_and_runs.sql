-- Payroll register and immutable run snapshots. Statutory deductions are user-entered and are not calculated from unverified rates.
CREATE TABLE payroll_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  employee_number text NOT NULL CHECK (length(trim(employee_number)) BETWEEN 1 AND 40),
  full_name text NOT NULL CHECK (length(trim(full_name)) BETWEEN 2 AND 160),
  job_title text NOT NULL CHECK (length(trim(job_title)) BETWEEN 2 AND 120),
  base_salary numeric(14,2) NOT NULL CHECK (base_salary > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, employee_number),
  UNIQUE (school_id, id)
);
CREATE TABLE payroll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  run_number text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
  gross_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (gross_total >= 0),
  deductions_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (deductions_total >= 0),
  net_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (net_total >= 0),
  salary_expense_account_id uuid,
  salary_payable_account_id uuid,
  deductions_payable_account_id uuid,
  journal_entry_id uuid,
  payment_journal_entry_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  paid_by uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start <= period_end),
  FOREIGN KEY (school_id, salary_expense_account_id) REFERENCES accounts(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, salary_payable_account_id) REFERENCES accounts(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, deductions_payable_account_id) REFERENCES accounts(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, journal_entry_id) REFERENCES journal_entries(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, payment_journal_entry_id) REFERENCES journal_entries(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, run_number),
  UNIQUE (school_id, id),
  UNIQUE (school_id, period_start, period_end)
);
CREATE TABLE payroll_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  payroll_run_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  basic_salary numeric(14,2) NOT NULL CHECK (basic_salary > 0),
  allowances numeric(14,2) NOT NULL DEFAULT 0 CHECK (allowances >= 0),
  deductions numeric(14,2) NOT NULL DEFAULT 0 CHECK (deductions >= 0),
  net_pay numeric(14,2) NOT NULL CHECK (net_pay > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, payroll_run_id) REFERENCES payroll_runs(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, staff_id) REFERENCES payroll_staff(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, payroll_run_id, staff_id),
  CHECK (net_pay = basic_salary + allowances - deductions)
);
CREATE INDEX payroll_staff_active_idx ON payroll_staff(school_id,status,full_name);
CREATE INDEX payroll_runs_period_idx ON payroll_runs(school_id,period_start DESC);
ALTER TABLE payroll_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_staff FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_staff_tenant_isolation ON payroll_staff USING (school_id=shuleledger_current_school_id()) WITH CHECK (school_id=shuleledger_current_school_id());
ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_runs_tenant_isolation ON payroll_runs USING (school_id=shuleledger_current_school_id()) WITH CHECK (school_id=shuleledger_current_school_id());
ALTER TABLE payroll_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_items FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_items_tenant_isolation ON payroll_items USING (school_id=shuleledger_current_school_id()) WITH CHECK (school_id=shuleledger_current_school_id());

INSERT INTO permissions(code,description) VALUES
 ('payroll.read','Read staff and payroll records'),
 ('payroll.manage','Create staff records and draft payroll runs'),
 ('payroll.approve','Approve payroll runs and post salary accruals'),
 ('payroll.pay','Pay approved payroll runs')
ON CONFLICT (code) DO NOTHING;

-- Grant sensitive access to existing role templates; school owners can further customize roles.
INSERT INTO role_permissions(role_id,permission_code)
SELECT r.id,p.code FROM roles r
JOIN permissions p ON
 (r.name IN ('school_admin','bursar') AND p.code IN ('payroll.read','payroll.manage','payroll.approve','payroll.pay'))
 OR (r.name='accountant' AND p.code IN ('payroll.read','payroll.pay'))
 OR (r.name='approver' AND p.code='payroll.approve')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT SELECT, INSERT, UPDATE ON payroll_staff, payroll_runs, payroll_items TO shuleledger_app;
  END IF;
END $$;
