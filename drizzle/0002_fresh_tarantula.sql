CREATE TABLE `managed_associations` (
	`id` text PRIMARY KEY NOT NULL,
	`operator_id` text NOT NULL,
	`equipment_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`since` text NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_managed_associations_archived` ON `managed_associations` (`archived_at`);--> statement-breakpoint
CREATE INDEX `idx_managed_associations_operator` ON `managed_associations` (`operator_id`);--> statement-breakpoint
CREATE INDEX `idx_managed_associations_equipment` ON `managed_associations` (`equipment_id`);--> statement-breakpoint
CREATE TABLE `managed_entity_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` text NOT NULL,
	`event` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_managed_entity_audit_occurred` ON `managed_entity_audit` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `managed_equipment` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`condition` text NOT NULL,
	`module` text NOT NULL,
	`battery` integer,
	`active` integer DEFAULT true NOT NULL,
	`expiry` text,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_managed_equipment_archived` ON `managed_equipment` (`archived_at`);--> statement-breakpoint
CREATE TABLE `managed_operators` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`rut` text NOT NULL,
	`credential` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`last_use` text DEFAULT 'Sin actividad' NOT NULL,
	`archived_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_managed_operators_archived` ON `managed_operators` (`archived_at`);