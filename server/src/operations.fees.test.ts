import { describe, expect, it } from 'vitest';
import { receiptSchema } from './operations.js';

const validReceipt = {
  studentId: '10000000-0000-4000-8000-000000000001',
  paymentAccountId: '10000000-0000-4000-8000-000000000002',
  amount: '1250.50',
  paymentMethod: 'cash' as const,
};

describe('fee receipt request validation', () => {
  it('accepts a valid cash receipt without an external reference', () => {
    const parsed = receiptSchema.safeParse(validReceipt);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.allocations).toEqual([]);
      expect(parsed.data.allowStudentCredit).toBe(false);
    }
  });

  it('requires an external reference for bank and M-Pesa receipts', () => {
    expect(receiptSchema.safeParse({ ...validReceipt, paymentMethod: 'bank' }).success).toBe(false);
    expect(receiptSchema.safeParse({ ...validReceipt, paymentMethod: 'mpesa' }).success).toBe(false);
    expect(receiptSchema.safeParse({
      ...validReceipt,
      paymentMethod: 'bank',
      externalReference: 'BANK-REF-001',
    }).success).toBe(true);
    expect(receiptSchema.safeParse({
      ...validReceipt,
      paymentMethod: 'mpesa',
      externalReference: 'QAB12CD34',
    }).success).toBe(true);
  });

  it('accepts real leap days and rejects impossible calendar dates', () => {
    expect(receiptSchema.safeParse({ ...validReceipt, receivedOn: '2024-02-29' }).success).toBe(true);
    for (const receivedOn of ['2025-02-29', '2026-13-01', '2026-04-31', '0000-01-01', '2026-2-01', 'not-a-date']) {
      expect(receiptSchema.safeParse({ ...validReceipt, receivedOn }).success, receivedOn).toBe(false);
    }
  });

  it('rejects invalid amounts and oversized external references', () => {
    for (const amount of ['-1.00', '1.001', '1.']) {
      expect(receiptSchema.safeParse({ ...validReceipt, amount }).success, amount).toBe(false);
    }
    expect(receiptSchema.safeParse({
      ...validReceipt,
      paymentMethod: 'mpesa',
      externalReference: 'x'.repeat(161),
    }).success).toBe(false);
  });
});
