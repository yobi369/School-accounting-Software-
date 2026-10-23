ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;
INSERT INTO permissions (code,description) VALUES ('bank.manage','manage school bank accounts') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id,permission_code)
SELECT id,'bank.manage' FROM roles WHERE name='school_admin'
ON CONFLICT DO NOTHING;
