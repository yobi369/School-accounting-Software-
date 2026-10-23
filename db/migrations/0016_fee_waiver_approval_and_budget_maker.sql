ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS approved_at timestamptz;
UPDATE fee_waivers SET approved_by=created_by,approved_at=created_at WHERE status='posted' AND approved_by IS NULL;
ALTER TABLE fee_waivers DROP CONSTRAINT IF EXISTS fee_waivers_status_check;
ALTER TABLE fee_waivers ADD CONSTRAINT fee_waivers_status_check CHECK (status IN ('submitted','posted','reversed'));
ALTER TABLE fee_waivers ADD CONSTRAINT fee_waivers_posted_requires_approval CHECK (status<>'posted' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND journal_entry_id IS NOT NULL));
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id) ON DELETE SET NULL;
