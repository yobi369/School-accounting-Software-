export type JournalLineInput = {
  accountId: string;
  debitMinor: bigint;
  creditMinor: bigint;
  memo?: string;
};

export type JournalInput = {
  schoolId: string;
  currency: 'KES';
  lines: JournalLineInput[];
};

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerValidationError';
  }
}

/**
 * Amounts are integer minor units (cents) to avoid binary floating-point.
 * Persist as PostgreSQL NUMERIC(14,2) at the storage boundary.
 * This validator is not a substitute for authorization or database transactions.
 */
export function validateJournal(input: JournalInput): { totalMinor: bigint; lineCount: number } {
  if (!input.schoolId.trim()) throw new LedgerValidationError('A school context is required.');
  if (input.currency !== 'KES') throw new LedgerValidationError('Only KES is enabled in the initial release.');
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new LedgerValidationError('A journal requires at least two lines.');
  }

  let debits = 0n;
  let credits = 0n;
  for (const [index, line] of input.lines.entries()) {
    if (!line.accountId.trim()) throw new LedgerValidationError(`Line ${index + 1} requires an account.`);
    if (line.debitMinor < 0n || line.creditMinor < 0n) {
      throw new LedgerValidationError('Amounts cannot be negative.');
    }
    if (line.debitMinor > 0n && line.creditMinor > 0n) {
      throw new LedgerValidationError('A line cannot contain both a debit and a credit.');
    }
    if (line.debitMinor === 0n && line.creditMinor === 0n) {
      throw new LedgerValidationError('A line must contain a debit or a credit.');
    }
    debits += line.debitMinor;
    credits += line.creditMinor;
  }
  if (debits !== credits) throw new LedgerValidationError('Journal is not balanced.');
  return { totalMinor: debits, lineCount: input.lines.length };
}

export function parseKesToMinorUnits(value: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new LedgerValidationError('Enter a valid non-negative KES amount with up to two decimal places.');
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return whole * 100n + fraction;
}

export function formatMinorUnitsKes(amount: bigint): string {
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}KES ${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}