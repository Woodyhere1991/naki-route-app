import assert from "node:assert/strict";
import test from "node:test";

import { handleJotformSubmission } from "../src/customer.js";

function fakeDatabase() {
  const bookings = new Map();
  let inserts = 0;
  return {
    get inserts() { return inserts; },
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
            async run() {
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

function requestFor(submissionID) {
  return new Request("https://example.test/jotform/submission?key=test-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      formID: "251768488640874",
      submissionID,
      rawRequest: {
        q4_name: { first: "Same", last: "Customer" },
        q5_address: { addr_line1: "1 Test Street", city: "New Plymouth" },
        q35_email: "same@example.com",
        q39_number: "0210000000",
        q7: "Washing machine"
      }
    })
  });
}

const json = (_request, body, status = 200) => ({ body, status });

test("different Jotform submission IDs are never merged by email and items", async () => {
  const db = fakeDatabase();
  const env = { CUSTOMER_DB: db, JOTFORM_WEBHOOK_SECRET: "test-secret" };
  const emails = [];
  const sendMail = async (_env, message) => { emails.push(message); return true; };

  const first = await handleJotformSubmission(requestFor("123456789012345"), env, json, sendMail);
  const second = await handleJotformSubmission(requestFor("123456789012346"), env, json, sendMail);

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(db.inserts, 2);
  assert.equal(emails.length, 2);
});
