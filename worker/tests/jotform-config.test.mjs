import assert from "node:assert/strict";
import test from "node:test";

import { JOTFORM_FORM_CONFIG } from "../src/customer.js";

test("supports every live whiteware Jotform with its own field layout", () => {
  assert.deepEqual(Object.keys(JOTFORM_FORM_CONFIG).sort(), [
    "240411186193047",
    "251768488640874",
    "252021546019044"
  ]);

  assert.deepEqual(JOTFORM_FORM_CONFIG["252021546019044"], {
    applianceQids: [7, 8, 54, 55, 56, 57, 58, 59, 60, 61],
    referralSourceQid: 69,
    referralDetailsQid: 70
  });
});
