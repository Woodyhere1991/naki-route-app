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

function profileFrom(row) {
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
    accessNotes: row.access_notes || ""
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
    sheetSyncStatus: row.sheet_sync_status,
    source,
    pickupDate: row.pickup_date || "",
    pickupWindow: row.pickup_window || "",
    customerNote: row.customer_note || "",
    cancellationReason: row.cancellation_reason || "",
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : "",
    canCancel: (source === "WEBSITE" || source === "JOTFORM" || source === "PICKUP_RUN") &&
      !["COMPLETED", "DECLINED", "CANCELLED"].includes(status),
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
  row[22] = "NEW";
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
      access_notes = CASE WHEN access_notes = '' THEN ?9 ELSE access_notes END,
      updated_at = ?10
    WHERE id = ?11`
  ).bind(
    invite.first_name || "", invite.last_name || "", invite.phone || "", invite.street_address || "",
    invite.town || "", invite.area || "", ruralOption, referralSource, invite.access_notes || "",
    now(), customerId
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

export async function handlePortalRequest({ request, env, path, json, sendMail }) {
  if (!path.startsWith("/customer/") && !path.startsWith("/owner/") && path !== "/jotform/submission") return null;
  if (!env.CUSTOMER_DB) return json(request, { error: "Customer accounts are not ready yet" }, 503);

  if (path === "/jotform/submission" && request.method === "POST") {
    return handleJotformSubmission(request, env, json);
  }

  if (path === "/customer/profile-invite" && request.method === "POST") {
    let body = {};
    try { body = await request.json(); } catch { /* handled below */ }
    const address = email(body.email);
    if (!EMAIL_RE.test(address)) return json(request, { error: "A valid customer email is needed" }, 400);
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
          rural_option, referral_source, access_notes, expires_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
      ).bind(
        await hashToken(token), address, clean(body.firstName, 60), clean(body.lastName, 60),
        clean(body.phone, 30), clean(body.streetAddress, 180), clean(body.town, 100),
        clean(body.area, 100), Object.hasOwn(RURAL_PRICES, ruralOption) ? ruralOption : "",
        REFERRAL_OPTIONS.has(referralSource) ? referralSource : "", clean(body.accessNotes, 1000),
        createdAt + PROFILE_INVITE_TTL_MS, createdAt
      ),
      env.CUSTOMER_DB.prepare(
        "DELETE FROM profile_invites WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?2)"
      ).bind(createdAt, createdAt - 30 * 24 * 60 * 60 * 1000)
    ]);
    const bookingLinked = await upsertExternalBooking(env, bookingFields, bookingSyncToken);
    return json(request, {
      ok: true,
      url: `${CUSTOMER_ACCOUNT_URL}?invite=${encodeURIComponent(token)}`,
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
        customer_id=COALESCE(customer_id, ?1), status=?2, first_name=?3, last_name=?4, phone=?5,
        street_address=?6, town=?7, area=?8, rural_option=?9, items_json=?10,
        additional_info=?11, total_cents=?12, quote_required=?13, updated_at=?14,
        completed_at=CASE WHEN ?2='COMPLETED' THEN COALESCE(completed_at, ?14) ELSE NULL END
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
      profile: profileFrom(profile),
      bookings: await customerBookings(env, verified.customerId),
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
      profile: profileFrom(profile),
      bookings: await customerBookings(env, verified.customerId)
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

  if (path.startsWith("/customer/")) {
    const session = await sessionFor(request, env, "customer");
    if (!session) return json(request, { error: "Please sign in again" }, 401);

    if (path === "/customer/me" && request.method === "GET") {
      const profile = await customerProfile(env, session.customer_id);
      return json(request, { profile: profileFrom(profile), bookings: await customerBookings(env, session.customer_id) });
    }

    if (path === "/customer/profile" && request.method === "PUT") {
      let body = {};
      try { body = await request.json(); } catch { /* handled below */ }
      const firstName = clean(body.firstName, 60);
      const lastName = clean(body.lastName, 60);
      const phone = clean(body.phone, 30);
      const streetAddress = clean(body.streetAddress, 180);
      const town = clean(body.town, 100);
      const area = clean(body.area, 100);
      const ruralOption = clean(body.ruralOption, 120);
      const referralSource = clean(body.referralSource, 40);
      const referralDetails = clean(body.referralDetails, 160);
      const accessNotes = clean(body.accessNotes, 1000);
      if (!firstName || !lastName || phone.replace(/\D/g, "").length < 8 || !streetAddress || !town || !Object.hasOwn(RURAL_PRICES, ruralOption)) {
        return json(request, { error: "Please complete your name, phone, address, town and pickup area" }, 400);
      }
      if (!REFERRAL_OPTIONS.has(referralSource)) return json(request, { error: "Choose how you found us" }, 400);
      if (referralSource === "Other" && !referralDetails) return json(request, { error: "Please tell us where you found us" }, 400);
      await env.CUSTOMER_DB.prepare(
        "UPDATE customers SET first_name=?1, last_name=?2, phone=?3, street_address=?4, town=?5, area=?6, rural_option=?7, referral_source=?8, referral_details=?9, access_notes=?10, updated_at=?11 WHERE id=?12"
      ).bind(firstName, lastName, phone, streetAddress, town, area, ruralOption, referralSource, referralDetails, accessNotes, now(), session.customer_id).run();
      return json(request, { ok: true, profile: profileFrom(await customerProfile(env, session.customer_id)) });
    }

    if (path === "/customer/bookings" && request.method === "GET") {
      return json(request, { bookings: await customerBookings(env, session.customer_id) });
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
      if (!profile || !profile.first_name || !profile.phone || !profile.street_address || !profile.town || !Object.hasOwn(RURAL_PRICES, profile.rural_option)) {
        return json(request, { error: "Please finish your profile before booking" }, 400);
      }
      const items = Array.isArray(body.items) ? body.items.map(item => clean(item, 80)).filter(Boolean).slice(0, 10) : [];
      if (!items.length || items.some(item => !Object.hasOwn(ITEM_PRICES, item))) {
        return json(request, { error: "Choose at least one item from the list" }, 400);
      }
      const price = calculate(items, profile.rural_option);
      const createdAt = now();
      const bookingId = `WEB-${createdAt}-${randomToken(6)}`;
      const additionalInfo = clean(body.additionalInfo || profile.access_notes, 1500);
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          `INSERT INTO bookings (
            id, customer_id, status, first_name, last_name, phone, email, street_address, town, area,
            rural_option, items_json, additional_info, referral_source, referral_details,
            total_cents, quote_required, created_at, updated_at
          ) VALUES (?1, ?2, 'NEW', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)`
        ).bind(
          bookingId, session.customer_id, profile.first_name, profile.last_name, profile.phone, profile.email,
          profile.street_address, profile.town, profile.area, profile.rural_option, JSON.stringify(items),
          additionalInfo, profile.referral_source, profile.referral_details, price.cents, price.quoteRequired ? 1 : 0, createdAt
        ),
        env.CUSTOMER_DB.prepare(
          "INSERT INTO booking_events (id, booking_id, event_type, detail, created_at) VALUES (?1, ?2, 'CREATED', 'Customer website', ?3)"
        ).bind(crypto.randomUUID(), bookingId, createdAt)
      ]);
      const booking = await env.CUSTOMER_DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(bookingId).first();
      let sheetBackedUp = true;
      try { await syncBookingToSheet(env, booking); }
      catch (error) {
        sheetBackedUp = false;
        await markSheetFailure(env, bookingId, error);
      }
      await sendMail(env, {
        to: profile.email,
        name: `${profile.first_name} ${profile.last_name}`.trim(),
        subject: "Whiteware Collection",
        text: customerConfirmationText(profile, items, additionalInfo, price)
      });
      await sendMail(env, {
        to: OWNER_EMAIL,
        name: "Woody",
        subject: `Re: Whiteware collection form - ${profile.first_name} ${profile.last_name}`.trim(),
        text: ownerNotificationText(profile, items, additionalInfo, price, bookingId)
      });
      return json(request, { ok: true, booking: bookingFrom(await env.CUSTOMER_DB.prepare("SELECT * FROM bookings WHERE id = ?1").bind(bookingId).first()), sheetBackedUp }, 201);
    }

    if (path === "/customer/logout" && request.method === "POST") {
      await env.CUSTOMER_DB.prepare("DELETE FROM sessions WHERE token_hash = ?1").bind(await hashToken(authToken(request))).run();
      return json(request, { ok: true });
    }
  }

  if (path.startsWith("/owner/")) {
    const session = await sessionFor(request, env, "owner");
    if (!session) return json(request, { error: "Owner login required" }, 401);

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
    if (customerMatch && request.method === "DELETE") {
      const customerId = decodeURIComponent(customerMatch[1]);
      await env.CUSTOMER_DB.batch([
        env.CUSTOMER_DB.prepare(
          "DELETE FROM booking_events WHERE booking_id IN (SELECT id FROM bookings WHERE customer_id = ?1)"
        ).bind(customerId),
        env.CUSTOMER_DB.prepare("DELETE FROM bookings WHERE customer_id = ?1").bind(customerId),
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

    if (path === "/owner/bookings" && request.method === "GET") {
      const rows = await env.CUSTOMER_DB.prepare(
        `SELECT * FROM (
          SELECT id, status, first_name, last_name, phone, email, street_address, town, area,
            rural_option, items_json, additional_info, referral_source, referral_details,
            total_cents, quote_required, sheet_sync_status, 'WEBSITE' AS booking_source,
            pickup_date, pickup_window, customer_note, cancellation_reason, cancelled_at, created_at
          FROM bookings
          UNION ALL
          SELECT id, status, first_name, last_name, phone, email, street_address, town, area,
            rural_option, items_json, additional_info, referral_source, referral_details,
            total_cents, quote_required, sheet_sync_status, 'JOTFORM' AS booking_source,
            pickup_date, pickup_window, customer_note, cancellation_reason, cancelled_at, created_at
          FROM jotform_bookings
          UNION ALL
          SELECT id, status, first_name, last_name, phone, email, street_address, town, area,
            rural_option, items_json, additional_info, '' AS referral_source, '' AS referral_details,
            total_cents, quote_required, 'PICKUP_RUN' AS sheet_sync_status, 'PICKUP_RUN' AS booking_source,
            pickup_date, pickup_window, customer_note, cancellation_reason, cancelled_at, created_at
          FROM external_bookings WHERE status='CANCELLED'
        ) ORDER BY CASE status WHEN 'NEW' THEN 0 ELSE 1 END, created_at DESC LIMIT 300`
      ).all();
      return json(request, { bookings: (rows.results || []).map(bookingFrom) });
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
      const updatedAt = now();
      const result = await env.CUSTOMER_DB.prepare(
        `UPDATE ${table} SET status=?1, pickup_date=?2, pickup_window=?3, customer_note=?4,
          updated_at=?5${jotform || pickupRun ? ", completed_at = CASE WHEN ?1='COMPLETED' THEN COALESCE(completed_at, ?5) ELSE NULL END" : ""}
         WHERE id=?6`
      ).bind(status, pickupDate, pickupWindow, customerNote, updatedAt, bookingId).run();
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
      if (body.notifyCustomer && status === "CONFIRMED") {
        await sendMail(env, {
          to: updated.email,
          name: `${updated.first_name || ""} ${updated.last_name || ""}`.trim(),
          subject: `Whiteware pickup confirmed - ${pickupDateText(pickupDate)}`,
          text: pickupConfirmationText(updated, pickupDate, pickupWindow, customerNote)
        });
      }
      updated.booking_source = jotform ? "JOTFORM" : pickupRun ? "PICKUP_RUN" : "WEBSITE";
      return json(request, { ok: true, booking: bookingFrom(updated) });
    }
  }

  return json(request, { error: "Not found" }, 404);
}
