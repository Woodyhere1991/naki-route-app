import assert from "node:assert/strict";
import test from "node:test";

import { jotformAddress } from "../src/customer.js";

test("drops a town field that is just the street address pasted again", () => {
  assert.deepEqual(jotformAddress({
    addr_line1: "1/34 waimea  street westown  newplymouth",
    city: "Unit 1/34 waimea street westown newplymouth"
  }), {
    streetAddress: "1/34 waimea street westown newplymouth",
    town: "",
    area: ""
  });
});

test("keeps a real town and region", () => {
  assert.deepEqual(jotformAddress({
    addr_line1: "58 Waimea street",
    city: "New Plymouth",
    state: "Taranaki"
  }), {
    streetAddress: "58 Waimea street",
    town: "New Plymouth",
    area: "Taranaki"
  });
});

test("drops a duplicate address line 2", () => {
  assert.deepEqual(jotformAddress({
    addr_line1: "14 Newbury Place",
    addr_line2: "14 Newbury Place",
    city: "New Plymouth"
  }), {
    streetAddress: "14 Newbury Place",
    town: "New Plymouth",
    area: ""
  });
});
