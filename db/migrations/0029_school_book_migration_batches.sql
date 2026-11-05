-- Controlled migration staging for schools moving from paper books or spreadsheets.
-- Staged data is never a ledger posting until a different user approves it.
CREATE TABLE migration_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  batch_type text NOT NULL CHECK (batch_type IN ('opening_balances','historical_transactions')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_review','approved','posted','rejected')),
  effective_date date NOT NULL,
  description text NOT NULL CHECK (length(trim(description)) BETWEEN 3 AND 500),
  source_label text NOT NULL CHECK (length(trim(source_label)) BETWEEN 1 AND 160),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  review_note text,
  posted_at timestamptz,
  journal_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, journal_entry_id) REFERENCES journal_entries(school_id, id),
  UNIQUE (school_id, id),
  CHECK (reviewed_by IS NULL OR reviewed_by <> created_by),
  CHECK (
    (status = 'draft' AND submitted_at IS NULL AND reviewed_by IS NULL AND posted_at IS NULL)
    OR (status = 'pending_review' AND submitted_at IS NOT NULL AND reviewed_by IS NULL AND posted_at IS NULL)
    OR (status = 'approved' AND submitted_at IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND posted_at IS NULL)
    OR (status = 'posted' AND submitted_at IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND posted_at IS NOT NULL AND journal_entry_id IS NOT NULL)
    OR (status = 'rejected' AND submitted_at IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND posted_at IS NULL)
  )
);
CREATE INDEX migration_batches_school_status_idx ON migration_batches(school_id,status,created_at DESC);

CREATE TABLE migration_batch_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  transaction_date date,
  external_reference text,
  fingerprint char(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(validation_errors) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, batch_id) REFERENCES migration_batches(school_id,id) ON DELETE RESTRICT,
  UNIQUE (school_id,batch_id,row_number),
  UNIQUE (school_id,batch_id,fingerprint)
);
CREATE INDEX migration_batch_rows_batch_idx ON migration_batch_rows(school_id,batch_id,row_number);

-- Historical batches may create one journal per original transaction date.
-- This mapping preserves traceability while the batch remains the review unit.
CREATE TABLE migration_batch_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  transaction_date date NOT NULL,
  source_id uuid NOT NULL UNIQUE,
  journal_entry_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id,batch_id) REFERENCES migration_batches(school_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id,journal_entry_id) REFERENCES journal_entries(school_id,id) ON DELETE RESTRICT,
  UNIQUE (school_id,batch_id,transaction_date)
);
ALTER TABLE migration_batch_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_batch_postings FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_batch_postings_tenant_isolation ON migration_batch_postings
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT SELECT,INSERT ON migration_batch_postings TO shuleledger_app;
  END IF;
END $$;

CREATE INDEX migration_batch_rows_reference_idx ON migration_batch_rows(school_id,external_reference)
  WHERE external_reference IS NOT NULL;

-- An approval is a separate immutable record, not merely a mutable status flag.
CREATE TABLE migration_batch_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  reviewer_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id,batch_id) REFERENCES migration_batches(school_id,id) ON DELETE RESTRICT,
  UNIQUE (school_id,batch_id)
);
CREATE INDEX migration_approvals_reviewer_idx ON migration_batch_approvals(school_id,reviewer_user_id,created_at DESC);

ALTER TABLE migration_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_batches_tenant_isolation ON migration_batches
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE migration_batch_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_batch_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_batch_rows_tenant_isolation ON migration_batch_rows
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE migration_batch_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_batch_approvals FORCE ROW LEVEL SECURITY;
CREATE POLICY migration_approvals_tenant_isolation ON migration_batch_approvals
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

CREATE OR REPLACE FUNCTION enforce_migration_batch_transition()
RETURNS trigger LANGUAGE plpgsql AS $migration_batch_guard$
BEGIN
  IF OLD.status <> NEW.status AND NOT (
    (OLD.status='draft' AND NEW.status='pending_review')
    OR (OLD.status='pending_review' AND NEW.status IN ('approved','rejected'))
    OR (OLD.status='approved' AND NEW.status='posted')
  ) THEN
    RAISE EXCEPTION 'Invalid migration batch state transition'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND (
    NEW.batch_type IS DISTINCT FROM OLD.batch_type
    OR NEW.effective_date IS DISTINCT FROM OLD.effective_date
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.source_label IS DISTINCT FROM OLD.source_label
    OR NEW.row_count IS DISTINCT FROM OLD.row_count
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
  ) THEN
    RAISE EXCEPTION 'Submitted migration batch details are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$migration_batch_guard$;
CREATE TRIGGER migration_batch_transition_guard
BEFORE UPDATE ON migration_batches
FOR EACH ROW EXECUTE FUNCTION enforce_migration_batch_transition();

CREATE OR REPLACE FUNCTION enforce_migration_row_draft_only()
RETURNS trigger LANGUAGE plpgsql AS $migration_row_guard$
DECLARE
  v_batch_id uuid;
  v_school_id uuid;
  v_status text;
BEGIN
  v_batch_id := CASE WHEN TG_OP='DELETE' THEN OLD.batch_id ELSE NEW.batch_id END;
  v_school_id := CASE WHEN TG_OP='DELETE' THEN OLD.school_id ELSE NEW.school_id END;
  SELECT status INTO v_status FROM migration_batches
    WHERE school_id=v_school_id AND id=v_batch_id FOR UPDATE;
  IF v_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Migration rows can only be changed while the batch is draft'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  IF TG_OP='UPDATE' AND (NEW.school_id<>OLD.school_id OR NEW.batch_id<>OLD.batch_id) THEN
    RAISE EXCEPTION 'Migration rows cannot be moved between batches'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$migration_row_guard$;
CREATE TRIGGER migration_row_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON migration_batch_rows
FOR EACH ROW EXECUTE FUNCTION enforce_migration_row_draft_only();

CREATE OR REPLACE FUNCTION enforce_migration_approval_separation()
RETURNS trigger LANGUAGE plpgsql AS $migration_guard$
DECLARE
  v_creator uuid;
  v_status text;
BEGIN
  SELECT created_by,status INTO v_creator,v_status
    FROM migration_batches
    WHERE school_id=NEW.school_id AND id=NEW.batch_id
    FOR UPDATE;
  IF NOT FOUND OR v_status <> 'pending_review' THEN
    RAISE EXCEPTION 'Only a submitted migration batch can receive a review decision'
      USING ERRCODE = '23514';
  END IF;
  IF v_creator = NEW.reviewer_user_id THEN
    RAISE EXCEPTION 'The migration preparer cannot approve their own batch'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$migration_guard$;
CREATE TRIGGER migration_approval_separation
BEFORE INSERT ON migration_batch_approvals
FOR EACH ROW EXECUTE FUNCTION enforce_migration_approval_separation();

CREATE OR REPLACE FUNCTION protect_migration_approvals()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Migration approval records are append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER migration_approvals_append_only
BEFORE UPDATE OR DELETE ON migration_batch_approvals
FOR EACH ROW EXECUTE FUNCTION protect_migration_approvals();

INSERT INTO permissions(code,description) VALUES
  ('migration.manage','Prepare and submit school book migration batches'),
  ('migration.approve','Review and approve school book migration batches')
ON CONFLICT (code) DO NOTHING;

-- Existing school roles receive only the capabilities appropriate to their role.
INSERT INTO role_permissions(role_id,permission_code)
SELECT r.id,'migration.manage' FROM roles r WHERE r.name IN ('school_admin','accountant')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions(role_id,permission_code)
SELECT r.id,'migration.approve' FROM roles r WHERE r.name IN ('school_admin','approver')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON migration_batches,migration_batch_rows TO shuleledger_app;
    GRANT SELECT,INSERT ON migration_batch_approvals TO shuleledger_app;
  END IF;
END $$;
