# Hunter CRM — Agent OS v1 (MVP)

Este documento resume la implementación del **Agent OS v1** (AI‑first) y cómo verificar el fix del loop de **comuna/ciudad** sin tocar conversaciones reales.

## 1) Objetivo y principios

- **AI‑Interprets‑Everything**: la IA genera *solo* una lista de **commands** (no texto suelto).
- **Backend = Command Executor**: valida schema, aplica guardrails (anti‑loop, NO_CONTACTAR, ventana 24h), persiste y audita.
- **No data loss**: no se borran conversaciones/mensajes/logs. “Cleanup/reset” = **ARCHIVE** (soft).
- **Simulación segura**: el simulador escribe en **workspace sandbox** y usa `NULL transport` (nunca manda WhatsApp real).

## 2) Arquitectura (nuevo core)

### AgentRuntimeService
Archivo: `backend/src/services/agent/agentRuntimeService.ts`

- Construye un `contextJson` mínimo:
  - `conversation` (status/stage/program/phoneLine, últimos mensajes)
  - `contact` (candidateName, comuna/ciudad/region, flags NO_CONTACTAR, etc.)
  - `askedFieldsHistory` y `lastOutbound`
  - `whatsappWindowStatus` (IN_24H / OUTSIDE_24H)
- Llama a OpenAI con **function calling** + `response_format=json_object`.
- Devuelve un JSON validado con Zod (ver schema abajo).
- Auditoría:
  - `AgentRunLog` guarda `inputContextJson` y `commandsJson`.
  - `ToolCallLog` guarda cada tool call (args + result/error).

### Command schema (estricto)
Archivo: `backend/src/services/agent/commandSchema.ts`

El agente responde:
```json
{ "agent":"...", "version":1, "commands":[ ... ], "notes":"..." }
```

Commands soportados (MVP):
- `UPSERT_PROFILE_FIELDS`
- `SET_CONVERSATION_STATUS`
- `SET_CONVERSATION_STAGE`
- `SET_CONVERSATION_PROGRAM`
- `ADD_CONVERSATION_NOTE`
- `SET_NO_CONTACTAR`
- `SCHEDULE_INTERVIEW`
- `SEND_MESSAGE` (SESSION_TEXT / TEMPLATE + `dedupeKey`)
- `NOTIFY_ADMIN`

### CommandExecutorService (guardrails)
Archivo: `backend/src/services/agent/commandExecutorService.ts`

Guardrails implementados:
- **NO_CONTACTAR**: bloquea cualquier `SEND_MESSAGE`.
- **Ventana 24h**: fuera de ventana bloquea `SESSION_TEXT` y exige `TEMPLATE`.
- **Anti‑loop**:
  - bloquea si se repite `dedupeKey` en ventana corta,
  - bloquea si el `textHash` (payload) se repite en ventana corta.
  - **loop breaker por campo**: si un campo se preguntó 2+ veces (tabla `ConversationAskedField`), el executor fuerza una confirmación rápida `1) Sí / 2) No` para cortar loops.
  - logging en `OutboundMessageLog` (incluye `blockedReason`).

Helper puro + tests:
- `backend/src/services/agent/guardrails.ts`
- `backend/src/services/agent/guardrails.test.ts`

### Tools deterministas (NO negocio)
Archivo: `backend/src/services/agent/tools.ts`

- `normalizeText` (lower, sin tildes, sin emojis)
- `resolveLocation` (RM mínimo; separadores tipo `/`, multi‑línea)
- `validateRut`
- `piiSanitizeText`
- `stableHash`

Tests:
- `backend/src/services/agent/tools.test.ts`

## 3) Automations (motor determinista)

Archivo: `backend/src/services/automationRunnerService.ts`

- `AutomationRule` define: trigger + condiciones AND + acciones.
- Acciones MVP:
  - `RUN_AGENT` (orchestrator/program_default)
  - `SET_STATUS`
  - `ADD_NOTE`
- Auditoría: `AutomationRunLog` con input/output.

Integración inbound:
- `backend/src/services/whatsappInboundService.ts`
  - Si existen reglas `INBOUND_MESSAGE` habilitadas para el workspace, el inbound **ejecuta automations y retorna early**, evitando el pipeline legacy (donde ocurría el loop de comuna/ciudad).

## 4) Multi‑tenant / multi‑line / programs (MVP)

### Modelos (Prisma)
Archivo: `prisma/schema.prisma`

- `Workspace`, `Membership` (roles OWNER/ADMIN/MEMBER/VIEWER)
- `PhoneLine` (alias + waPhoneNumberId + defaultProgramId)
- `Program` (prompt por program; soft archive)
- Logs: `AgentRunLog`, `ToolCallLog`, `OutboundMessageLog`, `AutomationRunLog`

Routing multi‑line:
- Webhook lee `metadata.phone_number_id` → resuelve `PhoneLine` por `waPhoneNumberId`.
- Conversaciones quedan asociadas a `conversation.phoneLineId`.

## 5) Simulador / Replay / Scenario Runner

Backend: `backend/src/routes/simulate.ts`

- **Sesiones sandbox**: conversaciones con `workspaceId='sandbox'` + `channel='sandbox'`
- `POST /api/simulate/run`: crea inbound en sandbox y ejecuta automations con `transportMode=NULL`
- `POST /api/simulate/replay/:conversationId`: clona una conversación real a sandbox (opcional sanitización PII)
- `GET /api/simulate/scenarios` + `POST /api/simulate/scenario/:id`: corre escenarios predefinidos y entrega reporte JSON

Guardrail PROD:
- `POST /api/simulate/whatsapp` sigue existiendo, pero solo acepta números en allowlist de admin/test (evita teléfonos sintéticos).

Frontend:
- Topbar + navegación: `frontend/src/App.tsx`
- Simulador (3 columnas): `frontend/src/pages/SimulatorPage.tsx`
  - soporta sesiones, replay y **run scenario**.

## 6) Cómo reproducir y verificar el bug “me falta comuna/ciudad…”

### Opción A: Scenario Runner (recomendado)
1) Ir a **Simulador → Run Scenario → “Loop comuna/ciudad (RM)”**.
2) Resultado esperado:
   - `contact.comuna` y `contact.ciudad` quedan poblados (ej: Puente Alto / Santiago),
   - no se repite la misma salida por dedupeKey en ventana corta (ver `OutboundMessageLog`),
   - logs visibles en **Configuración → Logs → Agent Runs**.

### Opción B: Replay de conversación real (sin tocar WA real)
1) Copiar `conversationId` real.
2) En Simulador: “Replay desde conversación real” → `sanitizePii=true` → Replay.
3) Enviar el mensaje inbound que reproducía el loop (ej: `✅ PUENTE ALTO / REGION METROPOLITANA / RUT ...`).

## 7) UI implementada (según spec v1)

- **Topbar**: workspace switcher + Inbox / Inactivos / Simulador / Agenda / Configuración / Salir.
- **Inbox**:
  - filtros por Status + PhoneLine + Program,
  - item muestra chips status/program/phoneLine + snippet.
- **Conversación**:
  - header muestra Status/Stage/Program (dropdown)/PhoneLine + indicador ventana 24h,
  - botón “Abrir en Simulador (Replay)”.
- **Configuración** (tabs): Workspace / Usuarios / Números WhatsApp / Programs / Automations / Logs.

## 8) Tests

Backend (`backend/package.json`):
- `npm test` ejecuta `node --test "dist/**/*.test.js"`.

Cobertura MVP:
- normalización de escapes `\\n`/`\\t` (`backend/src/utils/text.test.ts`)
- tools deterministas (`backend/src/services/agent/tools.test.ts`)
- anti‑loop helper (`backend/src/services/agent/guardrails.test.ts`)

## 9) Migraciones (aditivas, no destructivas)

Nuevas migraciones relevantes:
- `prisma/migrations/20251216145000_agent_os_v1_core/`
- `prisma/migrations/20251216160000_interview_slot_block_archive/` (soft archive en blocks; sin deletes)

Nota local:
- `prisma migrate dev` puede fallar por shadow DB si hay migraciones históricas con columnas duplicadas; para PROD se usa `migrate deploy` (aplica solo pendientes).

---

## Hotfix UI (localhost) — React “Rules of Hooks” crash

**Síntoma**
- UI en blanco en `npm run dev` y consola con:
  - “React has detected a change in the order of Hooks called by App”
  - “Rendered more hooks than during the previous render”

**Causa raíz (alto nivel)**
- En `App` había un `useCallback(...)` definido **después** de returns condicionales (`if (view === 'agenda' ...) return ...`).
- Cuando el `view` cambiaba, algunos renders retornaban antes de ejecutar ese hook y otros no → React detectaba un **orden distinto de hooks** y crasheaba.

**Decisión / fix**
- Se movió ese `useCallback` para que **todos los hooks se ejecuten siempre** (antes de cualquier `return` condicional), manteniendo el orden estable entre renders.

**Verificación**
1) Frontend:
   - `cd frontend && npm run dev`
   - Abrir la app y navegar `Inbox` / `Configuración` / `Simulador` → no debe quedar en blanco y consola sin warnings de hooks.
   - `cd frontend && npm run build` (OK)
2) Backend:
   - `cd backend && npm test` (OK)

**Nota lint**
- No hay ESLint configurado actualmente en `frontend/`, por lo que no se activaron reglas automáticas de `react-hooks` (recomendado agregar en una iteración dedicada si lo quieres).

---

## Safe Outbound Mode (DEV) — no molestar números reales

**Objetivo**
- En DEV (hunter.mangoro.app) evitar envíos WhatsApp a números reales por accidente.

**Implementación**
- Config en `SystemConfig`:
  - `outboundPolicy`: `ALLOWLIST_ONLY` | `ALLOW_ALL` | `BLOCK_ALL`
  - `outboundAllowlist`: lista adicional (JSON)
- Enforcement central en `backend/src/services/whatsappMessageService.ts`:
  - si policy es `ALLOWLIST_ONLY`, bloquea envíos a números fuera de allowlist (admin + test + allowlist adicional).
  - si policy es `BLOCK_ALL`, bloquea todo.
  - devuelve error `SAFE_OUTBOUND_BLOCKED:...` (se registra en el CRM vía `sendResult` de los mensajes).
- UI:
  - Indicador visible en topbar: `SAFE MODE: allowlist only` / `block all`
  - Configurable en **Configuración → Workspace → SAFE OUTBOUND MODE**

**Verificación**
- Activar `ALLOWLIST_ONLY` y dejar allowlist con admin + test.
- Intentar enviar un mensaje a un número no allowlist:
  - debe fallar con `SAFE_OUTBOUND_BLOCKED...` y no salir a WhatsApp.

## Docs operativas
- `docs/RUNBOOK.md` (cómo levantar local + validar Agent OS v1 rápido).
- `docs/DEPLOY.md` (playbook DEV/PROD + rollback).
- `docs/STATUS.md` (qué está listo, qué falta, riesgos y próximos pasos).
