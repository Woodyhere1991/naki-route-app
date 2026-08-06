-- Keep a short, private record of sent Arcade invites so email limits remain
-- effective even when an older in-app invite is replaced for the same friend.
CREATE TABLE IF NOT EXISTS arcade_invite_sends (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (sender_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS arcade_invite_sends_sender_time
  ON arcade_invite_sends(sender_id, created_at DESC);
