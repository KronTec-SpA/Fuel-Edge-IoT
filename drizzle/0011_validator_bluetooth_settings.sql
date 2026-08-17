CREATE TABLE `validator_bluetooth_settings` (
	`site_id` text PRIMARY KEY NOT NULL,
	`rssi_threshold` integer DEFAULT -70 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`applied_threshold` integer,
	`applied_revision` integer,
	`applied_at` text,
	`last_observed_rssi` integer,
	`last_observed_module` text,
	`observed_at` text
);
