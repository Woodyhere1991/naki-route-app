# Naki Route App — handover for future sessions

Booking/account backend (`naki-route-api` Worker + D1) and the owner "Naki Pickup
Run" app. The customer website is a **separate** project (`customer-site`).

## The rule that keeps being broken: never claim something happened

Audits on 16 September 2026 found the same class of bug repeatedly — the app
telling Woody work was done when it was not. **Whenever a send or a save has a
result, capture it and word the message from that result.** The correct pattern
already exists in the codebase (the quote email at `index.html`, which flashes
"the price email did not send"). Fixed so far:

- A receipt or invoice is **not** marked sent/paid on the share-sheet or Gmail
  fallback — those only *prepare* it. `done()` is called only after Woody
  confirms. A Gmail link opens a compose window with **no attachment**.
- The confirmation email result is captured (`confirmationEmailed`), so
  "confirmed and emailed" is never shown on a failed send.
- Bulk-send warnings are joined, not overwritten, and each failed confirmation
  writes an `EMAIL_FAILED` booking event so it survives the banner.
- The cloud backup no longer includes the geocode cache (`GEO`), which grows
  forever and was pushing the payload past the server's 4 MB limit — past that,
  every save was refused while the UI said "waiting to sync".

Two traps to remember when touching this app:

- `flagField()` (customer page) must not bail when a control has no `.field`
  wrapper — the pickup-area `<select>` has none, and that was the field customers
  most often left blank.
- Never let a customer's edit zero `quote_cents`/`quoted_at`. That silently threw
  away a price Woody had agreed.

## Deploy order (do it in this order)

Before any remote schema change, save a fresh private database export, inspect the live schema and `d1_migrations`, and check the exact pending migration list. This database has historically had migrations applied manually, so the registry alone may lag the schema. Never replay an older table-rebuild migration to reconcile that difference. Apply only the reviewed new migration below. On 29 September an unreviewed `migrations apply` replayed 0027/0028 and cleared requested dates; recovery is recorded in [the release notes](RELEASE-NOTES-2026-09-29.md).

1. **Migration first** — `wrangler d1 execute naki-customer-bookings --remote --file=migrations/NNNN_x.sql`
2. **Worker** — `wrangler deploy` from `naki-route-app/worker`
3. **Owner app** — stage `index.html`, `manifest.webmanifest`, `sw.js` and `assets`
   into a staging folder, then `wrangler pages deploy . --project-name naki-pickup-run`
   **from inside the staging folder**. Never deploy the app folder itself.
4. **Website** — only ever via `customer-site\DEPLOY-SITE.cmd`.
5. Bump `sw.js`'s `CACHE` constant whenever you change the owner app, or phones
   keep the old cached page.

Wrangler lives at `whiteware-io\node_modules\wrangler\bin\wrangler.js`. Run it as
`node <that path>`; `npx` is blocked by PowerShell execution policy.

## Schema rules that have bitten, and will again

- **`bookings.customer_id` is nullable** (migration 0027), `ON DELETE SET NULL`.
  It was `NOT NULL ... RESTRICT`, which made **every phone booking fail** because
  the AI receptionist saves callers who have no account. `jotform_bookings` and
  `external_bookings` always allowed NULL — `bookings` was the odd one out.
- **Rebuilding a table is dangerous here.** `booking_events` has `ON DELETE
  CASCADE` on `bookings`. `DROP TABLE bookings` with `PRAGMA foreign_keys=ON`
  **deletes every event row**. Migration 0027 parks the events in a temp table
  first for this reason. If you rebuild any table, check what cascades into it.
- A migration that turns `PRAGMA foreign_keys=OFF` **must turn it back ON**, or
  every later foreign key on that connection is silently unenforced.
- SQLite cannot drop an indexed column in place; rebuild the table instead.

**Always test a schema migration against a real export before applying it:**

```
node <wrangler> d1 export naki-customer-bookings --remote --output=worker/tmp/<date>-backup.sql
```

Then replay it into `node:sqlite`, run the migration, and assert the row counts
for `bookings`, `booking_events`, `booking_documents` are unchanged. Export the
backup into `worker/tmp/` — it is gitignored and **never** published.

## Adding a migration

`migrations/*.sql` are applied **by hand** — D1 does not track which have run.
Number them in order and apply each exactly once. Test fixtures should read the
whole directory in sorted order rather than listing files by hand: a hand-written
list silently goes stale the moment a migration adds a column an endpoint reads.

## Form vs server: keep the rules identical

Customer-facing rules exist in **two** places and must agree:

| Rule | Customer page | Worker |
|---|---|---|
| One name is enough | `profileComplete()` | `PUT /customer/profile` |
| Pickup area required | `address-rural` select | `RURAL_PRICES` lookup |

A mismatch is invisible until a real customer is blocked. This happened: the form
was relaxed to accept a first name only while the server still demanded a surname,
so those customers could never save a profile and could never book.

The booking POST must also accept either name box (fixed 1 October 2026):
checking only `first_name` refused customers whose valid profile used `last_name`.
Older flat profiles have no address ID. The page uses `saved`, which the booking
endpoint accepts; an empty option fails the required dropdown before reaching it.

`ITEM_PRICES` and `RURAL_PRICES` in `worker/src/customer.js` must also match the
`prices`/`travel` maps in `customer-site/account.html` **exactly** — the server
rejects any item name it does not know.

## Customer data gotchas

- A booking taken by phone has `customer_id = NULL` and is claimed by its email on
  first sign-in (`verify-code` / profile-invite).
- `bookings.additional_info`: only fall back to the saved address notes when the
  field is **absent** (`!= null`), not when it is empty — `"" || saved` puts a
  stale gate code back on a booking the customer just cleared.
- Changing a booking replaces its photo list. Do not clear photos before the
  replacements are safely written, or a failed upload destroys them.
- A receipt settles an invoice **for the same booking only**, never account-wide.

## Owner-visible telemetry

- `booking_dropoffs` records why a customer got stuck. Public endpoint
  (`POST /customer/dropoff`) because a blocked customer is not signed in. It
  stores a **fixed reason code only** — never free text, a name or an email.
- Shown to Woody under Customers → "🚧 Where people get stuck", which also counts
  failed confirmation emails (`EMAIL_FAILED` booking events).

## Testing

`node --test worker/tests/*.test.mjs` from `naki-route-app`.

One pre-existing failure is expected and unrelated: `voice-assistant.test.mjs`
("the session is built with GPT-Live…") fails because `text_booking_link` is in
the implementation but not the test's expected tool list. It is not caused by
booking work. Do not "fix" it by deleting the tool.

## Check payment (bank look-up)

`🏦 Check payment` on an owing booking calls `POST /owner/payment-check`
(`worker/src/bank-payments.js`). The Worker reads the ANZ "Business Current
Account" through Akahu, cleared **and pending** (same-day payments only show as
pending), from 14 days before the invoice. It matches the invoice amount plus the
customer's name or street number + street name, shows split payments and other
amounts, and ignores Woody's own transfers. It never marks anything paid: the
result's button opens the usual receipt. Owner sign-in only; bot keys get 403.
Secrets `AKAHU_APP_TOKEN` / `AKAHU_USER_TOKEN` are Worker secrets (set 20 Oct 2026
from `OneDrive\Desktop\bank managment\akahu.env`); never put them in code or the app.

## Paid is not done (20 Oct 2026, Woody's rule)

"Mark paid" records money only. It never sets COMPLETED/DONE and never sends a receipt;
the booking stays New or Scheduled and shows a green PAID tag. Sending the receipt after
pickup is the step that marks it done. Server record: `POST /owner/payments` (owner only)
writes the invoice id to R2 `owner-analytics/invoice-payments-v1.json`
(`worker/src/invoice-payments.js`); `paidDocuments()` then treats that invoice as not
owing in Bookings, the customer page and Earnings. A later invoice is owing again.
On the phone, a paid-but-unreceipted ledger stop keeps its card until the receipt goes out.
Tapping Navigate on a stop with an owing invoice runs the bank check in the background
(not again within 10 minutes or once a payment is found) and the stop card shows the result.

## Navigate speed and the Bertrand Road Bridge check (21 Oct 2026)

- `NakiRouting.mightCross` now skips the route-server bridge check when both ends are on the
  same bank of the Waitara River (`riverBank()`, river line from OpenStreetMap relation 12336327,
  simplified to 50 m). Near the river (500 m), east of the upper river, or opposite banks: the
  full check still runs. On real customer trips the check now runs on about 12% of trips, down
  from 63%. Validated: 250 same-bank OSRM routes, none used the bridge; every bridge route found
  (5) is still checked. Re-validate if the river line or the bridge location ever changes.
- Opening a booking card warms Navigate (address lookup, GPS fix, bridge check) so the tap is quick.
- Mark paid and the receipt shortcut from a bank match ask first in the app's own Yes/Cancel box.

## Cancelled, rebooked and deleted bookings (21 Oct 2026)

- Cancelled and declined bookings have their own **Cancelled** tab in Bookings; they no longer count under Done. **Restore** calls `POST /owner/bookings/:id/restore` (back to New, no day, cancel reason and time cleared).
- Customers see a **Cancelled pickups** list on their account with **Rebook this pickup** (`POST /customer/bookings/:id/rebook`, Woody is emailed) and **Remove from my list** (`POST /customer/bookings/:id/remove`). Remove only hides it from that customer (KV `custhide:<customerId>`); Woody keeps the record.
- Owner **Delete** now copies the booking, its events, documents and owner note to R2 `deleted-bookings/<id>.json` *before* deleting the rows. If that copy fails, nothing is deleted. Photos and PDFs are kept. **Deleted bookings** (bottom of Bookings) lists and restores them. The daily cron (`emptyBin`) removes entries older than 30 days together with their photos and PDFs.
- All of this is in `worker/src/booking-recovery.js`; no schema change. Tests: `worker/tests/booking-recovery.test.mjs`, `tests/cancelled-deleted-browser.cjs`, `customer-site/tests/cancelled-rebook-browser.cjs`.
