import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseMigrationImportFile } from './migration-import.js';

describe('safe migration file parser', () => {
  it('parses CSV headers and preserves source row numbers without posting data', async () => {
    const parsed = await parseMigrationImportFile(
      'books.csv',
      Buffer.from('Account Code,Debit,Credit,Reference\n1000,125.00,0.00,RCPT-1\n4000,0.00,125.00,RCPT-1\n', 'utf8'),
    );
    expect(parsed.format).toBe('csv');
    expect(parsed.headers).toEqual(['Account Code', 'Debit', 'Credit', 'Reference']);
    expect(parsed.rows).toEqual([
      { sourceRowNumber: 2, values: { 'Account Code': '1000', Debit: '125.00', Credit: '0.00', Reference: 'RCPT-1' } },
      { sourceRowNumber: 3, values: { 'Account Code': '4000', Debit: '0.00', Credit: '125.00', Reference: 'RCPT-1' } },
    ]);
  });

  it('parses a single-sheet XLSX workbook', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Historical');
    sheet.addRow(['Account Code', 'Debit', 'Credit']);
    sheet.addRow(['1000', 125, 0]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const parsed = await parseMigrationImportFile('books.xlsx', buffer);
    expect(parsed).toMatchObject({
      format: 'xlsx',
      sheetName: 'Historical',
      headers: ['Account Code', 'Debit', 'Credit'],
      rows: [{ sourceRowNumber: 2, values: { 'Account Code': '1000', Debit: '125', Credit: '0' } }],
    });
  });

  it('rejects formula-like CSV values instead of evaluating them', async () => {
    await expect(parseMigrationImportFile(
      'books.csv',
      Buffer.from('Account,Debit\n1000,=HYPERLINK("https://example.invalid")\n'),
    )).rejects.toThrow(/formula-like/i);
  });

  it('rejects XLSX formula cells', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Historical');
    sheet.addRow(['Account Code', 'Debit']);
    sheet.addRow(['1000', { formula: '1+1', result: 2 }]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseMigrationImportFile('books.xlsx', buffer)).rejects.toThrow(/formula cells/i);
  });

  it('rejects duplicate headers regardless of case', async () => {
    await expect(parseMigrationImportFile(
      'books.csv',
      Buffer.from('Account,account\n1000,2000\n'),
    )).rejects.toThrow(/headers must be unique/i);
  });

  it('rejects unsupported, empty, and oversized files', async () => {
    await expect(parseMigrationImportFile('books.xls', Buffer.from('data'))).rejects.toThrow(/only .csv and .xlsx/i);
    await expect(parseMigrationImportFile('books.csv', Buffer.alloc(0))).rejects.toThrow(/empty/i);
    await expect(parseMigrationImportFile('books.csv', Buffer.alloc(5 * 1024 * 1024 + 1))).rejects.toThrow(/5 MB/i);
  });
});
