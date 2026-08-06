-- Tracks whether a customer has actually installed the VIP app to their phone's
-- home screen, so Woody can see it on the Customers screen instead of guessing.
-- Set the first time the account site detects it's running in standalone/installed
-- mode while a customer is signed in; refreshed on every later standalone launch.
ALTER TABLE customers ADD COLUMN pwa_installed_at INTEGER;
ALTER TABLE customers ADD COLUMN pwa_last_seen_at INTEGER;
