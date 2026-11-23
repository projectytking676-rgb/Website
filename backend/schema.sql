CREATE TABLE IF NOT EXISTS app_data (
  path TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS admin_users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS device_sessions (
  id BIGSERIAL PRIMARY KEY,
  license_key TEXT NOT NULL,
  device_id TEXT NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(license_key, device_id)
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_key ON device_sessions(license_key);
