#!/bin/bash
set -euo pipefail

PROJECT_ROOT="/Users/cesar/Documents/dev/mangoro/app/hunter"
SSH_KEY="/Users/cesar/Documents/dev/mangoro/LightsailDefaultKey-us-east-2.pem"
REMOTE="ubuntu@3.148.219.40"
REMOTE_DIR="/opt/talent-hunter/talent-hunter"

echo "🛠  Building backend..."
cd "$PROJECT_ROOT/backend"
npm install
npm run build

echo "🛠  Building frontend..."
cd "$PROJECT_ROOT/frontend"
npm install
npm run build

echo "🚚 Syncing project via rsync..."
cd "$PROJECT_ROOT/.."
rsync -avz \
  -e "ssh -i $SSH_KEY" \
  --exclude "dev.db" \
  --exclude "backend/.env" \
  --exclude "node_modules" \
  --exclude "dist" \
  hunter/ \
  "$REMOTE:$REMOTE_DIR/"

echo "🔄 Rebuilding on server..."
ssh -i "$SSH_KEY" "$REMOTE" <<'EOF'
set -e
cd /opt/talent-hunter/talent-hunter/backend
npm install
npx prisma generate --schema ../prisma/schema.prisma
npx prisma migrate deploy --schema ../prisma/schema.prisma
npm run build
pm2 restart talent-hunter-backend || pm2 start dist/server.js --name talent-hunter-backend
pm2 save

cd /opt/talent-hunter/talent-hunter/frontend
npm install
npm run build
EOF

echo "✅ Deploy completed. Production ready at https://hunter.mangoro.app"
