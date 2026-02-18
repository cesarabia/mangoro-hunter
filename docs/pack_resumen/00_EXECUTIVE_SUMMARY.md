# PACK_RESUMEN - Executive Summary

## What it is
Hunter Agent OS is a multi-tenant WhatsApp CRM + automation platform. It runs AI agents ("Programs") that return structured commands, and a backend executes those commands deterministically with guardrails, persistence, and audit logs. The product includes a CRM inbox, Automations, Simulator/Replay/Scenarios, Copilot (internal assistant), and Usage/Cost tracking.

## What it does today (high level)
- Inbound WhatsApp routing by waPhoneNumberId -> workspace + phone line.
- Program-driven agents (recruitment/sales/staff/partner flows) using a Command schema.
- Automations (deterministic rules) trigger RUN_AGENT and other actions.
- Guardrails: SAFE MODE (allowlist-only), 24h WhatsApp window, dedupe, anti-loop.
- Observability: AgentRunLog, AutomationRunLog, Outbound logs, Copilot logs, Scenario runner.
- Multi-workspace with roles (OWNER/ADMIN/MEMBER/VIEWER) + invites.
- Staff Mode + reply-to mapping for WhatsApp staff notifications.

## Current state
- DEV environment active at https://hunter.mangoro.app
- SAFE OUTBOUND MODE in DEV = ALLOWLIST_ONLY.
- V2.2/V2.3 features exist: stage definitions, staff notifications, multi-persona routing, program menus, simulator/scenarios, review pack download.
- Frontend: React (Vite). Backend: Fastify + Prisma (SQLite in DEV by default).

## What it is for
- Build reusable agent workflows (recruitment/sales/operations) for multiple clients in one platform.
- Provide a safe, auditable AI-first runtime where decisions are made by the agent and execution is deterministic.
- Enable fast iteration with scenarios, logs, and release notes without affecting real WhatsApp users.

## Notable constraints
- Never delete data (archive-only).
- SAFE MODE must block outbound to non-allowlisted numbers in DEV.
- WhatsApp 24h window must be respected (template vs session text).

