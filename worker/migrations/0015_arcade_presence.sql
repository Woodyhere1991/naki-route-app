PRAGMA foreign_keys = ON;

-- Short-lived Arcade presence. The page refreshes this while it is open and
-- friends only see a simple online/game label, never contact details.
CREATE TABLE IF NOT EXISTS arcade_presence (
  customer_id TEXT PRIMARY KEY,
  activity TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS arcade_presence_recent
  ON arcade_presence(last_seen DESC);
