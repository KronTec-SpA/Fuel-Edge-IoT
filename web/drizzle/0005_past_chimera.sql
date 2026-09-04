CREATE TABLE `edge_runtime_status` (
	`id` integer PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`site_id` text NOT NULL,
	`state` text NOT NULL,
	`relay_energized` integer NOT NULL,
	`validator_online` integer NOT NULL,
	`k24_healthy` integer NOT NULL,
	`occurred_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `system_alert_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`description` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `system_alert_actions_alert_id_unique` ON `system_alert_actions` (`alert_id`);--> statement-breakpoint
CREATE INDEX `idx_system_alert_actions_alert` ON `system_alert_actions` (`alert_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `system_alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`occurred_at` text NOT NULL,
	`acknowledged_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_system_alerts_occurred` ON `system_alerts` (`occurred_at`);