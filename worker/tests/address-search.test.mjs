import assert from "node:assert/strict";
import test from "node:test";

import {
  addressMatchScore,
  houseNumberOf,
  linzAddressResults,
  linzCqlFor,
  physicalAddressQuery
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
