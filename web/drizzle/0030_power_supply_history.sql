CREATE TABLE `power_supply_events` (
  `id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL,
  `lost_at` text NOT NULL,
  `restored_at` text NOT NULL,
  `duration_seconds` integer NOT NULL CHECK (`duration_seconds` >= 0),
  `source` text NOT NULL CHECK (`source` IN ('ups_gpio24','operator_confirmed','reconstructed')),
  `loss_boot_id` text,
  `restore_boot_id` text,
  `recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_power_supply_events_site_lost`
ON `power_supply_events` (`site_id`,`lost_at`);
