# LOCAL STATUS — Hunter

Fecha/hora: 2026-03-08 16:45:45 -03

## URLs activas
- Frontend: [http://localhost:5173](http://localhost:5173)
- Backend: [http://localhost:4001](http://localhost:4001)
- Health backend: [http://localhost:4001/api/health](http://localhost:4001/api/health)

## Procesos activos (Mac local)
- Backend PID: `29160`
- Frontend PID: `29183`

## Comandos usados para levantar
```bash
npm run local:start
```

## Verificación real (última corrida)
```bash
curl -I http://localhost:5173
curl http://localhost:4001/api/health
npm run local:status
```

Resultado actual:
- `localhost:5173` responde `HTTP/1.1 200 OK`
- `localhost:4001/api/health` responde `ok:true`
- sesiones persistentes activas:
  - `hunter-local-backend`
  - `hunter-local-frontend`

## Snapshot PROD -> LOCAL aplicado
- Script ejecutado: `./ops/sync_prod_state_to_local.sh --execute`
- Reporte: `/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/last-sync-report.txt`
- DB local: `/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/dev.local.snapshot.db`
- Uploads locales: `/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/uploads`
- Assets locales: `/Users/cesar/Documents/dev/mangoro/app/hunter/tmp/local-state/assets`

## Cómo detener
```bash
npm run local:stop
```

## Cómo reiniciar
1. Ejecutar: `npm run local:start`.
2. Verificar:
```bash
npm run local:status
```
