CREATE TABLE IF NOT EXISTS school_classes (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL,
  name varchar(120) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS school_classes_school_active_idx ON school_classes (school_id, is_active, name);

INSERT INTO school_classes (id, school_id, name, is_active, created_at)
SELECT gen_random_uuid(), school_id, trim(class_name), true, now()
FROM students
WHERE class_name IS NOT NULL AND trim(class_name) <> ''
GROUP BY school_id, trim(class_name)
ON CONFLICT (school_id, name) DO NOTHING;

CREATE TABLE IF NOT EXISTS school_fee_items (
  id uuid PRIMARY KEY,
  school_id uuid NOT NULL,
  name varchar(100) NOT NULL,
  default_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (default_amount >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, name)
);
CREATE INDEX IF NOT EXISTS school_fee_items_school_active_idx ON school_fee_items (school_id, is_active, name);

INSERT INTO school_fee_items (id, school_id, name, default_amount, is_active, created_at)
SELECT gen_random_uuid(), schools.school_id, items.name, 0, true, now()
FROM (SELECT DISTINCT school_id FROM students) AS schools
CROSS JOIN (VALUES ('Tuition'),('Meals'),('Transport'),('Activities'),('Boarding'),('Examination'),('Development Levy'),('Other')) AS items(name)
ON CONFLICT (school_id, name) DO NOTHING;
