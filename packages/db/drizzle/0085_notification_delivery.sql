ALTER TABLE `notification_trigger` ADD `status` text DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE `notification_trigger` ADD `payload` text;--> statement-breakpoint
ALTER TABLE `notification_trigger` ADD `lease_token` text;--> statement-breakpoint
ALTER TABLE `notification_trigger` ADD `lease_expires_at` integer;--> statement-breakpoint
CREATE INDEX `notification_trigger_pending_idx` ON `notification_trigger` (`monitor_id`,`cron_timestamp`) WHERE "notification_trigger"."status" = 'pending';