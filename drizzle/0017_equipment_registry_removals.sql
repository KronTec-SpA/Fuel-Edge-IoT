CREATE TABLE `equipment_registry_removals` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`equipment_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL CHECK (`status` IN ('pending','processing','completed')),
	`requested_by` text NOT NULL,
	`error` text,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_equipment_registry_removals_status_requested`
	ON `equipment_registry_removals` (`status`,`requested_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_equipment_registry_removals_active_module`
	ON `equipment_registry_removals` (`module_id`)
	WHERE `status` IN ('pending','processing');
