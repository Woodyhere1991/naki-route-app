// Read each booking source once, rather than rescanning all history for every
// customer. Imported bookings match by customer id OR email; exclude the email
// copy when the id already matches so one booking is never counted twice.
export const CUSTOMER_DIRECTORY_QUERY = `WITH customer_history AS (
  SELECT customer_id, created_at FROM bookings
  UNION ALL
  SELECT customer_id, created_at FROM external_bookings
  UNION ALL
  SELECT c.id, e.created_at FROM external_bookings e
    JOIN customers c ON e.email = c.email COLLATE NOCASE
    WHERE e.customer_id IS NOT c.id
  UNION ALL
  SELECT customer_id, created_at FROM jotform_bookings
  UNION ALL
  SELECT c.id, j.created_at FROM jotform_bookings j
    JOIN customers c ON j.email = c.email COLLATE NOCASE
    WHERE j.customer_id IS NOT c.id
), customer_totals AS (
  SELECT customer_id, COUNT(*) AS booking_count, MAX(created_at) AS last_booking_at
  FROM customer_history GROUP BY customer_id
)
SELECT c.*, COALESCE(t.booking_count, 0) AS booking_count,
  MAX(COALESCE(t.last_booking_at, 0), 0) AS last_booking_at
FROM customers c LEFT JOIN customer_totals t ON t.customer_id = c.id
WHERE (?1='' OR LOWER(COALESCE(first_name,'')||' '||COALESCE(last_name,'')||' '||COALESCE(street_address,'')||' '||COALESCE(town,'')||' '||COALESCE(email,'')||' '||COALESCE(phone,'')) LIKE ?2)
ORDER BY (last_booking_at IS NULL), last_booking_at DESC, c.created_at DESC
LIMIT 101 OFFSET ?3`;
