import { describe, expect, it } from 'vitest';
import { receiptSchema } from './operations.js';

const validReceipt = {
  studentId: '11111111-1111-4111-8111-111111111111',
  amount: '1500.00',
  paymentAccountId: '22222222-2222-4222-8222-222222222222',
  paymentMethod: 'cash',
  allocations: [{ invoiceId: '33333333-3333-4333-8333-333333333333', amount: '1500.00' }],
};

describe('fee receipt input validation', () => {
  it('accepts a valid cash receipt without an external reference', () => {
    expect(receiptSchema.safeParse(validReceipt).success).toBe(true);
  });

  it('accepts real calendar dates and rejects impossible receipt dates', () => {
    expect(receiptSchema.safeParse({ ...validReceipt, receivedOn: '2024-02-29' }).success).toBe(true);
    for (const receivedOn of ['2025-02-29', '2026-13-01', '2026-04-31', '0000-01-01']) {
      expect(receiptSchema.safeParse({ ...validReceipt, receivedOn }).success).toBe(false);
    }
  });

  it('requires a reference for bank receipts', () => {
    const result = receiptSchema.safeParse({ ...validReceipt, paymentMethod: 'bank' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path.includes('externalReference'))).toBe(true);
    }
  });

  it('requires a reference for M-Pesa receipts', () => {
    const result = receiptSchema.safeParse({ ...validReceipt, paymentMethod: 'mpesa' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path.includes('externalReference'))).toBe(true);
    }
  });

  it('accepts bank and M-Pesa receipts with references', () => {
    for (const paymentMethod of ['bank', 'mpesa'] as const) {
      expect(receiptSchema.safeParse({
        ...validReceipt,
        paymentMethod,
        externalReference: 'REF-2026-001',
      }).success).toBe(true);
    }
  });

  it('rejects overlong external references and malformed monetary amounts', () => {
    expect(receiptSchema.safeParse({
      ...validReceipt,
      externalReference: 'x'.repeat(161),
    }).success).toBe(false);
    expect(receiptSchema.safeParse({ ...validReceipt, amount: '-1.00' }).success).toBe(false);
    expect(receiptSchema.safeParse({ ...validReceipt, amount: '1.001' }).success).toBe(false);
    // Zero is syntactically valid money; the receipt endpoint separately rejects amount <= 0.
    expect(receiptSchema.safeParse({ ...validReceipt, amount: '0.00' }).success).toBe(true);
  });

  it('defaults allocations to an empty list and student credit to false', () => {
    const result = receiptSchema.safeParse({
      studentId: validReceipt.studentId,
      amount: '500.00',
      paymentAccountId: validReceipt.paymentAccountId,
      paymentMethod: 'cash',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allocations).toEqual([]);
      expect(result.data.allowStudentCredit).toBe(false);
    }
  });
});
