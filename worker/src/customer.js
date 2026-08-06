const OWNER_EMAIL = "nakiwreckremoval@gmail.com";
const CODE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PROFILE_INVITE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CUSTOMER_ACCOUNT_URL = "https://nakiwhitewareremoval.vip/account.html";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const ITEM_PRICES = {
  "Fridge or upright freezer": [2000, 1000],
  "Fridge/freezer": [2000, 1000],
  "Large or French-door fridge": [3000, 2000],
  "Bar fridge": [2000, 1000],
  "Chest freezer (small or medium)": [2000, 1000],
  "Large chest freezer (over 1.5 m)": [3000, 2000],
  "Oven or stove": [2000, 1000],
  "Cooktop": [1000, 0],
  "Small benchtop oven": [1000, 0],
  "Microwave": [1000, 0],
  "Dishwasher": [2000, 1000],
  "Front-loading washing machine": [2000, 1000],
  "Top-loading washing machine": [2000, 1000],
  "Dryer": [2000, 1000],
  "Metal wash tub": [2000, 1000],
  "Treadmill": [2000, 1500],
  "Exercise bike": [2000, 1500],
  "Elliptical or cross-trainer": [2000, 1500],
  "Rowing machine": [2000, 1500],
  "Stair climber or stepper": [2000, 1500],
  "Home gym or multi-gym": [3000, 2500],
  "Pilates reformer": [2000, 1500],
  "Lawn mower": [2000, 1000],
  "Push bike": [1000, 1000],
  "BBQ (2-4 burners)": [2000, 1000],
  "BBQ (5 or more burners)": [3000, 2000],
  "Gas bottle": [1000, 1000],
  "Cast-iron bath": [3000, 2000],
  "Flat-screen TV": [2000, 1000],
  "Old box TV (CRT)": [4500, 3500],
  "Other": [0, 0]
};

const RURAL_PRICES = {
  "Main town or main road - no travel fee": 0,
  "Rural: up to 5 km from a main town or road - add $5": 500,
  "Outlying route, or rural 6-10 km away - add $10": 1000,
  "More than 10 km from a covered town or route - contact us": 0
};

const REFERRAL_OPTIONS = new Set(["Google", "Facebook", "Find My Local", "AI", "Word of mouth", "Other", ""]);
const OWNER_STATUSES = new Set(["NEW", "ADDED_TO_RUN", "CONTACTED", "CONFIRMED", "COMPLETED", "DECLINED", "CANCELLED"]);
// The arcade games. Anything else posting a score is rejected.
const ARCADE_GAMES = new Set(["stack", "flap", "tower", "invade", "dash", "wio", "squad"]);
// Arcade chat guard rails. Short lines, a handful a minute, kept a month.
const CHAT_MAX_LEN = 140;
const CHAT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const CHAT_PER_MINUTE = 4;
const CHAT_FETCH = 60;
const FRIEND_SEARCH_LIMIT = 10;
const LOBBY_INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const ARCADE_INVITE_COOLDOWN_MS = 2 * 60 * 1000;
const ARCADE_INVITE_DAY_MS = 24 * 60 * 60 * 1000;
const ARCADE_INVITE_MAX_PER_DAY = 10;
const ARCADE_ONLINE_MS = 75 * 1000;
const DIRECT_CHAT_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const DIRECT_CHAT_PER_MINUTE = 10;
// Family-safe chat view. These are stable account ids, not changeable arcade
// nicknames, so another player cannot impersonate someone on the trusted list.
const CHAT_RESTRICTED_VIEWERS = new Set([
  "812581f5-ebce-4337-9160-17ee73a9c1bd", // Maddie
  "8dd18c74-4c57-4df7-a288-50bd3f366947"  // Kaylee
]);
const CHAT_TRUSTED_AUTHORS = [
  "15d66880-9a74-4d7f-895d-e566e9549320", // Rene
  "a35ea2ce-1897-4ee0-bc67-7b70daeb17c4", // Sin
  "89ff9ebb-44eb-492d-9ab3-2f991d32d950", // Woody
  "c76ed0d5-73a4-4a43-ad30-6cc4b27e2524"  // Chloe
];
const CHAT_TRUSTED_AUTHOR_SET = new Set(CHAT_TRUSTED_AUTHORS);
// Public Arcade chat stays available to restricted accounts, but their server
// view, unread count and reply previews contain only their own messages plus
// these approved authors. Private chat and friend features use the same rule.
// No prize is offered for the monthly boards - kept empty so the page hides the prize card.
const ARCADE_PRIZE = "";
const JOTFORM_FORM_IDS = new Set(["251768488640874", "240411186193047"]);
const JOTFORM_APPLIANCE_QIDS = {
  "251768488640874": [7, 8, 54, 55, 56, 57, 58, 59, 60, 61],
  "240411186193047": [7, 8, 46, 47, 48, 49, 50, 51, 52, 53]
};
let googleToken = { value: "", expiresAt: 0 };

function clean(value, max = 200) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function email(value) {
  return clean(value, 160).toLowerCase();
}

function now() {
  return Date.now();
}

function friendPair(a, b) {
  return String(a) < String(b) ? [a, b] : [b, a];
}

function arcadeDisplayName(row) {
  return clean(row?.nickname || row?.first_name || "Player", 20);
}

function directChatAllowed(a, b) {
  return arcadeContactAllowed(a, b);
}

// One account-level policy covers friend requests, play invites and private
// messages. Names are editable, so this must never use nicknames.
function arcadeContactAllowed(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (CHAT_RESTRICTED_VIEWERS.has(left) && !CHAT_TRUSTED_AUTHOR_SET.has(right)) return false;
  if (CHAT_RESTRICTED_VIEWERS.has(right) && !CHAT_TRUSTED_AUTHOR_SET.has(left)) return false;
  return true;
}

async function acceptedArcadeFriends(env, a, b) {
  const [low, high] = friendPair(a, b);
  const row = await env.CUSTOMER_DB.prepare(
    "SELECT status FROM arcade_friendships WHERE user_low = ?1 AND user_high = ?2"
  ).bind(low, high).first();
  return row?.status === "accepted";
}

function arcadeFriendRequestEmail(sender) {
  const name = arcadeDisplayName(sender);
  return `Hi,

${name} sent you a friend request in Naki Arcade.

Open Naki Arcade, sign in, then accept or decline it under Arcade friends:
${CUSTOMER_ACCOUNT_URL.replace("account.html", "game.html")}

Your email address stays private. Your arcade name can change whenever you like — the friendship is safely tied to your Naki account.

Naki Whiteware Removal`;
}

function arcadePlayInviteEmail(sender) {
  const name = arcadeDisplayName(sender);
  return `Hi,

${name} invited you to come play in Naki Arcade.

Play now:
${CUSTOMER_ACCOUNT_URL.replace("account.html", "game.html?invite=1")}

Naki Arcade is the free games area from Naki Whiteware Removal. You can play straight away. Sign in with your email if you want to add friends, chat and join the scoreboards.

Naki Whiteware Removal`;
}

async function createArcadeFriendRequest(env, sendMail, sender, recipient) {
  const [low, high] = friendPair(sender.id, recipient.id);
  const existing = await env.CUSTOMER_DB.prepare(
    "SELECT status, requested_by FROM arcade_friendships WHERE user_low = ?1 AND user_high = ?2"
  ).bind(low, high).first();
  if (existing?.status === "accepted") return { accepted: true, pending: false, emailSent: false };
  if (existing?.status === "pending") {
    if (existing.requested_by !== sender.id) {
      await env.CUSTOMER_DB.prepare(
        "UPDATE arcade_friendships SET status = 'accepted', updated_at = ?3 WHERE user_low = ?1 AND user_high = ?2"
      ).bind(low, high, now()).run();
      return { accepted: true, pending: false, emailSent: false };
    }
    return { accepted: false, pending: true, emailSent: false };
  }
  const stamp = now();
  await env.CUSTOMER_DB.prepare(
    `INSERT INTO arcade_friendships
      (user_low, user_high, requested_by, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'pending', ?4, ?4)`
  ).bind(low, high, sender.id, stamp).run();
  // The request is already safely saved. A temporary mail issue must never
  // turn it into the vague "live service" error the player just saw.
  const emailSent = await sendMail(env, {
    to: recipient.email,
    name: arcadeDisplayName(recipient),
    subject: "Naki Arcade friend request",
    text: arcadeFriendRequestEmail(sender)
  }).catch(() => false);
  return { accepted: false, pending: true, emailSent };
}

/* ---------- Arcade months ----------
   Worked out in Auckland, never UTC. The worker's clock is 12-13 hours behind
   NZ, so a run at 11pm on the 31st would otherwise be filed under the month the
   player had already finished - and the prize would go to the wrong board. */
function aucklandMonth(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit"
  }).formatToParts(at);
  const get = type => (parts.find(p => p.type === type) || {}).value || "";
  return `${get("year")}-${get("month")}`;
}

function previousMonth(month) {
  const [year, mon] = String(month).split("-").map(Number);
  if (!year || !mon) return month;
  return mon <= 1 ? `${year - 1}-12` : `${year}-${String(mon - 1).padStart(2, "0")}`;
}

// Same Auckland-not-UTC reasoning as the month, at day and ISO-week grain.
function aucklandDay(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(at);
  const get = type => (parts.find(p => p.type === type) || {}).value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function aucklandWeek(at = new Date()) {
  const [y, m, d] = aucklandDay(at).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday decides the ISO week's year
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                     "July", "August", "September", "October", "November", "December"];
function monthLabel(month) {
  const [year, mon] = String(month).split("-").map(Number);
  return MONTH_NAMES[mon - 1] ? `${MONTH_NAMES[mon - 1]} ${year}` : String(month);
}

/* ---------- Arcade chat moderation ----------
   A word list only ever catches words, so this is a first pass and not a
   promise. What actually covers the rest is that the owner sees a delete button
   on every message, so anything this misses can be pulled down in a tap. */
const BANNED_WORDS = new Set([
  "fuck", "fucker", "fuk", "fck", "shit", "shite", "bullshit", "crap", "piss",
  "cunt", "twat", "bitch", "bastard", "wanker", "wank", "dick", "dickhead",
  "prick", "cock", "knob", "arsehole", "asshole", "arse", "ass", "bollocks",
  "slut", "whore", "hoe", "nigger", "nigga", "faggot", "fag", "dyke", "tranny",
  "retard", "retarded", "spastic", "coon", "kike", "chink", "gook", "paki",
  "wog", "abo", "raghead", "towelhead", "jizz", "cum", "wtf", "stfu", "gtfo",
  "milf", "porn", "rape", "rapist", "pedo", "paedo", "nonce", "hitler", "nazi",
  "kys", "suicide"
]);
// Words that innocently contain one of the above. Checked before the filter, so
// the classic Scunthorpe problem doesn't quietly eat a real message.
const FILTER_ALLOW = new Set([
  "scunthorpe", "penistone", "cockburn", "cocktail", "cockpit", "cockatoo",
  "cockle", "hancock", "shiitake", "shitake", "class", "classic", "classes",
  "assess", "assessment", "assassin", "assist", "assume", "asset", "assemble",
  "assign", "associate", "bass", "grass", "pass", "passing", "glass", "mass",
  "brass", "compass", "grasshopper", "massive", "classify", "analysis",
  "analyse", "analytics", "titan", "titanium", "dickens", "cumulative",
  "circumstance", "document", "accumulate", "scrape", "grape", "drape",
  "therapist", "cassette", "embassy", "canvass", "harass", "surpass"
]);
// Contact details and links are blocked outright. A public arcade board is not
// the place to hand out a phone number, and links are how spam arrives.
const CHAT_CONTACT_RE = /(https?:\/\/)|(\bwww\.)|([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})|(\b\d[\d\s().+-]{6,}\d\b)/i;

// "f u c k" and "f.u.c.k" collapse back to one word. A run of single letters is
// never how ordinary text is written, so real words are left alone.
function joinSpacedLetters(text) {
  return text.replace(/\b(?:[a-z][\s.\-_*+]+){2,}[a-z]\b/g, match => match.replace(/[^a-z]/g, ""));
}

// Common leetspeak folded back to letters, then everything that isn't a letter
// becomes a word gap.
function normaliseForFilter(text) {
  return text
    .replace(/@/g, "a").replace(/\$/g, "s")
    .replace(/0/g, "o").replace(/1/g, "i").replace(/3/g, "e")
    .replace(/4/g, "a").replace(/5/g, "s").replace(/7/g, "t")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

// Returns a message to show the sender, or "" when the line is fine.
function chatProblem(body) {
  if (CHAT_CONTACT_RE.test(body)) {
    return "Leave out phone numbers, emails and links.";
  }
  const words = normaliseForFilter(joinSpacedLetters(body.toLowerCase())).split(" ").filter(Boolean);
  for (const word of words) {
    if (FILTER_ALLOW.has(word)) continue;
    // "fuuuuck" -> "fuck", and a trailing s/ing/ed/er so plurals and -ing forms
    // don't slip straight through.
    const flat = word.replace(/(.)\1+/g, "$1");
    const stems = new Set([word, flat]);
    for (const form of [word, flat]) {
      for (const suffix of ["ing", "ers", "er", "ed", "es", "s", "y", "in", "az"]) {
        if (form.length > suffix.length + 2 && form.endsWith(suffix)) {
          stems.add(form.slice(0, -suffix.length));
        }
      }
    }
    for (const stem of stems) {
      if (BANNED_WORDS.has(stem)) return "Keep it clean, please.";
    }
    // Compounds like "bullshit". Only substrings of 4+ letters are considered,
    // which is what keeps three-letter entries from firing inside normal words.
    for (const banned of BANNED_WORDS) {
      if (banned.length >= 4 && word.length > banned.length && word.includes(banned)) {
        return "Keep it clean, please.";
      }
    }
  }
  return "";
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomToken(size = 32) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(size)));
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function hashCode(env, role, address, code) {
  return sha256(`${String(env.AUTH_PEPPER || "")}|${role}|${address}|${code}`);
}

async function hashToken(token) {
  return sha256(token);
}

function authToken(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function sessionFor(request, env, role) {
  const token = authToken(request);
  if (!token) return null;
  const tokenHash = await hashToken(token);
  const row = await env.CUSTOMER_DB.prepare(
    "SELECT token_hash, customer_id, role, email, expires_at FROM sessions WHERE token_hash = ?1 AND role = ?2 AND expires_at > ?3"
  ).bind(tokenHash, role, now()).first();
  return row || null;
}

function addressFrom(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label || "",
    streetAddress: row.street_address || "",
    town: row.town || "",
    area: row.area || "",
    ruralOption: row.rural_option || "",
    accessNotes: row.access_notes || "",
    isDefault: Boolean(row.is_default)
  };
}

function profileFrom(row, addresses = []) {
  if (!row) return null;
  return {
    email: row.email,
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    phone: row.phone || "",
    streetAddress: row.street_address || "",
    town: row.town || "",
    area: row.area || "",
    ruralOption: row.rural_option || "",
    referralSource: row.referral_source || "",
    referralDetails: row.referral_details || "",
    accessNotes: row.access_notes || "",
    nickname: row.nickname || "",
    addresses
  };
}

function bookingFrom(row) {
  let items = [];
  try { items = JSON.parse(row.items_json || "[]"); } catch { items = []; }
  const source = row.booking_source || "WEBSITE";
  const status = row.status || "NEW";
  return {
    id: row.id,
    status,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    email: row.email,
    streetAddress: row.street_address,
    town: row.town,
    area: row.area || "",
    ruralOption: row.rural_option,
    items,
    additionalInfo: row.additional_info || "",
    referralSource: row.referral_source || "",
    referralDetails: row.referral_details || "",
    total: Number(row.total_cents || 0) / 100,
    quoteRequired: Boolean(row.quote_required),
    // A priced quote replaces the "quote to be confirmed" placeholder.
    quotedPrice: row.quoted_at ? Number(row.quote_cents || 0) / 100 : null,
    quoteNote: row.quote_note || "",
    quotedAt: row.quoted_at ? new Date(row.quoted_at).toISOString() : "",
    photoCount: Number(row.photo_count || 0),
    // Lets the owner app match a pickup-run job back to the stop it came from.
    externalKey: row.external_key || "",
    sheetSyncStatus: row.sheet_sync_status,
    source,
    pickupDate: row.pickup_date || "",
    pickupWindow: row.pickup_window || "",
    customerNote: row.customer_note || "",
    cancellationReason: row.cancellation_reason || "",
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : "",
    canCancel: (source === "WEBSITE" || source === "JOTFORM" || source === "PICKUP_RUN") &&
      !["COMPLETED", "DECLINED", "CANCELLED"].includes(status),
    // Only website bookings can be re-priced safely - their items come from our
    // own list, so the total can be recalculated without guessing.
    canEdit: source === "WEBSITE" && !["COMPLETED", "DECLINED", "CANCELLED"].includes(status),
    createdAt: new Date(row.created_at).toISOString()
  };
}

function jotformValue(raw, qid, name = "") {
  if (!raw || typeof raw !== "object") return "";
  const candidates = [`q${qid}_${name}`, `q${qid}`, String(qid), name].filter(Boolean);
  for (const key of candidates) {
    if (Object.hasOwn(raw, key) && raw[key] != null) return raw[key];
  }
  const prefix = `q${qid}_`;
  const key = Object.keys(raw).find(item => item.startsWith(prefix));
  return key ? raw[key] : "";
}

function objectPart(value, keys) {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    if (value[key] != null && clean(value[key], 200)) return clean(value[key], 200);
  }
  return "";
}

function jotformName(value) {
  if (value && typeof value === "object") {
    return {
      firstName: objectPart(value, ["first", "firstName"]),
      lastName: objectPart(value, ["last", "lastName"])
    };
  }
  const parts = clean(value, 130).split(/\s+/).filter(Boolean);
  return { firstName: parts.shift() || "", lastName: parts.join(" ") };
}

function jotformAddress(value) {
  if (!value || typeof value !== "object") {
    return { streetAddress: clean(value, 180), town: "", area: "" };
  }
  const line1 = objectPart(value, ["addr_line1", "address1", "line1"]);
  const line2 = objectPart(value, ["addr_line2", "address2", "line2"]);
  return {
    streetAddress: [line1, line2].filter(Boolean).join(", "),
    town: objectPart(value, ["city", "town"]),
    area: objectPart(value, ["state", "region"])
  };
}

function jotformMoney(value) {
  const amount = Number(String(value == null ? "" : value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(amount) && amount >= 0 && amount <= 10000 ? Math.round(amount * 100) : 0;
}

async function parseJotformRequest(request) {
  const contentType = request.headers.get("Content-Type") || "";
  let body = {};
  if (contentType.includes("application/json")) {
    try { body = await request.json(); } catch { body = {}; }
  } else {
    try {
      const form = await request.formData();
      for (const [key, value] of form.entries()) body[key] = typeof value === "string" ? value : "";
    } catch { body = {}; }
  }
  let raw = body.rawRequest || body.raw_request || {};
  if (typeof raw === "string") {
    try { raw = JSON.parse(raw); } catch { raw = {}; }
  }
  if (!raw || typeof raw !== "object") raw = {};
  return { body, raw: { ...body, ...raw } };
}

async function handleJotformSubmission(request, env, json) {
  const supplied = new URL(request.url).searchParams.get("key") || "";
  if (!env.JOTFORM_WEBHOOK_SECRET || !supplied ||
      await sha256(supplied) !== await sha256(String(env.JOTFORM_WEBHOOK_SECRET))) {
    return json(request, { error: "Not found" }, 404);
  }
  const { body, raw } = await parseJotformRequest(request);
  const formId = clean(body.formID || body.formId || raw.formID || raw.formId, 30);
  const submissionId = clean(body.submissionID || body.submissionId || raw.submissionID || raw.submissionId, 40);
  if (!JOTFORM_FORM_IDS.has(formId) || !/^\d{10,30}$/.test(submissionId)) {
    return json(request, { error: "Unsupported Jotform submission" }, 400);
  }

  const person = jotformName(jotformValue(raw, 4, "name"));
  const location = jotformAddress(jotformValue(raw, 5, "address"));
  const address = email(jotformValue(raw, 35, "email"));
  if (!EMAIL_RE.test(address)) return json(request, { error: "Customer email is missing" }, 400);
  const items = JOTFORM_APPLIANCE_QIDS[formId]
    .map(qid => clean(jotformValue(raw, qid), 100))
    .filter(Boolean);
  const createdAt = now();
  const customerId = await customerIdForEmail(env, address);
  const existing = await env.CUSTOMER_DB.prepare(
    "SELECT id FROM jotform_bookings WHERE submission_id = ?1"
  ).bind(submissionId).first();
  await env.CUSTOMER_DB.prepare(
    `INSERT INTO jotform_bookings (
      id, submission_id, form_id, customer_id, status, first_name, last_name, phone, email,
      street_address, town, area, rural_option, items_json, additional_info, referral_source,
      referral_details, total_cents, quote_required, created_at, updated_at
    ) VALUES (?1, ?2, ?3, ?4, 'NEW', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)
    ON CONFLICT(submission_id) DO UPDATE SET
      customer_id=COALESCE(jotform_bookings.customer_id, excluded.customer_id),
      first_name=excluded.first_name, last_name=excluded.last_name, phone=excluded.phone,
      email=excluded.email, street_address=excluded.street_address, town=excluded.town,
      area=excluded.area, rural_option=excluded.rural_option, items_json=excluded.items_json,
      additional_info=excluded.additional_info, referral_source=excluded.referral_source,
      referral_details=excluded.referral_details, total_cents=excluded.total_cents,
      quote_required=excluded.quote_required, updated_at=excluded.updated_at`
  ).bind(
    `JOTFORM-${submissionId}`, submissionId, formId, customerId,
    person.firstName, person.lastName, clean(jotformValue(raw, 39, "number"), 30), address,
    location.streetAddress, location.town, location.area,
    clean(jotformValue(raw, 37, "ifRural37"), 120), JSON.stringify(items),
    clean(jotformValue(raw, 18, "additionalInformationenquires"), 1500),
    clean(jotformValue(raw, formId === "251768488640874" ? 70 : 60, "howDidYouHear"), 80),
    clean(jotformValue(raw, formId === "251768488640874" ? 74 : 64, "otherReferralDetails"), 160),
    jotformMoney(jotformValue(raw, 31, "total")), items.includes("Other") ? 1 : 0, createdAt
  ).run();
  const booking = await env.CUSTOMER_DB.prepare(
    "SELECT * FROM jotform_bookings WHERE submission_id = ?1"
  ).bind(submissionId).first();
  let sheetBackedUp = booking?.sheet_sync_status === "SYNCED";
  if (!sheetBackedUp) {
    try {
      await syncBookingToSheet(env, booking, "jotform_bookings");
      sheetBackedUp = true;
    } catch (error) {
      await markSheetFailure(env, booking.id, error, "jotform_bookings");
    }
  }
  return json(request, { ok: true, duplicate: Boolean(existing), sheetBackedUp }, existing ? 200 : 201);
}

function calculate(items, ruralOption) {
  const valid = items.filter(item => Object.hasOwn(ITEM_PRICES, item)).slice(0, 10);
  let cents = valid.reduce((sum, item) => sum + ITEM_PRICES[item][1], 0);
  if (valid.length) {
    cents += Math.max(...valid.map(item => ITEM_PRICES[item][0] - ITEM_PRICES[item][1]));
  }
  cents += RURAL_PRICES[ruralOption] || 0;
  const quoteRequired = valid.includes("Other") || ruralOption.startsWith("More than 10 km");
  return { cents, quoteRequired };
}

function priceText(price) {
  return price.quoteRequired ? "Quote to be confirmed" : `$${(price.cents / 100).toFixed(2)}`;
}

function bookingDetails(profile, items, additionalInfo, price, bookingId = "") {
  const lines = [
    "Whiteware collection form",
    "",
    `Name: ${profile.first_name} ${profile.last_name}`.trim(),
    `Phone number: ${profile.phone}`,
    `Email: ${profile.email}`,
    `Pickup address: ${profile.street_address}, ${profile.town}${profile.area ? `, ${profile.area}` : ""}`,
    `Pickup area: ${profile.rural_option}`
  ];
  items.forEach((item, index) => lines.push(`Appliance ${index + 1}: ${item}`));
  if (additionalInfo) lines.push(`Comments or additional details: ${additionalInfo}`);
  lines.push(`Estimated price: ${priceText(price)}`);
  if (bookingId) lines.push(`Booking ID: ${bookingId}`);
  return lines.join("\n");
}

function customerConfirmationText(profile, items, additionalInfo, price) {
  return `Thank you! We have received your form submission and will get in touch as soon as possible to confirm a pickup day.

Collections in Hāwera, Eltham, Stratford, Inglewood, New Plymouth, Bell Block and Waitara are usually within 5-10 working days (sooner if possible), with at least 1-2 days' notice. Pickups outside these areas can take longer because we group nearby collections together.

No one is required to be home during pickup, but we need adequate access to the appliance(s). If possible, please leave them inside your property line with the payment inside.

Please make sure any furry friends are securely put away if needed. Please ensure no food is left inside any appliances, but no cleaning is required. Thank you! 😊

${bookingDetails(profile, items, additionalInfo, price)}

Naki Whiteware Removal`;
}

function ownerNotificationText(profile, items, additionalInfo, price, bookingId) {
  return `A new customer booking was made through the Naki Whiteware website.

${bookingDetails(profile, items, additionalInfo, price, bookingId)}

Open the Bookings tab in Naki Pickup Run to add it to a run.`;
}

function pickupDateText(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return "";
  return new Intl.DateTimeFormat("en-NZ", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Pacific/Auckland"
  }).format(new Date(`${value}T12:00:00+12:00`));
}

function pickupConfirmationText(booking, pickupDate, pickupWindow, customerNote) {
  const day = pickupDateText(pickupDate);
  return `Your whiteware pickup is confirmed.

Pickup day: ${day}
${pickupWindow ? `Time: ${pickupWindow}\n` : ""}${customerNote ? `Note: ${customerNote}\n` : ""}
Please make sure the appliance(s) are accessible and any pets are safely secured. No one needs to be home if the items and payment are left safely inside your property line.

You can view or cancel your active booking here:
${CUSTOMER_ACCOUNT_URL}

Booking ID: ${booking.id}

Naki Whiteware Removal`;
}

function ownerCancellationText(booking, reason) {
  const name = `${booking.first_name || ""} ${booking.last_name || ""}`.trim() || "(Name not saved)";
  const location = [booking.street_address, booking.town, booking.area].filter(Boolean).join(", ");
  return `A customer cancelled their whiteware pickup.

Name: ${name}
Email: ${booking.email}
Phone: ${booking.phone || "(Not saved)"}
Address: ${location || "(Not saved)"}
Booking ID: ${booking.id}
${reason ? `Reason: ${reason}` : "Reason: Not provided"}

The booking is now marked Cancelled in the Bookings tab.`;
}

function customerCancellationText(booking) {
  return `Your whiteware pickup cancellation has been received.

Booking ID: ${booking.id}

If this was a mistake or you would like to arrange another collection, visit:
${CUSTOMER_ACCOUNT_URL}

Naki Whiteware Removal`;
}

function customerQuoteText(booking, quoteCents, note) {
  const first = String(booking.first_name || "").trim();
  return `Hi${first ? ` ${first}` : ""},

Here is the price for your whiteware collection.

Price: $${(quoteCents / 100).toFixed(2)}
${note ? `\n${note}\n` : ""}
This price is now showing in your account, along with the stage your pickup is at:
${CUSTOMER_ACCOUNT_URL}

If it does not look right, just reply to this email.

Booking ID: ${booking.id}

Cheers,
Woody
Naki Whiteware Removal`;
}

function ownerBookingChangeText(booking, items, additionalInfo, price) {
  const name = `${booking.first_name || ""} ${booking.last_name || ""}`.trim() || "(Name not saved)";
  const location = [booking.street_address, booking.town, booking.area].filter(Boolean).join(", ");
  return `A customer changed their whiteware collection request.

Name: ${name}
Email: ${booking.email}
Phone: ${booking.phone || "(Not saved)"}
Address: ${location || "(Not saved)"}
Booking ID: ${booking.id}

Updated list:
${items.map((item, index) => `Appliance ${index + 1}: ${item}`).join("\n")}
${additionalInfo ? `\nComments: ${additionalInfo}` : ""}
New estimated price: ${priceText(price)}

Check the Bookings tab - if this pickup is already on a run, the load may have changed.`;
}

function ownerCustomerMessageText(booking, message) {
  const name = `${booking.first_name || ""} ${booking.last_name || ""}`.trim() || "(Name not saved)";
  return `A customer sent a message about their pickup.

Name: ${name}
Email: ${booking.email}
Phone: ${booking.phone || "(Not saved)"}
Booking ID: ${booking.id}
Pickup: ${[booking.street_address, booking.town].filter(Boolean).join(", ") || "(Not saved)"}

Message:
${message}

Reply straight to this email to answer them.`;
}

function ownerProfileSignupText(profile, source) {
  const name = `${profile.first_name || ""} ${profile.last_name || ""}`.trim() || "(Name not saved yet)";
  const address = [profile.street_address, profile.town, profile.area].filter(Boolean).join(", ") || "(Address not saved yet)";
  return `A new customer profile was created ${source === "private-link" ? "from an invoice or receipt link" : "through the Naki Whiteware website"}.

Name: ${name}
Email: ${profile.email}
Phone: ${profile.phone || "(Not saved yet)"}
Pickup address: ${address}

This does not mean they have requested a new collection yet.

Open the Customers tab in Naki Pickup Run to view their profile.`;
}

async function notifyOwnerOfNewCustomer(env, sendMail, profile, source) {
  if (!profile) return;
  const name = `${profile.first_name || ""} ${profile.last_name || ""}`.trim();
  try {
    await sendMail(env, {
      to: OWNER_EMAIL,
      name: "Woody",
      subject: `New customer profile${name ? ` - ${name}` : ""}`,
      text: ownerProfileSignupText(profile, source)
    });
  } catch {
    // A temporary mail problem must not block the customer's new account.
  }
}

async function sendCode(env, sendMail, address, role) {
  const recent = await env.CUSTOMER_DB.prepare(
    "SELECT COUNT(*) AS count FROM login_codes WHERE email = ?1 AND role = ?2 AND created_at > ?3"
  ).bind(address, role, now() - 10 * 60 * 1000).first();
  if (Number(recent && recent.count || 0) >= 3) return true;

  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
  const createdAt = now();
  await env.CUSTOMER_DB.prepare(
    "INSERT INTO login_codes (id, email, role, code_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
  ).bind(crypto.randomUUID(), address, role, await hashCode(env, role, address, code), createdAt + CODE_TTL_MS, createdAt).run();

  const owner = role === "owner";
  const sent = await sendMail(env, {
    to: address,
    name: owner ? "Woody" : "",
    subject: owner ? "Your Naki Pickup Run login code" : "Your Naki Whiteware login code",
    text: `${owner ? "Your owner" : "Your"} login code is ${code}\n\nIt expires in 10 minutes. If you did not request it, you can ignore this email.\n\nNaki Whiteware Removal`
  });
  if (!sent) throw new Error("Login email could not be sent");
  return true;
}

async function verifyCode(env, address, role, code) {
  const row = await env.CUSTOMER_DB.prepare(
    "SELECT id, code_hash, attempts FROM login_codes WHERE email = ?1 AND role = ?2 AND consumed_at IS NULL AND expires_at > ?3 ORDER BY created_at DESC LIMIT 1"
  ).bind(address, role, now()).first();
  if (!row || Number(row.attempts || 0) >= 5) return null;

  const expected = await hashCode(env, role, address, code);
  if (expected !== row.code_hash) {
    await env.CUSTOMER_DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?1").bind(row.id).run();
    return null;
  }

  const createdAt = now();
  let customerId = null;
  let customerCreated = false;
  if (role === "customer") {
    let customer = await env.CUSTOMER_DB.prepare("SELECT id FROM customers WHERE email = ?1").bind(address).first();
    if (!customer) {
      customerId = crypto.randomUUID();
      customerCreated = true;
      await env.CUSTOMER_DB.prepare(
        "INSERT INTO customers (id, email, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)"
      ).bind(customerId, address, createdAt).run();
    } else {
      customerId = customer.id;
    }
  }

  const token = randomToken();
  const tokenHash = await hashToken(token);
  await env.CUSTOMER_DB.batch([
    env.CUSTOMER_DB.prepare("UPDATE login_codes SET consumed_at = ?1 WHERE id = ?2").bind(createdAt, row.id),
    env.CUSTOMER_DB.prepare(
      "INSERT INTO sessions (token_hash, customer_id, role, email, expires_at, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)"
    ).bind(tokenHash, customerId, role, address, createdAt + SESSION_TTL_MS, createdAt)
  ]);
  return { token, customerId, customerCreated };
}

async function googleAccessToken(env) {
  if (googleToken.value && googleToken.expiresAt > now() + 60000) return googleToken.value;
  const creds = JSON.parse(String(env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}"));
  if (!creds.client_email || !creds.private_key) throw new Error("Google Sheet backup is not configured");
  const issued = Math.floor(now() / 1000);
  const header = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: issued,
    exp: issued + 3600
  })));
  const pem = creds.private_key.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const binary = atob(pem);
  const keyBytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  if (!response.ok) throw new Error(`Google login failed (${response.status})`);
  const data = await response.json();
  googleToken = { value: data.access_token, expiresAt: now() + Number(data.expires_in || 3600) * 1000 };
  return googleToken.value;
}

function sheetRow(booking) {
  const row = Array(25).fill("");
  row[0] = new Date(booking.created_at).toISOString().replace("T", " ").slice(0, 19);
  row[1] = booking.first_name;
  row[2] = booking.last_name;
  row[3] = booking.phone;
  row[4] = booking.email;
  row[5] = booking.street_address;
  row[6] = booking.town;
  row[7] = booking.area || "";
  row[8] = booking.rural_option;
  let items = [];
  try { items = JSON.parse(booking.items_json || "[]"); } catch { items = []; }
  items.slice(0, 10).forEach((item, index) => { row[9 + index] = item; });
  const notes = [booking.additional_info || ""];
  if (booking.referral_source) {
    notes.push(`Found us: ${booking.referral_source}${booking.referral_details ? ` - ${booking.referral_details}` : ""}`);
  }
  row[19] = notes.filter(Boolean).join("; ");
  row[20] = (Number(booking.total_cents || 0) / 100).toFixed(2);
  row[21] = booking.id;
  // A retried backup must not reset a booking that has already moved on.
  row[22] = booking.status || "NEW";
  return row;
}

async function syncBookingToSheet(env, booking, table = "bookings") {
  const targetTable = table === "jotform_bookings" ? "jotform_bookings" : "bookings";
  const token = await googleAccessToken(env);
  const sheetId = String(env.GOOGLE_SHEET_ID || "").trim();
  if (!sheetId) throw new Error("Google Sheet ID is missing");
  const range = encodeURIComponent("'Pickups'!A:Y");
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [sheetRow(booking)] })
    }
  );
  if (!response.ok) throw new Error(`Google Sheet backup failed (${response.status})`);
  await env.CUSTOMER_DB.prepare(
    `UPDATE ${targetTable} SET sheet_sync_status = 'SYNCED', sheet_sync_attempts = sheet_sync_attempts + 1, sheet_last_error = '', sheet_synced_at = ?1, updated_at = ?1 WHERE id = ?2`
  ).bind(now(), booking.id).run();
}

async function updateSheetBookingStatus(env, bookingId, status) {
  const token = await googleAccessToken(env);
  const sheetId = String(env.GOOGLE_SHEET_ID || "").trim();
  if (!sheetId) return false;
  const lookupRange = encodeURIComponent("'Pickups'!V2:W2000");
  const lookup = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${lookupRange}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!lookup.ok) return false;
  const rows = (await lookup.json()).values || [];
  const index = rows.findIndex(row => String(row[0] || "") === bookingId);
  if (index < 0) return false;
  const rowNumber = index + 2;
  const statusRange = encodeURIComponent(`'Pickups'!W${rowNumber}`);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${statusRange}?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[status]] })
    }
  );
  return response.ok;
}

async function markSheetFailure(env, bookingId, error, table = "bookings") {
  const targetTable = table === "jotform_bookings" ? "jotform_bookings" : "bookings";
  await env.CUSTOMER_DB.prepare(
    `UPDATE ${targetTable} SET sheet_sync_status = 'PENDING', sheet_sync_attempts = sheet_sync_attempts + 1, sheet_last_error = ?1, updated_at = ?2 WHERE id = ?3`
  ).bind(clean(error && error.message || error, 300), now(), bookingId).run();
}

// Expired sign-in codes and dead sessions are rubbish - clear them on the timer
// so the auth tables do not grow forever.
export async function purgeExpiredAuth(env) {
  if (!env.CUSTOMER_DB) return { sessions: 0, codes: 0 };
  const cutoff = now();
  const [sessions, codes] = await env.CUSTOMER_DB.batch([
    env.CUSTOMER_DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(cutoff),
    // Keep a day of expired codes so the "3 codes per 10 minutes" limit still counts them.
    env.CUSTOMER_DB.prepare("DELETE FROM login_codes WHERE expires_at < ?1").bind(cutoff - 24 * 60 * 60 * 1000)
  ]);
  return {
    sessions: Number(sessions?.meta?.changes || 0),
    codes: Number(codes?.meta?.changes || 0)
  };
}

/* ---- Whole-database snapshot ----
   The customers, bookings, quotes and document records live in D1, so losing a
   phone never loses them. Losing the DATABASE would. Once a night the lot is
   dumped to R2 as one JSON file and yesterday's ones are kept for a month, so
   there is always something to rebuild from. Sign-in codes and live sessions are
   deliberately left out - they are secrets, and they are worthless a day later. */
const SNAPSHOT_SKIP = new Set([
  "_cf_KV", "d1_migrations", "sqlite_sequence", "sessions", "login_codes"
]);
const SNAPSHOT_PREFIX = "db-backups/";
const SNAPSHOT_KEEP_DAYS = 30;

export async function dumpDatabase(env) {
  if (!env.CUSTOMER_DB) throw new Error("No database bound");
  const tableRows = await env.CUSTOMER_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all();
  const tables = {};
  let rowCount = 0;
  for (const row of (tableRows.results || [])) {
    const name = String(row.name || "");
    if (!name || SNAPSHOT_SKIP.has(name) || name.startsWith("sqlite_")) continue;
    // Table names come from sqlite_master, not from a request, so they are safe
    // to interpolate - D1 cannot bind an identifier.
    const data = await env.CUSTOMER_DB.prepare(`SELECT * FROM "${name}"`).all();
    // Hashed invite/sync tokens are credential material - a downloaded file that
    // gets forwarded or left on a laptop shouldn't carry them. Nothing is rebuilt
    // from them anyway: invites expire, sync tokens are re-issued.
    tables[name] = (data.results || []).map(row => {
      const clean = {};
      for (const [column, value] of Object.entries(row)) {
        clean[column] = /(_hash|_secret)$/i.test(column) && value ? "[removed]" : value;
      }
      return clean;
    });
    rowCount += tables[name].length;
  }
  return { app: "naki-route-api", savedAt: now(), rowCount, tables };
}

export async function snapshotDatabase(env) {
  if (!env.DOCUMENTS) return { ok: false, reason: "No R2 bucket bound" };
  const dump = await dumpDatabase(env);
  const day = new Date(dump.savedAt).toISOString().slice(0, 10);
  const key = `${SNAPSHOT_PREFIX}${day}.json`;
  await env.DOCUMENTS.put(key, JSON.stringify(dump), {
    httpMetadata: { contentType: "application/json" }
  });
  // Drop anything older than a month so this never grows without limit.
  const cutoff = dump.savedAt - SNAPSHOT_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  let removed = 0;
  const listed = await env.DOCUMENTS.list({ prefix: SNAPSHOT_PREFIX, limit: 200 });
  for (const object of (listed.objects || [])) {
    const stamp = object.key.slice(SNAPSHOT_PREFIX.length, SNAPSHOT_PREFIX.length + 10);
    if (stamp && stamp < cutoffDay) { await env.DOCUMENTS.delete(object.key); removed++; }
  }
  return { ok: true, key, rowCount: dump.rowCount, tables: Object.keys(dump.tables).length, removed };
}

export async function retryPendingSheetBackups(env) {
  if (!env.CUSTOMER_DB) return { synced: 0 };
  const [website, jotform] = await Promise.all([
    env.CUSTOMER_DB.prepare(
      "SELECT *, 'bookings' AS backup_table FROM bookings WHERE sheet_sync_status = 'PENDING' AND sheet_sync_attempts < 20 ORDER BY created_at LIMIT 20"
    ).all(),
    env.CUSTOMER_DB.prepare(
      "SELECT *, 'jotform_bookings' AS backup_table FROM jotform_bookings WHERE sheet_sync_status = 'PENDING' AND sheet_sync_attempts < 20 ORDER BY created_at LIMIT 20"
    ).all()
  ]);
  const pending = [...(website.results || []), ...(jotform.results || [])]
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))
    .slice(0, 20);
  let synced = 0;
  for (const booking of pending) {
    try {
      await syncBookingToSheet(env, booking, booking.backup_table);
      synced++;
    } catch (error) {
      await markSheetFailure(env, booking.id, error, booking.backup_table);
    }
  }
  return { synced };
}

async function customerProfile(env, customerId) {
  return env.CUSTOMER_DB.prepare("SELECT * FROM customers WHERE id = ?1").bind(customerId).first();
}

async function customerAddresses(env, customerId) {
  const rows = await env.CUSTOMER_DB.prepare(
    "SELECT * FROM customer_addresses WHERE customer_id = ?1 ORDER BY is_default DESC, sort_order, created_at"
  ).bind(customerId).all();
  return (rows.results || []).map(addressFrom);
}

async function customerProfileResponse(env, customerId) {
  const [profile, addresses] = await Promise.all([
    customerProfile(env, customerId),
    customerAddresses(env, customerId)
  ]);
  return profileFrom(profile, addresses);
}

async function customerBookings(env, customerId) {
  const profile = await customerProfile(env, customerId);
  const [direct, pickupRun, jotform] = await Promise.all([
    env.CUSTOMER_DB.prepare(
      "SELECT * FROM bookings WHERE customer_id = ?1 ORDER BY created_at DESC LIMIT 50"
    ).bind(customerId).all(),
    env.CUSTOMER_DB.prepare(
      `SELECT id, status, first_name, last_name, phone, email, street_address, town, area,
        rural_option, items_json, additional_info, '' AS referral_source, '' AS referral_details,
        total_cents, quote_required, 'PICKUP_RUN' AS sheet_sync_status, 'PICKUP_RUN' AS booking_source,
        pickup_date, pickup_window, customer_note, cancellation_reason, cancelled_at, created_at
       FROM external_bookings
       WHERE customer_id = ?1 OR email = ?2 COLLATE NOCASE
       ORDER BY created_at DESC LIMIT 50`
    ).bind(customerId, profile?.email || "").all(),
    env.CUSTOMER_DB.prepare(
      `SELECT id, status, first_name, last_name, phone, email, street_address, town, area,
        rural_option, items_json, additional_info, referral_source, referral_details,
        total_cents, quote_required, sheet_sync_status, 'JOTFORM' AS booking_source,
        pickup_date, pickup_window, customer_note, cancellation_reason, cancelled_at, created_at
       FROM jotform_bookings
       WHERE customer_id = ?1 OR email = ?2 COLLATE NOCASE
       ORDER BY created_at DESC LIMIT 50`
    ).bind(customerId, profile?.email || "").all()
  ]);
  const seen = new Set();
  return [...(direct.results || []), ...(pickupRun.results || []), ...(jotform.results || [])]
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
    .filter(row => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    })
    .slice(0, 50)
    .map(bookingFrom);
}

function maskedEmail(address) {
  const [name, domain] = String(address || "").split("@");
  if (!name || !domain) return "";
  const shown = name.length <= 2 ? name[0] : name.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(2, Math.min(6, name.length - shown.length)))}@${domain}`;
}

async function profileInvite(env, rawToken) {
  const token = clean(rawToken, 120);
  if (token.length < 32) return null;
  return env.CUSTOMER_DB.prepare(
    "SELECT * FROM profile_invites WHERE token_hash = ?1 AND used_at IS NULL AND expires_at > ?2"
  ).bind(await hashToken(token), now()).first();
}

async function mergeInviteProfile(env, customerId, invite) {
  const ruralOption = Object.hasOwn(RURAL_PRICES, invite.rural_option || "") ? invite.rural_option : "";
  const referralSource = REFERRAL_OPTIONS.has(invite.referral_source || "") ? invite.referral_source : "";
  await env.CUSTOMER_DB.prepare(
    `UPDATE customers SET
      first_name = CASE WHEN first_name = '' THEN ?1 ELSE first_name END,
      last_name = CASE WHEN last_name = '' THEN ?2 ELSE last_name END,
      phone = CASE WHEN phone = '' THEN ?3 ELSE phone END,
      street_address = CASE WHEN street_address = '' THEN ?4 ELSE street_address END,
      town = CASE WHEN town = '' THEN ?5 ELSE town END,
      area = CASE WHEN area = '' THEN ?6 ELSE area END,
      rural_option = CASE WHEN rural_option = '' THEN ?7 ELSE rural_option END,
      referral_source = CASE WHEN referral_source = '' THEN ?8 ELSE referral_source END,
      referral_details = CASE WHEN referral_details = '' THEN ?9 ELSE referral_details END,
      access_notes = CASE WHEN access_notes = '' THEN ?10 ELSE access_notes END,
      updated_at = ?11
    WHERE id = ?12`
  ).bind(
    invite.first_name || "", invite.last_name || "", invite.phone || "", invite.street_address || "",
    invite.town || "", invite.area || "", ruralOption, referralSource, invite.referral_details || "",
    invite.access_notes || "", now(), customerId
  ).run();
}

function externalBookingFields(body, fallbackCreatedAt = now()) {
  const externalKey = clean(body.bookingKey, 180);
  const status = clean(body.bookingStatus, 30).toUpperCase();
  const items = Array.isArray(body.items)
    ? body.items.map(item => clean(item, 100)).filter(Boolean).slice(0, 10)
    : [];
  const rawTotal = Number(body.total);
  const created = Number(body.bookingCreatedAt);
  const createdAt = Number.isFinite(created) && created >= Date.UTC(2015, 0, 1) && created <= now() + 86400000
    ? Math.round(created)
    : fallbackCreatedAt;
  return {
    externalKey,
    status: OWNER_STATUSES.has(status) ? status : "ADDED_TO_RUN",
    firstName: clean(body.firstName, 60),
    lastName: clean(body.lastName, 60),
    phone: clean(body.phone, 30),
    address: email(body.email),
    streetAddress: clean(body.streetAddress, 180),
    town: clean(body.town, 100),
    area: clean(body.area, 100),
    ruralOption: clean(body.ruralOption, 120),
    itemsJson: JSON.stringify(items),
    additionalInfo: clean(body.accessNotes, 1000),
    totalCents: Number.isFinite(rawTotal) && rawTotal >= 0 && rawTotal <= 1000000 ? Math.round(rawTotal * 100) : 0,
    quoteRequired: body.quoteRequired ? 1 : 0,
    createdAt
  };
}

async function customerIdForEmail(env, address) {
  const customer = await env.CUSTOMER_DB.prepare(
    "SELECT id FROM customers WHERE email = ?1 COLLATE NOCASE"
  ).bind(address).first();
  return customer?.id || null;
}

async function bulkBookingTarget(env, recipient) {
  const bookingId = clean(recipient.bookingId, 180);
  const bookingKey = clean(recipient.bookingKey, 180);
  const address = email(recipient.email);
  const street = clean(recipient.streetAddress, 180);
  const exact = [];
  if (bookingId.startsWith("WEB-")) exact.push(["bookings", "WEBSITE", "id", bookingId]);
  if (bookingId.startsWith("JOTFORM-")) exact.push(["jotform_bookings", "JOTFORM", "id", bookingId]);
  if (bookingId.startsWith("PICKUP-")) exact.push(["external_bookings", "PICKUP_RUN", "id", bookingId]);
  if (/^\d{10,30}$/.test(bookingId)) exact.push(["jotform_bookings", "JOTFORM", "submission_id", bookingId]);
  if (bookingKey) exact.push(["external_bookings", "PICKUP_RUN", "external_key", bookingKey]);
  for (const [table, source, field, value] of exact) {
    const row = await env.CUSTOMER_DB.prepare(
      `SELECT * FROM ${table} WHERE ${field}=?1 AND status NOT IN ('COMPLETED','DECLINED','CANCELLED')`
    ).bind(value).first();
    if (row) return { table, source, row };
  }
  if (!EMAIL_RE.test(address)) return null;
  const candidates = [];
  for (const [table, source] of [
    ["bookings", "WEBSITE"],
    ["jotform_bookings", "JOTFORM"],
    ["external_bookings", "PICKUP_RUN"]
  ]) {
    const row = await env.CUSTOMER_DB.prepare(
      `SELECT * FROM ${table}
       WHERE email=?1 COLLATE NOCASE AND status NOT IN ('COMPLETED','DECLINED','CANCELLED')
         AND (?2='' OR street_address=?2 COLLATE NOCASE)
       ORDER BY created_at DESC LIMIT 1`
    ).bind(address, street).first();
    if (row) candidates.push({ table, source, row });
  }
  return candidates.sort((a, b) => Number(b.row.created_at || 0) - Number(a.row.created_at || 0))[0] || null;
}

async function upsertExternalBooking(env, fields, syncToken) {
  if (!fields.externalKey || !EMAIL_RE.test(fields.address)) return false;
  const updatedAt = now();
  const customerId = await customerIdForEmail(env, fields.address);
  const completedAt = fields.status === "COMPLETED" ? updatedAt : null;
  const exact = await env.CUSTOMER_DB.prepare(
    "SELECT id FROM external_bookings WHERE external_key = ?1"
  ).bind(fields.externalKey).first();
  if (!exact) {
    const recovered = await env.CUSTOMER_DB.prepare(
      `SELECT id FROM external_bookings
       WHERE external_key LIKE 'recovered:%' AND email = ?1 COLLATE NOCASE
         AND street_address = ?2 COLLATE NOCASE AND items_json = ?3 AND total_cents = ?4
       ORDER BY created_at DESC LIMIT 1`
    ).bind(fields.address, fields.streetAddress, fields.itemsJson, fields.totalCents).first();
    if (recovered) {
      await env.CUSTOMER_DB.prepare(
        "UPDATE external_bookings SET external_key = ?1 WHERE id = ?2"
      ).bind(fields.externalKey, recovered.id).run();
    }
  }
  await env.CUSTOMER_DB.prepare(
    `INSERT INTO external_bookings (
      id, external_key, sync_token_hash, customer_id, status, first_name, last_name, phone, email,
      street_address, town, area, rural_option, items_json, additional_info, total_cents,
      quote_required, created_at, updated_at, completed_at
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
    ON CONFLICT(external_key) DO UPDATE SET
      sync_token_hash=excluded.sync_token_hash,
      customer_id=COALESCE(external_bookings.customer_id, excluded.customer_id),
      status=excluded.status,
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      phone=excluded.phone,
      street_address=excluded.street_address,
      town=excluded.town,
      area=excluded.area,
      rural_option=excluded.rural_option,
      items_json=excluded.items_json,
      additional_info=excluded.additional_info,
      total_cents=excluded.total_cents,
      quote_required=excluded.quote_required,
      updated_at=excluded.updated_at,
      completed_at=excluded.completed_at
    WHERE external_bookings.email = excluded.email COLLATE NOCASE`
  ).bind(
    `PICKUP-${crypto.randomUUID()}`, fields.externalKey, await hashToken(syncToken), customerId,
    fields.status, fields.firstName, fields.lastName, fields.phone, fields.address,
    fields.streetAddress, fields.town, fields.area, fields.ruralOption, fields.itemsJson,
    fields.additionalInfo, fields.totalCents, fields.quoteRequired, fields.createdAt, updatedAt, completedAt
  ).run();
  return true;
}

const MAX_PHOTOS = 10;
// The browser shrinks each photo before upload; this is the backstop.
const MAX_PHOTO_CHARS = 900 * 1024;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const PHOTO_TTL_SECONDS = 60 * 60 * 24 * 400;

async function savePhotos(env, bookingId, photos) {
  if (!env.PHOTOS || !Array.isArray(photos)) return 0;
  let saved = 0;
  for (const raw of photos) {
    if (saved >= MAX_PHOTOS) break;
    const photo = String(raw && typeof raw === "object" ? raw.data : raw || "");
    const item = clean(raw && typeof raw === "object" ? raw.item : "", 80);
    if (!PHOTO_RE.test(photo) || photo.length > MAX_PHOTO_CHARS) continue;
    await env.PHOTOS.put(
      `photo:${bookingId}:${saved}`,
      JSON.stringify({ item, data: photo }),
      { expirationTtl: PHOTO_TTL_SECONDS }
    );
    saved++;
  }
  return saved;
}

async function readPhotoDetails(env, bookingId, count) {
  const total = Math.min(Number(count || 0), MAX_PHOTOS);
  if (!env.PHOTOS || total < 1) return [];
  const keys = Array.from({ length: total }, (_, index) => `photo:${bookingId}:${index}`);
  const values = await Promise.all(keys.map(key => env.PHOTOS.get(key)));
  return values.filter(Boolean).map(value => {
    if (PHOTO_RE.test(value)) return { item: "", data: value };
    try {
      const parsed = JSON.parse(value);
      return PHOTO_RE.test(parsed?.data || "") ? { item: clean(parsed.item, 80), data: parsed.data } : null;
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function readPhotos(env, bookingId, count) {
  return (await readPhotoDetails(env, bookingId, count)).map(photo => photo.data);
}

async function clearPhotos(env, bookingId, count) {
  const total = Math.min(Number(count || 0), MAX_PHOTOS);
  if (!env.PHOTOS || total < 1) return;
  await Promise.all(
    Array.from({ length: total }, (_, index) => env.PHOTOS.delete(`photo:${bookingId}:${index}`))
  );
}

async function latestBookingIdForEmail(env, address) {
  const row = await env.CUSTOMER_DB.prepare(
    `SELECT id FROM (
       SELECT id, created_at FROM bookings WHERE email = ?1 COLLATE NOCASE
       UNION ALL SELECT id, created_at FROM jotform_bookings WHERE email = ?1 COLLATE NOCASE
       UNION ALL SELECT id, created_at FROM external_bookings WHERE email = ?1 COLLATE NOCASE
     ) ORDER BY created_at DESC LIMIT 1`
  ).bind(address).first();
  return row?.id || "";
}

// The pickup-run app knows its own stable key, while the portal stores a separate
// PICKUP-* id. Resolve either form before saving a document so every PDF lands on
// the exact booking card it came from rather than merely the latest customer job.
async function bookingIdForDocument(env, rawId, address) {
  const candidate = clean(rawId, 180);
  if (candidate) {
    const row = await env.CUSTOMER_DB.prepare(
      `SELECT id FROM (
         SELECT id, email, '' AS external_key, '' AS submission_id FROM bookings
         UNION ALL SELECT id, email, '' AS external_key, submission_id FROM jotform_bookings
         UNION ALL SELECT id, email, external_key, '' AS submission_id FROM external_bookings
       ) WHERE email = ?1 COLLATE NOCASE
         AND (id = ?2 OR external_key = ?2 OR submission_id = ?2)
       LIMIT 1`
    ).bind(address, candidate).first();
    if (row?.id) return row.id;
  }
  return latestBookingIdForEmail(env, address);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Called after an invoice or receipt is emailed so the customer keeps a copy in
// their account instead of having to ask for it again. bookingId/items/address
// come straight from the same data the PDF was built from, so what lands in
// the account always matches what was actually sent - no re-deriving later.
export async function recordBookingDocument(env, { email: rawEmail, kind, amount, reference, bookingId, items, address, filename, pdfBase64 }) {
  if (!env.CUSTOMER_DB) return false;
  const emailAddress = email(rawEmail);
  const type = kind === "RECEIPT" ? "RECEIPT" : "INVOICE";
  if (!EMAIL_RE.test(emailAddress)) return false;
  const cents = Number.isFinite(Number(amount)) && Number(amount) >= 0 && Number(amount) <= 100000
    ? Math.round(Number(amount) * 100)
    : 0;
  const resolvedBookingId = await bookingIdForDocument(env, bookingId, emailAddress);
  const itemList = JSON.stringify(
    (Array.isArray(items) ? items : []).map(item => clean(item, 80)).filter(Boolean).slice(0, 20)
  );
  const id = crypto.randomUUID();
  let r2Key = "";
  if (env.DOCUMENTS && typeof pdfBase64 === "string" && /^[A-Za-z0-9+/=]+$/.test(pdfBase64) && pdfBase64.length > 100 && pdfBase64.length <= 2000000) {
    try {
      await env.DOCUMENTS.put(`doc:${id}.pdf`, base64ToBytes(pdfBase64), { httpMetadata: { contentType: "application/pdf" } });
      r2Key = `doc:${id}.pdf`;
    } catch { /* the email already went out - a storage hiccup shouldn't break that */ }
  }
  try {
    await env.CUSTOMER_DB.prepare(
      `INSERT INTO booking_documents (id, booking_id, email, kind, amount_cents, reference, created_at, items_json, address, filename, r2_key)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
    ).bind(
      id, resolvedBookingId, emailAddress, type, cents, clean(reference, 120), now(),
      itemList, clean(address, 300), clean(filename, 120), r2Key
    ).run();
    return true;
  } catch {
    return false;   // never let bookkeeping break an email that already went out
  }
}

function bookingDocumentFrom(row) {
  let items = [];
  try { items = JSON.parse(row.items_json || "[]"); } catch { items = []; }
  return {
    id: row.id,
    bookingId: row.booking_id || "",
    kind: row.kind,
    amount: Number(row.amount_cents || 0) / 100,
    reference: row.reference || "",
    items,
    address: row.address || "",
    filename: row.filename || "",
    hasPdf: Boolean(row.r2_key),
    createdAt: new Date(row.created_at).toISOString()
  };
}

async function customerDocuments(env, address) {
  if (!EMAIL_RE.test(address || "")) return [];
  const rows = await env.CUSTOMER_DB.prepare(
    "SELECT * FROM booking_documents WHERE email = ?1 COLLATE NOCASE ORDER BY created_at DESC LIMIT 50"
  ).bind(address).all();
  return (rows.results || []).map(bookingDocumentFrom);
}

export async function handlePortalRequest({ request, env, path, json, sendMail }) {
  if (!path.startsWith("/customer/") && !path.startsWith("/owner/") && path !== "/jotform/submission") return null;
  if (!env.CUSTOMER_DB) return json(request, { error: "Customer accounts are not ready yet" }, 503);

  if (path === "/jotform/submission" && request.method === "POST") {
    return handleJotformSubmission(request, env, json);
  }

  if (path === "/customer/profile-invite" && request.method === "POST") {
    // Only Woody can mint a private profile link, so nobody else can seed
    // details or pickup history against a customer's email address.
    if (!await sessionFor(request, env, "owner")) return json(request, { error: "Owner login required" }, 401);
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const address = email(body.email);
    if (!EMAIL_RE.test(address)) return json(request, { error: "A valid customer email is needed" }, 400);
    const existingCustomer = await env.CUSTOMER_DB.prepare(
      "SELECT id FROM customers WHERE email = ?1 COLLATE NOCASE"
    ).bind(address).first();
    if (existingCustomer) {
      const bookingSyncToken = randomToken();
      const bookingLinked = await upsertExternalBooking(
        env,
        externalBookingFields(body, now()),
        bookingSyncToken
      );
      return json(request, {
        ok: true,
        url: CUSTOMER_ACCOUNT_URL,
        hasProfile: true,
        bookingSyncToken: bookingLinked ? bookingSyncToken : ""
      });
    }
    const token = randomToken();
    const bookingSyncToken = randomToken();
    const createdAt = now();
    const ruralOption = clean(body.ruralOption, 120);
    const referralSource = clean(body.referralSource, 40);
    const bookingFields = externalBookingFields(body, createdAt);
    await env.CUSTOMER_DB.batch([
      env.CUSTOMER_DB.prepare(
        `INSERT INTO profile_invites (
          token_hash, email, first_name, last_name, phone, street_address, town, area,
          rural_option, referral_source, referral_details, access_notes, expires_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
      ).bind(
        await hashToken(token), address, clean(body.firstName, 60), clean(body.lastName, 60),
        clean(body.phone, 30), clean(body.streetAddress, 180), clean(body.town, 100),
        clean(body.area, 100), Object.hasOwn(RURAL_PRICES, ruralOption) ? ruralOption : "",
        REFERRAL_OPTIONS.has(referralSource) ? referralSource : "", clean(body.referralDetails, 160),
        clean(body.accessNotes, 1000), createdAt + PROFILE_INVITE_TTL_MS, createdAt
      ),
      env.CUSTOMER_DB.prepare(
        "DELETE FROM profile_invites WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?2)"
      ).bind(createdAt, createdAt - 30 * 24 * 60 * 60 * 1000)
    ]);
    const bookingLinked = await upsertExternalBooking(env, bookingFields, bookingSyncToken);
    return json(request, {
      ok: true,
      url: `${CUSTOMER_ACCOUNT_URL}?invite=${encodeURIComponent(token)}`,
      hasProfile: false,
      bookingSyncToken: bookingLinked ? bookingSyncToken : ""
    }, 201);
  }

  if (path === "/customer/external-booking/sync" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const syncToken = clean(body.syncToken, 120);
    const fields = externalBookingFields(body);
    if (syncToken.length < 32 || !fields.externalKey || !EMAIL_RE.test(fields.address)) {
      return json(request, { error: "This booking link is not valid" }, 400);
    }
    const existing = await env.CUSTOMER_DB.prepare(
      "SELECT id, email FROM external_bookings WHERE external_key = ?1 AND sync_token_hash = ?2"
    ).bind(fields.externalKey, await hashToken(syncToken)).first();
    if (!existing || email(existing.email) !== fields.address) {
      return json(request, { error: "This booking link has expired" }, 401);
    }
    const customerId = await customerIdForEmail(env, fields.address);
    const updatedAt = now();
    await env.CUSTOMER_DB.prepare(
      `UPDATE external_bookings SET
        customer_id=COALESCE(customer_id, ?1),
        status=CASE
          WHEN status IN ('CANCELLED','DECLINED','COMPLETED') THEN status
          WHEN status='CONFIRMED' AND ?2='ADDED_TO_RUN' THEN status
          ELSE ?2
        END,
        first_name=?3, last_name=?4, phone=?5,
        street_address=?6, town=?7, area=?8, rural_option=?9, items_json=?10,
        additional_info=?11, total_cents=?12, quote_required=?13, updated_at=?14,
        completed_at=CASE
          WHEN status IN ('CANCELLED','DECLINED') THEN completed_at
          WHEN status='COMPLETED' THEN COALESCE(completed_at, ?14)
          WHEN ?2='COMPLETED' THEN ?14
          ELSE NULL
        END
       WHERE id=?15`
    ).bind(
      customerId, fields.status, fields.firstName, fields.lastName, fields.phone,
      fields.streetAddress, fields.town, fields.area, fields.ruralOption, fields.itemsJson,
      fields.additionalInfo, fields.totalCents, fields.quoteRequired, updatedAt, existing.id
    ).run();
    return json(request, { ok: true });
  }

  if (path === "/customer/profile-invite" && request.method === "GET") {
    const invite = await profileInvite(env, new URL(request.url).searchParams.get("token"));
    if (!invite) return json(request, { error: "This private link has expired or was already used" }, 410);
    return json(request, { ok: true, maskedEmail: maskedEmail(invite.email) });
  }

  if (path === "/customer/profile-invite/request-code" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const invite = await profileInvite(env, body.token);
    if (!invite) return json(request, { error: "This private link has expired or was already used" }, 410);
    await sendCode(env, sendMail, invite.email, "customer");
    return json(request, { ok: true, message: "Check your email for the 6-digit code." });
  }

  if (path === "/customer/profile-invite/verify-code" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const code = clean(body.code, 6);
    if (!/^\d{6}$/.test(code)) return json(request, { error: "Enter the 6-digit code" }, 400);
    const invite = await profileInvite(env, body.token);
    if (!invite) return json(request, { error: "This private link has expired or was already used" }, 410);
    const verified = await verifyCode(env, invite.email, "customer", code);
    if (!verified) return json(request, { error: "That code is incorrect or has expired" }, 401);
    await mergeInviteProfile(env, verified.customerId, invite);
    await env.CUSTOMER_DB.batch([
      env.CUSTOMER_DB.prepare(
        "UPDATE profile_invites SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL"
      ).bind(now(), invite.token_hash),
      env.CUSTOMER_DB.prepare(
        "UPDATE external_bookings SET customer_id = ?1 WHERE email = ?2 COLLATE NOCASE AND customer_id IS NULL"
      ).bind(verified.customerId, invite.email),
      env.CUSTOMER_DB.prepare(
        "UPDATE jotform_bookings SET customer_id = ?1 WHERE email = ?2 COLLATE NOCASE AND customer_id IS NULL"
      ).bind(verified.customerId, invite.email)
    ]);
    const profile = await customerProfile(env, verified.customerId);
    if (verified.customerCreated) await notifyOwnerOfNewCustomer(env, sendMail, profile, "private-link");
    return json(request, {
      token: verified.token,
      profile: await customerProfileResponse(env, verified.customerId),
      bookings: await customerBookings(env, verified.customerId),
      documents: await customerDocuments(env, invite.email),
      prefilled: true
    });
  }

  if (path === "/customer/request-code" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const address = email(body.email);
    if (!EMAIL_RE.test(address)) return json(request, { error: "Enter a valid email address" }, 400);
    await sendCode(env, sendMail, address, "customer");
    return json(request, { ok: true, message: "Check your email for the 6-digit code." });
  }

  if (path === "/customer/verify-code" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const address = email(body.email);
    const code = clean(body.code, 6);
    if (!EMAIL_RE.test(address) || !/^\d{6}$/.test(code)) return json(request, { error: "Enter the 6-digit code" }, 400);
    const verified = await verifyCode(env, address, "customer", code);
    if (!verified) return json(request, { error: "That code is incorrect or has expired" }, 401);
    await env.CUSTOMER_DB.prepare(
      "UPDATE external_bookings SET customer_id = ?1 WHERE email = ?2 COLLATE NOCASE AND customer_id IS NULL"
    ).bind(verified.customerId, address).run();
    await env.CUSTOMER_DB.prepare(
      "UPDATE jotform_bookings SET customer_id = ?1 WHERE email = ?2 COLLATE NOCASE AND customer_id IS NULL"
    ).bind(verified.customerId, address).run();
    const profile = await customerProfile(env, verified.customerId);
    if (verified.customerCreated) await notifyOwnerOfNewCustomer(env, sendMail, profile, "website");
    return json(request, {
      token: verified.token,
      profile: await customerProfileResponse(env, verified.customerId),
      bookings: await customerBookings(env, verified.customerId),
      documents: await customerDocuments(env, address)
    });
  }

  if (path === "/owner/request-code" && request.method === "POST") {
    await sendCode(env, sendMail, OWNER_EMAIL, "owner");
    return json(request, { ok: true, message: "A login code was sent to the Naki business email." });
  }

  if (path === "/owner/verify-code" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const code = clean(body.code, 6);
    if (!/^\d{6}$/.test(code)) return json(request, { error: "Enter the 6-digit code" }, 400);
    const verified = await verifyCode(env, OWNER_EMAIL, "owner", code);
    if (!verified) return json(request, { error: "That code is incorrect or has expired" }, 401);
    return json(request, { token: verified.token });
  }

  if (path === "/customer/arcade/stats" && request.method === "GET") {
    const stamp = now();
    const [members, online] = await Promise.all([
      env.CUSTOMER_DB.prepare("SELECT COUNT(*) AS total FROM customers").first(),
      env.CUSTOMER_DB.prepare(
        "SELECT COUNT(*) AS total FROM arcade_presence WHERE last_seen > ?1"
      ).bind(stamp - ARCADE_ONLINE_MS).first()
    ]);
    return json(request, {
      members: Number(members?.total || 0),
      online: Number(online?.total || 0)
    }, 200, "public, max-age=30");
  }

  if (path.startsWith("/customer/")) {
    const session = await sessionFor(request, env, "customer");
    if (!session) return json(request, { error: "Please sign in again" }, 401);

    if (path === "/customer/me" && request.method === "GET") {
      const profile = await customerProfile(env, session.customer_id);
      const [bookings, documents] = await Promise.all([
        customerBookings(env, session.customer_id),
        customerDocuments(env, profile?.email || session.email)
      ]);
      return json(request, {
        profile: await customerProfileResponse(env, session.customer_id),
        bookings,
        documents
      });
    }

    // ---------- Naki Arcade ----------
    // Scores live server-side so the leaderboard is shared. Only a first name
    // (or the nickname they chose) ever leaves here - never a surname, email,
    // phone or address.
    if (path === "/customer/arcade" && request.method === "GET") {
      // The boards are per month so the prize is winnable by someone who only
      // joined last week. Personal bests stay all-time - that's the number a
      // player wants to see creep up, and resetting it monthly would feel mean.
      const day = aucklandDay();
      const week = aucklandWeek();
      const month = aucklandMonth();
      const last = previousMonth(month);
      // Same shape for all four periods: newest run wins ties, top 20 per game.
      const periodBoard = (table, column) => `SELECT s.game, s.best_score, s.customer_id,
                  COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(c.first_name), ''), 'Player') AS display_name
             FROM ${table} s JOIN customers c ON c.id = s.customer_id
            WHERE s.${column} = ?1 AND s.best_score > 0
            ORDER BY s.game, s.best_score DESC, s.updated_at`;
      const overallBoard = `SELECT s.game, s.best_score, s.customer_id,
                  COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(c.first_name), ''), 'Player') AS display_name
             FROM game_scores s JOIN customers c ON c.id = s.customer_id
            WHERE s.best_score > 0
            ORDER BY s.game, s.best_score DESC, s.updated_at`;
      const monthlyBoard = periodBoard("game_scores_monthly", "month");
      const [mine, dayRows, weekRows, monthRows, overallRows, lastBoards, me] = await Promise.all([
        env.CUSTOMER_DB.prepare(
          "SELECT game, best_score FROM game_scores WHERE customer_id = ?1"
        ).bind(session.customer_id).all(),
        env.CUSTOMER_DB.prepare(periodBoard("game_scores_daily", "day")).bind(day).all(),
        env.CUSTOMER_DB.prepare(periodBoard("game_scores_weekly", "week")).bind(week).all(),
        env.CUSTOMER_DB.prepare(monthlyBoard).bind(month).all(),
        env.CUSTOMER_DB.prepare(overallBoard).all(),
        env.CUSTOMER_DB.prepare(monthlyBoard).bind(last).all(),
        customerProfile(env, session.customer_id)
      ]);
      const scores = {};
      (mine.results || []).forEach(row => { scores[row.game] = Number(row.best_score || 0); });
      const buildBoard = rows => {
        const board = {};
        (rows || []).forEach(row => {
          const list = board[row.game] = board[row.game] || [];
          if (list.length >= 20) return;                     // top 20 per game
          list.push({
            name: row.display_name,
            score: Number(row.best_score || 0),
            isMe: row.customer_id === session.customer_id
          });
        });
        return board;
      };
      const leaderboards = {
        day: buildBoard(dayRows.results),
        week: buildBoard(weekRows.results),
        month: buildBoard(monthRows.results),
        overall: buildBoard(overallRows.results)
      };
      // Last month's champion per game. The rows are already sorted, so the
      // first one seen for a game is the winner.
      const winners = [];
      const claimed = new Set();
      (lastBoards.results || []).forEach(row => {
        if (claimed.has(row.game)) return;
        claimed.add(row.game);
        winners.push({
          game: row.game,
          name: row.display_name,
          score: Number(row.best_score || 0),
          isMe: row.customer_id === session.customer_id
        });
      });
      return json(request, {
        nickname: me?.nickname || "",
        firstName: me?.first_name || "",
        scores,
        leaderboards,
        month,
        monthName: monthLabel(month),
        prize: ARCADE_PRIZE,
        lastMonth: { month: last, monthName: monthLabel(last), winners }
      });
    }

    if (path === "/customer/arcade/nickname" && request.method === "PUT") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      // Letters, numbers, spaces, dash and underscore only - keeps the board tidy
      // and stops anyone smuggling markup into another player's screen.
      const nickname = clean(body.nickname, 20).replace(/[^A-Za-z0-9 _-]/g, "").trim();
      if (nickname && nickname.length < 2) {
        return json(request, { error: "Nicknames need at least 2 characters" }, 400);
      }
      await env.CUSTOMER_DB.prepare("UPDATE customers SET nickname = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(nickname, now(), session.customer_id).run();
      return json(request, { ok: true, nickname });
    }

    /* ---- Arcade friends and play-now invites ----
       Only public arcade names and opaque account ids are returned. Contact
       details never leave the account system. */
    if (path === "/customer/arcade/friends" && request.method === "GET") {
      const me = session.customer_id;
      const stamp = now();
      const personSql = `
        SELECT c.id, c.nickname, c.first_name, f.status, f.requested_by, f.updated_at,
               p.activity, p.last_seen,
               (SELECT COUNT(*) FROM arcade_direct_messages dm
                 WHERE dm.sender_id = c.id AND dm.recipient_id = ?1
                   AND dm.read_at IS NULL AND dm.hidden_by_recipient = 0) AS unread_count
          FROM arcade_friendships f
          JOIN customers c ON c.id = CASE WHEN f.user_low = ?1 THEN f.user_high ELSE f.user_low END
          LEFT JOIN arcade_presence p ON p.customer_id = c.id
         WHERE (f.user_low = ?1 OR f.user_high = ?1)`;
      const [rows, inviteRows] = await Promise.all([
        env.CUSTOMER_DB.prepare(personSql + " ORDER BY f.updated_at DESC").bind(me).all(),
        env.CUSTOMER_DB.prepare(
          `SELECT i.id, i.game, i.room, i.created_at, i.expires_at, c.id AS sender_id,
                  c.nickname, c.first_name
             FROM arcade_lobby_invites i JOIN customers c ON c.id = i.sender_id
            WHERE i.recipient_id = ?1 AND i.expires_at > ?2
            ORDER BY i.created_at DESC LIMIT 20`
        ).bind(me, stamp).all()
      ]);
      const friends = [], incoming = [], outgoing = [];
      (rows.results || []).forEach(row => {
        if (!arcadeContactAllowed(me, row.id)) return;
        const online = Number(row.last_seen || 0) > stamp - ARCADE_ONLINE_MS;
        const item = {
          id: row.id,
          name: arcadeDisplayName(row),
          online,
          activity: online ? clean(row.activity, 20) : "",
          canMessage: directChatAllowed(me, row.id),
          unread: Number(row.unread_count || 0)
        };
        if (row.status === "accepted") friends.push(item);
        else if (row.requested_by === me) outgoing.push(item);
        else incoming.push(item);
      });
      friends.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
      const invites = (inviteRows.results || [])
        .filter(row => arcadeContactAllowed(me, row.sender_id))
        .map(row => ({
        id: row.id,
        fromId: row.sender_id,
        from: arcadeDisplayName(row),
        game: row.game === "squad" ? "squad" : "wio",
        room: row.room,
        at: Number(row.created_at || 0),
        expiresAt: Number(row.expires_at || 0)
      }));
      return json(request, {
        friends,
        incoming,
        outgoing,
        invites,
        restricted: CHAT_RESTRICTED_VIEWERS.has(me)
      });
    }

    if (path === "/customer/arcade/presence" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* default to the arcade menu */ }
      const requested = clean(body.activity, 20).toLowerCase();
      const activity = requested === "menu" || ARCADE_GAMES.has(requested) ? requested : "menu";
      const stamp = now();
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          `INSERT INTO arcade_presence (customer_id, activity, last_seen)
           VALUES (?1, ?2, ?3)
           ON CONFLICT(customer_id) DO UPDATE SET
             activity = excluded.activity,
             last_seen = excluded.last_seen`
        ).bind(session.customer_id, activity, stamp),
        env.CUSTOMER_DB.prepare(
          "DELETE FROM arcade_presence WHERE last_seen < ?1"
        ).bind(stamp - 7 * 24 * 60 * 60 * 1000)
      ]);
      return json(request, { ok: true, activity });
    }

    if (path === "/customer/arcade/friends/search" && request.method === "GET") {
      const q = clean(new URL(request.url).searchParams.get("q"), 20)
        .replace(/[^A-Za-z0-9 _-]/g, "").trim();
      if (q.length < 2) return json(request, { results: [] });
      const [people, linked] = await Promise.all([
        env.CUSTOMER_DB.prepare(
        `SELECT c.id, c.nickname, c.first_name
           FROM customers c
          WHERE c.id <> ?1
            AND LOWER(COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(c.first_name), '')))
                LIKE LOWER(?2)
          ORDER BY CASE WHEN LOWER(COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(c.first_name), '')))
                              = LOWER(?3) THEN 0 ELSE 1 END,
                   COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(c.first_name), ''))
          LIMIT ?4`
        ).bind(session.customer_id, `${q}%`, q, FRIEND_SEARCH_LIMIT).all(),
        env.CUSTOMER_DB.prepare(
          `SELECT CASE WHEN user_low = ?1 THEN user_high ELSE user_low END AS customer_id
             FROM arcade_friendships
            WHERE user_low = ?1 OR user_high = ?1`
        ).bind(session.customer_id).all()
      ]);
      const alreadyLinked = new Set((linked.results || []).map(row => row.customer_id));
      return json(request, {
        results: (people.results || [])
          .filter(row => !alreadyLinked.has(row.id))
          .filter(row => arcadeContactAllowed(session.customer_id, row.id))
          .map(row => ({ id: row.id, name: arcadeDisplayName(row) }))
      });
    }

    if (path === "/customer/arcade/friends/request" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const target = clean(body.customerId, 80);
      const me = session.customer_id;
      if (!target || target === me) return json(request, { error: "Choose another player" }, 400);
      if (!arcadeContactAllowed(me, target)) {
        return json(request, { error: "That player is not available for your Arcade account" }, 403);
      }
      const [sender, person] = await Promise.all([
        env.CUSTOMER_DB.prepare("SELECT id, email, nickname, first_name FROM customers WHERE id = ?1").bind(me).first(),
        env.CUSTOMER_DB.prepare("SELECT id, email, nickname, first_name FROM customers WHERE id = ?1").bind(target).first()
      ]);
      if (!person) return json(request, { error: "That player could not be found" }, 404);
      if (!sender) return json(request, { error: "Please sign in again" }, 401);
      return json(request, { ok: true, ...await createArcadeFriendRequest(env, sendMail, sender, person) });
    }

    if (path === "/customer/arcade/friends/request-email" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const address = email(body.email);
      if (!EMAIL_RE.test(address)) return json(request, { error: "Enter a valid email address" }, 400);
      const [sender, person] = await Promise.all([
        env.CUSTOMER_DB.prepare("SELECT id, email, nickname, first_name FROM customers WHERE id = ?1").bind(session.customer_id).first(),
        env.CUSTOMER_DB.prepare("SELECT id, email, nickname, first_name FROM customers WHERE email = ?1 COLLATE NOCASE").bind(address).first()
      ]);
      if (!sender) return json(request, { error: "Please sign in again" }, 401);
      if (person && person.id === sender.id) return json(request, { error: "Choose another player" }, 400);
      // Do not reveal whether an email address has a Naki account.
      if (!person) return json(request, { ok: true, pending: false, emailSent: false });
      if (!arcadeContactAllowed(sender.id, person.id)) {
        return json(request, { ok: true, pending: false, emailSent: false });
      }
      return json(request, { ok: true, ...await createArcadeFriendRequest(env, sendMail, sender, person) });
    }

    if (path === "/customer/arcade/friends/respond" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const requester = clean(body.customerId, 80);
      const me = session.customer_id;
      if (!arcadeContactAllowed(me, requester)) {
        return json(request, { error: "That friend request is not available for your Arcade account" }, 403);
      }
      const [low, high] = friendPair(me, requester);
      const existing = await env.CUSTOMER_DB.prepare(
        `SELECT status, requested_by FROM arcade_friendships
          WHERE user_low = ?1 AND user_high = ?2`
      ).bind(low, high).first();
      if (!existing || existing.status !== "pending" || existing.requested_by !== requester) {
        return json(request, { error: "That friend request is no longer waiting" }, 404);
      }
      if (body.accept === true) {
        await env.CUSTOMER_DB.prepare(
          "UPDATE arcade_friendships SET status = 'accepted', updated_at = ?3 WHERE user_low = ?1 AND user_high = ?2"
        ).bind(low, high, now()).run();
      } else {
        await env.CUSTOMER_DB.prepare(
          "DELETE FROM arcade_friendships WHERE user_low = ?1 AND user_high = ?2"
        ).bind(low, high).run();
      }
      return json(request, { ok: true });
    }

    const friendDelete = path.match(/^\/customer\/arcade\/friends\/([^/]+)$/);
    if (friendDelete && request.method === "DELETE") {
      const other = decodeURIComponent(friendDelete[1]);
      const [low, high] = friendPair(session.customer_id, other);
      await env.CUSTOMER_DB.prepare(
        "DELETE FROM arcade_friendships WHERE user_low = ?1 AND user_high = ?2"
      ).bind(low, high).run();
      return json(request, { ok: true });
    }

    if (path === "/customer/arcade/invites" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const recipient = clean(body.customerId, 80);
      const game = clean(body.game || "wio", 20).toLowerCase();
      const inApp = body.inApp === true;
      if (game !== "wio" && game !== "squad") {
        return json(request, { error: "Choose a multiplayer game" }, 400);
      }
      const requestedRoom = clean(body.room, 24);
      const room = game === "squad"
        ? (requestedRoom.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5)
            || randomToken(5).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5))
        : (requestedRoom.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24)
            || randomToken(12).toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24));
      if (!room) return json(request, { error: "Could not make a game room. Please try again." }, 500);
      if (!recipient) return json(request, { error: "Choose a friend" }, 400);
      const me = session.customer_id;
      if (!arcadeContactAllowed(me, recipient)) {
        return json(request, { error: "You can only invite approved Arcade contacts" }, 403);
      }
      const [low, high] = friendPair(me, recipient);
      const friendship = await env.CUSTOMER_DB.prepare(
        `SELECT status FROM arcade_friendships
          WHERE user_low = ?1 AND user_high = ?2`
      ).bind(low, high).first();
      if (friendship?.status !== "accepted") {
        return json(request, { error: "You can only invite accepted friends" }, 403);
      }
      const [sender, person] = await Promise.all([
        env.CUSTOMER_DB.prepare("SELECT id, nickname, first_name FROM customers WHERE id = ?1").bind(me).first(),
        env.CUSTOMER_DB.prepare("SELECT id, email, nickname, first_name FROM customers WHERE id = ?1").bind(recipient).first()
      ]);
      if (!sender || !person) return json(request, { error: "That friend could not be found" }, 404);
      const stamp = now();
      if (!inApp) {
      const inviteHistory = await env.CUSTOMER_DB.prepare(
        `SELECT MAX(created_at) AS last_sent,
                SUM(CASE WHEN created_at > ?2 THEN 1 ELSE 0 END) AS sent_today
           FROM arcade_invite_sends
          WHERE sender_id = ?1`
      ).bind(me, stamp - ARCADE_INVITE_DAY_MS).first();
      const lastSent = Number(inviteHistory?.last_sent || 0);
      const sentToday = Number(inviteHistory?.sent_today || 0);
      if (lastSent > stamp - ARCADE_INVITE_COOLDOWN_MS) {
        const seconds = Math.max(1, Math.ceil((lastSent + ARCADE_INVITE_COOLDOWN_MS - stamp) / 1000));
        return json(request, { error: `Please wait ${seconds}s before sending another invite` }, 429);
      }
      if (sentToday >= ARCADE_INVITE_MAX_PER_DAY) {
        return json(request, { error: "You have reached today’s limit of 10 Arcade invites" }, 429);
      }
      }
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          "DELETE FROM arcade_lobby_invites WHERE expires_at <= ?1 OR (sender_id = ?2 AND recipient_id = ?3)"
        ).bind(stamp, me, recipient),
        env.CUSTOMER_DB.prepare(
          `INSERT INTO arcade_lobby_invites
            (id, sender_id, recipient_id, game, room, created_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        ).bind(randomToken(12), me, recipient, game, room, stamp, stamp + LOBBY_INVITE_TTL_MS)
        ,
        ...(inApp ? [] : [env.CUSTOMER_DB.prepare(
          `INSERT INTO arcade_invite_sends (id, sender_id, recipient_id, created_at)
           VALUES (?1, ?2, ?3, ?4)`
        ).bind(randomToken(12), me, recipient, stamp)])
      ]);
      if (inApp) return json(request, { ok: true, game, room, emailSent: false });
      const emailSent = await sendMail(env, {
        to: person.email,
        name: arcadeDisplayName(person),
        subject: "Come play in Naki Arcade",
        text: arcadePlayInviteEmail(sender)
      }).catch(() => false);
      return json(request, { ok: true, game, room, emailSent });
    }

    // The sender cancelling, not the recipient dismissing - used when someone invites
    // friends to a squad/IO lobby then leaves before anyone joins, so the invite left
    // behind doesn't point a friend at a room nobody is in.
    const inviteCancelRoom = path.match(/^\/customer\/arcade\/invites\/room\/([^/]+)$/);
    if (inviteCancelRoom && request.method === "DELETE") {
      const room = clean(decodeURIComponent(inviteCancelRoom[1]), 24);
      if (room) {
        await env.CUSTOMER_DB.prepare(
          "DELETE FROM arcade_lobby_invites WHERE sender_id = ?1 AND room = ?2"
        ).bind(session.customer_id, room).run();
      }
      return json(request, { ok: true });
    }

    const inviteDelete = path.match(/^\/customer\/arcade\/invites\/([^/]+)$/);
    if (inviteDelete && request.method === "DELETE") {
      await env.CUSTOMER_DB.prepare(
        "DELETE FROM arcade_lobby_invites WHERE id = ?1 AND recipient_id = ?2"
      ).bind(decodeURIComponent(inviteDelete[1]), session.customer_id).run();
      return json(request, { ok: true });
    }

    if (path === "/customer/arcade/score" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const game = clean(body.game, 20).toLowerCase();
      if (!ARCADE_GAMES.has(game)) return json(request, { error: "Unknown game" }, 400);
      const raw = Number(body.score);
      if (!Number.isFinite(raw) || raw < 0) return json(request, { error: "Invalid score" }, 400);
      // Cap what a single run can claim, so a fiddled request can't park an
      // unbeatable number at the top of the board forever.
      const score = Math.min(Math.floor(raw), 1000000);
      const stamp = now();
      const day = aucklandDay();
      const week = aucklandWeek();
      const month = aucklandMonth();
      // All four boards move together: the all-time personal best, and the
      // daily/weekly/monthly rows each period's leaderboard is read from.
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          `INSERT INTO game_scores (customer_id, game, best_score, played_count, created_at, updated_at)
           VALUES (?1, ?2, ?3, 1, ?4, ?4)
           ON CONFLICT(customer_id, game) DO UPDATE SET
             played_count = played_count + 1,
             best_score = MAX(best_score, excluded.best_score),
             updated_at = CASE WHEN excluded.best_score > best_score THEN ?4 ELSE updated_at END`
        ).bind(session.customer_id, game, score, stamp),
        env.CUSTOMER_DB.prepare(
          `INSERT INTO game_scores_daily (customer_id, game, day, best_score, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)
           ON CONFLICT(customer_id, game, day) DO UPDATE SET
             best_score = MAX(best_score, excluded.best_score),
             updated_at = CASE WHEN excluded.best_score > best_score THEN ?5 ELSE updated_at END`
        ).bind(session.customer_id, game, day, score, stamp),
        env.CUSTOMER_DB.prepare(
          `INSERT INTO game_scores_weekly (customer_id, game, week, best_score, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)
           ON CONFLICT(customer_id, game, week) DO UPDATE SET
             best_score = MAX(best_score, excluded.best_score),
             updated_at = CASE WHEN excluded.best_score > best_score THEN ?5 ELSE updated_at END`
        ).bind(session.customer_id, game, week, score, stamp),
        env.CUSTOMER_DB.prepare(
          `INSERT INTO game_scores_monthly (customer_id, game, month, best_score, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?5)
           ON CONFLICT(customer_id, game, month) DO UPDATE SET
             best_score = MAX(best_score, excluded.best_score),
             updated_at = CASE WHEN excluded.best_score > best_score THEN ?5 ELSE updated_at END`
        ).bind(session.customer_id, game, month, score, stamp)
      ]);
      const row = await env.CUSTOMER_DB.prepare(
        "SELECT best_score FROM game_scores WHERE customer_id = ?1 AND game = ?2"
      ).bind(session.customer_id, game).first();
      return json(request, { ok: true, best: Number(row?.best_score || 0) });
    }

    /* ---- Arcade chat ----
       Signed-in customers only, so every line has a real account behind it.
       Only the display name is ever returned - the same rule as the boards.
       Woody signs in with the owner address and gets a delete on every message,
       which is the part that actually handles anything the filter misses. */
    const chatOwner = String(session.email || "").toLowerCase() === OWNER_EMAIL;

    if (path === "/customer/arcade/chat/unread" && request.method === "GET") {
      const restrictedChat = CHAT_RESTRICTED_VIEWERS.has(session.customer_id);
      const stamp = now();
      const read = await env.CUSTOMER_DB.prepare(
        "SELECT public_read_at FROM arcade_chat_reads WHERE customer_id = ?1"
      ).bind(session.customer_id).first();
      let publicUnread = 0;
      if (!read) {
        await env.CUSTOMER_DB.prepare(
          "INSERT INTO arcade_chat_reads (customer_id, public_read_at) VALUES (?1, ?2)"
        ).bind(session.customer_id, stamp).run();
      } else {
        const allowed = restrictedChat ? [session.customer_id, ...CHAT_TRUSTED_AUTHORS] : [];
        const allowedSql = restrictedChat
          ? ` AND customer_id IN (${allowed.map((_, index) => `?${index + 3}`).join(", ")})`
          : "";
        const statement = env.CUSTOMER_DB.prepare(
          `SELECT COUNT(*) AS unread FROM arcade_messages
            WHERE hidden = 0 AND created_at > ?1 AND customer_id <> ?2${allowedSql}`);
        const row = restrictedChat
          ? await statement.bind(Number(read.public_read_at || 0), session.customer_id, ...allowed).first()
          : await statement.bind(Number(read.public_read_at || 0), session.customer_id).first();
        publicUnread = Number(row?.unread || 0);
      }
      const directAllowed = restrictedChat ? CHAT_TRUSTED_AUTHORS : [];
      const directAllowedSql = restrictedChat
        ? ` AND sender_id IN (${directAllowed.map((_, index) => `?${index + 2}`).join(", ")})`
        : "";
      const directStatement = env.CUSTOMER_DB.prepare(
        `SELECT COUNT(*) AS unread FROM arcade_direct_messages
          WHERE recipient_id = ?1 AND read_at IS NULL AND hidden_by_recipient = 0${directAllowedSql}`
      );
      const direct = restrictedChat
        ? await directStatement.bind(session.customer_id, ...directAllowed).first()
        : await directStatement.bind(session.customer_id).first();
      const directUnread = Number(direct?.unread || 0);
      return json(request, {
        publicUnread,
        directUnread,
        total: publicUnread + directUnread
      });
    }

    if (path === "/customer/arcade/chat" && request.method === "GET") {
      const restrictedChat = CHAT_RESTRICTED_VIEWERS.has(session.customer_id);
      const allowed = restrictedChat ? [session.customer_id, ...CHAT_TRUSTED_AUTHORS] : [];
      const allowedSql = restrictedChat
        ? ` AND m.customer_id IN (${allowed.map((_, index) => `?${index + 2}`).join(", ")})`
        : "";
      const replyAllowedSql = restrictedChat
        ? ` AND rm.customer_id IN (${allowed.map((_, index) => `?${index + 2}`).join(", ")})`
        : "";
      const limitParam = restrictedChat ? allowed.length + 2 : 2;
      const statement = env.CUSTOMER_DB.prepare(
        `SELECT m.id, m.body, m.created_at, m.customer_id, m.reply_to,
                 COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(c.first_name), ''), 'Player') AS display_name,
                 CASE WHEN rm.hidden = 0${replyAllowedSql} THEN rm.body ELSE NULL END AS reply_body,
                 CASE WHEN rm.hidden = 0${replyAllowedSql}
                      THEN COALESCE(NULLIF(TRIM(rc.nickname), ''), NULLIF(TRIM(rc.first_name), ''), 'Player')
                      ELSE NULL END AS reply_name
            FROM arcade_messages m JOIN customers c ON c.id = m.customer_id
            LEFT JOIN arcade_messages rm ON rm.id = m.reply_to
            LEFT JOIN customers rc ON rc.id = rm.customer_id
           WHERE m.hidden = 0 AND m.created_at > ?1${allowedSql}
           ORDER BY m.created_at DESC
           LIMIT ?${limitParam}`);
      const rows = restrictedChat
        ? await statement.bind(now() - CHAT_KEEP_MS, ...allowed, CHAT_FETCH).all()
        : await statement.bind(now() - CHAT_KEEP_MS, CHAT_FETCH).all();
      // Newest first out of the database, oldest first on screen.
      const messages = (rows.results || []).reverse().map(row => ({
        id: row.id,
        name: row.display_name,
        body: row.body,
        at: Number(row.created_at || 0),
        isMe: row.customer_id === session.customer_id,
        canDelete: chatOwner || row.customer_id === session.customer_id,
        reply: row.reply_body ? { name: row.reply_name, body: row.reply_body } : null
      }));
      await env.CUSTOMER_DB.prepare(
        `INSERT INTO arcade_chat_reads (customer_id, public_read_at)
         VALUES (?1, ?2)
         ON CONFLICT(customer_id) DO UPDATE SET public_read_at = excluded.public_read_at`
      ).bind(session.customer_id, now()).run();
      return json(request, {
        messages,
        isOwner: chatOwner,
        restricted: restrictedChat,
        maxLength: CHAT_MAX_LEN
      });
    }

    if (path === "/customer/arcade/chat" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      // Collapse any run of whitespace so a wall of newlines can't shove the
      // rest of the chat off the screen.
      const text = clean(body.body, CHAT_MAX_LEN).replace(/\s+/g, " ").trim();
      if (!text) return json(request, { error: "Type a message first" }, 400);
      const problem = chatProblem(text);
      if (problem) return json(request, { error: problem }, 400);
      const replyTo = clean(body.replyTo, 80);
      if (replyTo) {
        const reply = await env.CUSTOMER_DB.prepare(
          "SELECT customer_id FROM arcade_messages WHERE id = ?1 AND hidden = 0"
        ).bind(replyTo).first();
        const allowedReply = reply && (!CHAT_RESTRICTED_VIEWERS.has(session.customer_id)
          || reply.customer_id === session.customer_id
          || CHAT_TRUSTED_AUTHOR_SET.has(reply.customer_id));
        if (!allowedReply) return json(request, { error: "That message is no longer available" }, 400);
      }
      const recent = await env.CUSTOMER_DB.prepare(
        "SELECT COUNT(*) AS sent FROM arcade_messages WHERE customer_id = ?1 AND created_at > ?2"
      ).bind(session.customer_id, now() - 60000).first();
      if (Number(recent?.sent || 0) >= CHAT_PER_MINUTE) {
        return json(request, { error: "Slow down a moment - a few messages a minute is the limit." }, 429);
      }
      const stamp = now();
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          `INSERT INTO arcade_messages (id, customer_id, body, reply_to, created_at, hidden)
           VALUES (?1, ?2, ?3, ?4, ?5, 0)`
        ).bind(randomToken(12), session.customer_id, text, replyTo || null, stamp),
        // Old lines go on the way past rather than needing a scheduled job.
        env.CUSTOMER_DB.prepare("DELETE FROM arcade_messages WHERE created_at < ?1")
          .bind(stamp - CHAT_KEEP_MS)
      ]);
      return json(request, { ok: true });
    }

    if (path === "/customer/arcade/direct" && request.method === "GET") {
      const friendId = clean(new URL(request.url).searchParams.get("friendId"), 80);
      if (!friendId || !await acceptedArcadeFriends(env, session.customer_id, friendId)) {
        return json(request, { error: "Private messages are only for accepted friends" }, 403);
      }
      if (!directChatAllowed(session.customer_id, friendId)) {
        return json(request, { error: "Private messaging is not available for this friend" }, 403);
      }
      const friend = await env.CUSTOMER_DB.prepare(
        "SELECT id, nickname, first_name FROM customers WHERE id = ?1"
      ).bind(friendId).first();
      if (!friend) return json(request, { error: "That friend could not be found" }, 404);
      const rows = await env.CUSTOMER_DB.prepare(
        `SELECT m.id, m.body, m.created_at, m.read_at, m.sender_id, m.reply_to,
                COALESCE(NULLIF(TRIM(c.nickname), ''), NULLIF(TRIM(c.first_name), ''), 'Player') AS display_name,
                rm.body AS reply_body,
                COALESCE(NULLIF(TRIM(rc.nickname), ''), NULLIF(TRIM(rc.first_name), ''), 'Player') AS reply_name
           FROM arcade_direct_messages m
           JOIN customers c ON c.id = m.sender_id
           LEFT JOIN arcade_direct_messages rm ON rm.id = m.reply_to
           LEFT JOIN customers rc ON rc.id = rm.sender_id
          WHERE ((m.sender_id = ?1 AND m.recipient_id = ?2 AND m.hidden_by_sender = 0)
              OR (m.sender_id = ?2 AND m.recipient_id = ?1 AND m.hidden_by_recipient = 0))
            AND m.created_at > ?3
          ORDER BY m.created_at DESC LIMIT 100`
      ).bind(session.customer_id, friendId, now() - DIRECT_CHAT_KEEP_MS).all();
      const stamp = now();
      await env.CUSTOMER_DB.prepare(
        `UPDATE arcade_direct_messages SET read_at = ?3
          WHERE sender_id = ?1 AND recipient_id = ?2 AND read_at IS NULL`
      ).bind(friendId, session.customer_id, stamp).run();
      const messages = (rows.results || []).reverse().map(row => ({
        id: row.id,
        name: row.display_name,
        body: row.body,
        at: Number(row.created_at || 0),
        readAt: row.read_at ? Number(row.read_at) : null,
        isMe: row.sender_id === session.customer_id,
        reply: row.reply_body ? { name: row.reply_name, body: row.reply_body } : null
      }));
      return json(request, {
        friend: { id: friend.id, name: arcadeDisplayName(friend) },
        messages
      });
    }

    if (path === "/customer/arcade/direct" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const friendId = clean(body.friendId, 80);
      if (!friendId || !await acceptedArcadeFriends(env, session.customer_id, friendId)) {
        return json(request, { error: "Private messages are only for accepted friends" }, 403);
      }
      if (!directChatAllowed(session.customer_id, friendId)) {
        return json(request, { error: "Private messaging is not available for this friend" }, 403);
      }
      const text = clean(body.body, CHAT_MAX_LEN).replace(/\s+/g, " ").trim();
      if (!text) return json(request, { error: "Type a message first" }, 400);
      const problem = chatProblem(text);
      if (problem) return json(request, { error: problem }, 400);
      const replyTo = clean(body.replyTo, 80);
      if (replyTo) {
        const reply = await env.CUSTOMER_DB.prepare(
          `SELECT id FROM arcade_direct_messages
            WHERE id = ?1
              AND ((sender_id = ?2 AND recipient_id = ?3)
                OR (sender_id = ?3 AND recipient_id = ?2))`
        ).bind(replyTo, session.customer_id, friendId).first();
        if (!reply) return json(request, { error: "That message is no longer available" }, 400);
      }
      const recent = await env.CUSTOMER_DB.prepare(
        "SELECT COUNT(*) AS sent FROM arcade_direct_messages WHERE sender_id = ?1 AND created_at > ?2"
      ).bind(session.customer_id, now() - 60000).first();
      if (Number(recent?.sent || 0) >= DIRECT_CHAT_PER_MINUTE) {
        return json(request, { error: "Slow down a moment before sending more messages" }, 429);
      }
      const stamp = now();
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          `INSERT INTO arcade_direct_messages
            (id, sender_id, recipient_id, body, reply_to, created_at, read_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`
        ).bind(randomToken(12), session.customer_id, friendId, text, replyTo || null, stamp),
        env.CUSTOMER_DB.prepare(
          "DELETE FROM arcade_direct_messages WHERE created_at < ?1"
        ).bind(stamp - DIRECT_CHAT_KEEP_MS)
      ]);
      return json(request, { ok: true });
    }

    const chatDelete = path.match(/^\/customer\/arcade\/chat\/([^/]+)$/);
    if (chatDelete && request.method === "DELETE") {
      const id = decodeURIComponent(chatDelete[1]);
      // Hidden rather than deleted, so a removed message still leaves a trace.
      const result = chatOwner
        ? await env.CUSTOMER_DB.prepare("UPDATE arcade_messages SET hidden = 1 WHERE id = ?1")
            .bind(id).run()
        : await env.CUSTOMER_DB.prepare("UPDATE arcade_messages SET hidden = 1 WHERE id = ?1 AND customer_id = ?2")
            .bind(id, session.customer_id).run();
      if (!result?.meta?.changes) return json(request, { error: "That message isn't yours to remove" }, 403);
      return json(request, { ok: true });
    }

    const pdfMatch = path.match(/^\/customer\/documents\/([^/]+)\/pdf$/);
    if (pdfMatch && request.method === "GET") {
      const docId = decodeURIComponent(pdfMatch[1]);
      const doc = await env.CUSTOMER_DB.prepare(
        "SELECT r2_key, filename FROM booking_documents WHERE id = ?1 AND email = ?2 COLLATE NOCASE"
      ).bind(docId, session.email).first();
      const object = doc?.r2_key && env.DOCUMENTS ? await env.DOCUMENTS.get(doc.r2_key) : null;
      if (!object) return json(request, { error: "That document isn't available" }, 404);
      const bytes = new Uint8Array(await object.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return json(request, { pdfBase64: btoa(bin), filename: doc.filename || "Document.pdf" });
    }

    if (path === "/customer/profile" && request.method === "PUT") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const firstName = clean(body.firstName, 60);
      const lastName = clean(body.lastName, 60);
      const phone = clean(body.phone, 30);
      const referralSource = clean(body.referralSource, 40);
      const referralDetails = clean(body.referralDetails, 160);
      const suppliedAddresses = Array.isArray(body.addresses) ? body.addresses.slice(0, 10) : [{
        label: "Home",
        streetAddress: body.streetAddress,
        town: body.town,
        area: body.area,
        ruralOption: body.ruralOption,
        accessNotes: body.accessNotes,
        isDefault: true
      }];
      const addresses = suppliedAddresses.map((address, index) => ({
        id: `ADDR-${crypto.randomUUID()}`,
        label: clean(address?.label, 50) || `Address ${index + 1}`,
        streetAddress: clean(address?.streetAddress, 180),
        town: clean(address?.town, 100),
        area: clean(address?.area, 100),
        ruralOption: clean(address?.ruralOption, 120),
        accessNotes: clean(address?.accessNotes, 1000),
        isDefault: Boolean(address?.isDefault)
      }));
      const defaultIndex = Math.max(0, addresses.findIndex(address => address.isDefault));
      addresses.forEach((address, index) => { address.isDefault = index === defaultIndex; });
      const primary = addresses[defaultIndex];
      if (!firstName || !lastName || phone.replace(/\D/g, "").length < 8 || !primary ||
          addresses.some(address => !address.streetAddress || !address.town || !Object.hasOwn(RURAL_PRICES, address.ruralOption))) {
        return json(request, { error: "Please complete your name, phone, address, town and pickup area" }, 400);
      }
      if (!REFERRAL_OPTIONS.has(referralSource)) return json(request, { error: "Choose how you found us" }, 400);
      if (referralSource === "Other" && !referralDetails) return json(request, { error: "Please tell us where you found us" }, 400);
      const updatedAt = now();
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          "UPDATE customers SET first_name=?1, last_name=?2, phone=?3, street_address=?4, town=?5, area=?6, rural_option=?7, referral_source=?8, referral_details=?9, access_notes=?10, updated_at=?11 WHERE id=?12"
        ).bind(
          firstName, lastName, phone, primary.streetAddress, primary.town, primary.area,
          primary.ruralOption, referralSource, referralDetails, primary.accessNotes, updatedAt, session.customer_id
        ),
        env.CUSTOMER_DB.prepare("DELETE FROM customer_addresses WHERE customer_id=?1").bind(session.customer_id),
        ...addresses.map((address, index) => env.CUSTOMER_DB.prepare(
          `INSERT INTO customer_addresses (
            id, customer_id, label, street_address, town, area, rural_option,
            access_notes, is_default, sort_order, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`
        ).bind(
          address.id, session.customer_id, address.label, address.streetAddress, address.town,
          address.area, address.ruralOption, address.accessNotes, address.isDefault ? 1 : 0,
          index, updatedAt
        ))
      ]);
      return json(request, { ok: true, profile: await customerProfileResponse(env, session.customer_id) });
    }

    if (path === "/customer/bookings" && request.method === "GET") {
      return json(request, { bookings: await customerBookings(env, session.customer_id) });
    }

    // Change an existing request instead of cancelling and starting again.
    const editMatch = path.match(/^\/customer\/bookings\/([^/]+)$/);
    if (editMatch && request.method === "PUT") {
      const bookingId = decodeURIComponent(editMatch[1]);
      if (!bookingId.startsWith("WEB-")) {
        return json(request, { error: "This booking cannot be changed online. Please message us instead." }, 400);
      }
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const booking = await env.CUSTOMER_DB.prepare(
        "SELECT * FROM bookings WHERE id = ?1 AND (customer_id = ?2 OR email = ?3 COLLATE NOCASE)"
      ).bind(bookingId, session.customer_id, session.email).first();
      if (!booking) return json(request, { error: "Booking not found" }, 404);
      if (["COMPLETED", "DECLINED", "CANCELLED"].includes(booking.status)) {
        return json(request, { error: "This booking can no longer be changed online" }, 409);
      }
      const items = Array.isArray(body.items) ? body.items.map(item => clean(item, 80)).filter(Boolean).slice(0, 10) : [];
      if (!items.length || items.some(item => !Object.hasOwn(ITEM_PRICES, item))) {
        return json(request, { error: "Choose at least one item from the list" }, 400);
      }
      const additionalInfo = clean(body.additionalInfo, 1500);
      const price = calculate(items, booking.rural_option);
      const updatedAt = now();
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          `UPDATE bookings SET items_json=?1, additional_info=?2, total_cents=?3, quote_required=?4,
             quote_cents=0, quote_note='', quoted_at=NULL, updated_at=?5 WHERE id=?6`
        ).bind(JSON.stringify(items), additionalInfo, price.cents, price.quoteRequired ? 1 : 0, updatedAt, bookingId),
        env.CUSTOMER_DB.prepare(
          "INSERT INTO booking_events (id, booking_id, event_type, detail, created_at) VALUES (?1, ?2, 'CHANGED', ?3, ?4)"
        ).bind(crypto.randomUUID(), bookingId, `Customer updated the item list (${items.length} item${items.length === 1 ? "" : "s"})`, updatedAt)
      ]);
      const updated = await env.CUSTOMER_DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(bookingId).first();
      // Woody has to know, especially if this pickup is already on a run.
      const ownerEmailed = await sendMail(env, {
        to: OWNER_EMAIL,
        name: "Woody",
        subject: `Booking changed - ${booking.first_name || booking.town || booking.id}`,
        text: ownerBookingChangeText(updated, items, additionalInfo, price)
      }).catch(() => false);
      return json(request, { ok: true, booking: bookingFrom(updated), ownerEmailed });
    }

    const photoMatch = path.match(/^\/customer\/bookings\/([^/]+)\/photos$/);
    if (photoMatch && (request.method === "GET" || request.method === "POST")) {
      const bookingId = decodeURIComponent(photoMatch[1]);
      if (!bookingId.startsWith("WEB-")) return json(request, { error: "Photos are not available for this booking" }, 400);
      const booking = await env.CUSTOMER_DB.prepare(
        "SELECT id, status, photo_count, items_json FROM bookings WHERE id = ?1 AND (customer_id = ?2 OR email = ?3 COLLATE NOCASE)"
      ).bind(bookingId, session.customer_id, session.email).first();
      if (!booking) return json(request, { error: "Booking not found" }, 404);
      if (request.method === "GET") {
        const photoDetails = await readPhotoDetails(env, bookingId, booking.photo_count);
        return json(request, { photos: photoDetails.map(photo => photo.data), photoDetails });
      }
      if (["COMPLETED", "DECLINED", "CANCELLED"].includes(booking.status)) {
        return json(request, { error: "This booking can no longer be changed online" }, 409);
      }
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      await clearPhotos(env, bookingId, booking.photo_count);
      let bookingItems = [];
      try { bookingItems = JSON.parse(booking.items_json || "[]"); } catch { bookingItems = []; }
      const photos = Array.isArray(body.photos) ? body.photos.slice(0, bookingItems.length) : [];
      const photoCount = await savePhotos(env, bookingId, photos);
      await env.CUSTOMER_DB.prepare("UPDATE bookings SET photo_count=?1, updated_at=?2 WHERE id=?3")
        .bind(photoCount, now(), bookingId).run();
      return json(request, { ok: true, photoCount });
    }

    const messageMatch = path.match(/^\/customer\/bookings\/([^/]+)\/message$/);
    if (messageMatch && request.method === "POST") {
      const bookingId = decodeURIComponent(messageMatch[1]);
      const table = bookingId.startsWith("JOTFORM-") ? "jotform_bookings"
        : bookingId.startsWith("PICKUP-") ? "external_bookings"
        : bookingId.startsWith("WEB-") ? "bookings" : "";
      if (!table) return json(request, { error: "Booking not found" }, 404);
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const message = clean(body.message, 1500);
      if (message.length < 2) return json(request, { error: "Please type your message first" }, 400);
      const booking = await env.CUSTOMER_DB.prepare(
        `SELECT * FROM ${table} WHERE id = ?1 AND (customer_id = ?2 OR email = ?3 COLLATE NOCASE)`
      ).bind(bookingId, session.customer_id, session.email).first();
      if (!booking) return json(request, { error: "Booking not found" }, 404);
      const sent = await sendMail(env, {
        to: OWNER_EMAIL,
        name: "Woody",
        subject: `Message about a pickup - ${booking.first_name || booking.town || booking.id}`,
        text: ownerCustomerMessageText(booking, message),
        replyTo: { email: booking.email, name: `${booking.first_name || ""} ${booking.last_name || ""}`.trim() }
      }).catch(() => false);
      if (!sent) return json(request, { error: "Your message could not be sent just now. Please email us directly." }, 502);
      return json(request, { ok: true });
    }

    const cancelMatch = path.match(/^\/customer\/bookings\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      const bookingId = decodeURIComponent(cancelMatch[1]);
      const jotform = bookingId.startsWith("JOTFORM-");
      const pickupRun = bookingId.startsWith("PICKUP-");
      if (!jotform && !pickupRun && !bookingId.startsWith("WEB-")) {
        return json(request, { error: "This booking cannot be cancelled online" }, 400);
      }
      let body = {};
      try { body = await request.json(); } catch { /* reason is optional */ }
      const reason = clean(body.reason, 500);
      const table = jotform ? "jotform_bookings" : pickupRun ? "external_bookings" : "bookings";
      const booking = await env.CUSTOMER_DB.prepare(
        `SELECT * FROM ${table} WHERE id = ?1 AND (customer_id = ?2 OR email = ?3 COLLATE NOCASE)`
      ).bind(bookingId, session.customer_id, session.email).first();
      if (!booking) return json(request, { error: "Booking not found" }, 404);
      if (["COMPLETED", "DECLINED", "CANCELLED"].includes(booking.status)) {
        return json(request, { error: "This booking can no longer be cancelled online" }, 409);
      }
      const cancelledAt = now();
      await env.CUSTOMER_DB.prepare(
        `UPDATE ${table} SET status='CANCELLED', cancellation_reason=?1, cancelled_at=?2, updated_at=?2 WHERE id=?3`
      ).bind(reason, cancelledAt, bookingId).run();
      if (!jotform && !pickupRun) {
        await env.CUSTOMER_DB.prepare(
          "INSERT INTO booking_events (id, booking_id, event_type, detail, created_at) VALUES (?1, ?2, 'CANCELLED', ?3, ?4)"
        ).bind(crypto.randomUUID(), bookingId, reason, cancelledAt).run();
      }
      if (!pickupRun) {
        try { await updateSheetBookingStatus(env, bookingId, "CANCELLED"); } catch { /* app remains authoritative */ }
      }
      try {
        await sendMail(env, {
          to: OWNER_EMAIL,
          name: "Woody",
          subject: `Pickup cancelled - ${booking.first_name || booking.town || booking.id}`,
          text: ownerCancellationText(booking, reason)
        });
        await sendMail(env, {
          to: booking.email,
          name: `${booking.first_name || ""} ${booking.last_name || ""}`.trim(),
          subject: "Your whiteware pickup has been cancelled",
          text: customerCancellationText(booking)
        });
      } catch {
        // The cancellation is saved even if email is temporarily unavailable.
      }
      const updated = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(bookingId).first();
      updated.booking_source = jotform ? "JOTFORM" : pickupRun ? "PICKUP_RUN" : "WEBSITE";
      return json(request, { ok: true, booking: bookingFrom(updated) });
    }

    if (path === "/customer/bookings" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const profile = await customerProfile(env, session.customer_id);
      const savedAddresses = await customerAddresses(env, session.customer_id);
      const requestedAddressId = clean(body.addressId, 100);
      const selectedAddress = savedAddresses.find(address => address.id === requestedAddressId) ||
        savedAddresses.find(address => address.isDefault) || savedAddresses[0] || (
          profile?.street_address && profile?.town && Object.hasOwn(RURAL_PRICES, profile?.rural_option)
            ? {
                id: "",
                label: "Home",
                streetAddress: profile.street_address,
                town: profile.town,
                area: profile.area || "",
                ruralOption: profile.rural_option,
                accessNotes: profile.access_notes || "",
                isDefault: true
              }
            : null
        );
      if (!profile || !profile.first_name || !profile.phone || !selectedAddress) {
        return json(request, { error: "Please finish your profile before booking" }, 400);
      }
      const items = Array.isArray(body.items) ? body.items.map(item => clean(item, 80)).filter(Boolean).slice(0, 10) : [];
      if (!items.length || items.some(item => !Object.hasOwn(ITEM_PRICES, item))) {
        return json(request, { error: "Choose at least one item from the list" }, 400);
      }
      const price = calculate(items, selectedAddress.ruralOption);
      const createdAt = now();
      const bookingId = `WEB-${createdAt}-${randomToken(6)}`;
      const additionalInfo = clean(body.additionalInfo || selectedAddress.accessNotes, 1500);
      const pickupProfile = {
        ...profile,
        street_address: selectedAddress.streetAddress,
        town: selectedAddress.town,
        area: selectedAddress.area,
        rural_option: selectedAddress.ruralOption,
        access_notes: selectedAddress.accessNotes
      };
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          `INSERT INTO bookings (
            id, customer_id, status, first_name, last_name, phone, email, street_address, town, area,
            rural_option, items_json, additional_info, referral_source, referral_details,
            total_cents, quote_required, created_at, updated_at
          ) VALUES (?1, ?2, 'NEW', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)`
        ).bind(
          bookingId, session.customer_id, profile.first_name, profile.last_name, profile.phone, profile.email,
          pickupProfile.street_address, pickupProfile.town, pickupProfile.area, pickupProfile.rural_option, JSON.stringify(items),
          additionalInfo, profile.referral_source, profile.referral_details, price.cents, price.quoteRequired ? 1 : 0, createdAt
        ),
        env.CUSTOMER_DB.prepare(
          "INSERT INTO booking_events (id, booking_id, event_type, detail, created_at) VALUES (?1, ?2, 'CREATED', 'Customer website', ?3)"
        ).bind(crypto.randomUUID(), bookingId, createdAt)
      ]);
      // Photos are optional - a failed upload must never lose the booking.
      let photoCount = 0;
      try {
        const photos = Array.isArray(body.photos) ? body.photos.slice(0, items.length) : [];
        photoCount = await savePhotos(env, bookingId, photos);
        if (photoCount) {
          await env.CUSTOMER_DB.prepare("UPDATE bookings SET photo_count=?1 WHERE id=?2").bind(photoCount, bookingId).run();
        }
      } catch { photoCount = 0; }
      const booking = await env.CUSTOMER_DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(bookingId).first();
      let sheetBackedUp = true;
      try { await syncBookingToSheet(env, booking); }
      catch (error) {
        sheetBackedUp = false;
        await markSheetFailure(env, bookingId, error);
      }
      const customerEmailed = await sendMail(env, {
        to: profile.email,
        name: `${profile.first_name} ${profile.last_name}`.trim(),
        subject: "Whiteware Collection",
        text: customerConfirmationText(pickupProfile, items, additionalInfo, price)
      }).catch(() => false);
      const ownerEmailed = await sendMail(env, {
        to: OWNER_EMAIL,
        name: "Woody",
        subject: `Re: Whiteware collection form - ${profile.first_name} ${profile.last_name}`.trim(),
        text: ownerNotificationText(pickupProfile, items, additionalInfo, price, bookingId)
      }).catch(() => false);
      // Never tell a customer we emailed them when we did not. The booking is
      // already saved, so record the failure instead of losing it silently.
      if (!customerEmailed || !ownerEmailed) {
        await env.CUSTOMER_DB.prepare(
          "INSERT INTO booking_events (id, booking_id, event_type, detail, created_at) VALUES (?1, ?2, 'EMAIL_FAILED', ?3, ?4)"
        ).bind(
          crypto.randomUUID(), bookingId,
          `customer copy ${customerEmailed ? "sent" : "FAILED"}, owner alert ${ownerEmailed ? "sent" : "FAILED"}`,
          now()
        ).run();
      }
      return json(request, {
        ok: true,
        booking: bookingFrom(await env.CUSTOMER_DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(bookingId).first()),
        sheetBackedUp,
        customerEmailed,
        ownerEmailed
      }, 201);
    }

    if (path === "/customer/logout" && request.method === "POST") {
      await env.CUSTOMER_DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await hashToken(authToken(request))).run();
      return json(request, { ok: true });
    }
  }

  if (path.startsWith("/owner/")) {
    const session = await sessionFor(request, env, "owner");
    if (!session) return json(request, { error: "Owner login required" }, 401);

    /* ---- Off-phone backup of the pickup runs ----
       The runs live in one browser's storage, which a phone can wipe without
       warning (deleting the home-screen app does exactly that). The app pushes
       a copy here so a wiped or replaced phone can pull it straight back.
       The previous copy is kept too, so one bad overwrite isn't the end. */
    if (path === "/owner/backup" && request.method === "PUT") {
      const body = await request.text();
      if (body.length > 4 * 1024 * 1024) return json(request, { error: "That backup is too big to store" }, 413);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(request, { error: "Backup was not valid JSON" }, 400); }
      if (!parsed || typeof parsed !== "object" || !parsed.data) {
        return json(request, { error: "Backup has no data in it" }, 400);
      }
      const key = `backup:${session.email.toLowerCase()}`;
      const savedAt = now();
      const record = JSON.stringify({ savedAt, runCount: Number(parsed.runCount) || 0, data: parsed.data });
      // Roll the current copy back one slot before overwriting it.
      const existing = await env.REMINDERS.get(key);
      if (existing) await env.REMINDERS.put(`${key}:prev`, existing);
      await env.REMINDERS.put(key, record);
      return json(request, { ok: true, savedAt });
    }

    if (path === "/owner/backup" && request.method === "GET") {
      const key = `backup:${session.email.toLowerCase()}`;
      const which = new URL(request.url).searchParams.get("which") === "prev" ? `${key}:prev` : key;
      const stored = await env.REMINDERS.get(which, "json");
      if (!stored) return json(request, { error: "No backup saved yet" }, 404);
      return json(request, stored);
    }

    if (path === "/owner/backup/info" && request.method === "GET") {
      const key = `backup:${session.email.toLowerCase()}`;
      const [latest, prev] = await Promise.all([env.REMINDERS.get(key), env.REMINDERS.get(`${key}:prev`)]);
      const peek = raw => { try { const v = JSON.parse(raw); return { savedAt: v.savedAt, runCount: v.runCount }; } catch { return null; } };
      return json(request, { latest: latest ? peek(latest) : null, previous: prev ? peek(prev) : null });
    }

    /* Everything the business owns, as one file, on demand. The nightly R2
       snapshot is the automatic safety net; this is the copy Woody can keep
       himself, off Cloudflare entirely. */
    if (path === "/owner/export" && request.method === "GET") {
      const dump = await dumpDatabase(env);
      return json(request, dump);
    }

    if (path === "/owner/snapshots" && request.method === "GET") {
      if (!env.DOCUMENTS) return json(request, { snapshots: [] });
      const listed = await env.DOCUMENTS.list({ prefix: SNAPSHOT_PREFIX, limit: 200 });
      const snapshots = (listed.objects || [])
        .map(object => ({ day: object.key.slice(SNAPSHOT_PREFIX.length).replace(/\.json$/, ""), size: object.size }))
        .sort((a, b) => b.day.localeCompare(a.day));
      return json(request, { snapshots });
    }

    if (path === "/owner/snapshot" && request.method === "POST") {
      return json(request, await snapshotDatabase(env));
    }

    if (path === "/owner/customers" && request.method === "GET") {
      const rows = await env.CUSTOMER_DB.prepare(
        `SELECT c.*,
           ((SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) +
            (SELECT COUNT(*) FROM external_bookings e WHERE e.customer_id = c.id OR e.email = c.email COLLATE NOCASE) +
            (SELECT COUNT(*) FROM jotform_bookings j WHERE j.customer_id = c.id OR j.email = c.email COLLATE NOCASE)) AS booking_count,
           MAX(
             COALESCE((SELECT MAX(created_at) FROM bookings b WHERE b.customer_id = c.id), 0),
             COALESCE((SELECT MAX(created_at) FROM external_bookings e WHERE e.customer_id = c.id OR e.email = c.email COLLATE NOCASE), 0),
             COALESCE((SELECT MAX(created_at) FROM jotform_bookings j WHERE j.customer_id = c.id OR j.email = c.email COLLATE NOCASE), 0)
           ) AS last_booking_at
         FROM customers c ORDER BY (last_booking_at IS NULL), last_booking_at DESC, c.created_at DESC LIMIT 500`
      ).all();
      const customers = (rows.results || []).map(row => ({
        id: row.id,
        ...profileFrom(row),
        bookings: Number(row.booking_count || 0),
        lastBookingAt: row.last_booking_at ? new Date(row.last_booking_at).toISOString() : "",
        joinedAt: new Date(row.created_at).toISOString()
      }));
      return json(request, { customers });
    }

    const customerMatch = path.match(/^\/owner\/customers\/([^/]+)$/);
    // Woody fixing a typo'd phone number or address from the Customers tab —
    // email stays put since bookings, invites and sign-in are all matched on it.
    if (customerMatch && request.method === "PUT") {
      const customerId = decodeURIComponent(customerMatch[1]);
      const existing = await env.CUSTOMER_DB.prepare("SELECT id FROM customers WHERE id = ?1").bind(customerId).first();
      if (!existing) return json(request, { error: "Customer not found" }, 404);
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const firstName = clean(body.firstName, 60);
      const lastName = clean(body.lastName, 60);
      const phone = clean(body.phone, 30);
      const streetAddress = clean(body.streetAddress, 180);
      const town = clean(body.town, 100);
      const area = clean(body.area, 100);
      const accessNotes = clean(body.accessNotes, 1000);
      // Plenty of customers only ever give a first name, so one name is enough —
      // rejecting the whole save over a missing surname just lost the edit.
      if (!firstName && !lastName) return json(request, { error: "Enter at least a first name" }, 400);
      await env.CUSTOMER_DB.prepare(
        `UPDATE customers SET first_name=?1, last_name=?2, phone=?3, street_address=?4, town=?5,
          area=?6, access_notes=?7, updated_at=?8 WHERE id=?9`
      ).bind(firstName, lastName, phone, streetAddress, town, area, accessNotes, now(), customerId).run();
      const row = await env.CUSTOMER_DB.prepare(
        `SELECT c.*,
           ((SELECT COUNT(*) FROM bookings b WHERE b.customer_id = c.id) +
            (SELECT COUNT(*) FROM external_bookings e WHERE e.customer_id = c.id OR e.email = c.email COLLATE NOCASE) +
            (SELECT COUNT(*) FROM jotform_bookings j WHERE j.customer_id = c.id OR j.email = c.email COLLATE NOCASE)) AS booking_count,
           MAX(
             COALESCE((SELECT MAX(created_at) FROM bookings b WHERE b.customer_id = c.id), 0),
             COALESCE((SELECT MAX(created_at) FROM external_bookings e WHERE e.customer_id = c.id OR e.email = c.email COLLATE NOCASE), 0),
             COALESCE((SELECT MAX(created_at) FROM jotform_bookings j WHERE j.customer_id = c.id OR j.email = c.email COLLATE NOCASE), 0)
           ) AS last_booking_at
         FROM customers c WHERE c.id = ?1`
      ).bind(customerId).first();
      const customer = {
        id: row.id,
        ...profileFrom(row),
        bookings: Number(row.booking_count || 0),
        lastBookingAt: row.last_booking_at ? new Date(row.last_booking_at).toISOString() : "",
        joinedAt: new Date(row.created_at).toISOString()
      };
      return json(request, { ok: true, customer });
    }

    if (customerMatch && request.method === "DELETE") {
      const customerId = decodeURIComponent(customerMatch[1]);
      const existing = await env.CUSTOMER_DB.prepare("SELECT email FROM customers WHERE id = ?1").bind(customerId).first();
      if (!existing) return json(request, { error: "Customer not found" }, 404);
      // Delete really means delete: Jotform and pickup-run history are matched by
      // email too, so leaving them behind would reattach on the next sign-in.
      const address = email(existing.email);
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          "DELETE FROM booking_events WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = ?1)"
        ).bind(customerId),
        env.CUSTOMER_DB.prepare("DELETE FROM bookings WHERE customer_id = ?1").bind(customerId),
        env.CUSTOMER_DB.prepare(
          "DELETE FROM jotform_bookings WHERE customer_id = ?1 OR email = ?2 COLLATE NOCASE"
        ).bind(customerId, address),
        env.CUSTOMER_DB.prepare(
          "DELETE FROM external_bookings WHERE customer_id = ?1 OR email = ?2 COLLATE NOCASE"
        ).bind(customerId, address),
        env.CUSTOMER_DB.prepare("DELETE FROM profile_invites WHERE email = ?1 COLLATE NOCASE").bind(address),
        env.CUSTOMER_DB.prepare("DELETE FROM login_codes WHERE email = ?1 AND role = 'customer'").bind(address),
        env.CUSTOMER_DB.prepare("DELETE FROM sessions WHERE customer_id = ?1").bind(customerId)
      ]);
      const result = await env.CUSTOMER_DB.prepare("DELETE FROM customers WHERE id = ?1").bind(customerId).run();
      if (!result.meta || !result.meta.changes) return json(request, { error: "Customer not found" }, 404);
      return json(request, { ok: true });
    }

    if (path === "/owner/bookings/bulk-confirm" && request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const pickupDate = clean(body.pickupDate, 10);
      const pickupWindow = clean(body.pickupWindow, 80);
      const customerNote = clean(body.customerNote, 500);
      const recipients = Array.isArray(body.recipients) ? body.recipients.slice(0, 200) : [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
        return json(request, { error: "Choose the confirmed pickup day" }, 400);
      }
      if (!recipients.length) return json(request, { error: "No customers were selected" }, 400);
      const seen = new Set();
      const matched = [];
      const unmatched = [];
      for (const recipient of recipients) {
        const target = await bulkBookingTarget(env, recipient || {});
        if (!target) {
          unmatched.push(clean(recipient?.bookingId || recipient?.email, 180));
          continue;
        }
        if (seen.has(target.row.id)) continue;
        seen.add(target.row.id);
        const updatedAt = now();
        await env.CUSTOMER_DB.prepare(
          `UPDATE ${target.table} SET status='CONFIRMED', pickup_date=?1, pickup_window=?2,
            customer_note=CASE WHEN ?3='' THEN customer_note ELSE ?3 END, updated_at=?4
           WHERE id=?5`
        ).bind(pickupDate, pickupWindow, customerNote, updatedAt, target.row.id).run();
        if (target.table === "bookings") {
          await env.CUSTOMER_DB.prepare(
            "INSERT INTO booking_events (id, booking_id, event_type, detail, created_at) VALUES (?1, ?2, 'STATUS', ?3, ?4)"
          ).bind(crypto.randomUUID(), target.row.id, `CONFIRMED ${pickupDate} via bulk message`, updatedAt).run();
        }
        if (target.table !== "external_bookings") {
          try { await updateSheetBookingStatus(env, target.row.id, "CONFIRMED"); } catch { /* app remains authoritative */ }
        }
        matched.push(target.row.id);
      }
      return json(request, { ok: true, updated: matched.length, matched, unmatched });
    }

    const ownerPdfMatch = path.match(/^\/owner\/documents\/([^/]+)\/pdf$/);
    if (ownerPdfMatch && request.method === "GET") {
      const docId = decodeURIComponent(ownerPdfMatch[1]);
      const doc = await env.CUSTOMER_DB.prepare(
        "SELECT r2_key, filename FROM booking_documents WHERE id = ?1"
      ).bind(docId).first();
      const object = doc?.r2_key && env.DOCUMENTS ? await env.DOCUMENTS.get(doc.r2_key) : null;
      if (!object) return json(request, { error: "That document isn't available" }, 404);
      const bytes = new Uint8Array(await object.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return json(request, { pdfBase64: btoa(bin), filename: doc.filename || "Document.pdf" });
    }

    if (path === "/owner/bookings" && request.method === "GET") {
      const [rows, documentRows] = await Promise.all([
        env.CUSTOMER_DB.prepare(
        `SELECT * FROM (
          SELECT id, status, first_name, last_name, phone, email, street_address, town, area,
            rural_option, items_json, additional_info, referral_source, referral_details,
            total_cents, quote_required, quote_cents, quote_note, quoted_at, photo_count,
            sheet_sync_status, 'WEBSITE' AS booking_source, '' AS external_key,
            pickup_date, pickup_window, customer_note, cancellation_reason, cancelled_at, created_at,
            (SELECT COUNT(*) FROM booking_events e
              WHERE e.booking_id = bookings.id AND e.event_type = 'EMAIL_FAILED') AS email_failed
          FROM bookings
          UNION ALL
          SELECT id, status, first_name, last_name, phone, email, street_address, town, area,
            rural_option, items_json, additional_info, referral_source, referral_details,
            total_cents, quote_required, quote_cents, quote_note, quoted_at, 0 AS photo_count,
            sheet_sync_status, 'JOTFORM' AS booking_source, '' AS external_key,
            pickup_date, pickup_window, customer_note, cancellation_reason, cancelled_at, created_at,
            0 AS email_failed
          FROM jotform_bookings
          UNION ALL
          SELECT id, status, first_name, last_name, phone, email, street_address, town, area,
            rural_option, items_json, additional_info, '' AS referral_source, '' AS referral_details,
            total_cents, quote_required, quote_cents, quote_note, quoted_at, 0 AS photo_count,
            'PICKUP_RUN' AS sheet_sync_status, 'PICKUP_RUN' AS booking_source, external_key,
            pickup_date, pickup_window, customer_note, cancellation_reason, cancelled_at, created_at,
            0 AS email_failed
          FROM external_bookings
          WHERE status='CANCELLED' OR EXISTS (
            SELECT 1 FROM booking_documents d
            WHERE d.booking_id = external_bookings.id OR d.booking_id = external_bookings.external_key
          )
        ) ORDER BY CASE status WHEN 'NEW' THEN 0 ELSE 1 END, created_at DESC LIMIT 300`
        ).all(),
        env.CUSTOMER_DB.prepare(
          `SELECT id, booking_id, email, kind, amount_cents, reference, created_at,
             items_json, address, filename, r2_key
           FROM booking_documents ORDER BY created_at DESC LIMIT 1000`
        ).all()
      ]);
      const documentsByBooking = new Map();
      for (const document of (documentRows.results || []).map(bookingDocumentFrom)) {
        const list = documentsByBooking.get(document.bookingId) || [];
        list.push(document);
        documentsByBooking.set(document.bookingId, list);
      }
      const bookings = (rows.results || []).map(row => {
        const documents = documentsByBooking.get(row.id) || documentsByBooking.get(row.external_key || "") || [];
        const latestInvoice = documents.find(document => document.kind === "INVOICE");
        const latestReceipt = documents.find(document => document.kind === "RECEIPT");
        const invoiceOwing = Boolean(latestInvoice) && (!latestReceipt || latestInvoice.createdAt > latestReceipt.createdAt);
        return {
          ...bookingFrom(row),
          emailFailed: Number(row.email_failed || 0) > 0,
          documents,
          invoiceOwing
        };
      });
      return json(request, {
        bookings
      });
    }

    // Photos a customer attached to a website booking.
    const ownerPhotoMatch = path.match(/^\/owner\/bookings\/([^/]+)\/photos$/);
    if (ownerPhotoMatch && request.method === "GET") {
      const bookingId = decodeURIComponent(ownerPhotoMatch[1]);
      if (!bookingId.startsWith("WEB-")) return json(request, { photos: [] });
      const booking = await env.CUSTOMER_DB.prepare("SELECT photo_count FROM bookings WHERE id = ?1").bind(bookingId).first();
      if (!booking) return json(request, { error: "Booking not found" }, 404);
      const photoDetails = await readPhotoDetails(env, bookingId, booking.photo_count);
      return json(request, { photos: photoDetails.map(photo => photo.data), photoDetails });
    }

    // Where customers actually come from - collected on every booking, now visible.
    if (path === "/owner/insights" && request.method === "GET") {
      const [sources, towns, totals] = await Promise.all([
        env.CUSTOMER_DB.prepare(
          `SELECT source, COUNT(*) AS count FROM (
             SELECT COALESCE(NULLIF(TRIM(referral_source), ''), 'Not answered') AS source FROM bookings
             UNION ALL
             SELECT COALESCE(NULLIF(TRIM(referral_source), ''), 'Not answered') AS source FROM jotform_bookings
           ) GROUP BY source ORDER BY count DESC`
        ).all(),
        env.CUSTOMER_DB.prepare(
          // Towns are typed by hand. Keep New Plymouth and its suburbs together
          // in the summary, just like the owner page does. Westtown is a common
          // spelling of the Westown suburb.
          `SELECT CASE
             WHEN LOWER(TRIM(town)) IN ('fitzroy', 'westown', 'westtown', 'highlands park', 'merrilands', 'vogeltown', 'lower vogeltown', 'brooklands', 'strandon', 'moturoa', 'spotswood', 'lynmouth', 'blagdon', 'ferndale', 'frankleigh park', 'hurdon', 'marfell', 'welbourn', 'whalers gate', 'kawaroa')
               OR LOWER(TRIM(town)) LIKE '%new plymouth%'
               THEN 'New Plymouth'
             ELSE MIN(town)
           END AS town, COUNT(*) AS count FROM (
             SELECT COALESCE(NULLIF(TRIM(town), ''), 'No town') AS town FROM bookings
             UNION ALL
             SELECT COALESCE(NULLIF(TRIM(town), ''), 'No town') AS town FROM jotform_bookings
             UNION ALL
             SELECT COALESCE(NULLIF(TRIM(town), ''), 'No town') AS town FROM external_bookings
           ) GROUP BY CASE
             WHEN LOWER(TRIM(town)) IN ('fitzroy', 'westown', 'westtown', 'highlands park', 'merrilands', 'vogeltown', 'lower vogeltown', 'brooklands', 'strandon', 'moturoa', 'spotswood', 'lynmouth', 'blagdon', 'ferndale', 'frankleigh park', 'hurdon', 'marfell', 'welbourn', 'whalers gate', 'kawaroa')
               OR LOWER(TRIM(town)) LIKE '%new plymouth%'
               THEN 'new plymouth'
             ELSE LOWER(TRIM(town))
           END ORDER BY count DESC LIMIT 20`
        ).all(),
        env.CUSTOMER_DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM customers) AS customers,
             (SELECT COUNT(*) FROM bookings) + (SELECT COUNT(*) FROM jotform_bookings) +
               (SELECT COUNT(*) FROM external_bookings) AS bookings,
             (SELECT COUNT(*) FROM bookings WHERE status='COMPLETED') +
               (SELECT COUNT(*) FROM jotform_bookings WHERE status='COMPLETED') +
               (SELECT COUNT(*) FROM external_bookings WHERE status='COMPLETED') AS completed`
        ).first()
      ]);
      return json(request, {
        sources: (sources.results || []).map(row => ({ source: row.source, count: Number(row.count || 0) })),
        towns: (towns.results || []).map(row => ({ town: row.town, count: Number(row.count || 0) })),
        totals: {
          customers: Number(totals?.customers || 0),
          bookings: Number(totals?.bookings || 0),
          completed: Number(totals?.completed || 0)
        }
      });
    }

    const match = path.match(/^\/owner\/bookings\/([^/]+)$/);
    if (match && request.method === "DELETE") {
      const bookingId = decodeURIComponent(match[1]);
      const result = await env.CUSTOMER_DB.prepare(
        bookingId.startsWith("JOTFORM-")
          ? "DELETE FROM jotform_bookings WHERE id = ?1"
          : bookingId.startsWith("PICKUP-")
            ? "DELETE FROM external_bookings WHERE id = ?1"
          : "DELETE FROM bookings WHERE id = ?1"
      ).bind(bookingId).run();
      if (!result.meta || !result.meta.changes) return json(request, { error: "Booking not found" }, 404);
      return json(request, { ok: true });
    }

    if (match && request.method === "PATCH") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const status = clean(body.status, 30).toUpperCase();
      if (!OWNER_STATUSES.has(status)) return json(request, { error: "Invalid booking status" }, 400);
      const bookingId = decodeURIComponent(match[1]);
      const jotform = bookingId.startsWith("JOTFORM-");
      const pickupRun = bookingId.startsWith("PICKUP-");
      const table = jotform ? "jotform_bookings" : pickupRun ? "external_bookings" : "bookings";
      const existing = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(bookingId).first();
      if (!existing) return json(request, { error: "Booking not found" }, 404);
      const pickupDate = body.pickupDate == null ? existing.pickup_date || "" : clean(body.pickupDate, 10);
      const pickupWindow = body.pickupWindow == null ? existing.pickup_window || "" : clean(body.pickupWindow, 80);
      const customerNote = body.customerNote == null ? existing.customer_note || "" : clean(body.customerNote, 500);
      if (status === "CONFIRMED" && !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) {
        return json(request, { error: "Choose the confirmed pickup day" }, 400);
      }
      // Optional: put a real price on a "quote to be confirmed" job.
      const hasQuote = body.quoteAmount != null && String(body.quoteAmount).trim() !== "";
      const rawQuote = Number(body.quoteAmount);
      if (hasQuote && !(Number.isFinite(rawQuote) && rawQuote >= 0 && rawQuote <= 100000)) {
        return json(request, { error: "Enter the quoted price as a number" }, 400);
      }
      const updatedAt = now();
      const quoteCents = hasQuote ? Math.round(rawQuote * 100) : Number(existing.quote_cents || 0);
      const quoteNote = body.quoteNote == null ? existing.quote_note || "" : clean(body.quoteNote, 300);
      const quotedAt = hasQuote ? updatedAt : (existing.quoted_at || null);

      // Owner-edited customer details. Every field is optional - anything left out
      // keeps what the customer originally sent.
      const keep = (value, column, max) => value == null ? (existing[column] || "") : clean(value, max);
      const firstName = keep(body.firstName, "first_name", 60);
      const lastName = keep(body.lastName, "last_name", 60);
      const phone = keep(body.phone, "phone", 30);
      const address = body.email == null ? existing.email : email(body.email);
      if (!EMAIL_RE.test(address)) return json(request, { error: "Enter a valid email address" }, 400);
      const streetAddress = keep(body.streetAddress, "street_address", 180);
      const town = keep(body.town, "town", 100);
      const area = keep(body.area, "area", 100);
      const additionalInfo = keep(body.additionalInfo, "additional_info", 1500);
      let itemsJson = existing.items_json || "[]";
      let totalCents = Number(existing.total_cents || 0);
      let quoteRequired = Number(existing.quote_required || 0);
      if (Array.isArray(body.items)) {
        const items = body.items.map(item => clean(item, 100)).filter(Boolean).slice(0, 10);
        itemsJson = JSON.stringify(items);
        // Only re-price when every item is one of ours - a hand-typed item has no
        // price we can look up, so the existing total is left alone.
        if (items.length && items.every(item => Object.hasOwn(ITEM_PRICES, item))) {
          const priced = calculate(items, existing.rural_option || "");
          totalCents = priced.cents;
          quoteRequired = priced.quoteRequired ? 1 : 0;
        }
      }

      const result = await env.CUSTOMER_DB.prepare(
        `UPDATE ${table} SET status=?1, pickup_date=?2, pickup_window=?3, customer_note=?4,
          quote_cents=?7, quote_note=?8, quoted_at=?9,
          first_name=?10, last_name=?11, phone=?12, email=?13, street_address=?14, town=?15,
          area=?16, additional_info=?17, items_json=?18, total_cents=?19, quote_required=?20,
          updated_at=?5${jotform || pickupRun ? ", completed_at = CASE WHEN ?1='COMPLETED' THEN COALESCE(completed_at, ?5) ELSE NULL END" : ""}
         WHERE id=?6`
      ).bind(status, pickupDate, pickupWindow, customerNote, updatedAt, bookingId, quoteCents, quoteNote, quotedAt,
        firstName, lastName, phone, address, streetAddress, town, area, additionalInfo, itemsJson,
        totalCents, quoteRequired).run();
      if (!result.meta || !result.meta.changes) return json(request, { error: "Booking not found" }, 404);
      if (!jotform && !pickupRun) {
        await env.CUSTOMER_DB.prepare(
          "INSERT INTO booking_events (id, booking_id, event_type, detail, created_at) VALUES (?1, ?2, 'STATUS', ?3, ?4)"
        ).bind(crypto.randomUUID(), bookingId, `${status}${pickupDate ? ` ${pickupDate}` : ""}`, updatedAt).run();
      }
      if (!pickupRun) {
        try { await updateSheetBookingStatus(env, bookingId, status); } catch { /* app remains authoritative */ }
      }
      const updated = await env.CUSTOMER_DB.prepare(`SELECT * FROM ${table} WHERE id=?1`).bind(bookingId).first();
      let quoteEmailed = null;
      if (hasQuote && body.notifyCustomer !== false) {
        quoteEmailed = await sendMail(env, {
          to: updated.email,
          name: `${updated.first_name || ""} ${updated.last_name || ""}`.trim(),
          subject: "Your whiteware collection price",
          text: customerQuoteText(updated, quoteCents, quoteNote)
        }).catch(() => false);
      }
      if (body.notifyCustomer && status === "CONFIRMED") {
        await sendMail(env, {
          to: updated.email,
          name: `${updated.first_name || ""} ${updated.last_name || ""}`.trim(),
          subject: `Whiteware pickup confirmed - ${pickupDateText(pickupDate)}`,
          text: pickupConfirmationText(updated, pickupDate, pickupWindow, customerNote)
        });
      }
      updated.booking_source = jotform ? "JOTFORM" : pickupRun ? "PICKUP_RUN" : "WEBSITE";
      return json(request, { ok: true, booking: bookingFrom(updated), quoteEmailed });
    }
  }

  return json(request, { error: "Not found" }, 404);
}

// Exported only for the focused permission-policy test; the Worker routes
// above remain the public API.
export { arcadeContactAllowed, directChatAllowed };
