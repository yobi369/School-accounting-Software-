import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, newSessionToken, safeSecretEquals, verifyPassword } from './auth.js';

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
