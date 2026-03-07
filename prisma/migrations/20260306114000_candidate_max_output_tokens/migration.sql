-- Configurable output token cap for candidate-facing agent replies.
ALTER TABLE "SystemConfig" ADD COLUMN "candidateMaxOutputTokens" INTEGER;
