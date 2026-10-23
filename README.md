# ShuleLedger — Kenyan School Accounting Platform

ShuleLedger is a school-finance workspace for Kenyan primary and secondary schools. It is built around double-entry accounting, fee collection, controlled expenses, cash/bank reconciliation, financial reporting, and school-level access controls.

## Implemented foundations

- React + TypeScript responsive workspace with sign-in, first-login password change, school workspace switching, and role management.
- Node.js + Express API with password hashing, expiring bearer sessions, login throttling, security headers, server-side permissions, and cross-school membership checks.
- PostgreSQL migrations with row-level security, school-scoped foreign keys, append-only audit events, idempotency records, immutable posted journals, reversal-only corrections, and transactional posting.
- Student register, fee invoices and receipts, allocation checks, fee waivers, suppliers, expense approvals/payments, budgets, bank-statement CSV import/reconciliation, opening balances, period locking, and year-end close/opening-balance transfer.
- 18 ledger-backed reports with CSV, XLSX, and PDF exports.
- Installable PWA shell and durable IndexedDB queue for offline expense drafts. Offline drafts are pending, never posted, until server acceptance and approval.
- GitHub Actions run PostgreSQL migrations, tenant/ledger integration tests, a disposable database dump/restore smoke test, TypeScript checks, and production builds.

## Licensing

**Proprietary — all rights reserved.** Public source visibility does not grant permission to copy, modify, redistribute, host, or sell ShuleLedger. Commercial use requires prior written authorization. See [LICENSE](LICENSE) and [licensing policy](docs/LICENSING.md). Third-party dependencies retain their own licenses.

## Technology

- Frontend: React, TypeScript, Vite.
- API: Node.js, TypeScript, Express.
- Database: PostgreSQL with RLS and versioned SQL migrations.
- Tests: Vitest, including PostgreSQL integration checks in CI.
- Deployment: single-origin Node container serving the built UI and API; managed PostgreSQL recommended.

## Local development

Requirements: Node.js 22+ and PostgreSQL 16+.

```bash
npm install
cp .env.example .env
# Configure DATABASE_URL, MIGRATIONS_DATABASE_URL and BOOTSTRAP_TOKEN.
npm run db:migrate
npm run dev
```

Run the API separately during local development:

```bash
npm run dev:api
```

For CI or a disposable PostgreSQL database, create a non-superuser runtime role named `shuleledger_app` with `NOBYPASSRLS`, apply migrations with the migration-owner connection, then run:

```bash
npm run typecheck
npm test
npm run build
```

For container deployment, see [Deployment and initial setup](docs/DEPLOYMENT.md). For encrypted backups and restore drills, see [Backups and recovery](docs/BACKUPS_AND_RECOVERY.md).

## First school provisioning

Provisioning requires a temporary strong `BOOTSTRAP_TOKEN`. Use `POST /api/v1/auth/bootstrap` with header `x-bootstrap-token` and a JSON body containing `schoolName`, `schoolCode`, `fullName`, `email`, and `password`. Store the returned school ID securely. Remove or rotate the bootstrap token after authorized provisioning.

## Reports

The report API supports: trial balance, income statement, balance sheet, general ledger, cashbook, bankbook, receipts register, invoice register, fee balances, fee ageing, expense register, supplier payables, bank reconciliation, budget variance, journal register, collections by payment method, fees by class, and audit trail. Export endpoints use `/api/v1/reports/{report}.csv`, `.xlsx`, or `.pdf`.

## Production-readiness warning

**Do not use live school financial records until the deployment operator has completed the production checklist and the school accountant has independently reconciled test cases.** Passing CI is necessary but not sufficient. In particular:

- Run a restore drill with the actual production database provider and encrypted off-site backup destination.
- Verify runtime grants and RLS using the exact non-superuser database role in the target hosting environment.
- Configure edge rate limiting, TLS, monitoring, alerting, secrets management, backup scheduling, and retention.
- Test all roles and cross-school access with two separate schools.
- Pilot with synthetic data, then parallel-run against the existing books and obtain independent accounting sign-off.

M-Pesa, KRA eTIMS, SMS/email delivery, managed backup scheduling, multi-factor authentication, and external accountant acceptance are not complete integrations. Offline support currently queues expense drafts only; other financial actions require connectivity. CSV/XLSX/PDF exports are supported, but export contents still require reconciliation against the source ledger during acceptance.

## License

Choose and add a license before distributing this repository publicly or commercially.
