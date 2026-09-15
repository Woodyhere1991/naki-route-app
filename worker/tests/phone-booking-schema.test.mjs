/* The phone receptionist saves a booking straight into the bookings table. That
   only works if the schema agrees with it, and a mismatch here fails silently at
   the worst moment - on a live call. These tests apply the real migrations to a
   real in-memory database and then save a booking exactly as the receptionist
   does, so a future schema change cannot quietly break phone bookings again. */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function migrate() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  // The whole chain in order, exactly as production ran it - 0027 rebuilds the
  // bookings table, so it depends on every earlier ALTER having been applied.
  const files = fs.readdirSync(new URL('../migrations/', import.meta.url))
    .filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  return db;
}

// The exact statement from src/phone-reception.js saveBooking().
function savePhoneBooking(db, customerId, email = '') {
  return db.prepare(
    `INSERT INTO bookings (
       id, customer_id, status, first_name, last_name, phone, email, street_address, town, area,
       rural_option, items_json, additional_info, referral_source, referral_details,
       total_cents, quote_required, created_at, updated_at
     ) VALUES (?1, ?2, 'NEW', ?3, ?4, ?5, ?6, ?7, ?8, '', ?9, ?10, ?11, 'Phone', 'Phone receptionist', ?12, ?13, ?14, ?14)`
  ).run(
    `WEB-PHONE-${Math.random().toString(36).slice(2)}`, customerId, 'Ana', 'Smith', '0212345678', email,
    '80 Hume Street', 'Waitara', 'Main town or main road - no travel fee', '["Microwave"]',
    'Taken by the phone receptionist.', 1000, 0, Date.now()
  );
}

test('a phone booking saves when the caller gave no email', () => {
  const db = migrate();
  try {
    // No account exists, so there is nothing to attach the booking to.
    savePhoneBooking(db, null, '');
    const row = db.prepare('SELECT * FROM bookings').get();
    assert.equal(row.customer_id, null);
    assert.equal(row.referral_source, 'Phone');
    assert.equal(row.status, 'NEW');
  } finally { db.close(); }
});

test('a phone booking attaches to the account when the email is known', () => {
  const db = migrate();
  try {
    db.exec("INSERT INTO customers(id,email,created_at,updated_at) VALUES('cust-1','ana@example.test',0,0)");
    savePhoneBooking(db, 'cust-1', 'ana@example.test');
    assert.equal(db.prepare('SELECT customer_id FROM bookings').get().customer_id, 'cust-1');
  } finally { db.close(); }
});

test('customer_id really is nullable now, with SET NULL rather than RESTRICT', () => {
  const db = migrate();
  try {
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='bookings'").get().sql;
    assert.match(sql, /customer_id TEXT,/);
    assert.doesNotMatch(sql, /customer_id TEXT NOT NULL/);
    assert.match(sql, /ON DELETE SET NULL/);
  } finally { db.close(); }
});

test('a phone booking is kept when its customer account is deleted', () => {
  const db = migrate();
  try {
    db.exec("INSERT INTO customers(id,email,created_at,updated_at) VALUES('cust-1','ana@example.test',0,0)");
    savePhoneBooking(db, 'cust-1', 'ana@example.test');
    // The owner delete route removes bookings itself, so this mirrors the schema
    // guarantee we rely on rather than that route: deleting the account must not
    // be blocked by (RESTRICT) and must not wipe the job.
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec("DELETE FROM customers WHERE id='cust-1'");
    const row = db.prepare('SELECT customer_id FROM bookings').get();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1);
    assert.equal(row.customer_id, null);
  } finally { db.close(); }
});

test('the bookings indexes survive the table rebuild', () => {
  const db = migrate();
  try {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='bookings' AND name NOT LIKE 'sqlite_%'"
    ).all().map(row => row.name);
    for (const wanted of ['bookings_customer', 'bookings_owner_inbox', 'bookings_sheet_retry']) {
      assert.ok(names.includes(wanted), `${wanted} is missing`);
    }
  } finally { db.close(); }
});