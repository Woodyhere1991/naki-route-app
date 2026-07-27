PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customer_addresses (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  street_address TEXT NOT NULL,
  town TEXT NOT NULL,
  area TEXT NOT NULL DEFAULT '',
  rural_option TEXT NOT NULL,
  access_notes TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS customer_addresses_customer
  ON customer_addresses(customer_id, is_default DESC, sort_order, created_at);

INSERT OR IGNORE INTO customer_addresses (
  id, customer_id, label, street_address, town, area, rural_option,
  access_notes, is_default, sort_order, created_at, updated_at
)
SELECT
  'PRIMARY-' || id, id, 'Home', street_address, town, area, rural_option,
  access_notes, 1, 0, created_at, updated_at
FROM customers
WHERE street_address <> '' AND town <> '' AND rural_option <> '';
