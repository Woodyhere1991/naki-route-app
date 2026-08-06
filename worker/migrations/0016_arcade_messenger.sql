PRAGMA foreign_keys = ON;

-- Public-message replies.
ALTER TABLE arcade_messages ADD COLUMN reply_to TEXT;

-- One public-chat read marker per customer. This powers the red unread badge.
CREATE TABLE IF NOT EXISTS arcade_chat_reads (
  customer_id TEXT PRIMARY KEY,
  public_read_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- Private messages are only available between accepted Arcade friends.
CREATE TABLE IF NOT EXISTS arcade_direct_messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  hidden_by_sender INTEGER NOT NULL DEFAULT 0,
  hidden_by_recipient INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (sender_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (reply_to) REFERENCES arcade_direct_messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS arcade_direct_pair
  ON arcade_direct_messages(sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS arcade_direct_unread
  ON arcade_direct_messages(recipient_id, read_at, created_at DESC);
