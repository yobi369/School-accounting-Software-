-- Dedicated school-scoped academic years and terms, separate from accounting periods.
CREATE TABLE academic_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 80),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (starts_on <= ends_on),
  UNIQUE (school_id, id),
  UNIQUE (school_id, name)
);
CREATE TABLE academic_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  academic_year_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (starts_on <= ends_on),
  FOREIGN KEY (school_id, academic_year_id) REFERENCES academic_years(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, id),
  UNIQUE (school_id, academic_year_id, name)
);
CREATE INDEX academic_terms_school_dates ON academic_terms(school_id, starts_on, ends_on);
ALTER TABLE academic_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_years FORCE ROW LEVEL SECURITY;
CREATE POLICY academic_years_tenant_isolation ON academic_years
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());
ALTER TABLE academic_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY academic_terms_tenant_isolation ON academic_terms
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT SELECT, INSERT, UPDATE ON academic_years, academic_terms TO shuleledger_app;
  END IF;
END $$;
