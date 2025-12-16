# Hunter CRM — Status (v2.5.2 → Agent OS v1)

## Qué está listo (hoy)

### Agent OS v1 (MVP)
- AgentRuntime + CommandExecutor con schema estricto (commands JSON) y guardrails.
- Tools deterministas (normalize/resolve_location/validate_rut/pii sanitize).
- Automations (motor determinista) con acción principal `RUN_AGENT`.
- Logs y auditoría: AgentRunLog, ToolCallLog, AutomationRunLog, Outbound logs.
- Simulador seguro:
  - sesiones sandbox
  - replay desde conversación real (con sanitización PII)
  - scenario runner (reproduce loop comuna/ciudad)

### UI
- Topbar con navegación: Inbox / Inactivos / Simulador / Agenda / Configuración.
- Configuración con tabs (workspace/users/phone lines/programs/automations/logs).
- Fix de crash por “Rules of Hooks” (App ya no queda en blanco).

## Qué falta (para “Agent OS v1 completo”)
- Multi‑tenant real por workspace (scoping completo end‑to‑end, permisos por membership en UI).
- Multi‑line WhatsApp end‑to‑end en PROD (routing por `phone_number_id` + gestión operativa).
- Programs como “flows” por cargo/cliente (routing y UX de selección en conversaciones sin program).
- Automations UI builder más completo (más acciones + mejores condiciones + mejores logs).
- Scenario Runner con asserts más ricos (ej: asserts sobre mensajes, stages y guardrails).

## Riesgos conocidos
- DEV y PROD comparten riesgos si usan la misma DB/WhatsApp:
  - sin SAFE OUTBOUND MODE se puede molestar a números reales.
- Dependencia de OpenAI: si no hay key, `RUN_AGENT` falla (se ve en logs).
- Migraciones históricas: en local `prisma migrate dev` puede fallar por shadow DB; usar `migrate deploy` para aplicar pendientes.

## Próximas 3 tareas recomendadas (con criterio)
1) **SAFE OUTBOUND MODE + allowlist** (bloquea envíos a números no autorizados en DEV).
   - Criterio: evita incidentes operativos y protege reputación.
2) **Workspace sandbox aislado para pruebas** (todas las simulaciones y escenarios viven ahí; nunca tocan conversaciones reales).
   - Criterio: habilita QA continuo sin riesgo.
3) **Mejorar observabilidad “para humanos”**:
   - Dashboard simple de últimos Agent Runs, errores frecuentes, y links a replay.
   - Criterio: reduce tiempo de diagnóstico en operación real.

