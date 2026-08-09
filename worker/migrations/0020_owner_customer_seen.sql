-- Existing customers have already been through the owner list. New profiles
-- deliberately leave this blank until Woody opens their card on Customers.
ALTER TABLE customers ADD COLUMN owner_seen_at INTEGER;

UPDATE customers
SET owner_seen_at = created_at
WHERE owner_seen_at IS NULL;
