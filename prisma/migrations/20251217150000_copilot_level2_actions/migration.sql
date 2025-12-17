-- AlterTable
ALTER TABLE "CopilotRunLog" ADD COLUMN "proposalsJson" TEXT;
ALTER TABLE "CopilotRunLog" ADD COLUMN "resultsJson" TEXT;
ALTER TABLE "CopilotRunLog" ADD COLUMN "confirmedAt" DATETIME;
ALTER TABLE "CopilotRunLog" ADD COLUMN "confirmedByUserId" TEXT;

