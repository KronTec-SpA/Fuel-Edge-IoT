CREATE TABLE IF NOT EXISTS inventory_balance_anchors (
  id TEXT PRIMARY KEY,site_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory_balance_samples (
  id TEXT PRIMARY KEY,anchor_id TEXT NOT NULL,occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL,payload TEXT NOT NULL,
  FOREIGN KEY(anchor_id) REFERENCES inventory_balance_anchors(id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inventory_balance_time ON inventory_balance_samples(anchor_id,occurred_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_inventory_balance_day ON inventory_balance_samples(anchor_id,local_date,occurred_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS inventory_balance_alarm_state (
  anchor_id TEXT PRIMARY KEY,episode INTEGER NOT NULL DEFAULT 0,
  sign INTEGER NOT NULL DEFAULT 0,tier INTEGER NOT NULL DEFAULT 0,last_seen_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(anchor_id) REFERENCES inventory_balance_anchors(id)
);
