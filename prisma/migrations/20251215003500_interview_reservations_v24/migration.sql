-- AlterTable
ALTER TABLE "SystemConfig" ADD COLUMN "interviewTimezone" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "interviewSlotMinutes" INTEGER;
ALTER TABLE "SystemConfig" ADD COLUMN "interviewWeeklyAvailability" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "interviewExceptions" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "interviewLocations" TEXT;

-- CreateTable
CREATE TABLE "InterviewReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "startAt" DATETIME NOT NULL,
    "endAt" DATETIME NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "activeKey" TEXT DEFAULT 'ACTIVE',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InterviewReservation_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "InterviewReservation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "InterviewReservation_conversationId_idx" ON "InterviewReservation"("conversationId");
CREATE INDEX "InterviewReservation_contactId_idx" ON "InterviewReservation"("contactId");
CREATE INDEX "InterviewReservation_startAt_idx" ON "InterviewReservation"("startAt");

-- CreateUniqueIndex
CREATE UNIQUE INDEX "InterviewReservation_startAt_location_activeKey_key" ON "InterviewReservation"("startAt", "location", "activeKey");
