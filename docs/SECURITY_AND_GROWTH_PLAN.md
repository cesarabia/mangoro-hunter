# SECURITY AND GROWTH PLAN (Hunter)

## 1) Separación de ambientes
- `hunter-prod`: operación real (WhatsApp productivo).
- `hunter-staging`: pruebas controladas (número/chip de pruebas).
- Reglas:
  - BD, uploads y assets separados por host/instancia.
  - Nunca compartir `DATABASE_URL` ni storage entre PROD y STAGING.
  - Deploy scripts con guardrail de host para evitar despliegue cruzado.

## 2) Backups y recuperación
- Backups obligatorios antes de cada deploy:
  - SQLite con `sqlite3 .backup`.
  - uploads/assets empaquetados.
  - `manifest + SHA256SUMS`.
- Retención sugerida:
  - diarios 14 días,
  - semanales 8 semanas,
  - snapshot de instancia previo a cambios de infraestructura.
- Restore:
  - usar `ops/hunter_restore.sh` en modo plan y luego ejecución confirmada.

## 3) Ruteo seguro de inbound
- El workspace default interno no debe responder inbound en PROD.
- Si inbound llega sin `waPhoneNumberId` mapeado:
  - registrar `UNROUTED_INBOUND`,
  - responder 2xx al proveedor,
  - no enviar respuesta automática al candidato.

## 4) Política de assets y documentos
- `PUBLIC`: enviables al candidato (links públicos controlados).
- `INTERNAL`: solo staff autenticado; nunca enviables por IA al candidato.
- Toda subida de asset debe auditar:
  - usuario,
  - workspace,
  - slug,
  - tamaño/hash,
  - fecha.

## 5) Auditoría operacional
- Registrar acciones sensibles:
  - cambios de stage,
  - OP_REVIEW aceptado/rechazado,
  - envíos template/document,
  - cambios de SAFE MODE,
  - cambios en PhoneLines/Programs/Automations.
- Logs mínimos por acción:
  - `who`, `when`, `workspaceId`, `conversationId` (si aplica), `before/after`.

## 6) Alertas mínimas recomendadas
- `healthcheck` caído (>3 fallos seguidos).
- Disco alto (>80%, crítico >90%).
- Backup fallido.
- Bloqueos outbound repetidos (`SAFE_MODE`, `OUTSIDE_24H`, `NO_CONTACTAR`).
- Errores repetidos en webhook/agent runtime.

## 7) Plan de crecimiento
- Corto plazo:
  - mantener app stateless cuando sea posible,
  - mover jobs pesados a cola,
  - índices por `workspaceId`, `conversationId`, `createdAt`.
- Mediano plazo:
  - separar servicios (API, workers, webhook ingress),
  - storage de archivos en objeto externo (S3 compatible),
  - observabilidad central (métricas, trazas, alertas).

## 8) Checklist previo a campañas
- Health OK.
- Backup previo creado.
- SAFE MODE validado.
- Routing por PhoneLine validado.
- Smoke scenarios clave en PASS.
- OP_REVIEW operativo (cola, resumen, paquete, acciones).
