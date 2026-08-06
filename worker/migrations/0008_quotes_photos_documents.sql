-- A "quote needed" job can now be priced from the owner app instead of
-- dropping out of the system into a manual email.
ALTER TABLE bookings ADD COLUMN quote_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN quote_note TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN quoted_at INTEGER;

ALTER TABLE jotform_bookings ADD COLUMN quote_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jotform_bookings ADD COLUMN quote_note TEXT NOT NULL DEFAULT '';
ALTER TABLE jotform_bookings ADD COLUMN quoted_at INTEGER;

ALTER TABLE external_bookings ADD COLUMN quote_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE external_bookings ADD COLUMN quote_note TEXT NOT NULL DEFAULT '';
ALTER TABLE external_bookings ADD COLUMN quoted_at INTEGER;

-- Appliance photos live in KV; the booking only records how many there are.
ALTER TABLE bookings ADD COLUMN photo_count INTEGER NOT NULL DEFAULT 0;

-- What we actually invoiced or receipted, so the customer can see it in their
-- account and does not have to ask for a copy.
CREATE TABLE IF NOT EXISTS booking_documents (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL COLLATE NOCASE,
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  reference TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS booking_documents_email
  ON booking_documents(email, created_at DESC);

CREATE INDEX IF NOT EXISTS booking_documents_booking
  ON booking_documents(booking_id);
