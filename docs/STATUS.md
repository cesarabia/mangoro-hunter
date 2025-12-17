# Hunter CRM — Status (Agent OS v1)

## Qué está listo (hoy)

### Agent OS v1 (core)
- AgentRuntime + CommandExecutor con schema estricto (commands JSON) y guardrails.
- Tools deterministas (normalize/resolve_location/validate_rut/pii sanitize).
- Automations (motor determinista) con acción principal `RUN_AGENT`.
- Logs y auditoría: AgentRunLog, ToolCallLog, AutomationRunLog, Outbound logs.
- Simulador seguro (sandbox / NullTransport):
  - sesiones sandbox
  - replay desde conversación real (con sanitización PII)
  - scenario runner con asserts (24h, SAFE MODE, dedupe, program menu, etc.)

### Multi-tenant / Workspaces
- Aislamiento por `workspaceId` en conversaciones, mensajes, logs, programs, automations y phone lines.
- Roles por membership (OWNER/ADMIN/MEMBER/VIEWER) y UI con workspace switcher.

### Multi-line WhatsApp
- Routing inbound por `phone_number_id` → `PhoneLine` (safe-fail si no existe).
- Outbound desde la línea asociada a la conversación (usa `phoneLine.waPhoneNumberId`).

### Programs como flows
- Programs CRUD por workspace.
- Si una conversación no tiene `programId` y hay >1 Program activo: menú corto 1/2/3 y asignación.
- Override manual de Program desde CRM.

### UI
- Topbar con navegación: Inbox / Inactivos / Simulador / Agenda / Configuración.
- Configuración con tabs (Workspace / Integraciones / Usuarios / Números WhatsApp / Programs / Automations / Uso & Costos / Logs).
- Ayuda (no técnica) + QA/Owner Review (técnica) separadas y click-only.
- Copilot CRM (MVP): ayuda + diagnóstico + navegación + historial persistente por hilo.
- Fix de crash por “Rules of Hooks” (App ya no queda en blanco).
- Download Review Pack (zip) desde Owner Review.

## Qué falta (para “Agent OS v1 completo”)
- (Opcional) Integraciones por workspace (OpenAI/WhatsApp) si se requiere multi‑cliente con credenciales separadas.
- Copilot Nivel 2 (acciones con confirmación + auditoría + permisos).
- Scenarios más amplios (reclutamiento/entrevista/ventas) con asserts de contenido y stages.

## Riesgos conocidos
- DEV y PROD comparten riesgos si usan la misma DB/WhatsApp:
  - sin SAFE OUTBOUND MODE se puede molestar a números reales.
- Dependencia de OpenAI: si no hay key, `RUN_AGENT` falla (se ve en logs).
- Migraciones históricas: en local `prisma migrate dev` puede fallar por shadow DB; usar `migrate deploy` para aplicar pendientes.

## Próximas 3 tareas recomendadas (con criterio)
1) **Separar DEV/PROD de verdad (DB + subdominio + webhooks)**.
   - Criterio: reduce riesgo de incidentes con números reales y permite releases sin miedo.
2) **Copilot Nivel 2 (comandos con confirmación)**.
   - Criterio: acelera operación (crear programs/automations, diagnosticar y ejecutar acciones) sin tocar terminal.
3) **Scenarios de negocio (reclutamiento/entrevista/ventas)** con asserts de calidad.
   - Criterio: evita regresiones en lo que importa al usuario final.
