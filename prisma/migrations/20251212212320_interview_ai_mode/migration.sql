-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN "interviewAiModel" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "interviewAiPrompt" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "templateGeneralFollowup" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "templateInterviewInvite" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "assignedToId" TEXT,
    "channel" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "aiMode" TEXT NOT NULL DEFAULT 'RECRUIT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Conversation_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Conversation" ("assignedToId", "channel", "contactId", "createdAt", "id", "isAdmin", "status", "updatedAt") SELECT "assignedToId", "channel", "contactId", "createdAt", "id", "isAdmin", "status", "updatedAt" FROM "Conversation";
DROP TABLE "Conversation";
ALTER TABLE "new_Conversation" RENAME TO "Conversation";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
