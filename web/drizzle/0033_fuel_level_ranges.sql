CREATE TABLE IF NOT EXISTS fuel_level_ranges (
  occurred_at TEXT PRIMARY KEY,
  min_liters REAL NOT NULL,
  max_liters REAL NOT NULL,
  source TEXT NOT NULL,
  telemetry_session_id TEXT
);
