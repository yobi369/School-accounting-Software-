# Render hosting setup (initial pilot)

This repository includes a Render Blueprint to create the ShuleLedger web service and PostgreSQL database in Singapore, a reasonable starting region for Kenya.

## Important limits of the free pilot

- The Blueprint uses Render's free web service and free PostgreSQL plan to avoid automatically selecting a paid plan.
- Free web services can sleep when idle, and free PostgreSQL databases expire after 30 days. This is for a synthetic-data demonstration only, **not live school accounting**.
- Before any real school records are entered, upgrade to an appropriate paid plan, confirm backup/restore and retention options, and complete the least-privilege database setup and school accountant acceptance tests.
- The initial Blueprint temporarily uses the database connection URL for both migrations and application access. That is convenient for a synthetic-data bootstrap only; do not put real records into the system until the runtime database role is changed to a dedicated non-owner, non-superuser role with `NOBYPASSRLS` and the actual role has passed tenant-isolation tests.

## Deploy the pilot

1. Sign in to [Render](https://dashboard.render.com/).
2. Open **Blueprints** and create a new Blueprint from this GitHub repository: `yobi369/School-accounting-Software-`. Authorize Render to access the repository if prompted.
3. Review the resources before approving: `shuleledger` web service and `shuleledger-db` PostgreSQL database, both in Singapore and both on the free plan.
4. Approve the Blueprint. Render builds the existing Dockerfile, checks `/ready`, and runs `npm run db:migrate` after the first successful deploy.
5. In the service's Environment page, locate the generated `BOOTSTRAP_TOKEN`. Treat it as a secret; do not paste it into chat, screenshots, or source control.
6. Open the service's public HTTPS URL and verify:
   - `/health` returns HTTP 200.
   - `/ready` returns HTTP 200 after migrations and database setup.
   - `/api/v1/status` reports `databaseConfigured: true` and `productionReady: false`.
7. Provision one test school using `POST /api/v1/auth/bootstrap`, the `x-bootstrap-token` header, and synthetic data only. Remove/rotate the bootstrap token after authorized provisioning.

## Before real school data

1. Upgrade from the free resources; free PostgreSQL expires after 30 days and free web services can sleep.
2. Create a dedicated runtime database role, e.g. `shuleledger_app`, with `NOSUPERUSER NOBYPASSRLS`; grant only required schema/table/sequence privileges. Keep the database owner/migration credential for migrations only.
3. Change `DATABASE_URL` to the dedicated runtime-role connection string. Keep `MIGRATIONS_DATABASE_URL` restricted to a separate migration step and do not expose it to the app runtime if the host supports separate pre-deploy jobs/secrets.
4. Perform two-school isolation and role-authorization tests, reconcile invoices/receipts/journals/reports with an accountant, and perform an encrypted backup/restore drill in the selected paid hosting plan.
5. Set `PRODUCTION_READINESS_ATTESTED=true` only after every required check has been completed and evidenced. Configure GitHub Actions variable `PRODUCTION_BASE_URL` with the exact HTTPS origin to enable the live smoke test.
6. Review the commercial license, privacy notice, data-processing terms, and third-party dependency licenses. Legal approval still requires an authorized Kenyan advocate and signed agreement.

A successful Render deployment does not itself mean the application is legally approved or safe for live financial records. See [Deployment and initial setup](DEPLOYMENT.md), [Backups and recovery](BACKUPS_AND_RECOVERY.md), and [commercial license template](COMMERCIAL_LICENSE_AGREEMENT_TEMPLATE.md).
