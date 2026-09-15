-- Where customers actually get stuck. A failed booking attempt used to leave no
-- trace at all, so a person who tried three times and gave up was invisible.
-- Only the reason and a coarse stage are kept: no free text, no name, no email.
CREATE TABLE IF NOT EXISTS booking_dropoffs (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS booking_dropoffs_created
  ON booking_dropoffs(created_at DESC);

CREATE INDEX IF NOT EXISTS booking_dropoffs_stage
  ON booking_dropoffs(stage, created_at DESC);
