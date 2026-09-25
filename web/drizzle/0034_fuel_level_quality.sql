CREATE TABLE IF NOT EXISTS fuel_level_quality (
  id INTEGER PRIMARY KEY CHECK(id=1),
  occurred_at TEXT NOT NULL,
  quality TEXT NOT NULL,
  telemetry_session_id TEXT
);
