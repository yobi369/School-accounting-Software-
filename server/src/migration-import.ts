import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

export const MIGRATION_IMPORT_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRows: 500,
  maxColumns: 50,
} as const;

export type ParsedMigrationRow = {
  sourceRowNumber: number;
  values: Record<string, string>;
};

export type ParsedMigrationFile = {
  format: 'csv' | 'xlsx';
  sheetName: string;
  headers: string[];
  rows: ParsedMigrationRow[];
};

function reject(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 422 });
}

function cellText(cell: ExcelJS.Cell, format: 'csv' | 'xlsx'): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (format === 'xlsx' && value && typeof value === 'object' &&
      ('formula' in value || 'sharedFormula' in value)) {
    return reject(`Formula cells are not accepted (row ${cell.row}, column ${cell.col}).`);
  }
  if (cell.type === ExcelJS.ValueType.Error) {
    return reject(`Spreadsheet error cells are not accepted (row ${cell.row}, column ${cell.col}).`);
  }
  let result: string;
  if (value instanceof Date) {
    result = value.toISOString().slice(0, 10);
  } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    result = String(value);
  } else if (value && typeof value === 'object' && 'richText' in value &&
      Array.isArray(value.richText)) {
    result = value.richText.map(part => String(part.text ?? '')).join('');
  } else {
    return reject(`Unsupported spreadsheet cell value (row ${cell.row}, column ${cell.col}).`);
  }
  if (format === 'csv' && /^[\\s]*[=+@-]/.test(result)) {
    return reject(`Formula-like CSV values are not accepted (row ${cell.row}, column ${cell.col}).`);
  }
  if (result.length > 2_000) {
    return reject(`Cell value is too long (row ${cell.row}, column ${cell.col}).`);
  }
  return result.trim();
}

function extract(sheet: ExcelJS.Worksheet, format: 'csv' | 'xlsx'): ParsedMigrationFile {
  if (sheet.actualRowCount < 2) return reject('The import file must contain a header row and at least one data row.');
  if (sheet.actualColumnCount > MIGRATION_IMPORT_LIMITS.maxColumns) {
    return reject(`The import file cannot exceed ${MIGRATION_IMPORT_LIMITS.maxColumns} columns.`);
  }
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  for (let index = 1; index <= sheet.columnCount; index += 1) {
    headers.push(cellText(headerRow.getCell(index), format));
  }
  while (headers.length && headers[headers.length - 1] === '') headers.pop();
  if (!headers.length || headers.some(header => !header)) return reject('Every column must have a non-empty header.');
  const normalized = headers.map(header => header.toLocaleLowerCase('en'));
  if (new Set(normalized).size !== normalized.length) return reject('Column headers must be unique, ignoring letter case.');
  if (headers.length > MIGRATION_IMPORT_LIMITS.maxColumns) return reject('Too many columns in the import file.');

  const rows: ParsedMigrationRow[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const values: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((header, index) => {
      const value = cellText(row.getCell(index + 1), format);
      values[header] = value;
      if (value !== '') hasValue = true;
    });
    if (!hasValue) return;
    rows.push({ sourceRowNumber: rowNumber, values });
    if (rows.length > MIGRATION_IMPORT_LIMITS.maxRows) {
      reject(`The import file cannot exceed ${MIGRATION_IMPORT_LIMITS.maxRows} non-empty data rows.`);
    }
  });
  if (!rows.length) return reject('The import file contains no non-empty data rows.');
  return { format, sheetName: sheet.name || 'CSV', headers, rows };
}

/**
 * Parse a bounded CSV/XLSX workbook for a migration preview. This function only
 * stages parsed values in memory; it never writes to the accounting ledger.
 */
export async function parseMigrationImportFile(fileName: string, buffer: Buffer): Promise<ParsedMigrationFile> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return reject('The uploaded file is empty.');
  if (buffer.length > MIGRATION_IMPORT_LIMITS.maxBytes) {
    return reject('The import file exceeds the 5 MB upload limit.');
  }
  const extension = fileName.toLowerCase().split('.').pop();
  const workbook = new ExcelJS.Workbook();
  if (extension === 'csv') {
    const sheet = await workbook.csv.read(Readable.from([buffer]));
    return extract(sheet, 'csv');
  }
  if (extension !== 'xlsx') return reject('Only .csv and .xlsx files are supported.');
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return reject('The XLSX file is invalid or could not be read.');
  }
  const sheets = workbook.worksheets.filter(sheet => sheet.actualRowCount > 0);
  if (sheets.length !== 1) return reject('The XLSX file must contain exactly one non-empty worksheet.');
  return extract(sheets[0], 'xlsx');
}
