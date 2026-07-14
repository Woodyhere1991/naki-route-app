const GMS_PLACE_ID = "ChIJI-iQUfZQFG0RorGmjzvMPRE";
const APP_ORIGIN = "https://naki-route-app.pages.dev";

function cors(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = origin === APP_ORIGIN || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : APP_ORIGIN,
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
  return { name: location.name, lat: Number(location.lat), lng: Number(location.lng), days };
}

async function handleWeather(request, env) {
  if (!env.GOOGLE_API_KEY) return json(request, { error: "Weather is not configured yet", towns: [] }, 503);
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
  const settled = await Promise.allSettled(locations.map(location => weatherFor(location, env.GOOGLE_API_KEY)));
  const towns = settled.filter(x => x.status === "fulfilled").map(x => x.value);
  const failed = settled.map((x, i) => x.status === "rejected" ? locations[i].name : "").filter(Boolean);
  if (!towns.length) return json(request, { error: "Live weather could not be loaded", towns: [], failed }, 502);
  return json(request, { towns, failed, updated_at: new Date().toISOString(), source: "Google Weather" }, 200, "public, max-age=10800");
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

async function handleGms(request, env) {
  if (!env.GOOGLE_API_KEY) return json(request, { error: "GMS live hours are not configured" }, 503);
  const response = await fetch(`https://places.googleapis.com/v1/places/${GMS_PLACE_ID}`, {
    headers: {
      "Accept": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_API_KEY,
      "X-Goog-FieldMask": "id,displayName,formattedAddress,businessStatus,currentOpeningHours,regularOpeningHours,googleMapsUri,websiteUri"
    }
  });
  if (!response.ok) return json(request, { error: "GMS live hours could not be loaded" }, 502);
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

async function handleAddress(request, env) {
  if (!env.GOOGLE_API_KEY) return json(request, { error: "Address search is not configured", results: [] }, 503);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 180);
  const limit = Math.max(1, Math.min(6, number(url.searchParams.get("limit"), 6)));
  if (q.length < 3) return json(request, { results: [] });
  const address = /new zealand|\bnz\b/i.test(q) ? q : `${q}, Taranaki, New Zealand`;
  const params = new URLSearchParams({ address, key: env.GOOGLE_API_KEY, region: "nz", components: "country:NZ" });
  const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
  if (!response.ok) return json(request, { error: "Address search could not be loaded", results: [] }, 502);
  const payload = await response.json();
  if (payload.status && payload.status !== "OK" && payload.status !== "ZERO_RESULTS") {
    return json(request, { error: payload.error_message || payload.status, results: [] }, 502);
  }
  const results = (payload.results || []).slice(0, limit).map(result => ({
    label: String(result.formatted_address || "").replace(/, New Zealand$/, ""),
    lat: number((((result.geometry || {}).location || {}).lat), NaN),
    lng: number((((result.geometry || {}).location || {}).lng), NaN)
  })).filter(result => result.label && Number.isFinite(result.lat) && Number.isFinite(result.lng));
  return json(request, { results }, 200, "public, max-age=2592000");
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/weather" && request.method === "POST") return await handleWeather(request, env);
      if (url.pathname === "/gms-hours" && request.method === "GET") return await handleGms(request, env);
      if (url.pathname === "/address-search" && request.method === "GET") return await handleAddress(request, env);
      return json(request, { error: "Not found" }, 404);
    } catch (error) {
      return json(request, { error: "Live service could not be loaded" }, 502);
    }
  }
};
