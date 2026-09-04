ALTER TABLE `managed_operators` ADD COLUMN `credential_active` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE `managed_operators` ADD COLUMN `credential_is_master` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_managed_operators_single_active_master`
  ON `managed_operators` (`credential_is_master`)
  WHERE `credential_is_master`=1 AND `credential_active`=1 AND `archived_at` IS NULL;
--> statement-breakpoint
ALTER TABLE `nfc_enrollment_commands` ADD COLUMN `is_master` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `nfc_enrollment_commands` ADD COLUMN `previous_credential_id` text;
--> statement-breakpoint
ALTER TABLE `nfc_enrollment_commands` ADD COLUMN `replaced_master_credential_id` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `operator_id` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `equipment_id` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `is_master` integer DEFAULT 0 NOT NULL;
