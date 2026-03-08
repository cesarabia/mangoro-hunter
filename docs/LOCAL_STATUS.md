# LOCAL STATUS — Hunter

Fecha/hora: 2026-03-08 15:06:01 -03

## URLs activas
- Frontend: [http://localhost:5173](http://localhost:5173)
- Backend: [http://localhost:4001](http://localhost:4001)
- Health backend: [http://localhost:4001/api/health](http://localhost:4001/api/health)

## Procesos activos (Mac local)
- Backend PID: `7766`
- Frontend PID: `7889`

## Comandos usados para levantar
```bash
env DATABASE_URL="file:/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/dev.local.snapshot.db" \
  HUNTER_STATE_DB_PATH="/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/dev.local.snapshot.db" \
  HUNTER_STATE_UPLOADS_PATH="/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/uploads" \
  HUNTER_ASSETS_DIR="/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/assets" \
  PORT=4001 \
  npm --prefix backend run dev

npm --prefix frontend run dev -- --host 127.0.0.1 --port 5173
```

## Snapshot PROD -> LOCAL aplicado
- Script ejecutado: `./ops/sync_prod_state_to_local.sh --execute`
- Reporte: `/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/last-sync-report.txt`
- DB local: `/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/dev.local.snapshot.db`
- Uploads locales: `/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/uploads`
- Assets locales: `/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/assets`

## Cómo detener
```bash
kill $(lsof -nP -iTCP:4001 -sTCP:LISTEN -t) $(lsof -nP -iTCP:5173 -sTCP:LISTEN -t)
```

## Cómo reiniciar
1. Ejecutar de nuevo los comandos de “levantar”.
2. Verificar:
```bash
curl http://localhost:4001/api/health
curl -I http://localhost:5173
```
