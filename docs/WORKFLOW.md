# WORKFLOW.md — Forma de trabajo (Agent OS)

## Objetivo
Iterar rápido **sin romper DEV/PROD/pilotos**, con evidencia reproducible (**logs + smoke scenarios**) y **sin borrar data**.

## Reglas no negociables
1) **Nunca borrar data** (conversaciones, mensajes, logs, configuración): *archive-only*.
2) Cualquier feature visible debe:
   - Dejar logs/auditoría (Agent Runs / Automation Runs / Outbound / Config Changes).
   - Tener smoke scenario (o asserts nuevos) si puede romper comportamiento.
   - Actualizar **Release Notes (DEV)** dentro de la UI.
3) **SAFE OUTBOUND MODE**:
   - DEV: `ALLOWLIST_ONLY` por defecto (bloquea todo fuera allowlist).
   - Cualquier override debe ser explícito, auditado y preferir TEMP_OFF con auto‑revert.
4) Si hay conflicto, priorizar: **seguridad > consistencia > UX > features**.
5) WhatsApp:
   - Respetar ventana 24h (fuera → template; dentro → texto permitido).
   - Idempotencia inbound (por `Message.waMessageId`) y outbound (dedupeKey + anti‑loop).

## Ciclo por iteración (siempre igual)
1) **Definir entregables y criterios click‑only** (qué se valida desde UI).
2) **Implementar** (backend/frontend/migraciones) con cambios mínimos y aditivos.
3) **Agregar/actualizar smoke scenarios** (Sandbox/NullTransport) + asserts.
4) **Tests/build**:
   - `backend npm test`
   - `frontend npm run build`
5) **Deploy DEV** (migraciones seguras + build) y verificar `/api/health`.
6) **Verificación click‑only**:
   - Ayuda/QA → “Run Smoke Scenarios”
   - Ayuda/QA → Logs recientes (Agent/Automation/Outbound/Config/Notifications)
   - Ayuda/QA → “Re-evaluar DoD”
7) **Release Notes (DEV)**:
   - Qué cambió / Qué falta / Riesgos
   - Evidencia (scenarios + IDs/logs relevantes)
8) **Review Pack ZIP**:
   - Validar descarga desde UI y/o endpoint directo.
   - Debe contener docs + release notes + logs recientes + resultados scenarios.

## “Sombreros” de Codex (secuencial)
- **Implementador**: cambia código, migra, deja guardrails y endpoints.
- **QA**: intenta romper, escribe scenarios/asserts y valida guardrails.
- **Documentación**: actualiza docs (`PLATFORM_DESIGN.md`, `STATUS.md`) y deja pasos click‑only.

## Checklist de producción piloto (mínimo)
- `/api/health` OK y build stamp visible en UI.
- SAFE MODE policy correcta y allowlist efectiva correcta (DEV).
- Routing inbound por `waPhoneNumberId` resuelto (sin ambigüedad multi‑workspace).
- Program selection consistente (Program = fuente única).
- Logs y replay/simulator funcionando (sin WhatsApp real).
- 1 caso de negocio end‑to‑end validado (ej: SSClinical handoff + notificación + asignación).

