-- AlterTable
ALTER TABLE "OutboundMessageLog" ADD COLUMN "relatedConversationId" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "phoneLineId" TEXT NOT NULL DEFAULT 'default',
    "programId" TEXT,
    "contactId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "conversationKind" TEXT NOT NULL DEFAULT 'CLIENT',
    "conversationStage" TEXT NOT NULL DEFAULT 'NEW_INTAKE',
    "stageChangedAt" DATETIME,
    "stageReason" TEXT,
    "stageTags" TEXT,
    "archivedAt" DATETIME,
    "archivedSummary" TEXT,
    "sandboxSourceConversationId" TEXT,
    "assignedToId" TEXT,
    "channel" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "aiMode" TEXT NOT NULL DEFAULT 'RECRUIT',
    "aiPaused" BOOLEAN NOT NULL DEFAULT false,
    "interviewDay" TEXT,
    "interviewTime" TEXT,
    "interviewLocation" TEXT,
    "interviewStatus" TEXT,
    "adminLastCandidateWaId" TEXT,
    "adminPendingAction" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Conversation_phoneLineId_fkey" FOREIGN KEY ("phoneLineId") REFERENCES "PhoneLine" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Conversation_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Conversation_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Conversation" ("adminLastCandidateWaId", "adminPendingAction", "aiMode", "aiPaused", "archivedAt", "archivedSummary", "assignedToId", "channel", "contactId", "conversationStage", "createdAt", "id", "interviewDay", "interviewLocation", "interviewStatus", "interviewTime", "isAdmin", "phoneLineId", "programId", "sandboxSourceConversationId", "stageReason", "stageTags", "status", "updatedAt", "workspaceId") SELECT "adminLastCandidateWaId", "adminPendingAction", "aiMode", "aiPaused", "archivedAt", "archivedSummary", "assignedToId", "channel", "contactId", "conversationStage", "createdAt", "id", "interviewDay", "interviewLocation", "interviewStatus", "interviewTime", "isAdmin", "phoneLineId", "programId", "sandboxSourceConversationId", "stageReason", "stageTags", "status", "updatedAt", "workspaceId" FROM "Conversation";
DROP TABLE "Conversation";
ALTER TABLE "new_Conversation" RENAME TO "Conversation";
CREATE INDEX "Conversation_workspaceId_idx" ON "Conversation"("workspaceId");
CREATE INDEX "Conversation_phoneLineId_idx" ON "Conversation"("phoneLineId");
CREATE INDEX "Conversation_programId_idx" ON "Conversation"("programId");
CREATE TABLE "new_Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "isSandbox" BOOLEAN NOT NULL DEFAULT false,
    "ssclinicalNurseLeaderEmail" TEXT,
    "staffDefaultProgramId" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Workspace_staffDefaultProgramId_fkey" FOREIGN KEY ("staffDefaultProgramId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Workspace" ("archivedAt", "createdAt", "id", "isSandbox", "name", "ssclinicalNurseLeaderEmail", "updatedAt") SELECT "archivedAt", "createdAt", "id", "isSandbox", "name", "ssclinicalNurseLeaderEmail", "updatedAt" FROM "Workspace";
DROP TABLE "Workspace";
ALTER TABLE "new_Workspace" RENAME TO "Workspace";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "OutboundMessageLog_relatedConversationId_idx" ON "OutboundMessageLog"("relatedConversationId");

-- CreateIndex
CREATE INDEX "OutboundMessageLog_waMessageId_idx" ON "OutboundMessageLog"("waMessageId");

