# STAGING Separation Plan (Hunter)

## Objetivo
Separar completamente `hunter-prod` y `hunter-staging` para validar cambios sin contaminar producción.

## 1) Entornos aislados
- **Producción:** `hunter-prod` (línea real, dominio principal).
- **Staging:** `hunter-staging` (instancia y dominio/subdominio separados).
- Sin compartir PM2, nginx config ni archivos de release entre ambos.

## 2) Base de datos separada
- `hunter-prod`: `/opt/hunter/state/dev.db` (producción).
- `hunter-staging`: `/opt/hunter-staging/state/dev.db` (staging).
- Nunca copiar DB de staging sobre prod.
- Migraciones primero en staging, luego en prod.

## 3) Assets/uploads separados
- `hunter-prod`: `/opt/hunter/state/assets` y `/opt/hunter/state/uploads`.
- `hunter-staging`: `/opt/hunter-staging/state/assets` y `/opt/hunter-staging/state/uploads`.
- Backups y retención independientes por entorno.

## 4) Phone line/chip de pruebas separado
- Staging debe usar número/chip de prueba distinto al número real de producción.
- Webhook de staging debe apuntar solo a staging.
- No reutilizar `waPhoneNumberId` activo de prod en staging.

## 5) Pipeline de deploy independiente
- Script prod: `ops/deploy_hunter_prod.sh` (guardrail host/IP prod).
- Script staging: `ops/deploy_hunter_staging.sh` (guardrail host/IP staging).
- Prohibido `pm2 restart all`; reiniciar solo proceso objetivo del entorno.

## 6) Criterio de promoción staging -> prod
Promocionar a prod solo si staging cumple:
- Smoke scenarios críticos PASS.
- Healthcheck estable (`/api/health`).
- Verificación manual de flujo intake -> OP_REVIEW.
- Sin leaks de copy legacy.
- Backup previo en prod confirmado.

## Runbook corto de promoción
1. Deploy en staging.
2. Ejecutar smoke + QA manual.
3. Generar evidencia (Release Notes + logs).
4. Backup prod.
5. Deploy prod controlado.
6. Health + smoke mínimo post-deploy.
