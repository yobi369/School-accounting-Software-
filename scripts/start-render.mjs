import { spawnSync } from 'node:child_process';
import pg from 'pg';

const migrationUrl = process.env.MIGRATIONS_DATABASE_URL;
const runtimePassword = process.env.RUNTIME_DATABASE_PASSWORD;
if (!migrationUrl || !runtimePassword || runtimePassword.length < 24) {
  throw new Error('Render startup requires MIGRATIONS_DATABASE_URL and a generated RUNTIME_DATABASE_PASSWORD of at least 24 characters.');
}

const migration = spawnSync(process.execPath, ['scripts/migrate.mjs'], {
  stdio: 'inherit',
  env: process.env,
});
if (migration.status !== 0) process.exit(migration.status ?? 1);

const admin = new pg.Pool({
  connectionString: migrationUrl,
  max: 1,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: true } : undefined,
});

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

try {
  const current = await admin.query('SELECT current_user AS role_name');
  const migrationRole = current.rows[0]?.role_name;
  if (!migrationRole) throw new Error('Unable to identify migration database role.');
  if (migrationRole === 'shuleledger_app') {
    throw new Error('MIGRATIONS_DATABASE_URL must use a separate migration-owner role, not shuleledger_app.');
  }

  const exists = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'shuleledger_app'");
  if (!exists.rowCount) {
    await admin.query('CREATE ROLE shuleledger_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
  }

  // Reassert least-privilege attributes. CI setup-only mode preserves its known
  // disposable test password so the existing smoke-test client can connect.
  if (process.env.SHULELEDGER_ROLE_SETUP_ONLY !== 'true') {
    const alter = await admin.query(
      "SELECT format('ALTER ROLE shuleledger_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD %L', $1) AS sql",
      [runtimePassword],
    );
    await admin.query(alter.rows[0].sql);
  } else {
    await admin.query('ALTER ROLE shuleledger_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS');
  }
  await admin.query('GRANT CONNECT ON DATABASE ' + quoteIdentifier((await admin.query('SELECT current_database() AS name')).rows[0].name) + ' TO shuleledger_app');
  await admin.query('GRANT USAGE ON SCHEMA public TO shuleledger_app');
  await admin.query('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO shuleledger_app');
  await admin.query('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO shuleledger_app');
  // These are operator-only metadata tables, not application data.
  await admin.query('REVOKE ALL ON TABLE schema_migrations, backup_restore_drills FROM shuleledger_app');

  const defaults = await admin.query(
    "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shuleledger_app', current_user) AS sql",
  );
  await admin.query(defaults.rows[0].sql);
  const sequenceDefaults = await admin.query(
    "SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO shuleledger_app', current_user) AS sql",
  );
  await admin.query(sequenceDefaults.rows[0].sql);

  const verify = await admin.query(`
    SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole,
      (SELECT count(*)::int FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','S','v','m','f')
         AND c.relowner = r.oid) AS owned_objects
    FROM pg_roles r WHERE r.rolname = 'shuleledger_app'
  `);
  const role = verify.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole || Number(role.owned_objects) !== 0) {
    throw new Error('Runtime database role failed least-privilege verification; refusing to start.');
  }

  if (process.env.SHULELEDGER_ROLE_SETUP_ONLY === 'true') {
    await admin.end();
    process.stdout.write('Least-privilege runtime role verified.\n');
    process.exit(0);
  }

  const runtimeUrl = new URL(migrationUrl);
  runtimeUrl.username = 'shuleledger_app';
  runtimeUrl.password = runtimePassword;
  const childEnv = { ...process.env, DATABASE_URL: runtimeUrl.toString() };
  // Do not pass migration-owner credentials or the runtime password into the API process.
  delete childEnv.MIGRATIONS_DATABASE_URL;
  delete childEnv.RUNTIME_DATABASE_PASSWORD;
  const child = spawnSync(process.execPath, ['dist-server/index.js'], {
    stdio: 'inherit',
    env: childEnv,
  });
  process.exit(child.status ?? 1);
} finally {
  await admin.end();
}
