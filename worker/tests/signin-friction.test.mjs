/* A customer who mistypes the emailed code must not be locked out of signing up.
   This walks the real endpoint: five wrong tries, then the correct code, then a
   resend, and checks the customer is always told something true and actionable. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handlePortalRequest } from '../src/customer.js';

const json = (_r, data, status = 200) => Response.json(data, { status });

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url))
    .filter(n => n.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const wrap = {
    prepare(sql) {
      const s = db.prepare(sql);
      return {
        bind(...args) {
          return {
            first: async () => s.get(...args) || null,
            all: async () => ({ results: s.all(...args) }),
            run: async () => ({ meta: { changes: Number(s.run(...args).changes) } })
          };
        },
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
  const env = { CUSTOMER_DB: wrap, AUTH_PEPPER: 'signin-friction-test' };
  const mails = [];
  const send = async (_env, message) => { mails.push(message); return true; };
  const call = (path, body) => handlePortalRequest({
    request: new Request('https://test.invalid' + path, { method: 'POST', body: JSON.stringify(body) }),
    path, env, json, sendMail: send
  });
  const codeNow = () => {
    const found = mails.at(-1).text.match(/code is (\d{6})/);
    return found ? found[1] : '';
  };
  return { db, call, mails, codeNow };
}

const EMAIL = 'newperson@example.test';
const ask = (h, email = EMAIL) => h.call('/customer/request-code', { email });
const verify = (h, code, email = EMAIL) => h.call('/customer/verify-code', { email, code });

test('a customer who mistypes the code and then gets it right can still sign in', async () => {
  const h = setup();
  try {
    await ask(h);
    const right = h.codeNow();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) assert.equal((await verify(h, wrong)).status, 401);
    // Still within the five-attempt budget, so the correct code must work.
    assert.equal((await verify(h, right)).status, 200);
  } finally { h.db.close(); }
});

test('after five wrong tries the customer is told to ask for a new code, not that it expired', async () => {
  const h = setup();
  try {
    await ask(h);
    const right = h.codeNow();
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await verify(h, wrong);

    const spent = await verify(h, right);
    assert.equal(spent.status, 401);
    const spentBody = await spent.json();
    // The old code is genuinely dead now. Saying only "incorrect or expired" makes
    // a person retype a code that can never work, so the message must tell them to
    // ask for a new one - and say so explicitly.
    assert.match(spentBody.error, /too many tries|resend/i);
    assert.equal(spentBody.codeSpent, true);

    // The important part: they can recover by asking for a fresh code. Requesting
    // twice inside a minute is rate-limited (the endpoint raises that as a 429 at
    // the router), so age the existing codes rather than pretending the limit is
    // not there - the point is that recovery is possible, not instant.
    let refused = "";
    try { await ask(h); } catch (error) { refused = error.message; }
    assert.match(refused, /wait|latest email/i);
    h.db.prepare('UPDATE login_codes SET created_at = created_at - ?1').run(10 * 60 * 1000);
    const resent = await ask(h);
    assert.equal(resent.status, 200);
    assert.equal((await verify(h, h.codeNow())).status, 200);
  } finally { h.db.close(); }
});

test('a plain typo still says the code is wrong, not that it is exhausted', async () => {
  const h = setup();
  try {
    await ask(h);
    const right = h.codeNow();
    const wrong = right === '000000' ? '111111' : '000000';
    const res = await verify(h, wrong);
    assert.equal(res.status, 401);
    const body = await res.json();
    // One wrong try must not be described as a used-up code, or the customer
    // throws away a code that still works.
    assert.match(body.error, /incorrect or has expired/i);
    assert.equal(body.codeSpent, false);
    // And the real code still works on the next try.
    assert.equal((await verify(h, right)).status, 200);
  } finally { h.db.close(); }
});

test('a brand new customer gets an account created on first sign-in', async () => {
  const h = setup();
  try {
    await ask(h);
    const res = await verify(h, h.codeNow());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.token, 'a session token should come back');
    assert.equal(body.profile.email, EMAIL);
    // A bare account: no name, no address yet. The form must cope with that.
    assert.equal(body.profile.firstName, '');
    assert.deepEqual(body.profile.addresses, []);
  } finally { h.db.close(); }
});

test('the same email always maps to one account, however often they sign in', async () => {
  const h = setup();
  try {
    await ask(h);
    const first = await verify(h, h.codeNow());
    const firstEmail = (await first.json()).profile.email;
    // Requesting again inside a minute is rate-limited, so age the codes rather
    // than pretending the limit is not there.
    h.db.prepare('UPDATE login_codes SET created_at = created_at - ?1').run(10 * 60 * 1000);
    await ask(h);
    const second = await verify(h, h.codeNow());
    assert.equal(second.status, 200);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1);
    assert.equal((await second.json()).profile.email, firstEmail);
  } finally { h.db.close(); }
});
