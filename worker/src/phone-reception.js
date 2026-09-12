/* ---- Phone receptionist ----
   Calls Woody doesn't pick up roll to a Twilio number, which streams the audio
   here. This bridges that stream to GPT-Live, which answers as the business,
   quotes off the real price list, and writes the job straight into the Bookings
   inbox as NEW - never confirmed. Woody still decides.

   Why a Durable Object: the relay has to stay up for the whole call, with one
   socket to Twilio and one to OpenAI. A plain Worker invocation is the wrong
   shape for that; a DO is built for exactly this.

   Audio never touches our storage. We keep what a booking needs and a short
   transcript of what was agreed, and nothing else. */

import { ITEM_PRICES, RURAL_PRICES, OWNER_EMAIL } from "./customer.js";
// index.js imports this module, so this is a cycle - safe only because
// sendMail is a hoisted declaration and is called at runtime, never while
// the modules are still loading.
import { sendMail } from "./index.js";

const LIVE_MODEL = "gpt-live-1";
const BACKEND_MODEL = "gpt-5.6-luna";
const VOICE = "marin";
// A caller who keeps talking shouldn't be able to run up an open-ended bill.
const CALL_MAX_MS = 10 * 60000;

export function isPhonePath(path) {
  return path === "/phone/incoming" || path === "/phone/stream";
}

/* ---- Twilio proves it is Twilio ----
   Signature is HMAC-SHA1 over the full URL with every POST field appended in
   key order. Without this, anyone who finds the URL can make our number talk. */
async function twilioSignatureValid(request, env, bodyParams) {
  const signature = request.headers.get("X-Twilio-Signature") || "";
  if (!signature || !env.TWILIO_AUTH_TOKEN) return false;
  const url = new URL(request.url);
  // Twilio signs the URL it was configured with, which is always https here.
  url.protocol = "https:";
  url.port = "";
  let payload = url.toString();
  for (const key of [...bodyParams.keys()].sort()) payload += key + bodyParams.get(key);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(env.TWILIO_AUTH_TOKEN),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== signature.length) return false;
  // Constant time, so a wrong signature can't be guessed a character at a time.
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

function twiml(body, status = 200) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status, headers: { "Content-Type": "text/xml; charset=utf-8" }
  });
}

/* Twilio asks what to do with the call; we point it at the relay socket. */
export async function phoneIncoming(request, env) {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const params = new URLSearchParams(await request.text());
  if (!await twilioSignatureValid(request, env, params)) {
    console.error("Phone reception rejected an unsigned call webhook");
    return new Response("Forbidden", { status: 403 });
  }
  if (!env.OPENAI_API_KEY) {
    return twiml("<Say>Sorry, we can't take your call right now. Please try again shortly.</Say>");
  }
  const from = (params.get("From") || "").slice(0, 24);
  const callSid = (params.get("CallSid") || "").slice(0, 40);
  const host = new URL(request.url).host;
  const stream = `wss://${host}/phone/stream?call=${encodeURIComponent(callSid)}&from=${encodeURIComponent(from)}`;
  return twiml(`<Connect><Stream url="${stream.replace(/&/g, "&amp;")}" /></Connect>`);
}

/* Twilio opens the media socket; hand it to the call's own Durable Object. */
export function phoneStream(request, env) {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected a websocket", { status: 426 });
  }
  if (!env.RECEPTION) return new Response("Reception is not configured", { status: 503 });
  const callSid = new URL(request.url).searchParams.get("call") || crypto.randomUUID();
  const id = env.RECEPTION.idFromName(callSid);
  return env.RECEPTION.get(id).fetch(request);
}

/* ---- what it is allowed to say and do ---- */
export function priceLines() {
  const seen = new Map();
  for (const [item, [first]] of Object.entries(ITEM_PRICES)) {
    if (item === "Other") continue;
    if (!seen.has(first)) seen.set(first, []);
    seen.get(first).push(item);
  }
  return [...seen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cents, items]) => `$${(cents / 100).toFixed(0)} each: ${items.join("; ")}`)
    .join("\n");
}

function nzNow() {
  const at = new Date();
  return {
    spoken: new Intl.DateTimeFormat("en-NZ", {
      timeZone: "Pacific/Auckland", weekday: "long", day: "numeric", month: "long", year: "numeric"
    }).format(at),
    iso: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Pacific/Auckland", year: "numeric", month: "2-digit", day: "2-digit"
    }).format(at)
  };
}

export function receptionLiveInstructions() {
  return [
    "You are answering the phone for Naki Whiteware Removal in New Plymouth, New Zealand. You are the receptionist, not the owner. The owner is Woody and he is out on the truck.",
    "",
    "Open with: \"Naki Whiteware Removal, how can I help?\" Nothing longer.",
    "",
    "Personality and speaking style: warm, unhurried, plain Kiwi English. Short sentences. You are on a phone line, so one question at a time and never a list.",
    "Say prices and dates the way a person does - 'twenty dollars', 'Thursday the twentieth'.",
    "",
    "Backchannel policy: natural 'mm' and 'yep' while they talk. Never talk over them.",
    "Interruption policy: stop the moment they speak.",
    "",
    "Delegation policy: delegate anything about prices, what is collected, areas covered, or taking their details. Only answer by yourself to acknowledge, or to ask them to repeat something you did not catch.",
    "",
    "Never promise a day or a time. Woody confirms every job himself. If they push, say he will ring them back today or tomorrow."
  ].join("\n");
}

export function receptionBackendInstructions() {
  const today = nzNow();
  return [
    "You are the reasoning side of the phone receptionist for Naki Whiteware Removal - whiteware, appliance and scrap metal collection based in New Plymouth, Taranaki, New Zealand.",
    `Today is ${today.spoken} (${today.iso}), New Zealand time. All prices are New Zealand dollars and include GST.`,
    "",
    "WHAT THE BUSINESS DOES",
    "Picks up old whiteware, appliances, gym gear, BBQs, scrap metal and e-waste from homes around Taranaki and takes them away for recycling. The customer pays a small collection fee per item.",
    "Covers New Plymouth and the surrounding towns and routes. Rural pickups more than 10 km off a covered route need Woody to quote, so do not put a price on those.",
    "",
    "PRICES - use the quote_price tool, never do the sums in your head",
    "The first item costs the most and extra items are cheaper. quote_price works it out exactly. Read back the total, not the breakdown.",
    "If they name something not on the list, say Woody will confirm the price and take the booking anyway.",
    "",
    "HOW TO GET THE JOB IN - OFFER THE TEXT FIRST",
    "Once they know the price and want to go ahead, offer to text them the booking link before anything else: \"I can flick you a text with the booking form now if that's easier?\" Most people would rather tap a link than spell an address down the phone, and a form they fill in themselves has no mis-heard street names in it.",
    "If they say yes, call text_booking_link, tell them it has gone through, and wrap the call up. You do not need their address, email or item list for this - do not collect them.",
    "If they say they would rather do it on the phone, or they have not got a mobile, or the text will not send, then take it on the call with take_booking as set out below. Never make them feel awkward about choosing the phone.",
    "Do not offer the text twice. One offer, then get on with whichever way they picked.",
    "",
    "TAKING A BOOKING ON THE CALL - what you must collect before calling take_booking",
    "1. Their name.",
    "2. The pickup address, including the town. Read the street number and street back to them to check it.",
    "3. What they want taken. Match it to the tool's item list as closely as you can.",
    "4. A phone number to ring them back on. If they are calling from the number they want used, offer it back to them to confirm rather than making them say it again.",
    "5. An email address, because that is how the receipt goes out. If they have not got one, that is fine - say Woody will ring instead and leave it out.",
    "Ask for these one at a time. Do not read the whole list at them.",
    "",
    "BEFORE YOU SAVE IT, READ IT BACK",
    "Say the name, the address, the items and the price back to them in one short go, and ask if that is right. Only call take_booking once they have said yes. If anything is wrong, fix it and read it back again.",
    "",
    "WHAT YOU MUST NOT DO",
    "Do not promise a pickup day or a time. Woody sets those and rings them himself - say that plainly.",
    "Do not quote for anything over 10 km rural, or for anything not on the list.",
    "Do not take payment details. The business does not take card over the phone. If they ask, say Woody sorts payment at the pickup.",
    "Do not give out Woody's mobile number or any other customer's details.",
    "If they are angry, complaining about a job already done, or asking about something you have no answer for, say you will get Woody to ring them back, take their name and number, and use take_booking with a note explaining it is a callback rather than a new job.",
    "",
    "NEVER SAY YOU WILL CHECK WITH WOODY AND THEN ANSWER IT YOURSELF",
    "Woody is not on the call and cannot be asked anything during it. Decide before you open your mouth: either you can answer from the price list and what you have been told here, or you cannot.",
    "If you CAN answer, just answer. Do not say \"let me check with Woody\", \"I'll just ask Woody\" or \"bear with me\" first - there is nobody to ask and it makes you sound like you are stalling.",
    "If you CANNOT answer, say Woody will ring them back about it, take the callback, and do not then produce an answer anyway. Saying you will check and then answering in the next breath tells the caller you made it up.",
    "The same goes for holding: you have nothing to look up and nobody to consult, so never put them on hold or say you are looking into it.",
    "",
    "IF THEY JUST WANT A PRICE",
    "Quote it, and offer to book it in. If they say no, leave it - do not push. Say they are welcome to ring back.",
    "",
    "ENDING THE CALL",
    "Once the booking is saved, tell them Woody will ring to arrange the day, and say goodbye. Do not keep the call going."
  ].join("\n");
}

export function receptionTools() {
  return [
    {
      type: "function",
      name: "quote_price",
      description: "Work out the exact collection price for what the caller wants taken. Always use this rather than adding prices up yourself.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "string" },
            description: "What they want taken, matched to the business's item names as closely as you can, for example \"Fridge/freezer\" or \"Top-loading washing machine\". One entry per physical item."
          },
          rural: {
            type: "string",
            enum: ["town", "under5km", "6to10km", "over10km"],
            description: "town = in a main town or on a main road. under5km / 6to10km = rural that far off it. over10km = too far to price, Woody must quote."
          }
        },
        required: ["items", "rural"],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "text_booking_link",
      description: "Text the caller a link to the booking form while they are still on the phone. Offer this FIRST, before taking details out loud - it is quicker for them and nothing gets mis-heard. Only fall back to take_booking if they would rather do it on the call.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Their first name if you have it, so the text reads properly. Leave out if you have not asked yet." },
          to: { type: "string", description: "Only if they want it sent to a different number than the one they are ringing from. Otherwise leave this out." }
        },
        required: [],
        additionalProperties: false
      }
    },
    {
      type: "function",
      name: "take_booking",
      description: "Save the job into Woody's Bookings inbox as a new job for him to confirm. Only call this after reading the details back and hearing the caller agree.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Caller's full name as they said it." },
          phone: { type: "string", description: "Best number to ring them back on." },
          email: { type: "string", description: "Their email, or an empty string if they have not got one." },
          street: { type: "string", description: "Street number and street name." },
          town: { type: "string", description: "Town or suburb." },
          items: { type: "array", items: { type: "string" }, description: "The same item names used for quote_price." },
          rural: { type: "string", enum: ["town", "under5km", "6to10km", "over10km"] },
          notes: { type: "string", description: "Anything Woody needs to know: access, which day suits them, gear location, or that this is a callback rather than a job." }
        },
        required: ["name", "phone", "street", "town", "items", "rural"],
        additionalProperties: false
      }
    }
  ];
}

const RURAL_BY_KEY = {
  town: "Main town or main road - no travel fee",
  under5km: "Rural: up to 5 km from a main town or road - add $5",
  "6to10km": "Outlying route, or rural 6-10 km away - add $10",
  over10km: "More than 10 km from a covered town or route - contact us"
};

/* Same sums the booking forms use: every item's "extra" price, plus one bump
   for the dearest item, plus the travel fee. */
export function quoteFor(items, ruralKey) {
  const known = (Array.isArray(items) ? items : []).filter(item => Object.hasOwn(ITEM_PRICES, item)).slice(0, 10);
  const unknown = (Array.isArray(items) ? items : []).filter(item => !Object.hasOwn(ITEM_PRICES, item)).slice(0, 10);
  const ruralOption = RURAL_BY_KEY[ruralKey] || RURAL_BY_KEY.town;
  let cents = known.reduce((sum, item) => sum + ITEM_PRICES[item][1], 0);
  if (known.length) cents += Math.max(...known.map(item => ITEM_PRICES[item][0] - ITEM_PRICES[item][1]));
  cents += RURAL_PRICES[ruralOption] || 0;
  const quoteRequired = Boolean(unknown.length) || ruralKey === "over10km";
  return { cents, quoteRequired, known, unknown, ruralOption };
}


/* Worth an email when a booking was taken, or when there was a real
   conversation. A wrong number that hung up after two seconds is not news.
   Split out from the call object so the wording can be tested without
   standing up two websockets. */
export function ownerEmailFor({ booking, transcript = [], from = "", reason = "", seconds = 0 }) {
  if (!booking && transcript.length < 2) return null;
  const caller = from || "a withheld number";
  const lines = [];
  if (booking) {
    const price = booking.quoteRequired ? "Needs your quote" : `$${(booking.total / 100).toFixed(2)}`;
    lines.push(
      "The phone assistant took a booking. It is sitting in Bookings as NEW - nothing has been confirmed and nobody has been given a day.",
      "",
      `Name:    ${booking.name}`,
      `Address: ${booking.street}, ${booking.town}`,
      `Phone:   ${booking.phone}`,
      `Price:   ${price}`,
      ""
    );
  } else {
    lines.push(
      `Someone rang and the assistant did not end up taking a booking (${reason}).`,
      "Might be worth ringing them back.",
      ""
    );
  }
  lines.push(`Called from ${caller}, ${seconds} seconds.`, "", "What was said:", ...transcript.slice(-40));
  return {
    subject: booking
      ? `Phone booking - ${booking.name}, ${booking.town}`
      : `Missed enquiry - ${caller}`,
    text: lines.join("\n")
  };
}

export class ReceptionCall {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.twilio = null;
    this.openai = null;
    this.streamSid = "";
    this.from = "";
    this.ready = false;
    this.handled = new Set();
    this.transcript = [];
    this.booking = null;
    this.startedAt = Date.now();
  }

  async fetch(request) {
    const url = new URL(request.url);
    this.from = url.searchParams.get("from") || "";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.twilio = server;
    server.addEventListener("message", event => this.fromTwilio(event.data));
    server.addEventListener("close", () => this.finish("caller hung up"));
    server.addEventListener("error", () => this.finish("the line dropped"));
    this.ctx.waitUntil(this.connectOpenAi());
    // A call that somehow never closes still stops costing money.
    this.timer = setTimeout(() => this.finish("call ran over ten minutes"), CALL_MAX_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async connectOpenAi() {
    try {
      const response = await fetch("https://api.openai.com/v1/live/sessions", {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${this.env.OPENAI_API_KEY}`
        }
      });
      const socket = response.webSocket;
      if (!socket) throw Error(`no websocket back from OpenAI (${response.status})`);
      socket.accept();
      this.openai = socket;
      socket.addEventListener("message", event => this.fromOpenAi(event.data));
      socket.addEventListener("close", () => this.finish("the assistant hung up"));
      socket.addEventListener("error", () => this.finish("the assistant connection failed"));
      this.send({
        type: "session.start",
        session: {
          model: LIVE_MODEL,
          instructions: receptionLiveInstructions(),
          audio: { format: { type: "audio/pcmu", rate: 8000 }, output: { voice: VOICE } },
          delegation: {
            type: "responses",
            responses: {
              model: BACKEND_MODEL,
              instructions: receptionBackendInstructions() + "\n\nTHE PRICE LIST\n" + priceLines(),
              tools: receptionTools(),
              tool_choice: "auto"
            }
          }
        }
      });
    } catch (error) {
      console.error("Phone reception could not reach OpenAI", String(error));
      this.finish("could not reach the assistant");
    }
  }

  send(event) {
    try {
      if (this.openai && this.openai.readyState === WebSocket.OPEN) {
        this.openai.send(JSON.stringify(event));
        return true;
      }
    } catch (error) { /* the close handler tidies up */ }
    return false;
  }

  fromTwilio(raw) {
    let data;
    try { data = JSON.parse(raw); } catch (error) { return; }
    if (data.event === "start") {
      this.streamSid = data.start && data.start.streamSid || "";
      return;
    }
    if (data.event === "media" && this.ready) {
      this.send({ type: "session.input_audio.append", audio: data.media.payload });
      return;
    }
    if (data.event === "stop") this.finish("caller hung up");
  }

  async fromOpenAi(raw) {
    let event;
    try { event = JSON.parse(raw); } catch (error) { return; }

    if (event.type === "session.started") { this.ready = true; return; }

    if (event.type === "session.output_audio.delta" && this.streamSid) {
      try {
        this.twilio.send(JSON.stringify({ event: "media", streamSid: this.streamSid, media: { payload: event.delta } }));
      } catch (error) { /* the close handler tidies up */ }
      return;
    }

    // Kept so Woody can see what was actually agreed, not for training anything.
    if (event.type === "turn.done" && event.turn && event.turn.transcript) {
      this.transcript.push(`${event.turn.role === "user" ? "Caller" : "Reception"}: ${event.turn.transcript}`);
      if (this.transcript.length > 80) this.transcript.shift();
      return;
    }

    if (event.type === "response.event"
      && event.event && event.event.type === "response.output_item.done"
      && event.event.item && event.event.item.type === "function_call"
      && event.event.item.status === "completed") {
      const item = event.event.item;
      if (this.handled.has(item.call_id)) return;
      this.handled.add(item.call_id);
      let args = {};
      try { args = item.arguments ? JSON.parse(item.arguments) : {}; } catch (error) { args = {}; }
      const output = await this.runTool(item.name, args && typeof args === "object" ? args : {});
      this.send({ type: "response.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output) } });
      this.send({ type: "response.create" });
    }
  }

  async runTool(name, args) {
    try {
      if (name === "quote_price") {
        const quote = quoteFor(args.items, args.rural);
        if (quote.quoteRequired) {
          return {
            quote_required: true,
            reason: quote.unknown.length
              ? `Not on the price list: ${quote.unknown.join(", ")}.`
              : "Over 10 km rural.",
            say: "Tell them Woody will confirm the price, and take the booking anyway."
          };
        }
        return {
          total: `$${(quote.cents / 100).toFixed(2)}`,
          items_counted: quote.known.length,
          travel: quote.ruralOption
        };
      }
      if (name === "text_booking_link") return await this.textBookingLink(args);
      if (name === "take_booking") return await this.saveBooking(args);
      return { error: `There is no tool called ${name}.` };
    } catch (error) {
      console.error("Phone reception tool failed", name, String(error));
      return { error: "That did not save. Tell them you will get Woody to ring them back, then say goodbye." };
    }
  }

  /* Texts the caller the booking link while they are still on the phone.
     Most people would rather tap a link than spell an address out loud, and a
     booking they fill in themselves has no mis-heard street names in it.

     Needs a Twilio account: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and
     TWILIO_FROM_NUMBER. Without them the call still works - the tool just says
     it could not send, and the assistant falls back to taking the booking. */
  async textBookingLink(args) {
    const env = this.env;
    const to = String(args?.to || this.from || "").replace(/[^\d+]/g, "");
    if (!to) {
      return { sent: false, reason: "no_number", say: "Their number is withheld, so a text cannot be sent. Offer to take the booking on the phone instead." };
    }
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
      return { sent: false, reason: "not_configured", say: "Texting is not switched on yet. Do not tell them a text is coming - offer to take the booking on the phone instead." };
    }

    const name = String(args?.name || "").trim().slice(0, 40);
    // The booking form is the #book section on the front page. There is no
    // /book path - sending one would text every caller a 404.
    const link = env.BOOKING_LINK || "https://nakiwhitewareremoval.vip/#book";
    const body = `${name ? `Hi ${name}, ` : "Hi, "}here's the booking form for your pickup: ${link} - Naki Whiteware Removal`;

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body }),
          signal: AbortSignal.timeout(10000)
        }
      );
      if (!res.ok) {
        console.error("Booking link text rejected", res.status, (await res.text()).slice(0, 300));
        return { sent: false, reason: "send_failed", say: "The text would not go through. Offer to take the booking on the phone instead." };
      }
      this.texted = true;
      return { sent: true, to, say: "Tell them it has just gone to their phone, and that Woody will ring once it is in." };
    } catch (error) {
      console.error("Booking link text failed", String(error));
      return { sent: false, reason: "send_failed", say: "The text would not go through. Offer to take the booking on the phone instead." };
    }
  }

  async saveBooking(args) {
    const clean = (value, max) => String(value == null ? "" : value).trim().slice(0, max);
    const name = clean(args.name, 120);
    const street = clean(args.street, 180);
    const town = clean(args.town, 100);
    const phone = clean(args.phone, 30) || this.from;
    if (!name || !street || !town || !phone) {
      return { error: "Still missing a name, address, town or phone number. Ask for the missing one." };
    }
    const parts = name.split(/\s+/);
    const firstName = parts.shift() || name;
    const lastName = parts.join(" ");
    const emailRaw = clean(args.email, 160).toLowerCase();
    const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailRaw) ? emailRaw : "";
    const quote = quoteFor(args.items, args.rural);
    const id = `WEB-PHONE-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const at = Date.now();
    const said = [
      `Taken by the phone receptionist on ${nzNow().spoken}.`,
      `Caller rang from ${this.from || "a withheld number"}.`,
      email ? "" : "No email address given - ring them.",
      clean(args.notes, 600),
      quote.unknown.length ? `Not on the price list, needs your quote: ${quote.unknown.join(", ")}.` : "",
      "",
      "What was said:",
      ...this.transcript.slice(-30)
    ].filter(Boolean).join("\n").slice(0, 1500);

    await this.env.CUSTOMER_DB.prepare(
      `INSERT INTO bookings (
         id, customer_id, status, first_name, last_name, phone, email, street_address, town, area,
         rural_option, items_json, additional_info, referral_source, referral_details,
         total_cents, quote_required, created_at, updated_at
       ) VALUES (?1, NULL, 'NEW', ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, 'Phone', 'Phone receptionist', ?11, ?12, ?13, ?13)`
    ).bind(
      id, firstName, lastName, phone, email, street, town,
      quote.ruralOption, JSON.stringify(quote.known.concat(quote.unknown).slice(0, 10)), said,
      quote.cents, quote.quoteRequired ? 1 : 0, at
    ).run();

    this.booking = { id, name, street, town, phone, total: quote.cents, quoteRequired: quote.quoteRequired };
    return {
      ok: true,
      saved: true,
      say: "Tell them it is booked in and Woody will ring to arrange the day, then say goodbye."
    };
  }

  finish(reason) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    const seconds = Math.round((Date.now() - this.startedAt) / 1000);
    console.log("Phone reception call ended", reason, `${seconds}s`, this.booking ? this.booking.id : "no booking");
    try { this.openai && this.openai.close(); } catch (error) { /* already gone */ }
    try { this.twilio && this.twilio.close(); } catch (error) { /* already gone */ }
    // A booking sitting in the inbox he hasn't opened is no use to him. The
    // socket is already closing, so this has to outlive the request.
    this.ctx.waitUntil(this.tellWoody(reason, seconds).catch(error => {
      console.error("Phone reception could not email the owner", String(error));
    }));
  }

  async tellWoody(reason, seconds) {
    const mail = ownerEmailFor({
      booking: this.booking, transcript: this.transcript, from: this.from, reason, seconds
    });
    if (!mail) return;
    await sendMail(this.env, { to: OWNER_EMAIL, name: "Woody", ...mail });
  }
}
