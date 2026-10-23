-- ShuleLedger hardening migration.
-- Enforces critical ledger invariants in PostgreSQL, not only in application code.
-- Review and run against a disposable PostgreSQL database before deployment.

CREATE OR REPLACE FUNCTION enforce_journal_entry_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_line_count integer;
  v_debits numeric(18,2);
  v_credits numeric(18,2);
  v_period accounting_periods%ROWTYPE;
  v_year financial_years%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' THEN
      RAISE EXCEPTION 'Posted journal entries cannot be deleted; create a reversal instead'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'posted' THEN
    RAISE EXCEPTION 'Posted journal entries are immutable; create a reversal instead'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'posted' THEN
    SELECT * INTO v_period
      FROM accounting_periods
      WHERE id = NEW.period_id AND school_id = NEW.school_id
      FOR SHARE;
    IF NOT FOUND OR v_period.status <> 'open' THEN
      RAISE EXCEPTION 'Journal period must exist and be open'
        USING ERRCODE = '23514';
    END IF;

    SELECT * INTO v_year
      FROM financial_years
      WHERE id = NEW.financial_year_id AND school_id = NEW.school_id
      FOR SHARE;
    IF NOT FOUND OR v_year.status <> 'open' THEN
      RAISE EXCEPTION 'Financial year must exist and be open'
        USING ERRCODE = '23514';
    END IF;

    IF v_period.financial_year_id <> NEW.financial_year_id
       OR NEW.posting_date < v_period.starts_on
       OR NEW.posting_date > v_period.ends_on
       OR NEW.posting_date < v_year.starts_on
       OR NEW.posting_date > v_year.ends_on THEN
      RAISE EXCEPTION 'Posting date must fall within the selected open period and financial year'
        USING ERRCODE = '23514';
    END IF;

    SELECT count(*), COALESCE(sum(debit), 0), COALESCE(sum(credit), 0)
      INTO v_line_count, v_debits, v_credits
      FROM journal_lines
      WHERE journal_entry_id = NEW.id AND school_id = NEW.school_id;

    IF v_line_count < 2 OR v_debits <= 0 OR v_debits <> v_credits THEN
      RAISE EXCEPTION 'A posted journal requires at least two lines and equal, positive debit and credit totals'
        USING ERRCODE = '23514';
    END IF;

    NEW.posted_at := COALESCE(NEW.posted_at, now());
  ELSE
    NEW.posted_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entry_integrity
BEFORE UPDATE OR DELETE ON journal_entries
FOR EACH ROW EXECUTE FUNCTION enforce_journal_entry_integrity();

CREATE OR REPLACE FUNCTION protect_posted_journal_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_entry_id uuid;
  v_school_id uuid;
  v_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_entry_id := OLD.journal_entry_id;
    v_school_id := OLD.school_id;
  ELSE
    v_entry_id := NEW.journal_entry_id;
    v_school_id := NEW.school_id;
  END IF;

  SELECT status INTO v_status
    FROM journal_entries
    WHERE id = v_entry_id AND school_id = v_school_id
    FOR SHARE;

  IF NOT FOUND OR v_status <> 'draft' THEN
    RAISE EXCEPTION 'Journal lines may only be changed while their journal is a draft'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER journal_lines_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
FOR EACH ROW EXECUTE FUNCTION protect_posted_journal_lines();

CREATE OR REPLACE FUNCTION protect_audit_events()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION protect_audit_events();

-- Idempotency records let retry-safe financial APIs return the original outcome
-- instead of duplicating a receipt or journal. API code must still lock and use
-- this table transactionally with the financial write.
CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  resource_type text,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  UNIQUE (school_id, idempotency_key),
  CHECK ((response_status IS NULL) = (response_body IS NULL))
);
CREATE INDEX idempotency_records_created_at_idx ON idempotency_records (created_at);

-- Prevent direct modification of a journal's lines once the journal is posted.
-- The posting trigger validates balance at the transition to posted. Application
-- code must post within a single database transaction and write an audit event.
