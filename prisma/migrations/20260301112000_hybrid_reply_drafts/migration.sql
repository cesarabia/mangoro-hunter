-- Workspace hybrid approval settings (additive, safe)
ALTER TABLE "Workspace" ADD COLUMN "hybridApprovalEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Workspace" ADD COLUMN "hybridApprovalAdminWaId" TEXT;

-- Drafts for hybrid/manual approval flow
CREATE TABLE "HybridReplyDraft" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL DEFAULT 'default',
  "conversationId" TEXT NOT NULL,
  "inboundMessageId" TEXT,
  "agentRunId" TEXT,
  "dedupeKey" TEXT,
  "targetWaId" TEXT NOT NULL,
  "proposedText" TEXT NOT NULL,
  "finalText" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "approvedByWaId" TEXT,
  "approvedAt" DATETIME,
  "cancelledByWaId" TEXT,
  "cancelledAt" DATETIME,
  "sentWaMessageId" TEXT,
  "sentAt" DATETIME,
  "error" TEXT,
  "metadataJson" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "HybridReplyDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "HybridReplyDraft_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "HybridReplyDraft_workspaceId_idx" ON "HybridReplyDraft"("workspaceId");
CREATE INDEX "HybridReplyDraft_conversationId_idx" ON "HybridReplyDraft"("conversationId");
CREATE INDEX "HybridReplyDraft_inboundMessageId_idx" ON "HybridReplyDraft"("inboundMessageId");
CREATE INDEX "HybridReplyDraft_status_idx" ON "HybridReplyDraft"("status");
CREATE INDEX "HybridReplyDraft_createdAt_idx" ON "HybridReplyDraft"("createdAt");
