/* The kids report moved onto the public Naki Kids page, so owner sign-in had to
   stop being "mail the business inbox and ask no questions". These cover the
   part that matters: only Woody's own two addresses can ever be sent a code, a
   stranger learns nothing from trying, and a code minted for one address cannot
   be redeemed against the other. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handlePortalRequest } from '../src/customer.js';

const OWNER = 'nakiwreckremoval@gmail.com';
const SECOND = 'woodywoodyemail@gmail.com';
const ORIGIN = 'https://nakiwhitewareremoval.vip';

function harness(){
  const db = new DatabaseSync(':memory:'), dir = new URL('../migrations/', import.meta.url);
  for (const file of [readdirSync(dir).find(f => f.startsWith('0001')), '0024_account_reliability.sql'])
    db.exec(readFileSync(new URL(file, dir), 'utf8'));
  const mails = [];
  const env = {
    AUTH_PEPPER: 'test-only',
    CUSTOMER_DB: {
      prepare(sql){
        const stmt = db.prepare(sql);
        const bind = (...a) => ({ bind, first: async () => stmt.get(...a) || null,
          all: async () => ({ results: stmt.all(...a) }),
          run: async () => ({ meta: { changes: Number(stmt.run(...a).changes) } }) });
        return bind();
      },
      batch: async s => Promise.all(s.map(q => q.run()))
    }
  };
  const sendMail = async (_env, msg) => { mails.push(msg); return true; };
  const json = (_req, data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  const call = (path, body) => handlePortalRequest({
    request: new Request('https://test.invalid/v2' + path, {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }),
    env, path, json, sendMail
  });
  return { db, env, mails, call };
}
const codeOf = mails => mails.at(-1).text.match(/code is (\d{6})/)[1];

test('both of the owner addresses can sign in, and a stranger cannot', async () => {
  const h = harness();
  try {
    for (const address of [OWNER, SECOND]){
      const asked = await h.call('/owner/request-code', { email: address });
      assert.equal(asked.status, 200);
      assert.equal(h.mails.at(-1).to, address, `${address} should have been mailed the code`);
      const signedIn = await h.call('/owner/verify-code', { email: address, code: codeOf(h.mails) });
      assert.equal(signedIn.status, 200);
      assert.ok((await signedIn.json()).token, `${address} should get a session token`);
    }

    const sent = h.mails.length;
    // An empty address is not a stranger: older Pickup Run builds send none, and
    // that case is covered on its own below.
    for (const stranger of ['someone@example.invalid', 'WOODYWOODYEMAIL@gmail.com.evil.test', 'woodywoodyemail@googlemail.com']){
      const res = await h.call('/owner/request-code', { email: stranger });
      // A 200 with no mail sent: an outsider should not be able to tell an
      // owner address from any other, and no code leaves the building.
      assert.equal(res.status, 200);
      assert.equal(h.mails.length, sent, `no code may be mailed for ${stranger}`);
    }
  } finally { h.db.close(); }
});

test('an owner address is matched whatever case it is typed in', async () => {
  const h = harness();
  try {
    await h.call('/owner/request-code', { email: '  WoodyWoodyEmail@Gmail.com  ' });
    assert.equal(h.mails.at(-1).to, SECOND);
    const res = await h.call('/owner/verify-code', { email: 'WOODYWOODYEMAIL@GMAIL.COM', code: codeOf(h.mails) });
    assert.equal(res.status, 200);
  } finally { h.db.close(); }
});

test('a code minted for one owner address is useless against the other', async () => {
  const h = harness();
  try {
    await h.call('/owner/request-code', { email: SECOND });
    const code = codeOf(h.mails);
    const crossed = await h.call('/owner/verify-code', { email: OWNER, code });
    assert.equal(crossed.status, 401);
    const proper = await h.call('/owner/verify-code', { email: SECOND, code });
    assert.equal(proper.status, 200);
  } finally { h.db.close(); }
});

test('an app that sends no address still reaches the business inbox', async () => {
  const h = harness();
  try {
    const res = await h.call('/owner/request-code', {});
    assert.equal(res.status, 200);
    assert.match((await res.json()).message, /Naki business email/);
    assert.equal(h.mails.at(-1).to, OWNER);
    const signedIn = await h.call('/owner/verify-code', { code: codeOf(h.mails) });
    assert.equal(signedIn.status, 200);
  } finally { h.db.close(); }
});
