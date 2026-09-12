/* ---- Hands-free voice assistant ----
   Tap the mic, talk to the app while driving. OpenAI's GPT-Live runs the
   conversation over WebRTC; the thinking is delegated to a backend model that
   asks for tools by name. Those tools run here, in the app, so every call goes
   out through ownerApi / ownerActionFetch and keeps the login, idempotency keys
   and error handling the rest of the app already relies on.

   Two things drive the design:
   - Voice is billed on wall-clock seconds from connect to close, silence
     included. So the session hangs up on its own the moment it goes quiet, when
     the phone is locked, and at a hard cap - and the panel shows the running
     cost while it is open.
   - Nothing is changed without Woody saying yes. mark_job and confirm_pickup
     only ever hand back a token and a summary; the change itself runs in
     confirm_action. A booking note or a customer name that reads like an
     instruction can never move that gate - only his voice can. */

const VOICE_RATE_PER_MIN = 0.05;        // USD, GPT-Live wall-clock time
const VOICE_IDLE_MS = 90000;            // quiet this long and we hang up
const VOICE_MAX_MS = 15 * 60000;        // hard cap on one session
const VOICE_HIDDEN_MS = 20000;          // phone locked or app swapped away
const VOICE_CONFIRM_MS = 120000;        // a pending yes goes stale after this
const VOICE_MIC_LEVEL = 0.012;          // RMS that counts as "someone is talking"

let voice = null;
// Held apart from the session so a change can never be confirmed by anything
// other than the one token that was handed out for it.
let voicePending = null;

/* ---------- dates, in New Zealand time ---------- */
function voiceToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}
function voiceIsoPlus(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
function voiceDayWords(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 'no day booked';
  const at = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ---------- turning a booking into something worth saying out loud ---------- */
const VOICE_CLOSED = ['COMPLETED', 'DECLINED', 'CANCELLED'];
const VOICE_STATUS_WORDS = {
  NEW: 'new, not booked in yet',
  ADDED_TO_RUN: 'on a run',
  CONTACTED: 'contacted',
  CONFIRMED: 'booked in',
  COMPLETED: 'done',
  DECLINED: 'declined',
  CANCELLED: 'cancelled'
};
const VOICE_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function voiceName(row) {
  return [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || 'no name on the booking';
}
function voicePrice(row) {
  if (row.quotedPrice != null) return `$${Number(row.quotedPrice).toFixed(2)}`;
  if (row.quoteRequired) return 'quote still to be worked out';
  return `$${Number(row.total || 0).toFixed(2)}`;
}
function voiceBrief(row, withPhone = false) {
  const brief = {
    name: voiceName(row),
    street: row.streetAddress || 'no street on the booking',
    town: row.town || '',
    pickup_day: row.pickupDate ? voiceDayWords(row.pickupDate) : 'not booked in yet',
    status: VOICE_STATUS_WORDS[row.status] || String(row.status || '').toLowerCase(),
    items: (row.items || []).join(', ') || 'not listed',
    price: voicePrice(row)
  };
  if (row.customerNote) brief.note_from_customer = String(row.customerNote).slice(0, 200);
  if (withPhone) brief.phone = row.phone || 'no phone on the booking';
  return brief;
}

async function voiceBookings(query = '') {
  const data = await ownerApi(`/owner/bookings?q=${encodeURIComponent(query)}&offset=0`);
  return Array.isArray(data.bookings) ? data.bookings : [];
}

/* One query, one job - or a clear reason why not. Everything that changes a
   booking goes through here so the "which one did you mean" wording is the
   same wherever it comes up. */
async function voiceResolveJob(query) {
  const text = String(query || '').trim();
  if (text.length < 2) return { error: 'Ask him which customer, street or town he means.' };
  const rows = (await voiceBookings(text)).filter(row => !VOICE_CLOSED.includes(row.status));
  if (!rows.length) {
    return { error: `No open job matches "${text}". Ask him for the street or the town.` };
  }
  if (rows.length > 1) {
    return {
      needs_choice: true,
      note: 'More than one open job matches. Ask him which one, then call again with something more specific.',
      matches: rows.slice(0, 5).map(row => voiceBrief(row))
    };
  }
  return { row: rows[0] };
}

/* ---------- the pending-change gate ---------- */
function voiceStartConfirm(summary, run) {
  const token = crypto.randomUUID();
  voicePending = { token, at: Date.now(), summary, run };
  voiceSetPending(summary);
  return {
    needs_confirmation: true,
    confirm_token: token,
    summary,
    note: 'Nothing has changed yet. Say this summary back to Woody, wait for him to say yes out loud, then call confirm_action with this token.'
  };
}

async function voiceConfirm(token) {
  const pending = voicePending;
  if (!pending) return { error: 'There is nothing waiting to be confirmed. Ask him what he wants done.' };
  if (token !== pending.token) {
    return { error: 'That confirmation code does not match the change that is waiting. Read the change back to him again.' };
  }
  if (Date.now() - pending.at > VOICE_CONFIRM_MS) {
    voicePending = null;
    voiceSetPending('');
    return { error: 'That change sat too long and has been dropped. Nothing was changed. Ask him again if he still wants it.' };
  }
  // Cleared before it runs, so one token can never fire twice.
  voicePending = null;
  voiceSetPending('');
  try {
    const done = await pending.run();
    if (typeof loadDirectBookings === 'function') loadDirectBookings(false).catch(() => {});
    if (typeof flash === 'function') flash(`🎙️ ${pending.summary}`);
    return { ok: true, done: done || pending.summary };
  } catch (error) {
    return { error: `That did not save: ${error.message || 'the app could not reach the server'}. Nothing was changed.` };
  }
}

/* ---------- the tools themselves ---------- */
async function voiceListJobs(when) {
  const rows = await voiceBookings('');
  const today = voiceToday();
  const open = row => !VOICE_CLOSED.includes(row.status);
  let picked = [];
  let heading = '';
  if (when === 'new') {
    picked = rows.filter(row => row.status === 'NEW');
    heading = 'booked in by a customer, no pickup day set yet';
  } else if (when === 'today') {
    picked = rows.filter(row => open(row) && row.pickupDate === today);
    heading = 'booked for today';
  } else if (when === 'tomorrow') {
    const target = voiceIsoPlus(today, 1);
    picked = rows.filter(row => open(row) && row.pickupDate === target);
    heading = 'booked for tomorrow';
  } else if (when === 'week') {
    const end = voiceIsoPlus(today, 7);
    picked = rows.filter(row => open(row) && row.pickupDate >= today && row.pickupDate <= end);
    heading = 'booked over the next seven days';
  } else {
    picked = rows.filter(row => open(row) && row.pickupDate >= today);
    heading = 'booked in from today onwards';
  }
  picked.sort((a, b) => String(a.pickupDate || '').localeCompare(String(b.pickupDate || '')));
  return {
    what: heading,
    count: picked.length,
    showing: Math.min(picked.length, 10),
    jobs: picked.slice(0, 10).map(row => voiceBrief(row))
  };
}

async function voiceFindJob(query) {
  const text = String(query || '').trim();
  if (text.length < 2) return { error: 'Ask him for a name, street or town.' };
  const rows = await voiceBookings(text);
  if (!rows.length) return { count: 0, note: `Nothing matches "${text}".`, jobs: [] };
  return { count: rows.length, showing: Math.min(rows.length, 5), jobs: rows.slice(0, 5).map(row => voiceBrief(row, true)) };
}

async function voiceSummary() {
  const data = await ownerApi('/owner/insights');
  const totals = data.totals || {};
  return {
    customers: Number(totals.customers || 0),
    bookings_all_time: Number(totals.bookings || 0),
    jobs_completed: Number(totals.completed || 0),
    busiest_towns: (data.towns || []).slice(0, 5).map(row => `${row.town}: ${row.count}`),
    how_they_heard: (data.sources || []).slice(0, 5).map(row => `${row.source}: ${row.count}`)
  };
}

async function voiceMarkJob(query, status) {
  const wanted = String(status || '').toUpperCase();
  if (!['CONTACTED', 'COMPLETED', 'CANCELLED', 'DECLINED'].includes(wanted)) {
    return { error: 'That is not a status this can set.' };
  }
  const found = await voiceResolveJob(query);
  if (!found.row) return found;
  const row = found.row;
  // The booking update endpoint validates the email on the row, so a job that
  // was typed into a run by hand can't be changed from here.
  if (!VOICE_EMAIL_RE.test(String(row.email || ''))) {
    return { error: `${voiceName(row)} has no email address on the booking, so it cannot be changed by voice. Tell him it needs doing in the app.` };
  }
  const words = { CONTACTED: 'contacted', COMPLETED: 'done and finished', CANCELLED: 'cancelled', DECLINED: 'declined' }[wanted];
  const where = [row.streetAddress, row.town].filter(Boolean).join(', ');
  const summary = `Mark ${voiceName(row)}${where ? ` at ${where}` : ''} as ${words}`;
  return voiceStartConfirm(summary, async () => {
    await ownerApi(`/owner/bookings/${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: wanted })
    });
    return summary;
  });
}

async function voiceConfirmPickup(query, date) {
  const day = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'Work out the pickup day as a real date first.' };
  const today = voiceToday();
  if (day < today) return { error: 'That day has already been. Ask him which day he means.' };
  if (day > voiceIsoPlus(today, 365)) return { error: 'That day is over a year away. Check the date with him.' };
  const found = await voiceResolveJob(query);
  if (!found.row) return found;
  const row = found.row;
  const where = [row.streetAddress, row.town].filter(Boolean).join(', ');
  const summary = `Book ${voiceName(row)}${where ? ` at ${where}` : ''} in for ${voiceDayWords(day)}`;
  return voiceStartConfirm(summary, async () => {
    const result = await ownerApi('/owner/bookings/bulk-confirm', {
      method: 'POST',
      body: JSON.stringify({ pickupDate: day, recipients: [{ bookingId: row.id }], notifyCustomer: false })
    });
    if (!Number(result.updated)) throw Error('the booking could not be matched on the server');
    return summary;
  });
}

/* ---------- the pickup run that lives on this phone ----------
   These read and write state.stops directly, the same as the buttons on the
   cards do. Nothing here needs the network, which is the point: the run is what
   he is actually driving, and it has to answer on one bar. */
function voiceStops() {
  try { return Array.isArray(state.stops) ? state.stops : []; } catch (error) { return []; }
}
function voiceStopsLeft() {
  return voiceStops().filter(stop => stop.status !== 'DONE');
}
function voiceStopBrief(stop, withPhone = false) {
  const price = stopPrice(stop);
  const brief = {
    name: fullName(stop) || 'no name on this stop',
    address: fullAddr(stop) || 'no address on this stop',
    items: (stop.appliances || []).join(', ') || 'not listed',
    price: price == null ? 'no price set' : '$' + Number(price).toFixed(2),
    state: stop.status === 'DONE' ? 'done' : isCollected(stop) ? 'picked up, not finished off' : 'still to do',
    paid: stop.paid ? 'paid' : 'not paid yet'
  };
  if (stop.priority) brief.urgent = true;
  if (stop.reminderDate) brief.payment_reminder = voiceDayWords(stop.reminderDate);
  if (withPhone) brief.phone = stop.phone || 'no phone on this stop';
  return brief;
}

/* "next", "this one" and an empty query all mean the stop he is driving to. */
const VOICE_NEXT_WORDS = ['next', 'this', 'this one', 'current', 'the next one', 'next one', 'here'];
function voiceResolveStop(query) {
  const text = String(query || '').trim().toLowerCase();
  const left = voiceStopsLeft();
  if (!text || VOICE_NEXT_WORDS.includes(text)) {
    if (!left.length) return { error: 'There is nothing left on the run.' };
    return { stop: left[0] };
  }
  const haystack = stop => (fullName(stop) + ' ' + (stop.street || '') + ' ' + (stop.town || '')).toLowerCase();
  let hits = voiceStops().filter(stop => haystack(stop).includes(text));
  if (!hits.length) return { error: 'Nothing on the run matches "' + query + '". Ask him for the street or the name again.' };
  if (hits.length > 1) {
    // A finished stop with the same name is almost never the one he means.
    const open = hits.filter(stop => stop.status !== 'DONE');
    if (open.length === 1) hits = open;
    else return {
      needs_choice: true,
      note: 'More than one stop matches. Ask him which one.',
      matches: hits.slice(0, 5).map(stop => voiceStopBrief(stop))
    };
  }
  return { stop: hits[0] };
}

function voiceListRun() {
  const all = voiceStops();
  const left = voiceStopsLeft();
  return {
    run: activeRunName(),
    stops_total: all.length,
    done: all.length - left.length,
    still_to_do: left.length,
    unpaid_jobs: (state.unpaid || []).length,
    next_up: left.slice(0, 5).map(stop => voiceStopBrief(stop))
  };
}

function voiceStopDetails(query) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  return { stop: voiceStopBrief(found.stop, true) };
}

function voiceNavigate(query) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  if (!fullAddr(stop)) return { error: 'There is no address on ' + (fullName(stop) || 'that stop') + ' to navigate to.' };
  navStop(stop.id);
  return { ok: true, navigating_to: (fullName(stop) || 'the next stop') + ', ' + fullAddr(stop) };
}

/* A phone call takes the microphone, so the conversation is wound up first.
   The short delay leaves room for it to say who is being rung. */
function voiceCall(query) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const number = String(stop.phone || '').replace(/\s+/g, '');
  if (!number) return { error: 'There is no phone number on ' + (fullName(stop) || 'that stop') + '.' };
  setTimeout(() => {
    voiceStop('Ringing them now.');
    setTimeout(() => { location.href = 'tel:' + number; }, 400);
  }, 2500);
  return {
    ok: true,
    calling: fullName(stop) || 'the customer',
    note: 'Tell him you are ringing them now. The voice session ends as the call starts.'
  };
}

function voiceSetPriority(query, urgent) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const wanted = urgent !== false;
  const who = fullName(stop) || 'That stop';
  if (Boolean(stop.priority) === wanted) {
    return { ok: true, already: true, note: who + ' is already ' + (wanted ? 'marked ASAP' : 'off ASAP') + '.' };
  }
  togglePriority(stop.id);
  return { ok: true, done: who + ' is ' + (wanted ? 'now ASAP and moved up the run' : 'no longer ASAP') + '.' };
}

function voiceMarkStopDone(query) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const who = fullName(stop) || 'That stop';
  if (stop.status === 'DONE') return { ok: true, already: true, note: who + ' is already done.' };
  const owed = !stop.paid;
  toggleDone(stop.id);
  const left = voiceStopsLeft();
  const out = {
    ok: true,
    done: who + ' is marked done.',
    still_to_do: left.length,
    next_up: left.length ? voiceStopBrief(left[0]) : null
  };
  if (owed) out.warning = 'This one is still showing as not paid.';
  return out;
}

function voiceMarkCollected(query) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const who = fullName(stop) || 'That stop';
  if (isCollected(stop)) return { ok: true, already: true, note: who + ' is already marked picked up.' };
  toggleCollected(stop.id);
  return { ok: true, done: who + ' is marked as picked up.' };
}

function voiceRemoveStop(query) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const summary = 'Take ' + (fullName(stop) || fullAddr(stop) || 'that stop') + ' off ' + activeRunName();
  return voiceStartConfirm(summary, async () => {
    state.stops = state.stops.filter(other => other.id !== stop.id);
    if (Array.isArray(state.messageSelectedIds)) {
      state.messageSelectedIds = state.messageSelectedIds.filter(other => other !== stop.id);
    }
    save(); render(); drawRoute();
    return summary;
  });
}

/* ---------- money ---------- */
function voiceAmount(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback == null ? null : Number(fallback);
  const amount = Number(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(amount) && amount >= 0 && amount <= 100000 ? amount : null;
}

function voiceMarkPaid(query) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const who = fullName(stop) || fullAddr(stop) || 'that job';
  if (stop.paid) return { ok: true, already: true, note: who + ' is already down as paid.' };
  const price = stopPrice(stop);
  const summary = 'Mark ' + who + ' as paid' + (price == null ? '' : ' - $' + Number(price).toFixed(2));
  return voiceStartConfirm(summary, async () => {
    await cancelReminderFor(stop);
    await settleAsPaid(stop);
    return summary;
  });
}

/* The receipt PDF is built on the phone - the same one the Receipt button makes -
   then handed to the app's own send. No email address means no voice send: the
   fallback there is a share sheet, which is no use to someone driving. */
function voiceSendReceipt(query, amount) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const who = fullName(stop) || 'That job';
  if (!goodEmail(stop.email)) {
    return { error: who + ' has no email address, so a receipt cannot be sent by voice. Tell him it needs the app.' };
  }
  const total = voiceAmount(amount, stopPrice(stop));
  if (total == null) return { error: 'Ask him what the amount was, in dollars.' };
  const summary = 'Email a $' + total.toFixed(2) + ' receipt to ' + (fullName(stop) || stop.email) + ', and mark the job paid and done';
  return voiceStartConfirm(summary, async () => {
    await ensurePdf();
    if (!window.jspdf) throw Error('the PDF maker did not load');
    stop.amount = total;
    stop.receiptAmount = total;
    stop.profileUrl = await customerProfileLink(stop);
    const blob = await buildReceiptPdf(stop, total);
    const name = 'Receipt - ' + (fullName(stop) || 'pickup').replace(/[^\w \-]/g, '') + '.pdf';
    pendingReceipts[stop.id] = new File([blob], name, { type: 'application/pdf' });
    save();
    await sendReceipt(stop.id);
    // sendReceipt clears the pending file only once the send is confirmed.
    if (pendingReceipts[stop.id]) throw Error('the email was not confirmed. The receipt is built and waiting on the Receipt button, and the job has not been marked paid. Check Sent mail before trying again');
    return summary;
  });
}

function voiceSetReminder(query, amount, date, repeatDays) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const who = fullName(stop) || 'That job';
  if (!goodEmail(stop.email)) return { error: who + ' has no email address, so there is nobody to remind.' };
  const day = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'Work out the day for the reminder as a real date first.' };
  const today = voiceToday();
  if (day < today) return { error: 'That day has already been. Ask him which day he means.' };
  if (day > voiceIsoPlus(today, 365)) return { error: 'That is over a year away. Check the day with him.' };
  const total = voiceAmount(amount, stopPrice(stop));
  const repeat = [7, 14, 30].includes(Number(repeatDays)) ? Number(repeatDays) : 0;
  const summary = 'Email ' + (fullName(stop) || stop.email) + ' a payment reminder'
    + (total == null ? '' : ' for $' + total.toFixed(2))
    + ' on ' + voiceDayWords(day)
    + (repeat ? ', then every ' + repeat + ' days' : '');
  return voiceStartConfirm(summary, async () => {
    const res = await ownerActionFetch(API + '/set-reminder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: stop.reminderId || '', to: stop.email.trim(), name: fullName(stop), amount: total, date: day, repeatDays: repeat })
    });
    const out = await res.json().catch(() => ({}));
    if (!out.ok) throw Error(out.error || 'the reminder was not saved');
    stop.reminderId = out.reminderId || '';
    stop.reminderDate = day;
    stop.reminderRepeat = repeat;
    save(); render();
    return summary;
  });
}

function voiceCancelReminder(query) {
  const found = voiceResolveStop(query);
  if (!found.stop) return found;
  const stop = found.stop;
  const who = fullName(stop) || fullAddr(stop) || 'that job';
  if (!stop.reminderId) return { ok: true, already: true, note: who + ' has no payment reminder set.' };
  const summary = 'Turn off the payment reminder for ' + who;
  return voiceStartConfirm(summary, async () => {
    await cancelReminderFor(stop);
    stop.reminderDate = '';
    stop.reminderRepeat = 0;
    save(); render();
    return summary;
  });
}

/* ---------- rehearsing the phone assistant ----------
   Same prompt and same tools the real line uses, so what he hears here is what
   a customer would hear. The difference is only at the end: nothing is written
   to the bookings inbox, and he is told exactly what would have been. */
async function voiceReceptionQuote(items, rural) {
  const res = await ownerApi('/owner/reception-quote', {
    method: 'POST',
    body: JSON.stringify({ items: Array.isArray(items) ? items : [], rural: rural || 'town' })
  });
  if (res.quote_required) {
    return {
      quote_required: true,
      reason: (res.unknown_items || []).length
        ? 'Not on the price list: ' + res.unknown_items.join(', ') + '.'
        : 'Over 10 km rural.',
      say: 'Tell them Woody will confirm the price, and take the booking anyway.'
    };
  }
  return { total: res.total, travel: res.travel };
}

function voiceReceptionBooking(args) {
  const where = [args.street, args.town].filter(Boolean).join(', ');
  voiceSetPending(`${args.name || 'no name'} — ${where || 'no address'}`, 'Practice only, nothing saved');
  return {
    ok: true,
    saved: true,
    say: 'Tell them it is booked in and Woody will ring to arrange the day, then say goodbye.'
  };
}

/* Every path returns an object - the model is waiting on a reply, and a thrown
   error here would leave the conversation hanging. */
async function voiceRunTool(name, args) {
  try {
    if (!ownerToken) return { error: 'The owner is signed out of the app, so nothing can be looked up. Tell him to sign in on the Bookings tab.' };
    // A rehearsal only ever gets the phone assistant's own two tools.
    if (voice && voice.mode === 'reception') {
      if (name === 'quote_price') return await voiceReceptionQuote(args.items, args.rural);
      if (name === 'take_booking') return voiceReceptionBooking(args);
      return { error: `There is no tool called ${name}.` };
    }
    if (name === 'list_jobs') return await voiceListJobs(args.when);
    if (name === 'find_job') return await voiceFindJob(args.query);
    if (name === 'business_summary') return await voiceSummary();
    if (name === 'mark_job') return await voiceMarkJob(args.query, args.status);
    if (name === 'confirm_pickup') return await voiceConfirmPickup(args.query, args.date);
    if (name === 'list_run') return voiceListRun();
    if (name === 'stop_details') return voiceStopDetails(args.query);
    if (name === 'navigate_to') return voiceNavigate(args.query);
    if (name === 'call_customer') return voiceCall(args.query);
    if (name === 'set_priority') return voiceSetPriority(args.query, args.urgent);
    if (name === 'mark_stop_done') return voiceMarkStopDone(args.query);
    if (name === 'mark_collected') return voiceMarkCollected(args.query);
    if (name === 'remove_stop') return voiceRemoveStop(args.query);
    if (name === 'mark_paid') return voiceMarkPaid(args.query);
    if (name === 'send_receipt') return voiceSendReceipt(args.query, args.amount);
    if (name === 'set_payment_reminder') return voiceSetReminder(args.query, args.amount, args.date, args.repeat_days);
    if (name === 'cancel_payment_reminder') return voiceCancelReminder(args.query);
    if (name === 'confirm_action') return await voiceConfirm(args.token);
    return { error: `There is no tool called ${name}.` };
  } catch (error) {
    return { error: error && error.message ? error.message : 'The app could not reach the server.' };
  }
}

/* ---------- the panel ---------- */
function voiceEl(id) { return document.getElementById(id); }

function voiceBuildUi() {
  if (voiceEl('voiceFab')) return;
  const style = document.createElement('style');
  style.textContent = `
  #voiceFab{position:fixed;right:max(12px,env(safe-area-inset-right));z-index:2100;display:none;
    bottom:calc(84px + env(safe-area-inset-bottom));width:62px;height:62px;min-height:62px;padding:0;
    border-radius:50%;font-size:26px;line-height:1;box-shadow:0 6px 20px rgba(0,0,0,.5);border:2px solid #ffffff2e}
  #voicePanel{position:fixed;left:8px;right:8px;z-index:2100;display:none;
    bottom:calc(84px + env(safe-area-inset-bottom));background:#08283df2;border:1px solid var(--line);
    border-radius:16px;padding:12px;box-shadow:0 8px 28px rgba(0,0,0,.55);backdrop-filter:blur(6px)}
  #voicePanel.on{display:block}
  #voicePanel .voice-top{display:flex;align-items:center;gap:10px;justify-content:space-between}
  #voiceState{font-weight:900;font-size:16px}
  #voiceMeter{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
  #voiceSaid{margin:8px 0 0;font-size:14px;color:var(--txt);min-height:19px}
  #voicePending{margin:8px 0 0;padding:8px 10px;border-radius:10px;background:#4a2a08;
    border:1px solid var(--warn);color:#ffe6b8;font-size:14px;font-weight:700;display:none}
  #voiceHint{margin:8px 0 0;font-size:12px;color:var(--muted)}
  #voiceButtons{display:flex;gap:8px;margin-top:10px}
  #voiceButtons button{flex:1}
  #voiceHear{display:none}`;
  document.head.append(style);

  const fab = document.createElement('button');
  fab.id = 'voiceFab';
  fab.type = 'button';
  fab.textContent = '🎙️';
  fab.title = 'Talk to the app';
  fab.setAttribute('aria-label', 'Talk to the app hands free');

  const panel = document.createElement('div');
  panel.id = 'voicePanel';
  panel.setAttribute('role', 'status');
  panel.innerHTML = `
    <div class="voice-top"><span id="voiceState">Connecting…</span><span id="voiceMeter"></span></div>
    <p id="voiceSaid" class="small"></p>
    <p id="voicePending"></p>
    <p id="voiceHint" class="small"></p>
    <div id="voiceButtons">
      <button type="button" class="ghost" id="voiceHear">🔊 Tap to hear</button>
      <button type="button" class="bad" id="voiceStop">⏹ Finish</button>
    </div>`;

  document.body.append(fab, panel);
  fab.onclick = () => { if (!voice) voiceStart('owner'); };
  const rehearse = document.getElementById('receptionTest');
  if (rehearse) rehearse.onclick = () => { if (!voice) voiceStart('reception'); };
  voiceEl('voiceStop').onclick = () => voiceStop('You ended it.');
  voiceEl('voiceHear').onclick = () => {
    if (!voice || !voice.audio) return;
    voice.audio.play().then(() => { voiceEl('voiceHear').style.display = 'none'; }).catch(() => {});
  };
}

function voiceSetState(text) { const el = voiceEl('voiceState'); if (el) el.textContent = text; }
function voiceSetSaid(text) { const el = voiceEl('voiceSaid'); if (el) el.textContent = text || ''; }
function voiceSetHint(text) { const el = voiceEl('voiceHint'); if (el) el.textContent = text || ''; }
function voiceSetPending(text, label = 'Waiting on your yes') {
  const el = voiceEl('voicePending');
  if (!el) return;
  el.textContent = text ? `${label}: ${text}` : '';
  el.style.display = text ? 'block' : 'none';
}

function voiceTick() {
  if (!voice) return;
  const elapsed = Date.now() - voice.startedAt;
  const seconds = Math.floor(elapsed / 1000);
  const meter = voiceEl('voiceMeter');
  if (meter) {
    const cost = (elapsed / 60000) * VOICE_RATE_PER_MIN;
    meter.textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')} · about $${cost.toFixed(2)}`;
  }
  if (elapsed > VOICE_MAX_MS) { voiceStop('Fifteen minutes up — hung up to stop the meter running.'); return; }
  if (Date.now() - voice.activeAt > VOICE_IDLE_MS) { voiceStop('Quiet for a minute and a half — hung up to save credit.'); return; }
  if (document.hidden && Date.now() - voice.hiddenAt > VOICE_HIDDEN_MS) {
    voiceStop('Phone went away — hung up to save credit.');
  }
}

function voiceActive() { if (voice) voice.activeAt = Date.now(); }

/* Silence detection off the microphone itself, rather than off event names we
   would have to keep in step with the API. Any data-channel traffic counts too,
   so a long answer from the assistant never gets cut off mid-sentence. */
function voiceWatchMic(stream) {
  let ctx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
      if (Math.sqrt(sum / buffer.length) > VOICE_MIC_LEVEL) voiceActive();
    }, 1000);
    return { ctx, timer };
  } catch (error) {
    try { ctx && ctx.close(); } catch (e) { /* nothing to clean up */ }
    return null;
  }
}

/* ---------- the session ---------- */
function voiceSend(event) {
  if (!voice || !voice.dc || voice.dc.readyState !== 'open') return false;
  try { voice.dc.send(JSON.stringify(event)); return true; } catch (error) { return false; }
}

async function voiceHandleEvent(raw) {
  voiceActive();
  let event;
  try { event = JSON.parse(raw); } catch (error) { return; }

  if (event.type === 'session.started') {
    voice.ready = true;
    const rehearsing = voice.mode === 'reception';
    voiceSetState(rehearsing ? 'Practice call' : 'Listening');
    voiceSetHint(rehearsing
      ? 'You are the customer. Nothing you agree to here is saved.'
      : 'Try: "What\'s on today?" · "Mark the Devon Street job done"');
    return;
  }
  if (event.type === 'session.closed') {
    voice.finalised = true;
    voiceCleanup('Finished.');
    return;
  }
  // What was said, for the caption. Names vary a little between transports, so
  // anything that looks like a transcript is accepted.
  if (event.type === 'turn.done' && event.turn && event.turn.transcript) {
    voiceSetSaid(`${event.turn.role === 'user' ? 'You' : 'Assistant'}: ${event.turn.transcript}`);
    return;
  }
  if (typeof event.type === 'string' && event.type.endsWith('_transcript.delta') && event.delta) {
    const who = event.type.includes('input') ? 'You' : 'Assistant';
    if (voice.saidWho !== who) { voice.saidWho = who; voice.saidText = ''; }
    voice.saidText = (voice.saidText + event.delta).slice(-160);
    voiceSetSaid(`${who}: ${voice.saidText}`);
    return;
  }

  // A delegated function call, wrapped in a response.event envelope.
  if (event.type === 'response.event'
    && event.event && event.event.type === 'response.output_item.done'
    && event.event.item && event.event.item.type === 'function_call'
    && event.event.item.status === 'completed') {
    const item = event.event.item;
    if (voice.handled.has(item.call_id)) return;
    voice.handled.add(item.call_id);
    let args = {};
    try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch (error) { args = {}; }
    voiceSetState('Working…');
    const output = await voiceRunTool(item.name, args && typeof args === 'object' ? args : {});
    voiceActive();
    if (!voice) return;
    voiceSend({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
    voiceSend({ type: 'response.create' });
    voiceSetState(voice && voice.mode === 'reception' ? 'Practice call' : 'Listening');
  }
}

async function voiceStart(mode = 'owner') {
  if (voice) return;
  voiceBuildUi();
  if (!ownerToken) {
    if (typeof setAppView === 'function') setAppView('bookings');
    alert('Sign in on the Bookings tab first, then tap the microphone again.');
    return;
  }
  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    alert('This phone\'s browser cannot do hands-free voice. Open the app in Chrome or Safari.');
    return;
  }

  const fab = voiceEl('voiceFab');
  fab.disabled = true;
  voiceEl('voicePanel').classList.add('on');
  voiceSetState('Connecting…');
  voiceSetSaid('');
  voiceSetPending('');
  voiceSetHint('Asking for the microphone…');
  voiceEl('voiceHear').style.display = 'none';

  const session = {
    mode,
    pc: null, dc: null, mic: null, audio: null, meter: null, timer: null,
    startedAt: Date.now(), activeAt: Date.now(), hiddenAt: Date.now(),
    handled: new Set(), ready: false, finalised: false,
    closing: false, saidWho: '', saidText: ''
  };
  voice = session;
  voiceRefresh();

  try {
    session.mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    if (voice !== session) throw Error('cancelled');

    const pc = new RTCPeerConnection();
    session.pc = pc;

    const audio = new Audio();
    audio.autoplay = true;
    audio.playsInline = true;
    session.audio = audio;
    pc.addEventListener('track', event => {
      audio.srcObject = new MediaStream([event.track]);
      audio.play().catch(() => {
        // iOS can refuse playback started outside the tap. One more tap fixes it.
        const hear = voiceEl('voiceHear');
        if (hear) hear.style.display = 'block';
      });
    });
    for (const track of session.mic.getAudioTracks()) pc.addTrack(track, session.mic);

    const dc = pc.createDataChannel('oai-events');
    session.dc = dc;
    dc.addEventListener('message', event => { if (voice === session) voiceHandleEvent(event.data); });
    dc.addEventListener('close', () => {
      if (voice === session && !session.finalised) voiceCleanup('Voice disconnected.');
    });
    pc.addEventListener('connectionstatechange', () => {
      if (voice !== session) return;
      if (pc.connectionState === 'failed') voiceCleanup('Lost the connection — check your signal.');
    });

    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== 'complete') {
      await new Promise(resolve => {
        // Whatever has been gathered by now is enough - the server's own
        // candidates are public, so waiting longer only delays the first word.
        const done = setTimeout(finish, 4000);
        function finish() {
          clearTimeout(done);
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
        function check() { if (pc.iceGatheringState === 'complete') finish(); }
        pc.addEventListener('icegatheringstatechange', check);
        check();
      });
    }
    if (voice !== session) throw Error('cancelled');

    voiceSetHint('Starting the conversation…');
    const res = await boundedFetch(`${API}/owner/live-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ sdp: pc.localDescription.sdp, mode })
    }, 25000);
    let data = {};
    try { data = await res.json(); } catch (error) { data = {}; }
    if (!res.ok || !data.sdp) {
      if (res.status === 401) {
        ownerToken = '';
        localStorage.removeItem(OWNER_TOKEN_KEY);
      }
      throw Error(data.error || 'The voice service could not be reached.');
    }
    if (voice !== session) throw Error('cancelled');

    await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
    session.sessionId = data.sessionId || '';
    session.meter = voiceWatchMic(session.mic);
    session.startedAt = Date.now();
    session.activeAt = Date.now();
    session.timer = setInterval(voiceTick, 1000);
    voiceSetState(mode === 'reception' ? 'Practice call' : 'Listening');
    voiceSetHint(mode === 'reception'
      ? 'You are the customer. Nothing you agree to here is saved.'
      : 'Try: "What\'s on today?" · "Mark the Devon Street job done"');
  } catch (error) {
    if (voice === session) {
      voiceCleanup(error && error.message === 'cancelled' ? '' : `Couldn't start: ${error && error.message ? error.message : 'microphone or network problem'}`);
    }
  } finally {
    fab.disabled = false;
  }
}

/* Asks for a clean close so the final usage comes back, then tears down anyway
   if the answer never arrives. */
function voiceStop(reason) {
  if (!voice || voice.closing) return;
  voice.closing = true;
  voiceSetState('Finishing…');
  if (reason) voiceSetHint(reason);
  const session = voice;
  if (!voiceSend({ type: 'session.close' })) { voiceCleanup(reason); return; }
  setTimeout(() => { if (voice === session) voiceCleanup(reason); }, 8000);
}

function voiceCleanup(reason) {
  const session = voice;
  if (!session) return;
  voice = null;
  clearInterval(session.timer);
  if (session.meter) {
    clearInterval(session.meter.timer);
    try { session.meter.ctx.close(); } catch (error) { /* already gone */ }
  }
  if (session.mic) session.mic.getTracks().forEach(track => track.stop());
  try { session.dc && session.dc.close(); } catch (error) { /* already gone */ }
  try { session.pc && session.pc.close(); } catch (error) { /* already gone */ }
  if (session.audio) { session.audio.pause(); session.audio.srcObject = null; }
  // A change he never said yes to must not survive into the next conversation.
  voicePending = null;

  voiceRefresh();
  voiceSetPending('');
  voiceSetSaid('');
  const spent = ((Date.now() - session.startedAt) / 60000) * VOICE_RATE_PER_MIN;
  voiceSetState('Off');
  voiceSetHint(`${reason ? reason + ' ' : ''}That one cost about $${spent.toFixed(2)}.`);
  setTimeout(() => {
    if (!voice) voiceEl('voicePanel') && voiceEl('voicePanel').classList.remove('on');
  }, 6000);
}

/* Called whenever the sign-in state changes, so the mic only shows to the owner. */
function voiceRefresh() {
  const fab = voiceEl('voiceFab');
  if (!fab) return;
  let signedIn = false;
  // Runs on a timer, so a half-loaded page must never turn it into a loop of errors.
  try { signedIn = Boolean(ownerToken); } catch (error) { signedIn = false; }
  const allowed = signedIn && Boolean(navigator.mediaDevices) && Boolean(window.RTCPeerConnection);
  // Hidden while a conversation is up: the panel covers this corner and carries
  // its own Finish button.
  fab.style.display = allowed && !voice ? 'block' : 'none';
  if (!allowed && voice) voiceStop('Signed out.');
}

function voiceBoot() {
  voiceBuildUi();
  voiceRefresh();
  setInterval(voiceRefresh, 2000);
  document.addEventListener('visibilitychange', () => {
    if (!voice) return;
    if (document.hidden) voice.hiddenAt = Date.now();
    else voiceActive();
  });
  // A closed tab still costs money until the session times out at the far end.
  window.addEventListener('pagehide', () => { if (voice) voiceSend({ type: 'session.close' }); });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', voiceBoot);
else voiceBoot();
