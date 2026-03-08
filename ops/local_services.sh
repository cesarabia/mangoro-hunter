#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/tmp/local-run"
LOG_DIR="$RUN_DIR/logs"
BACKEND_PID_FILE="$RUN_DIR/backend.pid"
FRONTEND_PID_FILE="$RUN_DIR/frontend.pid"
BACKEND_LOG_FILE="$LOG_DIR/backend.log"
FRONTEND_LOG_FILE="$LOG_DIR/frontend.log"

LOCAL_DB_PATH="$ROOT_DIR/tmp/local-state/dev.local.snapshot.db"
LOCAL_UPLOADS_PATH="$ROOT_DIR/tmp/local-state/uploads"
LOCAL_ASSETS_PATH="$ROOT_DIR/tmp/local-state/assets"

BACKEND_PORT="${HUNTER_LOCAL_BACKEND_PORT:-4001}"
FRONTEND_PORT="${HUNTER_LOCAL_FRONTEND_PORT:-5173}"

BACKEND_SESSION="hunter-local-backend"
FRONTEND_SESSION="hunter-local-frontend"

mkdir -p "$RUN_DIR" "$LOG_DIR"

listener_pid_for_port() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n 1 || true
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

session_exists() {
  local session="$1"
  local out
  out="$(screen -list 2>/dev/null || true)"
  printf '%s\n' "$out" | grep -E "[[:space:]]+[0-9]+\\.${session}[[:space:]]" >/dev/null 2>&1
}

wait_http_ok() {
  local url="$1"
  local timeout="${2:-60}"
  local elapsed=0
  while (( elapsed < timeout )); do
    if curl -sS -o /dev/null "$url"; then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  return 1
}

cleanup_old_launchd() {
  local domain="gui/$(id -u)"
  local backend_label="com.mangoro.hunter.local.backend"
  local frontend_label="com.mangoro.hunter.local.frontend"
  local launch_dir="$HOME/Library/LaunchAgents"
  launchctl bootout "${domain}/${backend_label}" 2>/dev/null || true
  launchctl bootout "${domain}/${frontend_label}" 2>/dev/null || true
  rm -f "$launch_dir/${backend_label}.plist" "$launch_dir/${frontend_label}.plist"
}

start_backend() {
  if [[ ! -f "$LOCAL_DB_PATH" ]]; then
    echo "ERROR: no existe DB local snapshot en $LOCAL_DB_PATH"
    echo "Ejecuta: ./ops/sync_prod_state_to_local.sh --execute"
    exit 1
  fi
  mkdir -p "$LOCAL_UPLOADS_PATH" "$LOCAL_ASSETS_PATH"

  local port_pid
  port_pid="$(listener_pid_for_port "$BACKEND_PORT")"
  if is_running "$port_pid"; then
    echo "$port_pid" > "$BACKEND_PID_FILE"
    echo "Backend ya activo (PID $port_pid)"
    return 0
  fi

  if session_exists "$BACKEND_SESSION"; then
    screen -S "$BACKEND_SESSION" -X quit || true
  fi

  : > "$BACKEND_LOG_FILE"
  screen -dmS "$BACKEND_SESSION" bash -lc "
    cd '$ROOT_DIR/backend'
    exec env \
      DATABASE_URL='file:$LOCAL_DB_PATH' \
      HUNTER_STATE_DB_PATH='$LOCAL_DB_PATH' \
      HUNTER_STATE_UPLOADS_PATH='$LOCAL_UPLOADS_PATH' \
      HUNTER_ASSETS_DIR='$LOCAL_ASSETS_PATH' \
      HUNTER_WEBHOOK_MODE='DISABLED' \
      HUNTER_OUTBOUND_TRANSPORT='NULL' \
      APP_ENV='local' \
      PORT='$BACKEND_PORT' \
      ./node_modules/.bin/ts-node-dev --respawn --transpile-only src/server.ts \
      >> '$BACKEND_LOG_FILE' 2>&1
  "

  if ! wait_http_ok "http://127.0.0.1:${BACKEND_PORT}/api/health" 60; then
    echo "ERROR: backend no respondió en /api/health"
    tail -n 120 "$BACKEND_LOG_FILE" || true
    exit 1
  fi

  port_pid="$(listener_pid_for_port "$BACKEND_PORT")"
  echo "$port_pid" > "$BACKEND_PID_FILE"
  echo "Backend OK en http://localhost:${BACKEND_PORT} (PID ${port_pid:-n/a})"
}

start_frontend() {
  local port_pid
  port_pid="$(listener_pid_for_port "$FRONTEND_PORT")"
  if is_running "$port_pid"; then
    echo "$port_pid" > "$FRONTEND_PID_FILE"
    echo "Frontend ya activo (PID $port_pid)"
    return 0
  fi

  if session_exists "$FRONTEND_SESSION"; then
    screen -S "$FRONTEND_SESSION" -X quit || true
  fi

  : > "$FRONTEND_LOG_FILE"
  screen -dmS "$FRONTEND_SESSION" bash -lc "
    cd '$ROOT_DIR/frontend'
    exec ./node_modules/.bin/vite --host 127.0.0.1 --port '$FRONTEND_PORT' >> '$FRONTEND_LOG_FILE' 2>&1
  "

  if ! wait_http_ok "http://127.0.0.1:${FRONTEND_PORT}" 60; then
    echo "ERROR: frontend no respondió en localhost:${FRONTEND_PORT}"
    tail -n 120 "$FRONTEND_LOG_FILE" || true
    exit 1
  fi

  port_pid="$(listener_pid_for_port "$FRONTEND_PORT")"
  echo "$port_pid" > "$FRONTEND_PID_FILE"
  echo "Frontend OK en http://localhost:${FRONTEND_PORT} (PID ${port_pid:-n/a})"
}

stop_backend() {
  if session_exists "$BACKEND_SESSION"; then
    screen -S "$BACKEND_SESSION" -X quit || true
  fi
  local pid
  pid="$(listener_pid_for_port "$BACKEND_PORT")"
  if is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$BACKEND_PID_FILE"
  echo "Backend: detenido"
}

stop_frontend() {
  if session_exists "$FRONTEND_SESSION"; then
    screen -S "$FRONTEND_SESSION" -X quit || true
  fi
  local pid
  pid="$(listener_pid_for_port "$FRONTEND_PORT")"
  if is_running "$pid"; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$FRONTEND_PID_FILE"
  echo "Frontend: detenido"
}

print_status() {
  local backend_pid frontend_pid
  backend_pid="$(listener_pid_for_port "$BACKEND_PORT")"
  frontend_pid="$(listener_pid_for_port "$FRONTEND_PORT")"

  echo "== Hunter Local Status =="
  if is_running "$backend_pid"; then
    echo "Backend: RUNNING (PID $backend_pid)"
  else
    echo "Backend: STOPPED"
  fi
  if is_running "$frontend_pid"; then
    echo "Frontend: RUNNING (PID $frontend_pid)"
  else
    echo "Frontend: STOPPED"
  fi

  echo
  echo "-- Screen sessions --"
  if session_exists "$BACKEND_SESSION"; then echo "session $BACKEND_SESSION: OK"; else echo "session $BACKEND_SESSION: NO"; fi
  if session_exists "$FRONTEND_SESSION"; then echo "session $FRONTEND_SESSION: OK"; else echo "session $FRONTEND_SESSION: NO"; fi

  echo
  echo "-- Puertos --"
  lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN || true
  lsof -nP -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN || true

  echo
  echo "-- Health backend --"
  curl -sS "http://127.0.0.1:${BACKEND_PORT}/api/health" || true

  echo
  echo "-- Frontend HEAD --"
  curl -sSI "http://127.0.0.1:${FRONTEND_PORT}" | head -n 6 || true

  echo
  echo "-- Logs --"
  echo "Backend log: $BACKEND_LOG_FILE"
  echo "Frontend log: $FRONTEND_LOG_FILE"
}

case "${1:-status}" in
  start)
    cleanup_old_launchd
    start_backend
    start_frontend
    print_status
    ;;
  stop)
    stop_frontend
    stop_backend
    cleanup_old_launchd
    ;;
  restart)
    stop_frontend
    stop_backend
    cleanup_old_launchd
    start_backend
    start_frontend
    print_status
    ;;
  status)
    print_status
    ;;
  *)
    echo "Uso: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
