# PROD Deploy Safety (Hunter)

Documento operativo para despliegues en PROD con SQLite + uploads en estado persistente.

## Objetivo
- Evitar sobreescritura accidental de `dev.db` y `uploads`.
- Garantizar backup consistente antes de cualquier restart.
- Tener restore/rollback reproducible.

## Rutas de estado (aisladas)
- DB: `/opt/hunter/state/dev.db`
- Uploads: `/opt/hunter/state/uploads/`
- Backups: `/opt/hunter/backups/<YYYY-MM-DD_HH-mm-ss>/`
- Código release: `/opt/hunter/releases/<sha-ts>/`
- Symlink activo: `/opt/hunter/current`

Compatibilidad temporal:
- Si no existe `/opt/hunter/state/dev.db`, el runtime puede caer a ruta legacy y lo loguea como warning.

## Scripts
- Backup: `ops/hunter_backup.sh`
- Restore: `ops/hunter_restore.sh`
- Deploy PROD: `ops/deploy_hunter_prod.sh`

## SOP de deploy (PLAN)
1. Preflight (solo lectura):
   - Confirmar host objetivo `16.59.92.121`.
   - Confirmar marker `/opt/hunter/ops/IS_NEW_SERVER=true`.
   - Confirmar health actual: `curl -fsS http://127.0.0.1:4101/api/health`.
2. Backup obligatorio:
   - Ejecutar `ops/hunter_backup.sh`.
   - Verificar `manifest.txt` + `SHA256SUMS.txt`.
3. Build + release:
   - Build backend/frontend.
   - Copia a `releases/<sha-ts>` excluyendo DB/uploads/state/backups.
4. Guardrails:
   - Abortar si artifact contiene `.db` o `backend/uploads` con contenido.
   - Abortar si `DATABASE_URL` apunta a árbol de código/releases.
5. Restart controlado:
   - Reiniciar solo `hunter-backend`.
6. Post-check:
   - Health OK.
   - Métricas DB (size/conversations/messages) no caen abruptamente.

## Restore (PLAN)
Uso:
```bash
ops/hunter_restore.sh <timestamp|absolute_backup_dir>
```
No ejecuta restore real por defecto.

Para ejecutar:
```bash
HUNTER_RESTORE_CONFIRM=YES ops/hunter_restore.sh <timestamp> --execute
```

Secuencia:
1. Verificar checksums de backup.
2. Tomar backup actual de seguridad.
3. Detener `hunter-backend`.
4. Restaurar `dev.db` y `uploads`.
5. Levantar backend.
6. Verificar `/api/health`.

## Checklist pre/post deploy
Pre:
- [ ] Host/IP correctos (`16.59.92.121`)
- [ ] Marker de servidor nuevo válido
- [ ] Backup recién creado y verificable
- [ ] No hay intento de copiar DB/uploads en artifact

Post:
- [ ] `pm2 list` muestra `hunter-backend` online
- [ ] `/api/health` OK
- [ ] Conteos base de conversaciones/mensajes sin caída abrupta
- [ ] Logs sin errores críticos de bootstrap DB/uploads

## Stop conditions
- Falla backup.
- `DATABASE_URL` en código/release.
- Health check falla luego de restart.
- Guardrail de caída brusca de DB activado.
