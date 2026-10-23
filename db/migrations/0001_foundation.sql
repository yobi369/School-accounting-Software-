-- ShuleLedger foundation schema.
-- Apply only to a new development database. Review migrations before production.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  code text NOT NULL UNIQUE,
  currency char(3) NOT NULL DEFAULT 'KES' CHECK (currency = 'KES'),
  timezone text NOT NULL DEFAULT 'Africa/Nairobi',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  UNIQUE (school_id, name)
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE school_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, user_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_school_time_idx ON audit_events (school_id, created_at DESC);

CREATE TABLE financial_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  CHECK (ends_on >= starts_on),
  UNIQUE (school_id, name),
  UNIQUE (school_id, id)
);

CREATE TABLE accounting_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  financial_year_id uuid NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','locked')),
  FOREIGN KEY (school_id, financial_year_id) REFERENCES financial_years(school_id, id),
  CHECK (ends_on >= starts_on),
  UNIQUE (school_id, id)
);

CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('asset','liability','equity','income','expense')),
  parent_account_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  FOREIGN KEY (school_id, parent_account_id) REFERENCES accounts(school_id, id),
  UNIQUE (school_id, code),
  UNIQUE (school_id, id)
);

CREATE TABLE journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  financial_year_id uuid NOT NULL,
  period_id uuid NOT NULL,
  entry_number bigint NOT NULL,
  posting_date date NOT NULL,
  description text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted')),
  source_type text NOT NULL,
  source_id uuid,
  reversal_of_id uuid,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, financial_year_id) REFERENCES financial_years(school_id, id),
  FOREIGN KEY (school_id, period_id) REFERENCES accounting_periods(school_id, id),
  FOREIGN KEY (school_id, reversal_of_id) REFERENCES journal_entries(school_id, id),
  UNIQUE (school_id, financial_year_id, entry_number),
  UNIQUE (school_id, id),
  CHECK ((status = 'draft' AND posted_at IS NULL) OR (status = 'posted' AND posted_at IS NOT NULL))
);

CREATE TABLE journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE RESTRICT,
  journal_entry_id uuid NOT NULL,
  account_id uuid NOT NULL,
  line_number integer NOT NULL CHECK (line_number > 0),
  debit numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  memo text,
  FOREIGN KEY (school_id, journal_entry_id) REFERENCES journal_entries(school_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (school_id, account_id) REFERENCES accounts(school_id, id) ON DELETE RESTRICT,
  CHECK (NOT (debit > 0 AND credit > 0)),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)),
  UNIQUE (journal_entry_id, line_number)
);
CREATE INDEX journal_entries_school_date_idx ON journal_entries (school_id, posting_date, status);
CREATE INDEX journal_lines_account_idx ON journal_lines (school_id, account_id);

-- Important: balancing, immutable-posted-entry rules, and period locking require
-- transactional server logic and database triggers/procedures before production.
-- This migration is a foundation, not a complete production accounting schema.