/* The profile save is the gate in front of every booking. A customer who is
   refused here can never book, so these tests pin the rules that decide it -
   most importantly that one name is enough, matching the form and the owner-side
   endpoints. A mismatch between the form and this check is what silently blocked
   people who only gave a first name. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handlePortalRequest } from '../src/customer.js';

const json = (_r, data, status = 200) => Response.json(data, { status });
const ADDRESS = {
  label: 'Home', streetAddress: '80 Hume Street', town: 'Waitara', area: '',
  ruralOption: 'Main town or main road - no travel fee', accessNotes: '', isDefault: true
};

async function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const token = 'profile-gate-token';
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
  db.prepare("INSERT INTO customers(id,email,created_at,updated_at) VALUES('cust-1','ana@example.test',0,0)").run();
  db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,created_at,last_seen_at,expires_at) VALUES(?1,'cust-1','customer','ana@example.test',0,0,?2)")
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
  const save = body => handlePortalRequest({
    request: new Request('https://test.invalid/customer/profile', {
      method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
    }),
    path: '/customer/profile', env: { CUSTOMER_DB: wrap }, json
  });
  const stored = () => db.prepare("SELECT * FROM customers WHERE id='cust-1'").get();
  return { db, save, stored };
}

const valid = { firstName: 'Ana', lastName: 'Smith', phone: '0212345678', addresses: [ADDRESS] };

test('a first name on its own is enough to save a profile', async () => {
  const { db, save, stored } = await setup();
  try {
    // The form labels Last name "(optional)", so this must be accepted - it is
    // exactly what used to be refused, stranding the customer before booking.
    const response = await save({ ...valid, lastName: '' });
    assert.equal(response.status, 200);
    assert.equal(stored().first_name, 'Ana');
    assert.equal(stored().phone, '0212345678');
  } finally { db.close(); }
});

test('a surname on its own is enough too', async () => {
  const { db, save, stored } = await setup();
  try {
    assert.equal((await save({ ...valid, firstName: '', lastName: 'Smith' })).status, 200);
    assert.equal(stored().last_name, 'Smith');
  } finally { db.close(); }
});

test('a profile with no name at all is refused', async () => {
  const { db, save, stored } = await setup();
  try {
    const response = await save({ ...valid, firstName: '', lastName: '' });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /name/i);
    assert.equal(stored().first_name, '');
  } finally { db.close(); }
});

test('each refusal names the field that is actually wrong', async () => {
  const { db, save } = await setup();
  try {
    // Short phone: the message must be about the phone, not the address.
    const shortPhone = await save({ ...valid, phone: '123' });
    assert.equal(shortPhone.status, 400);
    assert.match((await shortPhone.json()).error, /phone/i);

    // Missing town: the message must be about the address.
    const noTown = await save({ ...valid, addresses: [{ ...ADDRESS, town: '' }] });
    assert.equal(noTown.status, 400);
    assert.match((await noTown.json()).error, /pickup address/i);

    // Missing pickup area: still about the address block, which is where it lives.
    const noArea = await save({ ...valid, addresses: [{ ...ADDRESS, ruralOption: '' }] });
    assert.equal(noArea.status, 400);
    assert.match((await noArea.json()).error, /pickup area|pickup address/i);

    // No addresses at all.
    const noAddress = await save({ ...valid, addresses: [] });
    assert.equal(noAddress.status, 400);
  } finally { db.close(); }
});

test('a saved address is kept and renumbered as the default', async () => {
  const { db, save } = await setup();
  try {
    // Only the second address is marked default, so the first must be cleared.
    const addresses = [{ ...ADDRESS, isDefault: false },
      { ...ADDRESS, label: "Mum's house", streetAddress: '12 Devon Street', town: 'New Plymouth', isDefault: true }];
    assert.equal((await save({ ...valid, addresses })).status, 200);
    const rows = db.prepare("SELECT * FROM customer_addresses ORDER BY sort_order").all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].is_default, 0);
    assert.equal(rows[1].is_default, 1);
    assert.equal(rows[1].label, "Mum's house");
  } finally { db.close(); }
});