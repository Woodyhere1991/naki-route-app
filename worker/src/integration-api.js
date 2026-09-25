import { readRunBackup } from "./run-backup.js";
import {apiBody, apiDigest} from './api-keys.js';
import {handlePortalRequest, bookingFrom, profileFrom, ITEM_PRICES, RURAL_PRICES, OWNER_EMAIL} from './customer.js';
import {apiSchema} from './integration-schema.js';

const BASE = '/api/v1';
const statuses = ['NEW', 'ADDED_TO_RUN', 'CONTACTED', 'CONFIRMED', 'COMPLETED', 'DECLINED', 'CANCELLED'];
const textFields = {firstName: 60, lastName: 60, phone: 30, email: 160, streetAddress: 180, town: 100,
  area: 100, ruralOption: 120, additionalInfo: 1500, requestedDate: 10, status: 30,
  pickupDate: 10, pickupWindow: 80, customerNote: 500, quoteNote: 300, accessNotes: 1000};
const createFields = ['firstName','lastName','phone','email','streetAddress','town','area','ruralOption','items','additionalInfo','requestedDate','expectedTotalCents','expectedQuoteRequired'];
const bookingFields = createFields.filter(x => !['requestedDate','expectedTotalCents','expectedQuoteRequired'].includes(x)).concat(['status','pickupDate','pickupWindow','customerNote','quoteAmount','quoteNote']);
const customerFields = ['firstName','lastName','phone','streetAddress','town','area','ruralOption','accessNotes'];

function reply(data, status = 200, headers = {}) {
  return Response.json(data, {status, headers: {'Cache-Control': 'no-store, no-transform', 'X-Content-Type-Options': 'nosniff', ...headers}});
}
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const etag = row => '"' + row.updated_at + '"';
function bookingTable(id) { return id.startsWith('JOTFORM-') ? 'jotform_bookings' : id.startsWith('PICKUP-') ? 'external_bookings' : 'bookings'; }
function bookingView(row) {
  return {...bookingFrom({...row, booking_source: row.id.startsWith('JOTFORM-') ? 'JOTFORM' : row.id.startsWith('PICKUP-') ? 'PICKUP_RUN' : 'WEBSITE'}), updatedAt: row.updated_at};
}
function safeRunCopy(value) {
  if (Array.isArray(value)) return value.map(safeRunCopy);
  if (!value || typeof value !== 'object') return value;
  // Run stops contain historySyncToken/profileInviteUrl credentials. A read-only
  // bot must never receive a token it could use to write through another route.
  return Object.fromEntries(Object.entries(value)
    .filter(([name]) => !/token|secret|password|authorization|inviteurl|apikey|credential/i.test(name))
    .map(([name, child]) => [name, safeRunCopy(child)]));
}
function validate(body, fields) {
  if (!Object.keys(body).length) fail('Provide at least one field to change.');
  for (const [name, value] of Object.entries(body)) {
    if (!fields.includes(name)) fail('Unsupported field: ' + name);
    if (name in textFields && (typeof value !== 'string' || value.length > textFields[name])) fail(name + ' must be text, up to ' + textFields[name] + ' characters.');
  }
  for (const name of ['pickupDate','requestedDate']) {
    const value = body[name];
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value)) fail(name + ' must be a real date in YYYY-MM-DD format.');
  }
  if ('status' in body && !statuses.includes(body.status)) fail('Choose a status from /catalog.');
  if ('ruralOption' in body && !Object.hasOwn(RURAL_PRICES, body.ruralOption)) fail('Choose a ruralOption from /catalog.');
  if ('items' in body && (!Array.isArray(body.items) || !body.items.length || body.items.length > 10 || body.items.some(x => typeof x !== 'string' || !Object.hasOwn(ITEM_PRICES, x)))) fail('Use 1 to 10 item names from /catalog. Repeat a name for multiple items.');
  if ('expectedTotalCents' in body && (!Number.isSafeInteger(body.expectedTotalCents) || body.expectedTotalCents < 0)) fail('expectedTotalCents must be a non-negative integer.');
  if ('expectedQuoteRequired' in body && typeof body.expectedQuoteRequired !== 'boolean') fail('expectedQuoteRequired must be true or false.');
  if ('quoteAmount' in body && (typeof body.quoteAmount !== 'number' || !Number.isFinite(body.quoteAmount) || body.quoteAmount < 0 || body.quoteAmount > 100000)) fail('quoteAmount must be an NZD amount from 0 to 100000.');
}

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer naki_bot_[a-f0-9]{64}$/.test(auth)) fail('A valid bot API key is required in Authorization: Bearer <secret>.', 401);
  const key = await env.CUSTOMER_DB.prepare('SELECT * FROM bot_api_keys WHERE token_hash=?1 AND revoked_at IS NULL AND expires_at>?2')
    .bind(await apiDigest(auth.slice(7)), Date.now()).first();
  if (!key) fail('This API key is invalid, expired or revoked.', 401);
  if (!(await env.BOT_RATE_LIMIT.limit({key: 'key:' + key.id})).success) fail('Too many requests. Wait a minute.', 429);
  await env.CUSTOMER_DB.prepare('UPDATE bot_api_keys SET last_used_at=?1 WHERE id=?2').bind(Date.now(), key.id).run();
  return key;
}

async function writeOnce(request, env, key, path, body, run) {
  const reference = request.headers.get('Idempotency-Key') || '';
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(reference)) fail('Supply an Idempotency-Key (8 to 100 letters, digits, dashes or underscores). Reuse it only when retrying the same change.');
  const id = await apiDigest(key.id + '|' + reference);
  const fingerprint = await apiDigest(request.method + '|' + path + '|' + (request.headers.get('If-Match') || '') + '|' + JSON.stringify(body));
  const db = env.CUSTOMER_DB;
  const replay = async () => {
    const row = await db.prepare('SELECT fingerprint,status,response FROM bot_api_requests WHERE id=?1').bind(id).first();
    if (!row) return null;
    if (row.fingerprint !== fingerprint) return reply({error: 'That Idempotency-Key was already used with different details.'}, 409);
    if (!row.status || !row.response) return reply({error: 'The earlier request is processing or its result is uncertain. Read the record before trying another change.'}, 409);
    return reply(JSON.parse(row.response), row.status, {'Idempotency-Replayed': 'true'});
  };
  const previous = await replay();
  if (previous) return previous;
  const claim = await db.prepare(`INSERT OR IGNORE INTO bot_api_requests(id,key_id,method,path,fingerprint,created_at)
    VALUES(?1,?2,?3,?4,?5,?6)`).bind(id, key.id, request.method, path, fingerprint, Date.now()).run();
  if (!claim.meta?.changes) return await replay() || reply({error: 'Request already in progress.'}, 409);
  // An interrupted write retains its claim; it must not be executed twice.
  let response;
  try { response = await run(); }
  catch (error) {
    if (!error.status) throw error;
    response = reply({error: error.message}, error.status);
  }
  await db.prepare('UPDATE bot_api_requests SET status=?1,response=?2 WHERE id=?3').bind(response.status, await response.clone().text(), id).run();
  return response;
}

export async function handleIntegrationApi(request, environment, {sendMail = null} = {}) {
  try {
    const url = new URL(request.url), path = url.pathname.slice(BASE.length);
    if (path === '/openapi.json' && request.method === 'GET') return reply(apiSchema(url.origin));
    // Read from primary so an immediately revoked key cannot survive on a replica.
    const env = {...environment, CUSTOMER_DB: environment.CUSTOMER_DB?.withSession?.('first-primary') || environment.CUSTOMER_DB};
    if (!env.CUSTOMER_DB || !env.BOT_RATE_LIMIT) fail('Bot API is not ready.', 503);
    const ip = request.headers.get('CF-Connecting-IP');
    if (ip && !(await env.BOT_RATE_LIMIT.limit({key: 'ip:' + ip})).success) fail('Too many requests. Wait a minute.', 429);
    const key = await authenticate(request, env);
    const match = path.match(/^\/(bookings|customers)\/([a-zA-Z0-9_-]{1,120})$/);
    const kind = match?.[1], id = match?.[2];
    const isRead = request.method === 'GET';
    if (!isRead && key.permission !== 'write') fail('This key is read-only.', 403);
    // Only booking creation gets the real sender, so the customer receives the same
    // booking confirmation a website booking sends. Every other bot call stays silent.
    const portal = async (target, method = 'GET', body, version = null, {email = false} = {}) => {
      const response = await handlePortalRequest({
        request: new Request(url.origin + target + url.search, {method, headers: {'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})}),
        env, path: target, json: (_r, data, status) => reply(data, status),
        sendMail: email && sendMail ? sendMail : async () => false,
        integrationSession: {role: 'owner', email: OWNER_EMAIL, apiKeyId: key.id, expectedUpdatedAt: version}
      });
      return response;
    };
    if (isRead) {
      if (path === '/me') return reply({name: key.name, permission: key.permission, expiresAt: key.expires_at});
      if (path === '/catalog') return reply({currency: 'NZD', items: Object.keys(ITEM_PRICES), ruralOptions: Object.keys(RURAL_PRICES), itemPrices: ITEM_PRICES, ruralPrices: RURAL_PRICES, statuses});
      if (path === '/bookings' || path === '/customers') return portal('/owner' + path);
      if (match) {
        const table = kind === 'bookings' ? bookingTable(id) : 'customers';
        const row = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(id).first();
        if (!row) fail('Record not found.', 404);
        return reply({[kind === 'bookings' ? 'booking' : 'customer']: kind === 'bookings' ? bookingView(row) : {id: row.id, ...profileFrom(row), updatedAt: row.updated_at}}, 200, {ETag: etag(row)});
      }
      if (path === '/runs') {
        const saved = await readRunBackup(env, 'backup:' + OWNER_EMAIL);
        let store = {};
        if (saved?.data?.naki_pickup_runs_v1) {
          try { store = JSON.parse(saved.data.naki_pickup_runs_v1); } catch { fail('The saved run copy could not be read.', 503); }
        }
        return reply({savedAt: saved?.savedAt || null, source: 'Last account backup; unsynced phone changes are not included.', readOnly: true, runs: safeRunCopy(store.runs || [])});
      }
      fail('Endpoint not found. See /api/v1/openapi.json.', 404);
    }
    const creating = request.method === 'POST' && path === '/bookings';
    const patching = request.method === 'PATCH' && match;
    if (!creating && !patching) fail('This method or endpoint is not available to bot keys.', 405);
    const body = await apiBody(request);
    validate(body, creating ? createFields : kind === 'bookings' ? bookingFields : customerFields);
    return await writeOnce(request, env, key, path, body, async () => {
      if (creating) {
        const items = body.items || [];
        const total = items.reduce((sum,item)=>sum+ITEM_PRICES[item][1],0)
          + (items.length ? Math.max(...items.map(item=>ITEM_PRICES[item][0]-ITEM_PRICES[item][1])) : 0)
          + (RURAL_PRICES[body.ruralOption] || 0);
        const quote = items.includes('Other') || String(body.ruralOption||'').startsWith('More than 10 km');
        if (('expectedTotalCents' in body && body.expectedTotalCents !== total)
          || ('expectedQuoteRequired' in body && body.expectedQuoteRequired !== quote))
          return reply({error:'The caller quote differs from current Naki pricing. Review before creating this booking.'},422);
        const {expectedTotalCents,expectedQuoteRequired,...fields}=body;
        return portal('/owner/bookings', 'POST', fields, null, {email: true});
      }
      const table = kind === 'bookings' ? bookingTable(id) : 'customers';
      const row = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(id).first();
      if (!row) fail('Record not found.', 404);
      const expected = request.headers.get('If-Match');
      if (!expected) fail('Read this record first and send its ETag in If-Match.', 428);
      // Cloudflare may prefix an ETag with W/ when it compresses JSON. This
      // validator represents the database revision, independent of encoding.
      if (expected.replace(/^W\//, '') !== etag(row)) fail('This record changed. Read it again before editing.', 412);
      if (kind === 'bookings') {
        return portal('/owner/bookings/' + id, 'PATCH', {...body, status: body.status || row.status, notifyCustomer: false}, row.updated_at);
      }
      return portal('/owner/customers/' + id, 'PUT', {
        ...Object.fromEntries(customerFields.map(field => [field, profileFrom(row)[field]])), ...body
      }, row.updated_at);
    });
  } catch (error) {
    const status = error.status || 500;
    return reply({error: error.status ? error.message : 'The API request could not finish. For a write, retry with the same Idempotency-Key or read the record to check its result.'}, status,
      status === 401 ? {'WWW-Authenticate': 'Bearer'} : status === 429 ? {'Retry-After': '60'} : {});
  }
}

export async function purgeApiRequests(env) {
  // Keep the fingerprint/claim as a tombstone for the lifetime of an active key.
  // Clear customer-bearing response bodies after seven days, without re-executing old writes.
  await env.CUSTOMER_DB.prepare('UPDATE bot_api_requests SET response=NULL WHERE response IS NOT NULL AND created_at<?1').bind(Date.now() - 7 * 86400000).run();
  await env.CUSTOMER_DB.prepare(`DELETE FROM bot_api_requests WHERE created_at<?1 AND key_id IN
    (SELECT id FROM bot_api_keys WHERE revoked_at IS NOT NULL OR expires_at<?2)`).bind(Date.now() - 90 * 86400000, Date.now()).run();
}
