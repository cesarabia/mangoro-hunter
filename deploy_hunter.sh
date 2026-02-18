#!/bin/bash
set -euo pipefail

REMOTE_HOST="ubuntu@3.148.219.40"
REMOTE_KEY="/Users/cesar/Documents/dev/mangoro/LightsailDefaultKey-us-east-2.pem"
REMOTE_CMD="bash /opt/hunter/deploy_hunter.sh"

# If we're running locally (no SSH session), act as a wrapper and run the deploy on the server.
if [ -z "${SSH_CONNECTION:-}" ]; then
  echo "Ejecutando deploy remoto en ${REMOTE_HOST}..."
  ssh -i "${REMOTE_KEY}" -o StrictHostKeyChecking=accept-new "${REMOTE_HOST}" "${REMOTE_CMD}"
  exit $?
fi

# ---- Remote section (runs inside the server) ----
APP_DIR="/opt/hunter"
cd "$APP_DIR"

timestamp=$(date +%Y%m%d%H%M%S)
if [ -f dev.db ]; then
  cp dev.db "dev-backup-${timestamp}.db"
  echo "Backup dev.db -> dev-backup-${timestamp}.db"
fi

echo "Git pull..."
git pull origin main

echo "Backend build + migrate..."
cd backend
npm install
npx prisma migrate deploy --schema ../prisma/schema.prisma
npx prisma generate --schema ../prisma/schema.prisma
npm run build

echo "Frontend build..."
cd ../frontend
npm install
npm run build

echo "Restarting pm2..."
cd ..
pm2 startOrReload ecosystem.config.cjs --only hunter-backend || pm2 start ecosystem.config.cjs --only hunter-backend
pm2 save

echo "Deploy finalizado."
