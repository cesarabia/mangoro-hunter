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
   - **Notificaciones a staff (SSClinical)**:
     - Se configuran por usuario (workspace) en `Usuarios → WhatsApp de notificaciones` (E.164).
     - Se disparan por automation (ej: `STAGE_CHANGED` a `INTERESADO`) y respetan SAFE MODE + 24h.
     - Si se bloquea/falla, debe existir fallback **in‑app** + logs (Outbound blockedReason).

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

## Troubleshooting rápido (WhatsApp staff)
Si un caso pasa a `INTERESADO` y **no llega WhatsApp al staff**:
1) Config → Usuarios: revisar **WhatsApp de notificaciones** (formato `+569...`).
2) Ayuda/QA → Logs → **Outbound**:
   - `SAFE_OUTBOUND_BLOCKED:*`: estás en SAFE MODE y el número no está en allowlist (en DEV solo admin/test).
   - `OUTSIDE_24H_REQUIRES_TEMPLATE`: fuera de ventana 24h (solución: pedir al staff que envíe “activar” al número de la línea para abrir ventana).
   - `NO_CONTACTAR`: el contacto está marcado como NO_CONTACTAR (solo opt‑out).
   - `DEDUPED_*`: ya se envió (dedupe por caso+stage+día).
3) Ayuda/QA → Notificaciones: debe existir una notificación in‑app de fallback si el WhatsApp no se pudo enviar.
