# Synthetic-school accounting acceptance and sign-off pack

**Purpose:** provide a repeatable, evidence-led acceptance run for Precious SchoolBooks (ShuleLedger) before any real school financial data is entered.

**Status:** preparation pack only. It is not evidence that the cases have been executed, and it is not an accountant's or school administrator's approval. Keep production readiness unattested until the required human reviewers complete and sign this pack.

## Safety rules

- Use a disposable/local or explicitly designated synthetic pilot school only.
- Use fictional names, student numbers, payment references, suppliers, and bank statement rows. Never copy real student or financial data into test fixtures.
- Do not create, reverse, or edit live financial records for acceptance testing.
- Record a case as **PASS** only when the tester performed the steps and attached evidence. Use **FAIL** for a mismatch, **BLOCKED** when the environment or permissions prevent the test, and **NOT RUN** otherwise.
- Capture evidence references (redacted screenshots, report exports, journal IDs, audit event IDs, CI run links) without passwords, session tokens, secrets, or personal data.
- Do not approve a case merely because CI is green. CI results prove only the checks that CI actually ran.

## Roles and independence

Use distinct test identities where the permission model supports them:

1. **School administrator:** provisions the synthetic school, configures terms/classes and users, and verifies access boundaries.
2. **Bursar/receipt clerk:** issues invoices and records receipts.
3. **Accountant/reviewer:** independently checks allocations, journals, trial balance, cashbook, and reports.
4. **Expense requester:** submits a synthetic expense.
5. **Expense approver:** approves or rejects it; must not be the requester.
6. **Payment operator:** records payment where maker-checker separation requires a separate actor.
7. **Auditor/read-only user:** verifies visibility and cannot mutate financial records.

If the system's current role model does not support one of these roles, record that as a gap rather than silently using an administrator account for every step.

## Synthetic fixture

Create a new school with currency **KES**, timezone **Africa/Nairobi**, a single open financial year and period, one class, and one fictional student. Configure and verify the actual ledger mappings in the application before posting.

| Fixture ID | Record | Value |
|---|---|---:|
| STU-SYN-001 | Fictional student | No real personal details |
| INV-SYN-001 | Term fee invoice | KES 1,000.00 |
| RCP-SYN-001 | First cash receipt | KES 400.00 |
| RCP-SYN-002 | Final cash receipt | KES 600.00 |
| EXP-SYN-001 | Approved administration expense | KES 200.00 |
| MPA-SYN-001 | Synthetic M-Pesa reference | `SYNMPESA0001` |
| BNK-SYN-001 | Synthetic bank receipt reference | `SYNBANK0001` |

Do not reuse a reference that could collide with real provider data. Do not assume a particular account code: record the actual configured account IDs/names and have the accountant confirm they are appropriate.

## Acceptance cases

For every case, record: **status, tester name/role, execution date (Africa/Nairobi), evidence reference, defect/ticket, reviewer notes**.

### A. Access, setup, and auditability

| ID | Steps | Expected result |
|---|---|---|
| A01 | Provision a new synthetic school and sign in with the initial administrator. | School is created once; the initial-password flow is enforced as configured; no second school is created accidentally. |
| A02 | Attempt a second bootstrap using the same one-time setup credential after provisioning. | Bootstrap is rejected or otherwise safely disabled/rotated according to deployment procedure. |
| A03 | Sign in as each available role and attempt allowed and forbidden actions. | Server-side permissions are enforced; hidden UI controls are not the only protection. |
| A04 | Attempt self-approval of an expense and, where configured, payment by the same actor who approved it. | Separation-of-duties rules are enforced and rejected actions leave no posted financial effects. |
| A05 | With two synthetic schools, try to read or mutate the other school's student, invoice, receipt, expense, journal, report, audit, and user records by changing IDs. | Cross-school access is denied; no data leaks and no unauthorized writes occur. |
| A06 | Review audit events for setup, role changes, rejected attempts, posting, reversal, and approvals. | Material actions have attributable audit evidence without exposing credentials or session tokens. |

### B. Fees, receipts, allocation, and reversals

| ID | Steps | Expected result |
|---|---|---|
| F01 | Issue INV-SYN-001 for KES 1,000.00 in the open term/period. | Invoice belongs to the intended student, school, term, and period; amount and due date are correct. |
| F02 | Record RCP-SYN-001 for KES 400.00 and allocate KES 400.00 to INV-SYN-001. | Outstanding invoice balance is KES 600.00; status is part-paid; receipt and posted journal are linked. |
| F03 | Record RCP-SYN-002 for KES 600.00 and allocate it to the same invoice. | Outstanding balance is KES 0.00; status is paid; total applied receipts are KES 1,000.00. |
| F04 | Retry the same request/idempotency key for a receipt. | No duplicate receipt, allocation, or journal is created. Record the exact idempotency mechanism exercised. |
| F05 | Try to allocate more than the invoice's remaining balance and more than the receipt amount. | Each invalid allocation is rejected atomically; receipt, invoice balance, and journals remain unchanged. |
| F06 | Try allocating a receipt to a reversed or void invoice. | Allocation is rejected; no journal or balance change occurs. |
| F07 | Record a bank receipt without an external reference or without an active mapped bank payment account. Repeat with valid synthetic values. | Invalid input is rejected; valid input is linked to the correct active bank ledger account and reference. |
| F08 | Record two M-Pesa receipts using the same synthetic external reference, including a retry after reversing the first receipt. | Duplicate reference is rejected across original and reversed receipts; no duplicate financial effect is created. |
| F09 | Reverse a posted receipt using the supported reversal flow. Inspect the original receipt, reversal, invoice balance, journals, and audit trail. | Original posting remains traceable and is not silently deleted/edited; reversal is linked and balanced; invoice balance follows the documented allocation/reversal rules. |
| F10 | Try to edit/delete a posted receipt or alter its posted journal directly through the UI/API. | Direct mutation is rejected; corrections use the authorized reversal/correction flow. |
| F11 | Submit and approve a fee waiver against an open invoice; then try submitting/approving a waiver against a reversed or void invoice. | Valid waiver follows approval controls and produces the documented accounting effect; waiver on reversed/void invoice is rejected. |
| F12 | Record a receipt that exceeds the invoice balance with student credit explicitly enabled, if the feature is available. Inspect unapplied credit and reports. | Excess is handled only according to the explicit student-credit rules; it is not silently allocated beyond the invoice or lost. If not supported, record the case as NOT SUPPORTED and document expected product behavior. |

### C. Expenses, bank reconciliation, and periods

| ID | Steps | Expected result |
|---|---|---|
| E01 | Submit EXP-SYN-001 for KES 200.00 as the requester. Try self-approval. | Submission is recorded; self-approval is rejected; no payment or expense journal is posted prematurely. |
| E02 | Approve the expense as a distinct authorized approver and record payment as the authorized payment operator. | Status transitions are valid; payment and journals are linked; amount and expense/payable accounts match the configured workflow. |
| E03 | Try duplicate payment submission/idempotent retry and try to pay an unapproved expense. | Duplicate payment is prevented and unapproved payment is rejected without duplicate postings. |
| E04 | Import a synthetic bank-statement CSV containing a matching line, an unmatched line, a duplicate line, invalid date/amount, and a formula-like description. | Valid lines are parsed safely; duplicate/invalid lines are detected; formula-like content is not executed in exports; no financial transaction is silently posted just by importing a statement. |
| E05 | Reconcile a matching synthetic bank line to the appropriate ledger transaction and review unmatched lines. | Matched line is traceable; unmatched items remain visible; reconciliation totals and status are explainable. |
| E06 | Attempt a new posting into a locked accounting period. | Posting is rejected and no journal is created. |
| E07 | Correct a posted journal using the supported reversal/replacement process. | Original, reversal, and replacement remain linked and auditable; all journals balance. |

### D. Ledger, reports, precision, and exports

| ID | Steps | Expected result |
|---|---|---|
| R01 | Inspect all journals created by the fee and expense scenarios. | For each posted journal, total debits equal total credits exactly to the cent; each line uses the intended school and ledger accounts. |
| R02 | Independently calculate the fixture: invoice KES 1,000.00; receipts KES 400.00 + KES 600.00; expense KES 200.00. | Fee balance is zero after both allocations; receipt total is KES 1,000.00; expense total is KES 200.00. These source totals are not a substitute for validating account mappings. |
| R03 | Compare trial balance, general ledger, income statement, balance sheet, cashbook/bankbook, receipt register, invoice register, fee balances, expense register, journal register, and audit trail with the underlying synthetic records. | Reports reconcile to the source records; trial balance debits equal credits; discrepancies are investigated rather than explained away. |
| R04 | Export representative reports as CSV, XLSX, and PDF. Include empty reports, decimal amounts, date boundaries, and formula-like text. | Export totals match the UI and independent calculation; values and dates are consistent; CSV formula injection is safely neutralized. |
| R05 | Test KES values with two decimal places, rounding boundaries, and dates around term/year boundaries in Africa/Nairobi. | No floating-point drift or unexpected timezone/date shift is observed; documented rounding rules are consistent. |

### E. Recovery, security, and operational readiness

| ID | Steps | Expected result |
|---|---|---|
| O01 | Run CI's disposable database backup/restore checks and capture the workflow run. | CI backup/restore checks pass. This is evidence for the disposable CI database only. |
| O02 | Separately perform a provider-level restore drill using an encrypted backup into a new disposable database, never over production. | Restore succeeds and an operator compares migration state, synthetic record counts, journal totals, allocations, school isolation, login, and reports. Attach provider/run evidence. |
| O03 | Verify HTTPS, readiness, response security headers, runtime least-privilege database role, row-level security, and rate limiting in the hosted environment. | Each control has current evidence; missing controls are recorded as blockers or accepted risks by the authorized owner. |
| O04 | Review secrets, backup encryption key custody, retention, access removal, monitoring, alerting, privacy notice, and Kenya Data Protection Act responsibilities with the school/operator. | Owners and procedures are documented; no secret is placed in test evidence or Git history. |
| O05 | In a non-production environment, simulate database unavailability and a failed migration. | Readiness fails safely, no partial posting occurs, and the recovery procedure is followed successfully. |

## Financial reconciliation worksheet

Fill this worksheet using observed values, not expected values copied without testing.

| Measure | Expected | Observed | Evidence |
|---|---:|---:|---|
| Original invoice | KES 1,000.00 |  |  |
| Receipt 1 allocated | KES 400.00 |  |  |
| Receipt 2 allocated | KES 600.00 |  |  |
| Invoice outstanding after both receipts | KES 0.00 |  |  |
| Total receipts before any reversal scenario | KES 1,000.00 |  |  |
| Synthetic expense | KES 200.00 |  |  |
| Trial balance debits | Must equal credits |  |  |
| Trial balance credits | Must equal debits |  |  |
| Unexplained difference | KES 0.00 |  |  |

Document separately any receipt reversals, waivers, student credit, bank timing differences, or other cases that change these simple fixture totals. Do not force a report to match by changing expected values after observing a discrepancy; obtain an independent accounting explanation.

## Defect handling

For each failed or blocked case, record:
- Case ID and date/time.
- Expected result versus observed result.
- Synthetic record IDs and redacted evidence.
- Severity: **Critical** (possible incorrect financial posting, data exposure, or bypass of approval), **High** (material reconciliation/access/control defect), **Medium**, or **Low**.
- Assigned owner, corrective change, regression test, and retest result.

Any critical or high-severity accounting, authorization, tenant-isolation, or data-integrity defect blocks real-school use until fixed and retested. Any risk acceptance must be written and signed by the authorized school decision-maker.

## Sign-off record

The people below must review the evidence and make their own decision. Do not pre-fill names, signatures, dates, or approvals.

| Required reviewer | Name and role | Cases reviewed / evidence reference | Decision (Approve / Reject / Conditional) | Conditions / open defects | Signature or verifiable approval | Date |
|---|---|---|---|---|---|---|
| Independent school accountant/bursar |  |  |  |  |  |  |
| Authorized school administrator |  |  |  |  |  |  |
| Technical/deployment operator |  |  |  |  |  |  |

### Release decision

- [ ] All required acceptance cases have execution evidence.
- [ ] All critical/high defects are closed and retested.
- [ ] Independent accountant has reviewed the ledger mappings, receipt/waiver/reversal behavior, reconciliations, and reports.
- [ ] Authorized administrator has approved access roles, operating procedures, and residual risks.
- [ ] Provider-level backup restore drill has passed and evidence is retained.
- [ ] Hosting expiry, backup schedule, retention, monitoring, and recovery ownership are addressed.
- [ ] Technical operator has verified the exact production revision and deployment health.
- [ ] All three required reviewers have recorded their decision above.

**Release rule:** until the release gates are complete, the correct status is **NOT APPROVED FOR REAL SCHOOL FINANCIAL OPERATIONS**. CI passing or a developer completing this document does not change that status.
