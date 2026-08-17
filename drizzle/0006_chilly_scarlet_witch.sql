PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_system_alert_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`description` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `system_alerts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_system_alert_actions`("id", "alert_id", "actor_user_id", "actor_name", "description", "occurred_at") SELECT "id", "alert_id", "actor_user_id", "actor_name", "description", "occurred_at" FROM `system_alert_actions`;--> statement-breakpoint
DROP TABLE `system_alert_actions`;--> statement-breakpoint
ALTER TABLE `__new_system_alert_actions` RENAME TO `system_alert_actions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `system_alert_actions_alert_id_unique` ON `system_alert_actions` (`alert_id`);--> statement-breakpoint
CREATE INDEX `idx_system_alert_actions_alert` ON `system_alert_actions` (`alert_id`,`occurred_at`);