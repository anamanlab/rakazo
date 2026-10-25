#!/usr/bin/env bash
set -euo pipefail
umask 077

# neon-restore-drill.sh - Drill / disaster recovery verification for Lakebase Postgres (Neon)
# Verifies checksums, decrypts streams in-memory without plaintext on disk,
# performs structural TOC validation, and optionally restores into an isolated Neon branch.

usage() {
  cat <<'EOF'
Usage: neon-restore-drill.sh <SNAPSHOT_DIR> [OPTIONS]

Options:
  --age-identity <file>         Age identity file containing private key
  --gpg-passphrase-file <file>  GPG passphrase file for symmetric decryption
  --target-url <url>            Target database URL (e.g. an isolated Neon branch)
  --max-rto-seconds <seconds>   Maximum allowable recovery time in seconds (default: 900)
  --skip-checksum               Skip SHA256 checksum verification
  -h, --help                    Show this help message
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

[[ $# -ge 1 ]] || usage
SNAPSHOT_DIR="$1"
shift

AGE_IDENTITY="${RAKAZO_BACKUP_AGE_IDENTITY:-}"
GPG_PASSPHRASE_FILE=""
TARGET_URL=""
MAX_RTO_SECONDS=900
SKIP_CHECKSUM=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --age-identity)
      [[ $# -ge 2 ]] || usage
      AGE_IDENTITY="$2"
      shift 2
      ;;
    --gpg-passphrase-file)
      [[ $# -ge 2 ]] || usage
      GPG_PASSPHRASE_FILE="$2"
      shift 2
      ;;
    --target-url)
      [[ $# -ge 2 ]] || usage
      TARGET_URL="$2"
      shift 2
      ;;
    --max-rto-seconds)
      [[ $# -ge 2 ]] || usage
      MAX_RTO_SECONDS="$2"
      shift 2
      ;;
    --skip-checksum)
      SKIP_CHECKSUM=1
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

[[ -d "${SNAPSHOT_DIR}" ]] || {
  echo "Error: Snapshot directory does not exist: ${SNAPSHOT_DIR}" >&2
  exit 1
}

# Verify checksums
if [[ "${SKIP_CHECKSUM}" != "1" ]]; then
  [[ -f "${SNAPSHOT_DIR}/SHA256SUMS" ]] || {
    echo "Error: SHA256SUMS missing from snapshot directory" >&2
    exit 1
  }
  echo "Verifying snapshot file integrity via SHA256..."
  (cd "${SNAPSHOT_DIR}" && sha256sum --check --quiet SHA256SUMS) || {
    echo "Error: SHA256 checksum verification failed" >&2
    exit 1
  }
  echo "Checksum verification OK."
fi

# Locate dump file
DUMP_FILE=""
ENCRYPTION_TYPE="plaintext"
if [[ -f "${SNAPSHOT_DIR}/rakazo.dump.age" ]]; then
  DUMP_FILE="${SNAPSHOT_DIR}/rakazo.dump.age"
  ENCRYPTION_TYPE="age"
elif [[ -f "${SNAPSHOT_DIR}/rakazo.dump.gpg" ]]; then
  DUMP_FILE="${SNAPSHOT_DIR}/rakazo.dump.gpg"
  ENCRYPTION_TYPE="gpg"
elif [[ -f "${SNAPSHOT_DIR}/rakazo.dump" ]]; then
  DUMP_FILE="${SNAPSHOT_DIR}/rakazo.dump"
  ENCRYPTION_TYPE="none"
else
  echo "Error: No recognized database dump found in ${SNAPSHOT_DIR}" >&2
  exit 1
fi

for tool in pg_restore sha256sum; do
  command -v "${tool}" >/dev/null || {
    echo "Error: Required tool '${tool}' is not installed" >&2
    exit 1
  }
done

if [[ "${ENCRYPTION_TYPE}" == "age" ]]; then
  command -v age >/dev/null || { echo "Error: age is required to decrypt snapshot" >&2; exit 1; }
  [[ -n "${AGE_IDENTITY}" && -r "${AGE_IDENTITY}" ]] || {
    echo "Error: Age identity file is required (--age-identity)" >&2
    exit 1
  }
elif [[ "${ENCRYPTION_TYPE}" == "gpg" ]]; then
  command -v gpg >/dev/null || { echo "Error: gpg is required to decrypt snapshot" >&2; exit 1; }
fi

# Decrypt command stream
decrypt_stream() {
  if [[ "${ENCRYPTION_TYPE}" == "age" ]]; then
    age --decrypt -i "${AGE_IDENTITY}" "${DUMP_FILE}"
  elif [[ "${ENCRYPTION_TYPE}" == "gpg" ]]; then
    if [[ -n "${GPG_PASSPHRASE_FILE}" ]]; then
      gpg --batch --yes --decrypt --passphrase-file "${GPG_PASSPHRASE_FILE}" "${DUMP_FILE}"
    else
      gpg --batch --yes --decrypt "${DUMP_FILE}"
    fi
  else
    cat "${DUMP_FILE}"
  fi
}

START_TIME=$(date +%s)

if [[ -z "${TARGET_URL}" ]]; then
  echo "Executing offline verification drill for snapshot ${SNAPSHOT_DIR}..."
  # Decrypt stream directly into pg_restore --list to authenticate every chunk without disk writes
  decrypt_stream | { pg_restore --list >/dev/null && cat >/dev/null; }
  
  END_TIME=$(date +%s)
  ELAPSED=$((END_TIME - START_TIME))
  echo "Offline drill PASSED: Decrypted and authenticated dump stream in ${ELAPSED}s (RTO ceiling: ${MAX_RTO_SECONDS}s)."
  
  if (( ELAPSED > MAX_RTO_SECONDS )); then
    echo "Warning: Drill duration (${ELAPSED}s) exceeded maximum RTO threshold (${MAX_RTO_SECONDS}s)" >&2
    exit 3
  fi
else
  TARGET_CONN="$(ensure_ssl "${TARGET_URL}")"
  MASKED_TARGET="$(mask_url "${TARGET_CONN}")"
  
  echo "Executing restore rehearsal drill into target branch ${MASKED_TARGET}..."
  command -v psql >/dev/null || { echo "Error: psql is required for target database restore drill" >&2; exit 1; }
  
  # Ensure target role exists
  psql "${TARGET_CONN}" --set=ON_ERROR_STOP=on -c \
    "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rakazo_app') THEN CREATE ROLE rakazo_app NOLOGIN; END IF; END \$\$" >/dev/null
  
  # Stream restore into target
  decrypt_stream | pg_restore --no-owner --no-privileges --clean --if-exists --dbname="${TARGET_CONN}" >/dev/null
  
  # Structural integrity checks on restored database
  TABLE_COUNT="$(psql "${TARGET_CONN}" -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")"
  
  END_TIME=$(date +%s)
  ELAPSED=$((END_TIME - START_TIME))
  
  echo "Restore rehearsal drill PASSED: Successfully restored ${TABLE_COUNT} public tables in ${ELAPSED}s (RTO ceiling: ${MAX_RTO_SECONDS}s)."
  
  if (( ELAPSED > MAX_RTO_SECONDS )); then
    echo "Warning: Restore duration (${ELAPSED}s) exceeded maximum RTO threshold (${MAX_RTO_SECONDS}s)" >&2
    exit 3
  fi
fi

exit 0
