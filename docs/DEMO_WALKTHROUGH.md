# Precious SchoolBooks — recruiter demonstration walkthrough

**Purpose:** a short, repeatable walkthrough of the product's intended school-finance workflows using fictional records. It is written for reviewers, recruiters, and supervised pilot evaluators.

**Demo status:** this document is a walkthrough plan, not evidence that the hosted instance has been provisioned with this fixture or that every scenario has been executed. Do not assume demo credentials exist. Use a fresh local or explicitly designated synthetic environment and follow the [local installation guide](LOCAL_INSTALLATION.md) and [pilot runbook](SAME_DAY_SCHOOL_PILOT_RUNBOOK.md).

> **Safety:** synthetic data only. Never enter real pupil, parent, employee, bank, tax, or school-finance information into a demonstration environment. Do not use the public hosted pilot for real financial records. Production use remains gated on deployment checks, a provider-level restore drill, role/RLS verification, and independent school-accountant acceptance.

## 1. What to evaluate

Precious SchoolBooks is a Kenyan school-finance workspace built around:

- Student records and fee invoices.
- Receipt capture and controlled allocation to invoices.
- Expense submission, approval, and payment workflows.
- Double-entry journals and traceable correction through reversals.
- Bank-statement CSV import and reconciliation.
- Ledger-backed financial reports and CSV/XLSX/PDF exports.
- School-scoped access controls and PostgreSQL row-level security.
- An installable PWA shell with offline expense drafts only; drafts remain pending until server acceptance and approval.

## 2. Start with a safe environment

1. Use a fresh local installation or a separately designated synthetic pilot database. Do not reuse a school's live database.
2. Follow [Local Installation](LOCAL_INSTALLATION.md). The application requires Node.js 22+ and PostgreSQL 16+.
3. Provision one fictional school using the bootstrap procedure in the [pilot runbook](SAME_DAY_SCHOOL_PILOT_RUNBOOK.md). Use an `.invalid` email domain and unique temporary credentials.
4. Rotate or remove the temporary bootstrap token after provisioning.
5. Sign in and confirm the first-login password-change behavior.
6. Create distinct test identities for administrator, bursar/receipt clerk, expense requester, approver, payment operator, and read-only reviewer where the current role model permits. Record unsupported role separations as gaps.
7. Use the application's configured chart of accounts and have an accountant/reviewer confirm the mappings before posting transactions.

No shared demo username or password is published in this repository. Never request or publish a user's production credentials.

## 3. Synthetic scenario

Use the following fictional values as a compact, reproducible demonstration. They are test inputs, not existing records in the hosted service.

| Record | Synthetic value |
|---|---|
| School | Demo Primary School (TEST ONLY) |
| Currency / timezone | KES / Africa/Nairobi |
| Student | Demo Learner 001 |
| Student reference | STU-SYN-001 |
| Invoice | INV-SYN-001 — KES 1,000.00 |
| First receipt | RCP-SYN-001 — KES 400.00 |
| Final receipt | RCP-SYN-002 — KES 600.00 |
| Expense | EXP-SYN-001 — KES 200.00 |
| Synthetic M-Pesa reference (only if testing that payment method) | SYNMPESA0001 |
| Synthetic bank reference (only if testing bank receipt flow) | SYNBANK0001 |

Use unique synthetic references in the disposable environment. Do not assume account codes; record the actual configured account IDs/names and verify them with the reviewer.

## 4. Walkthrough sequence

### A. School setup and access boundaries

- Provision the synthetic school and initial administrator.
- Confirm the initial password-change flow.
- Create the available test roles and inspect what each role can access.
- If testing multi-school isolation, create a second synthetic school with separate users and records. Attempt cross-school reads and writes only in the disposable test environment.
- Review audit events for setup and role changes.

**Show the reviewer:** the school workspace, role configuration, and evidence of denied unauthorized actions. A hidden button alone is not proof of authorization; verify the API/server-side result.

### B. Student and fee collection

- Create the fictional student STU-SYN-001 and assign the appropriate synthetic class/year context.
- Issue INV-SYN-001 for KES 1,000.00.
- Record and allocate RCP-SYN-001 for KES 400.00.
- Verify the invoice's outstanding balance is KES 600.00 and its state is part-paid.
- Record and allocate RCP-SYN-002 for KES 600.00.
- Verify the outstanding balance is KES 0.00 and the invoice is paid.
- Retry a receipt request with the same idempotency key, where the interface/test supports it, and verify no duplicate financial effect is created.

**Expected arithmetic:** KES 1,000.00 invoice − KES 400.00 first allocation = KES 600.00 outstanding; after the KES 600.00 final allocation, outstanding = KES 0.00.

### C. Expense controls

- Submit EXP-SYN-001 for KES 200.00 as the requester.
- Attempt self-approval and confirm it is rejected.
- Have a distinct authorized approver approve the expense.
- Have the authorized payment operator record payment where maker-checker separation requires a separate actor.
- Inspect the expense status, linked payment, journal, and audit trail.

**Expected control:** a submitted expense should not become a paid expense merely because it was entered. Verify each allowed transition and actor against the configured role policy.

### D. Journals and reconciliation

- Inspect the journals created by the fee and expense scenarios.
- Confirm each posted journal balances: total debits equal total credits exactly to the cent.
- Import a bank CSV containing only synthetic statement lines in the disposable environment.
- Match a synthetic line to the intended ledger transaction and inspect unmatched/duplicate lines.
- Confirm importing a statement does not silently post a financial transaction.
- If testing corrections, use the supported reversal/replacement flow; do not edit or delete posted journals.

### E. Reports and exports

Compare the source records and the relevant available reports, including:

- Trial balance and general ledger.
- Income statement and balance sheet.
- Cashbook/bankbook.
- Receipts register and invoice register.
- Fee balances and expense register.
- Journal register and audit trail.

Export representative reports as CSV, XLSX, and PDF. Independently compare totals, dates, and decimal amounts with the synthetic source records. Do not treat a successful export as proof that accounting totals are correct.

For this small fixture, the source totals are KES 1,000.00 in receipts and KES 200.00 in expenses, with the invoice fully allocated. These totals do not prove that the chart of accounts or every financial statement is correct; the reviewer must validate the actual account mappings and report balances.

### F. Offline behavior

- On a supported device, disconnect from the network and create an expense draft.
- Reconnect and observe the draft synchronization/acceptance flow.
- Confirm that a draft remains pending until server acceptance and any required approval.
- Do not present offline mode as full offline accounting: the documented queue supports expense drafts only; other financial actions require connectivity.

## 5. Evidence checklist

For each scenario, record the tester/role, execution date in Africa/Nairobi, result, evidence reference, and defect or reviewer note.

- [ ] School bootstrap and first-login behavior
- [ ] Role permissions and denied actions
- [ ] Student and invoice fixture
- [ ] Part-payment and final allocation balances
- [ ] Expense requester/approver/payment separation
- [ ] Balanced journals and reversal traceability
- [ ] Bank import and reconciliation behavior
- [ ] Report-to-source reconciliation
- [ ] CSV/XLSX/PDF export review
- [ ] Offline expense-draft behavior
- [ ] Cross-school isolation, if in scope
- [ ] Disposable backup/restore evidence

Mark a case **PASS** only after it has been executed and evidence captured. Use **FAIL**, **BLOCKED**, or **NOT RUN** honestly. CI success is evidence only for the automated checks that CI actually performs; it is not school or accountant sign-off.

## 6. Engineering behind the product

The repository documents a React + TypeScript frontend, Node.js + Express API, and PostgreSQL persistence. The engineering foundations include:

- Versioned SQL migrations and school-scoped relational constraints.
- PostgreSQL row-level security and server-side permission checks.
- Password hashing, expiring bearer sessions, and login throttling.
- Transactional ledger posting, idempotency records, and append-only audit events.
- Immutable posted journals with reversal-based correction.
- Automated type checks, tests, builds, PostgreSQL integration checks, and disposable database backup/restore smoke checks in CI.

Review the [CI workflow](../.github/workflows/ci.yml), [production smoke workflow](../.github/workflows/production-smoke.yml), [school acceptance test](SCHOOL_ACCEPTANCE_TEST.md), and [synthetic acceptance pack](SYNTHETIC_SCHOOL_ACCEPTANCE_PACK.md) for verification boundaries and detailed cases.

## 7. Current limitations and honest status

The repository's current product notes identify the following as incomplete or requiring further acceptance:

- M-Pesa and KRA eTIMS are not complete integrations.
- SMS/email delivery, managed backup scheduling, and multi-factor authentication are not complete.
- Offline support is limited to expense drafts.
- Provider-level encrypted backup/restore, production runtime-role/RLS checks, and independent accountant acceptance must be evidenced for the actual deployment.
- Export contents and accounting reports still require reconciliation against source ledger records during acceptance.

The latest documented CI and production smoke checks are automated engineering signals, not proof of production certification or approval for live school financial records.

## 8. Related documentation

- [Local installation](LOCAL_INSTALLATION.md)
- [Same-day supervised pilot runbook](SAME_DAY_SCHOOL_PILOT_RUNBOOK.md)
- [School acceptance test](SCHOOL_ACCEPTANCE_TEST.md)
- [Synthetic-school acceptance pack](SYNTHETIC_SCHOOL_ACCEPTANCE_PACK.md)
- [Deployment checklist](DEPLOYMENT.md)
- [Backup and recovery](BACKUPS_AND_RECOVERY.md)
