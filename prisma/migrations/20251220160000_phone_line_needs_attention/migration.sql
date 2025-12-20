-- Add needsAttention flag to PhoneLine (archive-only hygiene; no data deletion).
ALTER TABLE "PhoneLine" ADD COLUMN "needsAttention" BOOLEAN NOT NULL DEFAULT 0;

