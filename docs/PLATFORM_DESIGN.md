# Hunter CRM — Agent OS Platform Design (Living Doc)
**Versión:** 1.0 (documento vivo)  
**Entorno DEV actual:** `https://hunter.mangoro.app`  
**SAFE OUTBOUND MODE (DEV):** `ALLOWLIST_ONLY` (allowlist efectiva SOLO: `56982345846` admin, `56994830202` test)  

**Objetivo del documento:** ser la **fuente única de verdad** para backend + frontend + IA + QA + DevOps.  
Regla: si cambia producto/arquitectura, se actualiza este documento y las **Release Notes (DEV)** dentro de la UI.

---

## 0) Resumen ejecutivo (qué es esto)
**Hunter Agent OS** es una plataforma para construir y operar **agentes conversacionales** (**Programs**) conectados a canales (WhatsApp real + Sandbox), disparados por reglas (**Automations**), con un runtime de IA que produce **comandos estructurados** y un backend que **solo ejecuta** comandos de forma determinista y segura.

Promesa central:
- **IA interpreta** (intención, extracción, decisión, mensaje).
- **Sistema ejecuta** (validar, aplicar guardrails, persistir, auditar, enviar por canal).
- **Observabilidad humana** (logs, replay, scenarios).
- **Cero data loss:** todo es *archive-only*, nunca delete.

Esto permite que reclutamiento/ventas/RRHH/agenda/soporte sean “apps” encima del mismo motor.

---

## 1) Principios no negociables
1) **AI-first real**: el entendimiento y la decisión viven en el agente (LLM).  
2) **Backend = Command Executor**: valida schema, aplica guardrails, persiste y audita.  
3) **Safety-by-default en DEV**: SAFE OUTBOUND MODE (allowlist-only).  
4) **Idempotencia e anti-loop**: evitar duplicados, retries y loops.  
5) **No data loss**: no borrar. Solo archivar.  
6) **Multi-tenant**: soportar múltiples workspaces sin mezclar data.  

---

## 2) Conceptos del producto
> Estos nombres son “idioma del sistema”: deben aparecer así en UI/Docs.

- **Workspace**: cliente/cuenta. Define configuración, usuarios, programas, líneas, automations y logs.  
- **PhoneLine**: número de WhatsApp conectado (línea) y su Program por defecto.  
- **Program**: “app/agente” que gobierna conversaciones (reclutamiento, ventas, RRHH, etc.).  
- **Automation**: regla determinista que dispara agentes/acciones por evento (inbound → RUN_AGENT).  
- **Simulator**: sandbox para probar sin WhatsApp real (**NullTransport**).  
- **Replay**: clonar una conversación real a sandbox para depurar sin molestar usuarios reales.  
- **Scenarios**: pruebas automatizadas con asserts (PASS/FAIL) ejecutadas en sandbox.  
- **Logs**: auditoría del sistema (Agent Runs, Tool Calls, Automation Runs, Outbound).  
- **SAFE OUTBOUND MODE**: protección central (DEV) para bloquear envíos a números no autorizados.  

---

## 3) Alcance “Agent OS v1” (versión completa)
### 3.1 Incluye
- Multi-tenant por Workspace (scoping end-to-end + roles).  
- Multi-line WhatsApp por Workspace con routing correcto por `phone_number_id`.  
- Programs (multi-app) + selección/override por conversación.  
- Automations (motor determinista) con acción principal RUN_AGENT.  
- Simulator + Replay + Scenario Runner (NullTransport, PII sanitization).  
- Inbox/Chat UX “premium” (chat-first + Details).  
- Copilot CRM (IA interna) para ayuda + diagnóstico + (luego) acciones con confirmación.  
- **Uso & Costos** (OpenAI + WhatsApp) con estimaciones y auditoría.  
- **Release Notes (DEV)** dentro del producto como fuente única para revisar cambios.  
- **Review Pack ZIP** descargable desde la UI (para auditoría/compartir).  

### 3.2 No incluye (v2+)
- Builder visual avanzado tipo Zapier con branching complejo (v2).  
- Billing real (Stripe) y planes pagos operativos (solo diseño).  
- Analítica avanzada/predictiva “full ML” (solo KPIs base + diseño).  
- Integraciones externas grandes (ATS/CRM) salvo hooks (v2).  

---

## 4) Arquitectura de alto nivel
### 4.1 Componentes
**Canales**
- WhatsApp Cloud API (real)
- Sandbox (Simulator / NullTransport)

**Core**
- Inbound Service (ingresa mensaje, idempotencia, routing workspace/phoneline)
- Automation Engine (determinista; decide qué correr)
- Agent Runtime (LLM → Commands JSON)
- Tool Layer (determinista: normalizar, validar, resolver)
- Command Executor (guardrails + persistencia + envío)
- Outbound Service (WhatsApp) con SAFE OUTBOUND MODE
- Scheduler (inactividad / jobs)
- Logs & Auditoría

### 4.2 Flujo principal (inbound)
1) Llega inbound (WhatsApp webhook)  
2) Idempotencia (no procesar 2 veces el mismo `Message.waMessageId`)  
3) Resolver **Workspace + PhoneLine** por `metadata.phone_number_id`  
4) Resolver/crear Contact + Conversation en ese workspace (sin mezclar)  
5) Disparar Automation Engine (trigger INBOUND_MESSAGE)  
6) Acción típica: RUN_AGENT (orchestrator o program_default)  
7) Agent Runtime produce COMMANDS (JSON schema estricto)  
8) Executor valida + aplica guardrails + ejecuta (y registra)  
9) Outbound (si aplica) pasa por SAFE OUTBOUND MODE + ventana 24h + NO_CONTACTAR  

### 4.3 Flujo de simulación (Simulator/Scenarios)
1) Crear sesión sandbox (workspace `sandbox`)  
2) Ingresar inbound en sandbox  
3) Correr automations + RUN_AGENT con **NullTransport** (nunca WhatsApp real)  
4) Ver transcript + logs + diffs de estado  
5) Replay: clonar conversación real → sandbox (opcional PII sanitize)  

---

## 5) Modelo de datos (mínimo v1)
> Campos exactos pueden variar, pero estos conceptos/relaciones no.

### 5.1 Identidad y acceso
- **User**: credenciales + rol global (mínimo)  
  - `platformRole`: `SUPERADMIN|NONE` (gating de “Clientes/Plataforma” y endpoints `/api/platform/*`).  
- **Workspace**: tenant (incluye `isSandbox`)  
  - Settings por workspace (ej: `ssclinicalNurseLeaderEmail` para asignación automática en SSClinical).  
- **Membership**: rol por workspace (OWNER|ADMIN|MEMBER|VIEWER), soft-archive (no delete)  
  - `assignedOnly`: si `true` y rol=MEMBER, el usuario solo ve/gestiona conversaciones asignadas (`Conversation.assignedToId`).  
  - `staffWhatsAppE164` (opcional): WhatsApp del usuario para **notificaciones staff** (ej: SSClinical Stage=INTERESADO).  
- **WorkspaceInvite** (archive-only): invitación expirable por email+rol para entrar a un workspace.  
  - Token **no** se loguea; solo se expone al OWNER vía “Copiar link”.  
  - Aceptación (sin fricción y sin reset de password):
    - **Usuario nuevo**: define nombre+password y se crea la cuenta al aceptar.
    - **Usuario existente**: debe **iniciar sesión** y aceptar (endpoint `accept-existing`), sin cambiar credenciales.

### 5.2 Canales y conversaciones
- **PhoneLine**: alias + `waPhoneNumberId` + defaultProgram + **modo de entrada**  
  - `inboundMode=DEFAULT`: si la conversación no tiene Program, aplica `defaultProgramId`.  
  - `inboundMode=MENU`: si la conversación no tiene Program, el sistema muestra un **menú corto (1/2/3)** para que el usuario elija (y luego fija `conversation.programId`).  
  - `programMenuIds` (opcional): limita qué Programs aparecen en ese menú (si está vacío, muestra todos los activos).  
  - Comando **“menu”** (WhatsApp): muestra el menú **aunque ya exista Program** (para cambiar de flujo) y registra `PROGRAM_SELECTION`.  
- **Contact**: contactDisplayName (WhatsApp) + candidateName (extraído) + candidateNameManual (override humano)  
- **WorkspaceStage** (catálogo por workspace, configurable desde UI):  
  - `slug` (ID estable), `labelEs` (texto humano), `order`, `isDefault`, `isActive`, `isTerminal`, `archivedAt`.  
  - Regla: **exactamente 1 stage default activo** por workspace (si se desactiva/archiva, se elige otro automáticamente).  
  - Seed idempotente: set genérico + set SSClinical (incluye `INTERESADO`).  
- **Conversation**: status (NEW/OPEN/CLOSED) + `conversationStage` (slug) + programId + phoneLineId + flags y metadata  
  - `assignedToId`: asignación (para `MEMBER assignedOnly`).  
- **Message**: inbound/outbound + waMessageId idempotente + media/transcriptText + timestamp  
- **InAppNotification** (archive-only): notificaciones visibles en UI (campana) para asignaciones/handoffs (ej: Stage=INTERESADO).  

### 5.3 Agent OS runtime & auditoría
- **AgentRunLog**: inputContextJson + outputCommandsJson + executionResultsJson + error  
- **ToolCallLog**: toolName + argsJson + resultJson/error  
- **OutboundMessageLog**: dedupeKey + textHash + blockedReason + waMessageId  
- **ConversationAskedField**: contador por campo para loop-breaker  

### 5.4 Automations
- **AutomationRule**: trigger + scope + conditionsJson + actionsJson + priority + enabled  
- **AutomationRunLog**: input/output + status/error  

### 5.5 Copilot
- **CopilotThread**: hilo por workspace+user (persistente)  
- `stateJson`: estado liviano para follow-ups (ej: Copilot ofrece “listar automations” y, si el usuario responde “sí”, ejecuta sin repreguntar).  
- **CopilotRunLog**: auditoría por corrida (diagnóstico/navegación) y fuente del historial (inputText/responseText)  
  - Estados: `RUNNING` → `SUCCESS` / `PENDING_CONFIRMATION` → (`EXECUTING` → `EXECUTED`) / `CANCELLED` / `ERROR`  
  - Confirmar/Cancelar es **idempotente** (doble click no duplica ejecución; devuelve “ya ejecutado”).  
  - **Guías visuales (coachmarks)**: Copilot puede emitir acciones `GUIDE` (steps con `guideId`) que resaltan elementos UI (`data-guide-id="..."`) y guían al usuario sin terminal.  

### 5.6 Uso & costos
- **AiUsageLog**: tokens por AgentRuntime/Copilot  
- **OutboundMessageLog**: conteos WA (SESSION_TEXT/TEMPLATE) + bloqueos  
- **PricingConfig** (hoy: SystemConfig global): precios configurables (OpenAI por modelo, WA estimación)  

### 5.7 Programs PRO (Knowledge Pack + Tools)
- **Program**: además del prompt (`agentSystemPrompt`), incluye campos de “producto”:
  - `goal`, `audience`, `tone`, `language` (para construir prompts consistentes y UX explicable).
- **ProgramKnowledgeAsset** (archive-only):
  - Tipos mínimos: `LINK` | `TEXT` (extensible a archivos).
  - Campos: `title`, `url?`, `contentText?`, `tags?`, `archivedAt?`.
- **WorkspaceConnector** (archive-only):
  - Conectores declarativos disponibles por workspace (ej: “Medilink”), con:
    - `baseUrl` (solo `http/https`), `authType` (`BEARER_TOKEN` | `HEADER`), `authHeaderName`, `authToken` (masked en UI),
    - `allowedDomains` (allowlist para evitar SSRF), `timeoutMs`, `maxPayloadBytes`,
    - `actionsJson` (acciones posibles), `isActive`, `archivedAt`.
  - “Test conexión” (UI/endpoint) **NO ejecuta negocio**: solo valida conectividad y deja auditoría:
    - Bloquea hosts locales/privados (SSRF guardrail),
    - Respeta `allowedDomains`,
    - Loggea sin secretos.
- **ConnectorCallLog** (audit log, archive-only):
  - Registra cada test/llamada (kind/action, request/response resumida, ok/error/statusCode, userId, timestamps).
- **ProgramConnectorPermission** (archive-only):
  - Whitelist por Program de qué acciones del connector están permitidas (`allowedActionsJson`).
- Auditoría: cambios en Programs/Knowledge/Tools se registran en `ConfigChangeLog`.

---

## 6) Agent Runtime (IA) — contrato técnico-funcional
### 6.1 Objetivo
Dado un evento y un contexto, retornar **Commands** (JSON) para que el executor ejecute.

### 6.2 Reglas de oro del agente
- No inventar datos. Si no está seguro: `null` + pregunta/confirmación corta.  
- Siempre generar `dedupeKey` estable en SEND_MESSAGE.  
- Respetar ventana WhatsApp (24h) y preferir templates cuando aplica (el executor bloqueará texto si corresponde).  
- Nunca sobrescribir `candidateNameManual`.  
- Evitar loops: no repetir la misma pregunta 2+ veces; usar confirmación 1/2.  

### 6.3 Commands (v1)
Comandos mínimos:
- `UPSERT_PROFILE_FIELDS`
- `SET_CONVERSATION_STATUS`
- `SET_CONVERSATION_STAGE`
- `SET_CONVERSATION_PROGRAM`
- `ADD_CONVERSATION_NOTE`
- `SET_NO_CONTACTAR`
- `SCHEDULE_INTERVIEW`
- `SEND_MESSAGE` (SESSION_TEXT | TEMPLATE + `dedupeKey`)
- `NOTIFY_ADMIN`
- `RUN_TOOL` (opcional)

### 6.4 Guardrails (executor)
- Anti-loop por dedupeKey/textHash  
- Loop breaker por campo (si se preguntó 2+ veces → confirmación 1/2)  
- SAFE OUTBOUND MODE (DEV)  
- Bloqueo por NO_CONTACTAR  
- Ventana 24h WhatsApp (fuera: template-only)  

---

## 7) Automations (motor determinista)
### 7.1 Propósito
Desacoplar “cuándo correr qué” del agente:
- Automations decide **qué agente correr** y bajo qué condiciones.
- El agente decide **qué hacer** (commands).

### 7.2 Triggers (v1)
- INBOUND_MESSAGE
- INACTIVITY
- STAGE_CHANGED
- PROFILE_UPDATED
- MANUAL_ACTION (opcional)

### 7.3 Actions (v1)
- RUN_AGENT (principal)
- SET_STATUS (opcional)
- ADD_NOTE (opcional)
- ASSIGN_TO_NURSE_LEADER (SSClinical)
- NOTIFY_STAFF_WHATSAPP (SSClinical; respeta SAFE MODE + 24h y deja fallback in-app)

### 7.4 UI Builder (v1)
Builder simple:
- **Cuando pasa**: trigger
- **Si**: condiciones (AND)
- **Entonces**: acciones (RUN_AGENT por defecto)

---

## 8) UI/UX — Diseño detallado por pantalla
### 8.1 Layout global (Topbar)
Elementos (izq → der):
1) Workspace selector (dropdown)  
2) Badge SAFE MODE (estado)  
3) Build stamp (gitSha + startedAt)  
4) Tabs: Inbox | Inactivos | Simulador | Agenda | Configuración | Ayuda/QA | Salir  
5) Copilot flotante (global; auto-posicionado para no tapar el compositor del chat)  

### 8.1.1 Responsive & State (reglas)
Breakpoints (v1):
- **Topbar**: `< 980px` se colapsa a menú (hamburger) para evitar overflow.
- **Inbox**: `< 900px` usa navegación tipo mobile: Lista → Chat fullscreen con botón **Volver**.
- **Copilot**: `< 820px` se muestra como **bottom sheet** (no tapa navegación ni el compositor).

Reglas de estado (NO perder contexto):
- `selectedConversationId` se persiste en `localStorage` para diagnóstico (Copilot) y continuidad.
- El **draft del input** se guarda **por conversación** (persistente en `localStorage`) y no se pierde al:
  - cambiar de conversación,
  - volver a la lista en mobile,
  - cruzar breakpoints (redimensionar).
- En mobile:
  - **Volver** solo cambia el panel visible; **no** borra la conversación seleccionada.
  - El chat siempre tiene scroll vertical propio; **cero** scroll horizontal.

### 8.2 Inbox (Chat-first)
**Lista conversaciones (izquierda)**
- ContactDisplayName (o teléfono si no hay)  
- Chips: status (NEW/OPEN/CLOSED), program, phoneLine  
- Snippet último mensaje  

**Chat (centro)**
- Mensajes con wrap (sin scroll horizontal)  
- Timestamps por mensaje  
- Input sticky abajo  

**Detalles (derecha / drawer)**
Contenido (orden):
1) Identidad:
   - ContactDisplayName (read-only)
   - CandidateName detectado + CandidateName manual (editable + limpiar override)
2) Estado conversación:
   - Status (NEW/OPEN/CLOSED)
   - Stage
   - Program (dropdown)
   - PhoneLine (read-only)
   - Ventana WhatsApp: IN_24H/OUTSIDE_24H
3) Acciones:
   - Abrir en Simulador (Replay)
   - Marcar NO_CONTACTAR / Reactivar contacto
   - Silenciar IA
   - Archivar (stage ARCHIVED; nunca delete)
4) Perfil (campos extraídos):
   - Comuna/Ciudad/Región
   - RUT / Email
   - Experiencia / Disponibilidad
5) Logs rápidos:
   - últimos AgentRuns / Outbound logs (links)

### 8.3 Inactivos
- Vista con filtros por stage/motivo (STALE/ARCHIVED/DISQUALIFIED)
- Acciones: reabrir, replay, archivar con nota

### 8.4 Simulador
Layout 3 columnas:
1) Sesiones: nueva, replay (sanitize PII), run scenario  
2) Chat sandbox: timeline + input inbound  
3) Debug: estado/diffs, último AgentRun, tool calls, automations fired, transporte (Null)  

### 8.5 Configuración (tabs)
Tabs (v1):
1) Workspace
2) Usuarios
3) Números WhatsApp
4) Programs
5) Automations
6) Integraciones (OpenAI/WhatsApp)
7) Uso & Costos
8) Logs

#### 8.5.1 Programs (PRO)
En v1 “profesional”, Programs incluye (además de `name/slug/isActive/agentSystemPrompt`):
- **Resumen del Program**: `goal`, `audience`, `tone`, `language`.
- **Knowledge Pack** (archive-only): assets `LINK`/`TEXT` (extensible a archivos) con archivar/reactivar.
- **Tools / Integraciones por Program**: seleccionar connectors del workspace y hacer whitelist de acciones permitidas.
- **Prompt Builder**: “Generar/Mejorar instrucciones con IA” con preview + aplicar, y auditoría en `ConfigChangeLog`.

### 8.6 Ayuda / QA
Tabs:
- **Ayuda** (no técnica): conceptos + primeros pasos + guías por módulo + troubleshooting.
- **QA / Owner Review**: build/health, SAFE MODE, allowlist efectiva, logs recientes, botón Run Smoke Scenarios, Release Notes (DEV) + **DoD v1** (Auto: PASS/FAIL/PENDIENTE re-evaluable; Manual: PENDIENTE por defecto) y descarga Review Pack ZIP.

---

## 9) Casos de uso (mínimos)
1) Admin crea PhoneLine + Program + Automation inbound→RUN_AGENT → prueba en Simulator.  
2) Inbound real WhatsApp (número test) → agente responde → logs registran.  
3) Loop breaker: candidato manda “✅ PUENTE ALTO / RM / RUT…” → no se repite la misma pregunta.  
4) Fuera de 24h: intentar enviar texto → se exige template.  
5) SAFE MODE: enviar a número no allowlist → bloqueado + log.  
6) Replay: clonar conversación real → sandbox → comparar resultados sin molestar al candidato.  
7) Copilot: usuario pregunta “por qué no respondió” → copilot revisa logs y explica.  
8) Uso & Costos: admin ve costo estimado por día/program/phoneline.  
9) Multi-program: conversación sin program → menú 1/2/3 → asignación program.  

---

## 10) QA — estrategia y casos de prueba
### 10.1 Smoke (click-only)
- SAFE MODE + build stamp visibles
- Inbox abre conversación sin crash
- Chat visible + input sticky + wrap sin scroll horizontal
- Simulador crea sesión y corre scenario PASS
- Config abre tabs y Logs muestran runs
- Uso & Costos carga
- Copilot abre y puede navegar/diagnosticar

### 10.2 Scenarios (automatizables, sandbox)
- `admin_hola_responde` / `test_hola_responde`: validan respuesta a números allowlist.
- `location_loop_rm`: no repetir ask comuna/ciudad ante formatos mixtos.
- `displayname_garbage`: “Más información” no contamina candidateName.
- `program_menu_dedupe`: dedupeKey evita re-envíos del menú (anti-loop).
- `safe_mode_block`: outbound bloqueado fuera allowlist (SAFE MODE).
- `window_24h_template`: fuera de 24h bloquea SESSION_TEXT.
- `no_contactar_block`: bloquea cualquier SEND_MESSAGE.
- `program_select_assign`: conversación sin Program → menú 1/2/3 → asignación.
- `program_switch_suggest_and_inbound`: consistencia total al cambiar Program (Sugerir + inbound).
- `platform_superadmin_gate`: /api/platform/* solo SUPERADMIN.
- `ssclinical_onboarding`: seed SSClinical (Programs + inbound RUN_AGENT + invites).
- `ssclinical_stage_assign`: stage INTERESADO auto-asigna nurse leader.
- `stage_admin_configurable`: stages configurables por workspace (create + set).
- `inbound_program_menu`: PhoneLine inboundMode=MENU limita Programs del menú.
- `invite_existing_user_accept`: aceptar invite de usuario existente (sin reset password).
- `copilot_archive_restore`: archivar/restaurar hilos de Copilot.

### 10.3 Unit/integration
- Tools: normalizeText/resolveLocation/validateRut/pii sanitize
- Executor guardrails (dedupeKey/textHash + loop breaker)
- Automation runner determinista (conditions/actions)

---

## 11) Seguridad y cumplimiento
- **SAFE OUTBOUND MODE (DEV)**:
  - Policies: `ALLOWLIST_ONLY` (default), `BLOCK_ALL`, `ALLOW_ALL` (solo si se habilita explícitamente).
  - **TEMP_OFF**: permite `ALLOW_ALL` por X minutos (campo `SystemConfig.outboundAllowAllUntil`) y vuelve a `ALLOWLIST_ONLY` al expirar.
  - El servidor limpia `outboundAllowAllUntil` cuando expira y deja auditoría `ConfigChangeLog` tipo `OUTBOUND_SAFETY_TEMP_OFF_EXPIRED`.
  - Cualquier bloqueo queda registrado como `blockedReason` (ej: `SAFE_OUTBOUND_BLOCKED:*`) y se muestra en QA → Logs.
  - Cambios de policy/allowlist/TEMP_OFF quedan auditados en `ConfigChangeLog` (visible en QA → Logs → Config Changes).
- **Rate limiting (baseline)**:
  - Límite in-memory por IP para: WhatsApp webhook, Copilot, Simulator y “AI suggest”.
  - Respuesta 429 incluye `Retry-After` y queda visible via logs estándar del backend.
- **Request limits + headers (baseline)**:
  - `bodyLimit` aplicado a requests JSON para reducir abuso.
  - Headers mínimos: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`.
- **NO_CONTACTAR**: bloquea cualquier outbound (respeto opt-out).  
- **Ventana WhatsApp 24h**: fuera de ventana, texto libre bloqueado; solo templates.  
- **Auditoría**: cada run y cada tool call queda logueado; replay no toca conversaciones reales.  
- **PII**: Replay/Export puede sanitizar teléfonos/emails/RUT.  
- **No data loss**: archive-only. “Cleanup” = archivar y resumir; nunca borrar.  

---

## 12) DevOps / Entornos (DEV vs PROD)
### 12.1 Política recomendada
- **DEV:** `hunter.mangoro.app`  
  - SAFE MODE: `ALLOWLIST_ONLY` (solo admin/test)  
  - DB dev (idealmente separada)  
- **PROD:** `platform.mangoro.app` o `app.mangoro.app`  
  - DB separada (obligatoria)  
  - SAFE MODE: `ALLOW_ALL` (o soft-launch allowlist al inicio)  

### 12.2 Cambio de Webhook (DEV→PROD)
- Preparar PROD + validar `/api/health`
- Cambiar callback URL en Meta a PROD
- Monitorear inbound/outbound
- Rollback: volver webhook a DEV + rollback app + restore DB backup

---

## 13) Roadmap “infinito” (backlog)
- Copilot Nivel 3: acciones sensibles adicionales + rollback/preview (siempre con confirmación).
- Builder Automations avanzado (OR/branching, templates de reglas, preview).
- Multi-idioma ES/EN + locale por workspace.
- Monetización: planes, límites, billing (Stripe).
- Analytics avanzado: cohortes, conversion, SLA, alertas, KPIs por program.
- Integraciones: ATS/CRM externos, webhooks salientes, import/export.
- Guardrails avanzados: rate limiting, policy packs, content safety.

---

## 14) Reglas de oro para iterar sin caos
1) Cada iteración actualiza **Release Notes (DEV)** dentro del producto.  
2) Este documento se actualiza SIEMPRE que cambie producto/arquitectura.  
3) Nada de “inventar UI”: se implementa contra esta spec.  
4) “No borrar data” se respeta (migraciones aditivas/soft archive).  
