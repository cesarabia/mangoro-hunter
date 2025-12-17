-- Agent OS v1: multi-tenant hardening for contacts.
-- - Remove global uniqueness on Contact.waId
-- - Add composite uniqueness scoped by workspace (workspaceId, waId) and (workspaceId, phone)
--
-- NOTE: SQLite represents @unique as unique indexes. We only touch indexes (no deletes).

DROP INDEX IF EXISTS "Contact_waId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "Contact_workspaceId_waId_key" ON "Contact"("workspaceId", "waId");
CREATE UNIQUE INDEX IF NOT EXISTS "Contact_workspaceId_phone_key" ON "Contact"("workspaceId", "phone");

