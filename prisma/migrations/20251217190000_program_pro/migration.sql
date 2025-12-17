-- Add Program profile fields
ALTER TABLE "Program" ADD COLUMN "goal" TEXT;
ALTER TABLE "Program" ADD COLUMN "audience" TEXT;
ALTER TABLE "Program" ADD COLUMN "tone" TEXT;
ALTER TABLE "Program" ADD COLUMN "language" TEXT;

-- Program Knowledge Pack (archive-only)
CREATE TABLE "ProgramKnowledgeAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "programId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "contentText" TEXT,
    "filePath" TEXT,
    "mime" TEXT,
    "tags" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProgramKnowledgeAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProgramKnowledgeAsset_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ProgramKnowledgeAsset_workspaceId_idx" ON "ProgramKnowledgeAsset"("workspaceId");
CREATE INDEX "ProgramKnowledgeAsset_programId_idx" ON "ProgramKnowledgeAsset"("programId");
CREATE INDEX "ProgramKnowledgeAsset_createdAt_idx" ON "ProgramKnowledgeAsset"("createdAt");

-- Workspace Connectors (integrations base)
CREATE TABLE "WorkspaceConnector" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "actionsJson" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceConnector_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WorkspaceConnector_workspaceId_slug_key" ON "WorkspaceConnector"("workspaceId", "slug");
CREATE INDEX "WorkspaceConnector_workspaceId_idx" ON "WorkspaceConnector"("workspaceId");

-- Per-Program connector permissions (whitelist)
CREATE TABLE "ProgramConnectorPermission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "programId" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "allowedActionsJson" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ProgramConnectorPermission_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProgramConnectorPermission_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProgramConnectorPermission_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "WorkspaceConnector" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProgramConnectorPermission_programId_connectorId_key" ON "ProgramConnectorPermission"("programId", "connectorId");
CREATE INDEX "ProgramConnectorPermission_workspaceId_idx" ON "ProgramConnectorPermission"("workspaceId");
CREATE INDEX "ProgramConnectorPermission_programId_idx" ON "ProgramConnectorPermission"("programId");
