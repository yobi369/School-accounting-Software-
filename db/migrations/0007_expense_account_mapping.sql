ALTER TABLE expenses ADD COLUMN IF NOT EXISTS expense_account_id uuid;
ALTER TABLE expenses ADD CONSTRAINT expenses_expense_account_fk
  FOREIGN KEY (school_id, expense_account_id)
  REFERENCES accounts(school_id, id) ON DELETE RESTRICT;
INSERT INTO permissions (code,description) VALUES ('bank.manage','manage school bank accounts') ON CONFLICT (code) DO NOTHING;
