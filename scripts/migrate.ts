import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const connectionString = process.env.MIGRATIONS_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  process.stderr.write('Set MIGRATIONS_DATABASE_URL (or DATABASE_URL) to run migrations.\n');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString, max: 1 });
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum char(64) NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const directory = join(process.cwd(), 'db', 'migrations');
  const names = (await readdir(directory)).filter(n => /^\d{4}_[a-z0-9_]+\.sql$/.test(n)).sort();
  for (const name of names) {
    const sql = await readFile(join(directory, name), 'utf8');
    const { createHash } = await import('node:crypto');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = await pool.query('SELECT checksum FROM schema_migrations WHERE name=$1', [name]);
    if (previous.rowCount) {
      if (previous.rows[0].checksum !== checksum) throw new Error(`Applied migration ${name} has changed. Create a new migration instead of editing it.`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name,checksum) VALUES ($1,$2)', [name,checksum]);
      await client.query('COMMIT');
      process.stdout.write(`applied ${name}\n`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
