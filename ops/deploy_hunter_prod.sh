#!/usr/bin/env bash
set -euo pipefail

# Hunter PROD deploy guardrails (NEW server only)
# Local usage: ./ops/deploy_hunter_prod.sh
# Remote usage (internal): HUNTER_DEPLOY_REMOTE=1 ./ops/deploy_hunter_prod.sh

OLD_HOST_KEYWORDS=("mangoro-prod" "3.148.219.40")
DEFAULT_REMOTE_HOST="ubuntu@16.59.92.121"
REMOTE_HOST="${HUNTER_PROD_HOST:-$DEFAULT_REMOTE_HOST}"
REMOTE_KEY="${HUNTER_PROD_SSH_KEY:-$HOME/Documents/dev/mangoro/LightsailDefaultKey-us-east-2.pem}"
EXPECTED_NEW_IP="16.59.92.121"
APP_ROOT="/opt/hunter"
SOURCE_DIR="${HUNTER_SOURCE_DIR:-$APP_ROOT}"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"
STATE_DIR="$APP_ROOT/state"
BACKUPS_DIR="$APP_ROOT/backups"
LOG_DIR="$APP_ROOT/ops"
NEW_SERVER_MARKER="$APP_ROOT/ops/IS_NEW_SERVER"
BACKUP_SCRIPT="$APP_ROOT/ops/hunter_backup.sh"

log() {
  printf '[deploy_hunter_prod] %s\n' "$*"
}

abort_old_host() {
  local value="${1:-}"
  for forbidden in "${OLD_HOST_KEYWORDS[@]}"; do
    if [[ "$value" == *"$forbidden"* ]]; then
      echo "ERROR: destino prohibido detectado ($value). Este script solo permite hunter-prod." >&2
      exit 1
    fi
  done
}

extract_host() {
  local value="${1:-}"
  value="${value#*@}"
  value="${value%%:*}"
  echo "$value"
}

ensure_expected_remote_target() {
  local host_raw
  host_raw="$(extract_host "$REMOTE_HOST")"
  if [[ "$host_raw" != "$EXPECTED_NEW_IP" ]]; then
    echo "ERROR: target inválido. Solo se permite $EXPECTED_NEW_IP (recibido: $host_raw)" >&2
    exit 1
  fi
}

is_new_server_marker_ok() {
  local marker_value
  marker_value="$(tr -d '\r\n ' < "$NEW_SERVER_MARKER" 2>/dev/null || true)"
  [[ "$marker_value" == "true" ]]
}

safe_stat_bytes() {
  local file="${1:-}"
  if [[ -f "$file" ]]; then
    stat -c%s "$file" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

sqlite_metric() {
  local db_file="${1:-}"
  local sql="${2:-}"
  sqlite3 "$db_file" "$sql" 2>/dev/null || echo 0
}

db_metrics() {
  local db_file="${1:-}"
  local size_bytes conv_count msg_count
  size_bytes="$(safe_stat_bytes "$db_file")"
  conv_count="$(sqlite_metric "$db_file" 'select count(*) from Conversation;')"
  msg_count="$(sqlite_metric "$db_file" 'select count(*) from Message;')"
  echo "$size_bytes,$conv_count,$msg_count"
}

trim_quotes() {
  local value="${1:-}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  echo "$value"
}

database_url_from_env_file() {
  local env_file="${1:-}"
  [[ -f "$env_file" ]] || return 1
  local raw
  raw="$(grep -E '^DATABASE_URL=' "$env_file" | tail -n1 | cut -d= -f2- || true)"
  raw="$(trim_quotes "$raw")"
  [[ -n "$raw" ]] || return 1
  echo "$raw"
}

resolve_database_file_path() {
  local db_url="${1:-}"
  local base_dir="${2:-$APP_ROOT}"
  if [[ "$db_url" != file:* ]]; then
    return 1
  fi
  local file_path="${db_url#file:}"
  if [[ -z "$file_path" ]]; then
    return 1
  fi
  if [[ "$file_path" == /* ]]; then
    echo "$file_path"
  else
    python3 - <<PY
import os
print(os.path.realpath(os.path.join(${base_dir@Q}, ${file_path@Q})))
PY
  fi
}

guard_database_url_not_in_code_tree() {
  local env_file="${1:-}"
  local db_url
  db_url="$(database_url_from_env_file "$env_file" || true)"
  [[ -n "$db_url" ]] || return 0
  local db_path
  db_path="$(resolve_database_file_path "$db_url" "$APP_ROOT" || true)"
  [[ -n "$db_path" ]] || return 0

  local code_roots=("$APP_ROOT" "$SOURCE_DIR" "$RELEASES_DIR")
  for root in "${code_roots[@]}"; do
    if [[ "$db_path" == "$root/"* ]] && [[ "$db_path" != "$STATE_DIR/"* ]] && [[ "$db_path" != "$BACKUPS_DIR/"* ]]; then
      echo "ERROR: DATABASE_URL apunta dentro del árbol de código/releases ($db_path). Usa $STATE_DIR/dev.db" >&2
      exit 1
    fi
  done
}

rollback_to_previous_release() {
  local previous_release="${1:-}"
  if [[ -z "$previous_release" || ! -d "$previous_release" ]]; then
    log "Rollback omitido: no hay release previo válido."
    return 1
  fi
  local previous_sha
  previous_sha="$(basename "$previous_release" | cut -d- -f1)"
  export HUNTER_BUILD_SHA="$previous_sha"
  export HUNTER_BUILD_DIRTY="false"
  log "Rollback automático a release previo: $previous_release"
  ln -sfn "$previous_release" "$CURRENT_LINK"
  pm2 delete hunter-backend >/dev/null 2>&1 || true
  pm2 start "$CURRENT_LINK/ecosystem.config.cjs" --only hunter-backend --update-env || pm2 restart hunter-backend --update-env
  return 0
}

rotate_backups() {
  ls -1t "$BACKUPS_DIR"/dev.db.*.bak 2>/dev/null | tail -n +15 | xargs -r rm --
  ls -1t "$BACKUPS_DIR"/uploads.*.tgz 2>/dev/null | tail -n +15 | xargs -r rm --
}

abort_old_host "$REMOTE_HOST"
ensure_expected_remote_target

if [[ "${HUNTER_DEPLOY_REMOTE:-0}" != "1" ]]; then
  log "Deploy remoto en ${REMOTE_HOST}"
  if [[ ! -f "$REMOTE_KEY" ]]; then
    echo "ERROR: llave SSH no encontrada: $REMOTE_KEY" >&2
    exit 1
  fi

  remote_ip="$(ssh -i "$REMOTE_KEY" -o StrictHostKeyChecking=accept-new "$REMOTE_HOST" "curl -4 -fsS https://api.ipify.org || hostname -I | awk '{print \$1}'" 2>/dev/null || true)"
  if [[ "$remote_ip" != "$EXPECTED_NEW_IP" ]]; then
    echo "ERROR: IP remota inesperada ($remote_ip). Esperado: $EXPECTED_NEW_IP" >&2
    exit 1
  fi

  marker_state="$(ssh -i "$REMOTE_KEY" -o StrictHostKeyChecking=accept-new "$REMOTE_HOST" "test -f '$NEW_SERVER_MARKER' && tr -d '\\r\\n ' < '$NEW_SERVER_MARKER' || echo MISSING" 2>/dev/null || true)"
  if [[ "$marker_state" != "true" ]]; then
    echo "ERROR: marcador de servidor nuevo no válido en $NEW_SERVER_MARKER (valor: $marker_state)" >&2
    exit 1
  fi

  ssh -i "$REMOTE_KEY" -o StrictHostKeyChecking=accept-new "$REMOTE_HOST" "HUNTER_DEPLOY_REMOTE=1 bash '$APP_ROOT/ops/deploy_hunter_prod.sh'"
  exit $?
fi

# Remote section
abort_old_host "$(hostname -f 2>/dev/null || hostname || true)"
remote_ip_local="$(curl -4 -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
if [[ "$remote_ip_local" != "$EXPECTED_NEW_IP" ]]; then
  echo "ERROR: este host no coincide con hunter-prod ($EXPECTED_NEW_IP). Detectado: $remote_ip_local" >&2
  exit 1
fi
if [[ ! -f "$NEW_SERVER_MARKER" ]] || ! is_new_server_marker_ok; then
  echo "ERROR: marcador $NEW_SERVER_MARKER inválido. Aborto para evitar deploy en host incorrecto." >&2
  exit 1
fi

mkdir -p "$RELEASES_DIR" "$STATE_DIR" "$STATE_DIR/uploads" "$STATE_DIR/assets" "$BACKUPS_DIR" "$LOG_DIR"

# Compatibilidad temporal: migrar shared -> state si todavía existe despliegue antiguo.
if [[ -f "$APP_ROOT/shared/dev.db" && ! -f "$STATE_DIR/dev.db" ]]; then
  log "Migrando DB desde shared/dev.db a state/dev.db"
  cp -p "$APP_ROOT/shared/dev.db" "$STATE_DIR/dev.db"
fi
if [[ -d "$APP_ROOT/shared/uploads" && ! -d "$STATE_DIR/uploads" ]]; then
  log "Migrando uploads desde shared/uploads a state/uploads"
  mkdir -p "$STATE_DIR/uploads"
  cp -a "$APP_ROOT/shared/uploads/." "$STATE_DIR/uploads/" || true
fi

if [[ -f "$APP_ROOT/dev.db" && ! -f "$STATE_DIR/dev.db" ]]; then
  log "Inicializando state/dev.db desde $APP_ROOT/dev.db"
  cp -p "$APP_ROOT/dev.db" "$STATE_DIR/dev.db"
fi
if [[ ! -f "$STATE_DIR/dev.db" ]]; then
  echo "ERROR: falta SQLite persistente en $STATE_DIR/dev.db" >&2
  exit 1
fi

if [[ -d "$APP_ROOT/backend/uploads" && ! -d "$STATE_DIR/uploads" ]]; then
  log "Inicializando state/uploads desde backend/uploads"
  cp -a "$APP_ROOT/backend/uploads/." "$STATE_DIR/uploads/" || true
fi

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  echo "ERROR: SOURCE_DIR no es repositorio git: $SOURCE_DIR" >&2
  exit 1
fi

if [[ -f "$SOURCE_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SOURCE_DIR/.env"
  set +a
elif [[ -f "$APP_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_ROOT/.env"
  set +a
fi

# Forzar Prisma sobre la DB persistente de producción (nunca sobre clones/releases).
export DATABASE_URL="file:$STATE_DIR/dev.db"

log "Preflight: baseline de DB"
guard_database_url_not_in_code_tree "$SOURCE_DIR/.env"
IFS=',' read -r db_size_before conv_before msg_before <<< "$(db_metrics "$STATE_DIR/dev.db")"
log "Baseline DB => size=${db_size_before} bytes, conversations=${conv_before}, messages=${msg_before}"

log "Backup obligatorio pre-deploy"
[[ -x "$BACKUP_SCRIPT" ]] || { echo "ERROR: backup script no ejecutable: $BACKUP_SCRIPT" >&2; exit 1; }
backup_out="$("$BACKUP_SCRIPT")" || { echo "ERROR: backup pre-deploy falló" >&2; exit 1; }
log "Backup creado: $backup_out"

cd "$SOURCE_DIR"
log "Actualizar código"
snapshot_ts="$(date +%Y%m%d%H%M%S)"
source_snapshot_dir="$BACKUPS_DIR/source-snapshots"
mkdir -p "$source_snapshot_dir"
if [[ -n "$(git -C "$SOURCE_DIR" status --porcelain 2>/dev/null || true)" ]]; then
  snapshot_prefix="$source_snapshot_dir/hunter-source-${snapshot_ts}"
  log "Workspace git sucio en $SOURCE_DIR. Guardando snapshot previo en ${snapshot_prefix}.*"
  git -C "$SOURCE_DIR" diff > "${snapshot_prefix}.diff.patch" || true
  git -C "$SOURCE_DIR" diff --staged > "${snapshot_prefix}.staged.patch" || true
  git -C "$SOURCE_DIR" status --porcelain > "${snapshot_prefix}.status.txt" || true
  git -C "$SOURCE_DIR" ls-files --others --exclude-standard > "${snapshot_prefix}.untracked.txt" || true
  if [[ -s "${snapshot_prefix}.untracked.txt" ]]; then
    tar -czf "${snapshot_prefix}.untracked.tgz" -C "$SOURCE_DIR" -T "${snapshot_prefix}.untracked.txt" || true
  fi
  git -C "$SOURCE_DIR" reset --hard HEAD
  git -C "$SOURCE_DIR" clean -fd
fi
git fetch origin main
git checkout main
git pull --ff-only origin main

git_sha="$(git rev-parse --short HEAD)"
release_id="${git_sha}-$(date +%Y%m%d%H%M%S)"
release_dir="$RELEASES_DIR/$release_id"

log "Build backend"
cd "$SOURCE_DIR/backend"
npm install
npx prisma migrate deploy --schema "$SOURCE_DIR/prisma/schema.prisma"
npx prisma generate --schema "$SOURCE_DIR/prisma/schema.prisma"
npm run build
[[ -f dist/server.js ]] || { echo "ERROR: backend dist/server.js no existe" >&2; exit 1; }

log "Build frontend"
cd "$SOURCE_DIR/frontend"
npm install
npm run build
[[ -f dist/index.html ]] || { echo "ERROR: frontend dist/index.html no existe" >&2; exit 1; }

log "Preparar release: $release_id"
mkdir -p "$release_dir"
rsync -a --delete \
  --exclude='/.git' \
  --exclude='/dev.db' \
  --exclude='/*.db' \
  --exclude='/backend/uploads' \
  --exclude='/state' \
  --exclude='/shared' \
  --exclude='/backups' \
  "$SOURCE_DIR/" "$release_dir/"

if find "$release_dir" -type f \( -name 'dev.db' -o -name '*.db' \) | grep -q .; then
  echo "ERROR: artifact contiene archivos .db (bloqueado por seguridad)" >&2
  exit 1
fi
if find "$release_dir/backend/uploads" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
  echo "ERROR: artifact incluye backend/uploads con contenido (bloqueado por seguridad)" >&2
  exit 1
fi

if [[ -f "$SOURCE_DIR/.env" && ! -f "$STATE_DIR/.env" ]]; then
  cp -p "$SOURCE_DIR/.env" "$STATE_DIR/.env"
fi

ln -sfn "$STATE_DIR/dev.db" "$release_dir/dev.db"
rm -rf "$release_dir/backend/uploads"
ln -sfn "$STATE_DIR/uploads" "$release_dir/backend/uploads"

if [[ -f "$STATE_DIR/.env" ]]; then
  guard_database_url_not_in_code_tree "$STATE_DIR/.env"
  ln -sfn "$STATE_DIR/.env" "$release_dir/.env"
fi

previous_release="$(readlink -f "$CURRENT_LINK" 2>/dev/null || true)"
ln -sfn "$release_dir" "$CURRENT_LINK"

mkdir -p "$APP_ROOT/frontend/dist"
rsync -a --delete "$release_dir/frontend/dist/" "$APP_ROOT/frontend/dist/"

log "Restart seguro (solo hunter-backend)"
export HUNTER_BUILD_SHA="$git_sha"
export HUNTER_BUILD_DIRTY="false"
if [[ -f "$CURRENT_LINK/ecosystem.config.cjs" ]]; then
  pm2 delete hunter-backend >/dev/null 2>&1 || true
  pm2 start "$CURRENT_LINK/ecosystem.config.cjs" --only hunter-backend --update-env || pm2 restart hunter-backend --update-env
else
  pm2 restart hunter-backend --update-env
fi
pm2 save

log "Health check"
ok=0
for _ in $(seq 1 20); do
  if curl -sf http://127.0.0.1:4101/api/health >/tmp/hunter-prod-health.json; then
    ok=1
    break
  fi
  sleep 1
done

if [[ "$ok" != "1" ]]; then
  log "Health check falló. Ejecutando rollback automático."
  rollback_to_previous_release "$previous_release" || true
  pm2 logs hunter-backend --lines 120 --nostream || true
  exit 1
fi

IFS=',' read -r db_size_after conv_after msg_after <<< "$(db_metrics "$STATE_DIR/dev.db")"
log "Post-deploy DB => size=${db_size_after} bytes, conversations=${conv_after}, messages=${msg_after}"

# Guardrail anti-BD pequeña / caída abrupta de datos
if [[ "$db_size_before" -gt 0 && "$db_size_after" -gt 0 ]]; then
  min_allowed_size=$(( db_size_before * 40 / 100 ))
  if [[ "$db_size_after" -lt "$min_allowed_size" ]]; then
    log "Guardrail activado: tamaño de DB cayó demasiado (${db_size_before} -> ${db_size_after}). Rollback."
    rollback_to_previous_release "$previous_release" || true
    exit 1
  fi
fi

if [[ "$conv_before" -gt 20 ]]; then
  min_allowed_conv=$(( conv_before * 50 / 100 ))
  if [[ "$conv_after" -lt "$min_allowed_conv" ]]; then
    log "Guardrail activado: conversaciones cayeron demasiado (${conv_before} -> ${conv_after}). Rollback."
    rollback_to_previous_release "$previous_release" || true
    exit 1
  fi
fi

cat /tmp/hunter-prod-health.json
printf '\nDeploy OK (%s)\n' "$release_id"
