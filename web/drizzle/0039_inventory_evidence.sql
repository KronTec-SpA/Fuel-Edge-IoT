CREATE TABLE IF NOT EXISTS inventory_detection_state (
  anchor_id TEXT PRIMARY KEY, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_reference_windows (
  id TEXT PRIMARY KEY, anchor_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
  local_date TEXT NOT NULL, local_minute INTEGER NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inventory_reference_day
  ON inventory_reference_windows(anchor_id,local_date,local_minute);
CREATE INDEX IF NOT EXISTS idx_inventory_reference_time
  ON inventory_reference_windows(anchor_id,occurred_at);
CREATE TABLE IF NOT EXISTS inventory_measurement_health (
  site_id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, payload TEXT NOT NULL
);
