import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/index.js';
import {handleIntegrationApi} from '../src/integration-api.js';
import {handlePortalRequest} from '../src/customer.js';
import {readRunBackup, writeRunBackup} from '../src/run-backup.js';
import {fakeR2} from './fake-r2.mjs';

const sample = {firstName:'API Test',lastName:'Example',phone:'0212345678',email:'api-test@example.test',
  streetAddress:'80 Hume Street',town:'Waitara',ruralOption:'Main town or main road - no travel fee',items:['Microwave'],additionalInfo:'Keep this note'};
const backupKey = 'backup:nakiwreckremoval@gmail.com';

async function setup(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  for (const file of fs.readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const wrapper = {
    prepare(sql) {
      const statement = db.prepare(sql);
      const bind = (...args) => ({first: async () => statement.get(...args) || null, all: async () => ({results: statement.all(...args)}), run: async () => ({meta: {changes: Number(statement.run(...args).changes)}})});
      return {...bind(), bind};
    },
    async batch(statements) {
      db.exec('BEGIN');
      try { const out = []; for (const statement of statements) out.push(await statement.run()); db.exec('COMMIT'); return out; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  const state = {mails: 0, botMails: []};
  const env = {CUSTOMER_DB: wrapper, BOT_RATE_LIMIT: {limit: async () => ({success: true})}, REMINDERS: {get: async () => null, put: async () => {}}};
  const ownerHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test-owner'))).toString('base64url');
  db.prepare("INSERT INTO sessions(token_hash,role,email,created_at,last_seen_at,expires_at) VALUES(?,'owner','owner@example.test',0,0,?)").run(ownerHash, Date.now() + 86400000);
  const owner = (path, method = 'GET', body) => handlePortalRequest({
    request: new Request('https://test.invalid' + path, {method, headers: {Authorization: 'Bearer test-owner', 'Content-Type': 'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})}),
    env, path, json: (_request, data, status = 200) => Response.json(data, {status}), sendMail: async () => { state.mails++; return true; }
  });
  const created = await owner('/owner/api-keys', 'POST', {name: 'Run bot', permission: 'write', expiresInDays: 90});
  const key = await created.json();
  const api = (path, method = 'GET', body, headers = {}, secret = key.secret) => handleIntegrationApi(new Request('https://test.invalid/api/v1' + path, {
    method, headers: {Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json', ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})
  }), env, {sendMail: async (_env, message) => { state.botMails.push(message); return true; }});
  const booking = await (async () => {
    const response = await api('/bookings', 'POST', sample, {'Idempotency-Key': 'create-booking-1'});
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json()).booking;
  })();
  return {db, env, state, key, api, booking};
}

function seedRuns(db, bookingId) {
  const store = {activeRunId: 'run-a', shared: {}, runs: [
    {id: 'run-a', name: 'Tuesday', createdAt: 1, updatedAt: 1, data: {confirmationDate: '2026-10-01', manual: false, stops: [
      {id: 'stop-1', submission_id: bookingId, first_name: 'API Test', last_name: 'Example', email: sample.email, street: '80 Hume Street', town: 'Waitara', status: 'NEW', historyStatus: 'ADDED_TO_RUN', appliances: ['Microwave'], note: ''},
      {id: 'stop-2', first_name: 'Second', street: '1 Main Road', town: 'Hawera', status: 'NEW', appliances: []}
    ], bad: []}},
    {id: 'run-b', name: 'Wednesday', createdAt: 1, updatedAt: 1, data: {confirmationDate: '2026-10-08', stops: [], bad: []}}
  ]};
  const record = {savedAt: 1000, runCount: 2, data: {naki_pickup_runs_v1: JSON.stringify(store), naki_custom_contacts_v1: '[]'}};
  db.prepare('INSERT INTO run_backups(owner_key,saved_at,record_json) VALUES(?,?,?)').run(backupKey, 1000, JSON.stringify(record));
}

const headers = (etag = '"1000"', key = crypto.randomUUID()) => ({'If-Match': etag, 'Idempotency-Key': key});

test('a date lists that day’s runs and stops without secrets, and writes need the backup ETag', async t => {
  const {db, api, booking} = await setup(t);
  seedRuns(db, booking.id);
  const listed = await api('/runs?date=2026-10-01');
  assert.equal(listed.headers.get('ETag'), '"1000"');
  const body = await listed.json();
  assert.equal(body.readOnly, false);
  assert.deepEqual(body.plans.map(run => run.id), ['run-a']);
  assert.equal(body.plans[0].stops[0].bookingId, booking.id);
  assert.equal(body.plans[0].stops[0].onDate, true);
  assert.equal((await api('/runs/run-a/stops/stop-1/done', 'POST', {done: true}, {'Idempotency-Key': 'missing-match'})).status, 428);
  assert.equal((await api('/runs/run-a/stops/stop-1/done', 'POST', {done: true}, {'If-Match': '"1000"'})).status, 400);
  assert.equal((await api('/runs/run-a/stops/stop-1/done', 'POST', {done: true}, headers('"999"'))).status, 412);
  assert.equal(db.prepare('SELECT status FROM bookings').get().status, 'NEW');
});

test('marking a stop done or not done stays consistent with the booking and does not email', async t => {
  const {db, api, state, booking} = await setup(t);
  seedRuns(db, booking.id);
  const doneKey = 'done-once-1';
  const done = await api('/runs/run-a/stops/stop-1/done', 'POST', {done: true}, headers('"1000"', doneKey));
  assert.equal(done.status, 200, await done.clone().text());
  const saved = await done.json();
  assert.equal(saved.stop.done, true);
  assert.equal(saved.booking.status, 'COMPLETED');
  assert.equal(saved.customerEmailed, false);
  assert.equal(state.botMails.length, 1, 'only the original booking confirmation was emailed');
  const replay = await api('/runs/run-a/stops/stop-1/done', 'POST', {done: true}, headers('"1000"', doneKey));
  assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM booking_events WHERE detail LIKE 'COMPLETED%'").get().n, 1);
  const undone = await api('/runs/run-a/stops/stop-1/done', 'POST', {done: false}, headers(saved.etag));
  assert.equal(undone.status, 200, await undone.clone().text());
  assert.equal((await undone.json()).booking.status, 'ADDED_TO_RUN');
  assert.equal(state.botMails.length, 1);
});

test('moving a stop updates the run and the booking day, and a stale phone cannot overwrite it', async t => {
  const {db, env, api, booking} = await setup(t);
  seedRuns(db, booking.id);
  const moved = await api('/runs/run-a/stops/stop-1/move', 'POST', {toRunId: 'run-b', date: '2026-10-08'}, headers());
  assert.equal(moved.status, 200, await moved.clone().text());
  const body = await moved.json();
  assert.equal(body.runId, 'run-b');
  assert.equal(body.booking.pickupDate, '2026-10-08');
  assert.equal(body.booking.status, 'ADDED_TO_RUN');
  assert.equal(body.customerEmailed, false);
  const copy = await readRunBackup(env, backupKey);
  const store = JSON.parse(copy.data.naki_pickup_runs_v1);
  assert.equal(store.runs.find(run => run.id === 'run-a').data.stops.some(stop => stop.id === 'stop-1'), false);
  assert.equal(store.runs.find(run => run.id === 'run-b').data.stops[0].confirmedPickupDate, '2026-10-08');
  const stale = await writeRunBackup(env, backupKey, {baseSavedAt: 1000, runCount: 1, data: {naki_pickup_runs_v1: '{"runs":[]}'}});
  assert.equal(stale.status, 409);
  assert.equal((await readRunBackup(env, backupKey)).savedAt, body.savedAt);
});

test('reorder, remove and a read-only key cannot change the account copy', async t => {
  const {db, env, api, key, booking} = await setup(t);
  seedRuns(db, booking.id);
  const reader = await (await handlePortalRequest({
    request: new Request('https://test.invalid/owner/api-keys', {method: 'POST', headers: {Authorization: 'Bearer test-owner', 'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Reader', permission: 'read', expiresInDays: 7})}),
    env, path: '/owner/api-keys', json: (_r, data, status = 200) => Response.json(data, {status}), sendMail: async () => false
  })).json();
  assert.equal((await api('/runs/run-a/stops/reorder', 'POST', {stopIds: ['stop-2', 'stop-1']}, headers(), reader.secret)).status, 403);
  const ordered = await api('/runs/run-a/stops/reorder', 'POST', {stopIds: ['stop-2', 'stop-1']}, headers());
  assert.equal(ordered.status, 200, await ordered.clone().text());
  const orderedBody = await ordered.json();
  assert.deepEqual(orderedBody.plan.stops.map(stop => stop.id), ['stop-2', 'stop-1']);
  assert.equal(orderedBody.plan.manual, true);
  assert.equal((await api('/runs/run-a/stops/stop-1/remove', 'POST', {}, headers(orderedBody.etag))).status, 400);
  const removed = await api('/runs/run-a/stops/stop-1/remove', 'POST', {confirm: true}, headers(orderedBody.etag));
  assert.equal(removed.status, 200, await removed.clone().text());
  const after = await removed.json();
  assert.equal(after.booking.status, 'NEW');
  assert.equal(after.booking.pickupDate, '');
  assert.equal(db.prepare('SELECT status,pickup_date FROM bookings').get().pickup_date, '');
  assert.equal(key.secret.startsWith('naki_bot_'), true);
});

test('customer email is previewed by default and sent only with confirm:true', async t => {
  const {db, api, state, booking} = await setup(t);
  seedRuns(db, booking.id);
  const preview = await api('/messages/preview', 'POST', {kind: 'confirm', date: '2026-10-08', text: 'Hey Woody here, Tuesday works.', bookingIds: [booking.id]});
  assert.equal(preview.status, 200, await preview.clone().text());
  const drafted = await preview.json();
  assert.equal(drafted.sent, false);
  assert.equal(drafted.customerEmailed, false);
  assert.match(drafted.messages[0].text, /Hi API Test, Woody here/);
  assert.equal(state.botMails.length, 1);
  assert.equal(db.prepare('SELECT status FROM bookings').get().status, 'NEW');
  const key = 'send-once-1';
  assert.equal((await api('/messages/send', 'POST', {kind: 'confirm', date: '2026-10-08', text: 'Hey Woody here, Tuesday works.', bookingIds: [booking.id]}, {'Idempotency-Key': key, 'If-Match': '"1000"'})).status, 400);
  const sent = await api('/messages/send', 'POST', {confirm: true, kind: 'confirm', date: '2026-10-08', text: 'Hey Woody here, Tuesday works.', bookingIds: [booking.id]}, {'Idempotency-Key': key, 'If-Match': '"1000"'});
  assert.equal(sent.status, 200, await sent.clone().text());
  const result = await sent.json();
  assert.equal(result.sent, 1);
  assert.equal(result.customerEmailed, true);
  assert.equal(result.sms, 'Not sent. Email only.');
  assert.equal(state.botMails.at(-1).to, sample.email);
  assert.match(state.botMails.at(-1).subject, /confirmed/i);
  assert.equal(db.prepare('SELECT status,pickup_date FROM bookings').get().pickup_date, '2026-10-08');
  const again = await api('/messages/send', 'POST', {confirm: true, kind: 'confirm', date: '2026-10-08', text: 'Hey Woody here, Tuesday works.', bookingIds: [booking.id]}, {'Idempotency-Key': key, 'If-Match': '"1000"'});
  assert.equal(again.headers.get('Idempotency-Replayed'), 'true');
  assert.equal(state.botMails.length, 2);
});

test('the change log pages past 50 and the worker route is mounted', async t => {
  const {db, env, api, key} = await setup(t);
  const insert = db.prepare('INSERT INTO bot_api_requests(id,key_id,method,path,fingerprint,created_at,status) VALUES(?,?,?,?,?,?,?)');
  for (let i = 0; i < 120; i++) insert.run('extra-' + i, key.key.id, 'POST', '/runs/run-a/stops/stop-1/done', 'fp-' + i, 1000 + i, 200);
  const page = await (await api('/activity')).json();
  assert.equal(page.pageSize, 100);
  assert.equal(page.activity.length, 100);
  assert.equal(page.hasMore, true);
  const next = await (await api('/activity?offset=' + page.nextOffset)).json();
  assert.equal(next.activity.length, 21);
  assert.equal(next.hasMore, false);
  const viaWorker = await worker.fetch(new Request('https://test.invalid/api/v1/activity', {headers: {Authorization: 'Bearer ' + key.secret}}), env);
  assert.equal(viaWorker.status, 200);
  assert.equal((await viaWorker.json()).pageSize, 100);
});

test('earnings and dropoffs are readable, and a contact edit uses the same backup token', async t => {
  const {db, api} = await setup(t);
  seedRuns(db, 'unused');
  assert.equal((await api('/earnings')).status, 200);
  assert.equal((await api('/dropoffs')).status, 200);
  assert.equal((await api('/insights')).status, 200);
  const created = await api('/contacts', 'POST', {firstName: 'Local', phone: '021000111'}, headers());
  assert.equal(created.status, 200, await created.clone().text());
  const createdBody = await created.json();
  assert.equal(createdBody.contact.phone, '021000111');
  const removed = await api('/contacts/' + createdBody.contact.id + '/delete', 'POST', {confirm: true}, headers(createdBody.etag));
  assert.equal(removed.status, 200, await removed.clone().text());
});
