# DEV_PACKET — hunter.mangoro.app (Owner Review Mode)

Este es el **único** archivo que el Owner necesita para revisar DEV (sin terminal).

## Build stamp (DEV)
- Ver en UI: `Ayuda / QA → Build / Health` (gitSha + startedAt).

## Restricción crítica (SAFE OUTBOUND MODE)
- DEV debe operar en **ALLOWLIST_ONLY**.
- Allowlist efectiva autorizada (solo pruebas):
  - Admin: `56982345846`
  - Test: `56994830202`

## Qué cambió en esta iteración (UX + Review Mode)
- **SAFE MODE hardening (DEV):** bootstrap fuerza `ALLOWLIST_ONLY` y allowlist efectiva solo admin/test (evita molestar números reales).
- **Estados/Stages por workspace:** `WorkspaceStage` (archive-only) + UI para crear/ordenar/activar/desactivar.
- **PhoneLines:** `inboundMode` (`DEFAULT` / `MENU`) + allowlist opcional de Programs para el menú.
- **Scenarios/QA:** escenarios nuevos y DoD auto en PASS (incluye `inbound_program_menu` y `stage_admin_configurable`).
- SSClinical: seed de workspace + Programs base + invites (archive-only) y stage `INTERESADO` auto-asigna nurse leader (si está configurado).

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
- `docs/PLATFORM_DESIGN.md`
- `docs/STATUS.md`
