# School book migration runbook

## Scope and safety

The migration workspace is school-scoped. It stages opening balances and historical transactions separately; staged rows are not ledger entries. A batch must be prepared by one user and reviewed by a different user with the migration approval permission before it can be posted.

**Do not import a school's live books into a production workspace until the accountant and school administrator have signed off the source totals, cut-off date, account mapping, and reconciliation.** Use a disposable school workspace for rehearsals.

## Choose the migration cut-off

- An opening-balance batch records the school's financial position at the stated cut-off date.
- A historical-transactions batch contains only activity dated **before** that cut-off date.
- This boundary is enforced when rows are staged. It prevents the same activity from being counted once in historical journals and again in the opening position.
- Historical transaction dates are retained; they are not rewritten to the cut-off date.
- Each historical date is checked against an open financial year and open accounting period during submission. The journal posting service checks the period again at posting time.
- A closed period is not silently reopened by a custom report range or migration import.

## Prepare the source workbook

Before entry, preserve an untouched copy of the original cashbook, bank statements, fee records, supplier ledgers, payroll summaries, and trial balance. Record the file name, source owner, extraction date, and the cut-off date in the batch description/source label.

Map every source account to an active account code in the same school's chart of accounts. Do not map by account name alone where codes differ. Resolve suspense, control-account, and retained-surplus balances with the school's accountant before staging.

### Staged row format

The current workspace accepts mapped rows as JSON. CSV/XLSX file upload, column-mapping wizard, and one-click import preview are follow-on work and are not yet available.

Each row must contain:

- `accountCode`: active account code belonging to this school.
- `debit` and `credit`: decimal KES strings with no more than two decimal places; exactly one side must be positive.
- `memo`: optional explanation.
- `transactionDate`: required for historical transactions and must be earlier than the opening-balance cut-off.
- `externalReference`: optional source voucher, receipt, bank, or cashbook reference. It is stored separately and included in the posted journal line memo for traceability.

Example historical transaction lines for one source voucher:

```json
[
  {
    "accountCode": "1000",
    "debit": "12500.00",
    "credit": "0.00",
    "memo": "Cash received",
    "transactionDate": "2025-12-15",
    "externalReference": "RCPT-2025-0184"
  },
  {
    "accountCode": "4000",
    "debit": "0.00",
    "credit": "12500.00",
    "memo": "Fee income",
    "transactionDate": "2025-12-15",
    "externalReference": "RCPT-2025-0184"
  }
]
```

## Workflow

1. Create the batch and select the type and cut-off/reference date.
2. Stage mapped rows. The API validates school-owned active accounts, decimal KES amounts, one-sided lines, historical dates, and duplicate row fingerprints.
3. Inspect staged rows and compare totals with the source schedules.
4. Submit. The batch is frozen; opening balances must balance overall, and historical transactions must balance separately for each original transaction date. Every posting date must be in an open financial year and period.
5. A different authorized user reviews the source evidence and approves or rejects the batch.
6. Post only after approval. Posting is performed inside a school-scoped database transaction. Posted journals are immutable; corrections must use the existing reversal process.
7. Open the reconciliation report. Compare source row count, source debit/credit totals, posted journal count, posted debit/credit totals, and differences. A batch is reconciled only when posted totals and expected journal counts match.
8. Archive the source files, mapping decisions, reviewer note, and reconciliation report with the school's accounting records.

## Reconciliation and sign-off

For each migration, the preparer and reviewer should independently verify:

- The opening trial balance agrees with the source at the cut-off.
- Historical transactions are dated before the cut-off and agree with the original transaction register.
- Debits equal credits for every historical transaction date.
- No voucher/reference is intentionally omitted or imported twice.
- Cash, bank, fee receivables, supplier payables, payroll liabilities, and equity/control balances agree to supporting schedules.
- The posted ledger agrees to the source totals and has no unexplained reconciliation difference.
- The relevant financial years and accounting periods were open at posting time.

Record the preparer, reviewer, date, source files, cut-off, account mapping, exceptions, and school accountant/administrator sign-off. Do not delete or edit posted journals to resolve differences; use audited reversals and corrected replacement entries.

## Current implementation boundary

Implemented in this branch: school-isolated migration batches and rows; independent approval records; immutable submitted batches and approvals; opening-balance posting; historical journals grouped by original date; source-reference persistence; cut-off and open-period enforcement; repeat-safe posting responses; migration register UI; source-to-ledger reconciliation endpoint and UI.

Still outstanding before production use: CSV/XLSX upload and column-mapping preview, comprehensive API-level posting tests (including reversals and closed periods), full migration acceptance rehearsal on synthetic school data, independent accountant/administrator sign-off, production smoke testing, and backup/restore evidence for a migration rehearsal.
