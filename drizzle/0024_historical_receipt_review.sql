UPDATE `fuel_movements` AS `movements` SET
  `review_status`='pending',`original_liters`=COALESCE(`original_liters`,`liters`),
  `reviewed_by_user_id`=NULL,`reviewed_by_name`=NULL,`reviewed_at`=NULL,
  `review_note`='Detección automática histórica pendiente de conciliación'
  WHERE `movement_type`='receipt' AND `detected_automatically`=1 AND `detection_status`='confirmed'
    AND (
      `review_status`='not_required'
      OR (`review_status`='approved' AND NOT EXISTS (
        SELECT 1 FROM `fuel_receipt_reviews` AS `reviews`
        WHERE `reviews`.`movement_id`=`movements`.`id`
          AND `reviews`.`action` IN ('approved','corrected','rejected')
          AND `reviews`.`id`<>(`movements`.`id` || ':legacy-review')
      ))
    );
--> statement-breakpoint
DELETE FROM `fuel_receipt_reviews`
  WHERE `id` IN (
    SELECT `reviews`.`id` FROM `fuel_receipt_reviews` AS `reviews`
    INNER JOIN `fuel_movements` AS `movements` ON `movements`.`id`=`reviews`.`movement_id`
    WHERE `movements`.`movement_type`='receipt' AND `movements`.`detected_automatically`=1
      AND `movements`.`review_status`='pending'
      AND `reviews`.`id`=(`movements`.`id` || ':legacy-review')
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `fuel_receipt_reviews`(
  `id`,`movement_id`,`action`,`previous_liters`,`resulting_liters`,`note`,`actor_name`,`occurred_at`
) SELECT `movements`.`id` || ':historical-auto-detected',`movements`.`id`,'automatic_detected',NULL,
  COALESCE(`movements`.`original_liters`,`movements`.`liters`),
  'Detección automática histórica enviada a conciliación','Migración del sistema',COALESCE(`movements`.`created_at`,CURRENT_TIMESTAMP)
  FROM `fuel_movements` AS `movements`
  WHERE `movements`.`movement_type`='receipt' AND `movements`.`detected_automatically`=1
    AND `movements`.`review_status`='pending'
    AND NOT EXISTS (
      SELECT 1 FROM `fuel_receipt_reviews` AS `reviews`
      WHERE `reviews`.`movement_id`=`movements`.`id` AND `reviews`.`action`='automatic_detected'
    );
