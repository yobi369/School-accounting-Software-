import type { ReactElement } from 'react';

type ReceiptAllocation = { invoiceNumber?: string; amount?: string | number };
export type ReceiptRow = {
  receipt_number?: string;
  received_on?: string;
  student_name?: string;
  admission_number?: string;
  amount?: string | number;
  payment_method?: string;
  external_reference?: string | null;
  notes?: string | null;
  status?: string;
  allocations?: ReceiptAllocation[] | string;
};

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char] ?? char));
}

function kes(value: unknown): string {
  return 'KSh ' + Number(value ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}


export function ReceiptPrintButton({ receipt }: { receipt: ReceiptRow }): ReactElement {
  const printReceipt = () => {
    const popup = window.open('', '_blank', 'width=760,height=760');
    if (!popup) {
      window.alert('Allow pop-ups for this site to print the receipt.');
      return;
    }
    let allocations: ReceiptAllocation[] = [];
    try {
      allocations = Array.isArray(receipt.allocations)
        ? receipt.allocations
        : JSON.parse(String(receipt.allocations ?? '[]')) as ReceiptAllocation[];
    } catch {
      allocations = [];
    }
    const allocationRows = allocations.map(item =>
      `<tr><td>${escapeHtml(item.invoiceNumber || 'Fee invoice')}</td><td class="right">${escapeHtml(kes(item.amount))}</td></tr>`
    ).join('');
    const status = String(receipt.status ?? '').toLowerCase();
    const reversed = status === 'reversed';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Receipt ${escapeHtml(receipt.receipt_number)}</title>
      <style>
        body{font:14px/1.5 Arial,sans-serif;color:#17211d;margin:32px auto;max-width:720px;padding:0 20px}
        header{text-align:center;border-bottom:2px solid #245d4c;padding-bottom:16px;margin-bottom:20px}
        h1{font-size:24px;margin:0 0 5px}h2{font-size:18px;margin:0}
        .muted{color:#5a6861}.status{padding:6px 10px;border:1px solid #888;display:inline-block;margin-top:10px}
        .details{display:grid;grid-template-columns:1fr 1fr;gap:10px 24px;margin:20px 0}
        .label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#5a6861}
        .value{font-weight:600;overflow-wrap:anywhere}
        table{width:100%;border-collapse:collapse;margin:20px 0}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #d8e0dc}
        th{background:#f0f5f2}.right{text-align:right}.total{font-size:20px;font-weight:700;text-align:right;margin-top:20px}
        footer{border-top:1px solid #d8e0dc;margin-top:28px;padding-top:12px;text-align:center;color:#5a6861;font-size:12px}
        .notice{border:1px solid #a66;padding:10px;margin:12px 0;color:#8a3030}
        @media print{body{margin:0 auto;padding:0 8mm}.no-print{display:none}}
      </style></head><body>
      <header><h1>School Fee Receipt</h1><p class="muted">Official record of a recorded payment</p><h2>Receipt No. ${escapeHtml(receipt.receipt_number)}</h2>
      ${reversed ? '<div class="status">REVERSED — NOT VALID AS PROOF OF CURRENT PAYMENT</div>' : '<div class="status">POSTED</div>'}</header>
      ${reversed ? '<p class="notice">This receipt has been reversed. Retain this copy for the audit trail; it does not represent an active payment.</p>' : ''}
      <section class="details">
        <div><div class="label">Student</div><div class="value">${escapeHtml(receipt.student_name)}</div></div>
        <div><div class="label">Admission number</div><div class="value">${escapeHtml(receipt.admission_number || '—')}</div></div>
        <div><div class="label">Date received</div><div class="value">${escapeHtml(receipt.received_on)}</div></div>
        <div><div class="label">Payment method</div><div class="value">${escapeHtml(String(receipt.payment_method || '—').toUpperCase())}</div></div>
        <div><div class="label">Transaction reference</div><div class="value">${escapeHtml(receipt.external_reference || '—')}</div></div>
        <div><div class="label">Status</div><div class="value">${escapeHtml(status.toUpperCase() || 'UNKNOWN')}</div></div>
      </section>
      <table><thead><tr><th>Allocation / invoice</th><th class="right">Amount</th></tr></thead><tbody>
      ${allocationRows || '<tr><td>Receipt total</td><td class="right">' + escapeHtml(kes(receipt.amount)) + '</td></tr>'}
      </tbody></table>
      <div class="total">Receipt total: ${escapeHtml(kes(receipt.amount))}</div>
      ${receipt.notes ? '<p><strong>Notes:</strong> ' + escapeHtml(receipt.notes) + '</p>' : ''}
      <footer>Generated from the Precious SchoolBooks receipt register. Keep this receipt for your records.<br>Use the browser print dialog to print or save as PDF.</footer>
      <script>window.addEventListener('load',()=>setTimeout(()=>window.print(),250));</script></body></html>`;
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  };

  return <button type="button" className="sl-outline sl-action" onClick={printReceipt}>
    Print / Save PDF · {String(receipt.receipt_number ?? 'receipt')}
  </button>;
}
