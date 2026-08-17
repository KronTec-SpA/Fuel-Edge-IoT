ALTER TABLE `system_alerts` ADD COLUMN `priority` text DEFAULT 'medium' NOT NULL;
--> statement-breakpoint
ALTER TABLE `system_alerts` ADD COLUMN `status` text DEFAULT 'pending' NOT NULL;
--> statement-breakpoint
UPDATE `system_alerts` SET `priority` = CASE `severity`
  WHEN 'critical' THEN 'urgent' WHEN 'warning' THEN 'high' ELSE 'medium' END;
--> statement-breakpoint
UPDATE `system_alerts` SET `status` = 'resolved' WHERE `acknowledged_at` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE `system_alert_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`comment` text NOT NULL,
	`status_after` text NOT NULL,
	`priority_after` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `system_alerts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_system_alert_comments_alert` ON `system_alert_comments` (`alert_id`,`occurred_at`);
--> statement-breakpoint
INSERT OR IGNORE INTO `system_alert_comments`(
  `id`,`alert_id`,`actor_user_id`,`actor_name`,`comment`,`status_after`,`priority_after`,`occurred_at`
) SELECT x.`id`,x.`alert_id`,x.`actor_user_id`,x.`actor_name`,x.`description`,'resolved',a.`priority`,x.`occurred_at`
  FROM `system_alert_actions` x INNER JOIN `system_alerts` a ON a.`id`=x.`alert_id`;
