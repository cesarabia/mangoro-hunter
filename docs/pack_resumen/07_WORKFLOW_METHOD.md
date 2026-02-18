# PACK_RESUMEN - Workflow Method (Codex)

## Purpose
Define the working method used to change the platform safely, with evidence and no data loss.

## Non-negotiables
- Never delete data (archive-only).
- SAFE MODE in DEV is allowlist-only by default.
- Any visible feature must have logs + smoke scenario + Release Notes update.
- Prefer safety > consistency > UX > features.

## Iteration cycle
1) Define deliverables + click-only acceptance.
2) Implement (additive migrations only).
3) Add/update smoke scenarios + asserts.
4) Run build/tests locally.
5) Deploy DEV and verify /api/health.
6) QA in UI (Ayuda/QA -> Run Smoke Scenarios, Logs, DoD).
7) Update Release Notes (DEV) with evidence.
8) Validate Review Pack zip download.

## Roles (sequential, not parallel)
- Implementer: code, migrations, endpoints.
- QA: scenarios, guardrails, regressions.
- Docs: update PLATFORM_DESIGN/STATUS/WORKFLOW as needed.

## Simulation vs real
- Use Simulator/NullTransport for QA.
- WhatsApp real only for allowlisted numbers in DEV.

## Evidence standard
- Scenario PASS/FAIL in QA.
- Logs (Agent/Automation/Outbound/Copilot) referenced in Release Notes.
- Review Pack zip contains docs + logs + scenario results.

