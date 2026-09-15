/* A booking taken over the phone has no account to attach to, because the caller
   often gives no email. It must still be claimed by that person later, or they
   would sign in and not see the pickup they arranged. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handlePortalRequest, sendCode } from '../src/customer.js';

const json = (_r, data, status = 200) => Response.json(data, { status });

async function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const files = fs.readdirSync(new URL('../migrations/', import.meta.url))
    .filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
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
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = []; for (const s of statements) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const env = { CUSTOMER_DB: wrap, AUTH_PEPPER: 'phone-linking-test' };
  // Sign in the way the real page does: ask for a code, then use the one that
  // was actually emailed. That keeps this test honest about the hash and pepper.
  const signIn = async address => {
    const mails = [];
    const send = async (_env, message) => { mails.push(message); return true; };
    await sendCode(env, send, address, 'customer', `ip-${address}`);
    const code = mails.at(-1).text.match(/code is (\d{6})/)[1];
    return handlePortalRequest({
      request: new Request('https://test.invalid/customer/verify-code', {
        method: 'POST', body: JSON.stringify({ email: address, code })
      }),
      path: '/customer/verify-code', env, json, sendMail: send
    });
  };
  const phoneBooking = (id, address) => db.prepare(
    `INSERT INTO bookings (id, customer_id, status, first_name, last_name, phone, email,
       street_address, town, rural_option, items_json, referral_source, created_at, updated_at)
     VALUES (?1, NULL, 'NEW', 'Ana', 'Smith', '0212345678', ?2,
       '80 Hume Street', 'Waitara', 'Main town or main road - no travel fee', '["Microwave"]', 'Phone', 0, 0)`
  ).run(id, address);
  return { db, signIn, phoneBooking };
}

test('a phone booking is claimed when that person later signs in', async () => {
  const { db, signIn, phoneBooking } = await setup();
  try {
    phoneBooking('WEB-PHONE-1', 'ana@example.test');
    assert.equal(db.prepare('SELECT customer_id FROM bookings').get().customer_id, null);

    const response = await signIn('ana@example.test');
    assert.equal(response.status, 200);
    const body = await response.json();

    // The account now owns the booking, and it shows in their own list.
    assert.ok(db.prepare('SELECT customer_id FROM bookings').get().customer_id, 'booking was not linked');
    assert.equal(body.bookings.length, 1);
    assert.equal(body.bookings[0].id, 'WEB-PHONE-1');
    assert.equal(body.bookings[0].source, 'WEBSITE');
  } finally { db.close(); }
});

test('a phone booking with a different email is not claimed by the wrong person', async () => {
  const { db, signIn, phoneBooking } = await setup();
  try {
    phoneBooking('WEB-PHONE-2', 'someone.else@example.test');
    const response = await signIn('ana@example.test');
    const body = await response.json();
    // Their booking must attach to its own person, not to whoever signs in first.
    assert.equal(body.bookings.length, 0);
    assert.equal(db.prepare("SELECT customer_id FROM bookings WHERE id='WEB-PHONE-2'").get().customer_id, null);
  } finally { db.close(); }
});

test('a customer still only sees their own bookings', async () => {
  const { db, signIn, phoneBooking } = await setup();
  try {
    phoneBooking('WEB-PHONE-A', 'ana@example.test');
    phoneBooking('WEB-PHONE-B', 'bob@example.test');
    const response = await signIn('ana@example.test');
    const body = await response.json();
    assert.equal(body.bookings.length, 1);
    assert.equal(body.bookings[0].id, 'WEB-PHONE-A');
  } finally { db.close(); }
});