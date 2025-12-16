-- Add soft-archive support (no deletes) for agenda slot blocks.
ALTER TABLE "InterviewSlotBlock" ADD COLUMN "archivedAt" DATETIME;

CREATE INDEX "InterviewSlotBlock_archivedAt_idx" ON "InterviewSlotBlock"("archivedAt");

