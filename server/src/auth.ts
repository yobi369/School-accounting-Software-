import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { requirePool, withSchoolTransaction } from './db.js';

const scrypt = promisify(scryptCallback);
const TOKEN_TTL_HOURS = 12;

export type AuthContext = {
  userId: string;
  schoolId: string;
  email: string;
  fullName: string;
  schoolName: string;
  role: string;
  permissions: string[];
  sessionId: string;
  mustChangePassword: boolean;
};
declare global {
  namespace Express {
    interface Request { auth?: AuthContext }
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !/^[0-9a-f]{32}$/i.test(parts[1]) || !/^[0-9a-f]{128}$/i.test(parts[2])) return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = await scrypt(password, Buffer.from(parts[1], 'hex'), expected.length) as Buffer;
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function safeSecretEquals(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function newSessionToken(schoolId: string): string {
  return `${schoolId}.${randomBytes(32).toString('base64url')}`;
}

export async function authenticateRequest(req: Request): Promise<AuthContext | null> {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const schoolId = token.slice(0, dot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(schoolId)) return null;
  return withSchoolTransaction(schoolId, async client => {
    const result = await client.query(
      `SELECT s.id AS session_id, u.id AS user_id, u.email, u.full_name, u.must_change_password,
              sc.name AS school_name, r.name AS role_name
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN school_memberships m ON m.school_id = s.school_id AND m.user_id = u.id AND m.status = 'active'
       JOIN roles r ON r.id = m.role_id AND r.school_id = s.school_id
       JOIN schools sc ON sc.id = s.school_id AND sc.status = 'active'
       WHERE s.school_id = $1 AND s.token_hash = $2
         AND s.revoked_at IS NULL AND s.expires_at > now()
       LIMIT 1`,
      [schoolId, hashToken(token)],
    );
    if (result.rowCount !== 1) return null;
    const row = result.rows[0] as { session_id: string; user_id: string; email: string; full_name: string; must_change_password:boolean; school_name: string; role_name: string };
    const permissions = await client.query(
      `SELECT rp.permission_code FROM school_memberships m
       JOIN role_permissions rp ON rp.role_id = m.role_id
       WHERE m.school_id = $1 AND m.user_id = $2 AND m.status = 'active'
       ORDER BY rp.permission_code`,
      [schoolId, row.user_id],
    );
    await client.query('UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);
    return {
      sessionId: row.session_id, userId: row.user_id, schoolId, email: row.email,
      fullName: row.full_name, schoolName: row.school_name, role: row.role_name,
      mustChangePassword: row.must_change_password, permissions: permissions.rows.map(item => String(item.permission_code)),
    };
  });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authenticateRequest(req);
    if (!context) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    req.auth = context;
    next();
  } catch (error) {
    if (error instanceof Error && error.name === 'DatabaseUnavailableError') {
      res.status(503).json({ error: 'Authentication service is not configured.' });
      return;
    }
    next(error);
  }
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (req.auth.mustChangePassword) {
      res.status(403).json({ error: 'Change your initial password before using this feature.', code: 'PASSWORD_CHANGE_REQUIRED' });
      return;
    }
    if (!req.auth.permissions.includes(permission)) {
      res.status(403).json({ error: 'Insufficient permission.' });
      return;
    }
    next();
  };
}

export function authContext(req: Request): AuthContext {
  if (!req.auth) throw new Error('Authentication context is missing.');
  return req.auth;
}

export async function createSession(userId: string, schoolId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken(schoolId);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000);
  await withSchoolTransaction(schoolId, async client => {
    await client.query(
      'INSERT INTO auth_sessions (school_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
      [schoolId, userId, hashToken(token), expiresAt],
    );
  });
  return { token, expiresAt };
}
