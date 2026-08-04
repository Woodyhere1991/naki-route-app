import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/customer.js", import.meta.url), "utf8");
const { arcadeContactAllowed, directChatAllowed } = await import(
  `data:text/javascript,${encodeURIComponent(source)}`
);

const kaylee = "8dd18c74-4c57-4df7-a288-50bd3f366947";
const maddie = "812581f5-ebce-4337-9160-17ee73a9c1bd";
const approved = [
  "15d66880-9a74-4d7f-895d-e566e9549320", // Rene champ
  "c76ed0d5-73a4-4a43-ad30-6cc4b27e2524", // Chloe
  "a35ea2ce-1897-4ee0-bc67-7b70daeb17c4", // Sin
  "89ff9ebb-44eb-492d-9ab3-2f991d32d950"  // Woody
];
const outsider = "cfd1f834-8547-4f3e-ab14-d1a96450f094";

for (const contact of approved) {
  assert.equal(arcadeContactAllowed(kaylee, contact), true);
  assert.equal(arcadeContactAllowed(maddie, contact), true);
  assert.equal(directChatAllowed(contact, kaylee), true);
  assert.equal(directChatAllowed(contact, maddie), true);
}

assert.equal(arcadeContactAllowed(kaylee, maddie), false);
assert.equal(arcadeContactAllowed(kaylee, outsider), false);
assert.equal(arcadeContactAllowed(maddie, outsider), false);
assert.equal(arcadeContactAllowed(outsider, "another-account"), true);
assert.equal(directChatAllowed(kaylee, outsider), false);

console.log("PASS: Kaylee/Maddie Arcade allowlist policy");
