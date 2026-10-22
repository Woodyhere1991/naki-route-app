// Getting a booking back.
// - A cancelled (or declined) booking can be put back to New: by Woody from the
//   Cancelled tab, or by the customer who cancelled it ("Rebook this pickup").
// - A customer can remove a cancelled booking from their own list. It is only
//   hidden from them; Woody still sees it.
// - Woody's Delete moves the booking into a 30-day bin (a full copy in R2)
//   instead of destroying it. Photos and PDFs stay until the bin empties.
// No schema change: everything here works on the existing tables.
const DAY = 86400000;
export const BIN_DAYS = 30;
const BIN_PREFIX = "deleted-bookings/";
const MAX_PHOTOS = 10;
const HIDDEN_LIMIT = 500;

export const tableFor = id => id.startsWith("JOTFORM-") ? "jotform_bookings" : id.startsWith("PICKUP-") ? "external_bookings" : "bookings";
export const sourceFor = table => table === "bookings" ? "WEBSITE" : table === "jotform_bookings" ? "JOTFORM" : "PICKUP_RUN";
const binKey = id => `${BIN_PREFIX}${encodeURIComponent(id)}.json`;

// Back to New with no date: the pickup has to be arranged again. The old
// cancellation reason and time are cleared so nothing still reads it as cancelled.
export async function reopenBooking(env, { id, allowed, detail, at = Date.now() }) {
  const table = tableFor(id);
  const row = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(id).first();
  if (!row) return { error: "Booking not found", status: 404 };
  if (!allowed.includes(row.status)) {
    return { error: row.status === "NEW" ? "This booking is already open." : "Only a cancelled booking can be put back.", status: 409 };
  }
  const updatedAt = Math.max(at, Number(row.updated_at || 0) + 1);
  const changed = await env.CUSTOMER_DB.prepare(
    `UPDATE ${table} SET status='NEW', pickup_date='', pickup_window='', cancellation_reason='', cancelled_at=NULL, updated_at=?1
     WHERE id=?2 AND status=?3 AND updated_at IS ?4`
  ).bind(updatedAt, id, row.status, row.updated_at ?? null).run();
  if (!changed.meta?.changes) return { error: "This booking just changed. Refresh and try again.", status: 409 };
  // Only website bookings have an event history (its foreign key is to bookings).
  if (table === "bookings") {
    await env.CUSTOMER_DB.prepare("INSERT INTO booking_events (id, booking_id, event_type, detail, created_at) VALUES (?1, ?2, 'STATUS', ?3, ?4)")
      .bind(crypto.randomUUID(), id, `NEW - ${detail}`, updatedAt).run();
  }
  const updated = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(id).first();
  return { row: updated, previous: row, table };
}

// ---- Customer "Remove from my list" ----
const hiddenKey = customerId => `custhide:${customerId}`;
export async function hiddenBookingIds(env, customerId) {
  if (!env.REMINDERS || !customerId) return new Set();
  try {
    const list = JSON.parse(await env.REMINDERS.get(hiddenKey(customerId)) || "[]");
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch { return new Set(); }
}
export async function hideBookingForCustomer(env, customerId, bookingId) {
  if (!env.REMINDERS) throw Object.assign(new Error("Removing bookings is not available right now."), { status: 503 });
  const ids = [...await hiddenBookingIds(env, customerId)].filter(id => id !== bookingId);
  ids.push(bookingId);
  await env.REMINDERS.put(hiddenKey(customerId), JSON.stringify(ids.slice(-HIDDEN_LIMIT)));
}

// ---- Woody's Deleted bin ----
async function rowsFor(env, sql, id) {
  return (await env.CUSTOMER_DB.prepare(sql).bind(id).all()).results || [];
}
// Save a full copy before the database rows go. If this fails, nothing is deleted.
export async function binBooking(env, id, at = Date.now()) {
  if (!env.DOCUMENTS) throw Object.assign(new Error("The Deleted bin is not available right now. Nothing was deleted."), { status: 503 });
  const table = tableFor(id);
  const row = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(id).first();
  if (!row) return false;
  const [events, documents, notes] = await Promise.all([
    rowsFor(env, "SELECT * FROM booking_events WHERE booking_id=?1", id),
    rowsFor(env, "SELECT * FROM booking_documents WHERE booking_id=?1", id),
    rowsFor(env, "SELECT * FROM owner_booking_notes WHERE booking_id=?1", id)
  ]);
  await env.DOCUMENTS.put(binKey(id), JSON.stringify({ version: 1, deletedAt: at, table, row, events, documents, notes }),
    { httpMetadata: { contentType: "application/json" } });
  return true;
}

async function readBin(env, id) {
  const object = await env.DOCUMENTS?.get(binKey(id));
  if (!object) return null;
  const snapshot = await object.json().catch(() => null);
  return snapshot?.version === 1 && snapshot.row?.id === id && snapshot.table === tableFor(id) ? snapshot : null;
}
function summary(snapshot) {
  const row = snapshot.row;
  let items = [];
  try { items = JSON.parse(row.items_json || "[]"); } catch { items = []; }
  return {
    id: row.id, status: row.status || "", firstName: row.first_name || "", lastName: row.last_name || "",
    streetAddress: row.street_address || "", town: row.town || "", items,
    pickupDate: row.pickup_date || "",
    deletedAt: new Date(snapshot.deletedAt).toISOString(),
    emptiesAt: new Date(snapshot.deletedAt + BIN_DAYS * DAY).toISOString()
  };
}
export async function listBin(env) {
  if (!env.DOCUMENTS) return [];
  const found = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const listed = await env.DOCUMENTS.list({ prefix: BIN_PREFIX, cursor });
    for (const object of listed.objects || []) {
      const id = decodeURIComponent(object.key.slice(BIN_PREFIX.length).replace(/\.json$/, ""));
      const snapshot = await readBin(env, id);
      if (snapshot) found.push(summary(snapshot));
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return found.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

const NAME_RE = /^[a-z_][a-z0-9_]*$/;
async function columnsOf(env, table) {
  const info = await env.CUSTOMER_DB.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((info.results || []).map(c => c.name));
}
function insertFor(env, table, columns, row, orIgnore = false) {
  const names = Object.keys(row).filter(name => NAME_RE.test(name) && columns.has(name));
  const marks = names.map((_, i) => `?${i + 1}`).join(", ");
  return env.CUSTOMER_DB.prepare(`INSERT ${orIgnore ? "OR IGNORE " : ""}INTO ${table} (${names.join(", ")}) VALUES (${marks})`)
    .bind(...names.map(name => row[name] ?? null));
}
export async function restoreFromBin(env, id) {
  const snapshot = await readBin(env, id);
  if (!snapshot) return { error: "That booking is no longer in the Deleted bin.", status: 404 };
  const table = snapshot.table;
  const clash = await env.CUSTOMER_DB.prepare(`SELECT id FROM ${table} WHERE id=?1`).bind(id).first();
  if (clash) return { error: "A booking with this ID is already in Bookings.", status: 409 };
  const [bookingCols, eventCols, documentCols, noteCols] = await Promise.all(
    [table, "booking_events", "booking_documents", "owner_booking_notes"].map(name => columnsOf(env, name)));
  // The booking first: its events point at it.
  const statements = [insertFor(env, table, bookingCols, snapshot.row)];
  if (table === "bookings") for (const event of snapshot.events || []) statements.push(insertFor(env, "booking_events", eventCols, event, true));
  for (const document of snapshot.documents || []) statements.push(insertFor(env, "booking_documents", documentCols, document, true));
  for (const note of snapshot.notes || []) statements.push(insertFor(env, "owner_booking_notes", noteCols, note, true));
  await env.CUSTOMER_DB.batch(statements);
  await env.DOCUMENTS.delete(binKey(id));
  return { row: snapshot.row, table };
}

// Daily: anything binned more than 30 days ago is removed for good, along with
// the photos and PDFs that were kept for it.
export async function emptyBin(env, at = Date.now()) {
  if (!env.DOCUMENTS) return 0;
  let removed = 0, cursor;
  for (let page = 0; page < 10; page++) {
    const listed = await env.DOCUMENTS.list({ prefix: BIN_PREFIX, cursor });
    for (const object of listed.objects || []) {
      const id = decodeURIComponent(object.key.slice(BIN_PREFIX.length).replace(/\.json$/, ""));
      const snapshot = await readBin(env, id);
      const deletedAt = Number(snapshot?.deletedAt || Date.parse(object.uploaded) || at);
      if (at - deletedAt < BIN_DAYS * DAY) continue;
      // Restored in the meantime under the same ID: keep its files.
      const live = snapshot && await env.CUSTOMER_DB.prepare(`SELECT id FROM ${snapshot.table} WHERE id=?1`).bind(id).first();
      if (snapshot && !live) {
        const photos = Math.min(Number(snapshot.row.photo_count || 0), MAX_PHOTOS);
        if (env.PHOTOS) await Promise.all(Array.from({ length: photos }, (_, i) => env.PHOTOS.delete(`photo:${id}:${i}`).catch(() => {})));
        await Promise.all((snapshot.documents || []).map(d => d.r2_key ? env.DOCUMENTS.delete(d.r2_key).catch(() => {}) : null));
      }
      await env.DOCUMENTS.delete(object.key);
      removed++;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  return removed;
}
