-- Link fee structures to the authoritative academic calendar while preserving legacy records.
ALTER TABLE fee_structures
  ADD COLUMN academic_term_id uuid;

ALTER TABLE fee_structures
  ADD CONSTRAINT fee_structures_academic_term_school_fk
  FOREIGN KEY (school_id, academic_term_id)
  REFERENCES academic_terms (school_id, id)
  ON DELETE RESTRICT;

CREATE INDEX fee_structures_school_academic_term
  ON fee_structures (school_id, academic_term_id)
  WHERE academic_term_id IS NOT NULL;

-- A linked structure must use the same academic year and term labels as the calendar.
CREATE OR REPLACE FUNCTION shuleledger_validate_fee_structure_academic_term()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  term_row record;
BEGIN
  IF NEW.academic_term_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT t.name AS term_name, t.starts_on, t.ends_on, t.status AS term_status,
         y.name AS year_name, y.status AS year_status
    INTO term_row
    FROM academic_terms t
    JOIN academic_years y
      ON y.school_id = t.school_id AND y.id = t.academic_year_id
   WHERE t.school_id = NEW.school_id AND t.id = NEW.academic_term_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Academic term not found in this school';
  END IF;
  IF term_row.term_status <> 'open' OR term_row.year_status <> 'open' THEN
    RAISE EXCEPTION 'Fee structures can only be linked to open academic terms';
  END IF;
  IF NEW.academic_year <> term_row.year_name OR NEW.term_name <> term_row.term_name THEN
    RAISE EXCEPTION 'Fee structure year and term labels must match the selected academic term';
  END IF;
  IF NEW.due_on < term_row.starts_on OR NEW.due_on > term_row.ends_on THEN
    RAISE EXCEPTION 'Fee structure due date must fall within the selected academic term';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fee_structures_validate_academic_term
BEFORE INSERT OR UPDATE OF school_id, academic_year, term_name, due_on, academic_term_id
ON fee_structures
FOR EACH ROW
EXECUTE FUNCTION shuleledger_validate_fee_structure_academic_term();
