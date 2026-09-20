CREATE TABLE IF NOT EXISTS run_backups (
  owner_key TEXT PRIMARY KEY,
  saved_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  previous_json TEXT
);
