# School Book Migration and Opening Balances

## Purpose

Precious SchoolBooks must support two onboarding paths:

1. **Greenfield setup** — a school starts recording transactions in the software from an agreed date.
2. **Existing-book migration** — a school moves from paper books or spreadsheets during an active financial year and needs a controlled opening position plus historical activity.

The second path is a core product workflow, not an exception or an unrestricted way to backdate journals.

## Accounting concepts that must remain separate

| Concept | Meaning | Required treatment |
|---|---|---|
| Financial year | The school's configured reporting year | Start and end dates are school-defined; do not assume January–December forever. |
| Accounting period | A posting-control window within a financial year | Every posted journal belongs to exactly one period. |
| Opening balances | Account balances at the agreed migration cut-off | Imported as a balanced opening journal dated at the cut-off, with supporting schedules where applicable. |
| Historical activity | Transactions that occurred after the opening cut-off and before go-live | Imported with original transaction dates, references and source evidence; never silently re-date to go-live. |
| Current activity | Transactions occurring after go-live | Entered through normal operational workflows. |
| Academic year / term | Education calendar context | Remains independent of the financial year and accounting period. |
| Reporting range | The dates included in a report | May span any valid contiguous date range; it does not itself unlock posting periods. |

## Recommended school onboarding journey

### 1. Migration assessment

Capture:
- School name and financial year start/end.
- Intended go-live date and opening-balance cut-off date.
- Source records available (cashbook, bank statements, fee registers, debtor/creditor schedules, payroll, asset register, general ledger and trial balance).
- Whether the school wants opening balances only or full historical transaction detail.
- Named preparer and independent reviewer.

Do not permit a migration to proceed until the cut-off and scope are explicit.

### 2. Chart of accounts mapping

Provide a downloadable template and mapping screen for:
- Source account code and name.
- Precious SchoolBooks account.
- Account type.
- Opening debit or credit balance.
- Mapping notes and evidence reference.

Reject unknown, inactive, cross-school or incompatible account mappings. Do not auto-create accounts silently. Require reviewer approval for new account mappings.

### 3. Opening balances

Opening balances must be entered as at one cut-off date and converted into one balanced journal (or a controlled set of opening journals where a school requires separate funds/classes).

Controls:
- Debits must equal credits exactly to the cent.
- Only active accounts belonging to the current school may be used.
- Assets, liabilities and equity must be mapped deliberately; do not force an unexplained difference into retained earnings or an arbitrary suspense account.
- The opening journal must carry a source type such as migration_opening_balance, an import/batch reference, preparer, reviewer and cut-off date.
- The system must prevent a second approved opening-balance batch for the same school and cut-off unless an authorized correction/reversal workflow is used.
- Preserve the source trial balance and reconciliation evidence.
- Posted opening journals are immutable and corrected only by linked reversals and replacement entries.

### 4. Historical transaction import

Historical activity is distinct from opening balances. Provide CSV/XLSX template download, upload, preview, row-level validation, account mapping, duplicate detection, review and posting.

Minimum import fields:
- Original transaction date.
- Description and source reference.
- Debit account and credit account (or balanced journal-line format).
- Amount in KES with two decimal places.
- Optional student, supplier, bank reference, academic term and source document reference.
- Import batch ID and original row number.

Import safeguards:
- Upload into a staging batch first; preview must not post financial records.
- Validate every row against the school's financial year, a matching accounting period, account ownership/status and balanced journal rules.
- Preserve original transaction dates and source references.
- Detect duplicates using a stable source fingerprint and explicit duplicate review; do not rely only on description or amount.
- Enforce bounded upload size, row count, file type and safe CSV/XLSX parsing.
- Reject formula payloads and never evaluate spreadsheet formulas.
- Show valid, invalid, duplicate and warning counts with downloadable error details.
- Require a separate authorized reviewer to approve the batch before posting.
- Post the approved batch atomically or in explicitly resumable, idempotent chunks with batch-level reconciliation; never leave a partially posted batch looking successful.
- Record who uploaded, mapped, reviewed, approved and posted the batch, with timestamps and audit events.
- Re-running an import must not create duplicate journals.

### 5. Reconciliation and sign-off

Before go-live, compare:
- Source and imported trial balance.
- Cashbook and bank balances at cut-off.
- Student fee debtor balances to student-level schedules.
- Supplier and other creditor balances to supporting schedules.
- Payroll liabilities and other material balances.
- Journal debit/credit totals and report totals.

Require preparer and independent reviewer sign-off. A balanced journal alone does not prove that the opening balances are correct.

## Posting and period policy

- A normal journal's posting date must fall within its selected open accounting period and financial year.
- Historical import must not bypass period controls or write directly around ledger APIs.
- If historical periods are locked, provide a privileged, audited migration authorization workflow. Do not unlock all periods globally.
- The migration workflow must identify which periods are temporarily authorized, who approved the authorization, its expiry/revocation, and which batch used it.
- After migration review, lock completed historical periods according to school policy.
- Corrections to posted entries use reversal and replacement; never edit posted journal lines.
- A custom reporting range never changes posting permissions.

## User experience requirements

The finance workspace should expose separate navigation/actions:
- **Financial year setup** — configure and review financial years and their posting periods.
- **Book migration** — assess, map, import, validate, reconcile and sign off.
- **Opening balances** — view the approved opening position and supporting schedules.
- **Transaction entry** — record normal activity using the actual transaction date.
- **Reports** — choose month, term, year-to-date, full financial year, previous financial year or a custom from/to range.

Replace raw ISO timestamps with readable date labels such as 01 Jan 2026 – 31 Dec 2026. A school must be able to report across multiple months without changing accounting-period status.

## Data model direction (implementation must be reviewed before migration)

Introduce tenant-scoped migration entities rather than inserting untrusted uploaded rows directly into the ledger:

- migration_batches: school, type (opening balances / historical activity), cut-off, source period, status, preparer, reviewer, counts, file checksum, timestamps.
- migration_batch_rows: batch, source row number, normalized payload, validation status, error codes, duplicate fingerprint, resulting journal reference.
- migration_approvals: batch, reviewer, decision, reason and timestamp.
- migration_period_authorizations: school, financial year/period, batch, approver, scope, expiry/revocation and audit metadata.

All tenant-owned records require school-scoped foreign keys, RLS policies, least-privilege grants, indexes and append-only audit evidence where appropriate. Exact constraints and RLS policies must be implemented in a reviewed database migration, tested against two schools, and run against a disposable database before production.

Do not add an independent migration ledger. Approved batches must create normal journal entries and journal lines through the existing posting invariants.

## Delivery sequence and acceptance gates

### Phase 1 — discovery and domain contract
- Confirm current financial-year/period APIs, posting transaction boundaries, permissions, RLS and audit conventions.
- Define cut-off semantics and supported source templates with an accountant.
- Confirm whether historical migration needs controlled access to locked periods or whether periods remain open until sign-off.

### Phase 2 — opening balances
- Database migration entities and permission codes.
- Opening balance preview and exact balance validation.
- Reviewer approval, idempotent posting, immutable journal and audit trail.
- Tests for unbalanced batches, duplicate opening batches, cross-school access, locked periods, reversals and retry safety.

### Phase 3 — historical import
- CSV/XLSX parser, staging, mapping, row validation and duplicate review.
- Separate preparer/reviewer workflow.
- Atomic or resumable idempotent posting with reconciliation totals.
- Tests for malformed files, formula injection, duplicate rows, out-of-year dates, locked periods, partial failures and cross-tenant access.

### Phase 4 — reconciliation and reporting
- Source-to-ledger reconciliation screens and evidence.
- Multi-month reporting across the selected financial year.
- Migration completion report and school sign-off.

### Phase 5 — pilot
- Run synthetic fixtures first.
- Pilot with a consenting school only after data protection, backup/restore and accountant review.
- Never use real school records in automated CI fixtures.

## Minimum acceptance scenarios

1. A school joining on 03 Nov 2026 can configure 01 Jan–31 Dec 2026 as its financial year.
2. The school can enter an opening trial balance as at 31 Dec 2025 and the system rejects any unbalanced result.
3. The school can import historical transactions dated Jan–Oct 2026 without re-dating them to November.
4. A historical row outside the configured financial year is rejected with a clear row-level reason.
5. An import preview creates no journals and changes no balances.
6. A preparer cannot approve their own batch; an authorized reviewer can approve or reject with a reason.
7. Replaying an approved batch cannot create duplicate journals.
8. A batch cannot post to another school's accounts or period.
9. A locked period cannot be bypassed without a batch-specific, approved, auditable authorization.
10. Posted migration journals are immutable and corrections use reversals.
11. Trial balance, cashbook, bank, fee debtor and creditor schedules reconcile to the source records.
12. The user can report Jan–Feb, Jan–Oct or any other valid date range without changing posting periods.
13. Migration status and audit history identify uploader, preparer, reviewer, approver and posting actor.
14. A disposable-database restore retains migration batches, audit evidence and resulting journals.

## Current implementation boundary

The existing application already has financial years, monthly accounting periods, double-entry journals, immutable posted entries, period-lock checks, tenant context/RLS and custom reporting dates. Those controls must be reused.

This document is a product and engineering contract. It does not claim that opening-balance or historical-import APIs already exist. Do not expose a migration screen that implies posting is supported until the corresponding backend, database constraints, permissions and tests are implemented.
