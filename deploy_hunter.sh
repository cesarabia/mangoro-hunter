#!/bin/bash
set -euo pipefail
APP_DIR=/opt/hunter
cd "$APP_DIR"
git pull origin main
cd backend
npm install
npx prisma migrate deploy --schema ../prisma/schema.prisma
npx prisma generate --schema ../prisma/schema.prisma
npm run build
cd ../frontend
npm install
npm run build
pm2 restart hunter-backend
