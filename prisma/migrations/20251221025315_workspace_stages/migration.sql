-- CreateTable
CREATE TABLE "WorkspaceStage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "labelEs" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkspaceStage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentRunLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "conversationId" TEXT,
    "programId" TEXT,
    "phoneLineId" TEXT,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "inputContextJson" TEXT NOT NULL,
    "commandsJson" TEXT,
    "resultsJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRunLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AgentRunLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRunLog_programId_fkey" FOREIGN KEY ("programId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AgentRunLog_phoneLineId_fkey" FOREIGN KEY ("phoneLineId") REFERENCES "PhoneLine" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AgentRunLog" ("commandsJson", "conversationId", "createdAt", "error", "eventType", "id", "inputContextJson", "phoneLineId", "programId", "resultsJson", "status", "workspaceId") SELECT "commandsJson", "conversationId", "createdAt", "error", "eventType", "id", "inputContextJson", "phoneLineId", "programId", "resultsJson", "status", "workspaceId" FROM "AgentRunLog";
DROP TABLE "AgentRunLog";
ALTER TABLE "new_AgentRunLog" RENAME TO "AgentRunLog";
CREATE INDEX "AgentRunLog_workspaceId_idx" ON "AgentRunLog"("workspaceId");
CREATE INDEX "AgentRunLog_conversationId_idx" ON "AgentRunLog"("conversationId");
CREATE INDEX "AgentRunLog_createdAt_idx" ON "AgentRunLog"("createdAt");
CREATE TABLE "new_AutomationRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "trigger" TEXT NOT NULL,
    "scopePhoneLineId" TEXT,
    "scopeProgramId" TEXT,
    "conditionsJson" TEXT NOT NULL,
    "actionsJson" TEXT NOT NULL,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AutomationRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AutomationRule_scopePhoneLineId_fkey" FOREIGN KEY ("scopePhoneLineId") REFERENCES "PhoneLine" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AutomationRule_scopeProgramId_fkey" FOREIGN KEY ("scopeProgramId") REFERENCES "Program" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_AutomationRule" ("actionsJson", "archivedAt", "conditionsJson", "createdAt", "enabled", "id", "name", "priority", "scopePhoneLineId", "scopeProgramId", "trigger", "updatedAt", "workspaceId") SELECT "actionsJson", "archivedAt", "conditionsJson", "createdAt", "enabled", "id", "name", "priority", "scopePhoneLineId", "scopeProgramId", "trigger", "updatedAt", "workspaceId" FROM "AutomationRule";
DROP TABLE "AutomationRule";
ALTER TABLE "new_AutomationRule" RENAME TO "AutomationRule";
CREATE INDEX "AutomationRule_workspaceId_idx" ON "AutomationRule"("workspaceId");
CREATE INDEX "AutomationRule_trigger_idx" ON "AutomationRule"("trigger");
CREATE INDEX "AutomationRule_priority_idx" ON "AutomationRule"("priority");
CREATE TABLE "new_Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "waId" TEXT,
    "phone" TEXT,
    "name" TEXT,
    "displayName" TEXT,
    "candidateName" TEXT,
    "candidateNameManual" TEXT,
    "email" TEXT,
    "rut" TEXT,
    "comuna" TEXT,
    "ciudad" TEXT,
    "region" TEXT,
    "experienceYears" INTEGER,
    "terrainExperience" BOOLEAN,
    "availabilityText" TEXT,
    "noContact" BOOLEAN NOT NULL DEFAULT false,
    "noContactAt" DATETIME,
    "noContactReason" TEXT,
    "notes" TEXT,
    "mergedIntoContactId" TEXT,
    "mergedAt" DATETIME,
    "mergedReason" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Contact" ("archivedAt", "availabilityText", "candidateName", "candidateNameManual", "ciudad", "comuna", "createdAt", "displayName", "email", "experienceYears", "id", "mergedAt", "mergedIntoContactId", "mergedReason", "name", "noContact", "noContactAt", "noContactReason", "notes", "phone", "region", "rut", "terrainExperience", "updatedAt", "waId", "workspaceId") SELECT "archivedAt", "availabilityText", "candidateName", "candidateNameManual", "ciudad", "comuna", "createdAt", "displayName", "email", "experienceYears", "id", "mergedAt", "mergedIntoContactId", "mergedReason", "name", "noContact", "noContactAt", "noContactReason", "notes", "phone", "region", "rut", "terrainExperience", "updatedAt", "waId", "workspaceId" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE INDEX "Contact_workspaceId_idx" ON "Contact"("workspaceId");
CREATE UNIQUE INDEX "Contact_workspaceId_waId_key" ON "Contact"("workspaceId", "waId");
CREATE UNIQUE INDEX "Contact_workspaceId_phone_key" ON "Contact"("workspaceId", "phone");
CREATE TABLE "new_Conversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "phoneLineId" TEXT NOT NULL DEFAULT 'default',
    "programId" TEXT,
    "contactId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "conversationStage" TEXT NOT NULL DEFAULT 'NEW_INTAKE',
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
CREATE TABLE "new_CopilotRunLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT,
    "threadId" TEXT,
    "conversationId" TEXT,
    "view" TEXT,
    "inputText" TEXT NOT NULL,
    "responseText" TEXT,
    "actionsJson" TEXT,
    "proposalsJson" TEXT,
    "resultsJson" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SUCCESS',
    "error" TEXT,
    "confirmedAt" DATETIME,
    "confirmedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CopilotRunLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CopilotRunLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CopilotRunLog_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CopilotThread" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CopilotRunLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CopilotRunLog" ("actionsJson", "confirmedAt", "confirmedByUserId", "conversationId", "createdAt", "error", "id", "inputText", "proposalsJson", "responseText", "resultsJson", "status", "threadId", "userId", "view", "workspaceId") SELECT "actionsJson", "confirmedAt", "confirmedByUserId", "conversationId", "createdAt", "error", "id", "inputText", "proposalsJson", "responseText", "resultsJson", "status", "threadId", "userId", "view", "workspaceId" FROM "CopilotRunLog";
DROP TABLE "CopilotRunLog";
ALTER TABLE "new_CopilotRunLog" RENAME TO "CopilotRunLog";
CREATE INDEX "CopilotRunLog_workspaceId_idx" ON "CopilotRunLog"("workspaceId");
CREATE INDEX "CopilotRunLog_threadId_idx" ON "CopilotRunLog"("threadId");
CREATE INDEX "CopilotRunLog_conversationId_idx" ON "CopilotRunLog"("conversationId");
CREATE INDEX "CopilotRunLog_createdAt_idx" ON "CopilotRunLog"("createdAt");
CREATE TABLE "new_CopilotThread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL DEFAULT 'default',
    "userId" TEXT,
    "title" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CopilotThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CopilotThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_CopilotThread" ("archivedAt", "createdAt", "id", "title", "updatedAt", "userId", "workspaceId") SELECT "archivedAt", "createdAt", "id", "title", "updatedAt", "userId", "workspaceId" FROM "CopilotThread";
DROP TABLE "CopilotThread";
ALTER TABLE "new_CopilotThread" RENAME TO "CopilotThread";
CREATE INDEX "CopilotThread_workspaceId_idx" ON "CopilotThread"("workspaceId");
CREATE INDEX "CopilotThread_userId_idx" ON "CopilotThread"("userId");
CREATE INDEX "CopilotThread_createdAt_idx" ON "CopilotThread"("createdAt");
CREATE TABLE "new_InterviewReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "activeKey" TEXT DEFAULT 'ACTIVE',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InterviewReservation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InterviewReservation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_InterviewReservation" ("activeKey", "contactId", "conversationId", "createdAt", "endAt", "id", "location", "startAt", "status", "timezone", "updatedAt") SELECT "activeKey", "contactId", "conversationId", "createdAt", "endAt", "id", "location", "startAt", "status", "timezone", "updatedAt" FROM "InterviewReservation";
DROP TABLE "InterviewReservation";
ALTER TABLE "new_InterviewReservation" RENAME TO "InterviewReservation";
CREATE INDEX "InterviewReservation_conversationId_idx" ON "InterviewReservation"("conversationId");
CREATE INDEX "InterviewReservation_contactId_idx" ON "InterviewReservation"("contactId");
CREATE INDEX "InterviewReservation_startAt_idx" ON "InterviewReservation"("startAt");
CREATE UNIQUE INDEX "InterviewReservation_startAt_location_activeKey_key" ON "InterviewReservation"("startAt", "location", "activeKey");
CREATE TABLE "new_InterviewSlotBlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "reason" TEXT,
    "tag" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_InterviewSlotBlock" ("archivedAt", "createdAt", "endAt", "id", "location", "reason", "startAt", "tag", "timezone", "updatedAt") SELECT "archivedAt", "createdAt", "endAt", "id", "location", "reason", "startAt", "tag", "timezone", "updatedAt" FROM "InterviewSlotBlock";
DROP TABLE "InterviewSlotBlock";
ALTER TABLE "new_InterviewSlotBlock" RENAME TO "InterviewSlotBlock";
CREATE INDEX "InterviewSlotBlock_startAt_idx" ON "InterviewSlotBlock"("startAt");
CREATE INDEX "InterviewSlotBlock_tag_idx" ON "InterviewSlotBlock"("tag");
CREATE UNIQUE INDEX "InterviewSlotBlock_startAt_location_key" ON "InterviewSlotBlock"("startAt", "location");
CREATE TABLE "new_PhoneLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "phoneE164" TEXT,
    "waPhoneNumberId" TEXT NOT NULL,
    "wabaId" TEXT,
    "defaultProgramId" TEXT,
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
CREATE TABLE "new_SellerEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "rawText" TEXT NOT NULL,
    "dataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SellerEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SellerEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_SellerEvent" ("contactId", "conversationId", "createdAt", "dataJson", "id", "occurredAt", "rawText", "type") SELECT "contactId", "conversationId", "createdAt", "dataJson", "id", "occurredAt", "rawText", "type" FROM "SellerEvent";
DROP TABLE "SellerEvent";
ALTER TABLE "new_SellerEvent" RENAME TO "SellerEvent";
CREATE INDEX "SellerEvent_conversationId_idx" ON "SellerEvent"("conversationId");
CREATE INDEX "SellerEvent_contactId_idx" ON "SellerEvent"("contactId");
CREATE INDEX "SellerEvent_occurredAt_idx" ON "SellerEvent"("occurredAt");
CREATE INDEX "SellerEvent_type_idx" ON "SellerEvent"("type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "WorkspaceStage_workspaceId_idx" ON "WorkspaceStage"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceStage_createdAt_idx" ON "WorkspaceStage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceStage_workspaceId_slug_key" ON "WorkspaceStage"("workspaceId", "slug");
