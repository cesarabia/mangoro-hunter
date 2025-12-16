-- Safe Outbound Mode (DEV guardrail): allowlist-only / allow-all / block-all.
ALTER TABLE "SystemConfig" ADD COLUMN "outboundPolicy" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "outboundAllowlist" TEXT;

