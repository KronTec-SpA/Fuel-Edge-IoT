ALTER TABLE `fuel_movements` ADD COLUMN `review_status` text DEFAULT 'not_required' NOT NULL CHECK (`review_status` IN ('not_required','pending','approved','corrected','rejected'));
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `original_liters` real;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `document_reference` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `reviewed_by_user_id` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `reviewed_by_name` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `reviewed_at` text;
--> statement-breakpoint
ALTER TABLE `fuel_movements` ADD COLUMN `review_note` text;
--> statement-breakpoint
CREATE INDEX `idx_fuel_movements_receipt_review` ON `fuel_movements` (`movement_type`,`review_status`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `fuel_receipt_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`movement_id` text NOT NULL,
	`action` text NOT NULL CHECK (`action` IN ('automatic_detected','approved','corrected','rejected','manual_created')),
	`previous_liters` real,
	`resulting_liters` real,
	`document_reference` text,
	`note` text DEFAULT '' NOT NULL,
	`actor_user_id` text,
	`actor_name` text,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`movement_id`) REFERENCES `fuel_movements`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_fuel_receipt_reviews_movement` ON `fuel_receipt_reviews` (`movement_id`,`occurred_at`);
--> statement-breakpoint
UPDATE `fuel_movements` SET `review_status`='pending',`original_liters`=`liters`,
  `reviewed_by_user_id`=NULL,`reviewed_by_name`=NULL,`reviewed_at`=NULL,
  `review_note`='Detección automática histórica pendiente de conciliación'
  WHERE `movement_type`='receipt' AND `detected_automatically`=1;
--> statement-breakpoint
UPDATE `fuel_movements` SET `review_status`='approved',`original_liters`=`liters`,
  `reviewed_by_name`='Confirmación histórica',`reviewed_at`=`created_at`,
  `review_note`='Movimiento confirmado antes de habilitar el flujo de aprobación'
  WHERE `movement_type`='receipt' AND `detected_automatically`=0;
--> statement-breakpoint
INSERT OR IGNORE INTO `fuel_receipt_reviews`(
  `id`,`movement_id`,`action`,`previous_liters`,`resulting_liters`,`note`,`actor_name`,`occurred_at`
) SELECT `id` || ':historical-auto-detected',`id`,'automatic_detected',NULL,`liters`,
  'Detección automática histórica enviada a conciliación','Migración del sistema',COALESCE(`created_at`,CURRENT_TIMESTAMP)
  FROM `fuel_movements`
  WHERE `movement_type`='receipt' AND `detected_automatically`=1 AND `review_status`='pending';
--> statement-breakpoint
INSERT OR IGNORE INTO `fuel_receipt_reviews`(
  `id`,`movement_id`,`action`,`previous_liters`,`resulting_liters`,`note`,`actor_name`,`occurred_at`
) SELECT `id` || ':legacy-review',`id`,'approved',`liters`,`liters`,
  'Movimiento confirmado antes de habilitar el flujo de aprobación','Migración del sistema',COALESCE(`created_at`,CURRENT_TIMESTAMP)
  FROM `fuel_movements`
  WHERE `movement_type`='receipt' AND `detected_automatically`=0 AND `review_status`='approved';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `web_access_meta` (`key` text PRIMARY KEY NOT NULL,`value` text NOT NULL);
