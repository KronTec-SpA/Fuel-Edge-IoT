ALTER TABLE `equipment_enrollment_candidates`
  RENAME TO `equipment_enrollment_candidates_with_battery`;
--> statement-breakpoint
CREATE TABLE `equipment_enrollment_candidates` (
  `module_id` text PRIMARY KEY NOT NULL,
  `site_id` text NOT NULL,
  `device_name` text,
  `equipment_id` text,
  `firmware` text NOT NULL,
  `rssi` integer NOT NULL,
  `claimed` integer DEFAULT false NOT NULL CHECK (`claimed` IN (0,1)),
  `status` text DEFAULT 'detected' NOT NULL
    CHECK (`status` IN ('detected','pending','enrolling','failed','enrolled')),
  `last_seen` text NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `equipment_enrollment_candidates` (
  `module_id`,`site_id`,`device_name`,`equipment_id`,`firmware`,`rssi`,
  `claimed`,`status`,`last_seen`,`updated_at`
)
SELECT
  `module_id`,`site_id`,`device_name`,`equipment_id`,`firmware`,`rssi`,
  `claimed`,`status`,`last_seen`,`updated_at`
FROM `equipment_enrollment_candidates_with_battery`;
--> statement-breakpoint
DROP TABLE `equipment_enrollment_candidates_with_battery`;
--> statement-breakpoint
CREATE INDEX `idx_equipment_enrollment_candidates_last_seen`
  ON `equipment_enrollment_candidates` (`last_seen`);
--> statement-breakpoint
ALTER TABLE `managed_equipment`
  RENAME TO `managed_equipment_with_battery`;
--> statement-breakpoint
CREATE TABLE `managed_equipment` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `kind` text NOT NULL,
  `condition` text NOT NULL
    CHECK (`condition` IN ('Permanente','Temporal','Externo')),
  `module` text NOT NULL,
  `site_id` text DEFAULT '' NOT NULL,
  `active` integer DEFAULT true NOT NULL CHECK (`active` IN (0,1)),
  `expiry` text,
  `archived_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
INSERT INTO `managed_equipment` (
  `id`,`name`,`kind`,`condition`,`module`,`site_id`,`active`,`expiry`,
  `archived_at`,`created_at`,`updated_at`
)
SELECT
  `id`,`name`,`kind`,`condition`,`module`,`site_id`,`active`,`expiry`,
  `archived_at`,`created_at`,`updated_at`
FROM `managed_equipment_with_battery`;
--> statement-breakpoint
DROP TABLE `managed_equipment_with_battery`;
--> statement-breakpoint
CREATE INDEX `idx_managed_equipment_archived`
  ON `managed_equipment` (`archived_at`);
--> statement-breakpoint
CREATE INDEX `idx_managed_equipment_module_site_expiry`
  ON `managed_equipment` (`module`,`site_id`,`expiry`);
