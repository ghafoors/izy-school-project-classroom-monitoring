CREATE TABLE IF NOT EXISTS readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  wifi_rssi INTEGER,

  aht20_temperature_c REAL,
  aht20_humidity_pct REAL,

  bmp280_temperature_c REAL,
  bmp280_pressure_hpa REAL,
  bmp280_altitude_m REAL,

  mq2_adc INTEGER,
  mq2_voltage REAL,
  mq4_adc INTEGER,
  mq4_voltage REAL,
  mq6_adc INTEGER,
  mq6_voltage REAL,
  mq135_adc INTEGER,
  mq135_voltage REAL,

  sound_adc INTEGER,
  sound_voltage REAL,
  sound_detected INTEGER,

  uv_adc INTEGER,
  uv_voltage REAL,
  uv_index REAL,

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_readings_recorded_at ON readings (recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_device_recorded ON readings (device_id, recorded_at DESC);
