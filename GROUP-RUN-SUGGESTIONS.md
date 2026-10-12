# Group run suggestions — local review

Built in branch `codex/group-run-suggestions`, isolated from the normal app checkout. **Not deployed. No current production bookings or runs were changed.**

## Try the synthetic demo

Run `node scripts/preview-run-suggestions.cjs` from this folder, then open:

http://127.0.0.1:8788/?suggestions-demo=1

The demo labels all examples as synthetic, fills example planning inputs, uses a synthetic forecast, and simulates approval in memory. Its API base is redirected to a local demo endpoint, so it cannot call the production booking API. Tick the availability/load checkbox, choose **Suggest groups**, then edit or approve a group. There is no deployment step in the launcher.

## What the first version does

- **Suggest runs** on Bookings proposes whole groups of unassigned bookings. **Suggest bookings for this run** is under Scheduled → Manage; the dialog also lets you choose an existing run.
- Woody enters available days, start/finish hours, start/return town, pickup/item limits, loading minutes, maximum run time and nearby-area limit. These are explicit planning inputs, not inferred from a temporary injury or old runs.
- Groups match customer requested/confirmed dates, geography and entered limits. Existing pending stop order and unloads stay in place; new suggestions are ordered on the final leg. One proposed new group per free day avoids assuming overlapping owner availability. Existing active runs reserve their saved dates.
- Date conflicts, unresolved quotes and customer time windows are held for manual review. Customer/owner notes must be explicitly reviewed before approval. Missing towns/addresses are held. Recognized town-only locations can form a provisional group; approval requires acknowledgement that missing pins go to **Needs address**, rather than inventing street coordinates.
- Existing validated local address-cache pins can improve ordering without an external geocoding request. Straight-line distance × 1.4 and 45 km/h yield **approximate** distance/time, with entered loading time. This is a transparent heuristic, not a mathematically optimal road route or a measured trip time. Actual vehicle volume/weight is not inferred from item counts; Woody must verify loading.
- The preview shows reasons, confidence, editable day, membership and stop order, weather coverage/update time, and held-booking reasons. Edits update the visible item/pickup/time estimate and revalidate at approval.
- **Approve this group** rechecks owner authentication, selected run, availability, booking and note revisions, current run revision, customer dates, duplicate membership and limits. A single guarded D1 update saves the whole run group and accepted decision together. No per-booking partial scheduling is used. Duplicate/lost-response retries replay the same approval; changed payloads with the same reference are refused. Previews expire after 30 minutes.
- Approved group placement changes only the owner's saved run plan. Booking status, promised pickup date/window and customer messages stay untouched. A group containing town-only stops retains them under Needs address until Woody checks their pins. Old app booking features remain available.

## Weather and privacy

Reuses `worker/src/field-weather.js` with **MET Norway**, bypassing the optional paid Google Weather path. Only fixed public town-centre coordinates and locality names go to the provider. No customer address, contact, booking ID or pickup coordinate goes to weather/routing providers during suggestion generation. Approval does not automatically trigger external route calculation.

Weather only breaks ties after hard eligibility/count constraints, and only when all compared alternatives have fresh, complete rain and wind coverage. Partial, missing, stale or out-of-horizon forecasts do not receive invented rankings. The UI displays actual returned forecast dates and update times.

Primary references checked 7 October 2026 NZ time:

- [MET Locationforecast data model](https://docs.api.met.no/doc/locationforecast/datamodel.html): global forecasts extend up to 10 days; fields and intervals vary, and global historical forecasts are unavailable. The feature uses actual available days rather than promising a fixed horizon.
- [MET API terms](https://docs.api.met.no/doc/TermsOfService): reuse the existing identifiable User-Agent/cache behavior.
- [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/): 100 bound parameters and a 2 MB row limit. Approval uses at most three JSON revision lists rather than five parameters per booking, and checks combined current/previous backup size conservatively before writing.

## Feedback history

Suggested, edited, rejected and accepted groups are appended to `naki_run_suggestion_audit_v1` on the device, with stable booking/run IDs, days, reasons, confidence and owner planning inputs. The existing backup mechanism includes this key on normal subsequent saves/exports. Accepted groups additionally keep a decision record in account run-store shared data in the same atomic write as the group. Retry fingerprints are hashes, not customer address text.

This is the first feedback capture, not a trained model or a permanent execution log. Device-only events are not instantly cross-device synchronized; existing backup/restore behavior still applies. The audit refuses to silently discard history when its 2,000-event limit is reached. Immutable trip-arrival/departure logging and model training are outside this slice.

## Verification and remaining inputs

Verification uses synthetic bookings and SQLite, including the real migration chain. The existing live Cloudflare login was previously rejected; no authentication reset, new credential, scope change or production query/write was attempted for implementation. Browser transport is intercepted in tests, and screenshots contain synthetic examples only.

Checks cover multiple towns, existing capacity and unloads, conflicting dates/windows, missing pins, unavailable/partial weather, editable membership/order/day, owner availability, pending completions, duplicate assignments/clicks, stale previews, cancelled/completed bookings, changed notes, races at the atomic write, storage/API failure boundaries, KV mirror failure, large groups and owner/integration access boundaries. Existing backup and note-carryover tests are included. Browser QA covers 320, 390 and 1280 px, with a second complete verification pass.

Evidence files are under `output/`: `suggestions-verification-pass-1.txt`, `suggestions-verification-pass-2.txt`, browser pass logs and synthetic preview PNGs.

Before real use: restore existing authenticated access and verify deployed schema; Woody supplies current availability, capacity and travel/loading limits in the dialog and reviews customer notes. This version conservatively holds explicit customer time windows for manual planning. Releasing later requires the normal focused Worker/Pages workflow; no schema migration or new service credential is introduced by this change.
