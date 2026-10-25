# Deployment and initial setup

ShuleLedger now has an Express API, a React workspace, PostgreSQL migrations, server-side school scoping, and a basic production container. It is not certified for live school finance until a deployment operator completes the production checklist below.

## Required environment

Copy `.env.example` to a secure secret store, not into Git. Use a dedicated PostgreSQL runtime role named `shuleledger_app` with `NOSUPERUSER NOBYPASSRLS`; use a separate migration-owner credential for schema changes. Do not run the application with the migration-owner or a superuser connection. Use TLS and verified certificates where supported.

## Migration and startup

The Render free-tier pilot currently receives the same owner connection in `DATABASE_URL` and `MIGRATIONS_DATABASE_URL` from the blueprint. The startup supervisor uses the migration connection only to apply checksum-verified migrations and provision/verify a separate `shuleledger_app` role using the generated `RUNTIME_DATABASE_PASSWORD`. It launches the API with only the restricted runtime connection; migration credentials and the generated role password are not passed to the API process. Startup fails closed if role creation, grants, or least-privilege verification fail. Operator-only `schema_migrations` and `backup_restore_drills` tables are not granted to the runtime role.

For a production service, prefer a dedicated release/pre-deploy migration job and configure the service with a runtime-only `DATABASE_URL`; do not leave migration-owner credentials in the web service's environment.

1. Apply migrations with the migration-owner credential. The runner records checksums and refuses to silently change an applied migration.
2. Verify the application connects as `shuleledger_app`, which must have `NOSUPERUSER`, `NOBYPASSRLS`, no database/role creation privileges, and ownership of no application objects.
3. Build and run the container. It serves the static workspace and API from one origin; this is required for the current relative API URLs and CSP.
4. Configure TLS at the ingress, an external rate limit/WAF, health monitoring, log redaction, database backups, and alerting. The in-process login throttle is only a secondary control, not a replacement for an edge rate limit. Keep `PRODUCTION_READINESS_ATTESTED=false` until the live HTTPS deployment, two-school authorization tests, encrypted provider backup/restore drill, and accountant acceptance checklist have passed. Only then set it to `true`; this is a final operator attestation, not something CI can safely infer.

## Provision the first school

Use a strong, temporary `BOOTSTRAP_TOKEN` in the server secret store. Send one authorized request to `POST /api/v1/auth/bootstrap` with `x-bootstrap-token` and JSON containing `schoolName`, `schoolCode`, `fullName`, `email`, and a unique password of at least 12 characters. The response returns the school ID required at sign-in. Never put this token or a real password in shell history or logs. Remove the bootstrap token after authorized provisioning. For additional schools, rotate the provisioning secret under a documented admin process.

## Deployed-service verification

After the container is deployed behind HTTPS, add the exact public application origin as the GitHub Actions repository variable `PRODUCTION_BASE_URL` (for example, `https://accounting.example.org`; do not include a path). CI then runs `scripts/smoke-deployment.sh` against the real service and checks liveness, database readiness, the least-privilege runtime role, and required security headers. The script intentionally does not require `productionReady: true` until the independent acceptance and recovery gates have passed. To enforce final attestation after those gates, run with `REQUIRE_PRODUCTION_ATTESTATION=true`. Until the URL is configured and the live smoke test passes, production deployment verification is **not evidenced**. A green repository build does not verify the live host, database credentials, DNS, TLS, or provider settings.

## Security and operational checklist

- [ ] Configure HTTPS and secure DNS; verify headers and origin policy.
- [ ] Use a non-superuser runtime role with no `BYPASSRLS`; verify grants and RLS in the actual hosting provider.
- [ ] Configure rate limiting at the edge, monitoring, alerting, log redaction and incident response.
- [ ] Rotate/remove bootstrap secrets; provision users with unique initial passwords and confirm first-login change.
- [ ] Test all role permissions and cross-school access attempts using two real test schools.
- [ ] Verify `/health` and `/ready` monitoring behaviour, including an unavailable database and a failed migration.
- [ ] Verify report date filters, balances, totals, CSV formula-injection handling, and XLSX/PDF output with independently calculated fixtures.
- [ ] Reconcile fee invoices, receipts, allocations, waivers, journals and reports against independently calculated examples.
- [ ] Run the encrypted backup and restore drill in the actual production provider, not only CI.
- [ ] Test offline queue conflicts on mobile and shared devices; clear device storage at staff offboarding.
- [ ] Configure retention, privacy notices, data-subject request handling and appropriate safeguards under Kenya's Data Protection Act.
- [ ] Pilot with synthetic data, then parallel-run against the school's existing books and obtain school accountant sign-off before importing real records.

## Scope and limitations

M-Pesa, KRA eTIMS, SMS/email delivery, full academic-term configuration, automated recurring billing, multi-factor authentication, and managed object-storage backup scheduling are not live integrations in this repository. Offline operation currently queues expense drafts only; posting and other financial actions require connectivity. The health endpoint is a liveness check; use `/ready` for database readiness. The application exposes 18 report types with CSV, XLSX, and PDF export endpoints. These exports still require independent reconciliation against the ledger before live use. Do not advertise the system as production-ready until those requirements and the operational checklist are completed and evidenced.
