# PACK_RESUMEN - Risks and Technical Debt

## Product risks
- Misconfiguration risk: multi-tenant and program menus require correct config; wrong defaults lead to wrong program responses.
- LLM variability: agent behavior depends on prompts; no strict guarantee of output shape without repair.
- Staff notifications: blocked by SAFE MODE or 24h window; requires clear fallback.

## Technical debt / fragility
- Database is SQLite by default in DEV; not suited for high concurrency in prod without migration.
- Limited frontend tests (no unit/e2e suite in repo). Reliance on manual smoke scenarios.
- High coupling between runtime and specific routes; limited module boundaries for reuse.
- Prompt config stored in DB but not versioned; change history relies on config logs.
- Some flows rely on heuristics (e.g., persona routing) and may need more policy enforcement.

## Operational risks
- Missing robust job queue for heavy tasks (OCR, file parsing, large LLM usage).
- No built-in rate limit policy for all endpoints (some routes are protected, but no global WAF).
- Secrets management depends on env + DB; lacks centralized vault.

## Security risks
- If SAFE MODE is disabled by mistake in DEV, outbound could reach real numbers.
- Need to ensure all outbound paths enforce allowlist and 24h window.
- Webhook security depends on Meta signature verification (ensure this is enforced everywhere).

## Observability gaps
- Log volume may grow without retention policy.
- Release Notes and Review Pack depend on UI endpoints; if UI is down, access is limited.

## Scalability gaps
- Single-node service; no queue or horizontal scaling strategy implemented.
- No caching layer for expensive LLM calls or repetitive queries.

