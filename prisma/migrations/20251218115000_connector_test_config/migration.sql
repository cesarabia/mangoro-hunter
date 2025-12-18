-- Connector test configuration (safe, additive).
ALTER TABLE "WorkspaceConnector" ADD COLUMN "testPath" TEXT;
ALTER TABLE "WorkspaceConnector" ADD COLUMN "testMethod" TEXT;

-- Defaults for existing connectors (best-effort).
UPDATE "WorkspaceConnector"
SET "testPath" = '/health', "testMethod" = 'GET'
WHERE ("testPath" IS NULL OR "testPath" = '')
  AND ("testMethod" IS NULL OR "testMethod" = '');

