import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handlePortalRequest} from '../src/customer.js';
import {emptyBin} from '../src/booking-recovery.js';
import {fakeR2} from './fake-r2.mjs';

const json = (_r, data, status = 200) => Response.json(data, { status });
const DAY = 86400000;

async function setup({ documents = fakeR2() } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const hash = async token => Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))).toString('base64url');
  db.prepare("INSERT INTO customers(id,email,first_name,created_at,updated_at) VALUES('cust-a','alana@example.test','Alana',0,0),('cust-b','other@example.test','Other',0,0)").run();
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','owner@example.test',0,0,?)").run(await hash('owner-t'), Date.now() + 600000);
  db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,created_at,last_seen_at,expires_at) VALUES(?,'cust-a','customer','alana@example.test',0,0,?)").run(await hash('cust-a-t'), Date.now() + 600000);
  db.prepare("INSERT INTO sessions(token_hash,customer_id,role,email,created_at,last_seen_at,expires_at) VALUES(?,'cust-b','customer','other@example.test',0,0,?)").run(await hash('cust-b-t'), Date.now() + 600000);
  const booking = (id, status = 'CONFIRMED', extra = {}) => {
    const row = { id, customer_id: 'cust-a', status, first_name: 'Alana', last_name: 'M', phone: '021', email: 'alana@example.test',
      street_address: '66 Paynters Avenue', town: 'New Plymouth', area: 'New Plymouth', rural_option: 'Main town or main road - no travel fee',
      items_json: '["Dryer"]', total_cents: 2000, created_at: 1000, updated_at: 1000, pickup_date: '2026-10-22', pickup_window: 'Morning', ...extra };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO bookings(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`).run(...Object.values(row));
  };
  const wrap = {
    prepare(sql) {
      const s = db.prepare(sql);
      const api = args => ({ first: async () => s.get(...args) || null, all: async () => ({ results: s.all(...args) }), run: async () => ({ meta: { changes: Number(s.run(...args).changes) } }) });
      return { bind: (...args) => api(args), ...api([]) };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = []; for (const s of statements) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const kv = new Map(), photosDeleted = [], mails = [];
  const env = { CUSTOMER_DB: wrap, DOCUMENTS: documents,
    REMINDERS: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) },
    PHOTOS: { delete: async k => photosDeleted.push(k) } };
  const call = (path, { method = 'POST', token = 'owner-t', body } = {}) => handlePortalRequest({
    request: new Request('https://test.invalid' + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }),
    env, path, json, sendMail: async (_env, message) => { mails.push(message); return true; } });
  const row = id => db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
  return { db, env, call, booking, row, mails, kv, photosDeleted };
}

test('a customer who cancelled can rebook: back to New, no day, no cancel reason, Woody told', async () => {
  const t = await setup();
  try {
    t.booking('WEB-a');
    assert.equal((await t.call('/customer/bookings/WEB-a/cancel', { token: 'cust-a-t', body: { reason: 'Changed my mind' } })).status, 200);
    let list = await (await t.call('/customer/bookings', { method: 'GET', token: 'cust-a-t' })).json();
    const cancelled = list.bookings.find(b => b.id === 'WEB-a');
    assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.canRebook, true); assert.equal(cancelled.canCancel, false);
    t.mails.length = 0;
    const res = await t.call('/customer/bookings/WEB-a/rebook', { token: 'cust-a-t' });
    assert.equal(res.status, 200);
    const back = (await res.json()).bookings.find(b => b.id === 'WEB-a');
    assert.equal(back.status, 'NEW'); assert.equal(back.canRebook, false); assert.equal(back.canCancel, true);
    const r = t.row('WEB-a');
    assert.deepEqual([r.status, r.pickup_date, r.pickup_window, r.cancellation_reason, r.cancelled_at], ['NEW', '', '', '', null]);
    assert.ok(t.db.prepare("SELECT 1 FROM booking_events WHERE booking_id='WEB-a' AND event_type='STATUS' AND detail LIKE 'NEW - rebooked%'").get());
    assert.match(t.mails.find(m => /rebooked/i.test(m.subject)).text, /back in Bookings as New/);
    assert.equal((await t.call('/customer/bookings/WEB-a/rebook', { token: 'cust-a-t' })).status, 409, 'cannot rebook an open booking');
  } finally { t.db.close(); }
});

test("nobody can rebook or remove someone else's booking, or a booking that isn't cancelled", async () => {
  const t = await setup();
  try {
    t.booking('WEB-a', 'CANCELLED'); t.booking('WEB-open', 'CONFIRMED'); t.booking('WEB-done', 'COMPLETED');
    assert.equal((await t.call('/customer/bookings/WEB-a/rebook', { token: 'cust-b-t' })).status, 404);
    assert.equal((await t.call('/customer/bookings/WEB-a/remove', { token: 'cust-b-t' })).status, 404);
    for (const id of ['WEB-open', 'WEB-done']) {
      assert.equal((await t.call(`/customer/bookings/${id}/rebook`, { token: 'cust-a-t' })).status, 409);
      assert.equal((await t.call(`/customer/bookings/${id}/remove`, { token: 'cust-a-t' })).status, 409);
    }
    assert.equal((await t.call('/customer/bookings/WEB-a/rebook', { token: 'owner-t' })).status, 401, 'customer routes need a customer sign-in');
    assert.equal(t.row('WEB-a').status, 'CANCELLED');
  } finally { t.db.close(); }
});

test('removing a cancelled booking hides it from the customer only; Woody still sees it', async () => {
  const t = await setup();
  try {
    t.booking('WEB-a', 'CANCELLED'); t.booking('WEB-b', 'CONFIRMED');
    const res = await t.call('/customer/bookings/WEB-a/remove', { token: 'cust-a-t' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).bookings.map(b => b.id), ['WEB-b']);
    assert.deepEqual((await (await t.call('/customer/bookings', { method: 'GET', token: 'cust-a-t' })).json()).bookings.map(b => b.id), ['WEB-b']);
    const owner = await (await t.call('/owner/bookings', { method: 'GET' })).json();
    assert.ok(owner.bookings.some(b => b.id === 'WEB-a' && b.status === 'CANCELLED'));
    assert.ok(t.row('WEB-a'), 'nothing is deleted');
  } finally { t.db.close(); }
});

test('imported Jotform bookings can be rebooked too', async () => {
  const t = await setup();
  try {
    t.db.exec("INSERT INTO jotform_bookings(id,submission_id,form_id,customer_id,status,email,first_name,created_at,updated_at,cancellation_reason,cancelled_at) VALUES('JOTFORM-j','j','f','cust-a','CANCELLED','alana@example.test','Alana',1,1,'Away',5)");
    assert.equal((await t.call('/customer/bookings/JOTFORM-j/rebook', { token: 'cust-a-t' })).status, 200);
    const r = t.db.prepare("SELECT status,cancellation_reason,cancelled_at FROM jotform_bookings WHERE id='JOTFORM-j'").get();
    assert.deepEqual([r.status, r.cancellation_reason, r.cancelled_at], ['NEW', '', null]);
  } finally { t.db.close(); }
});

test('Woody can restore cancelled and declined bookings, not completed or group ones', async () => {
  const t = await setup();
  try {
    t.booking('WEB-c', 'CANCELLED', { cancellation_reason: 'x', cancelled_at: 9 }); t.booking('WEB-d', 'DECLINED'); t.booking('WEB-done', 'COMPLETED');
    for (const id of ['WEB-c', 'WEB-d']) {
      const res = await t.call(`/owner/bookings/${id}/restore`);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).booking.status, 'NEW');
      assert.equal(t.row(id).status, 'NEW');
    }
    assert.equal((await t.call('/owner/bookings/WEB-done/restore')).status, 409);
    assert.equal((await t.call('/owner/bookings/WEB-GROUP-x/restore')).status, 409);
    assert.equal((await t.call('/owner/bookings/WEB-missing/restore')).status, 404);
    assert.equal((await t.call('/owner/bookings/WEB-c/restore', { token: 'cust-a-t' })).status, 401);
  } finally { t.db.close(); }
});

test('Delete goes to the bin with its history, receipt and note; Restore brings it all back', async () => {
  const t = await setup();
  try {
    t.booking('WEB-x', 'CONFIRMED', { photo_count: 2 });
    t.db.exec("INSERT INTO booking_events(id,booking_id,event_type,detail,created_at) VALUES('e1','WEB-x','CREATED','Website',1000)");
    t.db.exec("INSERT INTO booking_documents(id,booking_id,email,kind,amount_cents,created_at,r2_key) VALUES('d1','WEB-x','alana@example.test','RECEIPT',2000,1000,'docs/d1.pdf')");
    t.db.exec("INSERT INTO owner_booking_notes(booking_id,note,updated_at) VALUES('WEB-x','Gate code 1234',1000)");
    const del = await t.call('/owner/bookings/WEB-x', { method: 'DELETE' });
    assert.equal(del.status, 200); assert.equal((await del.json()).binDays, 30);
    assert.equal(t.row('WEB-x'), undefined);
    assert.deepEqual(t.photosDeleted, [], 'photos kept while in the bin');
    const bin = await (await t.call('/owner/deleted-bookings', { method: 'GET' })).json();
    assert.equal(bin.bookings.length, 1); assert.equal(bin.bookings[0].id, 'WEB-x'); assert.deepEqual(bin.bookings[0].items, ['Dryer']);
    const restored = await t.call('/owner/deleted-bookings/WEB-x/restore');
    assert.equal(restored.status, 200); assert.equal((await restored.json()).booking.status, 'CONFIRMED');
    assert.equal(t.row('WEB-x').photo_count, 2);
    assert.equal(t.db.prepare("SELECT COUNT(*) n FROM booking_events WHERE booking_id='WEB-x'").get().n, 1);
    assert.equal(t.db.prepare("SELECT r2_key FROM booking_documents WHERE booking_id='WEB-x'").get().r2_key, 'docs/d1.pdf');
    assert.equal(t.db.prepare("SELECT note FROM owner_booking_notes WHERE booking_id='WEB-x'").get().note, 'Gate code 1234');
    assert.equal((await (await t.call('/owner/deleted-bookings', { method: 'GET' })).json()).bookings.length, 0);
    assert.equal((await t.call('/owner/deleted-bookings/WEB-x/restore')).status, 404, 'cannot restore twice');
    assert.equal((await t.call('/owner/deleted-bookings', { method: 'GET', token: 'cust-a-t' })).status, 401);
  } finally { t.db.close(); }
});

test('imported bookings round-trip through the bin as well', async () => {
  const t = await setup();
  try {
    t.db.exec("INSERT INTO external_bookings(id,external_key,sync_token_hash,status,email,created_at,updated_at) VALUES('PICKUP-p','k','h','ADDED_TO_RUN','a@example.test',1,1)");
    assert.equal((await t.call('/owner/bookings/PICKUP-p', { method: 'DELETE' })).status, 200);
    assert.equal((await t.call('/owner/deleted-bookings/PICKUP-p/restore')).status, 200);
    assert.equal(t.db.prepare("SELECT status FROM external_bookings WHERE id='PICKUP-p'").get().status, 'ADDED_TO_RUN');
  } finally { t.db.close(); }
});

test('if the bin copy cannot be saved, nothing is deleted', async () => {
  const broken = fakeR2(); broken.put = async () => { throw Error('R2 down'); };
  const t = await setup({ documents: broken });
  try {
    t.booking('WEB-keep');
    const res = await t.call('/owner/bookings/WEB-keep', { method: 'DELETE' });
    assert.equal(res.status, 503); assert.match((await res.json()).error, /Nothing was deleted/);
    assert.ok(t.row('WEB-keep'));
  } finally { t.db.close(); }
});

test('the bin empties after 30 days, removing kept photos and PDFs; younger entries stay', async () => {
  const t = await setup();
  try {
    t.booking('WEB-old', 'CONFIRMED', { photo_count: 2 }); t.booking('WEB-new');
    t.db.exec("INSERT INTO booking_documents(id,booking_id,email,kind,created_at,r2_key) VALUES('d2','WEB-old','alana@example.test','INVOICE',1,'docs/d2.pdf')");
    await t.env.DOCUMENTS.put('docs/d2.pdf', 'pdf');
    await t.call('/owner/bookings/WEB-old', { method: 'DELETE' });
    await t.call('/owner/bookings/WEB-new', { method: 'DELETE' });
    // Age the first one past 30 days.
    const key = 'deleted-bookings/WEB-old.json', snap = JSON.parse(t.env.DOCUMENTS.store.get(key).body);
    snap.deletedAt = Date.now() - 31 * DAY; await t.env.DOCUMENTS.put(key, JSON.stringify(snap));
    assert.equal(await emptyBin(t.env), 1);
    assert.equal(t.env.DOCUMENTS.store.has(key), false);
    assert.equal(t.env.DOCUMENTS.store.has('docs/d2.pdf'), false);
    assert.deepEqual(t.photosDeleted.sort(), ['photo:WEB-old:0', 'photo:WEB-old:1']);
    assert.equal(t.env.DOCUMENTS.store.has('deleted-bookings/WEB-new.json'), true);
  } finally { t.db.close(); }
});
