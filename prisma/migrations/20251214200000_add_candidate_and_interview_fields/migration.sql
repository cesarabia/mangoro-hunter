-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "displayName" TEXT;
ALTER TABLE "Contact" ADD COLUMN "candidateName" TEXT;

ALTER TABLE "Conversation" ADD COLUMN "aiPaused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Conversation" ADD COLUMN "interviewDay" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "interviewTime" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "interviewLocation" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "interviewStatus" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "adminLastCandidateWaId" TEXT;
