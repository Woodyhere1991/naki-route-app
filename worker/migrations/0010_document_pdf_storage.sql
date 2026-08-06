-- The portal used to only show a re-derived summary of an invoice/receipt;
-- now the exact PDF that was emailed is stored (R2) alongside the real item
-- list and address it was built from, so the two never drift apart.
ALTER TABLE booking_documents ADD COLUMN items_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE booking_documents ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE booking_documents ADD COLUMN filename TEXT NOT NULL DEFAULT '';
ALTER TABLE booking_documents ADD COLUMN r2_key TEXT NOT NULL DEFAULT '';
