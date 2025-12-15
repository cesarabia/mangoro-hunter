-- Add manual override for candidate names (human editable).
ALTER TABLE "Contact" ADD COLUMN "candidateNameManual" TEXT;

-- Sales AI config (prompt + knowledge base) for Ventas mode.
ALTER TABLE "SystemConfig" ADD COLUMN "salesAiPrompt" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "salesKnowledgeBase" TEXT;

