# Managed Neon Database Backup and Disaster Recovery

This document describes the backup architecture, recovery point and recovery time
objectives, and step-by-step disaster recovery procedures for Rakazo deployments
running on managed Lakebase Postgres (Neon).

---

## 1. Recovery Objectives (RPO & RTO)

| Incident Scenario | Mechanism | RPO (Data Loss Target) | RTO (Downtime Target) |
| --- | --- | --- | --- |
| Accidental data loss / bad migration within history window | Neon Point-in-Time Restore (PITR) Branch | < 5 minutes (continuous WAL) | < 5 minutes (instant branch + env reload) |
| Catastrophic service loss / data corruption past history window | Encrypted offsite logical dump (`neon-backup.sh`) | <= 24 hours (nightly backup) or schedule interval | < 15 minutes (restore to clean branch) |
| Complete infrastructure loss (multi-region / account outage) | Cold restore into fresh Neon project or Postgres instance | <= 24 hours | < 30 minutes |

### Retention Windows

- **Neon Free Tier**: 6 hours of continuous WAL history for Point-in-Time Restore.
- **Neon Launch / Scale / Enterprise**: Configurable up to 30 days of continuous PITR history.
- **Independent Logical Backups**: Retained on secondary storage (local disk `/var/backups/rakazo-neon` and optional offsite replica) with default 3-snapshot local retention and configurable offsite retention.

---

## 2. Backup Architecture

Rakazo uses client-side encrypted logical exports:

1. **Least-Privilege Connection**: Backups connect using a direct TLS connection string (`sslmode=require`).
2. **Zero Plaintext on Disk**: `pg_dump` streams custom-format archive directly through encryption (`age` public key or `gpg` symmetric cipher) into the target snapshot file.
3. **In-Flight Integrity Verification**: The plaintext stream is simultaneously validated via a FIFO by `pg_restore --list` before completing the run, ensuring corrupt dumps are caught immediately without needing the private decryption key on the host.
4. **Secret Masking**: Passwords and credentials are automatically redacted (`:***@`) in all logs, status outputs, and alerts.
5. **SHA256 Checksums**: Every snapshot generates a `SHA256SUMS` manifest and `METADATA.json` with timestamp and encryption mode.

---

## 3. Automated Backup Configuration

### Scheduled Unit

The backup runs nightly via systemd:

```bash
# Verify timer and service
sudo systemctl status rakazo-neon-backup.timer
sudo systemctl list-timers rakazo-neon-backup.timer
```

Configuration resides in `/etc/rakazo/backup.env`:

```bash
# Direct endpoint connection string (never pooled)
DATABASE_URL=postgres://user:password@ep-example-123456.us-east-2.aws.neon.tech/neondb?sslmode=require

# Encryption: Public age recipient key (private key stays off the host)
RAKAZO_BACKUP_AGE_RECIPIENTS=age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p

# Local retention
RAKAZO_BACKUP_KEEP=7
```

### Manual Backup Run

To trigger an immediate backup:

```bash
/srv/rakazo/infra/scripts/neon-backup.sh \
  --database-url "$DATABASE_URL" \
  --out-dir /var/backups/rakazo-neon \
  --age-recipient "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p"
```

To run a non-destructive preflight check:

```bash
/srv/rakazo/infra/scripts/neon-backup.sh --database-url "$DATABASE_URL" --dry-run
```

---

## 4. Disaster Recovery Procedures

### Scenario A: Fast Point-in-Time Restore (Within History Window)

If a bad migration or accidental deletion occurred recently:

1. **Identify Recovery Timestamp**: Determine the UTC timestamp just prior to the incident (e.g. `2026-10-25T11:00:00Z`).

2. **Create Branch from Timestamp** using Neon CLI:

   ```bash
   neon branches create \
     --project-id <project-id> \
     --parent main \
     --name recovered-main \
     --timestamp 2026-10-25T11:00:00Z
   ```

3. **Retrieve Direct Connection String**:

   ```bash
   neon connection-string recovered-main --role rakazo_app
   ```

4. **Update App Configuration**:
   Update `DATABASE_URL` in `/srv/rakazo/.env`.

5. **Restart Application Services**:

   ```bash
   docker compose --env-file /srv/rakazo/.env -f /srv/rakazo/infra/compose/docker-compose.managed.yml restart api worker
   ```

6. **Verify Service Health**:

   ```bash
   curl -fsS http://127.0.0.1:3100/ready
   ```

---

### Scenario B: Restoring from Encrypted Offsite Dump to Isolated Branch

When restoring from an encrypted logical snapshot:

1. **Create an Isolated Verification Branch** in Neon:

   ```bash
   neon branches create --name dr-test-restore
   TARGET_URL="$(neon connection-string dr-test-restore --role rakazo_app)"
   ```

2. **Execute the Restore Drill Script** with Operator Age Identity:

   ```bash
   /srv/rakazo/infra/scripts/neon-restore-drill.sh \
     /var/backups/rakazo-neon/20261025T024500Z \
     --age-identity /path/to/operator/age-identity.txt \
     --target-url "$TARGET_URL"
   ```

   The script will:
   - Verify SHA256 checksums of the dump archive.
   - Stream decrypted bytes directly into `pg_restore` (no plaintext dump touches host disk).
   - Pre-create the unprivileged `rakazo_app` role if needed.
   - Restore database schema, tables, and rows.
   - Query schema table counts to confirm successful restoration.
   - Measure and report elapsed RTO against the 900-second target ceiling.

3. **Cutover to Restored Database**:
   Once verified, set the restored branch as the primary endpoint in `/srv/rakazo/.env` and restart the stack.

---

### Scenario C: Offline Integrity Verification (Routine Drill)

To confirm that backup archives decrypt cleanly and have valid internal table manifests without touching any database:

```bash
/srv/rakazo/infra/scripts/neon-restore-drill.sh \
  /var/backups/rakazo-neon/20261025T024500Z \
  --age-identity /path/to/operator/age-identity.txt
```

---

## 5. Security & Key Management

- **Public Key Only on Host**: The production host and backup timer hold only the public age recipient key or GPG recipient. They CANNOT decrypt previously taken backups.
- **Private Key Custody**: Decryption identities (`age-identity.txt` or GPG private keys) must be stored in the organization's encrypted password manager or KMS, separate from the database host.
- **Row-Level Security Continuity**: After restoring into a target branch, verify that `rakazo_app` has `rolbypassrls = false`:

```bash
psql "$TARGET_URL" -c "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'rakazo_app';"
```
