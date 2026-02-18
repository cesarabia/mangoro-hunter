# PACK_RESUMEN - Test Status

## Automated tests (backend)
- Uses Node's built-in test runner against compiled JS:
  - `cd backend && npm test`
  - This runs `npm run build` and then `node --test dist/**/*.test.js`
- Current test files (source):
  - backend/src/services/agent/guardrails.test.ts
  - backend/src/services/agent/agentResponseRepair.test.ts
  - backend/src/services/agent/semanticValidation.test.ts
  - backend/src/services/agent/tools.test.ts
  - backend/src/services/modelResolutionService.test.ts

## Frontend tests
- No automated frontend tests in repo.
- Validation relies on build + manual QA in DEV.

## Scenario runner (QA)
- Sandbox/NullTransport scenarios in backend:
  - backend/src/services/simulate/scenarios.ts
- Executed from UI (Ayuda/QA) or API:
  - `/api/simulate/scenarios/run`
- Scenarios provide PASS/FAIL with assertions.

## Smoke checks
- `/api/health` for build info.
- Release Notes (DEV) tracks PASS/FAIL for scenarios and DoD checks.

## Gaps
- No CI pipeline in repo.
- No snapshot/e2e tests for frontend.

