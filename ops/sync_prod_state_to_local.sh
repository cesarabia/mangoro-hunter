#!/usr/bin/env bash
set -euo pipefail

# PLAN-ONLY helper for ER-P14
# This script DOES NOT copy or modify anything.
# It prints a safe, read-only migration plan to clone hunter-prod state into local dev.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_STATE_DIR="${ROOT_DIR}/tmp/local-state"
LOCAL_DB_PATH="${LOCAL_STATE_DIR}/dev.local.snapshot.db"
LOCAL_UPLOADS_DIR="${LOCAL_STATE_DIR}/uploads"
LOCAL_ASSETS_DIR="${LOCAL_STATE_DIR}/assets"

REMOTE_HOST="${HUNTER_PROD_HOST:-ubuntu@16.59.92.121}"
REMOTE_DB_PATH="${HUNTER_PROD_DB_PATH:-/opt/hunter/state/dev.db}"
REMOTE_UPLOADS_PATH="${HUNTER_PROD_UPLOADS_PATH:-/opt/hunter/state/uploads}"
REMOTE_ASSETS_PATH="${HUNTER_PROD_ASSETS_PATH:-/opt/hunter/state/assets}"
REMOTE_SSH_KEY="${HUNTER_PROD_SSH_KEY:-/Users/cesar/dev/LightsailDefaultKey-us-east-2.pem}"

cat <<EOF
ER-P14 PLAN ONLY — PROD -> LOCAL state sync

No actions executed. Commands below are for reviewed/manual execution later.

1) Preconditions
- Ensure local directories exist:
  mkdir -p "${LOCAL_STATE_DIR}" "${LOCAL_UPLOADS_DIR}" "${LOCAL_ASSETS_DIR}"
- Ensure local backend is stopped before replacing local snapshot DB.

2) Remote read-only checks
  ssh -i "${REMOTE_SSH_KEY}" "${REMOTE_HOST}" "ls -lah ${REMOTE_DB_PATH}"
  ssh -i "${REMOTE_SSH_KEY}" "${REMOTE_HOST}" "du -sh ${REMOTE_UPLOADS_PATH} ${REMOTE_ASSETS_PATH}"

3) Copy snapshot DB from PROD to LOCAL (read-only source)
  scp -i "${REMOTE_SSH_KEY}" "${REMOTE_HOST}:${REMOTE_DB_PATH}" "${LOCAL_DB_PATH}"

4) Copy uploads/assets from PROD to LOCAL (read-only source)
  rsync -avz --progress -e "ssh -i ${REMOTE_SSH_KEY}" "${REMOTE_HOST}:${REMOTE_UPLOADS_PATH}/" "${LOCAL_UPLOADS_DIR}/"
  rsync -avz --progress -e "ssh -i ${REMOTE_SSH_KEY}" "${REMOTE_HOST}:${REMOTE_ASSETS_PATH}/" "${LOCAL_ASSETS_DIR}/"

5) Optional anonymization (recommended before QA)
- Candidate/contact PII anonymization should be applied only on local copy.
- Example (local DB only):
  sqlite3 "${LOCAL_DB_PATH}" "update Contact set email=null, rut=null where workspaceId='envio-rapido';"

6) Wire backend local env to local snapshot copy
- DATABASE_URL should point to local snapshot, never to prod:
  DATABASE_URL="file:${LOCAL_DB_PATH}"
- Local state dirs (uploads/assets) should also point to local paths:
  HUNTER_STATE_UPLOADS_PATH="${LOCAL_UPLOADS_DIR}"
  HUNTER_ASSETS_DIR="${LOCAL_ASSETS_DIR}"

7) Safety rules
- Local never writes to prod.
- Prod never reads local DB.
- Do not reuse prod SSH key in app runtime env.

EOF
