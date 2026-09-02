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
  "bookingNavAddress", "navAddress"
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
});

test("booking and customer map links also remove the slash unit", () => {
  assert.equal(
    context.bookingNavAddress({ streetAddress: "1/34 Waimea Street", town: "Westown", area: "New Plymouth" }),
    "34 Waimea Street, Westown, New Plymouth, Taranaki, New Zealand"
  );
});
