'use strict';
/**
 * Receipt tests.
 *
 *   node server/test-receipts.js
 *
 * No network and no Stripe key: every session here is a literal shaped like
 * the ones Stripe sends, and each case that would otherwise reach the API is
 * given enough detail that it does not have to. Orders are written to a
 * scratch file via NV_ORDERS_FILE, so server/data/orders.json is never touched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-receipts-'));
process.env.NV_ORDERS_FILE = path.join(SCRATCH, 'orders.json');

const checkout = require('./stripe-checkout');

/* ------------------------------------------------------------ harness */

let passed = 0;
const failures = [];

function reset() {
  fs.writeFileSync(process.env.NV_ORDERS_FILE, JSON.stringify({ orders: [] }));
}

function orders() {
  return JSON.parse(fs.readFileSync(process.env.NV_ORDERS_FILE, 'utf8')).orders;
}

async function test(name, fn) {
  reset();
  try {
    await fn();
    passed += 1;
    console.log('  ok    ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('  FAIL  ' + name + '\n          ' + err.message);
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || 'value') + ': expected ' + b + ', got ' + a);
}

function ok(value, what) {
  if (!value) throw new Error(what || 'expected a truthy value');
}

/* ------------------------------------------------------------ fixtures */

// Shaped like an expanded Checkout Session: line_items present, so nothing
// here needs to call Stripe to fill in the detail.
function session(over) {
  return Object.assign({
    id: 'cs_test_' + Math.random().toString(36).slice(2, 12).padEnd(10, 'x'),
    mode: 'payment',
    payment_status: 'paid',
    currency: 'usd',
    amount_subtotal: 6800,
    amount_total: 6800,
    customer_details: { email: 'buyer@example.com', name: 'A Buyer' },
    metadata: { codes: 'NV / 013' },
    line_items: {
      data: [{
        description: 'Example 2',
        quantity: 2,
        amount_total: 6800,
        price: {
          unit_amount: 3400,
          recurring: null,
          product: { name: 'Example 2', metadata: { code: 'NV / 013', kind: 'book' } }
        }
      }]
    }
  }, over || {});
}

function event(type, obj) {
  return { type: type, data: { object: obj } };
}

/* --------------------------------------------------------------- cases */

async function run() {
  console.log('\n  receipts\n');

  /* ---- receipt numbering ---- */

  await test('the first receipt of the year is 0001', function () {
    const no = checkout.receiptNumber({ orders: [] }, new Date('2026-03-04T00:00:00Z'));
    eq(no, 'NV-2026-0001');
  });

  await test('receipt numbers increment and stay zero-padded', function () {
    const store = { orders: [{ receiptNo: 'NV-2026-0009' }] };
    eq(checkout.receiptNumber(store, new Date('2026-03-04T00:00:00Z')), 'NV-2026-0010');
  });

  await test('numbering restarts each calendar year', function () {
    const store = { orders: [{ receiptNo: 'NV-2025-0042' }] };
    eq(checkout.receiptNumber(store, new Date('2026-01-01T00:00:00Z')), 'NV-2026-0001');
  });

  await test('malformed receipt numbers do not break numbering', function () {
    const store = { orders: [{ receiptNo: 'NV-2026-oops' }, { receiptNo: null }, {}] };
    eq(checkout.receiptNumber(store, new Date('2026-06-01T00:00:00Z')), 'NV-2026-0001');
  });

  await test('receipt numbers are unique across a run of orders', async function () {
    const seen = new Set();
    for (let i = 0; i < 5; i += 1) {
      const rec = await checkout.fulfil(session());
      ok(rec, 'order ' + i + ' should be new');
      ok(!seen.has(rec.receiptNo), 'duplicate receipt number ' + rec.receiptNo);
      seen.add(rec.receiptNo);
    }
    eq(seen.size, 5, 'unique receipt numbers');
  });

  /* ---- line detail ---- */

  await test('line detail is read off an expanded session', function () {
    const lines = checkout.linesFrom(session());
    eq(lines.length, 1, 'line count');
    eq(lines[0].description, 'Example 2', 'description');
    eq(lines[0].code, 'NV / 013', 'code');
    eq(lines[0].kind, 'book', 'kind');
    eq(lines[0].quantity, 2, 'quantity');
    eq(lines[0].unitAmount, 3400, 'unit amount');
    eq(lines[0].amountTotal, 6800, 'line total');
    eq(lines[0].recurring, false, 'recurring');
  });

  await test('an unexpanded session yields no lines rather than junk', function () {
    eq(checkout.linesFrom({ id: 'cs_test_x' }), null);
    eq(checkout.linesFrom({ line_items: { data: [] } }), null);
  });

  await test('a recurring price is marked on the line', function () {
    const s = session();
    s.line_items.data[0].price.recurring = { interval: 'month' };
    eq(checkout.linesFrom(s)[0].recurring, true);
  });

  await test('a product Stripe left unexpanded still gives a usable line', function () {
    const s = session();
    s.line_items.data[0].price.product = 'prod_abc123';   // an id, not an object
    const line = checkout.linesFrom(s)[0];
    eq(line.description, 'Example 2', 'description falls back to the line description');
    eq(line.code, null, 'code is absent rather than wrong');
  });

  /* ---- shipping ---- */

  await test('shipping is read from collected_information', function () {
    const s = session({
      collected_information: {
        shipping_details: {
          name: 'A Buyer',
          address: { line1: '1 W Monroe St', line2: null, city: 'Chicago',
                     state: 'IL', postal_code: '60603', country: 'US' }
        }
      }
    });
    const ship = checkout.shippingFrom(s);
    eq(ship.city, 'Chicago', 'city');
    eq(ship.postalCode, '60603', 'postal code');
    eq(ship.country, 'US', 'country');
  });

  await test('shipping falls back to the older top-level field', function () {
    const s = session({
      shipping_details: { name: 'A Buyer', address: { line1: '1 W Monroe St', city: 'Chicago' } }
    });
    eq(checkout.shippingFrom(s).line1, '1 W Monroe St');
  });

  await test('no shipping collected means no address on the receipt', function () {
    eq(checkout.shippingFrom(session()), null);
  });

  /* ---- recording ---- */

  await test('a paid session is recorded with a full receipt', function () {
    const rec = checkout.recordOrder(session({ id: 'cs_test_full0000001' }));
    ok(rec, 'a record should come back');
    eq(rec.receiptNo, 'NV-' + new Date().getUTCFullYear() + '-0001', 'receipt number');
    eq(rec.amountTotal, 6800, 'total');
    eq(rec.email, 'buyer@example.com', 'email');
    eq(rec.name, 'A Buyer', 'name');
    eq(rec.lines.length, 1, 'lines stored');
    eq(orders().length, 1, 'orders on file');
  });

  await test('hosted receipt and invoice URLs are captured', function () {
    const rec = checkout.recordOrder(session({
      payment_intent: { id: 'pi_1', latest_charge: { receipt_url: 'https://pay.stripe.com/receipts/x' } },
      invoice: { hosted_invoice_url: 'https://invoice.stripe.com/i/y', invoice_pdf: 'https://invoice.stripe.com/i/y.pdf' }
    }));
    eq(rec.stripeReceiptUrl, 'https://pay.stripe.com/receipts/x', 'charge receipt');
    eq(rec.invoiceUrl, 'https://invoice.stripe.com/i/y', 'hosted invoice');
    eq(rec.invoicePdf, 'https://invoice.stripe.com/i/y.pdf', 'invoice PDF');
  });

  await test('the same session is never recorded twice', function () {
    const s = session({ id: 'cs_test_repeat000001' });
    ok(checkout.recordOrder(s), 'first write is new');
    eq(checkout.recordOrder(s), null, 'second write is not new');
    eq(orders().length, 1, 'orders on file');
  });

  await test('a replay does not renumber the receipt', function () {
    const s = session({ id: 'cs_test_renum0000001' });
    const first = checkout.recordOrder(s).receiptNo;
    checkout.recordOrder(s);
    eq(orders()[0].receiptNo, first, 'receipt number is stable');
  });

  await test('an order written before receipts existed is backfilled', function () {
    // Exactly the shape orders.json held before this change: no receipt
    // number, no lines. Re-seeing the session should complete it in place,
    // without counting as a new sale.
    fs.writeFileSync(process.env.NV_ORDERS_FILE, JSON.stringify({
      orders: [{
        sessionId: 'cs_test_legacy000001',
        mode: 'payment', amountTotal: 6800, currency: 'usd',
        paymentStatus: 'paid', email: 'buyer@example.com',
        codes: 'NV / 013', created: '2026-08-23T18:06:17.504Z'
      }]
    }));

    const fresh = checkout.recordOrder(session({ id: 'cs_test_legacy000001' }));
    eq(fresh, null, 'backfilling is not a new order');
    eq(orders().length, 1, 'no duplicate row');
    const o = orders()[0];
    eq(o.receiptNo, 'NV-' + new Date().getUTCFullYear() + '-0001', 'gains a receipt number');
    eq(o.lines.length, 1, 'gains line detail');
    eq(o.created, '2026-08-23T18:06:17.504Z', 'original date is preserved');
  });

  await test('line prices are frozen at the time of sale', function () {
    const rec = checkout.recordOrder(session({ id: 'cs_test_frozen000001' }));
    // The catalogue is editable; the receipt is not. What was charged has to
    // survive a later price change, which is why lines are stored, not joined.
    eq(rec.lines[0].unitAmount, 3400, 'unit amount as charged');
    eq(rec.lines[0].amountTotal, 6800, 'line total as charged');
  });

  /* ---- events ---- */

  await test('a completed paid session is fulfilled and numbered', async function () {
    const result = await checkout.handleEvent(
      event('checkout.session.completed', session({ id: 'cs_test_evt00000001' }))
    );
    eq(result.fulfilled, true, 'fulfilled');
    ok(result.receiptNo, 'a receipt number comes back');
    eq(orders().length, 1, 'one order on file');
  });

  await test('a completed but unpaid session is not fulfilled', async function () {
    const result = await checkout.handleEvent(
      event('checkout.session.completed', session({ payment_status: 'unpaid' }))
    );
    eq(result.fulfilled, false, 'not fulfilled');
    eq(result.reason, 'unpaid', 'reason');
    eq(orders().length, 0, 'nothing written');
  });

  await test('a delayed payment succeeding later is fulfilled', async function () {
    const result = await checkout.handleEvent(
      event('checkout.session.async_payment_succeeded', session({ id: 'cs_test_async0000001' }))
    );
    eq(result.fulfilled, true, 'fulfilled');
    eq(orders().length, 1, 'one order on file');
  });

  await test('a repeated event does not fulfil twice', async function () {
    const e = event('checkout.session.completed', session({ id: 'cs_test_twice0000001' }));
    const first = await checkout.handleEvent(e);
    const second = await checkout.handleEvent(e);
    eq(first.fulfilled, true, 'first is new');
    eq(second.fulfilled, false, 'second is not');
    eq(orders().length, 1, 'still one order');
  });

  await test('a failed async payment records nothing', async function () {
    const result = await checkout.handleEvent(
      event('checkout.session.async_payment_failed', session())
    );
    eq(result.fulfilled, false, 'not fulfilled');
    eq(result.reason, 'failed', 'reason');
    eq(orders().length, 0, 'nothing written');
  });

  await test('unrelated events are ignored', async function () {
    const result = await checkout.handleEvent(event('payment_intent.created', { id: 'pi_1' }));
    eq(result.fulfilled, false, 'not fulfilled');
    eq(result.reason, 'ignored', 'reason');
    eq(orders().length, 0, 'nothing written');
  });

  /* ---- lookup guard ---- */

  await test('a malformed session id is refused before reaching Stripe', function () {
    // Rejected on shape, so a junk id costs nothing and cannot be used to
    // hammer the API through our own endpoint.
    ['', 'nope', '../../etc/passwd', 'cs_test_' + 'x'.repeat(300), 'pi_test_abc'].forEach(function (bad) {
      let threw = null;
      try { checkout.fetchSession(bad); } catch (err) { threw = err; }
      ok(threw, 'should have thrown for ' + JSON.stringify(bad));
      eq(threw.statusCode, 400, 'status for ' + JSON.stringify(bad));
    });
  });

  /* --------------------------------------------------------- summary */

  console.log('\n  ' + passed + '/' + (passed + failures.length) + ' passed\n');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  if (failures.length) process.exit(1);
}

run().catch(function (err) {
  console.error('\n  harness crashed: ' + err.stack + '\n');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
});
