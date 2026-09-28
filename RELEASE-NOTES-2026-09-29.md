# Pickup notes and pricing — 29 September 2026

Owner approved publishing the pricing changes and requested that Scheduled pickup notes survive removal back to Bookings.

## Delivered

- `4b01cfc`: collection minimum $10 before the travel fee; $5 items retain their add-on rates.
- `8f111c5`: owner-only pickup notes persist separately from customer notes. Scheduled edits save to the booking; removal/bulk return waits for a successful note save. Failed saves retain local edits; stale edits return a conflict. Bookings has a Pickup note editor, and notes carry back into Scheduled.
- Worker `714776ad-85ee-4ba5-a1b8-10f0394361be`; Pages `https://87e5b17c.naki-pickup-run.pages.dev`; cache `naki-field-20260929-pickup-notes`. Both commits pushed to origin/main.
- 231 Node tests and actual desktop/mobile note-carryover browser checks passed. Canonical and immutable Pages have the new note controls/cache. Authenticated live Bookings displayed Gabby's current note and opened the new pickup-note editor; cancelled without altering her record.

## Gabby investigation

The old Scheduled removal path discarded the local pickup note without saving it to the cloud booking. This matches the reported failure, but no historical note-edit audit proves Gabby's exact edit/removal sequence. Her manually re-added “AFTER 10th OCTOBER” is present. Her confirmed pickup date remains 2 October 2026; it was not changed and no customer messages were sent by this investigation.

## Migration incident and recovery

At 2026-09-28 20:00:10–12 UTC, `wrangler d1 migrations apply` replayed 0025–0030 before adding 0031 because the registry did not reflect previously manual applications. Migration 0027 rebuilt bookings without requested_date/requested_window; 0028 re-added those fields empty. Confirmed pickup dates, notes, bookings and events are preserved by the rebuild.

Read-only checks found 159 bookings with no requested dates, versus 154 bookings and 20 requested dates in the R2 snapshot `db-backups/2026-09-27.json` saved at 21:00:44.950 UTC. There were no customer CHANGED events after that snapshot. All five later bookings came from the customer website, whose form does not submit requestedDate/requestedWindow; no later owner/bot creation could introduce such a preference through its separate form.

Recovered precisely the 20 saved requested_date values, guarded on the current fields being empty and no later CHANGED event. No confirmed date, note, status or updated_at field was touched. A fresh remote read matched requested_date/requested_window for all 154 snapshot bookings, with zero mismatches and all 20 dates restored. No whole-database rollback was used. Private recovery evidence is retained under ignored `tmp/`, never in a public staging folder. The user was informed of the incident and recovery.

Future schema changes must follow the added preflight in HANDOVER.md: fresh private export, live schema/registry/pending-list comparison, and only the reviewed new migration. Do not blindly replay historical migrations.
