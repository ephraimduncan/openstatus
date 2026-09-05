DROP INDEX `notification_id_monitor_id_crontimestampe`;--> statement-breakpoint
ALTER TABLE `monitor_status` ADD `cron_timestamp` integer;