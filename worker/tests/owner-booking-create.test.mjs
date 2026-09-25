import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handlePortalRequest, ITEM_PRICES} from '../src/customer.js';

const json = (_r, data, status = 200) => Response.json(data, { status });

async function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  // The whole chain in order, as production ran it. Listing files by hand let a
  // later migration add a column this endpoint needs without the test knowing.
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('owner-booking-test'))).toString('base64url');
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','owner@example.test',0,0,?)")
    .run(hash, Date.now() + 600000);
  const wrap = {
    prepare(sql) {
      const s = db.prepare(sql);
      return { bind(...args) { return {
        first: async () => s.get(...args) || null,
        all: async () => ({ results: s.all(...args) }),
        run: async () => ({ meta: { changes: Number(s.run(...args).changes) } })
      }; } };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = []; for (const s of statements) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const mails = [];
  const env = {
    CUSTOMER_DB: wrap,
    PHOTOS: { delete: async () => {} },
    DOCUMENTS: { delete: async () => {} }
  };
  const sendMail = async (_env, message) => { mails.push(message); return true; };
  const create = (body, authorized = true) => handlePortalRequest({
    request: new Request('https://test.invalid/owner/bookings', {
      method: 'POST',
      headers: authorized ? { Authorization: 'Bearer owner-booking-test' } : {},
      body: JSON.stringify(body)
    }),
    path: '/owner/bookings',
    env,
    json,
    sendMail
  });
  return { db, create, mails };
}

const valid = {
  firstName: 'Ana', lastName: 'Smith', phone: '0212345678', email: 'ana@example.test',
  streetAddress: '80 Hume Street', town: 'Waitara',
  ruralOption: 'Main town or main road - no travel fee',
  items: ['Microwave'], additionalInfo: 'Gate code 1234'
};

// Woody, 25 Sept: "add that i cant take any packaging, boxes etc". The same text
// goes to website, owner-taken and phone (bot API) bookings. It had also shown
// customers broken characters for weeks after the file was saved in the wrong
// encoding, so the customer-facing text is checked for that too.
test('the booking confirmation explains what happens, including no packaging, in clean text', async () => {
  const { db, create, mails } = await setup();
  try {
    assert.equal((await create(valid)).status, 201);
    assert.equal(mails.length, 1);
    const text = mails[0].text;
    assert.match(text, /Please note we can't take any packaging, boxes etc - only the items you've booked\./);
    assert.ok(text.includes('Collections in Hāwera,'));
    assert.ok(text.includes('Thank you! \u{1F60A}'));
    assert.doesNotMatch(text, /[ÂÃÄâð][\u0080-¿Œ-™]/, 'no double-encoded characters');
  } finally { db.close(); }
});

test('owner can take a booking for a brand new person', async () => {
  const { db, create, mails } = await setup();
  try {
    const response = await create(valid);
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.customerEmailed, true);
    // The booking is a real website booking, priced by the shared calculator.
    const row = db.prepare('SELECT * FROM bookings').get();
    assert.equal(row.status, 'NEW');
    assert.equal(row.street_address, '80 Hume Street');
    assert.equal(row.town, 'Waitara');
    assert.deepEqual(JSON.parse(row.items_json), ['Microwave']);
    assert.equal(row.total_cents, ITEM_PRICES['Microwave'][1] + (ITEM_PRICES['Microwave'][0] - ITEM_PRICES['Microwave'][1]));
    // And an account now exists for them, keyed on their email.
    const customer = db.prepare('SELECT * FROM customers').get();
    assert.equal(customer.email, 'ana@example.test');
    assert.equal(row.customer_id, customer.id);
    // They were emailed their copy.
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, 'ana@example.test');
  } finally { db.close(); }
});

test('a booking taken for an existing customer attaches to their account', async () => {
  const { db, create } = await setup();
  try {
    db.exec("INSERT INTO customers(id,email,first_name,last_name,phone,created_at,updated_at) VALUES('cust-1','ana@example.test','Ana','Smith','0212345678',0,0)");
    const response = await create(valid);
    assert.equal(response.status, 201);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
    assert.equal(db.prepare('SELECT customer_id FROM bookings').get().customer_id, 'cust-1');
  } finally { db.close(); }
});

test('an incomplete booking is refused with a message naming what is missing', async () => {
  const { db, create } = await setup();
  try {
    const cases = [
      [{ ...valid, firstName: '', lastName: '' }, /first name/i],
      [{ ...valid, phone: '123' }, /phone/i],
      [{ ...valid, email: '' }, /email/i],
      [{ ...valid, email: 'not-an-email' }, /email/i],
      [{ ...valid, streetAddress: '' }, /address/i],
      [{ ...valid, town: '' }, /address/i],
      [{ ...valid, ruralOption: '' }, /pickup area/i],
      [{ ...valid, items: [] }, /item/i],
      [{ ...valid, items: ['Not a real appliance'] }, /item/i]
    ];
    for (const [body, pattern] of cases) {
      const response = await create(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match((await response.json()).error, pattern);
    }
    // Nothing was written and nobody was emailed by any refusal.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 0);
  } finally { db.close(); }
});

test('a booking cannot be taken without an owner sign-in', async () => {
  const { db, create } = await setup();
  try {
    const response = await create(valid, false);
    assert.equal(response.status, 401);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
  } finally { db.close(); }
});
