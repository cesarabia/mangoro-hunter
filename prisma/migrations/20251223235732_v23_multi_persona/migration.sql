-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "activePersonaKind" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "activePersonaUntilAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "availabilityConfirmedAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "availabilityParsedJson" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "availabilityRaw" TEXT;

-- AlterTable
ALTER TABLE "Membership" ADD COLUMN "allowedPersonaKindsJson" TEXT;
ALTER TABLE "Membership" ADD COLUMN "staffWhatsAppExtraE164sJson" TEXT;

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "sourceConversationId" TEXT NOT NULL,
    "targetConversationId" TEXT,
    "targetKind" TEXT NOT NULL,
    "targetE164" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "templateText" TEXT,
    "renderedText" TEXT,
    "varsJson" TEXT,
    "blockedReason" TEXT,
    "waMessageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" DATETIME,
    CONSTRAINT "NotificationLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NotificationLog_sourceConversationId_fkey" FOREIGN KEY ("sourceConversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NotificationLog_targetConversationId_fkey" FOREIGN KEY ("targetConversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "ssclinicalNurseLeaderEmail" TEXT,
    "staffDefaultProgramId" TEXT,
    "clientDefaultProgramId" TEXT,
    "partnerDefaultProgramId" TEXT,
    "allowPersonaSwitchByWhatsApp" BOOLEAN NOT NULL DEFAULT true,
    "personaSwitchTtlMinutes" INTEGER NOT NULL DEFAULT 360,
    "staffProgramMenuIdsJson" TEXT,
    "clientProgramMenuIdsJson" TEXT,
    "partnerProgramMenuIdsJson" TEXT,
    "partnerPhoneE164sJson" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Workspace_staffDefaultProgramId_fkey" FOREIGN KEY ("staffDefaultProgramId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Workspace_clientDefaultProgramId_fkey" FOREIGN KEY ("clientDefaultProgramId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Workspace_partnerDefaultProgramId_fkey" FOREIGN KEY ("partnerDefaultProgramId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Workspace" ("archivedAt", "createdAt", "id", "isSandbox", "name", "ssclinicalNurseLeaderEmail", "staffDefaultProgramId", "updatedAt") SELECT "archivedAt", "createdAt", "id", "isSandbox", "name", "ssclinicalNurseLeaderEmail", "staffDefaultProgramId", "updatedAt" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "NotificationLog_workspaceId_idx" ON "NotificationLog"("workspaceId");

-- CreateIndex
CREATE INDEX "NotificationLog_sourceConversationId_idx" ON "NotificationLog"("sourceConversationId");

-- CreateIndex
CREATE INDEX "NotificationLog_targetConversationId_idx" ON "NotificationLog"("targetConversationId");

-- CreateIndex
CREATE INDEX "NotificationLog_createdAt_idx" ON "NotificationLog"("createdAt");

-- CreateIndex
CREATE INDEX "NotificationLog_dedupeKey_idx" ON "NotificationLog"("dedupeKey");

-- CreateIndex
CREATE INDEX "NotificationLog_waMessageId_idx" ON "NotificationLog"("waMessageId");
