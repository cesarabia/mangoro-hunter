#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${HUNTER_APP_ROOT:-/opt/hunter}"
STATE_DIR="${HUNTER_STATE_DIR:-$APP_ROOT/state}"
BACKUP_ROOT="${HUNTER_BACKUP_ROOT:-$APP_ROOT/backups}"
DB_PATH="${HUNTER_DB_PATH:-$STATE_DIR/dev.db}"
UPLOADS_PATH="${HUNTER_UPLOADS_PATH:-$STATE_DIR/uploads}"
PROCESS_NAME="${HUNTER_PM2_PROCESS:-hunter-backend}"

usage() {
  cat <<'EOF'
Uso:
  ops/hunter_restore.sh <timestamp|absolute_backup_dir> [--execute]

Modo por defecto:
  - PLAN ONLY (no cambia nada), imprime pasos y comandos de restore.

Para ejecutar restore real:
  - agregar --execute
  - confirmar variable HUNTER_RESTORE_CONFIRM=YES

Ejemplo:
  HUNTER_RESTORE_CONFIRM=YES ops/hunter_restore.sh 2026-03-07_10-15-00 --execute
EOF
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

backup_ref="$1"
execute_mode="false"
if [[ "${2:-}" == "--execute" || "${3:-}" == "--execute" ]]; then
  execute_mode="true"
fi

if [[ "$backup_ref" == /* ]]; then
  backup_dir="$backup_ref"
else
  backup_dir="$BACKUP_ROOT/$backup_ref"
fi

[[ -d "$backup_dir" ]] || { echo "ERROR: backup no encontrado: $backup_dir" >&2; exit 1; }
[[ -f "$backup_dir/dev.db" ]] || { echo "ERROR: falta $backup_dir/dev.db" >&2; exit 1; }
[[ -f "$backup_dir/uploads.tar.gz" ]] || { echo "ERROR: falta $backup_dir/uploads.tar.gz" >&2; exit 1; }

echo "[PLAN] Restore Hunter desde: $backup_dir"
echo "1) Verificar integridad:"
echo "   cd \"$backup_dir\" && sha256sum -c SHA256SUMS.txt"
echo "2) Tomar backup de seguridad actual:"
echo "   \"$APP_ROOT/ops/hunter_backup.sh\""
echo "3) Detener proceso backend:"
echo "   pm2 stop \"$PROCESS_NAME\""
echo "4) Restaurar DB SQLite:"
echo "   install -m 640 \"$backup_dir/dev.db\" \"$DB_PATH\""
echo "5) Restaurar uploads:"
echo "   rm -rf \"$UPLOADS_PATH\" && mkdir -p \"$UPLOADS_PATH\""
echo "   tar -xzf \"$backup_dir/uploads.tar.gz\" -C \"$STATE_DIR\""
echo "6) Levantar backend y validar:"
echo "   pm2 start \"$PROCESS_NAME\""
echo "   curl -fsS http://127.0.0.1:4101/api/health"

if [[ "$execute_mode" != "true" ]]; then
  echo "[PLAN] No ejecutado (modo seguro por defecto)."
  exit 0
fi

if [[ "${HUNTER_RESTORE_CONFIRM:-}" != "YES" ]]; then
  echo "ERROR: restore bloqueado. Exporta HUNTER_RESTORE_CONFIRM=YES para ejecutar." >&2
  exit 1
fi

command -v pm2 >/dev/null 2>&1 || { echo "ERROR: pm2 no instalado" >&2; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "ERROR: sha256sum no instalado" >&2; exit 1; }

echo "[RESTORE] Verificando checksums..."
(
  cd "$backup_dir"
  sha256sum -c SHA256SUMS.txt
)

echo "[RESTORE] Backup de seguridad previo..."
"$APP_ROOT/ops/hunter_backup.sh"

echo "[RESTORE] Deteniendo $PROCESS_NAME..."
pm2 stop "$PROCESS_NAME" || true

mkdir -p "$(dirname "$DB_PATH")" "$STATE_DIR"
install -m 640 "$backup_dir/dev.db" "$DB_PATH"

rm -rf "$UPLOADS_PATH"
mkdir -p "$UPLOADS_PATH"
tar -xzf "$backup_dir/uploads.tar.gz" -C "$STATE_DIR"

echo "[RESTORE] Levantando $PROCESS_NAME..."
pm2 start "$PROCESS_NAME" || pm2 restart "$PROCESS_NAME"

echo "[RESTORE] Health check..."
curl -fsS http://127.0.0.1:4101/api/health
echo "[RESTORE] OK"
