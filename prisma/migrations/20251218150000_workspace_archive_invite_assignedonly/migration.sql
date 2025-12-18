-- Workspace archive + invite assignedOnly (safe, additive).
ALTER TABLE "Workspace" ADD COLUMN "archivedAt" DATETIME;
ALTER TABLE "WorkspaceInvite" ADD COLUMN "assignedOnly" BOOLEAN NOT NULL DEFAULT 0;

