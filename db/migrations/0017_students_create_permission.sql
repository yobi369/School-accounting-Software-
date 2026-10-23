INSERT INTO permissions (code,description) VALUES ('students.create','create school student records') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id,permission_code)
SELECT id,'students.create' FROM roles WHERE name='school_admin'
ON CONFLICT DO NOTHING;
