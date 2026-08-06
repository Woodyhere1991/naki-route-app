ALTER TABLE bookings ADD COLUMN pickup_date TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN pickup_window TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN customer_note TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN cancelled_at INTEGER;
ALTER TABLE bookings ADD COLUMN cancellation_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE jotform_bookings ADD COLUMN pickup_date TEXT NOT NULL DEFAULT '';
ALTER TABLE jotform_bookings ADD COLUMN pickup_window TEXT NOT NULL DEFAULT '';
ALTER TABLE jotform_bookings ADD COLUMN customer_note TEXT NOT NULL DEFAULT '';
ALTER TABLE jotform_bookings ADD COLUMN cancelled_at INTEGER;
ALTER TABLE jotform_bookings ADD COLUMN cancellation_reason TEXT NOT NULL DEFAULT '';
