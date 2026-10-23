-- Correct the journal-line guard for updates that move a line between journals.
-- Both the old and new journal must be drafts; otherwise a caller could move a
-- line out of an immutable posted journal into a draft journal.

CREATE OR REPLACE FUNCTION protect_posted_journal_lines()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO v_status
      FROM journal_entries
      WHERE id = OLD.journal_entry_id AND school_id = OLD.school_id
      FOR SHARE;
    IF NOT FOUND OR v_status <> 'draft' THEN
      RAISE EXCEPTION 'Lines cannot be removed or moved from a posted journal'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT status INTO v_status
      FROM journal_entries
      WHERE id = NEW.journal_entry_id AND school_id = NEW.school_id
      FOR SHARE;
    IF NOT FOUND OR v_status <> 'draft' THEN
      RAISE EXCEPTION 'Journal lines may only be added to a draft journal'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
