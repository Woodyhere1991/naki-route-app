import { OWNER_ACTIONS, ownerAction } from "./owner-actions.js";
import { handleIntegrationApi, purgeApiRequests } from "./integration-api.js";
import { recordKidsActivity, purgeKidsActivity } from "./kids-activity.js";
import { loginSender } from "./login-mail.js";
import { AuthMailError } from "./auth-limits.js";
import { metWeather } from "./field-weather.js";
import { LIVE_SESSION_PATH, RECEPTION_QUOTE_PATH, liveSession, receptionQuote } from "./live-voice.js";
import { isPhonePath, phoneIncoming, phoneStream, ReceptionCall } from "./phone-reception.js";
import { handlePortalRequest, retryPendingSheetBackups, purgeExpiredAuth, purgeOldPhotos, recordBookingDocument, snapshotDatabase, sessionFor } from "./customer.js";

const GMS_PLACE_ID = "ChIJI-iQUfZQFG0RorGmjzvMPRE";

// Where every receipt email points people to leave feedback. Google wins when it's
// set — it's the listing that actually drives local search. The Find My Local link
// stays as the fallback if the Google one is ever cleared out.
const GOOGLE_REVIEW_URL = "https://g.page/r/CQPARM-ojFNrEBM/review";
const FIND_MY_LOCAL_REVIEW_URL = "https://findmylocal.nz/listing/naki-whiteware-removal/#reply-title";
const REVIEW_URL = GOOGLE_REVIEW_URL || FIND_MY_LOCAL_REVIEW_URL;
const REVIEW_PLACE = GOOGLE_REVIEW_URL ? "Google" : "Find My Local";
const APP_ORIGINS = new Set([
  "https://naki-pickup-run.pages.dev",
  "https://naki-route-app.pages.dev",
  "https://naki-collection.pages.dev",
  "https://nakiwhitewareremoval.vip",
  "https://www.nakiwhitewareremoval.vip"
]);

function allowedOrigin(request) {
  const origin = request.headers.get("Origin") || "";
  return APP_ORIGINS.has(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    /^https:\/\/[a-z0-9]+\.naki-pickup-run\.pages\.dev$/.test(origin) ||
    /^https:\/\/[a-z0-9]+\.naki-collection\.pages\.dev$/.test(origin);
}

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigin(request);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://naki-pickup-run.pages.dev",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key",
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
    let keep = true;
    try {
      const data = await response.clone().json();
      if (data && Array.isArray(data.results) && data.results.length === 0) keep = false;
    } catch { /* not an address payload */ }
    if (keep) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", `public, max-age=${seconds}`);
      await store.put(key, new Response(response.clone().body, { status: response.status, statusText: response.statusText, headers }));
    }
  }
  return noStore(response);
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
  const response = await fetch(`https://weather.googleapis.com/v1/forecast/days:lookup?${params}`,{signal:AbortSignal.timeout(10000)});
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
    if (rainMm >= 15) alerts.push("Wet day — 15 mm or more forecast");
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
  return metWeather(location);
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
  const key = cacheRequest(request, "weather-v3", locations.map(location => `${location.name.toLowerCase()},${location.lat.toFixed(3)},${location.lng.toFixed(3)}`).sort());
  return cached(request, key, 1800, async () => {
    const settled = await Promise.allSettled(locations.map(location => resilientWeather(location, env.GOOGLE_API_KEY)));
    const towns = settled.filter(x => x.status === "fulfilled").map(x => x.value);
    const failed = settled.map((x, i) => x.status === "rejected" ? locations[i].name : "").filter(Boolean);
    if (!towns.length) return json(request, { error: "Live weather could not be loaded", towns: [], failed }, 502);
    const fallback = towns.some(town => town.source !== "Google Weather");
    return json(request, { towns, failed, updated_at: new Date().toISOString(), source: fallback ? "Weather fallback" : "Google Weather" }, 200, "public, max-age=1800");
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

// "New Plymouth" is both a city and the district that contains Inglewood, Waitara,
// Ōakura and friends, so Google will happily answer "81 Rata Street, New Plymouth"
// with the Inglewood house. Pull the town out of the query so we can check the answer
// actually landed in that town, and re-ask with a hard locality filter when it didn't.
function townFromQuery(q) {
  const parts = String(q).split(",").map(part => part.trim()).filter(Boolean);
  for (const part of parts.slice(1)) {
    const town = part.replace(/\b\d{4}\b/g, "").trim();
    if (!town) continue;
    if (/^(taranaki|new zealand|nz|aotearoa)$/i.test(town)) continue;
    return town;
  }
  return "";
}

function looseKey(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function labelInTown(label, town) {
  if (!town) return true;
  return looseKey(label).includes(looseKey(town));
}

// The last real place name in a query before the region, e.g.
//   "201 Lincoln Road, Waitoriki"        -> "Waitoriki"
//   "201 Lincoln Road, Inglewood"        -> "Inglewood"
// Region-only parts are ignored, so "Inglewood, Taranaki, New Zealand" yields "Inglewood".
function suburbFromQuery(q) {
  const parts = String(q || "").split(",").map(part => part.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i -= 1) {
    const value = parts[i].replace(/\b\d{4}\b/g, "").trim();
    if (!value) continue;
    if (/^(taranaki|new zealand|nz|aotearoa)$/i.test(value)) continue;
    return value;
  }
  return "";
}

/* Does this label name a suburb the caller did not ask for?

   Inglewood holds TWO Lincoln Roads, so the town match cannot separate them:

     "Lincoln Road, Waitoriki, Inglewood, ..."   <- unexpected suburb
     "Lincoln Road, Inglewood, ..."              <- no extra suburb

   Only a suspect is flagged; a good match is never hidden. When the caller DID name the
   suburb ("... Waitoriki"), it is expected and nothing is flagged. */
function suburbUnexpected(label, wantSuburb, town) {
  if (!town) return false;
  const key = looseKey(label);
  const townKey = looseKey(town);
  const wantKey = looseKey(wantSuburb);
  if (wantKey && wantKey !== townKey && key.includes(wantKey)) return false;
  const parent = DISTRICT_PARENT[townKey] || [];
  return TARANAKI_LOCALITIES.some(place => {
    if (place === townKey || parent.includes(place)) return false;
    return key.includes(place);
  });
}

/* New Plymouth district covers Oakura, Inglewood, Waitara. LINZ often prints
   the district, not the coastal locality, so "Pitone, New Plymouth" is the
   right letterbox for an Oakura rural RAPID — not an unexpected town. */
const DISTRICT_PARENT = Object.freeze({
  oakura: ["newplymouth"], inglewood: ["newplymouth"], waitara: ["newplymouth"],
  bellblock: ["newplymouth"], okato: ["newplymouth"], omata: ["newplymouth"],
  urenui: ["newplymouth"], lepperton: ["newplymouth"], tikorangi: ["newplymouth"],
  motunui: ["newplymouth"], onaero: ["newplymouth"], pitone: ["newplymouth"],
  tarurutangi: ["newplymouth"], koru: ["newplymouth"], tataraimaka: ["newplymouth"]
});

function collapseExtraRepeats(text) {
  return String(text == null ? "" : text).replace(/([A-Za-z])\1{2,}/g, "$1$1");
}

function inTaranakiPoint(p) {
  const lat = Number(p && p.lat), lng = Number(p && p.lng);
  return lat < -38.35 && lat > -40.15 && lng > 173.45 && lng < 175.35;
}

function kmBetween(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

const TOWN_CENTRES = Object.freeze({
  inglewood: { lat: -39.161, lng: 174.207 }, hawera: { lat: -39.591, lng: 174.284 },
  patea: { lat: -39.757, lng: 174.476 }, oakura: { lat: -39.117, lng: 173.953 },
  newplymouth: { lat: -39.056, lng: 174.075 }, waitara: { lat: -39.001, lng: 174.238 },
  stratford: { lat: -39.337, lng: 174.284 }, eltham: { lat: -39.429, lng: 174.299 },
  bellblock: { lat: -39.032, lng: 174.148 }, okato: { lat: -39.195, lng: 173.880 },
  waverley: { lat: -39.769, lng: 174.614 }, normanby: { lat: -39.541, lng: 174.287 },
  manaia: { lat: -39.551, lng: 174.125 }, opunake: { lat: -39.455, lng: 173.858 },
  urenui: { lat: -38.995, lng: 174.390 }
});

function townCentre(town) {
  return TOWN_CENTRES[looseKey(town)] || null;
}

/* Rank lookup rows so a single-result caller gets the road in the town they typed.

   Inglewood has two Lincoln Roads. Google/OSM often put the Waitoriki one first.
   Navigate already sends the typed address (Google Maps then lands on the township
   road). The in-app pin used results[0], so stop 9 could sit by the school while
   Navigate was correct. Prefer a letterbox without an unexpected suburb when one
   exists; if the only hit is that suburb, keep it. */
function addressResultScore(result, q) {
  const label = result && result.label || "";
  const town = townFromQuery(q);
  const wantSuburb = suburbFromQuery(q);
  const physical = physicalAddressQuery(q);
  const want = houseNumberOf(physical);
  let n = 0;
  if (want && addressMatchScore(physical, label) > 0) n += 16;
  if (town && !suburbUnexpected(label, wantSuburb, town)) n += 8;
  if (town && labelInTown(label, town)) n += 4;
  if (result && result.exact) n += 2;
  return n;
}

function sortAddressResults(results, q) {
  return (Array.isArray(results) ? results.slice() : []).sort(
    (a, b) => addressResultScore(b, q) - addressResultScore(a, q));
}

function addressResultUsable(result, q) {
  if (!result) return false;
  if (!Number.isFinite(Number(result.lat)) || !Number.isFinite(Number(result.lng))) return false;
  const town = townFromQuery(q);
  const wantSuburb = suburbFromQuery(q);
  const physical = physicalAddressQuery(q);
  const want = houseNumberOf(physical);
  const label = result.label || "";
  if (want && houseNumberOf(label) && addressMatchScore(physical, label) === 0) return false;
  const requested = addressNumberParts(q), candidate = addressNumberParts(label);
  if (candidate?.unit && candidate.unit !== requested?.unit) return false;
  if (town && suburbUnexpected(label, wantSuburb, town)) return false;
  return true;
}

function preferLocalAddressResults(results, q) {
  const rows = (Array.isArray(results) ? results : []).filter(inTaranakiPoint);
  const physical = physicalAddressQuery(q);
  const want = houseNumberOf(physical);
  // Another region's 217 Greenwood Road is not a fallback. Rural RAPID numbers
  // miss the first 6 nationwide hits; using those pins sent Oakura jobs to Leigh.
  const ranked = sortAddressResults(rows.length ? rows : (want ? [] : results), q);
  const town = townFromQuery(q);
  const usable = ranked.filter(result => addressResultUsable(result, q));
  if (usable.length) return usable;
  // Rural RAPID numbers often sit in a locality LINZ does not call by the postal
  // town. Keep a Taranaki letterbox with the right number when it is near the
  // typed town. A far duplicate (Patea vs Inglewood) is the other road — drop it.
  const numbered = want
    ? ranked.filter(result => addressMatchScore(physical, result.label) > 0 && (!addressNumberParts(result.label)?.unit || addressNumberParts(result.label)?.unit === addressNumberParts(q)?.unit))
    : [];
  if (numbered.length === 1) return numbered;
  if (numbered.length) {
    const centre = townCentre(town);
    if (!centre) return numbered;
    return numbered.filter(result => kmBetween(result, centre) <= 40);
  }
  if (want) return [];
  if (town && ranked.length && ranked.every(result =>
    suburbUnexpected(result.label, suburbFromQuery(q), town))) return [];
  return ranked;
}

/* Taranaki localities that appear inside a road label.
   Deliberately a short, high-confidence list of places a driver could actually be sent to,
   not an exhaustive gazetteer: this only ever marks a doubtful match for a warning. */
const TARANAKI_LOCALITIES = Object.freeze([
  "patea", "alton", "waverley", "hawera", "normanby", "eltham", "stratford",
  "kaponga", "manaia", "opunake", "waitara", "urenui", "bellblock", "newplymouth",
  "oakura", "okato", "inglewood", "innglewood", "waitoriki", "waitariki",
  "midhirst", "toko", "ngaere", "douglas", "motunui", "lepperton", "tikorangi"
]);

// Split the unit from the physical street number. In NZ, "1/34" means unit 1
// at street number 34; treating the first 1 as the street number is how map
// searches end up at a completely different property.
function addressNumberParts(text) {
  const value = String(text || "").trim();
  const build = (unit, number, suffix, highNumber, highSuffix, consumed) => ({
    unit: String(unit || "").toLowerCase(), number,
    suffix: String(suffix || "").toLowerCase(),
    highNumber: String(highNumber || ""), highSuffix: String(highSuffix || "").toLowerCase(),
    house: `${number}${suffix || ""}${highNumber ? `-${highNumber}${highSuffix || ""}` : ""}`.toLowerCase(),
    consumed
  });
  let match = value.match(/^(?:(?:townhouse|town house|th|flat|unit|apartment|apt|shop|villa|room|rm|u)\s*\.?\s*|#\s*)?(\d+[a-z]?)\s*\/\s*(\d+)([a-z]?)(?:\s*-\s*(\d+)([a-z]?))?(?=\b|[\s,])/i);
  if (match) return {
    ...build(match[1], match[2], match[3], match[4], match[5], match[0].length)
  };
  match = value.match(/^(?:townhouse|town house|th|flat|unit|apartment|apt|shop|villa|room|rm|u)\s*\.?\s*(\d+[a-z]?)\s*(?:[,\-]\s*|at\s+|\s+)(\d+)([a-z]?)(?:\s*-\s*(\d+)([a-z]?))?(?=\b|[\s,])/i);
  if (match) return {
    ...build(match[1], match[2], match[3], match[4], match[5], match[0].length)
  };
  match = value.match(/^(\d+)([a-z]?)\s*-\s*(\d+)([a-z]?)(?=\b|[\s,])/i);
  if (match) return build("", match[1], match[2], match[3], match[4], match[0].length);
  match = value.match(/^(\d+)([a-z]?)(?=\b|[\s,])/i);
  return match ? build("", match[1], match[2], "", "", match[0].length) : null;
}

function houseNumberOf(text) {
  return addressNumberParts(text)?.house || "";
}

function physicalAddressQuery(text) {
  const value = String(text || "").trim();
  const parts = addressNumberParts(value);
  return parts?.unit ? `${parts.house}${value.slice(parts.consumed)}`.trim() : value;
}

function addressMatchScore(wanted, candidate) {
  const want = addressNumberParts(wanted), got = addressNumberParts(candidate);
  if (!want || !got || want.house !== got.house) return 0;
  if (want.unit && got.unit === want.unit) return 3;
  if (want.unit && got.unit) return 1;
  return 2;
}

/* ---------- LINZ NZ Addresses (authoritative, incl. rural rapid numbers) ---------- */
/* Open government data, free key, nothing to expire. Layer 123113 carries every
   current NZ address — the dataset that actually knows "1230 Mokau Road". */
const LINZ_ADDRESSES_LAYER = "data.linz.govt.nz:layer-123113";

// Build a WFS CQL filter from what Woody typed. Numbered queries pin down the
// exact letterbox; road-only queries find the road. Rural delivery codes
// ("RD 44") are postman routing, not geography, so they get dropped. Town names
// are a preference, not a rule — customers write their postal town while LINZ
// knows the locality ("Mimi") — and a written unit letter ("2A") sometimes turns
// out to be a plain "2" in the register, so both get relaxed step by step.
/* ---------- Street-type abbreviations ----------
   Woody, 18 Sept: "201 Lincoln road, Inglewood pickup when I pressed navigate sent me to
   Waitariki school a few minutes on the road."

   The cause was an ABBREVIATION, proven against the live service:

     "201 Lincoln Road, Inglewood"     -> 201 Lincoln Road, Inglewood        CORRECT
     "201 Lincoln Rd, Inglewood"       -> 201, Lincoln Road, Waitoriki ...   WRONG

   The authoritative register (LINZ) stores "Lincoln Road". Asking it for "Lincoln Rd"
   matches nothing, so the lookup fell through to the map - and Inglewood has TWO Lincoln
   Roads, so the fallback's first hit was the one by Waitoriki School, about 2.8km away.

   The fix is to expand the abbreviation BEFORE the lookup, so an abbreviated address
   reaches the authoritative register (which has the house number) instead of the map.
   Only the LAST word of the street line is expanded, so a genuine name keeps its spelling:
   "St Marys Road" keeps its Saint, and "Rd" at the end becomes "Road". */
const ROAD_ABBREVIATIONS = Object.freeze({
  rd: 'road', st: 'street', ave: 'avenue', av: 'avenue', dr: 'drive', drv: 'drive',
  cres: 'crescent', crs: 'crescent', pl: 'place', tce: 'terrace', terr: 'terrace',
  hwy: 'highway', ln: 'lane', ct: 'court', gr: 'grove', pde: 'parade',
  bvd: 'boulevard', blvd: 'boulevard', hts: 'heights', hgts: 'heights',
  gdn: 'garden', gdns: 'gardens', esp: 'esplanade', qy: 'quay', cl: 'close',
  bnd: 'bend', hbr: 'harbour', vly: 'valley', gln: 'glen', mwy: 'motorway',
  mtwy: 'motorway', rte: 'route', tpk: 'turnpike', ext: 'extension',
  n: 'north', s: 'south'
});

// Keep whatever case the caller typed: RD -> ROAD, Rd -> Road, rd -> road.
function matchCase(source, target) {
  const word = String(source || '');
  if (word && word === word.toUpperCase()) return target.toUpperCase();
  if (word && word[0] === word[0].toUpperCase()) return target[0].toUpperCase() + target.slice(1);
  return target;
}

/* Expand a trailing street-type abbreviation on the STREET line only.
   Towns and regions are left exactly as typed. Anything already spelled out is untouched. */
/* Expand the last word of a single street segment. */
function expandStreetToken(segment) {
  const part = String(segment == null ? '' : segment);
  const leading = part.match(/^\s*/)[0];
  const trailing = part.match(/\s*$/)[0];
  const tokens = part.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return part;
  const last = tokens[tokens.length - 1];
  const bare = last.replace(/[^A-Za-z]/g, '');
  const expansion = ROAD_ABBREVIATIONS[bare.toLowerCase()];
  if (!expansion || bare.length > 4) return part;
  tokens[tokens.length - 1] = last.replace(bare, matchCase(bare, expansion));
  return leading + tokens.join(' ') + trailing;
}

function expandStreetAbbreviations(text) {
  const value = String(text == null ? '' : text);
  if (!value) return value;
  /* Rebuild ONLY the street segment; every later segment is passed through untouched, so a
     stray space can never appear in a town name. */
  const comma = value.indexOf(',');
  if (comma < 0) return expandStreetToken(value);
  return expandStreetToken(value.slice(0, comma)) + value.slice(comma);
}

function linzCqlFor(q, includeTown, dropSuffix, dropUnit = false) {
  const cleaned = String(q || "").replace(/\b(?:rd|rural delivery)\s*\d+\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  const parts = cleaned.split(",").map(part => part.trim());
  const streetPart = parts[0] || "";
  const esc = s => String(s).replace(/'/g, "''");
  const conds = ["address_lifecycle='Current'"];
  const numberParts = addressNumberParts(streetPart);
  if (numberParts) {
    conds.push(`address_number=${numberParts.number}`);
    const roadWords = streetPart.slice(numberParts.consumed).trim().replace(/['"]/g, "");
    const words = roadWords.split(/\s+/).filter(Boolean).slice(0, 2);
    if (words.length) conds.push(`full_road_name_ascii ILIKE '${esc(words.join(" "))}%'`);
    if (numberParts.suffix && !dropSuffix) conds.push(`lower(address_number_suffix)='${esc(numberParts.suffix)}'`);
    if (numberParts.highNumber) {
      conds.push(`address_number_high=${numberParts.highNumber}`);
      if (numberParts.highSuffix && !dropSuffix) {
        const rangePattern = numberParts.unit ? `%/${numberParts.house}` : numberParts.house;
        conds.push(`lower(full_address_number) LIKE '${esc(rangePattern)}'`);
      }
    }
    if (numberParts.unit && !dropUnit) conds.push(`lower(unit_value)='${esc(numberParts.unit)}'`);
  } else {
    const words = streetPart.replace(/['"]/g, "").split(/\s+/).filter(Boolean).slice(0, 3);
    if (!words.length) return "";
    conds.push(`full_address_ascii ILIKE '%${esc(words.join(" "))}%'`);
  }
  if (includeTown) {
    const town = townFromQuery(q);
    if (town) conds.push(`full_address_ascii ILIKE '%${esc(town)}%'`);
  }
  // Postal town is often missing from the register ("Pitone, New Plymouth" vs
  // typed Oakura). Keep every hit inside Taranaki councils so count=6 cannot
  // fill with other regions' same-number roads.
  conds.push("(territorial_authority_ascii ILIKE '%New Plymouth%' OR territorial_authority_ascii ILIKE '%Stratford%' OR territorial_authority_ascii ILIKE '%South Taranaki%')");
  return conds.join(" AND ");
}

async function linzAddressResults(env, q, limit) {
  // Expand "Rd" before asking the register — otherwise an abbreviated street
  // misses the letterbox and the map pins the other road of the same name.
  q = collapseExtraRepeats(expandStreetAbbreviations(String(q || "")));
  // Most precise first; each step relaxes one guess. A hit at any step wins.
  // Town relaxes AFTER the unit letter: a written "2A" that's really "2" on the
  // right road beats an actual 2A on the other side of the country.
  // Number + road in Taranaki first. Asking for the postal town first hid the
  // real letterbox (Oakura is not in a Pitone LINZ label).
  const attempts = [...new Set([
    linzCqlFor(q, false, false, false),
    linzCqlFor(q, true, false, false),
    linzCqlFor(q, false, false, true),
    linzCqlFor(q, true, false, true),
    linzCqlFor(q, false, true, true),
    linzCqlFor(q, true, true, true)
  ])];
  for (const cql of attempts) {
    if (!cql) continue;
    const params = new URLSearchParams({
      service: "WFS", version: "2.0.0", request: "GetFeature",
      typeNames: LINZ_ADDRESSES_LAYER,
      outputFormat: "application/json", count: String(Math.max(limit, 20)),
      CQL_FILTER: cql
    });
    const response = await fetch(`https://data.linz.govt.nz/services;key=${env.LINZ_API_KEY}/wfs?${params}`);
    if (!response.ok) continue;
    const payload = await response.json();
    let rows = ((payload || {}).features || []).map(feature => {
      const props = feature.properties || {};
      const coords = (feature.geometry || {}).coordinates || [];
      const numberText = String(props.full_address_number || props.full_address || "");
      return {
        label: String(props.full_address || ""),
        lat: number(coords[1], NaN),
        lng: number(coords[0], NaN),
        numberText,
        house: houseNumberOf(numberText)
      };
    }).filter(row => row.label && Number.isFinite(row.lat) && Number.isFinite(row.lng));
    if (rows.length) {
      const local = rows.filter(inTaranakiPoint);
      if (local.length) rows = local;
      else if (houseNumberOf(q)) continue;
      // Once a slash unit falls back to its physical street number, do not also
      // offer neighbouring suffixes (1/34 must never offer 34A).
      const wantedNumber = addressNumberParts(q);
      if (wantedNumber?.unit) {
        const exactUnit = rows.filter(row => addressMatchScore(q, row.numberText) === 3);
        const physicalBase = rows.filter(row =>
          addressMatchScore(q, row.numberText) === 2 && !addressNumberParts(row.numberText)?.unit);
        rows = exactUnit.length ? exactUnit : physicalBase;
        if (!rows.length) continue;
      } else if (wantedNumber) {
        // A typed 34 only gets 34, never 34A; a typed 34A only gets 34A.
        rows = rows.filter(row => addressMatchScore(q, row.numberText) === 2 && !addressNumberParts(row.numberText)?.unit);
        if (!rows.length) continue;
      }
      // Exact letterbox matches float above same-road neighbours.
      const wantHouse = houseNumberOf(q);
      if (wantHouse) rows.sort((a, b) => addressMatchScore(q, b.house) - addressMatchScore(q, a.house));
      return rows.map(({ label, lat, lng }) => ({ label, lat, lng }));
    }
  }
  return [];
}

async function googleGeocode(env, address, components, limit) {
  const params = new URLSearchParams({ address, key: env.GOOGLE_API_KEY, region: "nz", components });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  if (!response.ok) return [];
  const payload = await response.json();
  return (payload.results || []).slice(0, limit).map(result => ({
    label: String(result.formatted_address || "").replace(/, New Zealand$/, ""),
    lat: number((((result.geometry || {}).location || {}).lat), NaN),
    lng: number((((result.geometry || {}).location || {}).lng), NaN),
    // ROOFTOP without partial_match = a real letterbox. Anything else is Google
    // guessing along the street, which is how a made-up house number gets a pin.
    exact: ((result.geometry || {}).location_type === "ROOFTOP") && !result.partial_match
  })).filter(result => result.label && Number.isFinite(result.lat) && Number.isFinite(result.lng));
}

async function handleAddress(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 180);
  const limit = Math.max(1, Math.min(6, number(url.searchParams.get("limit"), 6)));
  if (q.length < 3) return json(request, { results: [] });
  const key = cacheRequest(request, "address-v19", [q.toLowerCase(), String(limit)]);
  return cached(request, key, 2592000, async () => {
    /* Expand a trailing street abbreviation ("Rd" -> "Road") BEFORE any lookup. Without
     this an abbreviated address misses the authoritative register and falls through to the
     map, which is how a pickup was sent to the wrong road of the same name. */
    // Known local spelling correction; retain the customer's original address.
    const lookupQuery = collapseExtraRepeats(expandStreetAbbreviations(q)).replace(/\bBarret Road\b/gi, "Barrett Road");
    const physicalQuery = physicalAddressQuery(lookupQuery);
    const address = /new zealand|\bnz\b/i.test(physicalQuery) ? physicalQuery : `${physicalQuery}, Taranaki, New Zealand`;
    const town = townFromQuery(q);
    const street = String(physicalQuery).split(",")[0].trim();
    const fetchLimit = 6;
    // LINZ first for NZ RAPID numbers. Google interpolates the other Greenwood /
    // Hursthouse Road and the old order then threw the real letterbox away.
    if (env.LINZ_API_KEY) {
      try {
        let results = preferLocalAddressResults(await linzAddressResults(env, lookupQuery, fetchLimit), q);
        results = results.slice(0, limit);
        if (results.length) {
          return json(request, { results, source: "LINZ", town }, 200, "public, max-age=2592000");
        }
      } catch { /* keep falling through */ }
    }
    if (env.GOOGLE_API_KEY) {
      try {
        let results = await googleGeocode(env, address, "country:NZ", fetchLimit);
        // A numbered request only accepts the same physical street number.
        // In particular, 1/34 may not silently become 34A.
        if (houseNumberOf(physicalQuery)) {
          results = results.filter(result => addressMatchScore(physicalQuery, result.label) > 0);
        }
        const townChecked = Boolean(town);
        if (town && results.length && !results.some(result => addressResultUsable(result, q))) {
          // Wrong town, or the only hits are the other road of the same name.
          // Prefer any in-town pin (even interpolated) over an exact letterbox in Patea.
          const strict = await googleGeocode(env, `${street}, New Zealand`, `country:NZ|locality:${town}`, fetchLimit);
          const inTown = strict.filter(result => addressResultUsable(result, q));
          if (inTown.length) results = inTown;
        }
        results = preferLocalAddressResults(results, q);
        // Google often answers the Waitoriki Lincoln Road first. If every hit is
        // that unexpected suburb, skip Google so LINZ can still return the township letterbox.
        if (results.length && results.some(result => addressResultUsable(result, q))) {
          results = results.slice(0, limit);
          const townMismatch = townChecked && !labelInTown(results[0].label, town);
          return json(request, { results, source: "Google", town, townMismatch }, 200, "public, max-age=2592000");
        }
      } catch { /* use the no-cost fallback below */ }
    }
    try {
      const params = new URLSearchParams({ format: "json", addressdetails: "1", countrycodes: "nz", limit: String(fetchLimit), q: address });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { "Accept": "application/json", "User-Agent": "NakiPickupRun/1.0 (nakiwreckremoval@gmail.com)" }
      });
      if (response.ok) {
        const payload = await response.json();
        const toResults = rows => (rows || []).map(result => ({
          label: String(result.display_name || "").split(",").slice(0, 4).join(",").trim(),
          lat: number(result.lat, NaN),
          lng: number(result.lon, NaN)
        })).filter(result => result.label && Number.isFinite(result.lat) && Number.isFinite(result.lng));
        let results = toResults(payload);
        // Rural rapid numbers ("1230 Mokau Road") are mostly missing from OSM.
        // A whole-address miss shouldn't become a dead end: retry with just the
        // road so the run at least gets a pin on the right road, and the app's
        // house-number check keeps it honest about how precise that is.
        if (!results.length && /^\s*\d/.test(physicalQuery)) {
          const roadOnly = physicalQuery.replace(/^\s*\d+[a-z]?\s*/i, "").trim();
          if (roadOnly && roadOnly !== physicalQuery) {
            const retryParams = new URLSearchParams({ format: "json", addressdetails: "1", countrycodes: "nz", limit: String(fetchLimit), q: roadOnly });
            const retry = await fetch(`https://nominatim.openstreetmap.org/search?${retryParams}`, {
              headers: { "Accept": "application/json", "User-Agent": "NakiPickupRun/1.0 (nakiwreckremoval@gmail.com)" }
            });
            if (retry.ok) {
              results = toResults(await retry.json());
            }
          }
        }
        // "58A Argyle Street" deserves the answer with "58A" in it, not the bare
        // street OSM falls back to — numbered candidates float to the top.
        const house = houseNumberOf(physicalQuery);
        if (house) {
          results.sort((a, b) =>
            addressMatchScore(physicalQuery, b.label) - addressMatchScore(physicalQuery, a.label));
        }
        /* Prefer the township road when the same name exists twice in one district.

           Woody, 18 Sept: "201 Lincoln road, Inglewood pickup when I pressed navigate sent me
           to Waitariki school a few minutes on the road."

           Proven against the live service: Inglewood has TWO Lincoln Roads -

             Lincoln Road, Waitoriki, Inglewood   [-39.1248, 174.2576]  <- by the school
             Lincoln Road, Inglewood              [-39.1458, 174.2213]  <- the real one

           Asking for the bare road returns the Waitoriki one FIRST. Navigate already uses
           the typed address, so Google Maps is right; the in-app pin used results[0] and
           sat by the school. When both answers exist, keep the one without the extra suburb. */
        results = preferLocalAddressResults(results, q).slice(0, limit);
        const houseNumberWanted = houseNumberOf(physicalQuery);
        const wantSuburb = suburbFromQuery(q);
        const ambiguousRoad = Boolean(!houseNumberWanted && town && results.length
          && suburbUnexpected(results[0].label, wantSuburb, town));
        return json(request, { results, source: "OpenStreetMap fallback", town, ambiguousRoad }, 200, "public, max-age=2592000");
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
  // Every receipt now asks for feedback, not just the Find My Local customers.
  // Opt a single send out by passing includeReviewRequest: false from the app.
  const reviewRequest = body.includeReviewRequest === false
    ? ""
    : `\n\nOne small favour — if you're happy with how the collection went, would you mind leaving us a quick review on ${REVIEW_PLACE}? It takes a minute and it genuinely helps a small local business like ours get found.\n${REVIEW_URL}`;
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(request, { error: "Invalid email address" }, 400);
  if (!/^[A-Za-z0-9+/=]+$/.test(pdf) || pdf.length < 100 || pdf.length > 2000000) return json(request, { error: "Invalid PDF" }, 400);
  const first = name.split(/\s+/)[0] || "";
  const sent = await sendMail(env, {
    to, name,
    subject: "Your whiteware collection receipt",
    text: `${profileLinkLine(body.profileUrl, body.profileStatus)}Hey${first ? " " + first : ""},\n\nThanks heaps! Your receipt for the whiteware collection is attached.${reviewRequest}\n\nCheers,\nWoody\nNaki Whiteware Removal\nnakiwhitewareremoval@gmail.com`,
    attachment: [{ name: filename, content: pdf }]
  });
  if (!sent) return json(request, { error: "Email could not be sent" }, 502);
  await recordBookingDocument(env, {
    email: to, kind: "RECEIPT", amount: body.amount, reference: name,
    bookingId: body.bookingId, items: body.items, address: body.address,
    filename, pdfBase64: pdf
  });
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
  if (Array.isArray(body.messages) && body.messages.length > 40) return json(request,{error:"Send at most 40 emails per batch; none were sent."},400);
  const list = Array.isArray(body.messages) ? body.messages : [];
  if (!list.length) return json(request, { error: "No messages" }, 400);
  const emailOk = value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
  let sent = 0;
  const failed = [], sentTo=[];
  for (const m of list) {
    const to = String(m && m.to || "").trim();
    const name = String(m && m.name || "").trim().slice(0, 80);
    const text = String(m && m.body || "").trim().slice(0, 4000);
    if (!emailOk(to) || !text) { failed.push(to || "(blank)"); continue; }
    if (sent) await new Promise(r => setTimeout(r, 400));   // gentle pacing — a run of 40 looks human
    const ok = await sendMail(env, { to, name, subject, text });
    if (ok) { sent++; sentTo.push(to.toLowerCase()); } else failed.push(to);
  }
  return json(request, { ok: true, sent, sentTo, failed });
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

function replyToHeader(replyTo) {
  const address = String(replyTo && replyTo.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return "Naki Whiteware Removal <nakiwhitewareremoval@gmail.com>";
  const label = String(replyTo.name || "").replace(/["\r\n]/g, "").trim();
  return label ? `"${label}" <${address}>` : address;
}

function buildMime({ to, name, subject, text, attachment, replyTo }) {
  const toHeader = name ? `"${name.replace(/["\r\n]/g, "")}" <${to}>` : to;
  const head = [
    "From: Naki Whiteware Removal <nakiwreckremoval@gmail.com>",
    `To: ${toHeader}`,
    // A forwarded customer message replies to the customer, not to ourselves.
    `Reply-To: ${replyToHeader(replyTo)}`,
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
export async function sendMail(env, msg) {
  if (msg.kind === "customer-login" && env.AUTH_EMAIL_FROM) {
    // Authentication mail must never fall back to the personal Gmail sender.
    const sender = loginSender(env.AUTH_EMAIL_FROM);
    return sendBrevo(env, { ...msg, sender });
  }
  if (await sendGmail(env, msg)) return true;
  return sendBrevo(env, msg);
}

function mailConfigured(env) { return Boolean(env.GMAIL_REFRESH_TOKEN || env.BREVO_API_KEY); }

// Brevo sender — now the fallback path only.
async function sendBrevo(env, { to, name, subject, text, attachment, replyTo, sender }) {
  if (!env.BREVO_API_KEY) return false;
  const replyAddress = String(replyTo && replyTo.email || "").trim();
  const useReply = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyAddress)
    ? { email: replyAddress, ...(replyTo.name ? { name: String(replyTo.name).slice(0, 80) } : {}) }
    : { name: "Naki Whiteware Removal", email: "nakiwhitewareremoval@gmail.com" };
  const payload = {
    sender: sender || { name: "Naki Whiteware Removal", email: "nakiwreckremoval@gmail.com" },
    replyTo: useReply,
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

// The account link used to live in a promo box inside the PDF itself - but the
// PDF is now kept as the customer's permanent record, so the link belongs in
// the email instead, as the first thing they read.
const PROFILE_URL_RE = /^https:\/\/nakiwhitewareremoval\.vip\/account\.html(\?[^\s]*)?$/;
function profileLinkLine(url, status) {
  const value = String(url || "").trim();
  if (!PROFILE_URL_RE.test(value)) return "";
  if (status === "existing") {
    return `View your account, pickup history and every receipt/invoice we've sent you: ${value}\n\n`;
  }
  if (status === "invite") {
    return `Set up your free online account to view your pickup history and keep every receipt/invoice in one place: ${value}\n\n`;
  }
  return `Open your account page to sign in or set up an account: ${value}\n\n`;
}

function invoiceText(name, amount, profileUrl, profileStatus) {
  const first = firstName(name);
  const amt = Number.isFinite(Number(amount)) ? ` for $${Number(amount).toFixed(2)}` : "";
  return `${profileLinkLine(profileUrl, profileStatus)}Hi${first ? " " + first : ""},\n\nYour invoice${amt} for the whiteware collection is attached.\n\n${BANK_LINE}\n${REF_LINE}\n\nCheers,\nWoody\nNaki Whiteware Removal\nnakiwhitewareremoval@gmail.com`;
}

function reminderText(name, amount) {
  const first = firstName(name);
  const amt = Number.isFinite(Number(amount)) ? ` of $${Number(amount).toFixed(2)}` : "";
  return `Hi${first ? " " + first : ""},\n\nJust a friendly reminder about the payment${amt} for your whiteware collection.\n\n${BANK_LINE}\n${REF_LINE}\n\nIf you've already paid, thanks heaps — please ignore this.\n\nCheers,\nWoody\nNaki Whiteware Removal\nnakiwhitewareremoval@gmail.com\n\n(This is an automated reminder — Woody set it up when he sent your invoice.)`;
}

// A reminder can repeat until it's paid. Only these gaps are allowed, and it
// gives up after MAX_REMINDER_SENDS so nobody gets chased forever.
const REPEAT_DAY_CHOICES = [0, 3, 7, 14, 30];
const MAX_REMINDER_SENDS = 6;
const REMINDER_TTL = 60 * 60 * 24 * 120;
const REMINDER_TTL_REPEATING = 60 * 60 * 24 * 400;
function repeatDaysOf(value) {
  const days = Number(value);
  return REPEAT_DAY_CHOICES.includes(days) ? days : 0;
}
// Noon UTC on purpose - it keeps the date from sliding a day either way.
function addDays(isoDay, days) {
  const d = new Date(`${isoDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
async function storeReminder(env, { to, name, amount, date, repeatDays, sent }) {
  const id = crypto.randomUUID();
  const repeat = repeatDaysOf(repeatDays);
  await env.REMINDERS.put(`rem:${id}`, JSON.stringify({
    to, name,
    amount: Number.isFinite(Number(amount)) ? Number(amount) : null,
    date, repeatDays: repeat, sent: Number(sent) || 0
  }), { expirationTtl: repeat ? REMINDER_TTL_REPEATING : REMINDER_TTL });
  return id;
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
  const reminderRepeat = repeatDaysOf(body.reminderRepeat);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(request, { error: "Invalid email address" }, 400);
  if (!/^[A-Za-z0-9+/=]+$/.test(pdf) || pdf.length < 100 || pdf.length > 2000000) return json(request, { error: "Invalid PDF" }, 400);
  const sent = await sendMail(env, {
    to, name,
    subject: "Invoice - whiteware collection",
    text: invoiceText(name, amount, body.profileUrl, body.profileStatus),
    attachment: [{ name: filename, content: pdf }]
  });
  if (!sent) return json(request, { error: "Email could not be sent" }, 502);
  // Keep a copy in the customer's account so they can check what they owe.
  await recordBookingDocument(env, {
    email: to, kind: "INVOICE", amount, reference: name,
    bookingId: body.bookingId, items: body.items, address: body.address,
    filename, pdfBase64: pdf
  });
  // Reminder: only for a real future-or-today date, and only if KV is bound.
  let reminderId = "";
  if (env.REMINDERS && /^\d{4}-\d{2}-\d{2}$/.test(reminderDate) && reminderDate >= isoDate(aucklandToday())) {
    reminderId = await storeReminder(env, { to, name, amount, date: reminderDate, repeatDays: reminderRepeat });
  }
  return json(request, { ok: true, reminderId, reminderRepeat });
}

// Set, move or repeat a payment reminder AFTER the invoice has already gone out.
// Same store the invoice send writes to, so the daily cron picks it up as usual.
async function handleSetReminder(request, env) {
  if (!env.REMINDERS) return json(request, { error: "Reminders are not set up on this account" }, 503);
  let body;
  try { body = await request.json(); } catch { return json(request, { error: "Bad request" }, 400); }
  const to = String(body.to || "").trim();
  const name = String(body.name || "").trim().slice(0, 80);
  const date = String(body.date || "").trim();
  const repeatDays = repeatDaysOf(body.repeatDays);
  const replacing = String(body.id || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json(request, { error: "That customer has no usable email address" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json(request, { error: "Pick a day first" }, 400);
  if (date < isoDate(aucklandToday())) return json(request, { error: "That day has already been and gone" }, 400);
  // Changing an existing reminder drops the old one, so nobody gets chased twice.
  if (/^[\w-]{8,64}$/.test(replacing)) await env.REMINDERS.delete(`rem:${replacing}`);
  const reminderId = await storeReminder(env, { to, name, amount: body.amount, date, repeatDays });
  return json(request, { ok: true, reminderId, date, repeatDays });
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
      if (ok) {
        const repeat = repeatDaysOf(r.repeatDays);
        const times = (Number(r.sent) || 0) + 1;
        if (repeat && times < MAX_REMINDER_SENDS) {
          // Still owing, so line the next nudge up. Counted off today, not off the
          // day it was due — an overdue one would otherwise fire again straight away.
          await env.REMINDERS.put(key.name, JSON.stringify({
            ...r, date: addDays(today, repeat), repeatDays: repeat, sent: times
          }), { expirationTtl: REMINDER_TTL_REPEATING });
        } else {
          await env.REMINDERS.delete(key.name);
        }
        sent++;
      }
      else failed++;                             // left in KV — retried on the next run
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { sent, failed, date: today };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v1/")) return handleIntegrationApi(request, env, { sendMail });
    const path = url.pathname.replace(/^\/v2/, "");
    // Twilio and Jotform are servers, not browsers - neither sends an Origin.
    // They prove themselves with a signature instead, inside their handlers.
    if (isPhonePath(path)) {
      if (path === "/phone/incoming") return await phoneIncoming(request, env);
      return phoneStream(request, env);
    }
    if (path !== "/jotform/submission" && !allowedOrigin(request)) {
      return json(request, { error: "This service is only available to the Naki Pickup Run app" }, 403);
    }
    try {
      const dispatch = async () => {
      if (path === "/kids/activity") return await recordKidsActivity(request, env, json);
      // Ahead of the portal so the owner router doesn't 404 on it. Hands-free
      // voice: the phone swaps WebRTC details with OpenAI through here.
      if (path === LIVE_SESSION_PATH || path === RECEPTION_QUOTE_PATH) {
        const voiceSession = await sessionFor(request, env, "owner");
        if (!voiceSession) return json(request, { error: "Sign in on the Bookings tab, then start voice again." }, 401);
        return path === LIVE_SESSION_PATH
          ? await liveSession(request, env, json, voiceSession)
          : await receptionQuote(request, env, json);
      }
      const portalResponse = await handlePortalRequest({ request, env, path, json, sendMail });
      if (portalResponse) return portalResponse;
      if (path === "/weather" && request.method === "POST") return await handleWeather(request, env);
      if (path === "/gms-hours" && request.method === "GET") return await handleGms(request, env);
      if (path === "/address-search" && request.method === "GET") return await handleAddress(request, env);
      if (path === "/send-receipt" && request.method === "POST") return await handleSendReceipt(request, env);
      if (path === "/send-bulk" && request.method === "POST") return await handleSendBulk(request, env);
      if (path === "/send-invoice" && request.method === "POST") return await handleSendInvoice(request, env);
      if (path === "/set-reminder" && request.method === "POST") return await handleSetReminder(request, env);
      if (path === "/cancel-reminder" && request.method === "POST") return await handleCancelReminder(request, env);

      return json(request, { error: "Not found" }, 404);
      };
      if (OWNER_ACTIONS.has(path)) {
        // /owner/bookings is both the bookings LIST (GET) and "take a booking"
        // (POST). Only the create needs the once-only claim, so a GET has to fall
        // through to the list handler instead of being answered with 405.
        if (path === "/owner/bookings" && request.method !== "POST") return await dispatch();
        const session=await sessionFor(request,env,"owner");
        if (!session) return json(request,{error:"Sign in on the Bookings tab to send email or manage reminders."},401);
        if (request.method !== "POST") return json(request,{error:"Method not allowed"},405);
        return await ownerAction(request,env,path,session,json,dispatch);
      }
      return await dispatch();
    } catch (error) {
      if (error instanceof AuthMailError) {
        const response = json(request, { error: error.message, retryAfter: error.retryAfter }, error.status);
        response.headers.set("Retry-After", String(error.retryAfter));
        return response;
      }
      console.error("Naki route request failed", request.method, path, error?.stack || String(error));
      return json(request, { error: "Live service could not be loaded" }, 502);
    }
  },
  // Daily at 21:00 UTC = 9am NZST (10am NZDT): send any due payment reminders.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
    ctx.waitUntil(retryPendingSheetBackups(env));
    ctx.waitUntil(purgeExpiredAuth(env));
    ctx.waitUntil(purgeKidsActivity(env));
    ctx.waitUntil(env.CUSTOMER_DB.prepare("DELETE FROM auth_request_limits WHERE expires_at<?1").bind(Date.now()).run());
    // Only on the daily trigger - the 15-minute one has other work to do.
    if (event.cron === "0 21 * * *") {
      ctx.waitUntil(purgeApiRequests(env));
      ctx.waitUntil(env.CUSTOMER_DB.prepare('DELETE FROM owner_action_receipts WHERE status IS NOT NULL AND created_at<?1').bind(Date.now()-30*86400000).run());
      ctx.waitUntil(snapshotDatabase(env));
      ctx.waitUntil(purgeOldPhotos(env));
    }
  }
};

export { ReceptionCall };
export {
  addressMatchScore, houseNumberOf, linzAddressResults, linzCqlFor, physicalAddressQuery,
  expandStreetAbbreviations, suburbUnexpected, preferLocalAddressResults, addressResultUsable,
  collapseExtraRepeats
};
