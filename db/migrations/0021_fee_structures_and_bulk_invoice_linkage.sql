-- Class-based fee structures and idempotent bulk-invoice linkage.
CREATE TABLE fee_structures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  class_name text NOT NULL CHECK (length(trim(class_name)) > 0),
  academic_year text NOT NULL CHECK (length(trim(academic_year)) > 0),
  term_name text NOT NULL CHECK (length(trim(term_name)) > 0),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id),
  UNIQUE (school_id, class_name, academic_year, term_name)
);

CREATE TABLE fee_structure_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  structure_id uuid NOT NULL,
  item_name text NOT NULL CHECK (length(trim(item_name)) > 0),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, structure_id) REFERENCES fee_structures(school_id, id) ON DELETE RESTRICT,
  UNIQUE (school_id, id),
  UNIQUE (school_id, structure_id, item_name)
);

ALTER TABLE fee_invoices ADD COLUMN fee_structure_id uuid;
ALTER TABLE fee_invoices
  ADD CONSTRAINT fee_invoices_structure_fk
  FOREIGN KEY (school_id, fee_structure_id) REFERENCES fee_structures(school_id, id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX fee_invoices_student_structure_unique
  ON fee_invoices (school_id, student_id, fee_structure_id)
  WHERE fee_structure_id IS NOT NULL;

ALTER TABLE fee_structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_structures FORCE ROW LEVEL SECURITY;
CREATE POLICY fee_structures_tenant_isolation ON fee_structures
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

ALTER TABLE fee_structure_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE fee_structure_items FORCE ROW LEVEL SECURITY;
CREATE POLICY fee_structure_items_tenant_isolation ON fee_structure_items
  USING (school_id = shuleledger_current_school_id())
  WITH CHECK (school_id = shuleledger_current_school_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='shuleledger_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON fee_structures, fee_structure_items TO shuleledger_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shuleledger_app;
  END IF;
END $$;
