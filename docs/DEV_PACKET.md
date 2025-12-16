# DEV_PACKET — hunter.mangoro.app (Owner Review Mode)

Este es el **único** archivo que el Owner necesita para revisar DEV (sin terminal).

## Build stamp (DEV)
- `gitSha`: **PENDIENTE** (ver badge en la topbar o `GET /api/health`)
- `startedAt`: **PENDIENTE** (ver badge en la topbar o `GET /api/health`)

## Restricción crítica (SAFE OUTBOUND MODE)
- DEV debe operar en **ALLOWLIST_ONLY**.
- Allowlist efectiva autorizada (solo pruebas):
  - Admin: `56982345846`
  - Test: `56994830202`

## Qué cambió en esta iteración (UX + Review Mode)
- Inbox/Chat: vista **chat-first** con botón `Detalles` (evita encabezados largos); mensajes/adjuntos **wrap** (sin scroll horizontal).
- Program vs Modo: se removió el selector “Modo del candidato” de la UI; el **Program** es la única fuente visible.
- Nueva pantalla `Ayuda / QA` (topbar) con: build/health, SAFE MODE + allowlist, checklist click-only, logs recientes y botón `Run Smoke Scenarios` (sandbox / NullTransport).
- Logs: nuevo endpoint `GET /api/logs/outbound-messages` para ver bloqueos (blockedReason) y dedupe.

## QA DEV (click-only) — PASS/FAIL
Revisar desde `https://hunter.mangoro.app`:
- [ ] Topbar muestra `SAFE MODE` + build stamp
- [ ] `Ayuda / QA` carga (health + allowlist visibles)
- [ ] Inbox abre conversación y el chat se ve (sin scroll horizontal / sin crash)
- [ ] `Detalles` muestra Program/Status/Stage y NO_CONTACTAR sin errores
- [ ] Inactivos abre
- [ ] Simulador abre y `Run Smoke Scenarios` termina con PASS (NullTransport)
- [ ] Logs en `Ayuda / QA` muestran Agent Runs + Outbound (blockedReason) + Automation Runs
- [ ] Agenda abre sin romper

## Evidencia mínima esperada (en UI)
- En `Ayuda / QA`:
  - `Build / Health`: `ok: true`, `gitSha`, `startedAt`
  - `SAFE MODE`: `Policy: ALLOWLIST_ONLY` y allowlist efectiva = **solo** 2 números (admin/test)
  - `Logs recientes → Outbound`: si hay bloqueos, se ven con `blockedReason`

## Riesgos / pendientes
- Si SAFE MODE muestra allowlist con más números, **no probar WhatsApp** hasta corregirlo (riesgo de molestar candidatos reales).
- Simulator/Logs dependen de permisos `ADMIN/OWNER` y del workspace seleccionado.

## Docs tocados en esta iteración
- `docs/DEV_PACKET.md`
