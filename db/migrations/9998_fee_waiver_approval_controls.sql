ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS adjustment_type text NOT NULL DEFAULT 'waiver';
ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS rejected_by uuid;
ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'fee_waivers'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE fee_waivers DROP CONSTRAINT %I', item.conname);
  END LOOP;
END $$;

ALTER TABLE fee_waivers
  ADD CONSTRAINT fee_waivers_status_review_check
  CHECK (status IN ('submitted', 'posted', 'rejected', 'reversed'));
