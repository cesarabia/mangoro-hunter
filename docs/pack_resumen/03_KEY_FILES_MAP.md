# PACK_RESUMEN - Key Files Map (Top 30)

1) prisma/schema.prisma - Core data model (workspace, programs, conversations, logs).
2) backend/src/server.ts - Fastify bootstrap and route registration.
3) backend/src/routes/whatsappWebhook.ts - WhatsApp inbound webhook entrypoint.
4) backend/src/services/whatsappInboundService.ts - Inbound handling, persona routing, program selection.
5) backend/src/services/whatsappMessageService.ts - Outbound send + 24h window enforcement.
6) backend/src/services/phoneLineRoutingService.ts - Resolve workspace/phone line by waPhoneNumberId.
7) backend/src/services/automationRunnerService.ts - Deterministic automation engine.
8) backend/src/services/agent/agentRuntimeService.ts - LLM runtime (context -> commands).
9) backend/src/services/agent/commandExecutorService.ts - Command validation + execution + guardrails.
10) backend/src/services/agent/commandSchema.ts - Strict command schema (zod).
11) backend/src/services/agent/guardrails.ts - SAFE MODE, dedupe, anti-loop, 24h window.
12) backend/src/services/agent/tools.ts - Deterministic tools (normalize, resolve, list cases, etc.).
13) backend/src/services/agent/agentResponseRepair.ts - Repairs invalid agent outputs.
14) backend/src/services/configService.ts - Workspace config, SAFE MODE, allowlist.
15) backend/src/services/modelResolutionService.ts - Model override/alias resolution.
16) backend/src/services/openAiChatCompletionService.ts - OpenAI call + fallback logic.
17) backend/src/routes/automations.ts - CRUD automations + run logs.
18) backend/src/routes/programs.ts - Programs CRUD + prompt builder + knowledge.
19) backend/src/routes/phoneLines.ts - PhoneLines CRUD + conflict handling.
20) backend/src/routes/conversations.ts - Conversation list, detail, stage updates.
21) backend/src/routes/copilot.ts - Copilot chat, logs, and actions.
22) backend/src/routes/simulate.ts - Simulator + scenario runner endpoints.
23) backend/src/routes/logs.ts - Logs API for Agent/Automation/Outbound/Copilot.
24) backend/src/routes/reviewPack.ts - Review pack zip generation.
25) backend/src/services/simulate/scenarios.ts - Smoke scenarios + assertions.
26) frontend/src/App.tsx - Route shell + topbar + global state.
27) frontend/src/pages/InboxPage.tsx - Inbox layout and routing.
28) frontend/src/components/ConversationView.tsx - Chat view + details + staff quick actions.
29) frontend/src/pages/ConfigPage.tsx - Config UI (workspace, users, phone lines, programs, automations).
30) frontend/src/pages/ReviewPage.tsx - QA/Owner Review, scenarios, release notes.

