// Bot edits go through the same account backup the phone pushes and pulls.
// savedAt is the compare-and-swap token: a phone with unsynced edits keeps its
// copy, and a bot never overwrites a newer backup. There is no second run database.
import {readRunBackup, writeRunBackup} from './run-backup.js';
import {OWNER_EMAIL, bookingFrom, pickupConfirmationText, pickupDateText} from './customer.js';
import {ownerNotesFor} from './owner-booking-notes.js';
import {binBooking, restoreFromBin, reopenBooking, tableFor, sourceFor, BIN_DAYS} from './booking-recovery.js';

export const RUNS_KEY = 'naki_pickup_runs_v1';
export const CONTACTS_KEY = 'naki_custom_contacts_v1';
const BACKUP_KEY = 'backup:' + OWNER_EMAIL;
const CLOSED = ['CANCELLED', 'DECLINED'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const dateOk = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value + 'T12:00:00Z')) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
const nzDay = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', {timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
const newId = prefix => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
export const etagOf = savedAt => '"' + savedAt + '"';
export function etagMatches(header, savedAt) {
  return Boolean(header) && header.replace(/^W\//, '') === etagOf(savedAt);
}

function parseJson(value, label) {
  if (value == null || value === '') return null;
  try { return typeof value === 'string' ? JSON.parse(value) : value; }
  catch { fail('The saved ' + label + ' could not be read.', 503); }
}

export async function loadAccount(env) {
  const saved = await readRunBackup(env, BACKUP_KEY);
  if (!saved?.data) return {saved: null, store: {activeRunId: '', runs: [], shared: {}}, contacts: []};
  const parsed = parseJson(saved.data[RUNS_KEY], 'run copy');
  const store = parsed && typeof parsed === 'object' ? parsed : {activeRunId: '', runs: [], shared: {}};
  if (!Array.isArray(store.runs)) store.runs = [];
  store.shared = store.shared && typeof store.shared === 'object' ? store.shared : {};
  const contacts = parseJson(saved.data[CONTACTS_KEY], 'contacts');
  return {saved, store, contacts: Array.isArray(contacts) ? contacts : []};
}

function requireBackup(loaded) {
  if (!loaded.saved) fail('No account copy of the runs exists yet. Open the app while signed in and let it finish saving. Nothing was changed.', 409);
}
function requireMatch(request, savedAt) {
  const expected = request.headers.get('If-Match');
  if (!expected) fail('Read the runs first and send the ETag in If-Match.', 428);
  if (!etagMatches(expected, savedAt)) fail('The runs changed. Read them again before editing.', 412);
}
function ensureData(run) {
  run.data = run.data && typeof run.data === 'object' ? run.data : {};
  if (!Array.isArray(run.data.stops)) run.data.stops = [];
  if (!Array.isArray(run.data.bad)) run.data.bad = [];
  return run.data;
}
function touch(run) { run.updatedAt = Date.now(); }
function locate(store, stopId, runId = '') {
  const hits = [];
  for (const run of store.runs) {
    if (runId && run.id !== runId) continue;
    for (const list of ['stops', 'bad']) {
      const rows = ensureData(run)[list];
      const index = rows.findIndex(stop => stop && stop.id === stopId);
      if (index >= 0) hits.push({run, list, index, stop: rows[index]});
    }
  }
  if (hits.length > 1) fail('That stop id is on more than one run. Nothing was changed.', 409);
  return hits[0] || null;
}
function runDate(run) { return run?.data?.confirmationDate || run?.data?.planningDay || ''; }
function safeCopy(value) {
  if (Array.isArray(value)) return value.map(safeCopy);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !/token|secret|password|authorization|inviteurl|apikey|credential/i.test(name)).map(([name, child]) => [name, safeCopy(child)]));
}
function onDate(stop, run, date) {
  if (!date) return true;
  if (stop.confirmedPickupDate) return stop.confirmedPickupDate === date;
  return runDate(run) === date;
}
function publicStop(stop, run, date, index, needsAddress) {
  return {
    id: String(stop.id || ''), bookingId: String(stop.submission_id || ''),
    name: [stop.first_name, stop.last_name].filter(Boolean).join(' '),
    phone: String(stop.phone || ''), email: String(stop.email || ''),
    street: String(stop.street || ''), town: String(stop.town || ''), area: String(stop.area || ''),
    items: Array.isArray(stop.appliances) ? stop.appliances.map(String) : [],
    note: String(stop.note || ''), status: stop.status === 'DONE' ? 'DONE' : 'PENDING',
    done: stop.status === 'DONE', confirmedPickupDate: String(stop.confirmedPickupDate || ''),
    historyStatus: String(stop.historyStatus || ''), kind: stop.kind === 'unload' ? 'unload' : 'pickup',
    priority: Boolean(stop.priority), needsAddress, position: index, onDate: onDate(stop, run, date)
  };
}
function publicRun(run, date, activeId) {
  const data = run.data && typeof run.data === 'object' ? run.data : {};
  const stops = (Array.isArray(data.stops) ? data.stops : []).map((stop, index) => publicStop(stop, run, date, index, false));
  const needsAddress = (Array.isArray(data.bad) ? data.bad : []).map((stop, index) => publicStop(stop, run, date, index, true));
  return {
    id: run.id, name: run.name || '', confirmationDate: data.confirmationDate || '', planningDay: data.planningDay || '',
    manual: Boolean(data.manual), roundTrip: Boolean(data.roundTrip), active: run.id === activeId,
    pending: stops.filter(stop => !stop.done && stop.kind !== 'unload').length, stops, needsAddress
  };
}
function runIncluded(plan, date) {
  if (!date) return true;
  return plan.confirmationDate === date || plan.planningDay === date || plan.stops.some(stop => stop.onDate) || plan.needsAddress.some(stop => stop.onDate);
}
function markKey(stop) {
  const id = String(stop.submission_id || '').trim();
  if (/^(?:WEB|JOTFORM|PICKUP)-[A-Z0-9_-]{6,}$/i.test(id) || /^\d{6,}$/.test(id)) return 'id:' + id.toLowerCase();
  return 'stop:' + stop.id;
}
function addMark(run, bucket, stop, changes) {
  const data = ensureData(run);
  data.messageHistory = data.messageHistory || {};
  const bag = data.messageHistory[bucket] = data.messageHistory[bucket] || {};
  bag[markKey(stop)] = {...(bag[markKey(stop)] || {}), stopId: stop.id, deliveryVersion: 2, ...changes};
}

async function saveAccount(env, loaded, store, data) {
  data[RUNS_KEY] = JSON.stringify(store);
  const rough = JSON.stringify({savedAt: loaded.saved.savedAt, runCount: store.runs.length, data});
  if (rough.length > 4 * 1024 * 1024) fail('That change would make the account backup too big. Nothing was changed.', 413);
  const written = await writeRunBackup(env, BACKUP_KEY, {baseSavedAt: loaded.saved.savedAt, runCount: store.runs.length, data});
  if (written.error) fail(written.status === 409 ? 'The runs changed. Read them again before editing.' : written.error, written.status === 409 ? 412 : written.status);
  return written.savedAt;
}

async function editAccount(env, request, change, baseSavedAt = null) {
  const loaded = await loadAccount(env);
  requireBackup(loaded);
  if (baseSavedAt == null) requireMatch(request, loaded.saved.savedAt);
  else if (loaded.saved.savedAt !== baseSavedAt) return {conflict: true, savedAt: loaded.saved.savedAt, etag: etagOf(loaded.saved.savedAt)};
  const store = JSON.parse(JSON.stringify(loaded.store));
  const data = {...loaded.saved.data};
  const undos = [];
  const undo = fn => undos.push(fn);
  try {
    const result = await change({store, data, saved: loaded.saved, contacts: JSON.parse(JSON.stringify(loaded.contacts)), undo});
    if (result?.skip) return {savedAt: loaded.saved.savedAt, etag: etagOf(loaded.saved.savedAt), customerEmailed: false, ...result.body};
    if (result?.contacts) data[CONTACTS_KEY] = JSON.stringify(result.contacts);
    const savedAt = await saveAccount(env, loaded, store, data);
    return {savedAt, etag: etagOf(savedAt), customerEmailed: false, ...result?.body};
  } catch (error) {
    let undoFailed = false;
    for (const fn of undos.reverse()) { try { await fn(); } catch { undoFailed = true; } }
    if (undoFailed) fail('The runs changed, and a booking update could not be undone. Read the booking and the runs before trying again.', 409);
    throw error;
  }
}

async function readBooking(env, id) {
  const table = tableFor(id);
  const row = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(id).first();
  return row ? {table, row} : null;
}
async function publicBooking(env, id) {
  const found = await readBooking(env, id);
  if (!found) return null;
  const notes = await ownerNotesFor(env.CUSTOMER_DB, [id]);
  return {...bookingFrom({...found.row, booking_source: sourceFor(found.table)}), ownerNote: notes.get(id) || '', updatedAt: found.row.updated_at};
}
async function portalJson(portal, target, method, body, version) {
  const response = await portal(target, method, body, version);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(payload.error || 'The booking could not be updated.', response.status || 409);
  return payload;
}
async function ensureBooking(env, portal, undo, id, next) {
  const found = await readBooking(env, id);
  if (!found) return null;
  const row = found.row;
  if (CLOSED.includes(row.status)) fail('This booking is ' + row.status + '. Restore it before changing its run. Nothing was changed.', 409);
  const status = next.status || row.status;
  const pickupDate = next.pickupDate == null ? (row.pickup_date || '') : next.pickupDate;
  const pickupWindow = next.pickupWindow == null ? (row.pickup_window || '') : next.pickupWindow;
  if (status === row.status && pickupDate === (row.pickup_date || '') && pickupWindow === (row.pickup_window || '')) return publicBooking(env, id);
  if (status === 'CONFIRMED' && !dateOk(pickupDate)) fail('A confirmed booking needs a real pickup date.', 400);
  await portalJson(portal, '/owner/bookings/' + encodeURIComponent(id), 'PATCH', {status, pickupDate, pickupWindow, notifyCustomer: false}, row.updated_at);
  const fresh = await readBooking(env, id);
  undo(async () => {
    const current = await readBooking(env, id);
    if (!current) return;
    await portalJson(portal, '/owner/bookings/' + encodeURIComponent(id), 'PATCH', {
      status: row.status, pickupDate: row.pickup_date || '', pickupWindow: row.pickup_window || '', notifyCustomer: false
    }, current.row.updated_at);
  });
  return publicBooking(env, id);
}
async function unscheduleBooking(env, portal, undo, id) {
  const found = await readBooking(env, id);
  if (!found) return null;
  const row = found.row;
  if (CLOSED.includes(row.status) || row.status === 'COMPLETED' || (row.status === 'NEW' && !row.pickup_date && !row.pickup_window)) return publicBooking(env, id);
  await portalJson(portal, '/owner/bookings/' + encodeURIComponent(id) + '/unschedule', 'POST', {expectedPickupDate: row.pickup_date || ''});
  undo(async () => {
    const current = await readBooking(env, id);
    if (!current) return;
    await portalJson(portal, '/owner/bookings/' + encodeURIComponent(id), 'PATCH', {
      status: row.status, pickupDate: row.pickup_date || '', pickupWindow: row.pickup_window || '', notifyCustomer: false
    }, current.row.updated_at);
  });
  return publicBooking(env, id);
}
function linkedId(stop) {
  const id = String(stop?.submission_id || '').trim();
  return /^(?:WEB|PHONE|JOTFORM|PICKUP)-[A-Za-z0-9_-]{1,120}$/.test(id) ? id : '';
}
function requireRun(store, runId) {
  const run = store.runs.find(item => item.id === runId);
  if (!run) fail('Run not found.', 404);
  ensureData(run);
  return run;
}
export async function presentRuns(env, url, path) {
  const date = url.searchParams.get('date') || '';
  if (date && !dateOk(date)) fail('date must be a real day in YYYY-MM-DD format.', 400);
  const loaded = await loadAccount(env);
  const savedAt = loaded.saved?.savedAt || null;
  const runMatch = path.match(/^\/runs\/([A-Za-z0-9_.:-]{1,120})$/);
  const stopMatch = path.match(/^\/runs\/([A-Za-z0-9_.:-]{1,120})\/stops\/([A-Za-z0-9_.:-]{1,120})$/);
  const headers = savedAt ? {ETag: etagOf(savedAt)} : {};
  const base = {savedAt, etag: savedAt ? etagOf(savedAt) : null, source: 'Account backup. Unsynced phone edits are not included. A phone with no newer local edits pulls this copy on its next sync.', customerEmailed: false};
  if (!runMatch && !stopMatch) {
    const plans = loaded.store.runs.map(run => publicRun(run, date, loaded.store.activeRunId)).filter(plan => runIncluded(plan, date));
    const ids = new Set(plans.map(plan => plan.id));
    return {body: {...base, date: date || null, readOnly: false, plans, runs: safeCopy(loaded.store.runs.filter(run => !date || ids.has(run.id)))}, headers};
  }
  const run = loaded.store.runs.find(item => item.id === (stopMatch?.[1] || runMatch[1]));
  if (!run) fail('Run not found.', 404);
  if (stopMatch) {
    const found = locate(loaded.store, stopMatch[2], run.id);
    if (!found) fail('Stop not found.', 404);
    return {body: {...base, runId: run.id, stop: publicStop(found.stop, run, '', found.index, found.list === 'bad')}, headers};
  }
  return {body: {...base, plan: publicRun(run, date, loaded.store.activeRunId)}, headers};
}

export async function presentContacts(env) {
  const loaded = await loadAccount(env);
  const savedAt = loaded.saved?.savedAt || null;
  return {body: {savedAt, etag: savedAt ? etagOf(savedAt) : null, contacts: loaded.contacts.map(publicContact)}, headers: savedAt ? {ETag: etagOf(savedAt)} : {}};
}
function publicContact(contact) {
  return {id: String(contact.id || ''), firstName: String(contact.firstName || ''), lastName: String(contact.lastName || ''),
    phone: String(contact.phone || ''), email: String(contact.email || ''), streetAddress: String(contact.streetAddress || ''),
    town: String(contact.town || ''), area: String(contact.area || ''), accessNotes: String(contact.accessNotes || '')};
}
function contactFields(body, existing = {}) {
  const limits = {firstName: 60, lastName: 60, phone: 30, email: 160, streetAddress: 180, town: 100, area: 100, accessNotes: 1500};
  const next = {...publicContact(existing)};
  for (const [name, max] of Object.entries(limits)) {
    if (!(name in body)) continue;
    if (typeof body[name] !== 'string' || body[name].length > max) fail(name + ' must be text, up to ' + max + ' characters.');
    next[name] = body[name].trim();
  }
  if (next.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next.email)) fail('Enter a valid email address, or leave it blank.');
  if (!next.phone) fail('A phone number is required for a saved contact.');
  return next;
}

function stopFromBooking(row, note) {
  let items = [];
  try { items = JSON.parse(row.items_json || '[]'); } catch { items = []; }
  return {
    id: newId('s'), src: 'direct', submission_id: row.id, first_name: row.first_name || '', last_name: row.last_name || '',
    phone: row.phone || '', email: row.email || '', street: row.street_address || '', town: row.town || '', area: row.area || '',
    appliances: items, additional_info: row.additional_info || '', note: note || '', ownerNoteSynced: note || '',
    amount: row.quoted_at ? Number(row.quote_cents || 0) / 100 : Number(row.total_cents || 0) / 100,
    status: 'NEW', historyStatus: row.pickup_date ? 'CONFIRMED' : 'ADDED_TO_RUN', confirmedPickupDate: row.pickup_date || ''
  };
}
function manualStop(body) {
  for (const name of ['firstName', 'lastName', 'phone', 'email', 'street', 'town', 'area', 'note']) {
    if (name in body && (typeof body[name] !== 'string' || body[name].length > 500)) fail(name + ' must be text.');
  }
  if (!String(body.street || '').trim() || !String(body.town || '').trim()) fail('A manual stop needs a street and a town.');
  const items = Array.isArray(body.items) ? body.items.map(item => String(item).slice(0, 80)).filter(Boolean).slice(0, 10) : [];
  return {
    id: newId('s'), src: 'manual', first_name: String(body.firstName || '').trim(), last_name: String(body.lastName || '').trim(),
    phone: String(body.phone || '').trim(), email: String(body.email || '').trim(), street: body.street.trim(), town: body.town.trim(),
    area: String(body.area || '').trim(), appliances: items, note: String(body.note || '').trim(), status: 'NEW', historyStatus: 'ADDED_TO_RUN'
  };
}
function alreadyOnARun(store, bookingId) {
  return store.runs.find(run => ensureData(run).stops.concat(run.data.bad).some(stop => stop.submission_id === bookingId));
}

async function addStop(env, portal, ctx, runId, body) {
  const run = requireRun(ctx.store, runId);
  const data = ensureData(run);
  if (data.stops.length + data.bad.length >= 300) fail('That run already has 300 stops.', 409);
  let stop, booking = null;
  if (body.bookingId) {
    if (typeof body.bookingId !== 'string') fail('bookingId must be a booking id from the API.');
    if (alreadyOnARun(ctx.store, body.bookingId)) fail('That booking is already on a run.', 409);
    const found = await readBooking(env, body.bookingId);
    if (!found) fail('Booking not found.', 404);
    if (CLOSED.includes(found.row.status) || found.row.status === 'COMPLETED') fail('Undo or restore that booking before adding it to a run.', 409);
    const notes = await ownerNotesFor(env.CUSTOMER_DB, [body.bookingId]);
    stop = stopFromBooking(found.row, notes.get(body.bookingId) || '');
    const status = found.row.status === 'NEW' ? 'ADDED_TO_RUN' : found.row.status;
    booking = await ensureBooking(env, portal, ctx.undo, body.bookingId, {status, pickupDate: found.row.pickup_date || ''});
  } else stop = manualStop(body);
  const list = stop.street ? data.stops : data.bad;
  list.push(stop);
  touch(run);
  return {body: {runId: run.id, stop: publicStop(stop, run, '', list.length - 1, list === data.bad), booking}};
}

function reorder(run, stopIds) {
  if (!Array.isArray(stopIds) || stopIds.some(id => typeof id !== 'string')) fail('stopIds must list the pending stop ids in the new order.');
  const data = ensureData(run);
  const pending = data.stops.filter(stop => stop.status !== 'DONE');
  if (stopIds.length !== pending.length || new Set(stopIds).size !== stopIds.length || pending.some(stop => !stopIds.includes(stop.id))) {
    fail('stopIds must be every pending stop on this run, once each. Done stops stay where they are.');
  }
  const byId = new Map(data.stops.map(stop => [stop.id, stop]));
  const seq = stopIds.map(id => byId.get(id));
  let index = 0;
  const wanted = new Set(stopIds);
  data.stops = data.stops.map(stop => wanted.has(stop.id) ? seq[index++] : stop);
  data.manual = true;
  touch(run);
}

async function moveStop(env, portal, ctx, fromId, stopId, body) {
  const found = locate(ctx.store, stopId, fromId);
  if (!found) fail('Stop not found.', 404);
  const date = body.date || '';
  if ('date' in body && date && !dateOk(date)) fail('date must be a real day in YYYY-MM-DD format.');
  if (!body.toRunId && !date) fail('Provide toRunId, date, or both.');
  let target = found.run;
  let createdRun = false;
  if (body.toRunId) {
    if (typeof body.toRunId !== 'string') fail('toRunId must be a run id.');
    target = requireRun(ctx.store, body.toRunId);
  } else if (date && runDate(found.run) !== date) {
    const matches = ctx.store.runs.filter(run => runDate(run) === date);
    if (matches.length > 1) fail('More than one run is already on that day. Send toRunId.', 409);
    if (matches.length === 1) target = matches[0];
    else {
      if (ctx.store.runs.length >= 100) fail('There are already 100 runs. Choose an existing run.', 409);
      target = {id: newId('r'), name: 'Pickup ' + date, createdAt: Date.now(), updatedAt: Date.now(), data: {stops: [], bad: [], confirmationDate: date, manual: true}};
      ctx.store.runs.push(target);
      createdRun = true;
    }
  }
  if (date && runDate(target) && runDate(target) !== date) fail('That run is planned for ' + runDate(target) + '. Pick that day, or another run. The run day was not changed.', 409);
  const moving = found.stop;
  found.run.data[found.list].splice(found.index, 1);
  if (found.run !== target) touch(found.run);
  if (date) moving.confirmedPickupDate = date;
  else if (body.toRunId && runDate(target) && !moving.confirmedPickupDate) moving.confirmedPickupDate = runDate(target);
  if (moving.status !== 'DONE' && moving.confirmedPickupDate) moving.historyStatus = moving.historyStatus === 'COMPLETED' ? 'ADDED_TO_RUN' : (moving.historyStatus || 'ADDED_TO_RUN');
  const dest = ensureData(target);
  const list = found.list === 'bad' || !moving.street ? dest.bad : dest.stops;
  list.push(moving);
  touch(target);
  let booking = null;
  const bookingId = linkedId(moving);
  if (bookingId && moving.status !== 'DONE') {
    const current = await readBooking(env, bookingId);
    if (current && !CLOSED.includes(current.row.status) && current.row.status !== 'COMPLETED') {
      const status = current.row.status === 'NEW' ? 'ADDED_TO_RUN' : current.row.status;
      booking = await ensureBooking(env, portal, ctx.undo, bookingId, {status, pickupDate: moving.confirmedPickupDate || current.row.pickup_date || ''});
    }
  }
  return {body: {fromRunId: fromId, runId: target.id, stop: publicStop(moving, target, '', list.length - 1, list === dest.bad), booking, createdRun}};
}

async function setDone(env, portal, ctx, runId, stopId, done) {
  if (typeof done !== 'boolean') fail('done must be true or false.');
  const found = locate(ctx.store, stopId, runId);
  if (!found || found.list !== 'stops') fail('Stop not found on that run.', 404);
  const stop = found.stop;
  if (stop.kind === 'unload') fail('A GMS unload is not a customer pickup.', 400);
  const bookingId = linkedId(stop);
  let booking = null;
  if (done) {
    stop.status = 'DONE'; stop.historyStatus = 'COMPLETED'; stop.collectedAt = stop.collectedAt || Date.now(); stop.completionChangedAt = Date.now();
    if (bookingId) {
      const current = await readBooking(env, bookingId);
      if (current && !CLOSED.includes(current.row.status) && current.row.status !== 'COMPLETED') booking = await ensureBooking(env, portal, ctx.undo, bookingId, {status: 'COMPLETED'});
      else booking = current ? await publicBooking(env, bookingId) : null;
    }
  } else {
    stop.status = 'NEW'; stop.historyStatus = 'ADDED_TO_RUN'; stop.collectedAt = ''; stop.completionChangedAt = Date.now();
    if (bookingId) {
      const current = await readBooking(env, bookingId);
      if (current?.row.status === 'COMPLETED') booking = await ensureBooking(env, portal, ctx.undo, bookingId, {status: 'ADDED_TO_RUN'});
      else booking = current ? await publicBooking(env, bookingId) : null;
    }
  }
  touch(found.run);
  return {body: {runId, stop: publicStop(stop, found.run, '', found.index, false), booking}};
}

async function removeStop(env, portal, ctx, runId, stopId) {
  const found = locate(ctx.store, stopId, runId);
  if (!found) fail('Stop not found.', 404);
  const bookingId = linkedId(found.stop);
  let booking = null;
  if (bookingId && found.stop.status !== 'DONE' && found.stop.kind !== 'unload') booking = await unscheduleBooking(env, portal, ctx.undo, bookingId);
  found.run.data[found.list].splice(found.index, 1);
  if (Array.isArray(found.run.data.messageSelectedIds)) found.run.data.messageSelectedIds = found.run.data.messageSelectedIds.filter(id => id !== stopId);
  touch(found.run);
  return {body: {runId, removedStopId: stopId, booking}};
}

function takeUnfinished(run) {
  const data = ensureData(run);
  const back = data.stops.filter(stop => stop.kind !== 'unload' && stop.status !== 'DONE');
  const bad = data.bad.slice();
  return back.concat(bad);
}

async function scrubBooking(ctx, bookingId) {
  let removed = false;
  for (const run of ctx.store.runs) {
    const data = ensureData(run);
    const before = data.stops.length + data.bad.length;
    data.stops = data.stops.filter(stop => stop.submission_id !== bookingId);
    data.bad = data.bad.filter(stop => stop.submission_id !== bookingId);
    if (data.stops.length + data.bad.length !== before) { touch(run); removed = true; }
  }
  if (Array.isArray(ctx.store.shared?.unpaid)) {
    const before = ctx.store.shared.unpaid.length;
    ctx.store.shared.unpaid = ctx.store.shared.unpaid.filter(stop => stop.submission_id !== bookingId);
    if (ctx.store.shared.unpaid.length !== before) removed = true;
  }
  return removed;
}

export async function mutateRuns(env, request, portal, action, body) {
  return editAccount(env, request, async ctx => {
    if (action.kind === 'create-run') {
      const name = String(body.name || '').trim();
      if (!name || name.length > 60) fail('Give the run a name, up to 60 characters.');
      if (body.date && !dateOk(body.date)) fail('date must be a real day in YYYY-MM-DD format.');
      if (ctx.store.runs.length >= 100) fail('There are already 100 runs.', 409);
      const run = {id: newId('r'), name, createdAt: Date.now(), updatedAt: Date.now(), data: {stops: [], bad: [], manual: true, confirmationDate: body.date || ''}};
      ctx.store.runs.push(run);
      if (!ctx.store.activeRunId) ctx.store.activeRunId = run.id;
      return {body: {plan: publicRun(run, '', ctx.store.activeRunId)}};
    }
    if (action.kind === 'patch-run') {
      const run = requireRun(ctx.store, action.runId);
      if (!['name', 'confirmationDate', 'roundTrip', 'manual'].some(key => key in body)) fail('Provide a run setting to change.');
      if ('name' in body) {
        const name = String(body.name || '').trim();
        if (!name || name.length > 60) fail('Give the run a name, up to 60 characters.');
        run.name = name;
      }
      if ('confirmationDate' in body) {
        if (body.confirmationDate && !dateOk(body.confirmationDate)) fail('confirmationDate must be blank or a real YYYY-MM-DD day.');
        run.data.confirmationDate = body.confirmationDate || '';
      }
      if ('roundTrip' in body) {
        if (typeof body.roundTrip !== 'boolean') fail('roundTrip must be true or false.');
        run.data.roundTrip = body.roundTrip;
      }
      if ('manual' in body) {
        if (typeof body.manual !== 'boolean') fail('manual must be true or false.');
        run.data.manual = body.manual;
      }
      touch(run);
      return {body: {plan: publicRun(run, '', ctx.store.activeRunId)}};
    }
    if (action.kind === 'delete-run') {
      if (ctx.store.runs.length < 2) fail('Keep at least one pickup run.', 409);
      const run = requireRun(ctx.store, action.runId);
      const bookings = [];
      for (const stop of takeUnfinished(run)) {
        const id = linkedId(stop);
        if (id) bookings.push(await unscheduleBooking(env, portal, ctx.undo, id));
      }
      ctx.store.runs = ctx.store.runs.filter(item => item.id !== run.id);
      if (ctx.store.activeRunId === run.id) ctx.store.activeRunId = ctx.store.runs[0].id;
      return {body: {deletedRunId: run.id, activeRunId: ctx.store.activeRunId, bookings: bookings.filter(Boolean)}};
    }
    if (action.kind === 'merge') {
      const into = requireRun(ctx.store, action.runId);
      if (typeof body.fromRunId !== 'string' || body.fromRunId === into.id) fail('fromRunId must be a different run.');
      const from = requireRun(ctx.store, body.fromRunId);
      const have = new Set(into.data.stops.concat(into.data.bad).map(stop => stop.submission_id).filter(Boolean));
      const fresh = list => list.filter(stop => !stop.submission_id || !have.has(stop.submission_id));
      into.data.stops = into.data.stops.concat(fresh(from.data.stops));
      into.data.bad = into.data.bad.concat(fresh(from.data.bad));
      ctx.store.runs = ctx.store.runs.filter(item => item.id !== from.id);
      if (ctx.store.activeRunId === from.id) ctx.store.activeRunId = into.id;
      touch(into);
      return {body: {plan: publicRun(into, '', ctx.store.activeRunId), removedRunId: from.id}};
    }
    if (action.kind === 'reorder') {
      const run = requireRun(ctx.store, action.runId);
      reorder(run, body.stopIds);
      return {body: {plan: publicRun(run, '', ctx.store.activeRunId)}};
    }
    if (action.kind === 'add-stop') return addStop(env, portal, ctx, action.runId, body);
    if (action.kind === 'move') return moveStop(env, portal, ctx, action.runId, action.stopId, body);
    if (action.kind === 'done') return setDone(env, portal, ctx, action.runId, action.stopId, body.done);
    if (action.kind === 'remove') return removeStop(env, portal, ctx, action.runId, action.stopId);
    if (action.kind === 'return' || action.kind === 'clear-completed') {
      const run = requireRun(ctx.store, action.runId);
      const targets = action.kind === 'clear-completed' ? run.data.stops.filter(stop => stop.status === 'DONE') : takeUnfinished(run);
      const bookings = [];
      if (action.kind === 'return') {
        for (const stop of targets) {
          const id = linkedId(stop);
          if (id) bookings.push(await unscheduleBooking(env, portal, ctx.undo, id));
        }
      }
      const ids = new Set(targets.map(stop => stop.id));
      run.data.stops = run.data.stops.filter(stop => !ids.has(stop.id));
      run.data.bad = run.data.bad.filter(stop => !ids.has(stop.id));
      touch(run);
      return {body: {plan: publicRun(run, '', ctx.store.activeRunId), changed: targets.length, bookings: bookings.filter(Boolean)}};
    }
    if (action.kind === 'patch-stop') {
      const found = locate(ctx.store, action.stopId, action.runId);
      if (!found) fail('Stop not found.', 404);
      if ('priority' in body) {
        if (typeof body.priority !== 'boolean') fail('priority must be true or false.');
        found.stop.priority = body.priority;
      }
      if ('note' in body) {
        if (typeof body.note !== 'string' || body.note.length > 1500 || typeof body.expectedNote !== 'string') fail('Send note and expectedNote, each up to 1500 characters.');
        if (String(found.stop.note || '') !== body.expectedNote) fail('The pickup note changed. Read the stop again.', 409);
        const bookingId = linkedId(found.stop);
        if (bookingId) {
          const notes = await ownerNotesFor(env.CUSTOMER_DB, [bookingId]);
          const current = notes.get(bookingId) || '';
          if (current !== body.expectedNote && current !== body.note) fail('The pickup note changed on the booking. Read it again.', 409);
          if (current !== body.note.trim()) {
            const result = await env.CUSTOMER_DB.prepare(`INSERT INTO owner_booking_notes(booking_id,note,updated_at) VALUES(?1,?2,?3)
              ON CONFLICT(booking_id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at WHERE owner_booking_notes.note=?4`)
              .bind(bookingId, body.note.trim(), Date.now(), current).run();
            if (!result.meta?.changes && current !== body.note.trim()) fail('The pickup note changed. Read it again.', 409);
            ctx.undo(async () => {
              await env.CUSTOMER_DB.prepare(`INSERT INTO owner_booking_notes(booking_id,note,updated_at) VALUES(?1,?2,?3)
                ON CONFLICT(booking_id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at WHERE owner_booking_notes.note=?4`)
                .bind(bookingId, current, Date.now(), body.note.trim()).run();
            });
          }
        }
        found.stop.note = body.note.trim();
        found.stop.ownerNoteSynced = body.note.trim();
      }
      if (!('priority' in body) && !('note' in body)) fail('Provide priority or note.');
      touch(found.run);
      return {body: {stop: publicStop(found.stop, found.run, '', found.index, found.list === 'bad')}};
    }
    fail('That run action is not available.', 404);
  });
}

export async function mutateContacts(env, request, action, body) {
  return editAccount(env, request, async ctx => {
    const contacts = ctx.contacts;
    if (action.kind === 'create-contact') {
      if (contacts.length >= 500) fail('There are already 500 saved contacts.', 409);
      const contact = {...contactFields(body), id: 'CONTACT-' + crypto.randomUUID()};
      contacts.unshift(contact);
      return {contacts, body: {contact: publicContact(contact)}};
    }
    const index = contacts.findIndex(contact => contact.id === action.contactId);
    if (index < 0) fail('Contact not found.', 404);
    if (action.kind === 'delete-contact') {
      const [removed] = contacts.splice(index, 1);
      return {contacts, body: {deletedContactId: removed.id}};
    }
    contacts[index] = {...contactFields(body, contacts[index]), id: contacts[index].id};
    return {contacts, body: {contact: publicContact(contacts[index])}};
  });
}

function greeting(text, firstName) {
  const name = String(firstName || '').trim();
  return text && name ? String(text).replace(/^Hey /, `Hi ${name}, `) : String(text || '');
}
function messageSubject(kind, date) {
  if (kind === 'confirm') return `Whiteware pickup confirmed - ${pickupDateText(date) || date}`;
  if (kind === 'reminder') return 'Whiteware collection reminder';
  return 'Whiteware collection update';
}
async function messageRecipients(env, body) {
  const kind = body.kind;
  if (!['confirm', 'reminder', 'update'].includes(kind)) fail('kind must be confirm, reminder or update.');
  if (kind === 'confirm' && !dateOk(body.date || '')) fail('A confirmation needs a real date in YYYY-MM-DD format.');
  if (kind !== 'confirm' && body.date && !dateOk(body.date)) fail('date must be a real day in YYYY-MM-DD format.');
  if (body.text != null && (typeof body.text !== 'string' || body.text.length > 4000)) fail('text must be at most 4000 characters.');
  if (kind !== 'confirm' && !String(body.text || '').trim()) fail('Write the message text first. Nothing was sent.');
  if (!Array.isArray(body.bookingIds) || !body.bookingIds.length || body.bookingIds.length > 40 || new Set(body.bookingIds).size !== body.bookingIds.length) fail('Provide 1 to 40 booking ids. Nothing was sent.');
  const loaded = await loadAccount(env);
  const recipients = [];
  for (const id of body.bookingIds) {
    if (typeof id !== 'string') fail('bookingIds must be booking ids.');
    const found = await readBooking(env, id);
    if (!found) { recipients.push({bookingId: id, skipped: 'Booking not found'}); continue; }
    if (CLOSED.includes(found.row.status)) { recipients.push({bookingId: id, skipped: 'Booking is ' + found.row.status}); continue; }
    const email = String(found.row.email || '').trim();
    const text = kind === 'confirm'
      ? pickupConfirmationText(found.row, body.date, String(body.pickupWindow || '').slice(0, 80), found.row.customer_note || '', greeting(body.text || '', found.row.first_name))
      : greeting(body.text, found.row.first_name);
    recipients.push({bookingId: id, to: email, name: `${found.row.first_name || ''} ${found.row.last_name || ''}`.trim(), subject: messageSubject(kind, body.date || ''), text, row: found.row});
  }
  return {loaded, recipients, kind, date: body.date || ''};
}

export async function previewMessages(env, body) {
  const drafted = await messageRecipients(env, body);
  return {
    sent: false, customerEmailed: false, sms: 'Not sent. The phone app opens the Messages app on the device. This API can email only, and only from /messages/send with confirm:true.',
    savedAt: drafted.loaded.saved?.savedAt || null, etag: drafted.loaded.saved ? etagOf(drafted.loaded.saved.savedAt) : null,
    messages: drafted.recipients.map(({row, ...message}) => message)
  };
}

export async function sendMessages(env, request, portal, sendMail, body) {
  if (typeof sendMail !== 'function') fail('Email sending is not configured. Nothing was sent.', 503);
  const drafted = await messageRecipients(env, body);
  requireBackup(drafted.loaded);
  requireMatch(request, drafted.loaded.saved.savedAt);
  const deliverable = drafted.recipients.filter(item => item.to && !item.skipped && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item.to));
  const skipped = drafted.recipients.filter(item => !deliverable.includes(item)).map(item => ({bookingId: item.bookingId, reason: item.skipped || 'No email address'}));
  let first = {savedAt: drafted.loaded.saved.savedAt, etag: etagOf(drafted.loaded.saved.savedAt), bookings: []};
  if (drafted.kind === 'confirm' && deliverable.length) {
    first = await editAccount(env, request, async ctx => {
      const bookings = [];
      for (const item of deliverable) {
        bookings.push(await ensureBooking(env, portal, ctx.undo, item.bookingId, {status: 'CONFIRMED', pickupDate: drafted.date, pickupWindow: String(body.pickupWindow || '').slice(0, 80)}));
        for (const run of ctx.store.runs) {
          for (const stop of ensureData(run).stops.concat(run.data.bad)) {
            if (stop.submission_id !== item.bookingId || stop.status === 'DONE') continue;
            stop.confirmedPickupDate = drafted.date;
            stop.historyStatus = 'CONFIRMED';
            if (!run.data.confirmationDate) run.data.confirmationDate = drafted.date;
            touch(run);
          }
        }
      }
      return {body: {bookings: bookings.filter(Boolean)}};
    });
  }
  const emailedTo = [], failed = [];
  for (const item of deliverable) {
    try {
      const sent = await sendMail(env, {to: item.to, name: item.name, subject: item.subject, text: item.text});
      if (sent) emailedTo.push(item.to.toLowerCase()); else failed.push(item.to);
    } catch { failed.push(item.to); }
  }
  const bucket = drafted.kind === 'confirm' ? `confirm:${drafted.date}` : drafted.kind === 'reminder' ? `reminder:${drafted.date || nzDay()}` : `update:${nzDay()}:${body.text || ''}`;
  let marksSaved = false;
  let latest = first;
  if (deliverable.length) {
    const marked = await editAccount(env, request, async ctx => {
      let touched = false;
      for (const item of deliverable) {
        const ok = emailedTo.includes(item.to.toLowerCase());
        for (const run of ctx.store.runs) {
          for (const stop of ensureData(run).stops.concat(run.data.bad)) {
            if (stop.submission_id !== item.bookingId) continue;
            addMark(run, bucket, stop, ok ? {email: true, emailFailed: false, emailMessage: body.text || item.text} : {emailFailed: true});
            touch(run); touched = true;
          }
        }
      }
      return touched ? {body: {}} : {skip: true, body: {}};
    }, first.savedAt);
    marksSaved = !marked.conflict;
    if (!marked.conflict) latest = {...first, savedAt: marked.savedAt, etag: marked.etag};
  }
  return {...latest, customerEmailed: emailedTo.length > 0, sent: emailedTo.length, failed, emailedTo, skipped, marksSaved, sms: 'Not sent. Email only.'};
}

export async function deleteBooking(env, request, id) {
  if (id.startsWith('WEB-GROUP-')) fail('Cancel a group pickup instead of deleting it.', 409);
  const found = await readBooking(env, id);
  if (!found) fail('Booking not found.', 404);
  const expected = request.headers.get('If-Match');
  if (!expected) fail('Read this booking first and send its ETag in If-Match.', 428);
  if (!etagMatches(expected, found.row.updated_at)) fail('This booking changed. Read it again before deleting.', 412);
  await binBooking(env, id);
  await env.CUSTOMER_DB.batch([
    env.CUSTOMER_DB.prepare('DELETE FROM booking_documents WHERE booking_id = ?1').bind(id),
    env.CUSTOMER_DB.prepare('DELETE FROM owner_booking_notes WHERE booking_id = ?1').bind(id),
    env.CUSTOMER_DB.prepare('DELETE FROM booking_events WHERE booking_id = ?1').bind(id),
    env.CUSTOMER_DB.prepare(`DELETE FROM ${found.table} WHERE id = ?1`).bind(id)
  ]);
  let runs = {removed: false};
  const loaded = await loadAccount(env);
  const runsHeader = request.headers.get('If-Match-Runs');
  if (loaded.saved && runsHeader && etagMatches(runsHeader, loaded.saved.savedAt)) {
    try {
      runs = await editAccount(env, request, async ctx => {
        const removed = await scrubBooking(ctx, id);
        return removed ? {body: {removed: true}} : {skip: true, body: {removed: false}};
      }, loaded.saved.savedAt);
    } catch { runs = {removed: false, warning: 'The booking is in Deleted bookings. The run copy changed at the same time, so its stop was left in place. Read /runs and remove that stop.'}; }
  } else if (loaded.saved) runs = {removed: false, warning: 'The booking is in Deleted bookings. Send the runs ETag in If-Match-Runs to take its stop off the account copy, or remove the stop separately.'};
  return {deleted: true, binDays: BIN_DAYS, customerEmailed: false, runs};
}

function requireBookingMatch(request, updatedAt) {
  const expected = request.headers.get('If-Match');
  if (!expected) fail('Read this record first and send its ETag in If-Match.', 428);
  if (!etagMatches(expected, updatedAt)) fail('This record changed. Read it again before editing.', 412);
}
export async function restoreBooking(env, request, id) {
  if (id.startsWith('WEB-GROUP-')) fail('Group pickups are put back through the organiser request.', 409);
  const found = await readBooking(env, id);
  if (!found) fail('Booking not found.', 404);
  requireBookingMatch(request, found.row.updated_at);
  const reopened = await reopenBooking(env, {id, allowed: ['CANCELLED', 'DECLINED'], detail: 'restored from the bot API'});
  if (reopened.error) fail(reopened.error, reopened.status);
  const booking = await publicBooking(env, id);
  return {booking, customerEmailed: false, etag: booking ? etagOf(booking.updatedAt) : null};
}

export async function restoreDeleted(env, request, id) {
  const expected = request.headers.get('If-Match');
  if (!expected) fail('Read the deleted booking first and send its ETag in If-Match.', 428);
  const restored = await restoreFromBin(env, id, expected.replace(/^W\//, '').replaceAll('"', ''));
  if (restored.error) fail(restored.error, restored.status);
  return {booking: await publicBooking(env, id), customerEmailed: false};
}

export async function saveOwnerNote(env, request, id, body) {
  if (typeof body.note !== 'string' || body.note.length > 1500 || typeof body.expectedNote !== 'string') fail('Send note and expectedNote, each up to 1500 characters.');
  const found = await readBooking(env, id);
  if (!found) fail('Booking not found.', 404);
  requireBookingMatch(request, found.row.updated_at);
  const current = (await ownerNotesFor(env.CUSTOMER_DB, [id])).get(id) || '';
  if (current !== body.expectedNote) fail('The pickup note changed. Read the booking again.', 409);
  const note = body.note.trim();
  if (current !== note) {
    const result = await env.CUSTOMER_DB.prepare(`INSERT INTO owner_booking_notes(booking_id,note,updated_at) VALUES(?1,?2,?3)
      ON CONFLICT(booking_id) DO UPDATE SET note=excluded.note,updated_at=excluded.updated_at WHERE owner_booking_notes.note=?4`)
      .bind(id, note, Date.now(), current).run();
    if (!result.meta?.changes) fail('The pickup note changed. Read the booking again.', 409);
  }
  let runsUpdated = false;
  const loaded = await loadAccount(env);
  const runsHeader = request.headers.get('If-Match-Runs');
  if (loaded.saved && runsHeader && etagMatches(runsHeader, loaded.saved.savedAt)) {
    const saved = await editAccount(env, request, async ctx => {
      let touched = false;
      for (const run of ctx.store.runs) {
        for (const stop of ensureData(run).stops.concat(run.data.bad)) {
          if (stop.submission_id !== id) continue;
          stop.note = note; stop.ownerNoteSynced = note; touch(run); touched = true;
        }
      }
      return touched ? {body: {}} : {skip: true, body: {}};
    }, loaded.saved.savedAt);
    runsUpdated = !saved.conflict;
  }
  return {note, customerEmailed: false, etag: etagOf(found.row.updated_at), runsUpdated};
}

export async function activityPage(env, url, key) {
  const offset = Math.max(0, Math.min(100000, parseInt(url.searchParams.get('offset'), 10) || 0));
  const limit = 100;
  const rows = await env.CUSTOMER_DB.prepare(`SELECT r.method,r.path,r.status,r.created_at AS createdAt,k.name AS keyName
    FROM bot_api_requests r JOIN bot_api_keys k ON k.id=r.key_id
    WHERE (?3 = 'write' OR r.key_id = ?4)
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?1 OFFSET ?2`).bind(limit + 1, offset, key.permission, key.id).all();
  const activity = (rows.results || []).slice(0, limit);
  return {activity, hasMore: (rows.results || []).length > limit, nextOffset: offset + activity.length, pageSize: limit};
}

