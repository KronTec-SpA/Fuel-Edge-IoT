ALTER TABLE `edge_runtime_status` ADD COLUMN `nfc_ready` integer DEFAULT 0 NOT NULL;
ALTER TABLE `edge_runtime_status` ADD COLUMN `k24_enabled` integer DEFAULT 0 NOT NULL;
ALTER TABLE `edge_runtime_status` ADD COLUMN `tank_level_enabled` integer DEFAULT 0 NOT NULL;
