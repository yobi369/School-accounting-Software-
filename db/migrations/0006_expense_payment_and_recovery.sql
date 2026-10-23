-- Additional workflow state required for approved expenses and payments.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_journal_entry_id uuid;
ALTER TABLE expenses ADD CONSTRAINT expenses_payment_journal_fk
  FOREIGN KEY (school_id, payment_journal_entry_id)
  REFERENCES journal_entries(school_id, id) ON DELETE RESTRICT;
ALTER TABLE expenses ADD CONSTRAINT expenses_paid_requires_payment_journal
  CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND payment_journal_entry_id IS NOT NULL));

CREATE TABLE IF NOT EXISTS backup_restore_drills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_name text NOT NULL,
  backup_reference text NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  result text NOT NULL CHECK (result IN ('started','passed','failed')),
  verified_by text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((result = 'started' AND completed_at IS NULL) OR (result IN ('passed','failed') AND completed_at IS NOT NULL))
);
