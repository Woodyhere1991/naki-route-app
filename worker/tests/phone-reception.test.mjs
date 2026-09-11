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
