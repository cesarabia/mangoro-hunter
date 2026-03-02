#!/usr/bin/env bash
set -u

HEALTH_PUBLIC="${HEALTH_PUBLIC:-https://hunter.mangoro.app/api/health}"
HEALTH_LOCAL="${HEALTH_LOCAL:-http://127.0.0.1:4101/api/health}"
PM2_APP="${PM2_APP:-hunter-backend}"

print_health() {
  local label="$1"
  local url="$2"
  local body
  local code
  body=$(mktemp)
  code=$(curl -sS --max-time 8 -o "$body" -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  echo "[$label] $url (http=$code)"
  if [ "$code" = "200" ] && grep -q '"ok":true' "$body"; then
    cat "$body"
  else
    echo "health_check_failed"
    sed -n '1,8p' "$body"
  fi
  rm -f "$body"
  echo
}

echo "===== hunter status ====="
date -u
uptime
echo

print_health "health public" "$HEALTH_PUBLIC"
print_health "health local" "$HEALTH_LOCAL"

echo "[pm2 status]"
pm2 status "$PM2_APP" --no-color || true
echo

echo "[pm2 logs - errors tail]"
pm2 logs "$PM2_APP" --lines 80 --nostream 2>/dev/null | tail -n 80 || true
echo

echo "[resources]"
free -h || true
df -h / || true
