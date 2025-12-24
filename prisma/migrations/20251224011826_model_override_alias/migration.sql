-- AlterTable
ALTER TABLE "AiUsageLog" ADD COLUMN "modelRequested" TEXT;
ALTER TABLE "AiUsageLog" ADD COLUMN "modelResolved" TEXT;

-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN "adminAiModelAlias" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "adminAiModelOverride" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "aiModelAlias" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "aiModelOverride" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "interviewAiModelAlias" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "interviewAiModelOverride" TEXT;

