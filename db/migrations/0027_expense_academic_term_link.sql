-- Add optional academic-term attribution to expenses without rewriting legacy records.
ALTER TABLE expenses
  ADD COLUMN academic_term_id uuid;

ALTER TABLE expenses
  ADD CONSTRAINT expenses_academic_term_school_fk
  FOREIGN KEY (school_id, academic_term_id)
  REFERENCES academic_terms (school_id, id)
  ON DELETE RESTRICT;

CREATE INDEX expenses_school_academic_term
  ON expenses (school_id, academic_term_id)
  WHERE academic_term_id IS NOT NULL;

-- New/changed term-linked expenses must stay inside an open term and year.
CREATE OR REPLACE FUNCTION shuleledger_validate_expense_academic_term()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  term_row record;
BEGIN
  IF NEW.academic_term_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.starts_on, t.ends_on, t.status AS term_status, y.status AS year_status
    INTO term_row
    FROM academic_terms t
    JOIN academic_years y ON y.school_id=t.school_id AND y.id=t.academic_year_id
   WHERE t.school_id=NEW.school_id AND t.id=NEW.academic_term_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Academic term not found in this school';
  END IF;
  IF term_row.term_status <> 'open' OR term_row.year_status <> 'open' THEN
    RAISE EXCEPTION 'Expenses can only be linked to open academic terms';
  END IF;
  IF NEW.incurred_on < term_row.starts_on OR NEW.incurred_on > term_row.ends_on THEN
    RAISE EXCEPTION 'Expense date must fall within the selected academic term';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER expenses_validate_academic_term
BEFORE INSERT OR UPDATE OF school_id, incurred_on, academic_term_id
ON expenses
FOR EACH ROW
EXECUTE FUNCTION shuleledger_validate_expense_academic_term();
