# Spring clean group bookings

The owner's 19 October 2026 request authorises a working share link now. Street, date, household threshold and final payer details remain pending. The link accepts requests at the locked NZD $10 discounted item rate, described to households as a discounted price for this spring clean, with no individual payment requested. No event date is promised.

## Source and scope

Lauren Darrah's “Bulk collection of whiteware” conversation was read in nakiwhitewareremoval@gmail.com. Woody's 15 October reply offered $10 per metal whiteware item for more than about five households on the same street. Lauren's 19 October reply asked whether the organiser could receive one invoice and said the event was still being considered. The owner then explicitly asked to make the special link work and leave the remaining details for later.

The form currently offers the types named in that conversation: fridges/freezers, washing machines, dryers and ovens/stoves. It does not offer furniture or packaging. No final sponsor payment agreement is represented as confirmed.

## Using it

- Bookings has a dedicated Kāinga Ora spring clean group panel. Open it to copy the full share URL or review the complete participant list.
- The public form requires name, phone, a matching confirmation phone number, an email address confirmed with a matching second entry, street number/address, town and item quantities. The worker refuses requests with a missing or malformed email so the server rule matches the form. Access notes are optional. It does not require an account.
- Every booking and run stop carries the group badge. Group price snapshots remain server-side. The source booking ID is preserved in the Sheet backup, so imported copies retain the badge.
- To change priced items or the pickup address, cancel and replace the request before invoicing. Contact details and notes can still be corrected through Bookings. Deleting a group source record is refused to retain invoice traceability.
- Select completed pickups, preview, and save one invoice draft. Each person has item quantities, unit prices and a subtotal; the invoice has one grand total. Saved drafts reserve their pickups. Void an unsent draft to correct its selection.
- When the payer is confirmed, check their name/email, tick the review checkbox, review the final PDF, then tap Email. Nothing is sent automatically. The participant list is never public and the combined PDF is not placed in each household's account.
- Sent or uncertain-send invoices cannot be retried or voided automatically. Check Sent mail and reconcile any correction first. The original PDF is stored privately for owner download.

## Implementation and safeguards

Migration 0032 creates the programme, immutable booking price snapshots, invoice snapshots and unique pickup claims. The initial link accepts requests at the owner's instruction. The normal Worker auth protects all owner programme endpoints; integration API keys cannot access them. Public responses expose only offer details.

Booking retries use a random UUID and an exact canonical request fingerprint. Invoice draft claims use an atomic D1 batch and verify the booking is still completed at its reviewed version. Unique claims prevent two drafts billing the same pickup. Price/address edits and invoice-covered status changes are blocked at the database layer too.

Legacy individual invoice, receipt and payment reminder send paths reject group bookings. Run cards hide individual payment documents, and group confirmation/reminder wording removes the usual cash instruction. Group invoice sending claims a single send before contacting one provider; uncertain outcomes stay locked to prevent duplicated delivery.

## Validation limits

All booking, invoice and email tests use isolated SQLite/browser fixtures with stubbed delivery. No live customer test bookings, messages or invoices are created. A provider acceptance is not delivery proof. Physical-phone behaviour and real organiser/pickup details remain human checks.

The full pre-release backend suite had four unchanged baseline failures in field-reliability, route-optimise (two), and voice-assistant. The same four were reproduced against HEAD's unchanged index.html. Focused programme and booking regression tests and Chromium/WebKit browser checks are recorded in the release receipt.
