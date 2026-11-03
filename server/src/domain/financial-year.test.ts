import { describe, expect, it } from 'vitest';
import { buildFinancialYearCalendar } from './financial-year.js';

describe('buildFinancialYearCalendar', () => {
  it('preserves the existing January-to-December calendar', () => {
    const year = buildFinancialYearCalendar('2026-01-01');
    expect(year).toMatchObject({ startsOn: '2026-01-01', endsOn: '2026-12-31', name: '2026' });
    expect(year.periods).toHaveLength(12);
    expect(year.periods[0]).toEqual({ startsOn: '2026-01-01', endsOn: '2026-01-31' });
    expect(year.periods[11]).toEqual({ startsOn: '2026-12-01', endsOn: '2026-12-31' });
  });

  it('creates an April-to-March financial year with twelve calendar periods', () => {
    const year = buildFinancialYearCalendar('2026-04-01');
    expect(year).toMatchObject({ startsOn: '2026-04-01', endsOn: '2027-03-31', name: '2026/2027' });
    expect(year.periods).toHaveLength(12);
    expect(year.periods[0]).toEqual({ startsOn: '2026-04-01', endsOn: '2026-04-30' });
    expect(year.periods[11]).toEqual({ startsOn: '2027-03-01', endsOn: '2027-03-31' });
  });

  it('clips first and last periods when the year starts mid-month', () => {
    const year = buildFinancialYearCalendar('2026-04-15');
    expect(year.periods[0]).toEqual({ startsOn: '2026-04-15', endsOn: '2026-04-30' });
    expect(year.periods[year.periods.length - 1]).toEqual({ startsOn: '2027-04-01', endsOn: '2027-04-14' });
    expect(year.periods).toHaveLength(13);
  });

  it('handles leap days without shifting the year boundary', () => {
    const year = buildFinancialYearCalendar('2024-03-01');
    expect(year.endsOn).toBe('2025-02-28');
    expect(year.periods[11]).toEqual({ startsOn: '2025-02-01', endsOn: '2025-02-28' });
  });

  it('clamps a month-end start date to the final valid day in the next year', () => {
    const year = buildFinancialYearCalendar('2026-01-31');
    expect(year.endsOn).toBe('2027-01-30');
  });

  it('rejects impossible and out-of-range dates', () => {
    expect(() => buildFinancialYearCalendar('2026-02-30')).toThrow(/valid calendar date/i);
    expect(() => buildFinancialYearCalendar('1999-01-01')).toThrow(/between 2000 and 2200/i);
    expect(() => buildFinancialYearCalendar('2026-1-01')).toThrow(/YYYY-MM-DD/i);
  });
});
