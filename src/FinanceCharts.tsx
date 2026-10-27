import type { ReactElement } from 'react';

type TrendRow = Record<string, unknown>;

function amount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function kes(value: unknown): string {
  return new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(Number(value ?? 0));
}

export function FinanceCharts({ feeCollectionTrend, incomeExpenseTrend, academicTermSelected = false }: {
  feeCollectionTrend: TrendRow[];
  incomeExpenseTrend: TrendRow[];
  academicTermSelected?: boolean;
}): ReactElement {
  const collectionMax = Math.max(1, ...feeCollectionTrend.map(row => amount(row.collected)));
  const financeMax = Math.max(1, ...incomeExpenseTrend.flatMap(row => [amount(row.income), amount(row.expenses)]));

  return <div className="sl-dashboard-panels sl-finance-charts">
    <section className="sl-panel">
      <h2>Fee collection trend</h2>
      {feeCollectionTrend.length ? feeCollectionTrend.map(row => <div className="sl-chart-row" key={String(row.month)}>
        <span>{String(row.month)}</span>
        <progress value={amount(row.collected)} max={collectionMax} aria-label={`Fee collections ${String(row.month)}`} />
        <strong>{kes(row.collected)}</strong>
      </div>) : <p className="sl-muted">No posted fee collections for the selected dates.</p>}
    </section>
    <section className="sl-panel">
      <h2>Income vs expenses</h2>
      {academicTermSelected ? <p className="sl-muted">This chart is unavailable for a single academic term because expense records are not yet attributed to academic terms. Clear the term filter to compare income and expenses for the selected accounting dates.</p> : incomeExpenseTrend.length ? incomeExpenseTrend.map(row => <div className="sl-chart-group" key={String(row.month)}>
        <strong>{String(row.month)}</strong>
        <div className="sl-chart-row"><span>Income</span><progress value={amount(row.income)} max={financeMax} aria-label={`Income ${String(row.month)}`} /><b>{kes(row.income)}</b></div>
        <div className="sl-chart-row"><span>Expenses</span><progress value={amount(row.expenses)} max={financeMax} aria-label={`Expenses ${String(row.month)}`} /><b>{kes(row.expenses)}</b></div>
      </div>) : <p className="sl-muted">No posted income or expense journal activity for the selected dates.</p>}
    </section>
  </div>;
}
