import assert from "node:assert/strict";
import test from "node:test";

import {
  addressMatchScore,
  houseNumberOf,
  linzCqlFor,
  physicalAddressQuery
} from "../src/index.js";

test("a slash address keeps its unit but searches the physical street number", () => {
  assert.equal(houseNumberOf("1/34 Waimea Street"), "34");
  assert.equal(physicalAddressQuery("1/34 Waimea Street, Westown"), "34 Waimea Street, Westown");
});

test("34 is preferred and 34A is rejected for unit 1 at 34", () => {
  assert.equal(addressMatchScore("1/34 Waimea Street", "34 Waimea Street, Westown"), 2);
  assert.equal(addressMatchScore("1/34 Waimea Street", "34A Waimea Street, Westown"), 0);
  assert.equal(addressMatchScore("1/34 Waimea Street", "1/34 Waimea Street, Westown"), 3);
});

test("LINZ lookup uses street number 34 and the unit separately", () => {
  const exact = linzCqlFor("1/34 Waimea Street, Westown, New Plymouth", true, false, false);
  assert.match(exact, /address_number=34/);
  assert.match(exact, /full_road_name_ascii ILIKE 'Waimea Street%'/);
  assert.match(exact, /lower\(unit_value\)='1'/);

  const physicalFallback = linzCqlFor("1/34 Waimea Street, Westown, New Plymouth", true, false, true);
  assert.doesNotMatch(physicalFallback, /unit_value/);
});
