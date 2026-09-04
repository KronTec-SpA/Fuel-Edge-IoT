CREATE TABLE `managed_rfid_credentials` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`credential_active` integer DEFAULT 1 NOT NULL,
	`credential_is_master` integer DEFAULT 0 NOT NULL,
	`operator_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_managed_rfid_one_per_operator`
	ON `managed_rfid_credentials` (`operator_id`) WHERE `operator_id` IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_managed_rfid_single_active_master`
	ON `managed_rfid_credentials` (`credential_is_master`)
	WHERE `credential_is_master`=1 AND `credential_active`=1;
--> statement-breakpoint
CREATE INDEX `idx_managed_rfid_operator` ON `managed_rfid_credentials` (`operator_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `managed_rfid_credentials`(
	`credential_id`,`credential_active`,`credential_is_master`,`operator_id`,`created_at`,`updated_at`
) SELECT `credential`,`credential_active`,`credential_is_master`,`id`,`created_at`,`updated_at`
	FROM `managed_operators` WHERE `credential` LIKE 'nfc-%';
