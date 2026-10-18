-- Programme data stays private in D1. This owner-authorised link accepts requests; dates and payer remain unconfirmed.
CREATE TABLE partner_programmes (
 id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, label TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
 terms_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL
);
CREATE TABLE programme_bookings (
 booking_id TEXT NOT NULL PRIMARY KEY REFERENCES bookings(id) ON DELETE RESTRICT,
 programme_id TEXT NOT NULL REFERENCES partner_programmes(id),
 request_key TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL,
 snapshot_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX programme_bookings_group ON programme_bookings(programme_id);
CREATE TABLE programme_invoices (
 id TEXT PRIMARY KEY, programme_id TEXT NOT NULL REFERENCES partner_programmes(id),
 request_key TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL,
 recipient_email TEXT NOT NULL DEFAULT '', recipient_name TEXT NOT NULL DEFAULT '',
 pdf_r2_key TEXT NOT NULL DEFAULT '', emailed_at INTEGER,
 snapshot_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','VOID','SENDING','SENT','SEND_UNKNOWN')),
 created_at INTEGER NOT NULL
);
CREATE TABLE programme_invoice_claims (
 booking_id TEXT NOT NULL PRIMARY KEY REFERENCES programme_bookings(booking_id),
 invoice_id TEXT NOT NULL REFERENCES programme_invoices(id)
);
-- Prevent ordinary edit/delete/sync paths changing a promised sponsored price.
CREATE TRIGGER programme_price_locked BEFORE UPDATE OF items_json,total_cents,quote_cents,quoted_at,street_address,town,rural_option ON bookings
WHEN EXISTS(SELECT 1 FROM programme_bookings p WHERE p.booking_id=OLD.id)
 AND (NEW.items_json IS NOT OLD.items_json OR NEW.total_cents IS NOT OLD.total_cents
 OR NEW.quote_cents IS NOT OLD.quote_cents OR NEW.quoted_at IS NOT OLD.quoted_at
 OR NEW.street_address IS NOT OLD.street_address OR NEW.town IS NOT OLD.town OR NEW.rural_option IS NOT OLD.rural_option)
BEGIN SELECT RAISE(ABORT,'Programme price and address are locked; cancel and replace the booking before invoicing'); END;
CREATE TRIGGER programme_invoice_status_locked BEFORE UPDATE OF status ON bookings
WHEN NEW.status IS NOT OLD.status AND EXISTS(SELECT 1 FROM programme_invoice_claims c WHERE c.booking_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Void the group invoice draft before changing this pickup'); END;
INSERT INTO partner_programmes(id,token,label,terms_json,updated_at,active)
VALUES('spring-clean-lauren-202610',lower(hex(randomblob(18))),'Kāinga Ora spring clean',
'{"unitCents":1000,"payerName":"Kāinga Ora","payerEmail":"lauren.darrah@kaingaora.govt.nz","payerConfirmed":false,"street":"","town":"","pickupDate":"","minimumHouseholds":null,"termsConfirmed":false}',0,1);
