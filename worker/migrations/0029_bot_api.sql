CREATE TABLE IF NOT EXISTS bot_api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('read', 'write')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);

-- Request bodies and credentials are never logged. Responses allow safe retries.
CREATE TABLE IF NOT EXISTS bot_api_requests (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES bot_api_keys(id),
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status INTEGER,
  response TEXT
);
CREATE INDEX IF NOT EXISTS bot_api_requests_created ON bot_api_requests(created_at);
