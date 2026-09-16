/* Two ways the booking form could be refused even though the customer did
   everything right. Both were reachable in production, and both affected the
   same people: anyone whose account was created by Woody taking a booking over
   the phone, because those accounts have a customers row but no
   customer_addresses row. */
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
  const token = 'address-test-token';
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
  // A phone-taken booking: an account with an address on the customers row and NO
  // customer_addresses row. This is what saveBooking leaves behind.
  db.prepare(`INSERT INTO customers(id,email,first_name,last_name,phone,street_address,town,area,rural_option,created_at,updated_at)
    VALUES('cust-phone','caller@example.test','Ana','Smith','0212345678','80 Hume Street','Waitara','','Main town or main road - no travel fee',0,0)`).run();
  db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,created_at,last_seen_at,expires_at) VALUES(?1,'cust-phone','customer','caller@example.test',0,0,?2)")
    .run(hash, Date.now() + 600000);
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
  const env = { CUSTOMER_DB: wrap };
  const book = body => handlePortalRequest({
    request: new Request('https://test.invalid/customer/bookings', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
    }),
    path: '/customer/bookings', env, json, sendMail: async () => true
  });
  return { db, book };
}

const ITEMS = ['Microwave'];

test('a booking is accepted when the page sends "saved" as the address', async () => {
  const { db, book } = await setup();
  try {
    // The page sends the literal "saved" for an address it built from the legacy
    // flat profile fields. Treating that as a stale id refused the whole booking
    // with "That pickup address has changed" - for a customer who had one address
    // and had changed nothing.
    const response = await book({ items: ITEMS, addressId: 'saved' });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.booking.streetAddress, '80 Hume Street');
    assert.equal(body.booking.town, 'Waitara');
  } finally { db.close(); }
});

test('an empty address id also falls back to the saved address', async () => {
  const { db, book } = await setup();
  try {
    assert.equal((await book({ items: ITEMS, addressId: "" })).status, 201);
    assert.equal((await book({ items: ITEMS })).status, 201);
  } finally { db.close(); }
});

test('a genuinely stale address id is still refused, so the truck is not misdirected', async () => {
  const { db, book } = await setup();
  try {
    // The safety check must survive: a real id that no longer matches is a real
    // problem and must not be silently swapped for the default.
    const response = await book({ items: ITEMS, addressId: 'ADDR-deleted-long-ago' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /changed since this page loaded/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
  } finally { db.close(); }
});

test('a saved address id is used exactly as chosen', async () => {
  const { db, book } = await setup();
  try {
    db.prepare(`INSERT INTO customer_addresses(id,customer_id,label,street_address,town,area,rural_option,access_notes,is_default,sort_order,created_at,updated_at)
      VALUES('ADDR-mums','cust-phone','Mum''s house','12 Devon Street','New Plymouth','','Main town or main road - no travel fee','',0,1,0,0)`).run();
    db.prepare(`INSERT INTO customer_addresses(id,customer_id,label,street_address,town,area,rural_option,access_notes,is_default,sort_order,created_at,updated_at)
      VALUES('ADDR-home','cust-phone','Home','80 Hume Street','Waitara','','Main town or main road - no travel fee','',1,0,0,0)`).run();
    // Picking the non-default address must win over the default one.
    const response = await book({ items: ITEMS, addressId: 'ADDR-mums' });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).booking.streetAddress, '12 Devon Street');
  } finally { db.close(); }
});
