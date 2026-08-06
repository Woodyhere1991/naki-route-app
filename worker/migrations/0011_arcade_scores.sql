PRAGMA foreign_keys = ON;

-- Arcade leaderboards. One row per customer per game, holding their best run.
-- Starting empty is deliberate: this is the fresh reset of everyone's points.
CREATE TABLE IF NOT EXISTS game_scores (
  customer_id TEXT NOT NULL,
  game TEXT NOT NULL,
  best_score INTEGER NOT NULL DEFAULT 0,
  played_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (customer_id, game),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- Ranking read: highest score first, earliest to reach it wins a tie.
CREATE INDEX IF NOT EXISTS game_scores_board
  ON game_scores(game, best_score DESC, updated_at);

-- Optional arcade display name. Blank means "use my first name".
ALTER TABLE customers ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
