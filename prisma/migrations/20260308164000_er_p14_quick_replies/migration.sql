-- ER-P14.1: Quick replies catálogo por workspace (mensajes listos manuales)
CREATE TABLE IF NOT EXISTS "QuickReply" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "jobRole" TEXT NOT NULL,
  "stageKey" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "archivedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "QuickReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "QuickReply_workspaceId_idx" ON "QuickReply"("workspaceId");
CREATE INDEX IF NOT EXISTS "QuickReply_workspaceId_jobRole_idx" ON "QuickReply"("workspaceId", "jobRole");
CREATE INDEX IF NOT EXISTS "QuickReply_workspaceId_stageKey_idx" ON "QuickReply"("workspaceId", "stageKey");
