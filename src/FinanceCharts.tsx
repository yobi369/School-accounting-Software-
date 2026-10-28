import type { ReactElement } from 'react';

type TrendRow = Record<string, unknown>;

function amount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function kes(value: unknown): string {
  return 'KSh ' + Number(value ?? 0).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function monthLabel(value: unknown): string {
  const raw = String(value ?? '');
  const match = /^(\d{4})-(\d{2})$/.exec(raw);
  if (!match) return raw;
  return new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export function FinanceCharts({ feeCollectionTrend, incomeExpenseTrend, academicTermSelected = false }: {
  feeCollectionTrend: TrendRow[];
  incomeExpenseTrend: TrendRow[];
  academicTermSelected?: boolean;
}): ReactElement {
  const chartWidth = 720;
  const chartHeight = 245;
  const left = 52;
  const right = 18;
  const top = 18;
  const bottom = 42;
  const plotWidth = chartWidth - left - right;
  const plotHeight = chartHeight - top - bottom;
  const collectionMax = Math.max(1, ...feeCollectionTrend.map(row => amount(row.collected)));
  const financeMax = Math.max(1, ...incomeExpenseTrend.flatMap(row => [amount(row.income), amount(row.total_outflow ?? row.expenses)]));
  const collectionPoints = feeCollectionTrend.map((row, index) => ({
    x: left + (feeCollectionTrend.length < 2 ? plotWidth / 2 : index * plotWidth / (feeCollectionTrend.length - 1)),
    y: top + plotHeight - amount(row.collected) / collectionMax * plotHeight,
    row
  }));
  const incomePoints = incomeExpenseTrend.map((row, index) => ({
    x: left + (incomeExpenseTrend.length < 2 ? plotWidth / 2 : index * plotWidth / (incomeExpenseTrend.length - 1)),
    y: top + plotHeight - amount(row.income) / financeMax * plotHeight,
    row
  }));
  const outflowPoints = incomeExpenseTrend.map((row, index) => ({
    x: left + (incomeExpenseTrend.length < 2 ? plotWidth / 2 : index * plotWidth / (incomeExpenseTrend.length - 1)),
    y: top + plotHeight - amount(row.total_outflow ?? row.expenses) / financeMax * plotHeight,
    row
  }));
  const polyline = (points: { x: number; y: number }[]) => points.map(point => `${point.x},${point.y}`).join(' ');
  const gridLines = [0, 1, 2, 3, 4].map(index => top + index * plotHeight / 4);

  return <div className="sl-dashboard-panels sl-finance-charts">
    <section className="sl-panel sl-chart-panel">
      <div className="sl-section-title"><div><h2>Fee collection trend</h2><p>Actual posted receipts by month</p></div></div>
      {feeCollectionTrend.length ? <>
        <div className="sl-chart-legend"><span className="sl-legend-dot sl-legend-collections"/> Actual collections</div>
        <div className="sl-svg-chart-wrap"><svg className="sl-svg-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Monthly fee collection trend">
          {gridLines.map((y,index)=><g key={index}><line x1={left} x2={chartWidth-right} y1={y} y2={y} className="sl-chart-gridline"/><text x={left-8} y={y+4} textAnchor="end" className="sl-chart-axis">{Math.round(collectionMax*(4-index)/4).toLocaleString('en-KE')}</text></g>)}
          <polyline points={polyline(collectionPoints)} className="sl-chart-line sl-chart-line-collections"/>
          {collectionPoints.map(point=><g key={String(point.row.month)}><circle cx={point.x} cy={point.y} r="4" className="sl-chart-point sl-chart-point-collections"><title>{String(point.row.month)}: {kes(point.row.collected)}</title></circle><text x={point.x} y={chartHeight-16} textAnchor="middle" className="sl-chart-axis">{monthLabel(point.row.month)}</text></g>)}
        </svg></div>
        <div className="sl-chart-caption">Total in view: <strong>{kes(feeCollectionTrend.reduce((sum,row)=>sum+amount(row.collected),0))}</strong></div>
      </> : <p className="sl-muted">No posted fee collections for the selected dates.</p>}
    </section>
    <section className="sl-panel sl-chart-panel">
      <div className="sl-section-title"><div><h2>Actual income vs expenses</h2><p>Cash received compared with paid outflows, including payroll</p></div></div>
      {academicTermSelected && <p className="sl-chart-note">Collections follow the selected term. Expense outflows include only term-attributed expenses; payroll is shown by its payment date.</p>}
      {incomeExpenseTrend.length ? <>
        <div className="sl-chart-legend"><span className="sl-legend-dot sl-legend-income"/> Actual receipts <span className="sl-legend-dot sl-legend-outflow"/> Expenses + payroll</div>
        <div className="sl-svg-chart-wrap"><svg className="sl-svg-chart" viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label="Monthly actual receipts compared with expenses and payroll paid">
          {gridLines.map((y,index)=><g key={index}><line x1={left} x2={chartWidth-right} y1={y} y2={y} className="sl-chart-gridline"/><text x={left-8} y={y+4} textAnchor="end" className="sl-chart-axis">{Math.round(financeMax*(4-index)/4).toLocaleString('en-KE')}</text></g>)}
          <polyline points={polyline(incomePoints)} className="sl-chart-line sl-chart-line-income"/>
          <polyline points={polyline(outflowPoints)} className="sl-chart-line sl-chart-line-outflow"/>
          {incomeExpenseTrend.map((row,index)=>{const x=left+(incomeExpenseTrend.length<2?plotWidth/2:index*plotWidth/(incomeExpenseTrend.length-1));return <g key={String(row.month)}><circle cx={incomePoints[index].x} cy={incomePoints[index].y} r="3.5" className="sl-chart-point sl-chart-point-income"><title>{String(row.month)} receipts: {kes(row.income)}</title></circle><circle cx={outflowPoints[index].x} cy={outflowPoints[index].y} r="3.5" className="sl-chart-point sl-chart-point-outflow"><title>{String(row.month)} paid outflow: {kes(row.total_outflow ?? row.expenses)}</title></circle><text x={x} y={chartHeight-16} textAnchor="middle" className="sl-chart-axis">{monthLabel(row.month)}</text></g>;})}
        </svg></div>
        <div className="sl-chart-caption">Actual receipts <strong>{kes(incomeExpenseTrend.reduce((sum,row)=>sum+amount(row.income),0))}</strong><span>Paid outflows <strong>{kes(incomeExpenseTrend.reduce((sum,row)=>sum+amount(row.total_outflow ?? row.expenses),0))}</strong></span></div>
      </> : <p className="sl-muted">No posted receipts or paid expenses/payroll for the selected dates.</p>}
    </section>
  </div>;
}
