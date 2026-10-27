# ShuleLedger improvement roadmap

## Purpose

Implement the school-management feedback as an accounting-first evolution of ShuleLedger. Keep existing ledger posting, school isolation, permission checks, append-only audit records, and reversal controls as the source of truth. Do not calculate financial figures from UI-only state or offline drafts.

## Delivery principles

- KES amounts must use the existing exact-decimal/minor-unit domain helpers; no floating-point accounting arithmetic.
- All tenant-scoped data access must enforce the authenticated school context and database integrity rules.
- Posted financial records must be immutable. Correct them through authorized, reason-required reversals with linked audit events.
- Dashboard and reports must derive from posted server-side records and respect selected academic year, term/accounting period, and class filters where applicable.
- Use synthetic data in acceptance tests. Do not claim production readiness until tests, database migrations, deployment checks, and an accountant-led reconciliation pass.
- Keep the deployment on existing no-cost resources unless the owner explicitly approves a cost. Document any backup, storage, rate-limit, or integration limitation that remains.

## Workstreams and acceptance criteria

### 1. Finance-focused overview
- KPI cards: fees billed, fees collected, outstanding fees, collection rate, expenses, payroll, cash, bank, M-Pesa, and net balance.
- Add fee-collection trend and income-versus-expense charts sourced from server report endpoints.
- Add recent payments, pending approvals, and highest outstanding student accounts.
- Empty states must distinguish zero activity from unavailable data.
- **Implemented in this branch (CI run 40482931482 passed):** removed invitation acceptance from the dashboard; added a global financial-year/accounting-period selector; propagated date filters to overview and supported reports/exports; added billed, collected, outstanding, collection-rate, paid-expense, pending-approval, and approved-unpaid KPIs; added recent payments, pending approvals, and top outstanding accounts; added a school-scoped student account statement with running balance; added monthly fee-collection and ledger-derived income/expense series with accessible progress-bar charts; added a school-scoped receipt register showing student, payment method, reference, status, journal linkage, and invoice allocations.
- **Implemented and verified by CI run 40482931482:** class fee structures with itemized amounts, class/year/term labels and due dates; explicit activation before use; idempotent bulk invoice creation for active students in the selected class; invoice-to-structure linkage with a database uniqueness constraint; per-invoice ledger posting and audit events; repeated bulk runs skip already-invoiced students. The fee structure schema and API use the existing `fees.read` / `fees.manage` permissions and school-scoped RLS.
- **Dedicated academic calendar implemented on this branch:** migration 0023 adds school-scoped academic years and terms with forced row-level security, valid date ranges, non-overlapping years/terms, year-contained terms, and audited term/year closure. API routes require `ledger.read` for viewing and `periods.manage` for changes. Settings UI supports creating and viewing academic years/terms and closing them with a required reason; an academic year cannot close while any term remains open. Date-range unit tests cover valid, reversed, malformed, and impossible dates. Academic dates remain separate from accounting periods. The fee-structure integration now adds a nullable school-scoped academic-term foreign key in migration 0026 (after existing migration 0025), preserving legacy structures, validating open year/term and due-date containment, and blocking bulk invoicing after the linked term/year closes. The Fees screen offers an academic-term selector. Report filters now pass a selected academic-term ID through report endpoints and CSV/XLSX/PDF exports; invoice register, fee balances, fee aging, collections-by-method, and fees-by-class queries apply it server-side, including closed terms for historical reporting. A PostgreSQL-backed integration test covers term-scoped invoice-register and fee-balance reports, CSV export, invalid term IDs, and empty results for an unrecognized term ID. The invoice list and student financial statement endpoints accept academic-term filters, with term-scoped receipt allocations and balances. The dashboard now filters billed fees, outstanding balances, collection rate, allocated collections, recent payments, top arrears, and the monthly collection trend by selected academic term. The income-versus-expense chart explicitly explains why it is not shown under an academic-term filter: expense records are not yet attributed to academic terms. A PostgreSQL integration regression test confirms bulk invoicing is rejected after a linked term is closed and creates no invoice. CI run 40486073196 passed typecheck, all automated tests, production build, database migrations, least-privilege checks, plain and encrypted backup/restore drills, Docker build, and local Compose API smoke tests. Still outstanding: term attribution for expense reporting and independent hosted acceptance verification.

- **Student profile fields and editing implemented on this branch:** migration 0022 adds optional sex, date of birth, guardian relationship/alternate phone, home address, and emergency contact name/phone. The school-scoped API validates and persists these fields, list and financial-account responses return them, and the UI supports registration, viewing, and editing. Updates require `students.manage`, are school-scoped, and are audit-logged. PostgreSQL integration coverage checks field persistence and cross-school isolation; focused schema tests cover supported sex values and birth-date validation. CI run 40461639731 passed on the current profile-edit implementation, including typecheck, tests, production build, database migrations, backup/restore drills, container build, and local Compose API smoke test. The configured production-deployment smoke test was skipped, so hosted deployment behavior remains unverified. **Database enforcement strengthened in migration 0025:** academic-year date ranges are serialized per school and overlapping years are rejected by PostgreSQL; term writes are checked against their parent year, overlapping sibling terms are rejected, and a year cannot be closed while any term remains open. These invariants no longer rely only on API validation. **Still outstanding:** payroll and dedicated cash/bank/M-Pesa balance KPIs, propagation of academic-term filters into fee/report queries, and production schema/data verification. Receipt reversal is now exposed in the receipt register for posted receipts with a linked journal; it requires a reason and confirmation and calls the existing server-side reversal endpoint, which posts a compensating journal and marks the original receipt reversed. The receipt register now has a print-friendly receipt view that opens the browser print dialog (including Save as PDF); the receipt details are escaped before rendering, and reversed receipts are prominently marked as invalid proof of current payment. Do not label accounting periods as academic terms.

### 2. Academic year and term context
- Add a global academic-year/term selector with an explicit “all periods” option only where supported.
- Propagate selected filters to dashboard cards, charts, student balances, and reports.
- Prevent edits/postings into closed financial periods at both API and database boundaries; provide controlled close/reopen permissions and audit reasons.
- Test date boundaries, year changes, closed terms, and cross-period allocations.

### 3. Student financial account
- Student profile tabs: Profile, Fee Account, Invoices, Payments, Statements, and Documents.
- Show an auditable running balance from invoices, approved adjustments/waivers, receipts, allocations, arrears, and reversals.
- Add statement export and reconcile each displayed balance to the ledger.
- Test partial payments, overpayments, unapplied receipts, waivers, reversals, and carried-forward arrears.

### 4. Fee structures and billing
- Fee structures by class, academic year, and term, with itemized tuition, meals, transport, activity fees, and configurable items.
- Bulk invoice an entire class idempotently; prevent duplicate invoices for the same student/structure/period.
- Support authorized discounts/scholarships, adjustments, and arrears carry-forward with reason, approval, and audit trail.
- Preview totals before posting; never silently overwrite existing invoices.

### 5. Payments and receipts
- Separate invoicing screens from payment/receipt workflows.
- Generate unique server-side receipt numbers; do not trust client-provided uniqueness.
- Receipt details: student, admission number, class, academic year/term, amount, method, transaction reference, previous balance, and new balance.
- Provide print-friendly receipt and PDF/reprint using the original posted record.
- Void/reverse requires permission and a mandatory reason; preserve the original record and audit linkage.

### 6. Cash, bank, and M-Pesa
- Separate cash, bank, and M-Pesa control accounts and balances.
- Reconcile imported bank/M-Pesa statements, track unmatched items, and prevent duplicate imports/postings.
- Add an unmatched M-Pesa queue with safe manual assignment and audit history.
- Safaricom Daraja is a later integration: implement only after credentials, callback verification, idempotency, reconciliation, and sandbox tests are available. Do not simulate a live integration.

### 7. Expense approvals
- Enforce Draft → Submitted → Approved → Paid transitions on the server.
- Capture payee/supplier, category, description, amount, payment account/method, supporting document metadata, requester, approver, and payer.
- Separate permissions for submit, approve, and pay; prevent self-approval where policy requires.
- Reverse/void posted expenses with reason and linked audit event, never hard-delete.

### 8. Staff and payroll
- Staff register, salary components, configurable allowances/deductions, payroll runs, approvals, salary payments, payslips, and reports.
- Restrict salary data and payroll actions with dedicated permissions.
- Keep statutory deduction configuration explicit and versioned; validate current Kenyan statutory rates before enabling production calculations.
- Reconcile payroll journals to salary payments and ledger control accounts.

### 9. Financial reports
- Fee collection, arrears/outstanding fees, student and class balances, daily collections, payment methods, expenses, payroll, cash/bank/M-Pesa, income & expenditure, trial balance, and general ledger.
- Date, academic-year, term, and class filters must be server-side and consistent.
- Support CSV/XLSX/PDF and print-friendly output with school identity, filter criteria, generation timestamp, and totals.
- Report totals must reconcile to the posted ledger; test exports against known fixtures.

### 10. Users and permissions
- Support Director, Accountant/Bursar, Headteacher, Teacher, and Auditor role templates, while preserving configurable least-privilege roles.
- Use specific permissions for payroll read/manage, bank reconciliation, journal posting, receipt reversal, expense approval/payment, period closing, backup/restore, and report export.
- Enforce permissions server-side, not only by hiding UI controls. Add negative authorization tests for each sensitive action.

### 11. Audit trail
- Record actor, timestamp, action, entity, before/after change summary where safe, and reason for reversals/voids.
- Ensure failed and rejected sensitive actions are observable without storing secrets or passwords.
- Keep posted accounting records append-only; verify audit events are transactionally committed with the financial operation.

### 12. Backup and restore
- Show last successful backup, backup history, and last verified restore.
- Provide an authenticated manual export and documented scheduled/off-site encrypted backup process where the hosting plan supports it.
- Test restore into a clean database and verify row counts, constraints, school isolation, ledger balances, and audit continuity.
- Do not present a download/export as a verified backup until restore testing has succeeded. Keep provider/free-tier durability limits visible.

### 13. Usability and accessibility
- Improve KPI hierarchy, readable numbers, mobile layouts, table search/filtering, pagination, keyboard access, and clear empty/error/loading states.
- Preserve ShuleLedger's existing visual identity and responsive layout.
- Never use sample values as if they were live financial results.

## Recommended implementation sequence

1. Dashboard and invitation navigation cleanup.
2. Global academic-year/term filters and closed-period protections.
3. Student account/statement and running-balance correctness.
4. Fee structures, safe bulk invoicing, and arrears.
5. Receipt numbering, printable receipts, and reversal workflow.
6. Expense workflow, bank/M-Pesa reconciliation, and granular permissions.
7. Finance dashboard charts and reconciled report filters.
8. Payroll module.
9. Backup history/restore verification and final acceptance testing.
10. Daraja integration only after sandbox credentials and callback requirements are ready.

## Release gate

For every workstream: migration review, typecheck, automated tests, authorization tests, responsive UI check, and live smoke test where safe. Do not call the system production-ready solely because the deployment is online or the CI build passes.