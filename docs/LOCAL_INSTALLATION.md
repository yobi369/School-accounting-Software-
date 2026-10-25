# ShuleLedger local installation (desktop pilot)

This guide runs ShuleLedger on a Windows, macOS, or Linux computer using Docker Desktop / Docker Engine. The web app and PostgreSQL database run locally; the database port is not exposed to the network. Use synthetic test data only. This is a pilot setup, not a production-school deployment.

## What works and what does not

- The local application and database can run without a hosted database or internet connection **after the images and source dependencies have been downloaded/built**.
- Records created in this local instance persist in a Docker volume on that computer.
- The current offline queue supports **expense drafts only**. A queued draft is not posted accounting data. Other workflows require the local app and database to be running.
- The local database is not automatically synchronized with the Render deployment. Treat them as separate environments.
- The setup token is for initial provisioning. Remove it from the local environment after creating the first test school.
- Do not use real student, family, staff, or school financial information.

## 1. Install prerequisites

1. Install Docker Desktop on Windows/macOS, or Docker Engine and the Compose plugin on Linux.
2. Start Docker and wait until it reports that it is running.
3. Download the repository to the computer using Git, or download the repository ZIP from GitHub and extract it.
4. Open a terminal in the extracted `School-accounting-Software-` folder.

Official Docker installation guidance: https://docs.docker.com/get-started/get-docker/

## 2. Configure local secrets

Copy `.env.local.example` to a file named `.env` in the repository root. Replace all three placeholder values with different, long random values. For ease of this pilot, use letters, numbers, and hyphens only in the two database passwords so the PostgreSQL URL does not need extra encoding.

Do not commit or share `.env`. It is ignored by Git. Keep the owner password and bootstrap token private.

### Windows PowerShell

```powershell
Copy-Item .env.local.example .env
notepad .env
```

### macOS / Linux

```sh
cp .env.local.example .env
nano .env
```

## 3. Build and start ShuleLedger

From the repository root:

```sh
docker compose up --build -d
```

The first build downloads packages and may require an internet connection. Wait for the build to finish, then check:

```sh
docker compose ps
docker compose logs --tail=100 app migrate
```

Open http://localhost:3001 in Chrome or Microsoft Edge. The database is available only to the Compose network; the web app is bound to the local computer at 127.0.0.1. To add an app-style shortcut, open the browser menu and choose **Install ShuleLedger** or **Install page as app** if offered. It will open in its own window; the local Docker services must still be running for accounting actions.

If the app does not start, check the logs before retrying. To stop it without deleting local data, run `docker compose down`. To start it again, run `docker compose up -d`.

## 4. Create your first test school

Open `.env` in a text editor and copy the value of `SHULELEDGER_BOOTSTRAP_TOKEN` for your own local use. Do not paste it into chat or send it to anyone.

The following PowerShell example asks for the token and school details interactively. Run it in a separate PowerShell window while ShuleLedger is running. Use synthetic details and a unique test password of at least 12 characters.

```powershell
$token = Read-Host "Enter SHULELEDGER_BOOTSTRAP_TOKEN from your local .env file"
$schoolName = Read-Host "Test school name"
$schoolCode = Read-Host "Unique school code (example TEST-001)"
$fullName = Read-Host "Test administrator name"
$email = Read-Host "Test administrator email"
$securePassword = Read-Host "Unique test password (12+ characters)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  $body = @{
    schoolName = $schoolName
    schoolCode = $schoolCode
    fullName = $fullName
    email = $email
    password = $password
  } | ConvertTo-Json
  Invoke-RestMethod -Uri "http://localhost:3001/api/v1/auth/bootstrap" -Method Post -Headers @{ "x-bootstrap-token" = $token } -ContentType "application/json" -Body $body
} finally {
  if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $password = $null
  $token = $null
}
```

Save the returned `schoolId` privately. On the ShuleLedger sign-in screen, enter that value as the **School workspace ID**, plus the administrator email and the test password. Follow the first-login password-change prompt if shown.

Once the test school has been created, remove `SHULELEDGER_BOOTSTRAP_TOKEN` from the `.env` file and recreate the app container with `docker compose up -d --force-recreate app`. Keep the token only if you deliberately need to provision another synthetic test school; rotate it before doing so.

## 5. Verify basic operation

- Open http://localhost:3001/health — expect JSON with `"status":"ok"`.
- Open http://localhost:3001/ready — expect `{"status":"ready"}`.
- Sign in to the test workspace.
- Test workflows using fictitious students, fee amounts, and expenses.
- Export sample reports and independently compare their totals to the entries you created.
- Confirm a draft queued offline is still marked pending and is not treated as a posted transaction.

These checks do not constitute accountant acceptance, a full offline acceptance test, or approval for live school records.

## 6. Stop, back up, or reset the local test

Stop the app but keep the database volume:

```sh
docker compose down
```

Start it again later:

```sh
docker compose up -d
```

To make a logical backup of the local database:

```sh
docker compose exec -T db pg_dump -U shuleledger_owner -d shuleledger > shuleledger-local-backup.sql
```

Store the backup securely. To permanently delete the local database volume and all test records, run:

```sh
docker compose down -v
```

**Warning:** `docker compose down -v` permanently deletes this local instance's database. Do not run it if you need to keep test records.

## Troubleshooting

- **Port 3001 is busy:** Stop the other process using that port, or change the left side of the `ports` entry in `docker-compose.yml` and open the corresponding local port.
- **Database role/password errors on first startup:** If you changed database passwords after PostgreSQL initialized, the stored role is not automatically recreated. For a brand-new empty test database only, `docker compose down -v` then `docker compose up --build -d` recreates it. This deletes all local data.
- **Migration failed:** Read `docker compose logs migrate`; do not delete the database volume if it contains records you need.
- **Bootstrap returns 403:** Confirm the local app has the same token configured in its environment. Recreate the app container after changing `.env`.
- **Page opens but actions fail:** Check `docker compose ps` and `docker compose logs --tail=100 app db migrate`.

## Before any real-school use

Do not use this local pilot for live financial records until the runtime database grants/RLS, backup and restore, multi-school isolation, all roles, accounting totals, access controls, device security, and recovery processes have been independently tested and signed off. This guide does not enable general offline accounting or online/local synchronization.
