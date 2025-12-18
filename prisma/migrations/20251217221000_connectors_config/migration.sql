-- Add connector configuration fields (safe, additive).
ALTER TABLE "WorkspaceConnector" ADD COLUMN "baseUrl" TEXT;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "authType" TEXT;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "authHeaderName" TEXT;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "authToken" TEXT;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "allowedDomainsJson" TEXT;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "timeoutMs" INTEGER;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "maxPayloadBytes" INTEGER;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "lastTestedAt" DATETIME;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "lastTestOk" BOOLEAN;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "lastTestError" TEXT;

-- Connector call logs (audit, archive-only).
CREATE TABLE "ConnectorCallLog" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "connectorId" TEXT NOT NULL,
  "userId" TEXT,
  "kind" TEXT NOT NULL,
  "action" TEXT,
  "requestJson" TEXT,
  "responseJson" TEXT,
  "ok" BOOLEAN NOT NULL DEFAULT false,
  "error" TEXT,
  "statusCode" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorCallLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConnectorCallLog_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "WorkspaceConnector" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ConnectorCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ConnectorCallLog_workspaceId_idx" ON "ConnectorCallLog"("workspaceId");
CREATE INDEX "ConnectorCallLog_connectorId_idx" ON "ConnectorCallLog"("connectorId");
CREATE INDEX "ConnectorCallLog_createdAt_idx" ON "ConnectorCallLog"("createdAt");

