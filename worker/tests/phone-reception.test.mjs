/* The phone receptionist answers on Woody's business line, so the two things
   worth guarding hardest are: nobody but Twilio can make that number talk, and
   the price it quotes is the price the booking forms charge. */
import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../src/index.js';
import { quoteFor } from '../src/phone-reception.js';

const TOKEN = 'twilio-test-auth-token';
const URL_INCOMING = 'https://naki-route-api.example.workers.dev/v2/phone/incoming';

async function sign(url, params) {
  let payload = url;
  for (const key of [...params.keys()].sort()) payload += key + params.get(key);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return Buffer.from(mac).toString('base64');
}

function callParams(over = {}) {
  return new URLSearchParams({ CallSid: 'CA123', From: '+64271112222', To: '+6462222222', ...over });
}

async function incoming(env, { signed = true, params = callParams(), method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // Twilio signs the URL it was configured with - the /v2 prefix included.
  if (signed) headers['X-Twilio-Signature'] = await sign(URL_INCOMING, params);
  return worker.fetch(new Request(URL_INCOMING, { method, headers, body: method === 'POST' ? params.toString() : undefined }), env);
}

const env = { TWILIO_AUTH_TOKEN: TOKEN, OPENAI_API_KEY: 'sk-test', RECEPTION: {} };

test('a call webhook with no signature is refused', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const res = await incoming(env, { signed: false });
    assert.equal(res.status, 403);
  } finally { console.error = quiet; }
});

test('a signature from the wrong token is refused', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const params = callParams();
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Twilio-Signature': 'Zm9yZ2VkIHNpZ25hdHVyZSB2YWx1ZQ=='
    };
    const res = await worker.fetch(new Request(URL_INCOMING, { method: 'POST', headers, body: params.toString() }), env);
    assert.equal(res.status, 403);
  } finally { console.error = quiet; }
});

test('tampering with the caller id after signing is refused', async () => {
  const quiet = console.error; console.error = () => {};
  try {
    const signature = await sign(URL_INCOMING, callParams());
    const swapped = callParams({ From: '+64277654321' });
    const res = await worker.fetch(new Request(URL_INCOMING, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature },
      body: swapped.toString()
    }), env);
    assert.equal(res.status, 403);
  } finally { console.error = quiet; }
});

test('a properly signed call is pointed at the media socket', async () => {
  const res = await incoming(env);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<Connect><Stream url="wss:\/\/naki-route-api\.example\.workers\.dev\/phone\/stream\?call=CA123/);
  assert.match(body, /&amp;from=/);
  assert.ok(!body.includes(TOKEN));
});

test('the phone routes skip the browser Origin check, or Twilio could never call', async () => {
  // Every other route 403s a request with no allowed Origin. This one must not.
  const res = await incoming(env);
  assert.equal(res.status, 200);
  const other = await worker.fetch(new Request('https://local.invalid/v2/owner/bookings'), env);
  assert.equal(other.status, 403);
});

test('with no OpenAI key the caller hears an apology, not silence', async () => {
  const res = await incoming({ TWILIO_AUTH_TOKEN: TOKEN, RECEPTION: {} });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<Say>/);
  assert.ok(!body.includes('<Stream'));
});

test('a GET on the call webhook is refused', async () => {
  const res = await incoming(env, { method: 'GET' });
  assert.equal(res.status, 405);
});

/* ---- the money it says out loud ---- */
test('the quote matches what the booking forms charge', async () => {
  // First item full price, extras cheaper - same sums as calculate().
  assert.equal(quoteFor(['Fridge/freezer'], 'town').cents, 2000);
  assert.equal(quoteFor(['Fridge/freezer', 'Fridge/freezer'], 'town').cents, 3000);
  assert.equal(quoteFor(['Microwave'], 'town').cents, 1000);
  // The dearest item sets the bump, whatever order they were said in.
  assert.equal(quoteFor(['Microwave', 'Old box TV (CRT)'], 'town').cents,
    quoteFor(['Old box TV (CRT)', 'Microwave'], 'town').cents);
  assert.equal(quoteFor(['Fridge/freezer'], 'under5km').cents, 2500);
  assert.equal(quoteFor(['Fridge/freezer'], '6to10km').cents, 3000);
});

test('nothing gets a made-up price', async () => {
  const faraway = quoteFor(['Fridge/freezer'], 'over10km');
  assert.equal(faraway.quoteRequired, true);

  const oddity = quoteFor(['A piano'], 'town');
  assert.equal(oddity.quoteRequired, true);
  assert.deepEqual(oddity.unknown, ['A piano']);

  // An unknown item alongside a known one still flags for Woody.
  const mixed = quoteFor(['Fridge/freezer', 'A piano'], 'town');
  assert.equal(mixed.quoteRequired, true);
  assert.deepEqual(mixed.known, ['Fridge/freezer']);
});

test('an empty or junk item list costs nothing and asks for a quote', async () => {
  assert.equal(quoteFor([], 'town').cents, 0);
  assert.equal(quoteFor(null, 'town').cents, 0);
  assert.equal(quoteFor(undefined, 'nonsense').ruralOption, 'Main town or main road - no travel fee');
});

/* ---- what lands in Woody's inbox ---- */
import { ownerEmailFor } from '../src/phone-reception.js';

const booked = {
  id: 'WEB-PHONE-1', name: 'Jane Smith', street: '12 Devon Street', town: 'New Plymouth',
  phone: '+64271112222', total: 3000, quoteRequired: false
};

test('a booking emails him the details and says it is not confirmed', async () => {
  const mail = ownerEmailFor({ booking: booked, transcript: ['Caller: hi', 'Reception: hello'], from: '+64271112222', seconds: 95 });
  assert.match(mail.subject, /Phone booking - Jane Smith, New Plymouth/);
  assert.match(mail.text, /12 Devon Street/);
  assert.match(mail.text, /\$30\.00/);
  // The whole point: he still decides.
  assert.match(mail.text, /NEW - nothing has been confirmed/);
  assert.match(mail.text, /nobody has been given a day/);
});

test('a job needing his quote never shows a made-up figure', async () => {
  const mail = ownerEmailFor({ booking: { ...booked, quoteRequired: true }, transcript: [], seconds: 60 });
  assert.match(mail.text, /Needs your quote/);
  assert.ok(!/\$/.test(mail.text.split('Price:')[1].split('\n')[0]));
});

test('a real conversation that took no booking still gets flagged for a call back', async () => {
  const mail = ownerEmailFor({
    booking: null,
    transcript: ['Caller: do you take fridges', 'Reception: we do, twenty dollars'],
    from: '+6421999888', reason: 'caller hung up', seconds: 40
  });
  assert.match(mail.subject, /Missed enquiry - \+6421999888/);
  assert.match(mail.text, /ringing them back/);
  assert.match(mail.text, /do you take fridges/);
});

test('a wrong number that hangs up is not worth an email', async () => {
  assert.equal(ownerEmailFor({ booking: null, transcript: [], from: '+6421000000', seconds: 2 }), null);
  assert.equal(ownerEmailFor({ booking: null, transcript: ['Reception: Naki Whiteware Removal, how can I help?'], seconds: 4 }), null);
});

test('a withheld number is described, not left blank', async () => {
  const mail = ownerEmailFor({ booking: null, transcript: ['Caller: hi', 'Reception: hello'], from: '', seconds: 20 });
  assert.match(mail.subject, /a withheld number/);
});

test('only the tail of a long call is kept, so the email stays readable', async () => {
  const long = Array.from({ length: 120 }, (_, i) => `Caller: line ${i}`);
  const mail = ownerEmailFor({ booking: null, transcript: long, seconds: 300 });
  assert.ok(mail.text.includes('line 119'));
  assert.ok(!mail.text.includes('line 79'));
});
