import { describe, expect, it } from 'vitest';
import { studentSchema } from './operations.js';

const base = {
  admissionNumber: 'ADM-001',
  fullName: 'Sample Student',
};

describe('student registration profile validation', () => {
  it('keeps legacy-compatible minimal student details valid', () => {
    expect(studentSchema.safeParse(base).success).toBe(true);
  });

  it('accepts optional personal, guardian, address, and emergency-contact fields', () => {
    const result = studentSchema.safeParse({
      ...base,
      sex: 'female',
      dateOfBirth: '2012-04-05',
      guardianName: 'Amina Example',
      guardianRelationship: 'Mother',
      guardianPhone: '0712345678',
      guardianAlternatePhone: '0723456789',
      homeAddress: 'Voi, Taita Taveta',
      emergencyContactName: 'Emergency Contact',
      emergencyContactPhone: '0734567890',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unsupported sex values', () => {
    expect(studentSchema.safeParse({ ...base, sex: 'unknown-value' }).success).toBe(false);
  });

  it('rejects malformed or impossible dates', () => {
    expect(studentSchema.safeParse({ ...base, dateOfBirth: '2012-02-31' }).success).toBe(false);
    expect(studentSchema.safeParse({ ...base, dateOfBirth: 'not-a-date' }).success).toBe(false);
  });

  it('rejects future dates of birth', () => {
    expect(studentSchema.safeParse({ ...base, dateOfBirth: '2099-01-01' }).success).toBe(false);
  });

  it('accepts blank optional values when clearing a profile field', () => {
    expect(studentSchema.safeParse({ ...base, sex: '', dateOfBirth: '' }).success).toBe(true);
  });
});
