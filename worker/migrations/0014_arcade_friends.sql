PRAGMA foreign_keys = ON;

-- One row per pair. Keeping the ids in sorted order prevents two people making
-- duplicate friendships by sending requests at the same time.
CREATE TABLE IF NOT EXISTS arcade_friendships (
  user_low TEXT NOT NULL,
  user_high TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_low, user_high),
  FOREIGN KEY (user_low) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (user_high) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS arcade_friendships_by_low
  ON arcade_friendships(user_low, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS arcade_friendships_by_high
  ON arcade_friendships(user_high, status, updated_at DESC);

-- Short-lived Whiteware IO invitations between accepted friends.
CREATE TABLE IF NOT EXISTS arcade_lobby_invites (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  room TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (sender_id) REFERENCES customers(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS arcade_lobby_invites_for_friend
  ON arcade_lobby_invites(recipient_id, expires_at DESC);
