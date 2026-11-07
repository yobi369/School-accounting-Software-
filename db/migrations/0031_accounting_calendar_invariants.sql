-- Keep financial years and posting periods unambiguous at the database boundary.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM financial_years a
    JOIN financial_years b
      ON b.school_id = a.school_id
     AND b.id > a.id
     AND daterange(a.starts_on, a.ends_on, '[]')
         && daterange(b.starts_on, b.ends_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Existing financial years overlap';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_periods p
    JOIN financial_years y
      ON y.school_id = p.school_id
     AND y.id = p.financial_year_id
    WHERE p.starts_on < y.starts_on OR p.ends_on > y.ends_on
  ) THEN
    RAISE EXCEPTION 'Existing accounting periods fall outside their financial years';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_periods a
    JOIN accounting_periods b
      ON b.school_id = a.school_id
     AND b.id > a.id
     AND daterange(a.starts_on, a.ends_on, '[]')
         && daterange(b.starts_on, b.ends_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Existing accounting periods overlap';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION shuleledger_validate_financial_year_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.school_id::text), 23003);

  IF EXISTS (
    SELECT 1
    FROM financial_years y
    WHERE y.school_id = NEW.school_id
      AND y.id <> NEW.id
      AND daterange(y.starts_on, y.ends_on, '[]')
          && daterange(NEW.starts_on, NEW.ends_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Financial years for a school may not overlap'
      USING ERRCODE = '23514', CONSTRAINT = 'financial_years_no_overlap';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_periods p
    WHERE p.school_id = NEW.school_id
      AND p.financial_year_id = NEW.id
      AND (p.starts_on < NEW.starts_on OR p.ends_on > NEW.ends_on)
  ) THEN
    RAISE EXCEPTION 'Financial year dates must contain all existing accounting periods'
      USING ERRCODE = '23514', CONSTRAINT = 'financial_years_contain_periods';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER financial_years_validate_dates
BEFORE INSERT OR UPDATE OF school_id, starts_on, ends_on
ON financial_years
FOR EACH ROW EXECUTE FUNCTION shuleledger_validate_financial_year_dates();

CREATE OR REPLACE FUNCTION shuleledger_validate_accounting_period_dates()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  year_start date;
  year_end date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.school_id::text), 23003);

  SELECT starts_on, ends_on
    INTO year_start, year_end
  FROM financial_years
  WHERE school_id = NEW.school_id AND id = NEW.financial_year_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period must belong to a financial year in the same school'
      USING ERRCODE = '23503', CONSTRAINT = 'accounting_periods_year_school_fk';
  END IF;

  IF NEW.starts_on < year_start OR NEW.ends_on > year_end THEN
    RAISE EXCEPTION 'Accounting period dates must fall within the selected financial year'
      USING ERRCODE = '23514', CONSTRAINT = 'accounting_periods_within_year';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM accounting_periods p
    WHERE p.school_id = NEW.school_id
      AND p.id <> NEW.id
      AND daterange(p.starts_on, p.ends_on, '[]')
          && daterange(NEW.starts_on, NEW.ends_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Accounting periods for a school may not overlap'
      USING ERRCODE = '23514', CONSTRAINT = 'accounting_periods_no_overlap';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER accounting_periods_validate_dates
BEFORE INSERT OR UPDATE OF school_id, financial_year_id, starts_on, ends_on
ON accounting_periods
FOR EACH ROW EXECUTE FUNCTION shuleledger_validate_accounting_period_dates();
