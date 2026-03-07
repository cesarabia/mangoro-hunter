-- Add application flow metadata per conversation (role + state) for guided intake.
ALTER TABLE "Conversation" ADD COLUMN "applicationRole" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "applicationState" TEXT;
