-- Add platformRole to User for Platform SuperAdmin gating.
ALTER TABLE "User" ADD COLUMN "platformRole" TEXT NOT NULL DEFAULT 'NONE';

