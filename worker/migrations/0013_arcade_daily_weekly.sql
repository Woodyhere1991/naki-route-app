PRAGMA foreign_keys = ON;

-- Daily and weekly arcade boards, alongside the existing monthly and all-time
-- ones. Same shape as game_scores_monthly - one best score per player per
-- game per period, so the whole history is never held in one place.
-- `day` is 'YYYY-MM-DD' and `week` is ISO 'YYYY-Www', both worked out in
-- Auckland time so a late-night run lands in the period the player was
-- actually in.
CREATE TABLE IF NOT EXISTS game_scores_daily (
  customer_id TEXT NOT NULL,
  game TEXT NOT NULL,
  day TEXT NOT NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (customer_id, game, day),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS game_scores_daily_board
  ON game_scores_daily(day, game, best_score DESC, updated_at);

CREATE TABLE IF NOT EXISTS game_scores_weekly (
  customer_id TEXT NOT NULL,
  game TEXT NOT NULL,
  week TEXT NOT NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (customer_id, game, week),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS game_scores_weekly_board
  ON game_scores_weekly(week, game, best_score DESC, updated_at);
