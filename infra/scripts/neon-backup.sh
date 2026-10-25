#!/usr/bin/env bash
set -euo pipefail
umask 077

# neon-backup.sh - Logical encrypted backup for Lakebase Postgres (Neon)
# Generates a custom-format dump, streams through encryption, verifies without
# needing private keys on the host, creates SHA256 checksums, and manages retention.

usage() {
  cat <<'EOF'
Usage: neon-backup.sh [OPTIONS]

Options:
  --database-url <url>              Database URL (defaults to DATABASE_URL,
                                    DATABASE_MIGRATION_URL, or RAKAZO_BACKUP_DATABASE_URL)
  --out-dir <dir>                   Directory to store backups (default: /var/backups/rakazo-neon
                                    or $PWD/backups/neon if root is unavailable)
  --keep <N>                        Number of verified snapshots to keep (default: 3)
  --age-recipient <key>             Public age recipient key (can be repeated)
  --age-recipients-file <file>      File containing public age recipient keys
  --gpg-recipient <id>              GPG public key recipient
  --gpg-passphrase-file <file>      GPG passphrase file for symmetric AES256 encryption
  --allow-plaintext                 Allow unencrypted backups (unsafe for production)
  --dry-run                         Verify connectivity and tools without creating a dump
  --alert-on-failure                Invoke host-alert.py if the backup fails
  -h, --help                        Show this help message
EOF
  exit 1
}

mask_url() {
  local url="$1"
  echo "${url}" | sed -E 's|://([^:]+):([^@]+)@|://\1:***@|g'
}

ensure_ssl() {
  local url="$1"
  if [[ "${url}" != *"sslmode="* ]]; then
    if [[ "${url}" == *"?"* ]]; then
      echo "${url}&sslmode=require"
    else
      echo "${url}?sslmode=require"
    fi
  else
    echo "${url}"
  fi
}

# Parse command-line arguments
RAW_DATABASE_URL="${DATABASE_URL:-${DATABASE_MIGRATION_URL:-${RAKAZO_BACKUP_DATABASE_URL:-}}}"
BACKUP_ROOT="${RAKAZO_BACKUP_ROOT:-}"
KEEP="${RAKAZO_BACKUP_KEEP:-3}"
AGE_RECIPIENTS=(${RAKAZO_BACKUP_AGE_RECIPIENTS:-})
AGE_RECIPIENTS_FILE="${RAKAZO_BACKUP_AGE_RECIPIENTS_FILE:-}"
GPG_RECIPIENT="${RAKAZO_BACKUP_GPG_RECIPIENT:-}"
GPG_PASSPHRASE_FILE="${RAKAZO_BACKUP_GPG_PASSPHRASE_FILE:-}"
ALLOW_PLAINTEXT="${RAKAZO_BACKUP_ALLOW_PLAINTEXT:-0}"
DRY_RUN=0
ALERT_ON_FAILURE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --database-url)
      [[ $# -ge 2 ]] || usage
      RAW_DATABASE_URL="$2"
      shift 2
      ;;
    --out-dir)
      [[ $# -ge 2 ]] || usage
      BACKUP_ROOT="$2"
      shift 2
      ;;
    --keep)
      [[ $# -ge 2 ]] || usage
      KEEP="$2"
      shift 2
      ;;
    --age-recipient)
      [[ $# -ge 2 ]] || usage
      AGE_RECIPIENTS+=("$2")
      shift 2
      ;;
    --age-recipients-file)
      [[ $# -ge 2 ]] || usage
      AGE_RECIPIENTS_FILE="$2"
      shift 2
      ;;
    --gpg-recipient)
      [[ $# -ge 2 ]] || usage
      GPG_RECIPIENT="$2"
      shift 2
      ;;
    --gpg-passphrase-file)
      [[ $# -ge 2 ]] || usage
      GPG_PASSPHRASE_FILE="$2"
      shift 2
      ;;
    --allow-plaintext)
      ALLOW_PLAINTEXT=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --alert-on-failure)
      ALERT_ON_FAILURE=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

# Validate database URL
[[ -n "${RAW_DATABASE_URL}" ]] || {
  echo "Error: Database connection URL is required (set DATABASE_URL or pass --database-url)" >&2
  exit 1
}
TARGET_DATABASE_URL="$(ensure_ssl "${RAW_DATABASE_URL}")"
MASKED_DATABASE_URL="$(mask_url "${TARGET_DATABASE_URL}")"

# Validate retention parameter
[[ "${KEEP}" =~ ^[1-9][0-9]*$ ]] || {
  echo "Error: Retention count (--keep) must be a positive integer" >&2
  exit 1
}

# Determine backup directory
if [[ -z "${BACKUP_ROOT}" ]]; then
  if [[ -w "/var/backups" || ("$EUID" -eq 0 && -d "/var/backups") ]]; then
    BACKUP_ROOT="/var/backups/rakazo-neon"
  else
    BACKUP_ROOT="${PWD}/backups/neon"
  fi
fi

if [[ "${BACKUP_ROOT}" != /* ]]; then
  echo "Error: Output directory must be an absolute path: ${BACKUP_ROOT}" >&2
  exit 1
fi

# Determine encryption configuration
ENCRYPTION_MODE="none"
SUFFIX=""
age_args=()

if [[ -n "${AGE_RECIPIENTS_FILE}" ]]; then
  [[ -r "${AGE_RECIPIENTS_FILE}" && -s "${AGE_RECIPIENTS_FILE}" ]] || {
    echo "Error: Age recipients file is not readable or is empty: ${AGE_RECIPIENTS_FILE}" >&2
    exit 1
  }
  age_args+=(-R "${AGE_RECIPIENTS_FILE}")
fi

for recipient in "${AGE_RECIPIENTS[@]}"; do
  age_args+=(-r "${recipient}")
done

if ((${#age_args[@]} > 0)); then
  command -v age >/dev/null || { echo "Error: age is required for encryption but was not found in PATH" >&2; exit 1; }
  age --encrypt "${age_args[@]}" </dev/null >/dev/null || {
    echo "Error: age rejected the configured backup recipients" >&2
    exit 1
  }
  ENCRYPTION_MODE="age"
  SUFFIX=".age"
elif [[ -n "${GPG_RECIPIENT}" ]]; then
  command -v gpg >/dev/null || { echo "Error: gpg is required for GPG encryption but was not found in PATH" >&2; exit 1; }
  ENCRYPTION_MODE="gpg-recipient"
  SUFFIX=".gpg"
elif [[ -n "${GPG_PASSPHRASE_FILE}" ]]; then
  [[ -r "${GPG_PASSPHRASE_FILE}" && -s "${GPG_PASSPHRASE_FILE}" ]] || {
    echo "Error: GPG passphrase file is not readable or is empty: ${GPG_PASSPHRASE_FILE}" >&2
    exit 1
  }
  command -v gpg >/dev/null || { echo "Error: gpg is required for GPG encryption but was not found in PATH" >&2; exit 1; }
  ENCRYPTION_MODE="gpg-symmetric"
  SUFFIX=".gpg"
fi

if [[ "${ENCRYPTION_MODE}" == "none" ]]; then
  if [[ "${ALLOW_PLAINTEXT}" != "1" && "${DRY_RUN}" != "1" ]]; then
    echo "Error: Backups must be encrypted for production safety." >&2
    echo "Provide --age-recipient, --age-recipients-file, --gpg-recipient, or --gpg-passphrase-file." >&2
    echo "To explicitly accept unencrypted dumps, pass --allow-plaintext." >&2
    exit 1
  fi
  if [[ "${DRY_RUN}" != "1" ]]; then
    echo "WARNING: Backup is unencrypted. Set encryption recipients for production safety." >&2
  fi
fi

# Required tools
for tool in pg_dump pg_restore sha256sum; do
  command -v "${tool}" >/dev/null || {
    echo "Error: Required tool '${tool}' is not installed or not in PATH" >&2
    exit 1
  }
done

# Perform Dry-Run if requested
if [[ "${DRY_RUN}" == "1" ]]; then
  echo "Running backup preflight dry-run..."
  echo "Database target: ${MASKED_DATABASE_URL}"
  echo "Backup directory: ${BACKUP_ROOT}"
  echo "Encryption mode: ${ENCRYPTION_MODE}"
  
  # Check database connectivity
  if command -v psql >/dev/null; then
    psql "${TARGET_DATABASE_URL}" -c "SELECT 1 AS ready;" >/dev/null 2>&1 || {
      echo "Error: Failed to connect to database at ${MASKED_DATABASE_URL}" >&2
      exit 2
    }
  fi
  echo "Dry-run successful: connectivity verified and preflight checks passed."
  exit 0
fi

# Ensure backup destination exists
install -d -m 700 "${BACKUP_ROOT}"

# Acquire exclusive run lock
exec 9>"${BACKUP_ROOT}/.lock"
flock -n 9 || {
  echo "Error: Another Neon backup is currently running" >&2
  exit 1
}

# Listing verified snapshots
snapshots() {
  find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
    -regex '.*/[0-9]{8}T[0-9]{6}Z' -print | sort -r
}

# Clean partial or abandoned runs before starting
verified_dirs=()
while read -r dir; do
  [[ -n "${dir}" ]] || continue
  if [[ -f "${dir}/SHA256SUMS" ]]; then
    verified_dirs+=("${dir}")
  else
    rm -rf -- "${dir}"
  fi
done < <(snapshots)

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAPSHOT_DIR="${BACKUP_ROOT}/${STAMP}"
mkdir -m 700 -- "${SNAPSHOT_DIR}"

verified=0
cleanup() {
  local exit_code=$?
  if [[ "${verified}" != "1" ]]; then
    rm -rf -- "${SNAPSHOT_DIR}"
    if [[ "${ALERT_ON_FAILURE}" == "1" ]]; then
      local alert_script="$(dirname "$0")/../compose/host-alert.py"
      if [[ -x "${alert_script}" ]]; then
        "${alert_script}" neon-backup-failed "Neon database backup failed for ${MASKED_DATABASE_URL}" || true
      fi
    fi
  fi
  exit "${exit_code}"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Stream writer through configured encryption
seal() {
  local target_file="$1"
  if [[ "${ENCRYPTION_MODE}" == "age" ]]; then
    age --encrypt "${age_args[@]}" -o "${target_file}"
  elif [[ "${ENCRYPTION_MODE}" == "gpg-recipient" ]]; then
    gpg --batch --yes --encrypt --recipient "${GPG_RECIPIENT}" --output "${target_file}"
  elif [[ "${ENCRYPTION_MODE}" == "gpg-symmetric" ]]; then
    gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file "${GPG_PASSPHRASE_FILE}" --output "${target_file}"
  else
    cat > "${target_file}"
  fi
}

dump_file="${SNAPSHOT_DIR}/rakazo.dump${SUFFIX}"
pipe="${SNAPSHOT_DIR}/.verify"
mkfifo -m 600 -- "${pipe}"

# Verifier runs concurrently reading the plaintext stream from FIFO
(
  pg_restore --list >/dev/null && cat >/dev/null
) <"${pipe}" &
verifier_pid=$!

echo "Starting logical dump from ${MASKED_DATABASE_URL}..."
set +e
pg_dump --format=custom --no-owner --no-privileges --dbname="${TARGET_DATABASE_URL}" \
  | tee -- "${pipe}" \
  | seal "${dump_file}"
dump_status=("${PIPESTATUS[@]}")
set -e

wait "${verifier_pid}"
verifier_status=$?
rm -f -- "${pipe}"

if (( dump_status[0] != 0 )); then
  echo "Error: pg_dump failed with exit code ${dump_status[0]}" >&2
  exit 2
fi

if (( dump_status[1] != 0 || dump_status[2] != 0 )); then
  echo "Error: Dump stream processing / sealing failed" >&2
  exit 2
fi

if (( verifier_status != 0 )); then
  echo "Error: Backup verification failed (corrupt dump stream)" >&2
  exit 2
fi

# Write checksums
(
  cd "${SNAPSHOT_DIR}"
  sha256sum -- "rakazo.dump${SUFFIX}" > SHA256SUMS
)

# Record metadata
cat <<EOF > "${SNAPSHOT_DIR}/METADATA.json"
{
  "timestamp": "${STAMP}",
  "database": "${MASKED_DATABASE_URL}",
  "encryption": "${ENCRYPTION_MODE}",
  "verified": true
}
EOF

verified=1
echo "Backup successfully created and verified: ${SNAPSHOT_DIR}"

# Apply retention policy
verified_dirs=("${SNAPSHOT_DIR}" "${verified_dirs[@]}")
while ((${#verified_dirs[@]} > KEEP)); do
  oldest_index=$((${#verified_dirs[@]} - 1))
  rm -rf -- "${verified_dirs[oldest_index]}"
  unset 'verified_dirs[oldest_index]'
done

exit 0
