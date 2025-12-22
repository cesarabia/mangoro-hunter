-- CreateTable
CREATE TABLE "InAppNotification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "dataJson" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "readAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InAppNotification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InAppNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InAppNotification_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "InAppNotification_workspaceId_userId_dedupeKey_key" ON "InAppNotification"("workspaceId", "userId", "dedupeKey");
CREATE INDEX "InAppNotification_workspaceId_idx" ON "InAppNotification"("workspaceId");
CREATE INDEX "InAppNotification_userId_idx" ON "InAppNotification"("userId");
CREATE INDEX "InAppNotification_conversationId_idx" ON "InAppNotification"("conversationId");
CREATE INDEX "InAppNotification_createdAt_idx" ON "InAppNotification"("createdAt");

