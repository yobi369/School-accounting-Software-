-- Extend student records with optional personal, guardian, and emergency-contact details.
-- Nullable columns preserve compatibility with existing student records.
ALTER TABLE students
  ADD COLUMN sex text,
  ADD COLUMN date_of_birth date,
  ADD COLUMN guardian_relationship text,
  ADD COLUMN guardian_alternate_phone text,
  ADD COLUMN home_address text,
  ADD COLUMN emergency_contact_name text,
  ADD COLUMN emergency_contact_phone text;

ALTER TABLE students
  ADD CONSTRAINT students_sex_allowed
    CHECK (sex IS NULL OR sex IN ('female','male','other','prefer_not_to_say')),
  ADD CONSTRAINT students_date_of_birth_not_future
    CHECK (date_of_birth IS NULL OR date_of_birth <= CURRENT_DATE),
  ADD CONSTRAINT students_guardian_relationship_nonblank
    CHECK (guardian_relationship IS NULL OR length(trim(guardian_relationship)) > 0),
  ADD CONSTRAINT students_emergency_contact_name_nonblank
    CHECK (emergency_contact_name IS NULL OR length(trim(emergency_contact_name)) > 0);
