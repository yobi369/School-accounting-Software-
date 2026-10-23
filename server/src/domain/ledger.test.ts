import { describe, expect, it } from 'vitest';
import { formatMinorUnitsKes, LedgerValidationError, parseKesToMinorUnits, validateJournal } from './ledger.js';

const balanced = {
  schoolId: 'school-a',
  currency: 'KES' as const,
  lines: [
    { accountId: 'cash', debitMinor: 125050n, creditMinor: 0n },
    { accountId: 'fees-receivable', debitMinor: 0n, creditMinor: 125050n },
  ],
};

describe('ledger invariants', () => {
  it('accepts a balanced journal', () => {
    expect(validateJournal(balanced)).toEqual({ totalMinor: 125050n, lineCount: 2 });
  });
  it('rejects an unbalanced journal', () => {
    expect(() => validateJournal({ ...balanced, lines: [
      { accountId: 'cash', debitMinor: 100n, creditMinor: 0n },
      { accountId: 'income', debitMinor: 0n, creditMinor: 99n },
    ] })).toThrow(LedgerValidationError);
  });
  it('rejects a line with debit and credit together', () => {
    expect(() => validateJournal({ ...balanced, lines: [
      { accountId: 'cash', debitMinor: 100n, creditMinor: 100n },
      { accountId: 'income', debitMinor: 0n, creditMinor: 100n },
    ] })).toThrow(/both a debit and a credit/);
  });
  it('rejects negative values and one-line journals', () => {
    expect(() => validateJournal({ ...balanced, lines: [{ accountId: 'cash', debitMinor: -1n, creditMinor: 0n }] })).toThrow();
  });
  it('parses KES decimal amounts exactly', () => {
    expect(parseKesToMinorUnits('1234567.89')).toBe(123456789n);
    expect(parseKesToMinorUnits('12')).toBe(1200n);
    expect(formatMinorUnitsKes(123456789n)).toBe('KES 1,234,567.89');
  });
  it('rejects excessive precision and ambiguous formats', () => {
    expect(() => parseKesToMinorUnits('1.234')).toThrow();
    expect(() => parseKesToMinorUnits('-1.00')).toThrow();
    expect(() => parseKesToMinorUnits('1,000.00')).toThrow();
  });
});