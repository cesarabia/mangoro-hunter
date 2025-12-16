-- Agent OS v1 core tables (additive, non-destructive).

-- Workspaces (default + sandbox).
CREATE TABLE IF NOT EXISTS "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT OR IGNORE INTO "Workspace" ("id", "name", "isSandbox", "createdAt", "updatedAt")
VALUES ('default', 'Hunter Internal', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT OR IGNORE INTO "Workspace" ("id", "name", "isSandbox", "createdAt", "updatedAt")
VALUES ('sandbox', 'Sandbox', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Memberships (multi-user / per-workspace role).
CREATE TABLE IF NOT EXISTS "Membership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Membership_userId_workspaceId_key" ON "Membership"("userId", "workspaceId");
CREATE INDEX IF NOT EXISTS "Membership_workspaceId_idx" ON "Membership"("workspaceId");

-- Programs (configurable agent prompts).
CREATE TABLE IF NOT EXISTS "Program" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "agentSystemPrompt" TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Program_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "Program_workspaceId_slug_key" ON "Program"("workspaceId", "slug");
CREATE INDEX IF NOT EXISTS "Program_workspaceId_idx" ON "Program"("workspaceId");

-- WhatsApp lines (multi-line routing).
CREATE TABLE IF NOT EXISTS "PhoneLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "phoneE164" TEXT,
    "waPhoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "defaultProgramId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastInboundAt" DATETIME,
    "lastOutboundAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PhoneLine_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PhoneLine_workspaceId_waPhoneNumberId_key" ON "PhoneLine"("workspaceId", "waPhoneNumberId");
CREATE UNIQUE INDEX IF NOT EXISTS "PhoneLine_workspaceId_phoneE164_key" ON "PhoneLine"("workspaceId", "phoneE164");
CREATE INDEX IF NOT EXISTS "PhoneLine_workspaceId_idx" ON "PhoneLine"("workspaceId");

-- Ensure a default PhoneLine record exists for legacy data.
INSERT OR IGNORE INTO "PhoneLine" ("id", "workspaceId", "alias", "phoneE164", "waPhoneNumberId", "wabaId", "defaultProgramId", "isActive", "createdAt", "updatedAt")
SELECT
  'default',
  'default',
  'Default',
  NULL,
  COALESCE((SELECT "whatsappPhoneId" FROM "SystemConfig" WHERE "id" = 1), 'unknown'),
  NULL,
  NULL,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP;

-- Agent Runs + Logs (observability).
CREATE TABLE IF NOT EXISTS "AgentRunLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "conversationId" TEXT,
    "programId" TEXT,
    "phoneLineId" TEXT,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "inputContextJson" TEXT NOT NULL,
    "commandsJson" TEXT,
    "resultsJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRunLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgentRunLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AgentRunLog_workspaceId_idx" ON "AgentRunLog"("workspaceId");
CREATE INDEX IF NOT EXISTS "AgentRunLog_conversationId_idx" ON "AgentRunLog"("conversationId");
CREATE INDEX IF NOT EXISTS "AgentRunLog_createdAt_idx" ON "AgentRunLog"("createdAt");

CREATE TABLE IF NOT EXISTS "ToolCallLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentRunId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "argsJson" TEXT NOT NULL,
    "resultJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ToolCallLog_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRunLog" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "ToolCallLog_agentRunId_idx" ON "ToolCallLog"("agentRunId");

CREATE TABLE IF NOT EXISTS "OutboundMessageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "conversationId" TEXT NOT NULL,
    "agentRunId" TEXT,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "blockedReason" TEXT,
    "waMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboundMessageLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OutboundMessageLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OutboundMessageLog_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRunLog" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "OutboundMessageLog_workspaceId_idx" ON "OutboundMessageLog"("workspaceId");
CREATE INDEX IF NOT EXISTS "OutboundMessageLog_conversationId_idx" ON "OutboundMessageLog"("conversationId");
CREATE INDEX IF NOT EXISTS "OutboundMessageLog_createdAt_idx" ON "OutboundMessageLog"("createdAt");
CREATE INDEX IF NOT EXISTS "OutboundMessageLog_dedupeKey_idx" ON "OutboundMessageLog"("dedupeKey");

CREATE TABLE IF NOT EXISTS "ConversationAskedField" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "askCount" INTEGER NOT NULL DEFAULT 0,
    "lastAskedAt" DATETIME,
    "lastAskedHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ConversationAskedField_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConversationAskedField_conversationId_field_key" ON "ConversationAskedField"("conversationId", "field");
CREATE INDEX IF NOT EXISTS "ConversationAskedField_conversationId_idx" ON "ConversationAskedField"("conversationId");

-- Automations (deterministic runner).
CREATE TABLE IF NOT EXISTS "AutomationRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "trigger" TEXT NOT NULL,
    "scopePhoneLineId" TEXT,
    "scopeProgramId" TEXT,
    "conditionsJson" TEXT NOT NULL,
    "actionsJson" TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutomationRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AutomationRule_workspaceId_idx" ON "AutomationRule"("workspaceId");
CREATE INDEX IF NOT EXISTS "AutomationRule_trigger_idx" ON "AutomationRule"("trigger");
CREATE INDEX IF NOT EXISTS "AutomationRule_priority_idx" ON "AutomationRule"("priority");

CREATE TABLE IF NOT EXISTS "AutomationRunLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "ruleId" TEXT,
    "conversationId" TEXT,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "inputJson" TEXT,
    "outputJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationRunLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AutomationRunLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRunLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AutomationRunLog_workspaceId_idx" ON "AutomationRunLog"("workspaceId");
CREATE INDEX IF NOT EXISTS "AutomationRunLog_ruleId_idx" ON "AutomationRunLog"("ruleId");
CREATE INDEX IF NOT EXISTS "AutomationRunLog_createdAt_idx" ON "AutomationRunLog"("createdAt");

-- Contact: workspace + structured profile fields + merge/archival metadata.
ALTER TABLE "Contact" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Contact" ADD COLUMN "email" TEXT;
ALTER TABLE "Contact" ADD COLUMN "rut" TEXT;
ALTER TABLE "Contact" ADD COLUMN "comuna" TEXT;
ALTER TABLE "Contact" ADD COLUMN "ciudad" TEXT;
ALTER TABLE "Contact" ADD COLUMN "region" TEXT;
ALTER TABLE "Contact" ADD COLUMN "experienceYears" INTEGER;
ALTER TABLE "Contact" ADD COLUMN "terrainExperience" BOOLEAN;
ALTER TABLE "Contact" ADD COLUMN "availabilityText" TEXT;
ALTER TABLE "Contact" ADD COLUMN "mergedIntoContactId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "mergedAt" DATETIME;
ALTER TABLE "Contact" ADD COLUMN "mergedReason" TEXT;
ALTER TABLE "Contact" ADD COLUMN "archivedAt" DATETIME;
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_idx" ON "Contact"("workspaceId");

-- Conversation: workspace + phoneLine + program + replay metadata.
ALTER TABLE "Conversation" ADD COLUMN "workspaceId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Conversation" ADD COLUMN "phoneLineId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Conversation" ADD COLUMN "programId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "sandboxSourceConversationId" TEXT;
CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_idx" ON "Conversation"("workspaceId");
CREATE INDEX IF NOT EXISTS "Conversation_phoneLineId_idx" ON "Conversation"("phoneLineId");
CREATE INDEX IF NOT EXISTS "Conversation_programId_idx" ON "Conversation"("programId");

