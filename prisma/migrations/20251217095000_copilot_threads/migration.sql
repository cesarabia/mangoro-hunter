-- CreateTable
CREATE TABLE "CopilotThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT,
    "title" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CopilotThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CopilotThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "CopilotRunLog" ADD COLUMN "threadId" TEXT;

-- CreateIndex
CREATE INDEX "CopilotThread_workspaceId_idx" ON "CopilotThread"("workspaceId");
CREATE INDEX "CopilotThread_userId_idx" ON "CopilotThread"("userId");
CREATE INDEX "CopilotThread_createdAt_idx" ON "CopilotThread"("createdAt");
CREATE INDEX "CopilotRunLog_threadId_idx" ON "CopilotRunLog"("threadId");

