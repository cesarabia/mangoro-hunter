-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "adminPendingAction" TEXT;

ALTER TABLE "SystemConfig" ADD COLUMN "adminAiAddendum" TEXT;
