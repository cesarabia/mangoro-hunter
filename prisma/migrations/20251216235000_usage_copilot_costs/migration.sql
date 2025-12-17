-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN "openAiModelPricing" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "whatsappPricing" TEXT;

-- AlterTable
ALTER TABLE "OutboundMessageLog" ADD COLUMN "templateName" TEXT;

-- CreateTable
CREATE TABLE "CopilotRunLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT,
    "conversationId" TEXT,
    "view" TEXT,
    "inputText" TEXT NOT NULL,
    "responseText" TEXT,
    "actionsJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CopilotRunLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CopilotRunLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CopilotRunLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AiUsageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "actor" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "agentRunId" TEXT,
    "copilotRunId" TEXT,
    "conversationId" TEXT,
    "programId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AiUsageLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AiUsageLog_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRunLog" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiUsageLog_copilotRunId_fkey" FOREIGN KEY ("copilotRunId") REFERENCES "CopilotRunLog" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiUsageLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AiUsageLog_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScenarioRunLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'sandbox',
    "scenarioId" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "sessionConversationId" TEXT,
    "triggeredByUserId" TEXT,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScenarioRunLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ScenarioRunLog_sessionConversationId_fkey" FOREIGN KEY ("sessionConversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ScenarioRunLog_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CopilotRunLog_workspaceId_idx" ON "CopilotRunLog"("workspaceId");
CREATE INDEX "CopilotRunLog_conversationId_idx" ON "CopilotRunLog"("conversationId");
CREATE INDEX "CopilotRunLog_createdAt_idx" ON "CopilotRunLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiUsageLog_workspaceId_idx" ON "AiUsageLog"("workspaceId");
CREATE INDEX "AiUsageLog_createdAt_idx" ON "AiUsageLog"("createdAt");
CREATE INDEX "AiUsageLog_programId_idx" ON "AiUsageLog"("programId");
CREATE INDEX "AiUsageLog_conversationId_idx" ON "AiUsageLog"("conversationId");
CREATE INDEX "AiUsageLog_actor_idx" ON "AiUsageLog"("actor");
CREATE INDEX "AiUsageLog_model_idx" ON "AiUsageLog"("model");

-- CreateIndex
CREATE INDEX "ScenarioRunLog_workspaceId_idx" ON "ScenarioRunLog"("workspaceId");
CREATE INDEX "ScenarioRunLog_scenarioId_idx" ON "ScenarioRunLog"("scenarioId");
CREATE INDEX "ScenarioRunLog_createdAt_idx" ON "ScenarioRunLog"("createdAt");

