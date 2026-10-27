-- Enforce academic-calendar date invariants inside PostgreSQL as well as in the API.
-- Advisory transaction locks serialize competing writes for the same school so two
-- concurrent requests cannot both pass an overlap check.
CREATE OR REPLACE FUNCTION shuleledger_validate_academic_year_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.school_id::text), 23001);

  IF EXISTS (
    SELECT 1 FROM academic_years y
    WHERE y.school_id = NEW.school_id
      AND y.id <> NEW.id
      AND daterange(y.starts_on, y.ends_on, '[]')
          && daterange(NEW.starts_on, NEW.ends_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Academic years for a school may not overlap'
      USING ERRCODE = '23514', CONSTRAINT = 'academic_years_no_overlap';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER academic_years_validate_dates
BEFORE INSERT OR UPDATE OF school_id, starts_on, ends_on
ON academic_years
FOR EACH ROW EXECUTE FUNCTION shuleledger_validate_academic_year_dates();

CREATE OR REPLACE FUNCTION shuleledger_validate_academic_term_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_start date;
  parent_end date;
  parent_status text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.school_id::text), 23002);

  SELECT starts_on, ends_on, status
    INTO parent_start, parent_end, parent_status
  FROM academic_years
  WHERE school_id = NEW.school_id AND id = NEW.academic_year_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Academic term must belong to an academic year in the same school'
      USING ERRCODE = '23503', CONSTRAINT = 'academic_terms_year_school_fk';
  END IF;

  IF NEW.starts_on < parent_start OR NEW.ends_on > parent_end THEN
    RAISE EXCEPTION 'Academic term dates must fall within the selected academic year'
      USING ERRCODE = '23514', CONSTRAINT = 'academic_terms_within_year';
  END IF;

  IF parent_status <> 'open' AND NEW.status = 'open' THEN
    RAISE EXCEPTION 'A term cannot be opened under a closed academic year'
      USING ERRCODE = '23514', CONSTRAINT = 'academic_terms_parent_open';
  END IF;

  IF EXISTS (
    SELECT 1 FROM academic_terms t
    WHERE t.school_id = NEW.school_id
      AND t.academic_year_id = NEW.academic_year_id
      AND t.id <> NEW.id
      AND daterange(t.starts_on, t.ends_on, '[]')
          && daterange(NEW.starts_on, NEW.ends_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Terms within an academic year may not overlap'
      USING ERRCODE = '23514', CONSTRAINT = 'academic_terms_no_overlap';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER academic_terms_validate_dates
BEFORE INSERT OR UPDATE OF school_id, academic_year_id, starts_on, ends_on, status
ON academic_terms
FOR EACH ROW EXECUTE FUNCTION shuleledger_validate_academic_term_dates();

-- A year cannot be closed while it contains any open term, even if a caller
-- bypasses the application route.
CREATE OR REPLACE FUNCTION shuleledger_prevent_closing_year_with_open_terms()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'open' AND NEW.status = 'closed'
     AND EXISTS (
       SELECT 1 FROM academic_terms t
       WHERE t.school_id = NEW.school_id
         AND t.academic_year_id = NEW.id
         AND t.status = 'open'
     ) THEN
    RAISE EXCEPTION 'Close all academic terms before closing the academic year'
      USING ERRCODE = '23514', CONSTRAINT = 'academic_years_all_terms_closed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER academic_years_require_closed_terms
BEFORE UPDATE OF status ON academic_years
FOR EACH ROW EXECUTE FUNCTION shuleledger_prevent_closing_year_with_open_terms();
