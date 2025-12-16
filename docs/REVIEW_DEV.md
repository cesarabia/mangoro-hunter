# Review Pack — DEV (`hunter.mangoro.app`)

Este checklist es **solo “click y revisar”** (sin terminal). DEV corre en **SAFE OUTBOUND MODE (ALLOWLIST_ONLY)** para no molestar candidatos reales.

## Links (DEV)
- Inbox (SPA): `https://hunter.mangoro.app/`
- Health: `https://hunter.mangoro.app/api/health`

## Números autorizados (NO usar otros)
- Admin: `56982345846`
- Test: `56994830202`

## Checklist (PASS/FAIL)
1) Abrir `https://hunter.mangoro.app/` y loguearse.
2) Ver en la topbar:
   - botones `Inbox`, `Inactivos`, `Simulador`, `Agenda`, `Configuración`, `Salir`
   - badge **SAFE MODE: allowlist only**
   - **version stamp** visible (git sha/fecha-hora)
3) Ir a `Inbox`:
   - carga listado de conversaciones (sin pantalla blanca)
   - abrir una conversación → **no hay crash** (no aparece error tipo `.map`).
4) Dentro de una conversación:
   - timeline carga mensajes (si hay)
   - se puede escribir en el input sin romper UI
5) Ir a `Configuración` y validar tabs:
   - `Workspace`, `Usuarios`, `Números WhatsApp`, `Programs`, `Automations`, `Logs`
6) En `Configuración → Workspace → SAFE OUTBOUND MODE`:
   - Policy = `ALLOWLIST_ONLY`
   - “Effective allowlist” muestra **solo** los 2 números autorizados (admin + test)
7) (Prueba segura) Validar bloqueo sin molestar gente real:
   - Cambiar Policy a `BLOCK_ALL` → `Guardar`
   - Volver a `Inbox` y en la conversación de `56994830202` intentar enviar un mensaje de prueba
   - Debe quedar **bloqueado** (no sale a WhatsApp real) y se ve el error de envío
   - Volver a `Configuración` y dejar Policy de nuevo en `ALLOWLIST_ONLY` → `Guardar`
8) Ir a `Simulador`:
   - crear sesión nueva
   - correr scenario “Loop comuna/ciudad (RM)” → debe terminar OK y mostrar transcript
9) Ir a `Configuración → Logs`:
   - abrir el último `Agent Run` y ver `InputContext / Commands / Execution Results`
   - ver `Outbound messages` (blockedReason/dedupeKey cuando corresponda)
10) Ir a `Agenda`:
   - carga reservas (si existen) sin crash.
11) Abrir `https://hunter.mangoro.app/api/health`:
   - `ok: true`
   - incluye `gitSha` y `startedAt` (version stamp server)

## Red flags (si ves esto, reportar)
- Pantalla blanca o aparece “No se pudo renderizar la vista”.
- Error en consola/UI tipo “Rendered more hooks…” o “change in the order of Hooks”.
- Crash al abrir conversación: “Cannot read properties of undefined (reading 'map')”.
- SAFE MODE no aparece en topbar o Policy permite `ALLOW_ALL` en DEV.
- Simulator indica que “enviaría” WhatsApp real (debe ser **NullTransport**).
- Aparecen números nuevos/sintéticos (solo deben usarse `56982345846` y `56994830202` para pruebas).

