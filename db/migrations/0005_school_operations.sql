-- Core application domain tables: identity sessions, students, fees, expenses,
-- bank reconciliation, and offline sync receipts. Apply after migrations 0001-0004.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (lower(email));

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz
);
CREATE INDEX auth_sessions_active_idx ON auth_sessions (school_id, user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE students (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  admission_number text NOT NULL,
  full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
  class_name text,
  guardian_name text,
  guardian_phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','graduated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, admission_number),
  UNIQUE (school_id, id)
);
CREATE INDEX students_school_name_idx ON students (school_id, full_name);

CREATE TABLE fee_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  student_id uuid NOT NULL,
  invoice_number text NOT NULL,
  academic_year text NOT NULL,
  description text NOT NULL,
  issued_on date NOT NULL DEFAULT CURRENT_DATE,
  due_on date NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','part_paid','paid','void')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, invoice_number),
  UNIQUE (school_id, id)
);
CREATE INDEX fee_invoices_student_status_idx ON fee_invoices (school_id, student_id, status);

CREATE TABLE fee_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  receipt_number text NOT NULL,
  student_id uuid NOT NULL,
  received_on date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('cash','bank','mpesa','cheque','other')),
  external_reference text,
  notes text,
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  journal_entry_id uuid,
  received_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, student_id) REFERENCES students(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, journal_entry_id) REFERENCES journal_entries(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, receipt_number),
  UNIQUE (school_id, id)
);
CREATE UNIQUE INDEX fee_receipts_external_reference_unique
  ON fee_receipts (school_id, payment_method, external_reference)
  WHERE external_reference IS NOT NULL AND status = 'posted';

CREATE TABLE fee_receipt_allocations (
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  receipt_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (school_id, receipt_id, invoice_id),
  FOREIGN KEY (school_id, receipt_id) REFERENCES fee_receipts(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, invoice_id) REFERENCES fee_invoices(school_id, id) ON DELETE RESTRICT
);

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  phone text,
  email text,
  tax_pin text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  UNIQUE (school_id, id)
);

CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  expense_number text NOT NULL,
  supplier_id uuid,
  category text NOT NULL,
  description text NOT NULL,
  incurred_on date NOT NULL DEFAULT CURRENT_DATE,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved','rejected','paid')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  paid_at timestamptz,
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, supplier_id) REFERENCES suppliers(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, journal_entry_id) REFERENCES journal_entries(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, expense_number),
  UNIQUE (school_id, id),
  CHECK ((status <> 'approved' AND status <> 'paid') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
CREATE INDEX expenses_school_status_idx ON expenses (school_id, status, incurred_on);

CREATE TABLE bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  name text NOT NULL,
  bank_name text NOT NULL,
  account_number_masked text,
  ledger_account_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (school_id, ledger_account_id) REFERENCES accounts(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, id)
);

CREATE TABLE bank_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  bank_account_id uuid NOT NULL,
  transaction_date date NOT NULL,
  description text NOT NULL,
  reference text,
  amount numeric(14,2) NOT NULL CHECK (amount <> 0),
  imported_hash char(64) NOT NULL,
  matched_journal_line_id uuid REFERENCES journal_lines(id) ON DELETE RESTRICT,
  matched_at timestamptz,
  matched_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, bank_account_id) REFERENCES bank_accounts(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, bank_account_id, imported_hash),
  UNIQUE (school_id, id)
);
CREATE INDEX bank_statement_unmatched_idx ON bank_statement_lines (school_id, bank_account_id, transaction_date) WHERE matched_at IS NULL;

CREATE TABLE offline_sync_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  client_mutation_id uuid NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  resource_type text NOT NULL,
  resource_id uuid,
  response_body jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, client_mutation_id)
);

-- Tenant row-level security for newly introduced school-owned tables.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'auth_sessions','students','fee_invoices','fee_receipts','fee_receipt_allocations',
    'suppliers','expenses','bank_accounts','bank_statement_lines','offline_sync_receipts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (school_id = shuleledger_current_school_id()) WITH CHECK (school_id = shuleledger_current_school_id())', t || '_tenant_isolation', t);
  END LOOP;
END $$;
