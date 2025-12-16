# Hunter CRM — Deploy Playbook (DEV ahora, PROD después)

Este documento describe cómo desplegar **sin riesgo de molestar números reales** y sin pérdida de data (solo archive/audit).

## Principios (no negociables)
- Nunca borrar data: conversaciones/mensajes/logs **no se eliminan**. “Limpieza” = **archivar**.
- En DEV: **SAFE OUTBOUND MODE** activo (allowlist only).
- Simulator/Replay/Scenario Runner: **NullTransport** (nunca WhatsApp real).
- Migraciones: solo `prisma migrate deploy` (aplica pendientes; no reescribe historia).

## 1) Deploy a DEV (hunter.mangoro.app)

### Pre‑deploy (5 min)
1) Confirmar SAFE OUTBOUND MODE:
   - Policy: `ALLOWLIST_ONLY`
   - Allowlist: solo números autorizados (admin + test).
2) Confirmar variables críticas en el servidor:
   - `DATABASE_URL` (DB de DEV)
   - WhatsApp Cloud API (`whatsappToken`, `whatsappPhoneId`)
   - `APP_ENV=development` (recomendado)
3) Tener un backup antes de tocar nada.

### Deploy (script actual)
Este repo incluye `deploy_hunter.sh` (wrapper local → ejecuta en el server).

1) Desde tu máquina:
   - `./deploy_hunter.sh`
2) El script en el server hace:
   - backup de `dev.db` a `dev-backup-<timestamp>.db`
   - `git pull`
   - `npx prisma migrate deploy`
   - build backend + build frontend
   - restart de `pm2`

### Post‑deploy (smoke en 10 min)
1) `https://hunter.mangoro.app/api/health` → OK.
2) Abrir UI:
   - Navegar Inbox / Configuración / Simulador / Agenda.
3) Validar SAFE MODE visible (indicador en UI).
4) Simulador:
   - Run Scenario “Loop comuna/ciudad (RM)” → PASS.

## 2) Pase a PROD (platform.mangoro.app o app.mangoro.app)

### Objetivo
Separar DEV/PROD para evitar mezclar conversaciones reales con pruebas.

### Recomendación de arquitectura
1) **Subdominio PROD**:
   - `platform.mangoro.app` (o `app.mangoro.app`)
2) **DB separada**:
   - DEV: `dev.db`
   - PROD: `prod.db` (o Postgres si se escala)
3) `APP_ENV=production` en PROD.
4) SAFE OUTBOUND MODE en PROD:
   - normalmente `ALLOW_ALL` (operación real),
   - o mantener `ALLOWLIST_ONLY` durante la puesta en marcha (soft‑launch).

### Checklist de cambio de Webhook WhatsApp (DEV → PROD)
1) Preparar PROD:
   - Deploy con DB vacía o migrada.
   - Configurar tokens/phone id correctos.
   - Verificar `/api/health`.
2) Activar webhook hacia PROD:
   - En Meta/WhatsApp Cloud: cambiar URL callback a `https://platform.mangoro.app/api/whatsapp/webhook` (según ruta actual).
   - Verificar `verify_token`.
3) Monitorear primeros mensajes:
   - Confirmar que inbound entra y outbound sale correctamente (sin errores de 24h / NO_CONTACTAR).

### Rollback plan (si algo falla)
1) Webhook:
   - Volver a apuntar a DEV temporalmente (si era estable).
2) App:
   - `git reset --hard <commit_anterior>` en el server y rebuild + restart.
3) DB:
   - Restaurar el backup más reciente (`dev-backup-*.db` / `prod-backup-*.db`).

## 3) Nota sobre migraciones y “no data loss”
- No se eliminan tablas ni registros.
- “Cleanup/reset” debe archivar (`archivedAt`, tags, system notes), nunca borrar.

