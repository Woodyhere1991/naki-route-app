import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handlePortalRequest} from '../src/customer.js';

const json = (_r, data, status = 200) => Response.json(data, { status });

async function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of [
    '0001_customer_accounts.sql',
    '0003_pickup_run_history.sql',
    '0004_jotform_bookings.sql',
    '0026_booking_dropoffs.sql'
  ]) db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  // The public endpoint counts against the same fixed-window budget table the
  // auth limits use (0024 creates it in production).
  db.exec(`CREATE TABLE IF NOT EXISTS auth_request_limits (
    bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );`);
  const ownerHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('dropoff-owner'))).toString('base64url');
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','owner@example.test',0,0,?)")
    .run(ownerHash, Date.now() + 600000);
  const wrap = {
    prepare(sql) {
      const s = db.prepare(sql);
      return {
        bind(...args) { return {
          first: async () => s.get(...args) || null,
          all: async () => ({ results: s.all(...args) }),
          run: async () => ({ meta: { changes: Number(s.run(...args).changes) } })
        }; },
        // The owner summary uses .all()/.first() without any bindings.
        first: async () => s.get() || null,
        all: async () => ({ results: s.all() }),
        run: async () => ({ meta: { changes: Number(s.run().changes) } })
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = []; for (const s of statements) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const env = { CUSTOMER_DB: wrap };
  const post = body => handlePortalRequest({
    request: new Request('https://test.invalid/customer/dropoff', { method: 'POST', body: JSON.stringify(body) }),
    path: '/customer/dropoff', env, json
  });
  const read = token => handlePortalRequest({
    request: new Request('https://test.invalid/owner/dropoffs', {
      method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {}
    }),
    path: '/owner/dropoffs', env, json
  });
  return { db, post, read };
}

test('a stuck customer is recorded even though they are not signed in', async () => {
  const { db, post } = await setup();
  try {
    // No Authorization header at all - exactly the person who cannot get through.
    const response = await post({ stage: 'booking', reason: 'no-pickup-area', detail: 'your pickup area' });
    assert.equal(response.status, 200);
    const row = db.prepare('SELECT * FROM booking_dropoffs').get();
    assert.equal(row.stage, 'booking');
    assert.equal(row.reason, 'no-pickup-area');
    assert.equal(row.detail, 'your pickup area');
  } finally { db.close(); }
});

test('only known reason codes are stored, so nothing identifying can be smuggled in', async () => {
  const { db, post } = await setup();
  try {
    // A made-up stage or reason is refused...
    assert.equal((await post({ stage: 'nonsense', reason: 'no-pickup-area' })).status, 400);
    // ...and so is free text dressed up as a reason.
    assert.equal((await post({ stage: 'booking', reason: 'ana@example.com rang me' })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_dropoffs').get().n, 0);
  } finally { db.close(); }
});

test('the owner summary counts what was actually reported', async () => {
  const { db, post, read } = await setup();
  try {
    await post({ stage: 'booking', reason: 'bounced-to-profile', detail: 'your pickup area' });
    await post({ stage: 'booking', reason: 'no-pickup-area', detail: 'your pickup area' });
    await post({ stage: 'booking', reason: 'no-pickup-area', detail: 'your pickup area' });
    await post({ stage: 'profile', reason: 'profile-incomplete', detail: 'Please complete' });

    const response = await read('dropoff-owner');
    assert.equal(response.status, 200);
    const body = await response.json();
    const byReason = Object.fromEntries(body.summary.map(row => [row.reason, row.count]));
    assert.equal(byReason['no-pickup-area'], 2);
    assert.equal(byReason['bounced-to-profile'], 1);
    assert.equal(byReason['profile-incomplete'], 1);
    assert.equal(body.emailFailures, 0);
    // Most recent first, so the newest stuck moment is on top.
    assert.equal(body.recent.length, 4);
  } finally { db.close(); }
});

test('the drop-off summary needs an owner sign-in', async () => {
  const { db, post, read } = await setup();
  try {
    await post({ stage: 'booking', reason: 'no-pickup-area' });
    assert.equal((await read('')).status, 401);
    assert.equal((await read('not-a-real-token')).status, 401);
  } finally { db.close(); }
});

test('a flood of reports is capped but still answers ok', async () => {
  const { db, post } = await setup();
  try {
    // A stuck customer retrying is fine; a script hammering it is not. The cap
    // is generous (60 per IP per 10 minutes) and beyond it the endpoint still
    // answers ok so the page never shows an error for telemetry.
    for (let i = 0; i < 60; i++) {
      assert.equal((await post({ stage: 'booking', reason: 'no-pickup-area' })).status, 200);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_dropoffs').get().n, 60);
    for (let i = 0; i < 10; i++) {
      assert.equal((await post({ stage: 'booking', reason: 'no-pickup-area' })).status, 200);
    }
    // Nothing beyond the cap was stored.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM booking_dropoffs').get().n, 60);
  } finally { db.close(); }
});
