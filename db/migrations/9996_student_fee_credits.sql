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
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS student_fee_credit_allocations_invoice_idx
  ON student_fee_credit_allocations (school_id, invoice_id);
