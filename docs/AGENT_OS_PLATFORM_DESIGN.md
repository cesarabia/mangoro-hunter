# Mangoro Agent OS (Hunter) — Diseño de Plataforma Potenciada por IA
> Nota: este documento fue la base inicial. La fuente única de verdad a partir de v1 es `docs/PLATFORM_DESIGN.md`.
**Versión:** 1.0 (documento vivo)  
**Entorno actual (DEV):** `hunter.mangoro.app` (SAFE OUTBOUND MODE)  
**Objetivo del documento:** Ser la “fuente de verdad” de producto + arquitectura + UX + QA para que Codex implemente lo pendiente sin inventar ni romper datos.

---

## 0) Resumen ejecutivo (qué es esto)
**Mangoro Agent OS** es una plataforma para construir y operar **agentes conversacionales** (Programs) conectados a canales (WhatsApp, Sandbox, etc.), disparados por reglas (Automations), con un runtime de IA que produce **comandos estructurados** y un backend que **solo ejecuta** comandos de forma determinista y segura.

La promesa central:
- **IA interpreta** (intención, extracción, decisión, mensaje).
- **Sistema ejecuta** (validar, aplicar guardrails, persistir, auditar, enviar por canal).
- **Observabilidad** humana (logs, replay, scenarios).
- **Cero data loss**: todo es *archive-only*, nunca delete.

Esto permite que reclutamiento/ventas/RRHH/agenda/familia/soporte sean “apps” encima del mismo motor.

---

## 1) Principios no negociables
1) **AI-first real**: todo entendimiento y decisión está en el agente (LLM).  
2) **Backend = Command Executor**: valida schema, aplica guardrails, persiste, audita.  
3) **Safety-by-default** en DEV: SAFE OUTBOUND MODE (allowlist-only).  
4) **Idempotencia e anti-loop**: evitar duplicados, retries y loops de conversación.  
5) **No data loss**: no borrar. Solo archivar.  
6) **Multi-tenant**: el producto debe soportar múltiples clientes/cuentas sin mezclar data.

---

## 2) Conceptos del producto
> Estas son las palabras del sistema. Deben aparecer así en UI/Docs.

- **Workspace**: cliente/cuenta. Define la configuración, usuarios, programas, líneas, automations y logs.  
- **PhoneLine**: número de WhatsApp conectado (línea) y su program por defecto.  
- **Program**: “app/agente” que gobierna conversaciones (reclutamiento, ventas, RRHH, etc.).  
- **Automation**: reglas que disparan agentes/acciones por evento (inbound → RUN_AGENT).  
- **Simulator**: entorno sandbox para probar sin WhatsApp real (NullTransport).  
- **Logs**: auditoría del sistema (Agent Runs, Tool Calls, Automation Runs, Outbound).  
- **SAFE OUTBOUND MODE**: protección central para bloquear envíos a números no autorizados en DEV.

---

## 3) Alcance “Agent OS v1” (versión completa)
### 3.1 Incluye
- Multi-tenant por Workspace (scoping end-to-end + roles).  
- Multi-line WhatsApp por Workspace con routing correcto.  
- Programs (multi-app) + selección/override por conversación.  
- Automations (motor determinista) con acción principal RUN_AGENT.  
- Simulator + Replay + Scenario Runner (NullTransport, PII sanitization).  
- Inbox/Chat UX “premium” (chat-first + Details drawer).  
- Copilot CRM (IA interna) para ayuda + diagnóstico + (luego) acciones con confirmación.  
- Módulo **Uso & Costos** (OpenAI + WhatsApp) con estimaciones y auditoría.  
- Release Notes dentro del producto (DEV) como fuente única para revisar cambios.

### 3.2 No incluye (v2+)
- Builder visual avanzado tipo Zapier completo (si pasa esto → entonces esto) con branching.  
- Billing real (Stripe) y planes pagados operativos (solo diseño).  
- Analítica predictiva “full ML” (solo diseño + KPIs base).  
- Integraciones externas extensas (ATS, CRM externos) salvo hooks.

---

## 4) Arquitectura de alto nivel
### 4.1 Componentes
**Canales**
- WhatsApp Cloud API (real)
- Sandbox (simulador / NullTransport)

**Motor**
- Inbound Service (ingresa mensaje, idempotencia, enruta)
- Automation Engine (determinista; decide qué correr)
- Agent Runtime (LLM → Commands JSON)
- Tool Layer (determinista: normalizar, validar, resolver)
- Command Executor (guardrails + persistencia + envío)
- Outbound Service (WhatsApp) con SAFE OUTBOUND MODE
- Scheduler (inactividad / jobs)
- Logs & Auditoría

### 4.2 Flujo principal (inbound)
1) Llega inbound (WhatsApp webhook)  
2) Idempotencia (no procesar 2 veces el mismo waMessageId)  
3) Resolver Workspace + PhoneLine + Conversation  
4) Disparar Automation Engine (trigger INBOUND_MESSAGE)  
5) Acción típica: RUN_AGENT (orchestrator o program_default)  
6) Agent Runtime produce COMMANDS (JSON schema estricto)  
7) Executor valida + aplica guardrails + ejecuta (y registra)  
8) Outbound (si aplica) pasa por SAFE OUTBOUND MODE + ventana 24h + NO_CONTACTAR  

### 4.3 Flujo de simulación
1) Crear sesión sandbox (workspace “sandbox”)  
2) Ingresar inbound en sandbox  
3) Correr automations + RUN_AGENT con NullTransport  
4) Ver transcript + logs + diffs de estado  
5) Replay: clonar conversación real → sandbox (opcional PII sanitization)

---

## 5) Modelo de datos (mínimo v1)
> Nota: campos exactos pueden variar, pero estos conceptos y relaciones no.

### 5.1 Identidad y acceso
- **User**: {id, email, name, passwordHash?, createdAt}  
- **Workspace**: {id, name, slug, createdAt}  
- **Membership**: {id, userId, workspaceId, role: OWNER|ADMIN|MEMBER|VIEWER, createdAt}

### 5.2 Canales y conversaciones
- **PhoneLine**: {id, workspaceId, alias, phoneE164, waPhoneNumberId, wabaId?, isActive, defaultProgramId?, createdAt}  
- **Contact**: {id, workspaceId, phoneE164, contactDisplayName, candidateName?, email?, rut?, comuna?, ciudad?, region?, …}  
- **Conversation**: {id, workspaceId, contactId, phoneLineId, programId?, status(NEW/OPEN/CLOSED), stage, lastInboundAt, lastOutboundAt, archivedAt?}  
- **Message**: {id, conversationId, direction(IN/OUT), channel(WHATSAPP|SANDBOX), waMessageId?, text, rawJson?, createdAt, sendResult?}

### 5.3 Agent OS runtime & auditoría
- **AgentRunLog**: {id, workspaceId, conversationId?, eventType, inputContextJson, outputCommandsJson, executionResultsJson, createdAt}  
- **ToolCallLog**: {id, agentRunId, toolName, argsJson, resultJson, durationMs, createdAt}  
- **OutboundMessageLog**: {id, workspaceId, conversationId, toE164, type, dedupeKey, payloadHash, blockedReason?, createdAt}  
- **ConversationAskedField**: {id, conversationId, field, askCount, lastAskedAt, lastAskedHash}

### 5.4 Automations
- **AutomationRule**: {id, workspaceId, name, enabled, trigger, scope(phoneLineId?, programId?), conditionsJson, actionsJson, priority}  
- **AutomationRunLog**: {id, workspaceId, ruleId, conversationId?, eventType, inputJson, outputJson, createdAt}

### 5.5 Agenda (módulo ejemplo)
- **Interview**: {id, workspaceId, conversationId?, datetimeISO, locationText, status, createdAt}  
- **InterviewSlotBlock**: {id, workspaceId, start, end, reason, archivedAt?}

### 5.6 Uso & costos
- **UsageEvent** (propuesto): {id, workspaceId, actor(AGENT|COPILOT|SYSTEM), provider(OPENAI|WHATSAPP), category, model?, tokensIn?, tokensOut?, requestId?, costUsd?, metaJson, createdAt}  
- **PricingConfig** (propuesto): {id, workspaceId, openaiPricingJson, whatsappPricingJson, currency, updatedAt}

---

## 6) Agent Runtime (IA) — contrato técnico-funcional
### 6.1 Objetivo
Dado un evento y un contexto, retornar **Commands** (JSON) para que el executor ejecute.

### 6.2 Reglas de oro del agente
- No inventar datos. Si no está seguro: `null` + pregunta/confirmación corta.  
- Siempre generar `dedupeKey` estable en SEND_MESSAGE.  
- Respetar ventana WhatsApp (24h) y preferir templates cuando aplica (el executor bloqueará texto si corresponde).  
- El tono debe ser humano y adaptable (no “robot” por plantillas duras).

### 6.3 Commands (v1)
Comandos mínimos recomendados:
- `UPSERT_PROFILE_FIELDS`
- `SET_CONVERSATION_STAGE`
- `SET_CONVERSATION_PROGRAM`
- `ADD_CONVERSATION_NOTE`
- `SET_NO_CONTACTAR`
- `SCHEDULE_INTERVIEW`
- `SEND_MESSAGE` (SESSION_TEXT | TEMPLATE)
- `NOTIFY_ADMIN`
- `RUN_TOOL` (si aplica)

### 6.4 Guardrails (executor)
- Anti-loop por dedupeKey/textHash  
- Loop breaker por campo (si se preguntó 2+ veces → confirmación 1/2)  
- SAFE OUTBOUND MODE (DEV)  
- Bloqueo por NO_CONTACTAR  
- Ventana 24h WhatsApp

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
- SET_STATUS
- ADD_NOTE

### 7.4 UI Builder (v1)
Builder simple tipo:
- **Cuando pasa**: (evento)
- **Si**: (condiciones AND)
- **Entonces**: (acciones; típicamente RUN_AGENT)

---

## 8) UI/UX — Diseño detallado (campos + paneles)
## 8.1 Layout global (Topbar)
Elementos (izq → der):
1) **Workspace selector** (dropdown)  
2) Badge **SAFE MODE** (estado + color)  
3) Build stamp (gitSha + datetime)  
4) Tabs: Inbox | Inactivos | Simulador | Agenda | Configuración | Ayuda/QA | Salir  
5) **Copilot** botón flotante (global; abajo derecha)

## 8.2 Inbox (Chat-first)
### Columna izquierda: Lista conversaciones
- Filtros: Todos / Nuevos / En seguimiento / Cerrados
- Item conversación:
  - Nombre (candidateName si existe; sino contactDisplayName; sino phone)
  - phoneE164
  - snippet último inbound/outbound
  - badges: status (NEW/OPEN/CLOSED), stage, program
  - indicador “silenciado”/NO_CONTACTAR si aplica

### Panel central: Chat (siempre visible)
- Mensajes con wrap (sin scroll horizontal)
- Estados:
  - “Fuera de ventana 24h” banner si aplica
  - “SAFE MODE bloqueó envío” si aplica (con link a Outbound logs)
- Composer:
  - textarea + botón Enviar
  - botón Sugerir (IA) opcional
  - si OUTSIDE_24H: bloquear texto libre; mostrar selector Template + variables

### Botón **Detalles** (drawer lateral o panel colapsable)
Contenido (orden):
1) Identidad:
   - Contact: candidateName (editable) + contactDisplayName (read-only)
   - phoneE164
2) Estado conversación:
   - Status (NEW/OPEN/CLOSED)
   - Stage (enum)
   - Program (dropdown)
   - PhoneLine (read-only o dropdown si admin)
   - Ventana WhatsApp: IN_24H/OUTSIDE_24H
3) Acciones:
   - Abrir en Simulador (Replay)
   - Marcar NO_CONTACTAR
   - Silenciar IA
   - Agregar nota (admin/system)
4) Perfil (campos extraídos):
   - Comuna/Ciudad/Región
   - RUT
   - Email
   - Experiencia (años + texto)
   - Disponibilidad
5) Logs rápidos (últimos 3):
   - último AgentRun (link)
   - último Outbound log (link)

## 8.3 Inactivos
- Tabla/lista con:
  - contacto, phone, lastInboundAt, lastOutboundAt, motivo (inactividad, archivado), stage, program
- Acciones:
  - “Reabrir” (status OPEN)
  - “Replay en Simulator”
  - “Archive note” (sin borrar)

## 8.4 Simulador
Layout 3 columnas:
1) Sesiones:
   - + Nueva sesión
   - lista sesiones (sandbox) con fecha y tags
   - botón Replay (desde conversación real) + opción sanitizar PII
2) Chat sandbox:
   - inbound/outbound visible
   - input para enviar inbound
   - toggle: “NullTransport (siempre ON en sandbox)"
3) Panel de ejecución:
   - último AgentRun (input/commands/results)
   - Tools (lista + resultados)
   - Outbound logs (blockedReason/dedupeKey)
   - Scenario Runner:
     - dropdown escenario
     - botón Run
     - PASS/FAIL + asserts

## 8.5 Agenda
- Vista lista o calendario
- Crear entrevista (manual) y asociar a conversación
- Bloques de disponibilidad (soft-archive)
- Dedupe/double-booking

## 8.6 Configuración (tabs exactos)
Tabs:
1) **Workspace**
   - SAFE OUTBOUND MODE:
     - Policy: ALLOWLIST_ONLY / ALLOW_ALL / BLOCK_ALL
     - Effective allowlist (read-only) + allowlist adicional (editable)
   - WhatsApp config (seguro):
     - wabaId, phoneNumberIds registrados (por PhoneLine)
     - verify token status
   - OpenAI:
     - key status (set/empty) + modelo default + límites
   - Defaults:
     - defaultProgram por PhoneLine (si aplica)
2) **Usuarios**
   - lista Memberships (email, role)
   - invitación (v2) / toggle active
3) **Números WhatsApp (PhoneLines)**
   - listado: alias, phoneE164, waPhoneNumberId, isActive, defaultProgram
   - crear/editar/desactivar
4) **Programs**
   - listado: name, description, isActive, archivedAt?
   - detalle Program:
     - prompt/base instructions
     - requiredFields (opcional)
     - greeting / menu (opcional)
5) **Automations**
   - listado reglas (enabled, trigger, scope, priority)
   - builder simple (When/If/Then)
   - acción típica: RUN_AGENT
6) **Logs**
   - Agent Runs (filtros por conversación/eventType)
   - Automation Runs
   - Tool Calls
   - Outbound messages (blockedReason, dedupeKey)
7) **Uso & Costos**
   - Resumen (hoy / 7d / 30d):
     - OpenAI: tokens in/out, $ estimado
     - WhatsApp: #outbound, #templates, bloqueos, $ estimado
   - Breakdown por:
     - Workspace / Program / PhoneLine / día
   - Pricing config (editable por OWNER/ADMIN):
     - OpenAI pricing (por modelo) configurable
     - WhatsApp pricing estimada (por país/categoría) configurable
   - Export (CSV) (v2)

## 8.7 Ayuda / QA
Tabs:
- **Ayuda** (no técnica): conceptos + primeros pasos + guías por módulo + troubleshooting.
- **QA / Owner Review**: build/health, SAFE MODE, allowlist, logs recientes, botón Run Smoke Scenarios.
Incluye “Release Notes (DEV)” dentro del producto:
- gitSha, startedAt, safePolicy, allowlist efectiva, changelog y riesgos.

## 8.8 Copilot CRM (IA interna)
### Objetivo (v1)
- Responder dudas del usuario sobre la plataforma.
- Diagnosticar “por qué no respondió” usando logs.
- Navegar: “te llevo a Config → Programs” (sin acciones sensibles).

### Objetivo (v2)
- Proponer acciones como comandos (igual que Agent OS) y ejecutar solo con confirmación 1-click.
- Respetar roles (OWNER/ADMIN vs MEMBER/VIEWER).
- Auditoría: CopilotRunLog + commands ejecutados.

---

## 9) Casos de uso (mínimos)
1) Admin crea PhoneLine + Program + Automation inbound→RUN_AGENT → prueba en Simulator.  
2) Inbound real WhatsApp (número test) → agente responde → logs registran.  
3) Loop breaker: candidato manda “✅ PUENTE ALTO / RM / RUT…” → no se repite la misma pregunta.  
4) Fuera de 24h: intentar enviar texto → se exige template.  
5) SAFE MODE: enviar a número no allowlist → bloqueado + log.  
6) Replay: clonar conversación real → sandbox → comparar resultados sin molestar al candidato.  
7) Copilot: usuario pregunta “por qué no respondió” → copilot revisa logs y explica.  
8) Uso & Costos: admin ve costo estimado mensual por OpenAI/WhatsApp.

---

## 10) QA — estrategia y casos de prueba
### 10.1 Smoke (click-only)
- Topbar muestra SAFE MODE + build stamp
- Inbox abre conversación sin crash
- Detalles abre/cierra y no aplasta el chat
- Simulador crea sesión y corre scenario PASS
- Config abre tabs y Logs muestran runs
- Uso & Costos carga y no rompe UI
- Copilot abre y responde algo coherente

### 10.2 Scenarios (automatizables)
- `location_loop_rm`: no repetir ask comuna/ciudad; completar comuna/ciudad.
- `displayname_garbage`: no tomar “Más información” como nombre.
- `safe_mode_block`: bloquea outbound fuera allowlist.
- `window_24h_template`: bloquea texto fuera de 24h.
- `no_contactar`: bloquea cualquier send.
- `program_menu_select`: si no hay program, menú 1/2/3 y set program.

### 10.3 Unit/integration
- Tools: normalizeText/resolveLocation/validateRut/pii sanitize
- Command executor guardrails (dedupeKey / loop breaker)
- Automation runner determinista

---

## 11) DevOps / Entornos (DEV vs PROD)
### 11.1 Política recomendada
- **DEV:** `hunter.mangoro.app`  
  - SAFE OUTBOUND MODE: `ALLOWLIST_ONLY` (solo admin/test)  
  - DB: `dev.db` (o postgres-dev)  
- **PROD:** `platform.mangoro.app` o `app.mangoro.app`  
  - DB separada: `prod.db` o Postgres  
  - SAFE OUTBOUND MODE: `ALLOW_ALL` (o soft-launch con allowlist al inicio)

### 11.2 Cambio de Webhook (DEV→PROD)
- Preparar PROD + validar `/api/health`
- Cambiar callback URL en Meta a PROD
- Monitorear inbound/outbound
- Rollback: volver webhook a DEV + rollback de app + restore DB backup

---

## 12) Roadmap
### v1 (cerrar Agent OS completo)
- Scoping workspace completo + roles UI
- PhoneLines prod + routing probado
- Programs routing/selección inicial
- Automations builder más capaz
- Scenario runner asserts más ricos
- Uso & Costos v1 estable

### v2 (diferenciación “años luz”)
- Copilot ejecutor (acciones con confirmación)
- Builder visual avanzado + simulador poderoso
- Multilenguaje ES/EN
- KPIs + recomendaciones
- Monetización (planes) + billing

---

## 13) Reglas de oro para iterar sin caos
1) Cada iteración debe actualizar **Release Notes (DEV) en UI**.  
2) Este documento (`docs/PLATFORM_DESIGN.md`) se actualiza SIEMPRE que cambie el producto.  
3) Nada de “inventar UI”: se implementa contra esta spec.  
4) “No borrar data” es auditado (búsqueda de deletes + migraciones aditivas).

---
