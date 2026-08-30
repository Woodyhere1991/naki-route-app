ALTER TABLE customers ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_share_token ON customers(share_token) WHERE share_token IS NOT NULL;
