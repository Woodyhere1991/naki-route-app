/* The owner's sign-in used to expire on a fixed 30-day clock with no renewal, so
   it died mid-run on day 30 while work was still queued - and the app's only way
   back in was a fresh emailed code. It now slides forward while he is using it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { sessionFor } from '../src/customer.js';
import { reserveAuthRequest, AuthMailError } from '../src/auth-limits.js';

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY, customer_id TEXT, role TEXT NOT NULL,
    email TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
  );`);
  db.exec(`CREATE TABLE auth_request_limits (
    bucket TEXT PRIMARY KEY, used INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );`);
  const wrap = {
    prepare(sql) {
      const s = db.prepare(sql);
      return {
        bind(...args) { return {
          first: async () => s.get(...args) || null,
          all: async () => ({ results: s.all(...args) }),
          run: async () => ({ meta: { changes: Number(s.run(...args).changes) } })
        }; },
        first: async () => s.get() || null,
        all: async () => ({ results: s.all() }),
        run: async () => ({ meta: { changes: Number(s.run().changes) } })
      };
    }
  };
  return { db, env: { CUSTOMER_DB: wrap, AUTH_PEPPER: 'session-slide-test' } };
}

// sessionFor reads the token from an Authorization header.
const ask = (token) => new Request('https://test.invalid/x', { headers: { Authorization: `Bearer ${token}` } });

test('an owner session that is nearly expired is pushed forward on use', async () => {
  const { db, env } = setup();
  try {
    const token = 'owner-token';
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    // 29 days in: alive, but only a day left. This is the day-30 trap.
    const nearly = Date.now() + 1 * DAY;
    db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,expires_at,created_at,last_seen_at) VALUES(?1,NULL,'owner','owner@example.test',?2,0,0)")
      .run(hash, nearly);

    const first = await sessionFor(ask(token), env, 'owner');
    assert.ok(first, 'a valid session must be accepted');
    const after = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?1').get(hash).expires_at;
    assert.ok(after > nearly, 'the expiry should have been pushed forward');
    // Roughly a fresh 30 days, not a token amount.
    assert.ok(after - Date.now() > 29 * DAY, `expected a full renewal, got ${Math.round((after - Date.now()) / DAY)} days`);
  } finally { db.close(); }
});

test('the expiry is not rewritten on every single request', async () => {
  const { db, env } = setup();
  try {
    const token = 'owner-token-2';
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    // Freshly renewed: the write must be skipped so ordinary use stays cheap.
    const fresh = Date.now() + 30 * DAY;
    db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,expires_at,created_at,last_seen_at) VALUES(?1,NULL,'owner','owner@example.test',?2,0,0)")
      .run(hash, fresh);
    await sessionFor(ask(token), env, 'owner');
    const after = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?1').get(hash).expires_at;
    assert.equal(after, fresh, 'a fresh session should be left alone');
  } finally { db.close(); }
});

test('a customer session is not slid, so it still expires as advertised', async () => {
  const { db, env } = setup();
  try {
    const token = 'customer-token';
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    const nearly = Date.now() + 1 * DAY;
    db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,expires_at,created_at,last_seen_at) VALUES(?1,'cust-1','customer','c@example.test',?2,0,0)")
      .run(hash, nearly);
    await sessionFor(ask(token), env, 'customer');
    const after = db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?1').get(hash).expires_at;
    assert.equal(after, nearly, 'the customer 30-day rule should be unchanged');
  } finally { db.close(); }
});

test('an expired session is refused and never extended', async () => {
  const { db, env } = setup();
  try {
    const token = 'expired-token';
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
    const past = Date.now() - DAY;
    db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,expires_at,created_at,last_seen_at) VALUES(?1,NULL,'owner','owner@example.test',?2,0,0)")
      .run(hash, past);
    assert.equal(await sessionFor(ask(token), env, 'owner'), null);
    assert.equal(db.prepare('SELECT expires_at FROM sessions WHERE token_hash=?1').get(hash).expires_at, past);
  } finally { db.close(); }
});

test('customer sign-ins on the same connection cannot exhaust the owner budget', async () => {
  const { db, env } = setup();
  try {
    // 20 customer requests is the whole per-IP budget.
    for (let i = 0; i < 20; i++) await reserveAuthRequest(env, '203.0.113.9', Date.now(), 'customer');
    // The next customer request from that address is refused...
    await assert.rejects(
      () => reserveAuthRequest(env, '203.0.113.9', Date.now(), 'customer'),
      (error) => error instanceof AuthMailError && error.status === 429
    );
    // ...but the owner, on the same connection, is unaffected.
    await reserveAuthRequest(env, '203.0.113.9', Date.now(), 'owner');
    const ownerBucket = db.prepare("SELECT used FROM auth_request_limits WHERE bucket LIKE 'owner:%'").get();
    assert.equal(Number(ownerBucket.used), 1);
  } finally { db.close(); }
});