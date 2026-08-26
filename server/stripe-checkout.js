'use strict';
/**
 * Stripe Checkout for the NV store.
 *
 * The rule that matters here: the browser sends catalogue codes and
 * quantities, never prices. Every amount charged is looked up server-side
 * from catalogue.json. A cart is a request, not an instruction.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Stripe = require('stripe');

// Kept in step with server.js: NV_DATA_DIR moves runtime data onto a mounted
// volume, so a deploy on an ephemeral filesystem does not erase the orders.
const DATA_DIR = process.env.NV_DATA_DIR || path.join(__dirname, 'data');
const CATALOGUE = path.join(DATA_DIR, 'catalogue.json');
// Overridable so the tests can run against a scratch file. Nothing else sets
// it — real orders always live in server/data/orders.json.
const ORDERS = process.env.NV_ORDERS_FILE || path.join(DATA_DIR, 'orders.json');

const CURRENCY = 'usd';
const MAX_QTY = 20;
const MAX_LINES = 20;

// Items billed on a recurring basis. A Checkout Session is either
// mode:'payment' or mode:'subscription' — never both — so a cart mixing
// these with one-off items cannot be a single session.
const RECURRING_CODES = ["NV / S-04"];

// A stable label for this checkout flow, so sessions can be compared in the
// Dashboard. It identifies the integration, not the request - it must not
// vary per call, or idempotent retries will conflict.
const INTEGRATION_ID = "nvstore-qhwzmxkd";

let stripe = null;

function client() {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || /replace_me/.test(key)) {
    const err = new Error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and fill it in.');
    err.statusCode = 503;
    throw err;
  }
  if (/^[sr]k_live_/.test(key)) {
    console.warn('\n  WARNING: a LIVE Stripe key is loaded. Real money will move.\n');
  }
  // Instance client, not the deprecated global api_key pattern.
  stripe = new Stripe(key, { apiVersion: '2026-07-29.dahlia' });
  return stripe;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { return fallback; }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function isRecurring(item) {
  return RECURRING_CODES.indexOf(item.code) >= 0;
}

// Books ship a physical print edition; services do not.
function needsShipping(items) {
  return items.some(function (i) { return i.kind === 'book'; });
}

/**
 * Turn a client cart of {code, qty} into Stripe line items, pricing every
 * line from the catalogue. Returns { error } for anything it will not sell.
 */
function buildLineItems(cart) {
  if (!Array.isArray(cart) || !cart.length) return { error: 'Your cart is empty.' };
  if (cart.length > MAX_LINES) return { error: 'Too many different items in one order.' };

  const catalogue = readJSON(CATALOGUE, { items: [] });
  const byCode = new Map(catalogue.items.map(function (i) { return [i.code, i]; }));

  const lines = [];
  const resolved = [];
  const seen = new Set();

  for (const entry of cart) {
    if (!entry || typeof entry.code !== 'string') return { error: 'Malformed cart.' };
    if (seen.has(entry.code)) return { error: 'Duplicate item in cart.' };
    seen.add(entry.code);

    const item = byCode.get(entry.code);
    if (!item) return { error: 'That item is no longer available.' };

    const qty = Math.floor(Number(entry.qty));
    if (!isFinite(qty) || qty < 1 || qty > MAX_QTY) {
      return { error: 'Quantity must be between 1 and ' + MAX_QTY + '.' };
    }

    // Price comes from the catalogue. Anything the client sent is ignored.
    const unitAmount = Math.round(Number(item.price) * 100);
    if (!isFinite(unitAmount) || unitAmount <= 0) {
      return { error: 'That item is not currently priced for sale.' };
    }

    const line = {
      quantity: qty,
      price_data: {
        currency: CURRENCY,
        unit_amount: unitAmount,
        product_data: {
          name: item.title,
          description: item.sub,
          metadata: { code: item.code, kind: item.kind }
        }
      }
    };
    if (isRecurring(item)) line.price_data.recurring = { interval: 'month' };

    lines.push(line);
    resolved.push(item);
  }

  const recurring = resolved.filter(isRecurring);
  if (recurring.length && recurring.length !== resolved.length) {
    return {
      error: 'The ' + recurring[0].title + ' is billed monthly and has to be ' +
             'purchased on its own. Please check it out separately from the rest of your cart.'
    };
  }
  if (recurring.length > 1) {
    return { error: 'Only one subscription can be purchased at a time.' };
  }

  return { lines, items: resolved, mode: recurring.length ? 'subscription' : 'payment' };
}

async function createSession(cart, origin) {
  const built = buildLineItems(cart);
  if (built.error) { const e = new Error(built.error); e.statusCode = 400; throw e; }

  const base = (process.env.PUBLIC_URL || origin || 'http://localhost:8080').replace(/\/+$/, '');

  const params = {
    mode: built.mode,
    line_items: built.lines,
    success_url: base + '/?checkout=success&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: base + '/?checkout=cancelled',
    // No payment_method_types: omitting it enables dynamic payment methods,
    // so Stripe shows whatever converts best for each customer.
    billing_address_collection: 'auto',
    metadata: {
      codes: built.items.map(function (i) { return i.code; }).join(','),
      source: 'nv-store'
    },
    integration_identifier: INTEGRATION_ID
  };

  if (needsShipping(built.items)) {
    params.shipping_address_collection = { allowed_countries: ['US', 'CA', 'GB', 'IE', 'AU', 'NZ'] };
  }

  // Tax is deliberately NOT enabled. automatic_tax without an active
  // registration in the customer's jurisdiction collects nothing while
  // appearing to work. Turn it on only after registering — see server/README.

  // A receipt the customer can keep. Stripe finalises an invoice for the
  // session and hosts both an HTML page and a PDF; both URLs are captured at
  // fulfilment and linked from our own receipt page. Subscriptions already
  // raise their own invoices, and Checkout rejects the flag in that mode.
  if (built.mode === 'payment') {
    params.invoice_creation = { enabled: true };
  }

  // Idempotency absorbs a double-clicked button. The key is bucketed to ten
  // minutes so an identical cart later gets a fresh session rather than
  // resurrecting an expired one.
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const fingerprint = crypto.createHash("sha256")
    .update(JSON.stringify(cart) + built.mode + base + bucket)
    .digest("hex").slice(0, 32);

  return client().checkout.sessions.create(params, { idempotencyKey: 'nv-' + fingerprint });
}

/* -------------------------------------------------------- reconciliation */

/**
 * Pulls recent Checkout Sessions from Stripe and records any that are paid
 * but missing locally. Webhooks stay the primary path — this is the safety
 * net for events that never arrived: a webhook outage, or development on
 * localhost, where Stripe cannot reach the machine at all.
 */
async function syncOrders(limit) {
  const list = await client().checkout.sessions.list({
    limit: Math.min(Math.max(Number(limit) || 20, 1), 100)
  });
  const added = [];
  // Sequential, not Promise.all: each pass may retrieve the session to expand
  // its lines, and orders.json is read-modify-written per record. Overlapping
  // writes would lose orders and hand out duplicate receipt numbers.
  for (const session of list.data) {
    if (session.payment_status === 'unpaid') continue;
    const record = await fulfil(session);
    if (record) {
      added.push({
        id: record.sessionId,
        receiptNo: record.receiptNo,
        amount: record.amountTotal,
        codes: record.codes
      });
    }
  }
  return { scanned: list.data.length, added: added };
}

/* -------------------------------------------------------------- receipts */

// Everything the receipt needs that the session object does not carry by
// default. Four levels is the expansion limit, so this is as deep as it goes.
const RECEIPT_EXPAND = [
  'line_items.data.price.product',
  'payment_intent.latest_charge',
  'invoice'
];

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{1,250}$/;

function fetchSession(id) {
  if (!SESSION_ID.test(String(id || ''))) {
    const err = new Error('That is not a valid order reference.');
    err.statusCode = 400;
    throw err;
  }
  return client().checkout.sessions.retrieve(id, { expand: RECEIPT_EXPAND });
}

/**
 * Human-facing receipt numbers, sequential within the calendar year:
 * NV-2026-0001. Derived from the orders already on file rather than a stored
 * counter, so there is one source of truth and nothing to fall out of step.
 */
function receiptNumber(store, when) {
  const tag = 'NV-' + when.getUTCFullYear() + '-';
  let max = 0;
  store.orders.forEach(function (o) {
    if (typeof o.receiptNo !== 'string' || o.receiptNo.indexOf(tag) !== 0) return;
    const n = parseInt(o.receiptNo.slice(tag.length), 10);
    if (isFinite(n) && n > max) max = n;
  });
  return tag + String(max + 1).padStart(4, '0');
}

/**
 * Line detail as it was at the moment of sale. Stored rather than looked up,
 * because the catalogue is editable: re-pricing an item must never rewrite
 * what a past customer was charged.
 */
function linesFrom(session) {
  const data = session.line_items && session.line_items.data;
  if (!Array.isArray(data) || !data.length) return null;
  return data.map(function (li) {
    const price = li.price || {};
    const product = (price.product && typeof price.product === 'object') ? price.product : {};
    const meta = product.metadata || {};
    return {
      description: li.description || product.name || 'Item',
      code: meta.code || null,
      kind: meta.kind || null,
      quantity: li.quantity == null ? 1 : li.quantity,
      unitAmount: price.unit_amount == null ? null : price.unit_amount,
      amountTotal: li.amount_total == null ? null : li.amount_total,
      recurring: Boolean(price.recurring)
    };
  });
}

// Stripe moved shipping onto collected_information; older versions keep it at
// the top level. Read both so an API version bump cannot silently drop the
// address a book has to be posted to.
function shippingFrom(session) {
  const s = (session.collected_information && session.collected_information.shipping_details) ||
            session.shipping_details || null;
  if (!s) return null;
  const a = s.address || {};
  return {
    name: s.name || null,
    line1: a.line1 || null,
    line2: a.line2 || null,
    city: a.city || null,
    state: a.state || null,
    postalCode: a.postal_code || null,
    country: a.country || null
  };
}

// Stripe's own hosted copies, kept alongside ours so support can point at
// either. Absent until the payment intent and invoice have been expanded.
function receiptUrls(session) {
  const out = { stripeReceiptUrl: null, invoiceUrl: null, invoicePdf: null };
  const pi = session.payment_intent;
  if (pi && typeof pi === 'object') {
    const charge = pi.latest_charge;
    if (charge && typeof charge === 'object' && charge.receipt_url) {
      out.stripeReceiptUrl = charge.receipt_url;
    }
  }
  const inv = session.invoice;
  if (inv && typeof inv === 'object') {
    out.invoiceUrl = inv.hosted_invoice_url || null;
    out.invoicePdf = inv.invoice_pdf || null;
  }
  return out;
}

/**
 * Ask Stripe to email its own receipt. Checkout does not set receipt_email
 * for us; setting it on a succeeded PaymentIntent sends one to that address.
 * Best effort only — a receipt that fails to send must never fail an order,
 * and the customer can always read theirs on the site.
 */
async function sendStripeReceipt(session) {
  if (session.mode !== 'payment') return false;   // subscriptions invoice themselves
  const email = session.customer_details && session.customer_details.email;
  if (!email) return false;
  const pi = session.payment_intent;
  const id = typeof pi === 'string' ? pi : (pi && pi.id);
  if (!id) return false;
  if (pi && typeof pi === 'object' && pi.receipt_email === email) return false;
  await client().paymentIntents.update(id, { receipt_email: email });
  return true;
}

/* ----------------------------------------------------------- fulfilment */

function findOrder(store, sessionId) {
  return store.orders.find(function (o) { return o.sessionId === sessionId; }) || null;
}

/**
 * Write the order down. Returns the new record, or null if this session was
 * already fulfilled — events repeat, and the success page checks in behind
 * the webhook, so this is the single place that decides what is new.
 */
function recordOrder(session) {
  const store = readJSON(ORDERS, { orders: [] });
  const now = new Date();
  const lines = linesFrom(session);
  const urls = receiptUrls(session);
  const existing = findOrder(store, session.id);

  if (existing) {
    // Not a fresh order, but detail an earlier thin record missed is worth
    // filling in — that is what gives orders written before receipts existed
    // a receipt number and line prices.
    let changed = false;
    if (lines && !existing.lines) { existing.lines = lines; changed = true; }
    if (!existing.receiptNo) { existing.receiptNo = receiptNumber(store, now); changed = true; }
    if (!existing.shipping) {
      const ship = shippingFrom(session);
      if (ship) { existing.shipping = ship; changed = true; }
    }
    if (existing.amountSubtotal == null && session.amount_subtotal != null) {
      existing.amountSubtotal = session.amount_subtotal;
      changed = true;
    }
    if (!existing.name && session.customer_details && session.customer_details.name) {
      existing.name = session.customer_details.name;
      changed = true;
    }
    ['stripeReceiptUrl', 'invoiceUrl', 'invoicePdf'].forEach(function (k) {
      if (!existing[k] && urls[k]) { existing[k] = urls[k]; changed = true; }
    });
    if (changed) writeJSON(ORDERS, store);
    return null;
  }

  const record = {
    sessionId: session.id,
    receiptNo: receiptNumber(store, now),
    mode: session.mode,
    amountSubtotal: session.amount_subtotal == null ? null : session.amount_subtotal,
    amountTotal: session.amount_total,
    currency: session.currency,
    paymentStatus: session.payment_status,
    email: (session.customer_details && session.customer_details.email) || null,
    name: (session.customer_details && session.customer_details.name) || null,
    codes: (session.metadata && session.metadata.codes) || '',
    lines: lines,
    shipping: shippingFrom(session),
    stripeReceiptUrl: urls.stripeReceiptUrl,
    invoiceUrl: urls.invoiceUrl,
    invoicePdf: urls.invoicePdf,
    created: new Date().toISOString()
  };
  store.orders.push(record);
  writeJSON(ORDERS, store);
  return record;
}

/**
 * Record a paid session with its full line detail, expanding it from Stripe
 * first if the caller only has the slim copy a webhook carries. Returns the
 * new record, or null if it was already on file.
 */
async function fulfil(session) {
  const known = findOrder(readJSON(ORDERS, { orders: [] }), session.id);
  if (known && known.lines) return null;      // nothing to add, so no round trip

  let full = session;
  if (!session.line_items) {
    // Webhook payloads never include line_items, so the receipt detail has to
    // be fetched. If that call fails the order is still recorded from what we
    // have: a receipt missing its lines beats an order lost.
    try {
      full = await fetchSession(session.id);
    } catch (err) {
      console.error('  [stripe] could not expand ' + session.id + ': ' + err.message);
    }
  }

  const record = recordOrder(full);
  if (record) {
    try { await sendStripeReceipt(full); }
    catch (err) { console.error('  [stripe] receipt email failed: ' + err.message); }
  }
  return record;
}

/**
 * The receipt for one order. Reads locally first; if the order is not on file
 * the session is retrieved from Stripe, which is what makes receipts work on
 * localhost, where no webhook can ever arrive. The id in the URL only selects
 * which session to ask about — Stripe's answer decides whether it was paid.
 */
async function receiptFor(sessionId) {
  const local = findOrder(readJSON(ORDERS, { orders: [] }), sessionId);
  if (local && local.lines) return local;

  const session = await fetchSession(sessionId);
  if (session.payment_status === 'unpaid') {
    const err = new Error('That order has not been paid.');
    err.statusCode = 409;
    throw err;
  }

  const fresh = await fulfil(session);
  if (fresh) return fresh;
  return findOrder(readJSON(ORDERS, { orders: [] }), sessionId);
}

/**
 * Handle a verified Stripe event. Fulfilment lives here rather than on the
 * success page: customers are not guaranteed to arrive there, and an order
 * that only completes on redirect is an order silently dropped.
 */
async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      // Delayed-notification methods complete the session while still unpaid.
      if (session.payment_status === 'unpaid') {
        console.log('  [stripe] ' + session.id + ' completed but unpaid — waiting');
        return { fulfilled: false, reason: 'unpaid' };
      }
      const record = await fulfil(session);
      console.log('  [stripe] ' + (record ? 'fulfilled ' + record.receiptNo + ' for ' : 'already fulfilled ') + session.id);
      return { fulfilled: Boolean(record), receiptNo: record ? record.receiptNo : null };
    }
    case 'checkout.session.async_payment_failed':
      console.log('  [stripe] payment failed for ' + event.data.object.id);
      return { fulfilled: false, reason: 'failed' };
    default:
      return { fulfilled: false, reason: 'ignored' };
  }
}

function verifyEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || /replace_me/.test(secret)) {
    const err = new Error('STRIPE_WEBHOOK_SECRET is not set.');
    err.statusCode = 503;
    throw err;
  }
  // Throws if the signature does not match — never process an unverified event.
  return client().webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
  createSession, buildLineItems, handleEvent, verifyEvent, readJSON, ORDERS, syncOrders,
  receiptFor, recordOrder, fulfil, fetchSession, receiptNumber, linesFrom, shippingFrom,
  RECURRING_CODES   // exported so the mix rule can be tested and edited
};
