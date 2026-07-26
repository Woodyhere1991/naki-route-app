PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  street_address TEXT NOT NULL DEFAULT '',
  town TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  rural_option TEXT NOT NULL DEFAULT '',
  referral_source TEXT NOT NULL DEFAULT '',
  referral_details TEXT NOT NULL DEFAULT '',
  access_notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS login_codes_lookup
  ON login_codes(email, role, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  customer_id TEXT,
  role TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_customer ON sessions(customer_id);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
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
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS bookings_customer
  ON bookings(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_owner_inbox
  ON bookings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_sheet_retry
  ON bookings(sheet_sync_status, created_at);

CREATE TABLE IF NOT EXISTS booking_events (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS booking_events_booking
  ON booking_events(booking_id, created_at);
