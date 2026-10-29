CREATE TABLE IF NOT EXISTS student_fee_credits (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  receipt_id uuid NOT NULL REFERENCES fee_receipts(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  remaining_amount numeric(14,2) NOT NULL CHECK (remaining_amount >= 0 AND remaining_amount <= amount),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, receipt_id)
);
CREATE INDEX IF NOT EXISTS student_fee_credits_student_balance_idx
  ON student_fee_credits (school_id, student_id, status, remaining_amount);

CREATE TABLE IF NOT EXISTS student_fee_credit_allocations (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL,
  credit_id uuid NOT NULL REFERENCES student_fee_credits(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES fee_invoices(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversed_by uuid,
  reversed_at timestamptz,
  reversal_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS student_fee_credit_allocations_invoice_idx
  ON student_fee_credit_allocations (school_id, invoice_id);

ALTER TABLE student_fee_credits ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fee_credits FORCE ROW LEVEL SECURITY;
CREATE POLICY student_fee_credits_school_isolation ON student_fee_credits
  USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);
ALTER TABLE student_fee_credit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_fee_credit_allocations FORCE ROW LEVEL SECURITY;
CREATE POLICY student_fee_credit_allocations_school_isolation ON student_fee_credit_allocations
  USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);
DO $grant$
BEGIN
  -- Render may apply migrations before start-render creates the runtime role.
  -- The startup role-setup step grants application privileges after migrations.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shuleledger_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON student_fee_credits, student_fee_credit_allocations TO shuleledger_app';
  END IF;
END $;
