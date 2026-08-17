CREATE TABLE `nfc_enrollment_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`status` text NOT NULL,
	`credential_id` text,
	`error` text,
	`requested_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`started_at` text,
	`completed_at` text,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_nfc_enrollment_status` ON `nfc_enrollment_commands` (`status`,`requested_at`);
