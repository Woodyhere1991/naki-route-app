/* Fixes from the owner-app audit. Each one is a case where the app told Woody
   something had happened when it had not, or destroyed something he had set. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handlePortalRequest } from '../src/customer.js';

const json = (_r, data, status = 200) => Response.json(data, { status });

async function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url))
    .filter(n => n.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const ownerToken = 'owner-audit-token';
  const custToken = 'cust-audit-token';
  const hash = async (t) => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))).toString('base64url');
  db.prepare("INSERT INTO customers(id,email,first_name,last_name,phone,street_address,town,rural_option,created_at,updated_at) VALUES('cust-1','ana@example.test','Ana','Smith','0212345678','80 Hume Street','Waitara','Main town or main road - no travel fee',0,0)").run();
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?1,'owner','nakiwreckremoval@gmail.com',0,0,?2)")
    .run(await hash(ownerToken), Date.now() + 600000);
  db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,created_at,last_seen_at,expires_at) VALUES(?1,'cust-1','customer','ana@example.test',0,0,?2)")
    .run(await hash(custToken), Date.now() + 600000);
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
  // A mail sender that can be made to fail, to prove the result is reported.
  const state = { mailWorks: true, mails: [] };
  const sendMail = async (_env, message) => {
    if (!state.mailWorks) return false;
    state.mails.push(message);
    return true;
  };
  const env = { CUSTOMER_DB: wrap };
  const call = (path, { method = 'POST', token = ownerToken, body } = {}) => handlePortalRequest({
    request: new Request('https://test.invalid' + path, {
      method, headers: { Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body)
    }),
    path, env, json, sendMail
  });
  return { db, call, state };
}

const NEW_BOOKING = `INSERT INTO bookings (id,customer_id,status,first_name,last_name,phone,email,street_address,town,rural_option,items_json,quote_cents,quote_note,quoted_at,created_at,updated_at)
  VALUES ('WEB-audit-1','cust-1','NEW','Ana','Smith','0212345678','ana@example.test','80 Hume Street','Waitara','Main town or main road - no travel fee','["Microwave"]',4500,'Agreed on the phone',123,0,0)`;

test('a confirmation email that fails is reported instead of claiming they were told', async () => {
  const { db, call, state } = await setup();
  try {
    db.exec(NEW_BOOKING);
    state.mailWorks = false;
    const res = await call('/owner/bookings/WEB-audit-1', {
      method: 'PATCH', body: { status: 'CONFIRMED', pickupDate: '2026-09-25', notifyCustomer: true }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // The old code discarded this result, so the app always said "confirmed and emailed".
    assert.equal(body.confirmationEmailed, false);
  } finally { db.close(); }
});

test('a confirmation email that succeeds is reported as sent', async () => {
  const { db, call } = await setup();
  try {
    db.exec(NEW_BOOKING);
    const res = await call('/owner/bookings/WEB-audit-1', {
      method: 'PATCH', body: { status: 'CONFIRMED', pickupDate: '2026-09-25', notifyCustomer: true }
    });
    assert.equal((await res.json()).confirmationEmailed, true);
  } finally { db.close(); }
});

test('a customer edit does not wipe the price Woody quoted', async () => {
  const { db, call } = await setup();
  try {
    db.exec(NEW_BOOKING);
    const before = db.prepare("SELECT quote_cents, quote_note, quoted_at FROM bookings WHERE id='WEB-audit-1'").get();
    assert.equal(before.quote_cents, 4500);

    const res = await call('/customer/bookings/WEB-audit-1', {
      token: 'cust-audit-token', method: 'PUT',
      body: { items: ['Microwave', 'Flat-screen TV'] }
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).quoteKept, true);

    const after = db.prepare("SELECT quote_cents, quote_note, quoted_at FROM bookings WHERE id='WEB-audit-1'").get();
    assert.equal(after.quote_cents, 4500, 'the agreed price must survive');
    assert.equal(after.quote_note, 'Agreed on the phone');
    assert.equal(after.quoted_at, before.quoted_at);
  } finally { db.close(); }
});

test('the owner is warned when a changed item list affects an agreed price', async () => {
  const { db, call, state } = await setup();
  try {
    db.exec(NEW_BOOKING);
    await call('/customer/bookings/WEB-audit-1', {
      token: 'cust-audit-token', method: 'PUT', body: { items: ['Microwave', 'Flat-screen TV'] }
    });
    const ownerMail = state.mails.find(m => String(m.subject).startsWith('Booking changed'));
    assert.ok(ownerMail, 'the owner should be emailed about the change');
    assert.match(ownerMail.text, /already quoted|still right/i);
  } finally { db.close(); }
});

test('an unquoted booking still behaves as before', async () => {
  const { db, call } = await setup();
  try {
    db.exec(`INSERT INTO bookings (id,customer_id,status,first_name,last_name,phone,email,street_address,town,rural_option,items_json,quote_cents,quote_note,quoted_at,created_at,updated_at)
      VALUES ('WEB-audit-2','cust-1','NEW','Ana','Smith','0212345678','ana@example.test','80 Hume Street','Waitara','Main town or main road - no travel fee','["Microwave"]',0,'',NULL,0,0)`);
    const res = await call('/customer/bookings/WEB-audit-2', {
      token: 'cust-audit-token', method: 'PUT', body: { items: ['Flat-screen TV'] }
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).quoteKept, false);
    const after = db.prepare("SELECT quote_cents FROM bookings WHERE id='WEB-audit-2'").get();
    assert.equal(after.quote_cents, 0);
  } finally { db.close(); }
});

test('the account backup uses one slot whichever owner address signs in', async () => {
  const source = fs.readFileSync(new URL('../src/customer.js', import.meta.url), 'utf8');
  // Keyed on the business address, not the session email, so signing in with the
  // second owner address cannot read an empty backup.
  assert.doesNotMatch(source, /backup:\$\{session\.email/);
  assert.equal((source.match(/backup:\$\{OWNER_EMAIL\}/g) || []).length, 3);
});