import { describe, expect, it } from 'vitest';
import { isRealPayrollDate } from './payroll.js';

describe('payroll date validation', () => {
  it('accepts real ISO calendar dates', () => {
    expect(isRealPayrollDate('2026-01-01')).toBe(true);
    expect(isRealPayrollDate('2024-02-29')).toBe(true);
  });

  it('rejects impossible dates and malformed input without throwing', () => {
    expect(isRealPayrollDate('2026-02-30')).toBe(false);
    expect(isRealPayrollDate('2026-13-01')).toBe(false);
    expect(isRealPayrollDate('not-a-date')).toBe(false);
    expect(isRealPayrollDate('2026-1-01')).toBe(false);
  });
});
