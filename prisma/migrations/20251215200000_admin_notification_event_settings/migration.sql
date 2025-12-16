-- Per-event admin notification controls (enable/disable + detail overrides).
ALTER TABLE "SystemConfig" ADD COLUMN "adminNotificationEnabledEvents" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "adminNotificationDetailLevelsByEvent" TEXT;

