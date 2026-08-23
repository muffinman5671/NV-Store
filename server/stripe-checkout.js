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

const DATA_DIR = path.join(__dirname, 'data');
const CATALOGUE = path.join(DATA_DIR, 'catalogue.json');
const ORDERS = path.join(DATA_DIR, 'orders.json');

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
  list.data.forEach(function (session) {
    if (session.payment_status === 'unpaid') return;
    if (recordOrder(session)) {
      added.push({
        id: session.id,
        amount: session.amount_total,
        codes: (session.metadata && session.metadata.codes) || ''
      });
    }
  });
  return { scanned: list.data.length, added: added };
}

/* ----------------------------------------------------------- fulfilment */

function recordOrder(session) {
  const store = readJSON(ORDERS, { orders: [] });
  if (store.orders.some(function (o) { return o.sessionId === session.id; })) {
    return false;                        // already fulfilled; events can repeat
  }
  store.orders.push({
    sessionId: session.id,
    mode: session.mode,
    amountTotal: session.amount_total,
    currency: session.currency,
    paymentStatus: session.payment_status,
    email: (session.customer_details && session.customer_details.email) || null,
    codes: (session.metadata && session.metadata.codes) || '',
    created: new Date().toISOString()
  });
  writeJSON(ORDERS, store);
  return true;
}

/**
 * Handle a verified Stripe event. Fulfilment lives here rather than on the
 * success page: customers are not guaranteed to arrive there, and an order
 * that only completes on redirect is an order silently dropped.
 */
function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      // Delayed-notification methods complete the session while still unpaid.
      if (session.payment_status === 'unpaid') {
        console.log('  [stripe] ' + session.id + ' completed but unpaid — waiting');
        return { fulfilled: false, reason: 'unpaid' };
      }
      const fresh = recordOrder(session);
      console.log('  [stripe] ' + (fresh ? 'fulfilled ' : 'already fulfilled ') + session.id);
      return { fulfilled: fresh };
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
  RECURRING_CODES   // exported so the mix rule can be tested and edited
};
