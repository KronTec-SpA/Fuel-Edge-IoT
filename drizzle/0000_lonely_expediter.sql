CREATE TABLE `web_access_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` text,
	`event` text NOT NULL,
	`target_user_id` text,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `web_users` (
	`id` text PRIMARY KEY NOT NULL,
	`email_digest` text NOT NULL,
	`email_encrypted` text,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`permissions` text NOT NULL,
	`password_hash` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`is_master` integer DEFAULT false NOT NULL,
	`bootstrap_version` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_login_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_web_users_email_digest` ON `web_users` (`email_digest`);