-- A booking taken over the phone has no customer account, because the caller
-- often gives no email. bookings.customer_id was NOT NULL with a RESTRICT
-- foreign key, so every phone booking was rejected and the AI receptionist
-- silently saved nothing. The column is rebuilt as nullable with ON DELETE SET
-- NULL, matching jotform_bookings and external_bookings, which already allow it.
--
-- customer_id is indexed on its own, so it cannot be dropped in place; the table
-- has to be rebuilt. Two dangers are handled explicitly:
--   1. booking_events has ON DELETE CASCADE, and DROP TABLE bookings with
--      enforcement on deletes every child row. The events are parked in a
--      temp table and restored, so no history can be lost either way.
--   2. Enforcement is turned back on at the end, so later foreign keys on this
--      connection are not silently unenforced.

PRAGMA foreign_keys = OFF;

-- Park the children so dropping the parent cannot take them with it.
CREATE TABLE booking_events_parked AS SELECT * FROM booking_events;
DELETE FROM booking_events;

CREATE TABLE bookings_new (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'NEW',
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  street_address TEXT NOT NULL,
  town TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  rural_option TEXT NOT NULL,
  items_json TEXT NOT NULL,
  additional_info TEXT NOT NULL DEFAULT '',
  referral_source TEXT NOT NULL DEFAULT '',
  referral_details TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL DEFAULT 0,
  quote_required INTEGER NOT NULL DEFAULT 0,
  sheet_sync_status TEXT NOT NULL DEFAULT 'PENDING',
  sheet_sync_attempts INTEGER NOT NULL DEFAULT 0,
  sheet_last_error TEXT NOT NULL DEFAULT '',
  sheet_synced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pickup_date TEXT NOT NULL DEFAULT '',
  pickup_window TEXT NOT NULL DEFAULT '',
  customer_note TEXT NOT NULL DEFAULT '',
  cancelled_at INTEGER,
  cancellation_reason TEXT NOT NULL DEFAULT '',
  quote_cents INTEGER NOT NULL DEFAULT 0,
  quote_note TEXT NOT NULL DEFAULT '',
  quoted_at INTEGER,
  photo_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

INSERT INTO bookings_new (
  id, customer_id, status, first_name, last_name, phone, email, street_address, town, area,
  rural_option, items_json, additional_info, referral_source, referral_details,
  total_cents, quote_required, sheet_sync_status, sheet_sync_attempts, sheet_last_error,
  sheet_synced_at, created_at, updated_at, pickup_date, pickup_window, customer_note,
  cancelled_at, cancellation_reason, quote_cents, quote_note, quoted_at, photo_count
)
SELECT
  id, customer_id, status, first_name, last_name, phone, email, street_address, town, area,
  rural_option, items_json, additional_info, referral_source, referral_details,
  total_cents, quote_required, sheet_sync_status, sheet_sync_attempts, sheet_last_error,
  sheet_synced_at, created_at, updated_at, pickup_date, pickup_window, customer_note,
  cancelled_at, cancellation_reason, quote_cents, quote_note, quoted_at, photo_count
FROM bookings;

DROP TABLE bookings;

ALTER TABLE bookings_new RENAME TO bookings;

-- Restore the parked events against the rebuilt table.
INSERT OR IGNORE INTO booking_events (id, booking_id, event_type, detail, created_at)
SELECT id, booking_id, event_type, detail, created_at FROM booking_events_parked;
DROP TABLE booking_events_parked;

CREATE INDEX IF NOT EXISTS bookings_customer
  ON bookings(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_owner_inbox
  ON bookings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_sheet_retry
  ON bookings(sheet_sync_status, created_at);

PRAGMA foreign_keys = ON;