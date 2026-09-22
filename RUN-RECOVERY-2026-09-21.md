# Scheduled run recovery — 21 September 2026

Recovered the pre-pull run snapshot (17 Hāwera, 5 New Plymouth, 3 Coastal stops). All 25 linked booking records were present. The displaced six-stop run contains completed bookings and was not merged back into scheduled work. Full before/recovery snapshots are held privately outside the repository.

The prior sync policy unconditionally uploaded local changes over a newer account snapshot. A stale browser could replace newer runs. This repair uses an atomic D1 revision check, refuses old clients without a revision, pauses conflicting frontend saves, and keeps each device's own undo snapshot. The exact device that initiated the incident is not established.

D1 migration 0030 creates the authoritative current/previous run snapshot. The existing KV daily copies remain a secondary recovery source; bot run reads now use D1 too. The existing nightly database backup automatically includes the new table. Old app builds must refresh to resume saving; their local data is retained.

Validation: 39 focused tests passed, including concurrent saves, first-save races, stale/legacy refusal, lost-response replay, KV failures, frontend conflicts and undo preservation. Worker and inline script syntax checks passed.
