export type FinancialPeriod = { startsOn: string; endsOn: string };
export type FinancialYearCalendar = {
  startsOn: string;
  endsOn: string;
  name: string;
  periods: FinancialPeriod[];
};

function parseDateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Financial year start must use YYYY-MM-DD.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('Financial year start must be a valid calendar date.');
  }
  if (year < 2000 || year > 2200) throw new Error('Financial year must start between 2000 and 2200.');
  return date;
}

function dateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function buildFinancialYearCalendar(startDate: string): FinancialYearCalendar {
  const start = parseDateOnly(startDate);
  const targetYear = start.getUTCFullYear() + 1;
  const targetMonth = start.getUTCMonth();
  const lastTargetDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const endExclusive = new Date(Date.UTC(targetYear, targetMonth, Math.min(start.getUTCDate(), lastTargetDay)));
  const end = new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000);
  const startsOn = dateString(start);
  const endsOn = dateString(end);
  const startYear = start.getUTCFullYear();
  const endYear = end.getUTCFullYear();
  const name = startYear === endYear ? String(startYear) : `${startYear}/${endYear}`;

  const periods: FinancialPeriod[] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const nextMonth = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const calendarMonthEnd = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000);
    const periodEnd = calendarMonthEnd < end ? calendarMonthEnd : end;
    periods.push({ startsOn: dateString(cursor), endsOn: dateString(periodEnd) });
    cursor = new Date(periodEnd.getTime() + 24 * 60 * 60 * 1000);
  }

  return { startsOn, endsOn, name, periods };
}
