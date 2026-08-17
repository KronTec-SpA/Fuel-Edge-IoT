CREATE TABLE `equipment_enrollment_candidates` (
	`module_id` text PRIMARY KEY NOT NULL,
	`site_id` text NOT NULL,
	`device_name` text,
	`equipment_id` text,
	`firmware` text NOT NULL,
	`battery` integer NOT NULL,
	`rssi` integer NOT NULL,
	`claimed` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'detected' NOT NULL,
	`last_seen` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_equipment_enrollment_candidates_last_seen` ON `equipment_enrollment_candidates` (`last_seen`);--> statement-breakpoint
CREATE TABLE `equipment_enrollment_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`site_id` text NOT NULL,
	`equipment_id` text NOT NULL,
	`requested_name` text NOT NULL,
	`kind` text DEFAULT 'Tractor' NOT NULL,
	`condition` text DEFAULT 'Permanente' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`error` text,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_equipment_enrollment_commands_status_module` ON `equipment_enrollment_commands` (`status`,`module_id`,`requested_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_equipment_enrollment_commands_active` ON `equipment_enrollment_commands` (`module_id`) WHERE status IN ('pending','enrolling');