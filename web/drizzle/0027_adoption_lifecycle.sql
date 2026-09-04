ALTER TABLE `technology_adoption_settings` ADD `program_status` text DEFAULT 'inactive' NOT NULL;
--> statement-breakpoint
ALTER TABLE `technology_adoption_settings` ADD `completed_at` text;
