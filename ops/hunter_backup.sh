#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${HUNTER_APP_ROOT:-/opt/hunter}"
STATE_DIR="${HUNTER_STATE_DIR:-$APP_ROOT/state}"
BACKUP_ROOT="${HUNTER_BACKUP_ROOT:-$APP_ROOT/backups}"
DB_PATH="${HUNTER_DB_PATH:-$STATE_DIR/dev.db}"
UPLOADS_PATH="${HUNTER_UPLOADS_PATH:-$STATE_DIR/uploads}"
ASSETS_PATH="${HUNTER_ASSETS_PATH:-$STATE_DIR/assets}"
RETENTION_DAYS="${HUNTER_BACKUP_RETENTION_DAYS:-14}"
S3_BUCKET="${S3_BACKUP_BUCKET:-}"
S3_PREFIX="${S3_BACKUP_PREFIX:-hunter}"

timestamp="$(date +%Y-%m-%d_%H-%M-%S)"
backup_dir="$BACKUP_ROOT/$timestamp"
manifest="$backup_dir/manifest.txt"
sha_file="$backup_dir/SHA256SUMS.txt"
disk_file="$backup_dir/df-hT.txt"

log() {
  printf '[hunter_backup] %s\n' "$*"
}

fail() {
  printf '[hunter_backup] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 no está instalado."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum no está instalado."

sqlite_backup_with_retry() {
  local src_db="${1:-}"
  local dst_db="${2:-}"
  local attempts="${HUNTER_SQLITE_BACKUP_RETRIES:-8}"
  local sleep_seconds="${HUNTER_SQLITE_BACKUP_RETRY_SLEEP_SEC:-2}"
  local timeout_ms="${HUNTER_SQLITE_BACKUP_TIMEOUT_MS:-8000}"
  local attempt=1
  local last_err=""
  while [[ "$attempt" -le "$attempts" ]]; do
    if sqlite3 "$src_db" <<SQL >/dev/null 2>"$backup_dir/sqlite-backup.err"
.timeout $timeout_ms
.backup '$dst_db'
SQL
    then
      rm -f "$backup_dir/sqlite-backup.err" >/dev/null 2>&1 || true
      return 0
    fi
    last_err="$(tr '\n' ' ' < "$backup_dir/sqlite-backup.err" 2>/dev/null || echo "unknown sqlite backup error")"
    log "SQLite backup intento ${attempt}/${attempts} falló: ${last_err}"
    rm -f "$dst_db" >/dev/null 2>&1 || true
    attempt=$((attempt + 1))
    sleep "$sleep_seconds"
  done
  fail "No se pudo respaldar SQLite tras ${attempts} intentos: ${last_err}"
}

mkdir -p "$backup_dir"

[[ -f "$DB_PATH" ]] || fail "DB no encontrada en $DB_PATH"
[[ -d "$UPLOADS_PATH" ]] || fail "Uploads no encontrado en $UPLOADS_PATH"
if [[ ! -d "$ASSETS_PATH" ]]; then
  mkdir -p "$ASSETS_PATH"
fi

log "Creando backup en $backup_dir"

sqlite_backup_with_retry "$DB_PATH" "$backup_dir/dev.db"
tar -czf "$backup_dir/uploads.tar.gz" -C "$STATE_DIR" "$(basename "$UPLOADS_PATH")"
tar -czf "$backup_dir/assets.tar.gz" -C "$STATE_DIR" "$(basename "$ASSETS_PATH")"

git_sha="unknown"
if [[ -d "$APP_ROOT/.git" ]]; then
  git_sha="$(git -C "$APP_ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
elif [[ -d "$APP_ROOT/current/.git" ]]; then
  git_sha="$(git -C "$APP_ROOT/current" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi

df -hT > "$disk_file" || true

{
  echo "timestamp=$timestamp"
  echo "hostname=$(hostname -f 2>/dev/null || hostname)"
  echo "git_sha=$git_sha"
  echo "app_root=$APP_ROOT"
  echo "state_dir=$STATE_DIR"
  echo "db_path=$DB_PATH"
  echo "uploads_path=$UPLOADS_PATH"
  echo "assets_path=$ASSETS_PATH"
  echo "db_size_bytes=$(stat -c%s "$backup_dir/dev.db" 2>/dev/null || echo 0)"
  echo "uploads_tar_size_bytes=$(stat -c%s "$backup_dir/uploads.tar.gz" 2>/dev/null || echo 0)"
  echo "assets_tar_size_bytes=$(stat -c%s "$backup_dir/assets.tar.gz" 2>/dev/null || echo 0)"
  echo ""
  echo "[df -hT]"
  cat "$disk_file"
} > "$manifest"

(
  cd "$backup_dir"
  sha256sum dev.db uploads.tar.gz assets.tar.gz > "$sha_file"
)

find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -print0 | xargs -0r rm -rf --

if [[ -n "$S3_BUCKET" ]]; then
  if command -v aws >/dev/null 2>&1; then
    target="s3://$S3_BUCKET/$S3_PREFIX/backups/$timestamp/"
    log "Subiendo backup a $target"
    aws s3 cp "$backup_dir/" "$target" --recursive
  else
    fail "S3_BACKUP_BUCKET está definido pero aws cli no está instalado."
  fi
fi

log "OK backup_dir=$backup_dir"
echo "$backup_dir"
