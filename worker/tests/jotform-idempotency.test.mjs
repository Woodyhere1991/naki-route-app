import assert from "node:assert/strict";
import test from "node:test";

import { handleJotformSubmission } from "../src/customer.js";

function fakeDatabase() {
  const bookings = new Map();
  let inserts = 0;
  return {
    get inserts() { return inserts; },
    bookings,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes("FROM customers")) return null;
              if (sql.includes("WHERE submission_id = ?1")) {
                const booking = bookings.get(String(values[0]));
                return booking || null;
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM jotform_bookings WHERE lower(email)")) {
                const [email, since, submissionId] = values;
                return { results: [...bookings.values()].filter(row =>
                  row.email === email && row.created_at >= since && String(row.submission_id) !== String(submissionId)) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.startsWith("UPDATE jotform_bookings SET additional_info")) {
                const row = [...bookings.values()].find(b => b.id === values[2]);
                if (row) row.additional_info = values[0];
              }
              if (sql.includes("INSERT INTO jotform_bookings")) {
                inserts += 1;
                const [id, submissionId, formId, customerId, firstName, lastName,
                  phone, email, streetAddress, town, area, ruralOption, itemsJson,
                  additionalInfo, referralSource, referralDetails, totalCents,
                  quoteRequired, createdAt] = values;
                bookings.set(String(submissionId), {
                  id, submission_id: submissionId, form_id: formId, customer_id: customerId,
                  status: "NEW", first_name: firstName, last_name: lastName, phone, email,
                  street_address: streetAddress, town, area, rural_option: ruralOption,
                  items_json: itemsJson, additional_info: additionalInfo,
                  referral_source: referralSource, referral_details: referralDetails,
                  total_cents: totalCents, quote_required: quoteRequired,
                  created_at: createdAt, updated_at: createdAt, sheet_sync_status: "SYNCED"
                });
              }
              return { success: true };
            }
          };
        }
      };
    }
  };
}

function requestFor(submissionID, { street = "1 Test Street", item = "Washing machine", note = "" } = {}) {
  return new Request("https://example.test/jotform/submission?key=test-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      formID: "251768488640874",
      submissionID,
      rawRequest: {
        q4_name: { first: "Same", last: "Customer" },
        q5_address: { addr_line1: street, city: "New Plymouth" },
        q35_email: "same@example.com",
        q39_number: "0210000000",
        q7: item,
        q18_additionalInformationenquires: note
      }
    })
  });
}

const json = (_request, body, status = 200) => ({ body, status });

test("the same booking sent twice within half an hour is saved once", async () => {
  const db = fakeDatabase();
  const env = { CUSTOMER_DB: db, JOTFORM_WEBHOOK_SECRET: "test-secret" };
  const emails = [];
  const sendMail = async (_env, message) => { emails.push(message); return true; };

  const first = await handleJotformSubmission(requestFor("123456789012345"), env, json, sendMail);
  const second = await handleJotformSubmission(requestFor("123456789012346", { note: "Gate code 1234" }), env, json, sendMail);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(db.inserts, 1, "only one booking card");
  assert.equal(emails.length, 1, "only one alert to Woody");
  assert.match([...db.bookings.values()][0].additional_info, /Gate code 1234/, "a note added the second time is kept");
});

test("same person, different address or different items, is a real second booking", async () => {
  const db = fakeDatabase();
  const env = { CUSTOMER_DB: db, JOTFORM_WEBHOOK_SECRET: "test-secret" };
  const emails = [];
  const sendMail = async (_env, message) => { emails.push(message); return true; };

  await handleJotformSubmission(requestFor("123456789012345"), env, json, sendMail);
  const otherAddress = await handleJotformSubmission(requestFor("123456789012346", { street: "9 Other Road" }), env, json, sendMail);
  const otherItems = await handleJotformSubmission(requestFor("123456789012347", { item: "Fridge" }), env, json, sendMail);

  assert.equal(otherAddress.status, 201);
  assert.equal(otherItems.status, 201);
  assert.equal(db.inserts, 3);
  assert.equal(emails.length, 3);
});

test("the same booking again after half an hour is kept", async () => {
  const db = fakeDatabase();
  const env = { CUSTOMER_DB: db, JOTFORM_WEBHOOK_SECRET: "test-secret" };
  const sendMail = async () => true;
  await handleJotformSubmission(requestFor("123456789012345"), env, json, sendMail);
  [...db.bookings.values()][0].created_at -= 31 * 60 * 1000;
  const later = await handleJotformSubmission(requestFor("123456789012346"), env, json, sendMail);
  assert.equal(later.status, 201);
  assert.equal(db.inserts, 2);
});

test("a cancelled booking never blocks booking the same thing again", async () => {
  const db = fakeDatabase();
  const env = { CUSTOMER_DB: db, JOTFORM_WEBHOOK_SECRET: "test-secret" };
  const sendMail = async () => true;
  await handleJotformSubmission(requestFor("123456789012345"), env, json, sendMail);
  [...db.bookings.values()][0].status = "CANCELLED";
  const again = await handleJotformSubmission(requestFor("123456789012346"), env, json, sendMail);
  assert.equal(again.status, 201);
  assert.equal(db.inserts, 2);
});
