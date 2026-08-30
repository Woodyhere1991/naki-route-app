CREATE TABLE IF NOT EXISTS customer_share_tokens (
  token TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS customer_share_tokens_customer
  ON customer_share_tokens(customer_id);
