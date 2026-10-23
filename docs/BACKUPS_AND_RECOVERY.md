# Database backups and restore drills

## Encrypted backup

Install PostgreSQL client tools and `age`. Set `DATABASE_URL`, `BACKUP_DIR`, and `BACKUP_AGE_RECIPIENT` (an approved public age recipient; never the private key), then run `bash scripts/backup-db.sh`. The script writes an encrypted custom-format dump, checksum, and manifest with restrictive permissions. Store copies in separate, access-controlled storage with versioning and retention controls. Keep secrets out of this repository.

## Restore drill

Restore only to a new disposable database. Set `BACKUP_FILE`, `RESTORE_DATABASE_URL`, `AGE_IDENTITY_FILE`, and `CONFIRM_RESTORE_TARGET=disposable`, then run `bash scripts/restore-drill.sh`. It verifies the checksum when present, decrypts to a permission-restricted temporary file, restores, and prints basic counts. It does not certify accounting correctness; verify journal balances, fee allocation totals, school isolation, login, and reports.

## Production requirements

- Schedule backups outside the application and alert on failures or missing backups.
- Keep encrypted backups in a separate account/project and region where practical.
- Test point-in-time recovery if the selected PostgreSQL service supports it.
- Define recovery point objective, recovery time objective, retention, key rotation, and authorized restore operators.
- Never test recovery by restoring over the live production database.
- Record restore-drill operator, timestamp, backup reference, outcome, and evidence.
- CI should test dump/restore in a disposable database; that is not a substitute for a production restore drill.
