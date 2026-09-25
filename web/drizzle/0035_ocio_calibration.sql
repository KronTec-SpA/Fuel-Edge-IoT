CREATE TABLE IF NOT EXISTS ocio_calibration_settings (
  site_id TEXT PRIMARY KEY, interval_days INTEGER NOT NULL DEFAULT 365,
  revision INTEGER NOT NULL DEFAULT 0, confirmation_id TEXT,
  calibrated_at TEXT, calibrated_by TEXT, calibrated_by_name TEXT, next_due_at TEXT,
  fingerprint TEXT, applied_revision INTEGER NOT NULL DEFAULT 0, applied_at TEXT,
  controller_fingerprint TEXT, controller_seen_at TEXT, controller_session_id TEXT,
  controller_pending INTEGER
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ocio_calibration_events (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL, kind TEXT NOT NULL,
  revision INTEGER NOT NULL, occurred_at TEXT NOT NULL, actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL, interval_days INTEGER NOT NULL, next_due_at TEXT,
  fingerprint TEXT, applied_at TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ocio_calibration_events_site ON ocio_calibration_events(site_id,occurred_at);
--> statement-breakpoint
ALTER TABLE inventory_balance_anchors ADD COLUMN original_site_id TEXT;
--> statement-breakpoint
ALTER TABLE inventory_balance_anchors ADD COLUMN archived_at TEXT;
