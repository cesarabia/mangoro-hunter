# PACK_RESUMEN - Architecture

## High-level components
- Frontend (React + Vite): Inbox, Config, Simulator, QA/Review, Copilot.
- Backend (Fastify + Prisma): API, WhatsApp webhook, Agent runtime, Automations, Logs, Review Pack.
- Database (Prisma): Workspaces, Programs, PhoneLines, Conversations, Logs, Scenarios, Usage.
- External services: WhatsApp Cloud API, OpenAI (LLM), optional connectors (Medilink, etc.).

## Logical flow (text diagram)

INBOUND WHATSAPP
  -> WhatsApp webhook (/webhook/whatsapp)
  -> phone line routing (by waPhoneNumberId)
  -> dedupe by waMessageId
  -> Automation engine (INBOUND_MESSAGE)
  -> AgentRuntime (LLM -> Commands JSON)
  -> CommandExecutor (guardrails + persistence)
  -> Outbound (WhatsApp) or in-app notes
  -> Logs (AgentRunLog, AutomationRunLog, OutboundMessageLog)

SIMULATOR / REPLAY
  -> /api/simulate/run (NullTransport)
  -> same Automations + AgentRuntime + CommandExecutor
  -> Scenario assertions -> ScenarioRunLog

COPILOT (internal)
  -> /api/copilot
  -> navigation + explanations + (optional) action proposals with confirm
  -> CopilotRunLog + CopilotThread

## Core runtime modules
- AgentRuntime: builds minimal context, calls LLM, returns Commands list.
- CommandSchema: strict zod schema for commands.
- CommandExecutor: validates, applies guardrails (SAFE MODE, 24h window, dedupe), persists.
- Tools: deterministic utilities (normalize text, resolve location, validate RUT, list cases, etc.).
- Automations: deterministic rule engine that triggers RUN_AGENT and other actions.

## Data model (core entities)
- Workspace: tenant boundary, config, program defaults per persona, stages.
- PhoneLine: WhatsApp line; inbound routing by waPhoneNumberId.
- Program: agent instructions, knowledge pack, tools permissions.
- Conversation: messages, programId, stageSlug, conversationKind (CLIENT/STAFF/PARTNER).
- Logs: AgentRunLog, AutomationRunLog, OutboundMessageLog, CopilotRunLog, NotificationLog.

## Guardrails and safety
- SAFE OUTBOUND MODE (DEV allowlist-only): blocks non-allowlisted outbound.
- WhatsApp 24h window enforcement: template-only outside window.
- Dedupe: inbound by waMessageId, outbound by dedupeKey + anti-loop.
- Archive-only: no deletes.

## Where to look in code
- Backend runtime: backend/src/services/agent/*
- WhatsApp inbound/outbound: backend/src/services/whatsappInboundService.ts, whatsappMessageService.ts
- Automations: backend/src/services/automationRunnerService.ts
- Config + SAFE MODE: backend/src/services/configService.ts
- Simulator/scenarios: backend/src/services/simulate/* and backend/src/routes/simulate.ts
- Frontend UI: frontend/src/pages/*, frontend/src/components/*

