-- CreateTable
CREATE TABLE "SellerEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL,
    "rawText" TEXT NOT NULL,
    "dataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SellerEvent_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SellerEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SellerEvent_conversationId_idx" ON "SellerEvent"("conversationId");
CREATE INDEX "SellerEvent_contactId_idx" ON "SellerEvent"("contactId");
CREATE INDEX "SellerEvent_occurredAt_idx" ON "SellerEvent"("occurredAt");
CREATE INDEX "SellerEvent_type_idx" ON "SellerEvent"("type");

