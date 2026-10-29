CREATE TABLE IF NOT EXISTS fee_invoice_items (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL REFERENCES fee_invoices(id) ON DELETE RESTRICT,
  line_number integer NOT NULL CHECK (line_number > 0),
  item_name varchar(120) NOT NULL,
  description varchar(500) NOT NULL DEFAULT '',
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, invoice_id, line_number)
);
CREATE INDEX IF NOT EXISTS fee_invoice_items_school_invoice_idx
  ON fee_invoice_items (school_id, invoice_id, line_number);
