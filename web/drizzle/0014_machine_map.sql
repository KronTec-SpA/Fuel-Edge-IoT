CREATE TABLE `validator_bluetooth_observations` (
	`site_id` text NOT NULL,
	`module_id` text NOT NULL,
	`rssi` integer NOT NULL,
	`observed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`site_id`, `module_id`),
	CONSTRAINT "validator_bluetooth_observations_rssi_check" CHECK(`rssi` BETWEEN -127 AND 20)
);
--> statement-breakpoint
CREATE INDEX `idx_validator_bluetooth_observations_site_time` ON `validator_bluetooth_observations` (`site_id`,`observed_at`);
