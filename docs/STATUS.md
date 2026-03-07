# Hunter CRM — Status (Agent OS v1)

## Qué está listo (hoy)

### ER-P6 (Pre-GoLive Reclutamiento) — implementado
- Modo explícito de respuesta por workspace:
  - `candidateReplyMode = AUTO | HYBRID`
  - `adminNotifyMode = HITS_ONLY | EVERY_DRAFT`
  - UI y API de Workspace actualizadas (fallback compatible con `hybridApprovalEnabled` legado).
- Runtime inbound más robusto:
  - métricas de cola en `/api/health`: `inboundPlannedCount`, `oldestPlannedAgeMs`
  - recuperación de PLANNED atascados (`STUCK_PLANNED_RECOVERED`) con unlock seguro.
- `Sugerir` state-aware:
  - en `OP_REVIEW/WAITING_OP_RESULT` sin borrador retorna guía interna (no mensaje al candidato).
  - contexto incluye `applicationFlow.missingFields` + `nextStep`.
- Notificaciones admin por hitos:
  - `HITS_ONLY` suprime ruido no crítico.
- Inbox más operable:
  - preview prioriza último mensaje conversacional real (oculta eventos internos),
  - modo compacto persistente (localStorage) para operar con menos ruido.
- Smoke scenarios ER-P6 añadidos y validados localmente:
  - `inbound_planned_drains_to_executed`
  - `candidate_auto_reply_until_op_review`
  - `docs_missing_reactivates_ai_and_requests_exact_missing_docs`
  - `accepted_moves_to_interview_pending`
  - `rejected_moves_to_rejected_and_ai_pauses`
  - `suggest_respects_application_state`
  - `conversation_preview_hides_internal_events`
  - `tone_no_slang_in_auto_and_suggest`

### ER-P5 (Hunter PROD only) — avance de implementación
- Fix de storage assets en runtime:
  - `WorkspaceAsset` ya no depende de `/var/lib/hunter/assets`,
  - usa ruta persistente de estado (`/opt/hunter/state/assets`) vía `HUNTER_ASSETS_DIR` / `HUNTER_WORKSPACE_ASSETS_DIR` y fallback controlado.
- Nuevo módulo backend `OP_REVIEW`:
  - `GET /api/op-review/queue` (cola de revisión),
  - `GET /api/op-review/:conversationId` (detalle + resumen + docs),
  - `POST /api/op-review/:conversationId/action` (aceptar/rechazar/volver screening/pedir doc/regenerar resumen),
  - `GET /api/op-review/:conversationId/package` (ZIP con resumen + documentos detectados).
- Nueva vista frontend “Revisión operación” (dock en navegación principal):
  - cola operativa de casos en `OP_REVIEW`,
  - detalle de postulante (cargo/comuna/disponibilidad/experiencia/documentos),
  - acciones directas de operación y descarga de paquete.
- Smoke scenarios añadidos para ER‑P5:
  - `upload_public_asset_ok`
  - `postulacion_driver_to_ready_for_op_review`
  - `op_review_download_package_ok`
  - `op_review_pause_ai_after_ready`
- DoD automático (`/api/release-notes/evaluate-dod`) actualizado para considerar estos escenarios.

### ER-P1 (Hunter PROD only) — estado actual
- `Sugerir` ahora acepta `draftText` explícito y diferencia modo:
  - con borrador: mejora redacción/tono sin perder intención,
  - sin borrador: genera propuesta desde cero.
- Context builder unificado `buildLLMContext(...)` reutilizado para inbound/suggest/compose.
- Filtro de contexto endurecido: excluye eventos internos/notas/logs técnicos del historial que ve el LLM.
- Debounce inbound persistente (DB scheduler + worker) activo: ráfagas de inbound consolidan una sola ejecución.
- Plantilla menú agregada al catálogo conocido: `enviorapido_postulacion_menu_v1` (`es_CL`) y fallback sugerido fuera de 24h.
- Workspace Assets + `SEND_PDF`:
  - assets PDF por workspace (PUBLIC/INTERNAL),
  - envío por tool con validación `OUTSIDE_24H`, SAFE MODE y auditoría en Outbound logs.
- Guardrail de despliegue dedicado: `ops/deploy_hunter_prod.sh` aborta si detecta host viejo (`mangoro-prod` / `3.148.219.40`).
- Validación local (2026-03-06) de smoke scenarios ER‑P1 + pendientes staff:
  - PASS `staff_inbox_list_cases`
  - PASS `staff_reply_to_notification_updates_case`
  - PASS `staff_notification_template_variables`
  - PASS `ssclinical_notification_requires_availability`
  - PASS `suggest_includes_draft_text`
  - PASS `suggest_uses_history_without_system_events`
  - PASS `inbound_debounce_single_draft_for_multiple_msgs`
  - PASS `candidate_ok_does_not_restart_flow`
  - PASS `send_pdf_public_asset_ok`
  - PASS `send_pdf_outside_24h_returns_blocked`
  - PASS `model_resolved_gpt4o_mini`
  - Resultado: **11/11 PASS**.

### ER-P2 (Hunter PROD only) — estado actual
- Deploy guardrails reforzados para host dedicado:
  - `ops/deploy_hunter_prod.sh` exige destino `16.59.92.121`,
  - valida marcador `ops/IS_NEW_SERVER=true`,
  - aborta si detecta fingerprints del host antiguo.
  - layout de releases: `/opt/hunter/releases/<sha-ts>` + symlink `/opt/hunter/current`.
  - datos persistentes fuera del artifact: `/opt/hunter/shared/dev.db`, `/opt/hunter/shared/uploads`, `/opt/hunter/shared/assets`.
  - backup previo a cada deploy:
    - SQLite: `sqlite3 .backup` en `/opt/hunter/backups/dev.db.<ts>.bak`
    - uploads: `/opt/hunter/backups/uploads.<ts>.tgz`
    - retención: últimos 14 backups.
  - guardrail anti data-loss:
    - excluye `.db` y `backend/uploads` del artifact,
    - aborta si detecta `.db` dentro del release,
    - compara baseline de DB (size/conversations/messages) y hace rollback si cae abruptamente.
  - rollback automático:
    - si falla health post-restart, vuelve al symlink previo y reinicia solo `hunter-backend`.
- Configuración de modelo en runtime y config global alineada a `gpt-4o-mini` (override + alias).
- UI operativa:
  - Tooltips consistentes (~1000ms) en controles críticos (`SAFE MODE`, `Stage`, `Sugerir`, `Silenciar IA`, `Mostrar/Ocultar plantillas`).
  - Copilot en desktop con comportamiento “dock” real (reserva espacio lateral; no tapa el chat).
  - Glosario rápido de stages en Configuración → Workspace → Estados.
- Routing safety en PROD:
  - inbound sin `waPhoneNumberId` o sin match ya no cae al workspace `default`,
  - se registra evento `UNROUTED_INBOUND` y no se responde al candidato,
  - inbound automático en workspace `default` se bloquea server-side con evento `DEFAULT_WORKSPACE_INBOUND_BLOCKED`.
- Tone guard:
  - `Sugerir` aplica filtro anti-modismos (ej: `wena`, `me tinca`, `bacán`, `compa`, `bro`, `cachai`),
  - retry automático de reescritura profesional; si no pasa validación, retorna error técnico en vez de texto defectuoso.

### ER-P3 (Deploy safety + restore) — implementado en repo (plan de ejecución pendiente)
- Backup dedicado agregado: `ops/hunter_backup.sh`
  - backup consistente SQLite (`sqlite3 .backup`) + `uploads.tar.gz`,
  - `manifest.txt` + `SHA256SUMS.txt`,
  - retención configurable (>14 días),
  - soporte opcional a S3 (`S3_BACKUP_BUCKET`).
- Restore controlado agregado: `ops/hunter_restore.sh`
  - modo por defecto **PLAN ONLY** (no ejecuta),
  - restore real solo con `--execute` + `HUNTER_RESTORE_CONFIRM=YES`.
- Deploy PROD reforzado:
  - `ops/deploy_hunter_prod.sh` invoca backup obligatorio antes de restart,
  - migra/usa estado persistente en `/opt/hunter/state/{dev.db,uploads}`,
  - aborta si `DATABASE_URL` apunta al árbol de código/releases,
  - aborta si artifact incluye `.db` o `backend/uploads`.
- Runtime con compatibilidad state/legacy:
  - `backend/src/utils/statePaths.ts` resuelve DB/uploads en `state` con fallback temporal legacy + warnings explícitos.
- Smoke nuevo:
  - `deploy_creates_backup_before_restart` valida guardrails de backup en modo simulado.

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
- `SAFE OUTBOUND MODE` configurable en UI con políticas:
  - `ALLOWLIST_ONLY` (default DEV),
  - `BLOCK_ALL`,
  - `ALLOW_ALL` (override explícito; auditado).

### Multi-persona WhatsApp (V2.3)
- Router determinista por conversación: `CLIENT | STAFF | PARTNER | ADMIN`.
- Override por comando (si está habilitado): `roles` / `modo cliente|staff|proveedor|auto` con TTL.
- Menús por “persona” (workspace): programas permitidos para staff/partner (solo activos) y default program por persona.

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
  - Comando operativo `WORKSPACE_BOOTSTRAP_BUNDLE` (bundle auditable) para corregir gates de Setup Wizard en una sola ejecución (Programs/Stages/Routing/Automations/defaults).
  - `Fix with Copilot` usa marcador de gate (`[SETUP_WIZARD_FIX gate=...]`) + auto-send para ejecutar cambios reales, no solo guía textual.
- Fix de crash por “Rules of Hooks” (App ya no queda en blanco).
- Download Review Pack (zip) desde Owner Review.
- SSClinical (pilot): setting `Nurse Leader Email` + stage `INTERESADO` dispara auto-asignación vía Automation `STAGE_CHANGED`.
- Estados/Stages configurables por workspace (UI + API) vía `WorkspaceStage` (archive-only) con `isDefault` (exactamente 1 default activo).
- Notificaciones in-app (campana): asignación manual y handoff `INTERESADO` crean `InAppNotification` + log `NOTIFICATION_CREATED`.
- Copilot follow-up: si Copilot ofrece listar Programs/Automations y el usuario responde “sí”, ejecuta sin repreguntar (estado en `CopilotThread.stateJson`).
- Workspace operativo “Envio Rápido” (DEV bootstrap idempotente):
  - Programs CLIENT/STAFF de reclutamiento de conductores,
  - stages de pipeline de reclutamiento,
  - automations base (`INBOUND_MESSAGE -> RUN_AGENT` + handoff `QUALIFIED/INTERVIEW_PENDING -> ASSIGN + NOTIFY_STAFF_WHATSAPP`),
  - saneo archive-only de seeds heredados (“ventas en terreno/alarmas”).
- Rediseño LLM-first (postulación Envío Rápido):
  - se eliminó el reemplazo técnico de borradores (ya no aparece la nota “borrador técnico reemplazado”),
  - el runtime recupera texto del LLM en errores de parseo (`INVALID_SCHEMA`/`INVALID_SEMANTICS`) y ejecuta solo `SEND_MESSAGE`,
  - metadata conversacional nueva: `conversation.applicationRole` + `conversation.applicationState` (comando `SET_APPLICATION_FLOW`),
  - default de modelos en config/admin/interview a `gpt-4o-mini` + `candidateMaxOutputTokens` configurable.
- Smoke scenarios agregados:
  - `candidate_intake_choose_role`
  - `candidate_conductor_collect_cv_and_docs`
  - `candidate_peoneta_basic_flow`

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
