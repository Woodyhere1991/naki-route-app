PRAGMA foreign_keys = ON;

-- Monthly arcade boards. The all-time game_scores table stays as each player's
-- personal best; these rows are what the prize is judged on, so a new player
-- joining in week three still has a real shot at the month.
-- `month` is 'YYYY-MM' worked out in Auckland time, not UTC, so a run at 11pm
-- on the 31st counts to the month the player was actually in.
CREATE TABLE IF NOT EXISTS game_scores_monthly (
  customer_id TEXT NOT NULL,
  game TEXT NOT NULL,
  month TEXT NOT NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (customer_id, game, month),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- Ranking read: one month at a time, highest first, earliest to reach it wins a tie.
CREATE INDEX IF NOT EXISTS game_scores_monthly_board
  ON game_scores_monthly(month, game, best_score DESC, updated_at);

-- Arcade chat. Short public lines from signed-in customers only.
-- `hidden` is a soft delete so a removed message leaves a trace rather than
-- vanishing from the table entirely.
CREATE TABLE IF NOT EXISTS arcade_messages (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS arcade_messages_recent
  ON arcade_messages(hidden, created_at DESC);

-- Rate limiting reads "how many did this person post in the last minute".
CREATE INDEX IF NOT EXISTS arcade_messages_by_author
  ON arcade_messages(customer_id, created_at DESC);
