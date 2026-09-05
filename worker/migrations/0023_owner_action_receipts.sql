CREATE TABLE IF NOT EXISTS owner_action_receipts (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status INTEGER,
  response TEXT
);
CREATE INDEX IF NOT EXISTS owner_action_receipts_owner_time ON owner_action_receipts(owner_email, created_at);
