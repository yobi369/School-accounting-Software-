ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS adjustment_type text NOT NULL DEFAULT 'waiver';
ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS rejected_by uuid;
ALTER TABLE fee_waivers ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

ALTER TABLE fee_waivers ALTER COLUMN status DROP DEFAULT;
ALTER TABLE fee_waivers ALTER COLUMN status TYPE text USING status::text;
ALTER TABLE fee_waivers ALTER COLUMN status SET DEFAULT 'submitted';

DO $body$
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
END $body$;

ALTER TABLE fee_waivers
  ADD CONSTRAINT fee_waivers_status_review_check
  CHECK (status IN ('submitted', 'posted', 'rejected', 'reversed'));

ALTER TABLE fee_receipts ADD COLUMN IF NOT EXISTS previous_balance numeric(14,2);
ALTER TABLE fee_receipts ADD COLUMN IF NOT EXISTS new_balance numeric(14,2);
