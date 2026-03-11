# DEV_SERVER_LAYOUT.md

## Objetivo
Mantener `hunter-prod` como host estable de producción y dejar base ordenada para un futuro staging, sin compartir estado crítico entre ambientes.

## Estado actual validado (2026-03-11)
- Producción activa:
  - Host: `hunter-prod` (`hunter.mangoro.app`)
  - Backend local: `127.0.0.1:4101`
  - Nginx publica `/api` y webhook a backend
- Health producción:
  - `GET /api/health` responde `ok: true`
  - `gitSha`: `5e049bd`

## Layout recomendado en `hunter-prod`
- Producción (actual):
  - `/opt/hunter` (release/runtime actual)
  - `/opt/hunter/state` (DB y estado persistente de prod)
  - `/opt/hunter/shared` (archivos compartidos de prod)
  - `/opt/hunter/backups` (backups ER-P3 de prod)
- Estructura preparada para staging (sin desplegar todavía):
  - `/opt/staging/hunter` (código staging futuro)
  - `/opt/staging/hunter-state` (estado persistente staging)
- Común de host:
  - `/opt/backups` (backups de referencia/archivos de decommission)
  - `/opt/shared` (reservado para utilidades comunes no sensibles)

## Reglas de aislamiento (obligatorias)
1. **No compartir DB entre prod y staging**.
2. **No compartir uploads/assets entre prod y staging**.
3. **No reutilizar `.env` de prod en staging**.
4. **No apuntar staging al mismo waPhoneNumberId de prod**.
5. **Deploy de staging no debe reiniciar procesos de prod**.

## Puertos sugeridos (reservados)
- Producción:
  - Backend: `4101`
- Staging futuro:
  - Backend: `4201`
  - Frontend preview interno: `4273` (opcional)
  - Exposición pública staging por subdominio dedicado y vhost separado.

## Logging y retención (housekeeping seguro)
- `pm2-logrotate` activo en host.
- Journald en uso bajo (`~48 MB` al momento de esta revisión).
- Mantener caps de logs y rotación para evitar crecimiento no controlado.

## Swap (evaluación)
- Estado: sin swap (`0B`).
- Memoria observada suficiente para operación actual de prod.
- Recomendación: si se harán builds pesados en este mismo host, agregar swap moderada (1–2 GB) en ventana controlada.

## Checklist antes de crear staging real
1. Crear `.env` staging aislado.
2. Configurar PM2 app separada (`hunter-staging-backend`).
3. Crear vhost nginx separado para staging.
4. Validar que staging no toque `/opt/hunter/state`.
5. Correr smoke en staging antes de cualquier promoción.
