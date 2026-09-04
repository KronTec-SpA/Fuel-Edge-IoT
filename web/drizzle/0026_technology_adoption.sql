ALTER TABLE `fuel_movements` ADD `authorization_evidence` text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD `adoption_stage` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD `assisted_mode` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD `equipment_issue` text;
--> statement-breakpoint
ALTER TABLE `manual_mode_schedules` ADD `purpose` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
CREATE TABLE `technology_adoption_settings` (
	`site_id` text PRIMARY KEY NOT NULL,
	`stage` text DEFAULT 'full' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`program_started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`stage_started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`review_at` text,
	`updated_by` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`note` text DEFAULT 'Política segura inicial: trazabilidad completa.' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `technology_adoption_transitions` (
	`id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`from_stage` text NOT NULL,
	`to_stage` text NOT NULL,
	`reason` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_adoption_transitions_site_time` ON `technology_adoption_transitions` (`site_id`,`occurred_at`);
--> statement-breakpoint
ALTER TABLE `edge_runtime_status` ADD `technology_adoption_stage` text DEFAULT 'full' NOT NULL;
--> statement-breakpoint
ALTER TABLE `edge_runtime_status` ADD `adoption_policy_revision` integer DEFAULT 1 NOT NULL;
