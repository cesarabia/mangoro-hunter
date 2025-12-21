-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PhoneLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "phoneE164" TEXT,
    "waPhoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "defaultProgramId" TEXT,
    "inboundMode" TEXT NOT NULL DEFAULT 'DEFAULT',
    "programMenuIdsJson" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "needsAttention" BOOLEAN NOT NULL DEFAULT false,
    "lastInboundAt" DATETIME,
    "lastOutboundAt" DATETIME,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PhoneLine_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PhoneLine_defaultProgramId_fkey" FOREIGN KEY ("defaultProgramId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PhoneLine" ("alias", "archivedAt", "createdAt", "defaultProgramId", "id", "isActive", "lastInboundAt", "lastOutboundAt", "needsAttention", "phoneE164", "updatedAt", "waPhoneNumberId", "wabaId", "workspaceId") SELECT "alias", "archivedAt", "createdAt", "defaultProgramId", "id", "isActive", "lastInboundAt", "lastOutboundAt", "needsAttention", "phoneE164", "updatedAt", "waPhoneNumberId", "wabaId", "workspaceId" FROM "PhoneLine";
DROP TABLE "PhoneLine";
ALTER TABLE "new_PhoneLine" RENAME TO "PhoneLine";
CREATE INDEX "PhoneLine_workspaceId_idx" ON "PhoneLine"("workspaceId");
CREATE UNIQUE INDEX "PhoneLine_workspaceId_waPhoneNumberId_key" ON "PhoneLine"("workspaceId", "waPhoneNumberId");
CREATE UNIQUE INDEX "PhoneLine_workspaceId_phoneE164_key" ON "PhoneLine"("workspaceId", "phoneE164");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
