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

const names = [
  "normKey", "addressWithoutUnit", "houseNumberOf", "labelDroppedNumber",
  "looksLikeStreetAddress", "uniqueAddressParts", "safeMapsAddress",
  "bookingNavAddress", "navAddress", "mapsDirUrl"
];
const context = {};
vm.runInNewContext(names.map(functionSource).join("\n"), context);

test("phone navigation never sends slash-unit notation or a guessed letter", () => {
  const oldWrongStop = {
    street: "1/34 waimea street westown newplymouth",
    town: "",
    geoLabel: "34A Waimea Street, Westown, New Plymouth"
  };
  assert.equal(
    context.navAddress(oldWrongStop),
    "34 waimea street westown newplymouth, Taranaki, New Zealand"
  );
  assert.doesNotMatch(context.navAddress(oldWrongStop), /1\/34|34A/i);
  assert.equal(
    decodeURIComponent(context.mapsDirUrl({ ...oldWrongStop, lat: -39.08029885, lng: 174.05688065 })),
    "https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate&destination=34 waimea street westown newplymouth, Taranaki, New Zealand"
  );
});

test("a confirmed physical 34 result is safe for the unit pickup", () => {
  const correctedStop = {
    street: "1/34 Waimea Street",
    town: "Westown, New Plymouth",
    geoLabel: "34 Waimea Street, Westown, New Plymouth"
  };
  assert.equal(
    context.navAddress(correctedStop),
    "34 Waimea Street, Westown, New Plymouth, New Zealand"
  );
  assert.equal(
    context.mapsDirUrl({ ...correctedStop, lat: -39.0800806167, lng: 174.0572009167 }),
    "https://www.google.com/maps/dir/?api=1&travelmode=driving&dir_action=navigate&destination=-39.0800806167,174.0572009167"
  );
});

test("booking and customer map links also remove the slash unit", () => {
  assert.equal(
    context.bookingNavAddress({ streetAddress: "1/34 Waimea Street", town: "Westown", area: "New Plymouth" }),
    "34 Waimea Street, Westown, New Plymouth, Taranaki, New Zealand"
  );
});

test("common unit spellings all navigate to the physical street number", () => {
  const cases = [
    ["Flat 1, 34 Waimea Street", "34 Waimea Street"],
    ["Flat 1 34 Waimea Street", "34 Waimea Street"],
    ["Unit 1 at 34 Waimea Street", "34 Waimea Street"],
    ["#1/34 Waimea Street", "34 Waimea Street"],
    ["U1/34 Waimea Street", "34 Waimea Street"],
    ["4B/22-26 High Street", "22-26 High Street"]
  ];
  for (const [entered, physical] of cases) {
    assert.equal(context.addressWithoutUnit(entered), physical, entered);
    assert.equal(context.houseNumberOf(entered), context.houseNumberOf(physical), entered);
  }
});

test("registered unit coordinates are used instead of a slash address string", () => {
  const officialUnit = {
    street: "1/10A Brixham Place",
    town: "Merrilands, New Plymouth",
    geoLabel: "1/10A Brixham Place, Merrilands, New Plymouth",
    lat: -39.05975125,
    lng: 174.1023672667
  };
  const url = context.mapsDirUrl(officialUnit);
  assert.match(url, /destination=-39\.05975125,174\.1023672667$/);
  assert.doesNotMatch(url, /1%2F10A|1\/10A/i);
});

test("lettered houses, registered ranges, rural numbers and numberless roads stay intact", () => {
  const cases = [
    ["34A Waimea Street", "34a"],
    ["127-129 Connett Road", "127-129"],
    ["1A-7A Puka Place", "1a-7a"],
    ["1230 Mokau Road", "1230"],
    ["State Highway 3", ""]
  ];
  for (const [entered, expected] of cases) {
    assert.equal(context.houseNumberOf(entered), expected, entered);
    assert.equal(context.safeMapsAddress(entered, "Taranaki", ""), `${entered}, Taranaki`, entered);
  }
});
