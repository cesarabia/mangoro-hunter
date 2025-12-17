-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN "outboundAllowAllUntil" DATETIME;

-- CreateTable
CREATE TABLE "ConfigChangeLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConfigChangeLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ConfigChangeLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ConfigChangeLog_workspaceId_idx" ON "ConfigChangeLog"("workspaceId");
CREATE INDEX "ConfigChangeLog_createdAt_idx" ON "ConfigChangeLog"("createdAt");

