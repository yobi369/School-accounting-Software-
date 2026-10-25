import pg from 'pg';

const connectionString = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('Set MIGRATIONS_DATABASE_URL or DATABASE_URL before preparing the local database.');
}
const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const role = await pool.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'shuleledger_app'",
  );
  if (!role.rowCount) throw new Error('Expected the shuleledger_app runtime role to exist.');
  if (role.rows[0].rolsuper || role.rows[0].rolbypassrls) {
    throw new Error('Refusing to grant privileges: shuleledger_app must be NOSUPERUSER and NOBYPASSRLS.');
  }
  await pool.query('GRANT USAGE ON SCHEMA public TO shuleledger_app');
  await pool.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shuleledger_app');
  await pool.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO shuleledger_app');
  await pool.query('ALTER DEFAULT PRIVILEGES FOR ROLE shuleledger_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shuleledger_app');
  await pool.query('ALTER DEFAULT PRIVILEGES FOR ROLE shuleledger_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO shuleledger_app');
  process.stdout.write('Local runtime grants prepared; row-level security remains enabled for shuleledger_app.\n');
} finally {
  await pool.end();
}
