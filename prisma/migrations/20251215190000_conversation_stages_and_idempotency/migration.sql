-- Add workflow stage + archive metadata to conversations (non-destructive).
ALTER TABLE "Conversation" ADD COLUMN "conversationStage" TEXT NOT NULL DEFAULT 'NEW_INTAKE';
ALTER TABLE "Conversation" ADD COLUMN "stageReason" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "stageTags" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "Conversation" ADD COLUMN "archivedSummary" TEXT;

-- Add WhatsApp message id for inbound idempotency.
ALTER TABLE "Message" ADD COLUMN "waMessageId" TEXT;
CREATE UNIQUE INDEX "Message_waMessageId_key" ON "Message"("waMessageId");

-- Store workflow rules and inactivity thresholds in config (editable from CRM UI).
ALTER TABLE "SystemConfig" ADD COLUMN "workflowRules" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "workflowInactivityDays" INTEGER;
ALTER TABLE "SystemConfig" ADD COLUMN "workflowArchiveDays" INTEGER;

