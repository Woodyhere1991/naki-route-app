import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in index.html`);
  const open = html.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function sliceBetween(fromText, toText) {
  const from = html.indexOf(fromText);
  const to = html.indexOf(toText, from);
  assert.notEqual(from, -1, fromText);
  assert.notEqual(to, -1, toText);
  return html.slice(from, to);
}

const names = [
  "haversine", "isUnload", "applyGeo", "routeMatrixFallback", "routeSequenceCost",
  "greedyRoadOrder", "improveRoadOrder", "exactRoadOrder", "smartestRoadOrder",
  "orderRunAroundUnloads"
];
const context = {};
vm.runInNewContext("const PIN_FIX = 7;\n" + names.map(functionSource).join("\n"), context);

const inglewood = { id: "start", lat: -39.1611, lng: 174.2066 };
const waitara = { id: "waitara", lat: -39.0014, lng: 174.2383, status: "NEW" };
const hawera = { id: "hawera", lat: -39.591, lng: 174.2835, status: "NEW" };
const bell = { id: "bell", lat: -39.0323, lng: 174.148, status: "NEW" };
const yard = { id: "gms", kind: "unload", lat: -39.0323484, lng: 174.1650931, status: "NEW" };

test("a crossed Taranaki run is uncrossed, north towns before Hawera", () => {
  const all = [waitara, hawera, bell];
  const matrix = context.routeMatrixFallback([inglewood, ...all]);
  const best = context.smartestRoadOrder(all, matrix, 0, null).map(s => s.id);
  assert.equal(best.join(","), "bell,waitara,hawera");
});

test("a GMS unload stays where Woody put it, and only that leg is reordered", () => {
  const all = [hawera, waitara, yard, bell];
  const matrix = context.routeMatrixFallback([inglewood, ...all]);
  const best = context.orderRunAroundUnloads(all, matrix, 0, null).map(s => s.id);
  assert.equal(best[2], "gms");
  assert.equal([...best.slice(0, 2)].sort().join(","), "hawera,waitara");
  assert.equal(best[3], "bell");
  assert.ok(best.indexOf("waitara") < best.indexOf("gms"));
  assert.ok(best.indexOf("hawera") < best.indexOf("gms"));
});

test("a later lookup cannot drag a Taranaki pin to another city's street of the same name", () => {
  const stop = { lat: -39.0014, lng: 174.2383, geoLabel: "" };
  context.applyGeo(stop, { lat: -45.94915, lng: 170.32567, label: "Queen Street, Dunedin" });
  assert.equal(stop.lat, -39.0014);
  assert.equal(stop.lng, 174.2383);
  assert.equal(stop.geoLabel, "");
  context.applyGeo(stop, { lat: -39.002, lng: 174.239, label: "15 Queen Street, Waitara" });
  assert.equal(stop.geoLabel, "15 Queen Street, Waitara");
});

test("a stray pin outside Taranaki can be pulled back to the typed town", () => {
  const stop = { lat: -45.94915, lng: 170.32567, geoLabel: "Queen Street, Dunedin" };
  context.applyGeo(stop, { lat: -39.0014, lng: 174.2383, label: "15 Queen Street, Waitara" });
  assert.equal(stop.lat, -39.0014);
  assert.equal(stop.lng, 174.2383);
  assert.equal(stop.geoLabel, "15 Queen Street, Waitara");
});

test("the map pin prefers the township road when the same name exists twice", () => {
  const pinSource = "const PIN_FIX = 7;\n" + functionSource("normKey") + "\n" + functionSource("houseNumberOf") + "\n" +
    functionSource("addressUnitOf") + "\n" + functionSource("labelDroppedNumber") + "\n" + functionSource("haversine") + "\n" +
    sliceBetween("function looseKey(text){", "function applyGeo(") + "\n" + functionSource("applyGeo");
  const pin = {};
  vm.runInNewContext(pinSource, pin);
  const waitoriki = { label: "Lincoln Road, Waitoriki, Inglewood", lat: -39.1248, lng: 174.2576 };
  const township = { label: "201 Lincoln Road, Inglewood", lat: -39.1458, lng: 174.2213 };
  const picked = pin.pickAddressResult([waitoriki, township], "201 Lincoln Rd, Inglewood");
  assert.equal(picked.lat, township.lat);
  assert.equal(picked.lng, township.lng);
  const patea = { label: "Hursthouse Road, Alton, Patea", lat: -39.6728, lng: 174.4545 };
  const inglewoodRoad = { label: "Hursthouse Road, Inglewood", lat: -39.154, lng: 174.221 };
  const hursthouse = pin.pickAddressResult([patea, inglewoodRoad], "Hursthouse Road, Inglewood");
  assert.equal(hursthouse.lat, inglewoodRoad.lat);
  assert.equal(pin.pickAddressResult([patea], "Hursthouse Road, Inglewood"), null);
  assert.equal(pin.pinNeedsRelookup({
    street: "Hursthouse Road", town: "Inglewood", geoLabel: township.label
  }), true);
  assert.equal(pin.pinNeedsRelookup({
    street: "Hursthouse Road", town: "Inglewood", geoLabel: township.label, pinFix: 7
  }), false);
  assert.equal(pin.pinNeedsRelookup({
    street: "Hursthouse Road", town: "Inglewood", geoLabel: patea.label, pinFix: 7
  }), true);
  const pitone = { label: "217 Greenwood Road, Pitone, New Plymouth", lat: -39.132116, lng: 173.89912 };
  assert.equal(pin.pickAddressResult([pitone], "217 Greenwood Road, Hawera").lat, pitone.lat);
  assert.equal(pin.suburbUnexpected(pitone.label, "Pitone", "Pitone"), false);
  const greenwood = { street: "217 Greenwood Road", town: "Pitone", lat: null, lng: null };
  pin.applyGeo(greenwood, pitone);
  assert.equal(greenwood.lat, pitone.lat);
  assert.equal(greenwood.geoLabel, pitone.label);
});

test("optimise tells Woody it finished after releasing the spinner, not before drawing the map", () => {
  const source = sliceBetween("async function optimise(){", "/* ---------- Map drawing");
  const flashAt = source.indexOf("flash(");
  const busyOff = source.lastIndexOf("setRouteOptimiseBusy(false)");
  const drawAt = source.lastIndexOf("drawRoute()");
  assert.ok(flashAt > 0 && busyOff > 0 && drawAt > 0);
  assert.ok(busyOff < flashAt, "confirmation must come after the spinner is released");
  assert.ok(flashAt < drawAt, "the map line must not block the confirmation");
  assert.equal(/save\(\); render\(\); await drawRoute\(\)/.test(source), false);
  assert.equal(/if\(optimised\) await drawRoute\(\)/.test(source), false);
});

// Runs the real optimise() with the map and road-time lookups stubbed out, so
// what Woody sees in the actions line is checked, not just the order of code.
function optimiseHarness({ slowMap = true, stopsChangeMidway = false, roadTimesFail = false } = {}) {
  const status = { text: "", color: "" }, calls = [];
  let finishMap;
  const env = {
    status, calls,
    routeOptimiseBusy: false,
    document: { getElementById: () => ({ disabled: false, setAttribute() {} }) },
    busy(msg) { status.text = msg ? "spinner " + msg : ""; status.color = ""; },
    flash(msg) { status.text = msg; status.color = "good"; },
    stops: [{ id: "a" }, { id: "b" }],
    routeStops() { return env.stops; },
    startPoint: () => ({ lat: 0, lng: 0 }), endPoint: () => null,
    async roadTimeMatrix() {
      if (stopsChangeMidway) env.stops = [{ id: "a" }];
      if (roadTimesFail) throw new Error("offline");
      return [[0]];
    },
    routeMatrixFallback: () => [[0]],
    orderRunAroundUnloads: all => [...all].reverse(),
    state: { stops: [{ id: "a" }, { id: "b" }, { id: "done" }], manual: true },
    save() { calls.push("save"); }, render() { calls.push("render"); },
    drawRoute() { calls.push("drawRoute"); return slowMap ? new Promise(resolve => { finishMap = resolve; }) : Promise.resolve(); },
    finishMap: () => finishMap?.()
  };
  vm.runInNewContext("var routeOptimiseBusy=false;\n" + functionSource("setRouteOptimiseBusy") + "\n" +
    sliceBetween("async function optimise(){", "/* ---------- Map drawing") +
    "\nthis.optimise=optimise;this.busyNow=()=>routeOptimiseBusy;", env);
  return env;
}

test("Optimise shows its green confirmation straight away, even while the map line is still loading", async () => {
  const run = optimiseHarness();
  const result = await run.optimise();
  assert.equal(result, true);
  assert.equal(run.status.text, "✓ Route optimised using real driving times");
  assert.equal(run.status.color, "good");
  assert.equal(run.busyNow(), false, "the buttons are usable again");
  assert.deepEqual(run.state.stops.map(s => s.id), ["b", "a", "done"]);
  assert.equal(run.state.manual, false);
  assert.deepEqual(run.calls, ["save", "render", "drawRoute"]);
  run.finishMap();
  assert.equal(run.status.text, "✓ Route optimised using real driving times", "the map finishing does not wipe it");
});

test("Optimise says when it had to use distance estimates", async () => {
  const run = optimiseHarness({ roadTimesFail: true, slowMap: false });
  assert.equal(await run.optimise(), false);
  assert.match(run.status.text, /Road timings were unavailable/);
});

test("Optimise clears its spinner and changes nothing if the stops change while it works", async () => {
  const run = optimiseHarness({ stopsChangeMidway: true });
  assert.equal(await run.optimise(), false);
  assert.equal(run.status.text, "");
  assert.equal(run.busyNow(), false);
  assert.deepEqual(run.calls, []);
  assert.deepEqual(run.state.stops.map(s => s.id), ["a", "b", "done"]);
});
