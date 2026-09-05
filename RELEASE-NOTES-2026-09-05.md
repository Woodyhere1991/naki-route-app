# Pickup Run field improvements - 5 September 2026

- Scheduled puts the next pickup first, with Navigate, Done and Call together. Other actions are under More actions; route tools are under Route options.
- Town groups, manual message text, pickup history and the existing browser storage mode are preserved.
- Saving status is visible. Failed account uploads and payment-reminder cancellations retry after reconnection. The account also retains daily backup snapshots for eight days.
- Texts are labelled ready until the owner confirms they sent them in Messages. Emails track individual success/failure and large sends are split into groups of 40.
- Sending and payment reminder actions require the existing owner sign-in. Stable request references prevent replaying the same accepted request on a connection retry; uncertain results require checking Sent mail.
- Search reaches older records. Lists load additional pages and documents are fetched only for those records. Booking/customer polling pauses when hidden and runs less often.
- Map and PDF libraries load when needed. A service worker caches only the app shell and bundled libraries, so a previously opened pickup list can reopen offline. Fresh weather, new bookings, email, road routing and map tiles require connectivity.
- Weather uses MET Norway's worldwide forecast with attribution, cached on the Worker. It follows the collection day and shows town forecasts, native time intervals, forecast age and missing values. Google weather remains optional if a key is configured; no paid provider or Google AI model was activated. Local accuracy has not been benchmarked.

Validation: automated regression tests, 320px phone layout, synthetic pickup/message screens, map and invoice preview, offline app-shell reopening. No real customer message was sent during testing. A real iPhone Messages handoff still needs field confirmation.

Release order: focused commit, D1 migration 0023, Worker, explicit static staging (index.html, manifest.webmanifest, sw.js and assets), production Pages, remote push and live checks. Never deploy the workspace or worker source as a Pages directory.
