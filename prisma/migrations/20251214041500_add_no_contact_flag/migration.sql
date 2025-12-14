-- Add noContact flag to Contact
ALTER TABLE "Contact" ADD COLUMN "noContact" BOOLEAN NOT NULL DEFAULT 0;
