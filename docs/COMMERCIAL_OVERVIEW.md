# Precious SchoolBooks — Commercial Overview

Precious SchoolBooks is a school-finance workspace being developed for Kenyan primary and secondary schools. It brings fee collection, expense controls, double-entry accounting, reconciliation, reporting, and school-scoped access into one application.

## Who it is for

- School owners and administrators who need visibility into school finances.
- School accountants and bursars who manage fees, receipts, expenses, and reconciliations.
- Schools that want traceable accounting records and controlled financial approvals.

## Product capabilities

The current repository documents these implemented foundations:

- Fee invoices, receipts, allocation checks, waivers, and student balances.
- Double-entry journals, immutable posted entries, and reversal-based corrections.
- Expense approvals, supplier payments, budgets, and bank-statement reconciliation.
- School-level access controls and PostgreSQL row-level security.
- Ledger-backed financial reports with CSV, XLSX, and PDF exports.
- An installable PWA shell and an offline queue for expense drafts.

Offline support currently covers expense drafts only. Other financial actions require connectivity. M-Pesa, KRA eTIMS, SMS/email delivery, managed backup scheduling, and multi-factor authentication are not complete integrations.

## Commercial engagement options

Commercial discussions may cover:

1. A scoped product demonstration using synthetic data.
2. A time-boxed evaluation or pilot with agreed acceptance criteria.
3. A self-hosted or managed deployment proposal after the required technical and operational checks.
4. A written software licence, implementation scope, support terms, and maintenance arrangement.

Pricing and service levels are quoted only after the school, deployment model, user count, support requirements, and operational responsibilities are understood. No production-use licence or service-level commitment is created by this overview.

## Safety and readiness boundary

**Do not use live school financial records until the production checklist and independent school acceptance process are complete.** Before any live deployment, the operator must verify the actual hosting environment, non-superuser database grants and row-level security, cross-school isolation, encrypted backups and a successful restore drill, monitoring, alerting, rate limiting, retention controls, and school accountant sign-off.

Initial demonstrations and evaluations should use synthetic data. The product's current status and limitations are described in the root README and the deployment, backup, and school-acceptance documentation.

## Licensing and contact

The software is proprietary. Public repository visibility does not grant permission to copy, modify, redistribute, host, or commercially use it. Any evaluation, deployment, or commercial use requires a separate written agreement. See [LICENSE](../LICENSE), [licensing policy](LICENSING.md), and [commercial licence agreement template](COMMERCIAL_LICENSE_AGREEMENT_TEMPLATE.md).

To discuss a demonstration or scoped commercial proposal, use the contact form on [Brian Mutunga's portfolio](https://brianmutunga.vercel.app).

This overview is informational, not a binding offer, legal advice, or a guarantee of production readiness.
