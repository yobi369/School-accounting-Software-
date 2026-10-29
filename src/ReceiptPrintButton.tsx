import type { ReactElement } from 'react';

type ReceiptAllocation = { invoiceNumber?: string; academicYear?: string; termName?: string; amount?: string | number };
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
  school_name?: string;
  class_name?: string;
  previous_balance?: string | number | null;
  new_balance?: string | number | null;
  received_by_name?: string | null;
  student_credit_amount?: string | number | null;
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


function amountInWords(value: unknown): string {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return 'Amount unavailable';
  const ones = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const tens = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  const words = (n: number): string => {
    if (n < 20) return ones[n];
    if (n < 100) return tens[Math.floor(n / 10)] + (n % 10 ? '-' + ones[n % 10] : '');
    if (n < 1000) return ones[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + words(n % 100) : '');
    for (const [unit, label] of [[1_000_000_000,'billion'],[1_000_000,'million'],[1000,'thousand']] as const) {
      if (n >= unit) return words(Math.floor(n / unit)) + ' ' + label + (n % unit ? ' ' + words(n % unit) : '');
    }
    return String(n);
  };
  const cents = Math.round(amount * 100);
  return words(Math.floor(cents / 100)) + ' Kenya shillings' + (cents % 100 ? ' and ' + words(cents % 100) + ' cents' : '') + ' only';
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
      `<tr><td>${escapeHtml(item.invoiceNumber || 'Fee invoice')}<br><small>${escapeHtml([item.academicYear,item.termName].filter(Boolean).join(' · '))}</small></td><td class="right">${escapeHtml(kes(item.amount))}</td></tr>`
    ).join('');
    const firstAllocation = allocations[0];
    const receivedDate = receipt.received_on ? new Intl.DateTimeFormat('en-KE',{day:'2-digit',month:'short',year:'numeric'}).format(new Date(receipt.received_on)) : '—';
    const status = String(receipt.status ?? '').toLowerCase();
    const reversed = status === 'reversed';
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Receipt ${escapeHtml(receipt.receipt_number)}</title>
      <style>
        body{font:14px/1.5 Arial,sans-serif;color:#17211d;margin:32px auto;max-width:720px;padding:0 20px}
        header{text-align:center;border-bottom:2px solid #245d4c;padding-bottom:16px;margin-bottom:20px}.brandmark{display:inline-grid;place-items:center;width:48px;height:48px;border-radius:12px;background:#245d4c;color:#fff;font-weight:800;letter-spacing:.04em;margin-bottom:8px}
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
      <header><div class="brandmark" aria-label="Precious SchoolBooks mark">PSB</div><h1>${escapeHtml(receipt.school_name || 'School')}</h1><p class="muted">Official Fee Receipt</p><h2>Receipt No. ${escapeHtml(receipt.receipt_number)}</h2>
      ${reversed ? '<div class="status">REVERSED — NOT VALID AS PROOF OF CURRENT PAYMENT</div>' : '<div class="status">POSTED</div>'}</header>
      ${reversed ? '<p class="notice">This receipt has been reversed. Retain this copy for the audit trail; it does not represent an active payment.</p>' : ''}
      <section class="details">
        <div><div class="label">Student</div><div class="value">${escapeHtml(receipt.student_name)}</div></div>
        <div><div class="label">Admission number</div><div class="value">${escapeHtml(receipt.admission_number || '—')}</div></div>
        <div><div class="label">Date received</div><div class="value">${escapeHtml(receivedDate)}</div></div>
        <div><div class="label">Class</div><div class="value">${escapeHtml(receipt.class_name || '—')}</div></div>
        <div><div class="label">Academic year / term</div><div class="value">${escapeHtml([firstAllocation?.academicYear,firstAllocation?.termName].filter(Boolean).join(' · ') || '—')}</div></div>
        <div><div class="label">Payment method</div><div class="value">${escapeHtml(String(receipt.payment_method || '—').toUpperCase())}</div></div>
        <div><div class="label">Transaction reference</div><div class="value">${escapeHtml(receipt.external_reference || '—')}</div></div>
        <div><div><div class="label">Received by</div><div class="value">${escapeHtml(receipt.received_by_name || '—')}</div></div>
        <div><div class="label">Status</div><div class="value">${escapeHtml(status.toUpperCase() || 'UNKNOWN')}</div></div>
      </section>
      <table><thead><tr><th>Allocation / invoice</th><th class="right">Amount</th></tr></thead><tbody>
      ${allocationRows || '<tr><td>Receipt total</td><td class="right">' + escapeHtml(kes(receipt.amount)) + '</td></tr>'}
      </tbody></table>
      <p><strong>Amount in words:</strong> ${escapeHtml(amountInWords(receipt.amount))}</p>
      <div class="total">Amount paid: ${escapeHtml(kes(receipt.amount))}</div>
      ${Number(receipt.student_credit_amount ?? 0) > 0 ? '<p><strong>Unallocated student credit created:</strong> ' + escapeHtml(kes(receipt.student_credit_amount)) + '</p>' : ''}
      <section class="details"><div><div class="label">Previous balance</div><div class="value">${escapeHtml(kes(receipt.previous_balance))}</div></div><div><div class="label">New balance</div><div class="value">${escapeHtml(kes(receipt.new_balance))}</div></div></section>
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
