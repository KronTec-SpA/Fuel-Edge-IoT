ALTER TABLE `fuel_movements` ADD `legacy_id` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD `manual_mode_session_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fuel_movements_legacy_id` ON `fuel_movements` (`legacy_id`) WHERE `legacy_id` IS NOT NULL;
