ALTER TABLE `equipment_enrollment_commands` ADD `valid_until` text;--> statement-breakpoint
ALTER TABLE `managed_equipment` ADD `site_id` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_managed_equipment_module_site_expiry` ON `managed_equipment` (`module`,`site_id`,`expiry`);