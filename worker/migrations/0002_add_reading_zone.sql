ALTER TABLE readings ADD COLUMN zone TEXT NOT NULL DEFAULT 'classroom'
  CHECK (zone IN ('courtyard', 'classroom', 'library'));

CREATE INDEX IF NOT EXISTS idx_readings_zone_recorded
  ON readings (zone, recorded_at DESC);
