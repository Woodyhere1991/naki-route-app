import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {handlePortalRequest} from '../src/customer.js';
import {deliveredKey} from '../src/mail-delivered.js';

const json = (_r, data, status = 200) => Response.json(data, { status });

async function setup() {
  const db = new DatabaseSync(':memory:');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('owner-warning-test'))).toString('base64url');
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','owner@example.test',0,0,?)").run(hash, Date.now() + 600000);
  db.prepare(`INSERT INTO bookings(id,status,first_name,last_name,phone,email,street_address,town,area,rural_option,items_json,total_cents,created_at,updated_at)
    VALUES('WEB-alex','NEW','Alex','C','021','Alex@Example.test','27b Meade Place','Bell Block','Bell Block','','[]',2000,1000,1000)`).run();
  db.prepare("INSERT INTO booking_events(id,booking_id,event_type,detail,created_at) VALUES('e1','WEB-alex','EMAIL_FAILED','Confirmation email failed',5000)").run();
  const wrap = { prepare(sql) { const s = db.prepare(sql); return {
    bind(...args) { return { first: async () => s.get(...args) || null, all: async () => ({ results: s.all(...args) }), run: async () => ({ meta: { changes: Number(s.run(...args).changes) } }) }; },
    all: async () => ({ results: s.all() }) }; } };
  const kv = new Map();
  const env = { CUSTOMER_DB: wrap, REMINDERS: { get: async k => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } };
  const list = async () => {
    const res = await handlePortalRequest({ request: new Request('https://test.invalid/owner/bookings', { headers: { Authorization: 'Bearer owner-warning-test' } }),
      env, path: '/owner/bookings', json, sendMail: async () => true });
    const body = await res.json();
    return body.bookings.find(b => b.id === 'WEB-alex');
  };
  return { db, kv, list };
}

test('a failed email shows the warning until a later email to that customer goes through', async () => {
  const { db, kv, list } = await setup();
  try {
    assert.equal((await list()).emailFailed, true);
    kv.set(deliveredKey('alex@example.test'), '4000'); // delivered BEFORE the failure: still a warning
    assert.equal((await list()).emailFailed, true);
    kv.set(deliveredKey(' ALEX@example.test '), '9000'); // delivered after it: cleared
    assert.equal((await list()).emailFailed, false);
  } finally { db.close(); }
});
