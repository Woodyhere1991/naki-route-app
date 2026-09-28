CREATE TABLE IF NOT EXISTS owner_booking_notes (
  booking_id TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
