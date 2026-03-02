#!/usr/bin/env bash
set -u

HEALTH_PUBLIC="${HEALTH_PUBLIC:-https://hunter.mangoro.app/api/health}"
HEALTH_LOCAL="${HEALTH_LOCAL:-http://127.0.0.1:4101/api/health}"
PM2_APP="${PM2_APP:-hunter-backend}"

echo "===== hunter status ====="
date -u
uptime
echo

echo "[health public] ${HEALTH_PUBLIC}"
curl -sS --max-time 8 "$HEALTH_PUBLIC" || echo "health_public_error"
echo

echo "[health local] ${HEALTH_LOCAL}"
curl -sS --max-time 8 "$HEALTH_LOCAL" || echo "health_local_error"
echo

echo "[pm2 status]"
pm2 status "$PM2_APP" --no-color || true
echo

echo "[pm2 logs - errors tail]"
pm2 logs "$PM2_APP" --lines 80 --nostream 2>/dev/null | tail -n 80 || true
echo

echo "[resources]"
free -h || true
df -h / || true
