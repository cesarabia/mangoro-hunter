-- ER-P10: Prompt lock/source metadata for Programs
ALTER TABLE "Program" ADD COLUMN "promptSource" TEXT NOT NULL DEFAULT 'SEEDED';
ALTER TABLE "Program" ADD COLUMN "promptLocked" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Program"
SET "promptSource" = 'SEEDED'
WHERE "promptSource" IS NULL OR TRIM("promptSource") = '';

CREATE INDEX IF NOT EXISTS "Program_workspaceId_promptLocked_idx" ON "Program"("workspaceId", "promptLocked");
