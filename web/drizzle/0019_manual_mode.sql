CREATE TABLE `manual_mode_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_role` text NOT NULL,
	`site_id` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`cancelled_at` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_manual_mode_status_start` ON `manual_mode_schedules` (`status`,`start_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_manual_mode_one_open` ON `manual_mode_schedules` ((1)) WHERE status IN ('scheduled','active');
