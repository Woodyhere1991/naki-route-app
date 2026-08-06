CREATE TABLE IF NOT EXISTS jotform_bookings (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE,
  form_id TEXT NOT NULL,
  customer_id TEXT,
  status TEXT NOT NULL DEFAULT 'NEW',
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
  completed_at INTEGER,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS jotform_bookings_customer
  ON jotform_bookings(customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS jotform_bookings_email
  ON jotform_bookings(email, created_at DESC);

CREATE INDEX IF NOT EXISTS jotform_bookings_owner_inbox
  ON jotform_bookings(status, created_at DESC);

CREATE INDEX IF NOT EXISTS jotform_bookings_sheet_retry
  ON jotform_bookings(sheet_sync_status, created_at);
