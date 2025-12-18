# DEV QA Result — `hunter.mangoro.app`

Fecha: 2025-12-18

## Build stamp (DEV)
- URL: `https://hunter.mangoro.app/`
- Health: `https://hunter.mangoro.app/api/health`
- gitSha: `1f6dd25`
- startedAt: `2025-12-18T11:33:50.531Z`

## Hotfix 2025-12-18 — UI crash en Inbox (TDZ) — PASS
### Síntoma
En DEV se mostraba el ErrorBoundary: “No se pudo renderizar la vista” con error:
`ReferenceError: Cannot access 'Oe' before initialization` (bundle minificado).

### Causa raíz (alto nivel)
`ConversationView` referenciaba una variable derivada (`isAdmin`) en el dependency array de un `useEffect`
antes de inicializarla, causando un error de **Temporal Dead Zone** en runtime.

### Fix
Se movió la inicialización de `isAdmin` al inicio del componente (antes de cualquier `useEffect` que lo use).

## SAFE OUTBOUND MODE (DEV) — PASS
Regla no negociable: **ALLOWLIST_ONLY** y allowlist efectiva solo 2 números.

Evidencia (SystemConfig en DEV DB):
- `adminWaIds`: `["56982345846"]`
- `testPhoneNumbers`: `["56994830202"]`
- `outboundPolicy`: `ALLOWLIST_ONLY`
- `outboundAllowlist`: `[]/null` (vacío)

## TAREA A — “WhatsApp: digo Hola y responde” — PASS
### Resultado
Al recibir un inbound desde el **testPhoneNumber**, el bot ejecuta Automations → RUN_AGENT → SEND_MESSAGE y envía respuesta real por WhatsApp (sendResult success).

### Evidencia (DEV)
- contact waId: `56994830202`
- conversationId: `cmj7lbtvp000bqr964zl25sa7`
- inbound (waMessageId): `wamid.devtest.1765918922`
  - Message.id: `cmj92j5kv0002vmfkjciqwy6l`
- automationRunLog:
  - id: `cmj92j5nk0004vmfk7ypg8i84` (SUCCESS)
- agentRunLog:
  - id: `cmj92j5q40006vmfkr1t2hfbw` (EXECUTED)
- outbound (CRM Message):
  - Message.id: `cmj92j80m0008vmfkgunrqde6`
  - text: `¡Hola, Ignacio! ¿En qué te puedo ayudar hoy?`
  - sendResult.messageId: `wamid.HBgLNTY5OTQ4MzAyMDIVAgARGBIyMDM3NDgwNTFEQTI3N0M2RTMA`
- outbound log (guardrails/idempotencia):
  - OutboundMessageLog.id: `cmj92j819000avmfk88xtxec9`
  - blockedReason: `null`

### Causa raíz (cuando fallaba)
- El AgentRuntime estaba recibiendo JSON válido pero con shape incorrecto (ej: `commands[].parameters.text` en vez de `commands[].text`), y/o faltaban campos requeridos.
- Resultado: AutomationRun quedaba en ERROR y no se enviaba mensaje (se veía “muerto”).

### Fix aplicado
- Normalización de salida del agente:
  - acepta wrapper `parameters` y lo aplana al comando
  - completa IDs/flags obvios desde contexto (conversationId/contactId/channel/dedupeKey)
  - retry con instrucción cuando el schema/semántica no calza
- Validación semántica: `SEND_MESSAGE` requiere `text` cuando `type=SESSION_TEXT` (evita envíos vacíos).

## TAREA B — DEV QA “click-only” (UI) — PASS (build + endpoints)
Lo verás al revisar visualmente:
- Inbox / Inactivos: sin pantalla blanca (hay `ErrorBoundary` para no quedar muerto ante errores de datos).
- Configuración: tabs `Workspace / Usuarios / Números WhatsApp / Programs / Automations / Logs`.
- Simulador: corre scenario “Loop comuna/ciudad (RM)”.
- Agenda: carga sin romper.

Verificación técnica mínima realizada (sin UI manual):
- `GET /` sirve HTML y bundle JS.
- `GET /api/health` OK con gitSha.
- `GET /api/conversations` devuelve `401` sin token (route existe).
