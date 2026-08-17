CREATE TABLE `fuel_detection_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`capacity_liters` real NOT NULL,
	`baseline_level_liters` real NOT NULL,
	`last_level_liters` real NOT NULL,
	`peak_level_liters` real NOT NULL,
	`active_receipt_id` text,
	`active_started_at` text,
	`last_reading_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fuel_history_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fuel_level_readings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` text NOT NULL,
	`level_liters` real NOT NULL,
	`source` text DEFAULT 'OCIO' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fuel_level_readings_occurred` ON `fuel_level_readings` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `fuel_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`movement_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`liters` real NOT NULL,
	`opening_level_liters` real NOT NULL,
	`closing_level_liters` real NOT NULL,
	`source` text NOT NULL,
	`reference_id` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`detected_automatically` integer DEFAULT false NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`detection_status` text DEFAULT 'confirmed' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fuel_movements_occurred` ON `fuel_movements` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_fuel_movements_type_occurred` ON `fuel_movements` (`movement_type`,`occurred_at`);