# Account reliability and score review

Deploy migration `0024_account_reliability.sql` before this Worker. The added delivery-status column defaults historical codes to `sent`; existing sessions are unchanged.

Login code verification atomically claims the latest sent code and reserves one of five attempts. Sends reserve a pending row before contacting email delivery, allow one per minute and three per rolling ten minutes per email/role, and mark failed delivery unusable. Newer sent codes expire older codes. Every request also counts toward atomic fixed ten-minute budgets: 20 per hashed IP and 100 globally. These intentionally count failed requests too. The scheduled cleanup removes expired buckets. No raw IP is stored by this feature.

Customer login sender activation remains a separate prerequisite: see `AUTH-EMAIL.md`. Without `AUTH_EMAIL_FROM`, existing delivery is preserved. Do not activate an unverified address.

## Unusual arcade results

The score endpoint accepts only non-negative safe integer numbers. Per-game thresholds in `src/score-validation.js` are generous review triggers, not evidence that a run was honestly played. An over-threshold score returns HTTP 202 with `reviewRequired`, preserves the existing leaderboard, and stores one review record per customer/game. Later flagged submissions replace that record. Existing scores are not retroactively changed.

Owner-authenticated `GET /v2/owner/arcade/score-flags` lists the latest 100 review records. Customer sessions and anonymous callers cannot access this list. No automatic approval or deletion is provided; investigate the game and run with the player before considering any manual correction. There is no new owner screen in this release.

Client-controlled gameplay can still submit a fabricated score below a threshold. Full anti-cheat requires server-authoritative play or trustworthy run evidence; a client run token alone would not prove an earned score. This release does not claim that protection.

## Verification

Run `node --test worker/tests/*.test.mjs`. The reliability tests use real in-memory SQLite, simulated email delivery and fake test identities only; they do not send email or change production customer data. Frontend regression tests live in the separate customer-site repository under `tests/account-reliability.test.mjs`.
