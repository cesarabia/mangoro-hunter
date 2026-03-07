-- ER-P1: debounce persistente inbound + filtros de contexto + workspace assets

ALTER TABLE "Conversation" ADD COLUMN "pendingInboundAiRunAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "pendingInboundAiRunReason" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "pendingInboundAiRunVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Conversation" ADD COLUMN "aiRunInFlight" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "aiRunLockUntil" DATETIME;

ALTER TABLE "Message" ADD COLUMN "isInternalEvent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "OutboundMessageLog" ADD COLUMN "assetId" TEXT;
ALTER TABLE "OutboundMessageLog" ADD COLUMN "assetSlug" TEXT;

CREATE TABLE "WorkspaceAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "audience" TEXT NOT NULL DEFAULT 'PUBLIC',
    "mimeType" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT,
    "storagePath" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkspaceAsset_publicId_key" ON "WorkspaceAsset"("publicId");
CREATE UNIQUE INDEX "WorkspaceAsset_workspaceId_slug_key" ON "WorkspaceAsset"("workspaceId", "slug");
CREATE INDEX "WorkspaceAsset_workspaceId_audience_archivedAt_idx" ON "WorkspaceAsset"("workspaceId", "audience", "archivedAt");
CREATE INDEX "WorkspaceAsset_createdAt_idx" ON "WorkspaceAsset"("createdAt");

CREATE INDEX "Conversation_pendingInboundAiRunAt_idx" ON "Conversation"("pendingInboundAiRunAt");
CREATE INDEX "Conversation_aiRunInFlight_aiRunLockUntil_idx" ON "Conversation"("aiRunInFlight", "aiRunLockUntil");
CREATE INDEX "OutboundMessageLog_assetId_idx" ON "OutboundMessageLog"("assetId");

PRAGMA foreign_keys=OFF;
CREATE TABLE "new_OutboundMessageLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "conversationId" TEXT NOT NULL,
    "relatedConversationId" TEXT,
    "assetId" TEXT,
    "assetSlug" TEXT,
    "agentRunId" TEXT,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "templateName" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "blockedReason" TEXT,
    "waMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboundMessageLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OutboundMessageLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OutboundMessageLog_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRunLog" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "OutboundMessageLog_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "WorkspaceAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_OutboundMessageLog" (
    "id", "workspaceId", "conversationId", "relatedConversationId", "agentRunId", "channel", "type", "templateName", "dedupeKey", "textHash", "blockedReason", "waMessageId", "createdAt"
)
SELECT
    "id", "workspaceId", "conversationId", "relatedConversationId", "agentRunId", "channel", "type", "templateName", "dedupeKey", "textHash", "blockedReason", "waMessageId", "createdAt"
FROM "OutboundMessageLog";

DROP TABLE "OutboundMessageLog";
ALTER TABLE "new_OutboundMessageLog" RENAME TO "OutboundMessageLog";

CREATE INDEX "OutboundMessageLog_conversationId_idx" ON "OutboundMessageLog"("conversationId");
CREATE INDEX "OutboundMessageLog_relatedConversationId_idx" ON "OutboundMessageLog"("relatedConversationId");
CREATE INDEX "OutboundMessageLog_workspaceId_idx" ON "OutboundMessageLog"("workspaceId");
CREATE INDEX "OutboundMessageLog_createdAt_idx" ON "OutboundMessageLog"("createdAt");
CREATE INDEX "OutboundMessageLog_dedupeKey_idx" ON "OutboundMessageLog"("dedupeKey");
CREATE INDEX "OutboundMessageLog_waMessageId_idx" ON "OutboundMessageLog"("waMessageId");
CREATE INDEX "OutboundMessageLog_assetId_idx" ON "OutboundMessageLog"("assetId");
PRAGMA foreign_keys=ON;
