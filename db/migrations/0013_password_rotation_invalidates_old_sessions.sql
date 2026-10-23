ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at timestamptz NOT NULL DEFAULT now();
UPDATE users SET password_changed_at=created_at WHERE password_changed_at IS NULL;
