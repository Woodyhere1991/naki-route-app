-- Customers keep telling us which day suits them ("Friday will be great"), but
-- the booking form had nowhere to say it, so it arrived as a separate text or
-- email Woody had to chase. This is what the CUSTOMER asked for.
--
-- It is deliberately separate from pickup_date: pickup_date is the day Woody has
-- CONFIRMED and is shown to the customer as their collection day. Overwriting
-- that with a request would tell someone their pickup is booked when it is not.
ALTER TABLE bookings ADD COLUMN requested_date TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN requested_window TEXT NOT NULL DEFAULT '';
