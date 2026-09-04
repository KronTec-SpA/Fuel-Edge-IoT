ALTER TABLE `fuel_detection_state` ADD COLUMN `baseline_started_at` text DEFAULT '1970-01-01T00:00:00.000Z' NOT NULL;
--> statement-breakpoint
ALTER TABLE `fuel_detection_state` ADD COLUMN `telemetry_session_id` text;
--> statement-breakpoint
ALTER TABLE `edge_runtime_status` ADD COLUMN `telemetry_session_id` text;
