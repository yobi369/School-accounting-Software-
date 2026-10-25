# ShuleLedger school acceptance test

Use a **synthetic school and synthetic records only** until every gate passes. This checklist is intended for a school bursar/accountant and a separate administrator. Record the tester, date, result, evidence reference, and defect for each case. A developer's CI result is not a substitute for school sign-off.

## Test setup

- Create a pilot school with KES currency and the correct Africa/Nairobi time zone.
- Create separate administrator, bursar, accountant, expense requester, approver, payer, and auditor accounts where the role model permits.
- Create one student, one open financial year and period, and cash, fees receivable, fee income, accounts payable, and administration expense accounts.
- Use no real student names, phone numbers, bank details, tax PINs, or school finance records.

## Required scenarios

| ID | Scenario | Expected result / evidence |
|---|---|---|
| A01 | Bootstrap and first login | One school is created; a second bootstrap is rejected; administrator must change the initial password. |
| A02 | Role permissions | Each role can perform only permitted actions. A requester cannot approve their own expense; an approver cannot pay the expense they approved if maker-checker separation requires another payer. |
| A03 | Invoice and part-payment | Issue a KES 1,000 invoice. Receive and allocate KES 400. Outstanding balance is KES 600 and invoice status is part-paid. |
| A04 | Final payment and duplicate request | Allocate a further KES 600. Outstanding is KES 0 and invoice is paid. Re-submit the same receipt idempotency key: no second receipt or journal is created. |
| A05 | Allocation boundaries | Attempt to allocate more than the invoice's remaining balance and attempt allocations above the receipt amount. Each must be rejected without changing balances. |
| A06 | Expense approval and payment | Submit a KES 200 expense. Self-approval is rejected. An authorized approver approves it and a distinct authorized payer records payment. The expense is paid and linked to the correct posted journals. |
| A07 | Double-entry and reports | Every posted journal has equal positive debit and credit totals. Trial balance debits equal credits; ledger, income statement, balance sheet, cashbook, receipts register, fee balances, and expense register agree with source records. |
| A08 | Posted-entry correction and period lock | A posted journal cannot be edited or deleted. Corrections use a linked reversal and replacement. Posting into a locked period is rejected. |
| A09 | Two-school isolation | Create school A and school B with distinct users and records. Each user cannot read or change the other school's students, fees, receipts, expenses, journals, reports, audit events, or invitations by changing IDs or request parameters. |
| A10 | Exports and numeric precision | Compare CSV, XLSX, and PDF values with the on-screen report and independently calculated KES totals. Test cents, date boundaries, empty reports, and CSV formula-injection strings. |
| A11 | Offline draft recovery | Disconnect, create an expense draft, reconnect and sync. A draft remains unposted until server acceptance and required approval; repeated sync does not duplicate it. Confirm the documented limitation that offline mode does not support every accounting action. |
| A12 | Backup and restore | Take an encrypted backup in the actual hosting provider, restore it to a new disposable database, and compare migration checksums, record counts, journal totals, allocations, school isolation, login, and reports. Never restore over the live database. |
| A13 | Security and privacy | Confirm HTTPS, required response headers, rate limiting, log redaction, least-privilege database role, RLS, secret rotation, access removal, retention policy, privacy notice, and the school's Kenya Data Protection Act obligations. |
| A14 | Operational recovery | Simulate database unavailability and a failed migration in a non-production environment. Verify readiness goes unhealthy, alerts reach the operator, and the documented recovery procedure works. |

## Independent accounting fixture

Use these values as a small reproducible test:

- Invoice: KES 1,000.00.
- Receipt 1: KES 400.00 allocated to that invoice; expected outstanding KES 600.00.
- Receipt 2: KES 600.00 allocated to the same invoice; expected outstanding KES 0.00.
- Expense: KES 200.00, with separate request, approval, and payment actors.
- Expected receipts total: KES 1,000.00; expected expense total: KES 200.00.
- Every posted journal must balance exactly to the cent. Confirm actual account mappings and report totals with the accountant; do not assume this fixture alone proves the full chart of accounts is correct.

## Sign-off gate

Do not approve real-world use until all required cases pass, every defect is closed or explicitly risk-accepted by the school, a production-provider restore drill is evidenced, and the school's accountant and authorized administrator sign off. Keep `PRODUCTION_READINESS_ATTESTED=false` until then.

| Role | Name / signature | Date | Decision |
|---|---|---|---|
| School accountant |  |  |  |
| Authorized school administrator |  |  |  |
| Technical operator |  |  |  |
