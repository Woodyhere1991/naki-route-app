const GMS_PLACE_ID = "ChIJI-iQUfZQFG0RorGmjzvMPRE";
const APP_ORIGINS = new Set([
  "https://naki-pickup-run.pages.dev",
  "https://naki-route-app.pages.dev"
]);

function allowedOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  return APP_ORIGINS.has(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || /^https:\/\/[a-z0-9]+\.naki-pickup-run\.pages\.dev$/.test(origin);
}

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigin(request);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://naki-pickup-run.pages.dev",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

function json(request, data, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, ...cors(request) }
  });
}

function number(value, fallback = 0) {
  const out = Number(value);
  return Number.isFinite(out) ? out : fallback;
}

function dateFromGoogle(display) {
  if (!display || !display.year || !display.month || !display.day) return "";
  return `${String(display.year).padStart(4, "0")}-${String(display.month).padStart(2, "0")}-${String(display.day).padStart(2, "0")}`;
}

function cacheRequest(request, path, parts = []) {
  const origin = request.headers.get("Origin") || "none";
  const params = new URLSearchParams({ origin, value: parts.join("|") });
  return new Request(`https://naki-route-cache.invalid/${path}?${params}`);
}

function noStore(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function cached(request, key, seconds, producer) {
  const store = caches.default;
  const hit = await store.match(key);
  if (hit) return noStore(hit);
  const response = await producer();
  if (response.ok) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", `public, max-age=${seconds}`);
    await store.put(key, new Response(response.clone().body, { status: response.status, statusText: response.statusText, headers }));
  }
  return noStore(response);
}

function weatherCode(code) {
  if (code === 0) return ["Sunny", "CLEAR"];
  if (code <= 3) return ["Partly cloudy", "PARTLY_CLOUDY"];
  if (code <= 48) return ["Fog", "FOG"];
  if (code <= 57) return ["Drizzle", "DRIZZLE"];
  if (code <= 67) return ["Rain", "RAIN"];
  if (code <= 77) return ["Snow", "SNOW"];
  if (code <= 82) return ["Showers", "SHOWERS"];
  if (code <= 86) return ["Snow showers", "SNOW_SHOWERS"];
  return ["Thunderstorms", "THUNDERSTORMS"];
}

async function openMeteoWeather(location) {
  const params = new URLSearchParams({
    latitude: Number(location.lat).toFixed(5),
    longitude: Number(location.lng).toFixed(5),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max",
    timezone: "Pacific/Auckland",
    forecast_days: "7"
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) throw new Error(`Fallback weather ${response.status}`);
  const payload = await response.json();
  const daily = payload.daily || {};
  const days = (daily.time || []).slice(0, 7).map((date, i) => {
    const condition = weatherCode(number((daily.weather_code || [])[i], 3));
    const rainChance = Math.round(number((daily.precipitation_probability_max || [])[i]));
    const rainMm = Math.round(number((daily.precipitation_sum || [])[i]) * 10) / 10;
    const wind = Math.round(number((daily.wind_speed_10m_max || [])[i]));
    const gust = Math.round(number((daily.wind_gusts_10m_max || [])[i]));
    const alerts = [];
    if (rainChance >= 70 || rainMm >= 15) alerts.push("Heavy rain possible");
    else if (rainChance >= 50 || rainMm >= 5) alerts.push("Rain likely");
    if (gust >= 70) alerts.push("Severe wind gusts");
    else if (gust >= 50) alerts.push("Strong wind");
    return {
      date,
      condition: condition[0],
      condition_type: condition[1],
      high: Math.round(number((daily.temperature_2m_max || [])[i]) * 10) / 10,
      low: Math.round(number((daily.temperature_2m_min || [])[i]) * 10) / 10,
      rain_chance: rainChance,
      rain_mm: rainMm,
      wind,
      gust,
      alerts
    };
  });
  if (!days.length) throw new Error("No fallback forecast returned");
  return { name: location.name, lat: Number(location.lat), lng: Number(location.lng), days, source: "Open-Meteo fallback" };
}

async function weatherFor(location, key) {
  const params = new URLSearchParams({
    key,
    "location.latitude": Number(location.lat).toFixed(5),
    "location.longitude": Number(location.lng).toFixed(5),
    days: "7",
    pageSize: "7",
    unitsSystem: "METRIC"
  });
  const response = await fetch(`https://weather.googleapis.com/v1/forecast/days:lookup?${params}`);
  if (!response.ok) throw new Error(`Weather ${response.status}`);
  const payload = await response.json();
  const days = (payload.forecastDays || []).slice(0, 7).map(row => {
    const daytime = row.daytimeForecast || {};
    const nighttime = row.nighttimeForecast || {};
    const dayCondition = daytime.weatherCondition || {};
    const nightCondition = nighttime.weatherCondition || {};
    const dayRain = (((daytime.precipitation || {}).probability || {}).percent);
    const nightRain = (((nighttime.precipitation || {}).probability || {}).percent);
    const dayQpf = (((daytime.precipitation || {}).qpf || {}).quantity);
    const nightQpf = (((nighttime.precipitation || {}).qpf || {}).quantity);
    const dayWind = daytime.wind || {};
    const nightWind = nighttime.wind || {};
    const rainChance = Math.round(Math.max(number(dayRain), number(nightRain)));
    const rainMm = Math.round((number(dayQpf) + number(nightQpf)) * 10) / 10;
    const wind = Math.round(Math.max(number((dayWind.speed || {}).value), number((nightWind.speed || {}).value)));
    const gust = Math.round(Math.max(number((dayWind.gust || {}).value), number((nightWind.gust || {}).value)));
    const alerts = [];
    if (rainChance >= 70 || rainMm >= 15) alerts.push("Heavy rain possible");
    else if (rainChance >= 50 || rainMm >= 5) alerts.push("Rain likely");
    if (gust >= 70) alerts.push("Severe wind gusts");
    else if (gust >= 50) alerts.push("Strong wind");
    return {
      date: dateFromGoogle(row.displayDate),
      condition: (((dayCondition.description || {}).text) || ((nightCondition.description || {}).text) || "Forecast"),
      condition_type: dayCondition.type || nightCondition.type || "",
      high: Math.round(number((row.maxTemperature || {}).degrees) * 10) / 10,
      low: Math.round(number((row.minTemperature || {}).degrees) * 10) / 10,
      rain_chance: rainChance,
      rain_mm: rainMm,
      wind,
      gust,
      alerts
    };
  }).filter(day => day.date);
  if (!days.length) throw new Error("No forecast returned");
  return { name: location.name, lat: Number(location.lat), lng: Number(location.lng), days, source: "Google Weather" };
}

async function resilientWeather(location, key) {
  if (key) {
    try { return await weatherFor(location, key); }
    catch { /* use the no-cost fallback below */ }
  }
  return openMeteoWeather(location);
}

async function handleWeather(request, env) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const seen = new Set();
  const locations = [];
  for (const item of Array.isArray(body.locations) ? body.locations.slice(0, 12) : []) {
    const name = String(item && item.name || "").trim().slice(0, 80);
    const lat = Number(item && item.lat), lng = Number(item && item.lng);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -40.3 || lat > -38.4 || lng < 173.4 || lng > 175.3) continue;
    const id = `${name.toLowerCase()}|${lat.toFixed(3)}|${lng.toFixed(3)}`;
    if (!seen.has(id)) { seen.add(id); locations.push({ name, lat, lng }); }
  }
  if (!locations.length) return json(request, { error: "No pickup towns were found", towns: [] }, 400);
  const key = cacheRequest(request, "weather-v2", locations.map(location => `${location.name.toLowerCase()},${location.lat.toFixed(3)},${location.lng.toFixed(3)}`).sort());
  return cached(request, key, 10800, async () => {
    const settled = await Promise.allSettled(locations.map(location => resilientWeather(location, env.GOOGLE_API_KEY)));
    const towns = settled.filter(x => x.status === "fulfilled").map(x => x.value);
    const failed = settled.map((x, i) => x.status === "rejected" ? locations[i].name : "").filter(Boolean);
    if (!towns.length) return json(request, { error: "Live weather could not be loaded", towns: [], failed }, 502);
    const fallback = towns.some(town => town.source !== "Google Weather");
    return json(request, { towns, failed, updated_at: new Date().toISOString(), source: fallback ? "Weather fallback" : "Google Weather" }, 200, "public, max-age=10800");
  });
}

function clockLabel(hour, minute) {
  const suffix = hour < 12 ? "AM" : "PM";
  return `${hour % 12 || 12}:${String(minute || 0).padStart(2, "0")} ${suffix}`;
}

function periodsLabel(periods) {
  if (!periods.length) return "Closed";
  return periods.map(period => {
    const open = period.open || {}, close = period.close || {};
    return `${clockLabel(number(open.hour), number(open.minute))}–${clockLabel(number(close.hour), number(close.minute))}`;
  }).join(", ");
}

function signature(periods) {
  return periods.map(period => {
    const open = period.open || {}, close = period.close || {};
    return `${number(open.hour)}:${number(open.minute)}-${number(close.hour)}:${number(close.minute)}`;
  }).join("|");
}

function aucklandToday() {
  const parts = new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const get = type => number((parts.find(p => p.type === type) || {}).value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

function isoDate(date) { return date.toISOString().slice(0, 10); }

function gmsFallback(request) {
  const base = aucklandToday();
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = new Date(base.getTime() + offset * 86400000);
    const open = date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
    days.push({
      date: isoDate(date),
      label: offset === 0 ? "Today" : names[date.getUTCDay()],
      date_label: `${date.getUTCDate()} ${months[date.getUTCMonth()]}`,
      hours: open ? "7:00 AM–5:00 PM" : "Closed",
      closed: !open,
      normally_closed: !open,
      special: false
    });
  }
  const today = days[0];
  const summary = `GMS usual hours today · ${today.hours} · live check unavailable`;
  const message = "Live closure checking is temporarily unavailable. Check Google Maps before driving there.";
  return json(request, {
    status: "fallback",
    live: false,
    name: "Global Metal Solutions - New Plymouth",
    address: "146 Connett Road, Bell Block",
    business_status: "UNKNOWN",
    open_now: !today.closed,
    summary,
    level: "warning",
    attention: true,
    notification_message: message,
    notification_key: `${isoDate(base)}|fallback`,
    days,
    source_url: "https://maps.google.com/?q=Global+Metal+Solutions+New+Plymouth",
    website_url: "https://www.gmsgroup.nz/new-plymouth",
    updated_at: new Date().toISOString()
  }, 200, "public, max-age=900");
}

async function handleGmsLive(request, env) {
  if (!env.GOOGLE_API_KEY) return gmsFallback(request);
  const response = await fetch(`https://places.googleapis.com/v1/places/${GMS_PLACE_ID}`, {
    headers: {
      "Accept": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_API_KEY,
      "X-Goog-FieldMask": "id,displayName,formattedAddress,businessStatus,currentOpeningHours,regularOpeningHours,googleMapsUri,websiteUri"
    }
  });
  if (!response.ok) return gmsFallback(request);
  const payload = await response.json();
  const current = payload.currentOpeningHours || {};
  const regular = payload.regularOpeningHours || {};
  const currentByDate = new Map();
  for (const period of current.periods || []) {
    const date = (period.open || {}).date;
    const key = dateFromGoogle(date);
    if (!key) continue;
    if (!currentByDate.has(key)) currentByDate.set(key, []);
    currentByDate.get(key).push(period);
  }
  const regularByDay = new Map();
  for (const period of regular.periods || []) {
    const day = number((period.open || {}).day, -1);
    if (day < 0) continue;
    if (!regularByDay.has(day)) regularByDay.set(day, []);
    regularByDay.get(day).push(period);
  }
  const base = aucklandToday();
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const days = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = new Date(base.getTime() + offset * 86400000);
    const key = isoDate(date), googleDay = date.getUTCDay();
    const actual = currentByDate.get(key) || [];
    const usual = regularByDay.get(googleDay) || [];
    days.push({
      date: key,
      label: offset === 0 ? "Today" : names[googleDay],
      date_label: `${date.getUTCDate()} ${months[date.getUTCMonth()]}`,
      hours: periodsLabel(actual),
      closed: !actual.length,
      normally_closed: !usual.length,
      special: signature(actual) !== signature(usual)
    });
  }
  const today = days[0];
  const futureSpecial = days.slice(1).find(day => day.special);
  const status = payload.businessStatus || "";
  let summary = `GMS New Plymouth open today · ${today.hours}`;
  let message = "", level = "ok";
  if (status && status !== "OPERATIONAL") {
    summary = "GMS New Plymouth is not showing as operational";
    message = "Global Metal Solutions is not showing as operational. Check before driving there.";
    level = "danger";
  } else if (today.closed) {
    summary = "GMS New Plymouth is closed today";
    message = "Global Metal Solutions is closed today.";
    level = "danger";
  }
  if (futureSpecial) {
    summary += ` · ${futureSpecial.label}: ${futureSpecial.hours}`;
    message = `GMS has special hours ${futureSpecial.label}: ${futureSpecial.hours}.`;
    if (level === "ok") level = "warning";
  }
  return json(request, {
    status: "ok",
    live: true,
    name: ((payload.displayName || {}).text) || "Global Metal Solutions - New Plymouth",
    address: payload.formattedAddress || "146 Connett Road, Bell Block",
    business_status: status,
    open_now: Boolean(current.openNow),
    summary,
    level,
    attention: Boolean(message),
    notification_message: message,
    notification_key: `${isoDate(base)}|${message}`,
    days,
    source_url: payload.googleMapsUri || "https://maps.google.com/?q=Global+Metal+Solutions+New+Plymouth",
    website_url: payload.websiteUri || "https://www.gmsgroup.nz/new-plymouth",
    updated_at: new Date().toISOString()
  }, 200, "public, max-age=10800");
}

async function handleGms(request, env) {
  const key = cacheRequest(request, "gms-hours-v2", [isoDate(aucklandToday())]);
  return cached(request, key, 10800, async () => {
    try { return await handleGmsLive(request, env); }
    catch { return gmsFallback(request); }
  });
}

async function handleAddress(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 180);
  const limit = Math.max(1, Math.min(6, number(url.searchParams.get("limit"), 6)));
  if (q.length < 3) return json(request, { results: [] });
  const key = cacheRequest(request, "address-v2", [q.toLowerCase(), String(limit)]);
  return cached(request, key, 2592000, async () => {
    const address = /new zealand|\bnz\b/i.test(q) ? q : `${q}, Taranaki, New Zealand`;
    if (env.GOOGLE_API_KEY) {
      try {
        const params = new URLSearchParams({ address, key: env.GOOGLE_API_KEY, region: "nz", components: "country:NZ" });
        const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
        if (response.ok) {
          const payload = await response.json();
          const results = (payload.results || []).slice(0, limit).map(result => ({
            label: String(result.formatted_address || "").replace(/, New Zealand$/, ""),
            lat: number((((result.geometry || {}).location || {}).lat), NaN),
            lng: number((((result.geometry || {}).location || {}).lng), NaN)
          })).filter(result => result.label && Number.isFinite(result.lat) && Number.isFinite(result.lng));
          if (results.length) return json(request, { results, source: "Google" }, 200, "public, max-age=2592000");
        }
      } catch { /* use the no-cost fallback below */ }
    }
    try {
      const params = new URLSearchParams({ format: "json", addressdetails: "1", countrycodes: "nz", limit: String(limit), q: address });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { "Accept": "application/json", "User-Agent": "NakiPickupRun/1.0 (nakiwreckremoval@gmail.com)" }
      });
      if (response.ok) {
        const payload = await response.json();
        const results = (payload || []).map(result => ({
          label: String(result.display_name || "").split(",").slice(0, 4).join(",").trim(),
          lat: number(result.lat, NaN),
          lng: number(result.lon, NaN)
        })).filter(result => result.label && Number.isFinite(result.lat) && Number.isFinite(result.lng));
        return json(request, { results, source: "OpenStreetMap fallback" }, 200, "public, max-age=2592000");
      }
    } catch { /* return a clean miss below */ }
    return json(request, { results: [], source: "fallback unavailable" }, 200, "public, max-age=900");
  });
}

// Email a receipt PDF straight to the customer via Woody's own Brevo account
// (sender nakiwreckremoval@gmail.com is Brevo-verified; replies go to the
// Naki Whiteware Removal address). Key lives in the BREVO_API_KEY secret.
async function handleSendReceipt(request, env) {
  if (!mailConfigured(env)) return json(request, { error: "Email sending is not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json(request, { error: "Bad request" }, 400); }
  const to = String(body.to || "").trim();
  const name = String(body.name || "").trim().slice(0, 80);
  const pdf = String(body.pdfBase64 || "");
  const filename = (String(body.filename || "").replace(/[^\w .\-]/g, "").slice(0, 80)) || "Receipt.pdf";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(request, { error: "Invalid email address" }, 400);
  if (!/^[A-Za-z0-9+/=]+$/.test(pdf) || pdf.length < 100 || pdf.length > 2000000) return json(request, { error: "Invalid PDF" }, 400);
  const first = name.split(/\s+/)[0] || "";
  const sent = await sendMail(env, {
    to, name,
    subject: "Your whiteware collection receipt",
    text: `Hey${first ? " " + first : ""},\n\nThanks heaps! Your receipt for the whiteware collection is attached.\n\nCheers,\nWoody\nNaki Whiteware Removal\nnakiwhitewareremoval@gmail.com`,
    attachment: [{ name: filename, content: pdf }]
  });
  if (!sent) return json(request, { error: "Email could not be sent" }, 502);
  return json(request, { ok: true });
}

// Bulk confirmations/reminders: one personalised email per customer (not one
// BCC blob), sent through the same Brevo account as the receipts. Capped at 40
// per call — well inside Brevo's 300/day and the worker's subrequest budget.
async function handleSendBulk(request, env) {
  if (!mailConfigured(env)) return json(request, { error: "Email sending is not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json(request, { error: "Bad request" }, 400); }
  const subject = (String(body.subject || "").trim().slice(0, 150)) || "Whiteware collection";
  const list = Array.isArray(body.messages) ? body.messages.slice(0, 40) : [];
  if (!list.length) return json(request, { error: "No messages" }, 400);
  const emailOk = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
  let sent = 0;
  const failed = [];
  for (const m of list) {
    const to = String(m && m.to || "").trim();
    const name = String(m && m.name || "").trim().slice(0, 80);
    const text = String(m && m.body || "").trim().slice(0, 4000);
    if (!emailOk(to) || !text) { failed.push(to || "(blank)"); continue; }
    if (sent) await new Promise(r => setTimeout(r, 400));   // gentle pacing — a run of 40 looks human
    const ok = await sendMail(env, { to, name, subject, text });
    if (ok) sent++; else failed.push(to);
  }
  return json(request, { ok: true, sent, failed });
}

/* ---------- Email sending ----------
   Gmail API first (genuine gmail.com mail — passes DMARC, lands in the primary
   inbox, shows in Woody's Sent folder). Brevo is the automatic fallback.
   Why: Brevo sends "From: nakiwreckremoval@gmail.com" from non-Google servers,
   which Yahoo/Xtra/Hotmail reject outright (DMARC) and Gmail tags "via brevosend". */
let gmailTok = { token: "", exp: 0 };
async function gmailAccessToken(env) {
  if (gmailTok.token && Date.now() < gmailTok.exp - 60000) return gmailTok.token;
  const body = new URLSearchParams({
    client_id: String(env.GMAIL_CLIENT_ID || "").trim(),
    client_secret: String(env.GMAIL_CLIENT_SECRET || "").trim(),
    refresh_token: String(env.GMAIL_REFRESH_TOKEN || "").trim(),
    grant_type: "refresh_token"
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (!r.ok) throw new Error(`gmail token ${r.status}`);
  const out = await r.json();
  gmailTok = { token: out.access_token, exp: Date.now() + (out.expires_in || 3600) * 1000 };
  return gmailTok.token;
}

// UTF-8-safe base64 (btoa alone chokes on macrons in customer names).
function textToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function buildMime({ to, name, subject, text, attachment }) {
  const toHeader = name ? `"${name.replace(/["\r\n]/g, "")}" <${to}>` : to;
  const head = [
    "From: Naki Whiteware Removal <nakiwreckremoval@gmail.com>",
    `To: ${toHeader}`,
    "Reply-To: Naki Whiteware Removal <nakiwhitewareremoval@gmail.com>",
    `Subject: ${subject.replace(/[\r\n]/g, " ")}`,
    "MIME-Version: 1.0"
  ];
  if (attachment && attachment.length) {
    const B = "nakimail_boundary_2718";
    const parts = [
      `Content-Type: multipart/mixed; boundary="${B}"`, "",
      `--${B}`,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64", "",
      textToB64(text), ""
    ];
    for (const a of attachment) {
      const fname = String(a.name || "attachment.pdf").replace(/["\r\n]/g, "");
      parts.push(
        `--${B}`,
        `Content-Type: application/pdf; name="${fname}"`,
        `Content-Disposition: attachment; filename="${fname}"`,
        "Content-Transfer-Encoding: base64", "",
        String(a.content).replace(/(.{76})/g, "$1\r\n"), ""
      );
    }
    parts.push(`--${B}--`);
    return head.concat(parts).join("\r\n");
  }
  return head.concat([
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64", "",
    textToB64(text)
  ]).join("\r\n");
}

async function sendGmail(env, msg) {
  if (!env.GMAIL_REFRESH_TOKEN) return false;
  try {
    const tok = await gmailAccessToken(env);
    const raw = textToB64(buildMime(msg)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw })
    });
    return r.ok;
  } catch { return false; }
}

// One front door: Gmail first, Brevo fallback so a Google hiccup never loses a send.
async function sendMail(env, msg) {
  if (await sendGmail(env, msg)) return true;
  return sendBrevo(env, msg);
}

function mailConfigured(env) { return Boolean(env.GMAIL_REFRESH_TOKEN || env.BREVO_API_KEY); }

// Brevo sender — now the fallback path only.
async function sendBrevo(env, { to, name, subject, text, attachment }) {
  if (!env.BREVO_API_KEY) return false;
  const payload = {
    sender: { name: "Naki Whiteware Removal", email: "nakiwreckremoval@gmail.com" },
    replyTo: { name: "Naki Whiteware Removal", email: "nakiwhitewareremoval@gmail.com" },
    to: [{ email: to, ...(name ? { name } : {}) }],
    subject,
    textContent: text,
    ...(attachment ? { attachment } : {})
  };
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": String(env.BREVO_API_KEY).trim(), "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload)
    });
    return response.ok;
  } catch { return false; }
}

const BANK_LINE = "Bank account: 06-0709-0967040-00  (TRADING AS NWR)";
const REF_LINE = "Reference: please use your name or address, as it was on the collection form";

function firstName(name) { return String(name || "").trim().split(/\s+/)[0] || ""; }

function invoiceText(name, amount) {
  const first = firstName(name);
  const amt = Number.isFinite(Number(amount)) ? ` for $${Number(amount).toFixed(2)}` : "";
  return `Hi${first ? " " + first : ""},\n\nYour invoice${amt} for the whiteware collection is attached.\n\n${BANK_LINE}\n${REF_LINE}\n\nCheers,\nWoody\nNaki Whiteware Removal\nnakiwhitewareremoval@gmail.com`;
}

function reminderText(name, amount) {
  const first = firstName(name);
  const amt = Number.isFinite(Number(amount)) ? ` of $${Number(amount).toFixed(2)}` : "";
  return `Hi${first ? " " + first : ""},\n\nJust a friendly reminder about the payment${amt} for your whiteware collection.\n\n${BANK_LINE}\n${REF_LINE}\n\nIf you've already paid, thanks heaps — please ignore this.\n\nCheers,\nWoody\nNaki Whiteware Removal\nnakiwhitewareremoval@gmail.com`;
}

// Email the invoice PDF now and, if asked, park a reminder in KV for the cron.
async function handleSendInvoice(request, env) {
  if (!mailConfigured(env)) return json(request, { error: "Email sending is not configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return json(request, { error: "Bad request" }, 400); }
  const to = String(body.to || "").trim();
  const name = String(body.name || "").trim().slice(0, 80);
  const pdf = String(body.pdfBase64 || "");
  const filename = (String(body.filename || "").replace(/[^\w .\-]/g, "").slice(0, 80)) || "Invoice.pdf";
  const amount = Number(body.amount);
  const reminderDate = String(body.reminderDate || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(request, { error: "Invalid email address" }, 400);
  if (!/^[A-Za-z0-9+/=]+$/.test(pdf) || pdf.length < 100 || pdf.length > 2000000) return json(request, { error: "Invalid PDF" }, 400);
  const sent = await sendMail(env, {
    to, name,
    subject: "Invoice - whiteware collection",
    text: invoiceText(name, amount),
    attachment: [{ name: filename, content: pdf }]
  });
  if (!sent) return json(request, { error: "Email could not be sent" }, 502);
  // Reminder: only for a real future-or-today date, and only if KV is bound.
  let reminderId = "";
  if (env.REMINDERS && /^\d{4}-\d{2}-\d{2}$/.test(reminderDate) && reminderDate >= isoDate(aucklandToday())) {
    reminderId = crypto.randomUUID();
    await env.REMINDERS.put(`rem:${reminderId}`, JSON.stringify({ to, name, amount: Number.isFinite(amount) ? amount : null, date: reminderDate }), { expirationTtl: 60 * 60 * 24 * 120 });
  }
  return json(request, { ok: true, reminderId });
}

// Customer paid: drop their queued reminder.
async function handleCancelReminder(request, env) {
  if (!env.REMINDERS) return json(request, { ok: true, note: "No reminder store" });
  let body;
  try { body = await request.json(); } catch { return json(request, { error: "Bad request" }, 400); }
  const id = String(body.id || "").trim();
  if (!/^[\w-]{8,64}$/.test(id)) return json(request, { error: "Invalid reminder id" }, 400);
  await env.REMINDERS.delete(`rem:${id}`);
  return json(request, { ok: true });
}

// Send every reminder whose day has arrived (NZ time), then forget it.
async function runReminders(env) {
  if (!env.REMINDERS || !mailConfigured(env)) return { sent: 0, note: "Not configured" };
  const today = isoDate(aucklandToday());
  let sent = 0, failed = 0, cursor;
  do {
    const page = await env.REMINDERS.list({ prefix: "rem:", cursor });
    for (const key of page.keys) {
      const raw = await env.REMINDERS.get(key.name);
      if (!raw) continue;
      let r;
      try { r = JSON.parse(raw); } catch { await env.REMINDERS.delete(key.name); continue; }
      if (!r.date || r.date > today) continue;   // not due yet
      const ok = await sendMail(env, { to: r.to, name: r.name, subject: "Payment reminder - whiteware collection", text: reminderText(r.name, r.amount) });
      if (ok) { await env.REMINDERS.delete(key.name); sent++; }
      else failed++;                             // left in KV — retried on the next run
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { sent, failed, date: today };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (!allowedOrigin(request)) return json(request, { error: "This service is only available to the Naki Pickup Run app" }, 403);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/v2/, "");
    try {
      if (path === "/weather" && request.method === "POST") return await handleWeather(request, env);
      if (path === "/gms-hours" && request.method === "GET") return await handleGms(request, env);
      if (path === "/address-search" && request.method === "GET") return await handleAddress(request, env);
      if (path === "/send-receipt" && request.method === "POST") return await handleSendReceipt(request, env);
      if (path === "/send-bulk" && request.method === "POST") return await handleSendBulk(request, env);
      if (path === "/send-invoice" && request.method === "POST") return await handleSendInvoice(request, env);
      if (path === "/cancel-reminder" && request.method === "POST") return await handleCancelReminder(request, env);
      if (path === "/run-reminders" && request.method === "GET") return json(request, await runReminders(env));
      return json(request, { error: "Not found" }, 404);
    } catch (error) {
      return json(request, { error: "Live service could not be loaded" }, 502);
    }
  },
  // Daily at 21:00 UTC = 9am NZST (10am NZDT): send any due payment reminders.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
  }
};
