import assert from "node:assert/strict";
import test from "node:test";

import {
  handlePortalRequest,
  normalizeShareToken,
  shareBookingUrl,
  shareDisplayName,
  shareReferralLabel
} from "../src/customer.js";

function json(_request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createFakeDb() {
  const customers = new Map();
  const tokens = [];
  const sessions = [];

  return {
    customers,
    tokens,
    sessions,
    prepare(sql) {
      const compact = sql.replace(/\s+/g, " ").trim();
      return {
        bind(...args) {
          return {
            async first() {
              if (compact.includes("FROM sessions")) {
                return sessions.find(row =>
                  row.token_hash === args[0] && row.role === args[1] && row.expires_at > args[2]
                ) || null;
              }
              if (compact.includes("FROM customer_share_tokens") && compact.includes("JOIN customers")) {
                const row = tokens.find(item => item.token === args[0]);
                if (!row) return null;
                const customer = customers.get(row.customer_id);
                return customer
                  ? { token: row.token, customer_id: row.customer_id, first_name: customer.first_name }
                  : null;
              }
              if (compact.includes("FROM customer_share_tokens") && compact.includes("customer_id")) {
                return tokens.find(item => item.customer_id === args[0]) || null;
              }
              return null;
            },
            async run() {
              if (compact.startsWith("INSERT INTO customer_share_tokens")) {
                if (tokens.some(item => item.customer_id === args[2] || item.token === args[0])) {
                  throw new Error("UNIQUE constraint failed");
                }
                tokens.push({
                  token: args[0],
                  token_hash: args[1],
                  customer_id: args[2],
                  created_at: args[3]
                });
              }
              if (compact.startsWith("UPDATE customers SET")) {
                const customer = customers.get(args[3]);
                if (customer) {
                  if (!customer.referral_source) customer.referral_source = args[0];
                  if (!customer.referral_details) customer.referral_details = args[1];
                }
              }
              return { meta: { changes: 1 } };
            },
            async all() {
              return { results: [] };
            }
          };
        }
      };
    }
  };
}

async function portal(path, { method = "GET", token = "", env, origin = "https://nakiwhitewareremoval.vip" } = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = new Request(`https://naki-route-api.example${path}`, { method, headers });
  return handlePortalRequest({
    request,
    env: { CUSTOMER_DB: env },
    path,
    json,
    sendMail: async () => true
  });
}

test("share helpers build a stable account.html?ref= booking URL", () => {
  assert.equal(normalizeShareToken("abc"), "");
  assert.equal(normalizeShareToken("good-token_1"), "good-token_1");
  assert.equal(normalizeShareToken("bad token!!"), "");
  assert.equal(
    shareBookingUrl("WoodyLink1"),
    "https://nakiwhitewareremoval.vip/account.html?ref=WoodyLink1"
  );
  assert.equal(shareDisplayName(""), "a friend");
  assert.equal(shareDisplayName("Woody"), "Woody");
  assert.equal(shareReferralLabel("Woody"), "Shared by Woody");
});

test("signed-in GET /customer/share mints one stable personal booking URL", async () => {
  const db = createFakeDb();
  const customerId = "cust-woody";
  const sessionToken = "session-token-value";
  db.customers.set(customerId, { id: customerId, first_name: "Woody", referral_source: "", referral_details: "" });
  db.sessions.push({
    token_hash: await sha256(sessionToken),
    customer_id: customerId,
    role: "customer",
    email: "owner@example.com",
    expires_at: Date.now() + 60_000
  });

  const first = await portal("/customer/share", { token: sessionToken, env: db });
  assert.equal(first.status, 200);
  const minted = await first.json();
  assert.match(minted.url, /^https:\/\/nakiwhitewareremoval\.vip\/account\.html\?ref=[A-Za-z0-9_-]{8,}$/);
  assert.equal(minted.url, shareBookingUrl(minted.token));
  assert.equal(db.tokens.length, 1);

  const second = await portal("/customer/share", { token: sessionToken, env: db });
  const again = await second.json();
  assert.equal(again.url, minted.url);
  assert.equal(again.token, minted.token);
  assert.equal(db.tokens.length, 1);
});

test("GET /customer/share without a session is 401", async () => {
  const response = await portal("/customer/share", { env: createFakeDb() });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error, "Please sign in again");
});

test("public GET /customer/share/:token returns the sharer's first name", async () => {
  const db = createFakeDb();
  db.customers.set("cust-woody", { id: "cust-woody", first_name: "Woody" });
  db.tokens.push({ token: "shareCode99", token_hash: "x", customer_id: "cust-woody", created_at: 1 });

  const found = await portal("/customer/share/shareCode99", { env: db });
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { ok: true, firstName: "Woody" });

  const missing = await portal("/customer/share/unknown99", { env: db });
  assert.equal(missing.status, 404);
});
