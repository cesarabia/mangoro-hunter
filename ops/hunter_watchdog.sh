#!/usr/bin/env bash
set -u

HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:4101/api/health}"
PM2_APP="${PM2_APP:-hunter-backend}"
STATE_FILE="${STATE_FILE:-/tmp/hunter_watchdog_fail_count}"
LOG_FILE="${LOG_FILE:-/opt/hunter/tmp/hunter-watchdog.log}"
MAX_FAILS="${MAX_FAILS:-3}"

mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"
}

is_healthy() {
  local out
  out=$(curl -sS --max-time 6 "$HEALTH_URL" 2>/dev/null || true)
  echo "$out" | grep -q '"ok":true'
}

fail_count=0
if [ -f "$STATE_FILE" ]; then
  fail_count=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
fi

if is_healthy; then
  if [ "$fail_count" != "0" ]; then
    log "health recovered (previous_fail_count=$fail_count)"
  fi
  echo 0 > "$STATE_FILE"
  exit 0
fi

fail_count=$((fail_count + 1))
echo "$fail_count" > "$STATE_FILE"
log "health check failed (count=$fail_count/$MAX_FAILS)"

if [ "$fail_count" -lt "$MAX_FAILS" ]; then
  exit 0
fi

log "restarting $PM2_APP after $fail_count consecutive failures"
pm2 restart "$PM2_APP" --update-env >/dev/null 2>&1 || true
sleep 4

if is_healthy; then
  log "$PM2_APP restarted and healthy"
  echo 0 > "$STATE_FILE"
else
  log "$PM2_APP restart attempted but health still failing"
fi
