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

test('unscheduling clears owner and customer dates while preserving both notes and requested date',async()=>{
 const {db,call,state}=await setup();try{
  db.exec(NEW_BOOKING);db.exec("UPDATE bookings SET status='CONFIRMED',pickup_date='2026-10-02',pickup_window='Morning',additional_info='After 10 October',customer_note='Keep access instructions',requested_date='2026-10-12'; INSERT INTO owner_booking_notes VALUES('WEB-audit-1','After 10 October',1)");
  const path='/owner/bookings/WEB-audit-1/unschedule',body={expectedPickupDate:'2026-10-02'};
  assert.equal((await call(path,{body,token:'cust-audit-token'})).status,401);
  const res=await call(path,{body});assert.equal(res.status,200);
  const owner=(await res.json()).booking;assert.equal(owner.status,'NEW');assert.equal(owner.pickupDate,'');assert.equal(owner.pickupWindow,'');assert.equal(owner.ownerNote,'After 10 October');assert.equal(owner.additionalInfo,'After 10 October');assert.equal(owner.requestedDate,'2026-10-12');assert.equal(owner.customerNote,'Keep access instructions');
  const customer=await (await call('/customer/bookings',{method:'GET',token:'cust-audit-token'})).json();assert.equal(customer.bookings[0].status,'NEW');assert.equal(customer.bookings[0].pickupDate,'');assert.equal(customer.bookings[0].pickupWindow,'');
  assert.equal((await call(path,{body})).status,200);assert.equal(db.prepare("SELECT count(*) n FROM booking_events WHERE event_type='STATUS'").get().n,1);assert.equal(state.mails.length,0);
 }finally{db.close();}
});
test('unscheduling rejects stale dates and removes closed run copies without reopening, including imported bookings without email',async()=>{
 const {db,call}=await setup();try{
  db.exec(NEW_BOOKING);db.exec("UPDATE bookings SET status='CONFIRMED',pickup_date='2026-10-20'");
  assert.equal((await call('/owner/bookings/WEB-audit-1/unschedule',{body:{expectedPickupDate:'2026-10-02'}})).status,409);
  db.exec("UPDATE bookings SET status='COMPLETED'");const closed=await call('/owner/bookings/WEB-audit-1/unschedule',{body:{expectedPickupDate:'2026-10-20'}});assert.equal(closed.status,200);assert.equal((await closed.json()).removedFromRun,true);assert.equal(db.prepare("SELECT status FROM bookings WHERE id='WEB-audit-1'").get().status,'COMPLETED');
  db.exec("INSERT INTO jotform_bookings(id,submission_id,form_id,email,status,pickup_date,created_at,updated_at) VALUES('JOTFORM-unschedule','unschedule','form','','CONFIRMED','2026-10-02',0,0); INSERT INTO external_bookings(id,external_key,sync_token_hash,email,status,pickup_date,created_at,updated_at) VALUES('PICKUP-unschedule','unschedule','hash','','CONFIRMED','2026-10-02',0,0)");
  for(const id of ['JOTFORM-unschedule','PICKUP-unschedule']){const res=await call(`/owner/bookings/${id}/unschedule`,{body:{expectedPickupDate:'2026-10-02'}});assert.equal(res.status,200);const b=(await res.json()).booking;assert.equal(b.status,'NEW');assert.equal(b.pickupDate,'');assert.equal(b.source,id.startsWith('JOTFORM')?'JOTFORM':'PICKUP_RUN');}
 }finally{db.close();}
});
test('deleted and cancelled bookings can leave a run without losing history, changing dates or sending mail',async()=>{
 const {db,call,state}=await setup();try{
  db.exec(NEW_BOOKING);db.exec("UPDATE bookings SET status='CANCELLED',pickup_date='2026-09-08',cancellation_reason='Owner confirmed cancellation'");
  for(const status of ['CANCELLED','DECLINED','COMPLETED']){
   db.prepare("UPDATE bookings SET status=? WHERE id='WEB-audit-1'").run(status);
   const before=db.prepare("SELECT * FROM bookings WHERE id='WEB-audit-1'").get();
   const result=await (await call('/owner/bookings/WEB-audit-1/unschedule',{body:{expectedPickupDate:'old'}})).json();
   assert.equal(result.removedFromRun,true);assert.equal(result.booking.status,status);
   assert.deepEqual(db.prepare("SELECT * FROM bookings WHERE id='WEB-audit-1'").get(),before);
  }
  for(const id of ['WEB-missing','JOTFORM-missing','PICKUP-missing']){
   const result=await call(`/owner/bookings/${id}/unschedule`,{body:{expectedPickupDate:''}});assert.equal(result.status,200);assert.equal((await result.json()).missing,true);
  }
  assert.equal((await call('/owner/bookings/WEB-missing/unschedule',{token:'cust-audit-token',body:{expectedPickupDate:''}})).status,401);
  assert.equal(state.mails.length,0);assert.equal(db.prepare('SELECT count(*) n FROM booking_events').get().n,0);
 }finally{db.close();}
});

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
  assert.ok((source.match(/backup:\$\{OWNER_EMAIL\}/g) || []).length >= 3);
});
test('pickup note stays with the booking, is owner-only, and never changes the customer note/date',async()=>{
  const {db,call,state}=await setup();
  try{
    db.exec(NEW_BOOKING);
    db.prepare("UPDATE bookings SET additional_info='Gate code supplied by customer',pickup_date='2026-10-20' WHERE id='WEB-audit-1'").run();
    const note='AFTER 10th OCTOBER';
    const saved=await call('/owner/bookings/WEB-audit-1/owner-note',{method:'PUT',body:{note,expectedNote:''}});assert.equal(saved.status,200);
    const list=await (await call('/owner/bookings',{method:'GET'})).json();assert.equal(list.bookings[0].ownerNote,note);
    const row=db.prepare('SELECT additional_info,pickup_date FROM bookings').get();assert.equal(row.additional_info,'Gate code supplied by customer');assert.equal(row.pickup_date,'2026-10-20');
    const customer=await call('/customer/bookings',{method:'GET',token:'cust-audit-token'});const body=await customer.text();assert.equal(customer.status,200);assert.doesNotMatch(body,/AFTER 10th|ownerNote/);
    assert.equal((await call('/owner/bookings/WEB-audit-1/owner-note',{method:'GET',token:'cust-audit-token'})).status,401);
    assert.equal(state.mails.length,0);
  }finally{db.close();}
});
test('pickup note retries are idempotent, stale edits are refused, and clearing is intentional',async()=>{
  const {db,call}=await setup();try{
    db.exec(NEW_BOOKING);const path='/owner/bookings/WEB-audit-1/owner-note';
    const put=(note,expectedNote)=>call(path,{method:'PUT',body:{note,expectedNote}});
    assert.equal((await put('After 10 October','')).status,200);
    assert.equal((await put('After 10 October','')).status,200);
    assert.equal((await put('Old stale note','')).status,409);
    assert.equal((await put('','After 10 October')).status,200);
    assert.equal((await (await call(path,{method:'GET'})).json()).note,'');
    assert.equal((await put('x'.repeat(1501),'')).status,400);
    assert.equal((await call('/owner/bookings/WEB-missing/owner-note',{method:'PUT',body:{note:'No phantom booking',expectedNote:''}})).status,404);
  }finally{db.close();}
});
test('imported Jotform and pickup-run notes survive owner reads and delete with their booking',async()=>{
  const {db,call}=await setup();try{
    db.exec("INSERT INTO jotform_bookings(id,submission_id,form_id,email,created_at,updated_at) VALUES('JOTFORM-note','note','form','test@example.test',0,0); INSERT INTO external_bookings(id,external_key,sync_token_hash,email,created_at,updated_at) VALUES('PICKUP-note','note','hash','test@example.test',0,0)");
    for(const id of ['JOTFORM-note','PICKUP-note']){
      assert.equal((await call(`/owner/bookings/${id}/owner-note`,{method:'PUT',body:{note:'Keep this note',expectedNote:''}})).status,200);
      const list=await (await call('/owner/bookings',{method:'GET'})).json();assert.equal(list.bookings.find(b=>b.id===id).ownerNote,'Keep this note');
      assert.equal((await call(`/owner/bookings/${id}`,{method:'DELETE'})).status,200);
      assert.equal(db.prepare('SELECT count(*) n FROM owner_booking_notes WHERE booking_id=?').get(id).n,0);
    }
  }finally{db.close();}
});
