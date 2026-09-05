ALTER TABLE login_codes ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'sent';
CREATE TABLE IF NOT EXISTS auth_request_limits (
  bucket TEXT PRIMARY KEY,
  used INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_request_limits_expiry ON auth_request_limits(expires_at);
CREATE TABLE IF NOT EXISTS arcade_score_flags (
  customer_id TEXT NOT NULL,
  game TEXT NOT NULL,
  score INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (customer_id, game),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);
