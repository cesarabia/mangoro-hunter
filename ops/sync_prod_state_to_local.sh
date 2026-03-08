#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_STATE_DIR="${ROOT_DIR}/tmp/local-state"
LOCAL_DB_PATH="${LOCAL_STATE_DIR}/dev.local.snapshot.db"
LOCAL_UPLOADS_DIR="${LOCAL_STATE_DIR}/uploads"
LOCAL_ASSETS_DIR="${LOCAL_STATE_DIR}/assets"
LOCAL_REPORT_PATH="${LOCAL_STATE_DIR}/last-sync-report.txt"

REMOTE_HOST="${HUNTER_PROD_HOST:-ubuntu@16.59.92.121}"
REMOTE_DB_PATH="${HUNTER_PROD_DB_PATH:-/opt/hunter/state/dev.db}"
REMOTE_UPLOADS_PATH="${HUNTER_PROD_UPLOADS_PATH:-/opt/hunter/state/uploads}"
REMOTE_ASSETS_PATH="${HUNTER_PROD_ASSETS_PATH:-/opt/hunter/state/assets}"
REMOTE_SSH_KEY="${HUNTER_PROD_SSH_KEY:-/Users/cesar/dev/LightsailDefaultKey-us-east-2.pem}"

MODE="${1:---plan}"
RUN_AT="$(date '+%Y-%m-%d %H:%M:%S %Z')"

print_plan() {
  cat <<EOF
ER-P14.1 PLAN — PROD -> LOCAL state sync

No actions executed. Run:
  ./ops/sync_prod_state_to_local.sh --execute

Config actual:
- REMOTE_HOST=${REMOTE_HOST}
- REMOTE_DB_PATH=${REMOTE_DB_PATH}
- REMOTE_UPLOADS_PATH=${REMOTE_UPLOADS_PATH}
- REMOTE_ASSETS_PATH=${REMOTE_ASSETS_PATH}
- LOCAL_DB_PATH=${LOCAL_DB_PATH}
- LOCAL_UPLOADS_DIR=${LOCAL_UPLOADS_DIR}
- LOCAL_ASSETS_DIR=${LOCAL_ASSETS_DIR}

Acciones de --execute:
1) Verifica acceso SSH y existencia de DB/uploads/assets en PROD (solo lectura).
2) Copia snapshot DB a local.
3) Sincroniza uploads/assets a local.
4) Aplica hardening local:
   - outboundPolicy=BLOCK_ALL
   - limpia credenciales WhatsApp en SystemConfig
   - limpia reviewEmailTo/reviewEmailFrom en Workspace
5) Genera reporte en ${LOCAL_REPORT_PATH}.

EOF
}

if [[ "${MODE}" != "--execute" ]]; then
  print_plan
  exit 0
fi

mkdir -p "${LOCAL_STATE_DIR}" "${LOCAL_UPLOADS_DIR}" "${LOCAL_ASSETS_DIR}"

if [[ ! -f "${REMOTE_SSH_KEY}" ]]; then
  echo "ERROR: SSH key no encontrada: ${REMOTE_SSH_KEY}" >&2
  exit 1
fi

echo "[sync] ${RUN_AT} | Verificando acceso remoto..."
ssh -i "${REMOTE_SSH_KEY}" -o StrictHostKeyChecking=accept-new "${REMOTE_HOST}" "test -r '${REMOTE_DB_PATH}' && test -d '${REMOTE_UPLOADS_PATH}' && test -d '${REMOTE_ASSETS_PATH}'"

TMP_DB_PATH="${LOCAL_STATE_DIR}/dev.local.snapshot.db.tmp"
echo "[sync] Copiando DB snapshot..."
scp -i "${REMOTE_SSH_KEY}" "${REMOTE_HOST}:${REMOTE_DB_PATH}" "${TMP_DB_PATH}"
mv "${TMP_DB_PATH}" "${LOCAL_DB_PATH}"

echo "[sync] Sincronizando uploads..."
rsync -avz --progress -e "ssh -i ${REMOTE_SSH_KEY}" "${REMOTE_HOST}:${REMOTE_UPLOADS_PATH}/" "${LOCAL_UPLOADS_DIR}/"

echo "[sync] Sincronizando assets..."
rsync -avz --progress -e "ssh -i ${REMOTE_SSH_KEY}" "${REMOTE_HOST}:${REMOTE_ASSETS_PATH}/" "${LOCAL_ASSETS_DIR}/"

if command -v sqlite3 >/dev/null 2>&1; then
  echo "[sync] Aplicando hardening local (BLOCK_ALL + sin credenciales WhatsApp/email)..."
  sqlite3 "${LOCAL_DB_PATH}" "UPDATE SystemConfig SET outboundPolicy='BLOCK_ALL', outboundAllowAllUntil=NULL, whatsappToken=NULL, whatsappPhoneId=NULL, whatsappVerifyToken=NULL;"
  sqlite3 "${LOCAL_DB_PATH}" "UPDATE Workspace SET reviewEmailTo=NULL, reviewEmailFrom=NULL;"
fi

{
  echo "runAt=${RUN_AT}"
  echo "remoteHost=${REMOTE_HOST}"
  echo "remoteDb=${REMOTE_DB_PATH}"
  echo "localDb=${LOCAL_DB_PATH}"
  echo "localUploads=${LOCAL_UPLOADS_DIR}"
  echo "localAssets=${LOCAL_ASSETS_DIR}"
  echo "dbSha256=$(shasum -a 256 "${LOCAL_DB_PATH}" | awk '{print $1}')"
  echo "dbSizeBytes=$(stat -f %z "${LOCAL_DB_PATH}" 2>/dev/null || stat -c %s "${LOCAL_DB_PATH}")"
  echo "uploadsSize=$(du -sh "${LOCAL_UPLOADS_DIR}" | awk '{print $1}')"
  echo "assetsSize=$(du -sh "${LOCAL_ASSETS_DIR}" | awk '{print $1}')"
} > "${LOCAL_REPORT_PATH}"

echo "[sync] OK. Reporte: ${LOCAL_REPORT_PATH}"
