import { useMemo, useState } from 'react';
import { apiRequest, type SchoolSession } from './lib/api';

type Batch = { id: string; description: string; batch_type: string };
type PreviewRow = { sourceRowNumber: number; values: Record<string, string> };
type Preview = { format: 'csv' | 'xlsx'; sheetName: string; headers: string[]; rows: PreviewRow[] };
type Mapping = {
  accountCode: string;
  debit: string;
  credit: string;
  memo: string;
  transactionDate: string;
  externalReference: string;
};

const emptyMapping: Mapping = {
  accountCode: '', debit: '', credit: '', memo: '', transactionDate: '', externalReference: '',
};
const aliases: Record<keyof Mapping, string[]> = {
  accountCode: ['accountcode', 'account', 'code', 'ledgeraccount', 'sourceaccountcode'],
  debit: ['debit', 'debitamount', 'dr', 'debitkes'],
  credit: ['credit', 'creditamount', 'cr', 'creditkes'],
  memo: ['memo', 'description', 'narration', 'details', 'particulars'],
  transactionDate: ['transactiondate', 'date', 'postingdate', 'transactionday'],
  externalReference: ['externalreference', 'reference', 'ref', 'voucherno', 'receiptno', 'documentreference'],
};
function headerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function guessMapping(headers: string[], historical: boolean): Mapping {
  const result = { ...emptyMapping };
  for (const field of Object.keys(aliases) as (keyof Mapping)[]) {
    if (!historical && (field === 'transactionDate' || field === 'externalReference')) continue;
    result[field] = headers.find(header => aliases[field].includes(headerKey(header))) ?? '';
  }
  return result;
}

export function MigrationImportWizard({ session, batches, onImported }: {
  session: SchoolSession;
  batches: Batch[];
  onImported: () => void;
}) {
  const [batchId, setBatchId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping>(emptyMapping);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const selectedBatch = useMemo(() => batches.find(batch => batch.id === batchId), [batches, batchId]);
  const historical = selectedBatch?.batch_type === 'historical_transactions';

  const upload = async () => {
    if (!batchId || !file) {
      setError('Choose a draft batch and a CSV or XLSX file.');
      return;
    }
    setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      const response = await fetch('/api/v1/migration/batches/' + encodeURIComponent(batchId) + '/import-preview', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + session.token,
          'Content-Type': 'application/octet-stream',
          'X-File-Name': file.name,
        },
        body: file,
      });
      const body = await response.json().catch(() => ({})) as { preview?: Preview; error?: string };
      if (!response.ok || !body.preview) throw new Error(body.error || 'Could not preview this import file.');
      setPreview(body.preview);
      setMapping(guessMapping(body.preview.headers, historical));
      setNotice('Preview ready. Nothing has been saved or posted. Map the columns, inspect the rows, then stage them into the selected draft.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import preview failed.');
    } finally {
      setBusy(false);
    }
  };

  const stage = async () => {
    if (!preview || !selectedBatch) return;
    if (!mapping.accountCode || !mapping.debit || !mapping.credit) {
      setError('Map account code, debit, and credit columns before staging.');
      return;
    }
    if (historical && !mapping.transactionDate) {
      setError('Historical transactions require a mapped original transaction date.');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const rows = preview.rows.map(row => {
        const value = (field: keyof Mapping) => mapping[field] ? String(row.values[mapping[field]] ?? '').trim() : '';
        const memo = value('memo');
        return {
          accountCode: value('accountCode'),
          debit: value('debit') || '0.00',
          credit: value('credit') || '0.00',
          memo: ('Source row ' + row.sourceRowNumber + (memo ? ' · ' + memo : '')).slice(0, 500),
          ...(historical ? {
            transactionDate: value('transactionDate'),
            externalReference: value('externalReference') || undefined,
          } : {}),
        };
      });
      await apiRequest('/migration/batches/' + selectedBatch.id + '/rows', session, {
        method: 'POST', body: JSON.stringify({ rows }),
      });
      setNotice(rows.length + ' rows staged in the draft batch. No ledger journals were posted. Review the batch totals and submit only after checking the source records.');
      setPreview(null); setFile(null);
      onImported();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stage imported rows. The draft batch was not submitted or posted.');
    } finally {
      setBusy(false);
    }
  };

  const mappingField = (field: keyof Mapping, label: string, required: boolean) => {
    if (!preview || (!historical && (field === 'transactionDate' || field === 'externalReference'))) return null;
    return <label className="sl-field" key={field}>{label}{required ? ' *' : ' (optional)'}
      <select value={mapping[field]} onChange={event => setMapping(current => ({ ...current, [field]: event.target.value }))}>
        <option value="">— Select column —</option>
        {preview.headers.map(header => <option key={header} value={header}>{header}</option>)}
      </select>
    </label>;
  };

  return <section className="sl-panel sl-wide">
    <h2>Import CSV / Excel workbook</h2>
    <p className="sl-muted">Upload a single-sheet .csv or .xlsx file (maximum 5 MB and 500 non-empty rows). Preview and column mapping never post financial records. Formula cells and formula-like CSV values are rejected.</p>
    <div className="sl-form-grid">
      <label className="sl-field">Draft batch
        <select value={batchId} onChange={event => { setBatchId(event.target.value); setPreview(null); setError(''); }}>
          <option value="">Select draft batch…</option>
          {batches.map(batch => <option key={batch.id} value={batch.id}>{batch.description} · {batch.batch_type.replaceAll('_', ' ')}</option>)}
        </select>
      </label>
      <label className="sl-field">CSV or XLSX file
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={event => { setFile(event.target.files?.[0] ?? null); setPreview(null); setError(''); }} />
      </label>
    </div>
    <div className="sl-report-actions">
      <button className="sl-outline" disabled={busy || !batchId || !file} onClick={() => void upload()}>{busy ? 'Working…' : 'Preview file'}</button>
    </div>
    {error && <p role="alert" className="sl-error">{error}</p>}
    {notice && <p className="sl-muted" role="status">{notice}</p>}
    {preview && <>
      <div className="sl-period-selection">
        <div className="sl-period-selection-item"><span>FILE</span><strong>{file?.name ?? '—'}</strong></div>
        <div className="sl-period-selection-item"><span>ROWS</span><strong>{preview.rows.length}</strong></div>
        <div className="sl-period-selection-item"><span>FORMAT</span><strong>{preview.format.toUpperCase()}</strong></div>
      </div>
      <h3>Map source columns</h3>
      <div className="sl-form-grid">
        {mappingField('accountCode', 'Account code', true)}
        {mappingField('debit', 'Debit (KES)', true)}
        {mappingField('credit', 'Credit (KES)', true)}
        {mappingField('memo', 'Description / memo', false)}
        {mappingField('transactionDate', 'Original transaction date', historical)}
        {mappingField('externalReference', 'Source reference', false)}
      </div>
      <h3>Preview rows</h3>
      <div className="sl-table-wrap"><table className="sl-table">
        <thead><tr><th>Source row</th>{preview.headers.map(header => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>{preview.rows.slice(0, 12).map(row => <tr key={row.sourceRowNumber}>
          <td>{row.sourceRowNumber}</td>{preview.headers.map(header => <td key={header}>{row.values[header]}</td>)}
        </tr>)}</tbody>
      </table></div>
      {preview.rows.length > 12 && <p className="sl-muted">Showing the first 12 of {preview.rows.length} rows. All rows are included when staged.</p>}
      <div className="sl-report-actions">
        <button className="sl-primary" disabled={busy || !selectedBatch} onClick={() => void stage()}>{busy ? 'Staging…' : 'Stage mapped rows'}</button>
        <button className="sl-outline" disabled={busy} onClick={() => { setPreview(null); setNotice('Preview discarded. No data was staged.'); }}>Discard preview</button>
      </div>
    </>}
  </section>;
}
