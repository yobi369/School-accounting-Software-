import { describe, expect, it } from 'vitest';
import { isValidDateRange } from './academic-terms.js';

describe('academic year and term date ranges', () => {
  it('accepts valid inclusive date ranges', () => {
    expect(isValidDateRange('2026-01-01','2026-12-31')).toBe(true);
    expect(isValidDateRange('2026-01-01','2026-01-01')).toBe(true);
  });
  it('rejects reversed ranges', () => {
    expect(isValidDateRange('2026-06-01','2026-05-31')).toBe(false);
  });
  it('rejects impossible calendar dates and malformed input', () => {
    expect(isValidDateRange('2026-02-30','2026-03-01')).toBe(false);
    expect(isValidDateRange('2026-1-01','2026-12-31')).toBe(false);
    expect(isValidDateRange('not-a-date','2026-12-31')).toBe(false);
  });
});
