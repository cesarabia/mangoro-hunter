-- ER-P4: Postulación flow state + OP review email/log safety

ALTER TABLE "Workspace" ADD COLUMN "reviewEmailTo" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "reviewEmailFrom" TEXT;

ALTER TABLE "Conversation" ADD COLUMN "applicationDataJson" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "opReviewSummarySentAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "opReviewEmailSentAt" DATETIME;

CREATE TABLE "EmailOutboundLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "conversationId" TEXT,
    "channel" TEXT NOT NULL DEFAULT 'EMAIL',
    "fromEmail" TEXT,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyPreview" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    CONSTRAINT "EmailOutboundLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EmailOutboundLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "EmailOutboundLog_workspaceId_idx" ON "EmailOutboundLog"("workspaceId");
CREATE INDEX "EmailOutboundLog_conversationId_idx" ON "EmailOutboundLog"("conversationId");
CREATE INDEX "EmailOutboundLog_createdAt_idx" ON "EmailOutboundLog"("createdAt");
CREATE INDEX "EmailOutboundLog_status_idx" ON "EmailOutboundLog"("status");
