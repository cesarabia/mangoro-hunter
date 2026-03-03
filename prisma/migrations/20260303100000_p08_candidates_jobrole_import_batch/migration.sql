-- P0.8: Candidate import traceability + job role mapping
ALTER TABLE "Workspace" ADD COLUMN "templatePeonetaStartName" TEXT;

ALTER TABLE "Contact" ADD COLUMN "jobRole" TEXT;
ALTER TABLE "Contact" ADD COLUMN "importBatchId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "importedAt" DATETIME;
ALTER TABLE "Contact" ADD COLUMN "importedByUserId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "importSourceFileName" TEXT;
ALTER TABLE "Contact" ADD COLUMN "importSourceChannel" TEXT;

CREATE INDEX "Contact_workspaceId_importBatchId_idx" ON "Contact"("workspaceId", "importBatchId");
