CREATE TABLE `site_commissioning` (
	`site_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'in_progress' NOT NULL CHECK(`status` IN ('in_progress','completed')),
	`cycle` integer DEFAULT 1 NOT NULL CHECK(`cycle` >= 1),
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text,
	`completed_by` text,
	`reopened_at` text,
	`reopened_by` text,
	`reopen_reason` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
