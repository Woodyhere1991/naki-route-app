-- Aggregate play counts only. No player identity, answers, age, IP or device fields.
CREATE TABLE IF NOT EXISTS kids_activity_daily (
  day TEXT NOT NULL,
  game TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('live','test')),
  starts INTEGER NOT NULL DEFAULT 0,
  finishes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,game,channel)
);
-- Temporary random round receipts prevent double-counting retries and finishes.
CREATE TABLE IF NOT EXISTS kids_activity_rounds (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,
  day TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('live','test')),
  finished INTEGER NOT NULL DEFAULT 0 CHECK(finished IN (0,1)),
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kids_activity_expiry ON kids_activity_rounds(expires_at);
CREATE TRIGGER IF NOT EXISTS kids_activity_started AFTER INSERT ON kids_activity_rounds
BEGIN
  INSERT INTO kids_activity_daily(day,game,channel,starts,finishes)
  VALUES(NEW.day,NEW.game,NEW.channel,1,0)
  ON CONFLICT(day,game,channel) DO UPDATE SET starts=starts+1;
END;
CREATE TRIGGER IF NOT EXISTS kids_activity_finished AFTER UPDATE OF finished ON kids_activity_rounds
WHEN OLD.finished=0 AND NEW.finished=1
BEGIN
  UPDATE kids_activity_daily SET finishes=finishes+1
  WHERE day=NEW.day AND game=NEW.game AND channel=NEW.channel;
END;
