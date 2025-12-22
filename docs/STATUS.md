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
- Platform SUPERADMIN (solo `cesarabia@gmail.com`) para “Clientes/Plataforma” y endpoints `/api/platform/*`.

### Multi-line WhatsApp
- Routing inbound por `phone_number_id` → `PhoneLine` (safe-fail si no existe).
- Outbound desde la línea asociada a la conversación (usa `phoneLine.waPhoneNumberId`).
- `PhoneLine.inboundMode`:
  - `DEFAULT`: aplica `defaultProgramId` si la conversación no tiene Program.
  - `MENU`: muestra menú de Programs y asigna por opción (1/2/3), con allowlist opcional por línea.
  - Comando WhatsApp **“menu”**: muestra el menú aunque ya exista Program (cambio de flujo) y deja log `PROGRAM_SELECTION`.

### Programs como flows
- Programs CRUD por workspace.
- Si una conversación no tiene `programId` y hay >1 Program activo: menú corto 1/2/3 y asignación.
- Override manual de Program desde CRM.

### UI
- Topbar con navegación: Inbox / Inactivos / Simulador / Agenda / Configuración.
- Configuración con tabs (Workspace / Integraciones / Usuarios / Números WhatsApp / Programs / Automations / Uso & Costos / Logs).
- Ayuda (no técnica) + QA/Owner Review (técnica) separadas y click-only.
- Copilot CRM:
  - Nivel 1: ayuda + diagnóstico + navegación + historial persistente por hilo.
  - Nivel 2 (MVP): propuestas con Confirmar/Cancelar + ejecución idempotente + auditoría (CopilotRunLog).
- Fix de crash por “Rules of Hooks” (App ya no queda en blanco).
- Download Review Pack (zip) desde Owner Review.
- SSClinical (pilot): setting `Nurse Leader Email` + stage `INTERESADO` dispara auto-asignación vía Automation `STAGE_CHANGED`.
- Estados/Stages configurables por workspace (UI + API) vía `WorkspaceStage` (archive-only) con `isDefault` (exactamente 1 default activo).
- Notificaciones in-app (campana): asignación manual y handoff `INTERESADO` crean `InAppNotification` + log `NOTIFICATION_CREATED`.
- Copilot follow-up: si Copilot ofrece listar Programs/Automations y el usuario responde “sí”, ejecuta sin repreguntar (estado en `CopilotThread.stateJson`).

## Qué falta (para “Agent OS v1 completo”)
- (Opcional) Integraciones por workspace (OpenAI/WhatsApp) si se requiere multi‑cliente con credenciales separadas.
- Ampliar catálogo de acciones Copilot Nivel 2 (usuarios/invitaciones + templates) y permisos finos por rol.
- Scenarios más amplios (reclutamiento/entrevista/ventas) con asserts de contenido, stages y assignedOnly completo.

## Riesgos conocidos
- DEV y PROD comparten riesgos si usan la misma DB/WhatsApp:
  - sin SAFE OUTBOUND MODE se puede molestar a números reales.
- Dependencia de OpenAI: si no hay key, `RUN_AGENT` falla (se ve en logs).
- Migraciones históricas: en local `prisma migrate dev` puede fallar por shadow DB; usar `migrate deploy` para aplicar pendientes.

## Próximas 3 tareas recomendadas (con criterio)
1) **Separar DEV/PROD de verdad (DB + subdominio + webhooks)**.
   - Criterio: reduce riesgo de incidentes con números reales y permite releases sin miedo.
2) **Catálogo Copilot Nivel 2 + onboarding multi-cliente**.
   - Criterio: acelera operación (usuarios/invites/plantillas) sin tocar terminal y reduce confusión de roles.
3) **Scenarios de negocio (reclutamiento/entrevista/ventas)** con asserts de calidad.
   - Criterio: evita regresiones en lo que importa al usuario final.
