import { Pool, type PoolClient } from 'pg';

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: true } : undefined,
    })
  : null;

export class DatabaseUnavailableError extends Error {
  constructor() {
    super('Database is not configured. Set DATABASE_URL before using financial or authentication endpoints.');
    this.name = 'DatabaseUnavailableError';
  }
}

export function requirePool(): Pool {
  if (!pool) throw new DatabaseUnavailableError();
  return pool;
}

export async function withSchoolTransaction<T>(
  schoolId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(schoolId)) {
    throw new Error('A valid school context is required.');
  }
  const client = await requirePool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.school_id', $1, true)", [schoolId]);
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
