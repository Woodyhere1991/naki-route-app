CREATE TABLE IF NOT EXISTS external_bookings (
  id TEXT PRIMARY KEY,
  external_key TEXT NOT NULL UNIQUE,
  sync_token_hash TEXT NOT NULL,
  customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'ADDED_TO_RUN',
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL COLLATE NOCASE,
  street_address TEXT NOT NULL DEFAULT '',
  town TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  rural_option TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL DEFAULT '[]',
  additional_info TEXT NOT NULL DEFAULT '',
  total_cents INTEGER NOT NULL DEFAULT 0,
  quote_required INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS external_bookings_customer
  ON external_bookings(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS external_bookings_email
  ON external_bookings(email, created_at DESC);

CREATE INDEX IF NOT EXISTS external_bookings_token
  ON external_bookings(sync_token_hash);
