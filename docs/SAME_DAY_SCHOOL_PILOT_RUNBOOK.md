# Same-day school pilot runbook

This runbook is for a **supervised pilot with synthetic/test data**. It is not a declaration that ShuleLedger is certified for live accounting or that the commercial agreement has legal approval. Do not import real pupil, parent, payroll, banking, or financial records until the deployment and acceptance gates below are signed off.

## 1. Decide which installation you are doing

- **Demonstration / supervised pilot:** use a dedicated machine or secured test server, synthetic data, and a separate test database. This is appropriate for a same-day walkthrough.
- **Live school deployment:** requires a secured HTTPS host, managed PostgreSQL or a hardened server, restricted runtime database credentials, secret management, off-site encrypted backups, a successful restore drill, access-control tests, and accountant sign-off. Do not expose a development server to the internet.

The application is a Node.js/TypeScript service and PostgreSQL database, not a static website. A Vercel static deployment alone is not a complete installation.

## 2. Required components

- Node.js 22 or newer and npm.
- PostgreSQL 16 or newer.
- A machine/account that can securely store database credentials and a temporary bootstrap token.
- A trusted HTTPS reverse proxy or hosting ingress for any network-accessible deployment.
- A backup destination separate from the application machine for live use.

## 3. Install on a controlled test machine

1. Obtain the authorized source release from the repository and check out the intended commit. Do not deploy directly from an unreviewed working tree.
2. Install dependencies and build:

   ```sh
   npm install
   npm run typecheck
   npm test
   npm run build
   ```

3. Create a new, empty PostgreSQL database. Use one separate migration-owner credential for migrations and a dedicated non-superuser runtime role with `NOBYPASSRLS` for the application. Never use a PostgreSQL superuser as the application's `DATABASE_URL`.
4. Create a private environment file based on `.env.example`; restrict its permissions (for example, `chmod 600 .env`). Set `DATABASE_URL`, `MIGRATIONS_DATABASE_URL`, `BOOTSTRAP_TOKEN`, `PORT=3001`, and the TLS option appropriate to the database provider. Do not commit or send the file to anyone.
5. Apply schema migrations once as a release step:

   ```sh
   npm run db:migrate
   ```

6. Build and start the API/UI using the supported production start command:

   ```sh
   npm run build
   npm start
   ```

   Keep the process supervised by an appropriate service manager or container runtime. Do not rely on a terminal window as the production process manager.

7. Check these endpoints locally before proceeding:

   ```sh
   curl -fsS http://127.0.0.1:3001/health
   curl -fsS http://127.0.0.1:3001/ready
   curl -fsS http://127.0.0.1:3001/api/v1/status
   ```

   The readiness endpoint must return `ready`. The status endpoint is expected to show `productionReady: false` until the real production acceptance work has been completed. Do not change `PRODUCTION_READINESS_ATTESTED` to true merely to bypass the gate.

## 4. Provision the first school

Use a temporary, strong bootstrap token stored in the server's secret environment. Make the request from the trusted host or a protected admin workstation; do not place the token or the real administrator password in shell history, screenshots, chat, or logs.

Example request shape (replace every placeholder and use synthetic details for a pilot):

```sh
curl --fail-with-body -X POST http://127.0.0.1:3001/api/v1/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H 'x-bootstrap-token: REPLACE_WITH_TEMPORARY_TOKEN' \
  --data '{
    "schoolName": "PILOT SCHOOL — TEST ONLY",
    "schoolCode": "PILOT-TEST",
    "fullName": "Pilot Administrator",
    "email": "pilot-admin@example.invalid",
    "password": "REPLACE_WITH_UNIQUE_PASSWORD_AT_LEAST_12_CHARACTERS"
  }'
```

Use the real HTTPS origin instead of localhost only when HTTPS, firewall rules, and access controls are already configured. The example password and token are placeholders, not usable credentials. Store the returned school ID securely. After successful first-school provisioning, remove or rotate the bootstrap token and restart/redeploy the service so bootstrap cannot be reused. Verify that the initial administrator is required to change their password at first login.

## 5. Pilot acceptance checklist

Use synthetic records first. Record the outcome and who verified it.

- [ ] Administrator can sign in and must change the initial password.
- [ ] Create two test users with different roles and verify permissions in the UI and API.
- [ ] If multi-school functionality is being tested, create two isolated test schools and verify neither can access the other's data.
- [ ] Enter a test fee invoice and receipt; verify receipt allocations cannot exceed the invoice balance.
- [ ] Enter a test expense and verify approval/payment permissions and separation of duties.
- [ ] Verify a balanced journal, reject an unbalanced journal, and confirm posted entries cannot be silently edited.
- [ ] Reconcile the trial balance, income statement, balance sheet, fee balances, receipts, and cash/bank reports against independently calculated test figures.
- [ ] Test CSV/XLSX/PDF export and review files for correct totals and unintended personal data.
- [ ] Test offline expense drafts on the intended device. Offline support is limited: drafts are pending and are not posted until server acceptance; other financial actions require connectivity.
- [ ] Create an encrypted backup, restore it into a disposable database, and verify balances, allocations, users, migrations, and tenant isolation.
- [ ] Verify HTTPS, secure cookies/session behavior as applicable, security headers, rate limiting, monitoring, log redaction, and recovery contacts on the actual host.
- [ ] Obtain written acceptance from the school's authorized administrator and accountant before any live financial use.

**Stop the pilot** if any test fails, totals do not reconcile, a user can cross school boundaries, a posted entry changes unexpectedly, a backup cannot be restored, or secrets appear in logs.

## 6. Requirements before live records or commercial production

- Complete and evidence the deployment checklist in [DEPLOYMENT.md](DEPLOYMENT.md).
- Complete a provider-specific encrypted backup and restore drill; CI's disposable database test is not a substitute.
- Perform authorization/RLS tests against the exact runtime database role on the actual deployment.
- Complete independent accounting reconciliation and an agreed pilot/parallel-run period.
- Establish privacy notices, data retention/deletion, incident response, and a data-processing arrangement appropriate under Kenyan law.
- Have a qualified Kenyan advocate review and approve the final signed commercial license/customer agreement, privacy terms, and data-processing terms. The repository template is not legal approval and should not be represented to clients as such.
- Review the generated third-party dependency license inventory and resolve any compatibility or attribution questions before distributing a build.
- Change repository visibility to private if source confidentiality is required; a proprietary notice does not prevent people from viewing a public repository.

## 7. Release evidence currently available

The GitHub Actions run for commit `84059dcfe7e80438fcb537b7240610d3426b3d5e` passed CI, including type-checking, tests, build, database migrations, disposable database backup/restore, dependency advisory checks, and dependency license inventory generation. The production deployment smoke test was **skipped** because a `PRODUCTION_BASE_URL` was not configured. Therefore, this is evidence of a passing CI build, not evidence of a verified live deployment, legal approval, or production certification.

## 8. Useful links

- [Deployment checklist](DEPLOYMENT.md)
- [Backup and recovery](BACKUPS_AND_RECOVERY.md)
- [Licensing policy](LICENSING.md)
- [Commercial license agreement template](COMMERCIAL_LICENSE_AGREEMENT_TEMPLATE.md)
- [Third-party license review](THIRD_PARTY_LICENSE_REVIEW.md)
