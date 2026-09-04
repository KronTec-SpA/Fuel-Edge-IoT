ALTER TABLE `system_alerts` ADD COLUMN `parent_alert_id` text REFERENCES `system_alerts`(`id`) ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE `system_alerts` ADD COLUMN `root_alert_id` text REFERENCES `system_alerts`(`id`) ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE `system_alerts` ADD COLUMN `reopen_sequence` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `system_alerts` ADD COLUMN `reopened_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `system_alerts` ADD COLUMN `reopened_by_name` text;
--> statement-breakpoint
ALTER TABLE `system_alerts` ADD COLUMN `reopen_reason` text;
--> statement-breakpoint
ALTER TABLE `system_alert_comments` ADD COLUMN `event_type` text DEFAULT 'follow_up' NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_system_alerts_single_reopen` ON `system_alerts` (`parent_alert_id`) WHERE `parent_alert_id` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_system_alerts_root_cycle` ON `system_alerts` (`root_alert_id`,`reopen_sequence`);
