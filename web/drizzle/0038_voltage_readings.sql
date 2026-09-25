CREATE TABLE IF NOT EXISTS voltage_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  telemetry_session_id TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL,
  source TEXT NOT NULL,
  volts REAL NOT NULL,
  raw_adc REAL NOT NULL,
  quality TEXT NOT NULL,
  calibration_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(site_id,telemetry_session_id,source,occurred_at)
);
CREATE INDEX IF NOT EXISTS idx_voltage_readings_occurred ON voltage_readings(occurred_at);
