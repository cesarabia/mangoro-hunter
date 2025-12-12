#!/bin/bash
set -euo pipefail
APP_DIR=/opt/hunter
cd "$APP_DIR"
git pull origin main
cd backend
npm install
npm run build
cd ../frontend
npm install
npm run build
pm2 restart hunter-backend
