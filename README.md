# ShuleLedger — Kenyan School Accounting Platform

A multi-school accounting platform for Kenyan primary and secondary schools, designed around accurate double-entry bookkeeping, fee collection, expense control, reconciliations, reporting, and dependable offline workflows.

## Product principles

- **Accounting integrity:** decimal money, balanced journals, immutable posted entries, reversal-only corrections.
- **Tenant isolation:** school-scoped data and server-side authorization.
- **Operational clarity:** fee balances, payables, cash and bank reconciliation, budgets, and reports.
- **Offline-aware:** queued actions are explicitly pending until accepted by the server; no silent overwrites.
- **Privacy:** least privilege, audit trails, protected backups, and data-minimization practices.
- **Kenya-first:** KES default, configurable academic and financial calendars. M-Pesa, eTIMS, and SMS integrations are future work, not live V1 features.

## Intended architecture

- Web: React + TypeScript + Vite, responsive PWA.
- API: Node.js + TypeScript + Express.
- Database: PostgreSQL with migrations, constraints, and transactional journal posting.
- Tests: Vitest, API/database integration tests, and Playwright.
- CI: GitHub Actions.
- Initial deployment: frontend and API deployed separately, managed PostgreSQL with verified backups.

A modular monolith is preferred for the first release over microservices to reduce operational complexity and cost.

## Delivery phases

1. Foundation, school isolation, permissions, audit trail, double-entry ledger.
2. Students, fee structures, invoices, receipts, allocations, waivers, statements.
3. Expenses, suppliers, vouchers, petty cash, cash/bank books, imports and reconciliation.
4. Budgets, opening balances, period/year-end controls, 18 reports and exports.
5. Offline PWA, durable local queue, idempotent sync, conflict handling.
6. Security hardening, restoration drills, performance testing, pilot and handover.

## Important status

This repository is the project starting point. Do not treat it as production-ready until implementation, automated tests, security review, database migration checks, backup restoration tests, and school-user acceptance tests have passed.

## Accounting and security invariants

- All monetary calculations use exact decimal arithmetic; never JavaScript floating-point for money.
- A posted journal must balance and post atomically.
- Posted journals are immutable; corrections use linked reversals.
- Every school-owned query and mutation must enforce server-derived school membership.
- Idempotency is required for retryable financial submissions.
- Draft/pending/offline transactions must never be presented as server-confirmed postings.
- Reports must reconcile to the posted ledger and source records.
- Credentials and production secrets must only be supplied through environment variables.

## Local development

Setup instructions will be expanded alongside the implementation. Never use real student or financial data in development fixtures.

## License and ownership

License and commercial distribution terms must be selected by the repository owner before public distribution.