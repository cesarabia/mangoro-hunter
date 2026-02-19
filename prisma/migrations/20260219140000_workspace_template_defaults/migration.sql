-- Add workspace-level WhatsApp template defaults (non-destructive)
ALTER TABLE "Workspace" ADD COLUMN "templateRecruitmentStartName" TEXT;
ALTER TABLE "Workspace" ADD COLUMN "templateInterviewConfirmationName" TEXT;
