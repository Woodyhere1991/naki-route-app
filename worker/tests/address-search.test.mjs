import assert from "node:assert/strict";
import test from "node:test";

import {
  addressMatchScore,
  expandStreetAbbreviations,
  houseNumberOf,
  linzAddressResults,
  linzCqlFor,
  physicalAddressQuery,
  preferLocalAddressResults,
  sideWordLast,
  tidyStreetLine,
  pinFromNeighbours,
  suburbUnexpected
} from "../src/index.js";

test("a slash address keeps its unit but searches the physical street number", () => {
  const cases = [
    ["1/34 Waimea Street", "34", "34 Waimea Street"],
    [" UNIT 2A / 34B Waimea Street ", "34b", "34b Waimea Street"],
    ["Flat 1, 34 Waimea Street", "34", "34 Waimea Street"],
    ["Flat 1 34 Waimea Street", "34", "34 Waimea Street"],
    ["Unit 1 at 34 Waimea Street", "34", "34 Waimea Street"],
    ["#1/34 Waimea Street", "34", "34 Waimea Street"],
    ["U1/34 Waimea Street", "34", "34 Waimea Street"],
    ["4B/22-26 High Street", "22-26", "22-26 High Street"],
    ["127-129 Connett Road", "127-129", "127-129 Connett Road"],
    ["1A-7A Puka Place", "1a-7a", "1A-7A Puka Place"],
    ["34A Waimea Street", "34a", "34A Waimea Street"],
    ["1230 Mokau Road", "1230", "1230 Mokau Road"],
    ["State Highway 3", "", "State Highway 3"]
  ];
  for (const [entered, house, physical] of cases) {
    assert.equal(houseNumberOf(entered), house, entered);
    assert.equal(physicalAddressQuery(entered), physical, entered);
  }
});

test("34 is preferred and 34A is rejected for unit 1 at 34", () => {
  assert.equal(addressMatchScore("1/34 Waimea Street", "34 Waimea Street, Westown"), 2);
  assert.equal(addressMatchScore("1/34 Waimea Street", "34A Waimea Street, Westown"), 0);
  assert.equal(addressMatchScore("1/34 Waimea Street", "1/34 Waimea Street, Westown"), 3);
  assert.equal(addressMatchScore("1/34 Waimea Street", "2/34 Waimea Street, Westown"), 1);
  assert.equal(addressMatchScore("1/34 Waimea Street", "34 Waimea Street, Westown"), 2);
});

test("LINZ lookup uses street number 34 and the unit separately", () => {
  const exact = linzCqlFor("1/34 Waimea Street, Westown, New Plymouth", true, false, false);
  assert.match(exact, /address_number=34/);
  assert.match(exact, /full_road_name_ascii ILIKE 'Waimea Street%'/);
  assert.match(exact, /lower\(unit_value\)='1'/);
  assert.match(exact, /territorial_authority_ascii ILIKE '%New Plymouth%'/);

  const physicalFallback = linzCqlFor("1/34 Waimea Street, Westown, New Plymouth", true, false, true);
  assert.doesNotMatch(physicalFallback, /unit_value/);
});

test("LINZ lookup keeps registered address ranges exact", () => {
  const range = linzCqlFor("127-129 Connett Road, Bell Block, New Plymouth", true, false, false);
  assert.match(range, /address_number=127/);
  assert.match(range, /address_number_high=129/);
  assert.match(range, /full_road_name_ascii ILIKE 'Connett Road%'/);

  const letteredRange = linzCqlFor("1A-7A Puka Place, Inglewood", true, false, false);
  assert.match(letteredRange, /address_number=1/);
  assert.match(letteredRange, /address_number_high=7/);
  assert.match(letteredRange, /lower\(address_number_suffix\)='a'/);
  assert.match(letteredRange, /lower\(full_address_number\) LIKE '1a-7a'/);
});

test("LINZ results never include a neighbouring unit or letter suffix", async () => {
  const originalFetch = globalThis.fetch;
  const feature = (fullAddressNumber, fullAddress, offset) => ({
    properties: { full_address_number: fullAddressNumber, full_address: fullAddress },
    geometry: { coordinates: [174.05 + offset, -39.08 - offset] }
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ features: [
    feature("10A", "10A Test Street, New Plymouth", 0),
    feature("1/10A", "1/10A Test Street, New Plymouth", 0.001),
    feature("2/10A", "2/10A Test Street, New Plymouth", 0.002),
    feature("34", "34 Test Street, New Plymouth", 0.003),
    feature("34A", "34A Test Street, New Plymouth", 0.004)
  ] }));
  try {
    assert.deepEqual(
      (await linzAddressResults({ LINZ_API_KEY: "test" }, "1/10A Test Street, New Plymouth", 6)).map(row => row.label),
      ["1/10A Test Street, New Plymouth"]
    );
    assert.deepEqual(
      (await linzAddressResults({ LINZ_API_KEY: "test" }, "9/10A Test Street, New Plymouth", 6)).map(row => row.label),
      ["10A Test Street, New Plymouth"]
    );
    assert.deepEqual(
      (await linzAddressResults({ LINZ_API_KEY: "test" }, "34 Test Street, New Plymouth", 6)).map(row => row.label),
      ["34 Test Street, New Plymouth"]
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* Woody, 18 Sept: "201 Lincoln road, Inglewood pickup when I pressed navigate sent me to
   Waitariki school a few minutes on the road."

   Reproduced against the live service, and the cause was an ABBREVIATION:

     "201 Lincoln Road, Inglewood"   -> 201 Lincoln Road, Inglewood    CORRECT
     "201 Lincoln Rd, Inglewood"     -> 201, Lincoln Road, Waitoriki   WRONG

   The authoritative register stores "Lincoln Road", so "Lincoln Rd" matched nothing, fell
   through to the map, and the map's first hit was the OTHER Lincoln Road - Inglewood has
   two, and the wrong one is by Waitoriki School, about 2.8km away. */
test("a trailing street abbreviation is expanded so the register is asked properly", () => {
  const cases = [
    ["201 Lincoln Rd, Inglewood", "201 Lincoln Road, Inglewood"],
    ["12 Rata St, Inglewood", "12 Rata Street, Inglewood"],
    ["5a Devon Ave, New Plymouth", "5a Devon Avenue, New Plymouth"],
    ["9 Coronation Dr, Waitara", "9 Coronation Drive, Waitara"],
    ["23 Huatoki Pl, New Plymouth", "23 Huatoki Place, New Plymouth"],
    ["45 South Rd, Manaia", "45 South Road, Manaia"],
    ["201 LINCOLN RD, INGLEWOOD", "201 LINCOLN ROAD, INGLEWOOD"]
  ];
  for (const [entered, expanded] of cases) {
    assert.equal(expandStreetAbbreviations(entered), expanded, entered);
  }
});

test("only the street line is expanded, and real names are never mangled", () => {
  for (const untouched of [
    "201 Lincoln Road, Inglewood",
    "St Marys Road, New Plymouth",     // "St" here is part of the name
    "1/34 Waimea Street, Westown, New Plymouth",
    "1230 Mokau Road, Urenui",
    "State Highway 3, Waitara",
    "Lincoln Road",
    "12 Rata Street, Inglewood"
  ]) {
    assert.equal(expandStreetAbbreviations(untouched), untouched, untouched);
  }
  /* The town must survive byte-for-byte: an earlier version of this rebuilt every
     comma-separated segment and inserted a stray space into the town name. */
  assert.equal(expandStreetAbbreviations("201 Lincoln Rd, Inglewood"), "201 Lincoln Road, Inglewood");
  assert.equal(expandStreetAbbreviations("9 Coronation Dr,Waitara"), "9 Coronation Drive,Waitara");
});

test("the township Lincoln Road beats the Waitoriki one when both come back", () => {
  const waitoriki = {
    label: "Lincoln Road, Waitoriki, Inglewood",
    lat: -39.1248, lng: 174.2576
  };
  const township = {
    label: "201 Lincoln Road, Inglewood",
    lat: -39.1458, lng: 174.2213
  };
  const query = "201 Lincoln Rd, Inglewood";
  assert.equal(suburbUnexpected(waitoriki.label, "Inglewood", "Inglewood"), true);
  assert.equal(suburbUnexpected(township.label, "Inglewood", "Inglewood"), false);
  const picked = preferLocalAddressResults([waitoriki, township], query);
  assert.equal(picked[0].label, township.label);
  assert.equal(picked[0].lat, township.lat);
  assert.deepEqual(preferLocalAddressResults([waitoriki], "123 Unique Road, Inglewood"), []);
});

test("a rural RAPID is kept when LINZ names the district, not the postal town", () => {
  const pitone = {
    label: "217 Greenwood Road, Pitone, New Plymouth",
    lat: -39.132116, lng: 173.89912
  };
  assert.equal(suburbUnexpected(pitone.label, "Oakura", "Oakura"), false);
  assert.equal(suburbUnexpected(pitone.label, "Pitone", "Pitone"), false);
  assert.equal(preferLocalAddressResults([pitone], "217 Greenwood Road, Oakura")[0].label, pitone.label);
  assert.equal(preferLocalAddressResults([pitone], "217 Greenwood Road, Inglewood")[0].label, pitone.label);
  assert.equal(preferLocalAddressResults([pitone], "217 Greenwood Road, Pitone")[0].label, pitone.label);
  assert.equal(preferLocalAddressResults([pitone], "217 Greenwood Road, Hawera")[0].label, pitone.label);
  const leigh = { label: "217 Greenwood Road, Leigh", lat: -36.2906, lng: 174.8008 };
  assert.equal(preferLocalAddressResults([leigh, pitone], "217 Greenwood Road, Oakura")[0].label, pitone.label);
  assert.deepEqual(preferLocalAddressResults([leigh], "217 Greenwood Road, Oakura"), []);
});

test("an Inglewood street is not pinned on the Patea road of the same name", () => {
  const patea = { label: "Hursthouse Road, Alton, Patea", lat: -39.6728, lng: 174.4545 };
  const inglewood = { label: "Hursthouse Road, Inglewood", lat: -39.154, lng: 174.221 };
  const query = "Hursthouse Road, Inglewood";
  assert.equal(suburbUnexpected(patea.label, "Inglewood", "Inglewood"), true);
  const picked = preferLocalAddressResults([patea, inglewood], query);
  assert.equal(picked[0].label, inglewood.label);
  assert.deepEqual(preferLocalAddressResults([patea], query), []);
});

test("townhouses search their exact unit and never accept neighbouring units", () => {
  assert.equal(physicalAddressQuery("TH78/71 Barrett Road"), "71 Barrett Road");
  assert.match(linzCqlFor("TH78/71 Barrett Road", false, false), /unit_value\)='78'/);
  const wrong = {label:"79/71 Barrett Road, New Plymouth", lat:-39.0845, lng:174.037};
  assert.deepEqual(preferLocalAddressResults([wrong], "TH78/71 Barrett Road, New Plymouth"), []);
  assert.deepEqual(preferLocalAddressResults([wrong], "71 Barrett Road, New Plymouth"), []);
});

/* Woody, 20 Oct: "4 lower TIMARU ROAD, Okato" would not find. LINZ registers the
   road as "Timaru Road Lower", so the typed order matched nothing. */
test("a Lower/Upper road is found whichever order it is written in", () => {
  const typed = linzCqlFor("4 lower TIMARU ROAD, Okato, Tataraimaka", false, false);
  assert.match(typed, /address_number=4/);
  assert.match(typed, /full_road_name_ascii ILIKE 'Lower TIMARU%' OR full_road_name_ascii ILIKE 'TIMARU% Lower'/);
  const flipped = linzCqlFor("71 Dudley Road Lower, Inglewood", false, false);
  assert.match(flipped, /ILIKE 'Lower Dudley%' OR full_road_name_ascii ILIKE 'Dudley% Lower'/);
  const roadOnly = linzCqlFor("Upper Timaru Road, Okato", false, false);
  assert.match(roadOnly, /full_address_ascii ILIKE '%Upper Timaru Road%' OR full_address_ascii ILIKE '%Timaru Road% Upper%'/);
  // Ordinary roads are asked exactly as before.
  assert.match(linzCqlFor("380 Lower Pitone Road, Oakura", false, false), /'Lower Pitone%'/);
  assert.match(linzCqlFor("201 Lincoln Road, Inglewood", false, false), /full_road_name_ascii ILIKE 'Lincoln Road%'/);
  assert.equal(sideWordLast("Lower Timaru Road"), "Timaru Road Lower");
  assert.equal(sideWordLast("Timaru Road Lower"), "Timaru Road Lower");
  assert.equal(sideWordLast("Lower"), "Lower");
});

/* Every past booking address was run through the finder on 20 Oct 2026. These
   ones found nothing only because of how they were typed. */
test("street lines are tidied to the register's spelling before the lookup", () => {
  const cases = [
    ["1892 Eltham rd., Riverlea", "1892 Eltham rd, Riverlea"],
    ["12 Aotea Street., New Plymouth", "12 Aotea Street, New Plymouth"],
    ["34 Plympton  St.    Brooklands, New Plymouth", "34 Plympton St, Brooklands, New Plymouth"],
    ["410 Saint Aubyn Street, New Plymouth", "410 St Aubyn Street, New Plymouth"],
    ["12 a standish  st, Inglewood", "12a standish st, Inglewood"],
    ["30 Standish Street Flat 3, Inglewood", "30 Standish Street, Inglewood"],
    ["192a Pendarves St Lynmouth", "192a Pendarves St, Lynmouth"]
  ];
  for (const [typed, tidied] of cases) assert.equal(tidyStreetLine(typed), tidied, typed);
  for (const same of ["100 Devon Street West, New Plymouth", "4 Timaru Road Lower, Okato",
    "12 Sea View Road, Oakura", "St Marys Road, New Plymouth", "1/34 Waimea Street, Westown",
    "Flat 1, 18 Dixon Ave, New Plymouth", "45 South Road, Manaia", "2 Mill Road Extension, Stratford"]) {
    assert.equal(tidyStreetLine(same), same, same);
  }
});

test("compass words are found in either order too", () => {
  assert.match(linzCqlFor("60 Pembroke east road, Stratford", false, false),
    /ILIKE 'East Pembroke%' OR full_road_name_ascii ILIKE 'Pembroke% East'/);
  assert.match(linzCqlFor("45 South Road, Manaia", false, false), /'South Road%'/);
  assert.equal(sideWordLast("Pembroke east road"), "Pembroke road east");
  assert.equal(sideWordLast("Pembroke Road East"), "Pembroke Road East");
});

test("a compass word in the middle of a name is still asked as typed", () => {
  assert.match(linzCqlFor("1378 Main North Road, Urenui", false, false), /full_road_name_ascii ILIKE 'Main North%' OR/);
  assert.doesNotMatch(linzCqlFor("4 Lower Timaru Road, Okato", false, false), /'Timaru Road%'/);
});

test("an unregistered number is pinned from its neighbours on the same side", () => {
  const row = (number, lat, lng, extra = {}) => ({ number, lat, lng, suffix: "", unit: "", ...extra });
  const rows = [row(1, -39.0, 174.0), row(4, -39.001, 174.0), row(8, -39.003, 174.0), row(12, -39.01, 174.0),
    row(12, -39.0101, 174.0, { suffix: "b" }), row(5, -39.5, 174.5, { unit: "2" })];
  assert.deepEqual(pinFromNeighbours(rows, "12"), { lat: -39.01, lng: 174.0 }, "12A uses 12's letterbox");
  const six = pinFromNeighbours(rows, "6");
  assert.ok(Math.abs(six.lat - -39.002) < 1e-9, "6 sits halfway between 4 and 8");
  assert.deepEqual(pinFromNeighbours(rows, "2"), { lat: -39.001, lng: 174.0 }, "2 uses 4, the nearest even");
  assert.equal(pinFromNeighbours(rows, "40"), null, "too far from any neighbour");
  assert.deepEqual(pinFromNeighbours([row(3, -39, 174), row(9, -39.2, 174)], "5"), { lat: -39, lng: 174 }, "neighbours far apart: the nearer one, not a point between");
});
