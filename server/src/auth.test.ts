import { describe, expect, it, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { hashPassword, hashToken, newSessionToken, requirePermission, safeSecretEquals, verifyPassword } from './auth.js';

describe('authentication primitives', () => {
  it('hashes passwords with a unique salt and verifies only the matching password', async () => {
    const first = await hashPassword('SchoolAdmin#Secure2026');
    const second = await hashPassword('SchoolAdmin#Secure2026');
    expect(first).not.toBe(second);
    expect(await verifyPassword('SchoolAdmin#Secure2026', first)).toBe(true);
    expect(await verifyPassword('wrong-password', first)).toBe(false);
  });
  it('rejects malformed password hashes without throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
  it('creates opaque high-entropy session tokens scoped to a school', () => {
    const schoolId = 'c2c22c4b-7ad3-4f95-8c24-3adf1b9d98f1';
    const token = newSessionToken(schoolId);
    expect(token.startsWith(schoolId + '.')).toBe(true);
    expect(token.length).toBeGreaterThan(50);
    expect(hashToken(token)).not.toBe(token);
  });
  it('compares secrets safely and detects mismatches', () => {
    expect(safeSecretEquals('bootstrap-secret', 'bootstrap-secret')).toBe(true);
    expect(safeSecretEquals('bootstrap-secret', 'other-secret')).toBe(false);
    expect(safeSecretEquals('', 'other-secret')).toBe(false);
  });
});


describe('authorization middleware', () => {
  function harness(auth?: Express.Request['auth']) {
    const req = { auth } as Request;
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    return { req, response, next };
  }

  it('denies requests without an authenticated context', () => {
    const h = harness();
    requirePermission('reports.read')(h.req, h.response, h.next);
    expect(h.response.status).toHaveBeenCalledWith(401);
    expect(h.response.json).toHaveBeenCalledWith({ error: 'Authentication required.' });
    expect(h.next).not.toHaveBeenCalled();
  });

  it('requires initial password rotation before granting any permission', () => {
    const h = harness({
      userId: 'user-a', schoolId: 'school-a', email: 'a@example.test', fullName: 'Test User',
      schoolName: 'Test School', role: 'school_admin', permissions: ['reports.read'],
      sessionId: 'session-a', mustChangePassword: true,
    });
    requirePermission('reports.read')(h.req, h.response, h.next);
    expect(h.response.status).toHaveBeenCalledWith(403);
    expect(h.response.json).toHaveBeenCalledWith({
      error: 'Change your initial password before using this feature.', code: 'PASSWORD_CHANGE_REQUIRED',
    });
    expect(h.next).not.toHaveBeenCalled();
  });

  it('denies permissions that are not assigned to the active role', () => {
    const h = harness({
      userId: 'user-a', schoolId: 'school-a', email: 'a@example.test', fullName: 'Test User',
      schoolName: 'Test School', role: 'bursar', permissions: ['fees.read'],
      sessionId: 'session-a', mustChangePassword: false,
    });
    requirePermission('expenses.pay')(h.req, h.response, h.next);
    expect(h.response.status).toHaveBeenCalledWith(403);
    expect(h.response.json).toHaveBeenCalledWith({ error: 'Insufficient permission.' });
    expect(h.next).not.toHaveBeenCalled();
  });

  it('allows an explicitly assigned permission after initial password change', () => {
    const h = harness({
      userId: 'user-a', schoolId: 'school-a', email: 'a@example.test', fullName: 'Test User',
      schoolName: 'Test School', role: 'accountant', permissions: ['reports.read', 'reports.export'],
      sessionId: 'session-a', mustChangePassword: false,
    });
    requirePermission('reports.export')(h.req, h.response, h.next);
    expect(h.next).toHaveBeenCalledOnce();
    expect(h.response.status).not.toHaveBeenCalled();
  });
});
