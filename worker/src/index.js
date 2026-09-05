import { OWNER_ACTIONS, ownerAction } from "./owner-actions.js";
import { metWeather } from "./field-weather.js";
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
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", `public, max-age=${seconds}`);
    await store.put(key, new Response(response.clone().body, { status: response.status, statusText: response.statusText, headers }));
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
  let match = value.match(/^(?:(?:flat|unit|apartment|apt|shop|villa|room|rm|u)\s*\.?\s*|#\s*)?(\d+[a-z]?)\s*\/\s*(\d+)([a-z]?)(?:\s*-\s*(\d+)([a-z]?))?(?=\b|[\s,])/i);
  if (match) return {
    ...build(match[1], match[2], match[3], match[4], match[5], match[0].length)
  };
  match = value.match(/^(?:flat|unit|apartment|apt|shop|villa|room|rm|u)\s*\.?\s*(\d+[a-z]?)\s*(?:[,\-]\s*|at\s+|\s+)(\d+)([a-z]?)(?:\s*-\s*(\d+)([a-z]?))?(?=\b|[\s,])/i);
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
    conds.push(`full_address_ascii ILIKE '${esc(words.join(" "))}%'`);
  }
  if (includeTown) {
    const town = townFromQuery(q);
    if (town) conds.push(`full_address_ascii ILIKE '%${esc(town)}%'`);
  }
  return conds.join(" AND ");
}

async function linzAddressResults(env, q, limit) {
  // Most precise first; each step relaxes one guess. A hit at any step wins.
  // Town relaxes AFTER the unit letter: a written "2A" that's really "2" on the
  // right road beats an actual 2A on the other side of the country.
  const attempts = [...new Set([
    linzCqlFor(q, true, false, false),
    linzCqlFor(q, false, false, false),
    linzCqlFor(q, true, false, true),
    linzCqlFor(q, false, false, true),
    linzCqlFor(q, true, true, true),
    linzCqlFor(q, false, true, true)
  ])];
  for (const cql of attempts) {
    if (!cql) continue;
    const params = new URLSearchParams({
      service: "WFS", version: "2.0.0", request: "GetFeature",
      typeNames: LINZ_ADDRESSES_LAYER,
      outputFormat: "application/json", count: String(limit),
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
        rows = rows.filter(row => addressMatchScore(q, row.numberText) === 2);
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
  const key = cacheRequest(request, "address-v11", [q.toLowerCase(), String(limit)]);
  return cached(request, key, 2592000, async () => {
    const physicalQuery = physicalAddressQuery(q);
    const address = /new zealand|\bnz\b/i.test(physicalQuery) ? physicalQuery : `${physicalQuery}, Taranaki, New Zealand`;
    const town = townFromQuery(q);
    const street = String(physicalQuery).split(",")[0].trim();
    if (env.GOOGLE_API_KEY) {
      try {
        let results = await googleGeocode(env, address, "country:NZ", limit);
        // A numbered request only accepts the same physical street number.
        // In particular, 1/34 may not silently become 34A.
        if (houseNumberOf(physicalQuery)) {
          results = results.filter(result => addressMatchScore(physicalQuery, result.label) > 0);
        }
        const townChecked = Boolean(town);
        if (town && results.length && !results.some(result => labelInTown(result.label, town))) {
          // Wrong town: ask again, this time forcing Google to stay inside it.
          // Only a real letterbox counts — an interpolated guess in the right town
          // is worse than an exact match in the neighbouring one.
          const strict = await googleGeocode(env, `${street}, New Zealand`, `country:NZ|locality:${town}`, limit);
          const inTown = strict.filter(result => labelInTown(result.label, town) && result.exact &&
            (!houseNumberOf(physicalQuery) || addressMatchScore(physicalQuery, result.label) > 0));
          if (inTown.length) results = inTown;
        }
        if (results.length) {
          // Town matches first, so a single-result caller never gets the wrong town silently.
          results.sort((a, b) => Number(labelInTown(b.label, town)) - Number(labelInTown(a.label, town)));
          const townMismatch = townChecked && !labelInTown(results[0].label, town);
          return json(request, { results, source: "Google", town, townMismatch }, 200, "public, max-age=2592000");
        }
      } catch { /* use the no-cost fallback below */ }
    }
    // LINZ NZ Addresses: every current NZ address, rural rapid numbers included.
    // This is what finds rural Taranaki that OpenStreetMap has never heard of.
    if (env.LINZ_API_KEY) {
      try {
        const results = await linzAddressResults(env, q, limit);
        if (results.length) {
          return json(request, { results, source: "LINZ", town }, 200, "public, max-age=2592000");
        }
      } catch { /* keep falling through to the free map below */ }
    }
    try {
      const params = new URLSearchParams({ format: "json", addressdetails: "1", countrycodes: "nz", limit: String(limit), q: address });
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
            const retryParams = new URLSearchParams({ format: "json", addressdetails: "1", countrycodes: "nz", limit: String(limit), q: roadOnly });
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
async function sendMail(env, msg) {
  if (await sendGmail(env, msg)) return true;
  return sendBrevo(env, msg);
}

function mailConfigured(env) { return Boolean(env.GMAIL_REFRESH_TOKEN || env.BREVO_API_KEY); }

// Brevo sender — now the fallback path only.
async function sendBrevo(env, { to, name, subject, text, attachment, replyTo }) {
  if (!env.BREVO_API_KEY) return false;
  const replyAddress = String(replyTo && replyTo.email || "").trim();
  const useReply = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(replyAddress)
    ? { email: replyAddress, ...(replyTo.name ? { name: String(replyTo.name).slice(0, 80) } : {}) }
    : { name: "Naki Whiteware Removal", email: "nakiwhitewareremoval@gmail.com" };
  const payload = {
    sender: { name: "Naki Whiteware Removal", email: "nakiwreckremoval@gmail.com" },
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
    const path = url.pathname.replace(/^\/v2/, "");
    if (path !== "/jotform/submission" && !allowedOrigin(request)) {
      return json(request, { error: "This service is only available to the Naki Pickup Run app" }, 403);
    }
    try {
      const dispatch = async () => {
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
        const session=await sessionFor(request,env,"owner");
        if (!session) return json(request,{error:"Sign in on the Bookings tab to send email or manage reminders."},401);
        if (request.method !== "POST") return json(request,{error:"Method not allowed"},405);
        return await ownerAction(request,env,path,session,json,dispatch);
      }
      return await dispatch();
    } catch (error) {
      console.error("Naki route request failed", request.method, path, error?.stack || String(error));
      return json(request, { error: "Live service could not be loaded" }, 502);
    }
  },
  // Daily at 21:00 UTC = 9am NZST (10am NZDT): send any due payment reminders.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env));
    ctx.waitUntil(retryPendingSheetBackups(env));
    ctx.waitUntil(purgeExpiredAuth(env));
    // Only on the daily trigger - the 15-minute one has other work to do.
    if (event.cron === "0 21 * * *") {
      ctx.waitUntil(env.CUSTOMER_DB.prepare('DELETE FROM owner_action_receipts WHERE status IS NOT NULL AND created_at<?1').bind(Date.now()-30*86400000).run());
      ctx.waitUntil(snapshotDatabase(env));
      ctx.waitUntil(purgeOldPhotos(env));
    }
  }
};

export { addressMatchScore, houseNumberOf, linzAddressResults, linzCqlFor, physicalAddressQuery };
