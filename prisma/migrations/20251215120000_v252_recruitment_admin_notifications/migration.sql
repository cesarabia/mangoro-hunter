-- v2.5.2: Recruitment UX config + configurable admin notifications.
ALTER TABLE "SystemConfig" ADD COLUMN "recruitJobSheet" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "recruitFaq" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "adminNotificationDetailLevel" TEXT;
ALTER TABLE "SystemConfig" ADD COLUMN "adminNotificationTemplates" TEXT;

