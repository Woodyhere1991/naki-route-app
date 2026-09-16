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
