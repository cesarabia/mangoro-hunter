# PACK_RESUMEN - Reuse Plan (Lead2Sale)

Goal: identify reusable engine parts for a new product (Lead2Sale) without rebuilding the runtime.

## Reuse candidates (high value)
1) Agent OS runtime
- AgentRuntime + CommandSchema + CommandExecutor (deterministic execution).
- Guardrails: SAFE MODE, 24h WhatsApp window, dedupe, anti-loop.

2) Automations + scenarios
- Automation engine for deterministic triggers.
- Scenario runner (NullTransport) for QA and regression.

3) Observability
- AgentRunLog, AutomationRunLog, OutboundMessageLog, CopilotRunLog.
- Release Notes + Review Pack zip generation.

4) WhatsApp routing + safe outbound
- PhoneLine routing by waPhoneNumberId.
- SAFE MODE allowlist policy and blockedReason tracking.

5) Copilot (internal)
- Navigation helper, diagnostics, action proposals with confirm.

6) Tools layer
- Reusable tools (normalize text, validate IDs, list cases, add note, set stage).

7) Program configuration
- Programs, knowledge assets, connectors per program.
- Program selection menu and persona routing.

## Extraction plan (suggested)
- Package backend runtime into a library or service module:
  - /services/agent, /services/automation, /services/whatsapp*
- Standardize command schema and tool registry as a shared module.
- Keep UI shell (Inbox/Config/Review) and reskin for Lead2Sale.

## What is product-specific
- Program prompts, templates, stage definitions.
- Domain-specific tools (e.g., Medilink, ATS, CRM).

## Suggested reuse order
1) Use existing runtime + guardrails + logs.
2) Clone Program + Automations UI with new defaults.
3) Adapt tools for Lead2Sale (lead scoring, outreach, pipeline).
4) Keep simulator/scenarios as QA foundation.

## Gaps to address for Lead2Sale
- Replace any recruitment-specific copy with neutral, domain-agnostic terms.
- Replace RUT/email extractors with domain-appropriate validators.
- Add integrations (CRM, email, ads) as connectors.

