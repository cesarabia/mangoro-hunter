-- Agenda blocks: reserve a slot without creating a Contact/Conversation.
CREATE TABLE "InterviewSlotBlock" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "startAt" DATETIME NOT NULL,
  "endAt" DATETIME NOT NULL,
  "timezone" TEXT NOT NULL,
  "location" TEXT NOT NULL,
  "reason" TEXT,
  "tag" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "InterviewSlotBlock_startAt_idx" ON "InterviewSlotBlock"("startAt");
CREATE INDEX "InterviewSlotBlock_tag_idx" ON "InterviewSlotBlock"("tag");
CREATE UNIQUE INDEX "InterviewSlotBlock_startAt_location_key" ON "InterviewSlotBlock"("startAt","location");

