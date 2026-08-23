'use strict';
/**
 * Creates a Stripe Payment Link for every catalogue item.
 *
 *   node --env-file=.env server/create-payment-links.js
 *
 * Payment Links are Stripe-hosted URLs that need no backend, so they work
 * from a purely static copy of the site — the published artifact, or the
 * standalone HTML file. The full cart checkout on the real server stays as
 * it is; these are the fallback for when there is no server to call.
 *
 * Re-running is safe: items that already have a link are left alone.
 * Pass --force to rebuild every link from scratch.
 */

const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const CATALOGUE = path.join(__dirname, 'data', 'catalogue.json');
const FORCE = process.argv.includes('--force');

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function writeJSON(file, value) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

(async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || /replace_me/.test(key)) {
    console.error('\n  STRIPE_SECRET_KEY is not set. Run with: node --env-file=.env server/create-payment-links.js\n');
    process.exit(1);
  }
  if (/^[sr]k_live_/.test(key)) {
    console.error('\n  Refusing to run against a LIVE key. Payment Links created here are');
    console.error('  embedded in a public page — build them in test mode first.\n');
    process.exit(1);
  }

  const stripe = new Stripe(key, { apiVersion: '2026-07-29.dahlia' });
  const data = readJSON(CATALOGUE);
  let made = 0;
  let kept = 0;

  for (const item of data.items) {
    if (item.paymentLink && !FORCE) { kept++; continue; }

    // A Payment Link needs a Price, which needs a Product.
    const product = await stripe.products.create({
      name: item.title,
      description: item.sub,
      metadata: { code: item.code, kind: item.kind, nv_id: item.id }
    });

    const price = await stripe.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: Math.round(Number(item.price) * 100)
    });

    const params = {
      line_items: [{ price: price.id, quantity: 1, adjustable_quantity: { enabled: true, minimum: 1, maximum: 20 } }],
      metadata: { code: item.code, source: 'nv-store-payment-link' },
      after_completion: {
        type: 'redirect',
        redirect: { url: (process.env.PUBLIC_URL || 'http://localhost:8080') + '/?checkout=success' }
      }
    };
    // Books ship a print edition; services do not.
    if (item.kind === 'book') {
      params.shipping_address_collection = { allowed_countries: ['US', 'CA', 'GB', 'IE', 'AU', 'NZ'] };
    }

    const link = await stripe.paymentLinks.create(params);

    item.paymentLink = link.url;
    item.stripeProduct = product.id;
    item.stripePrice = price.id;
    made++;
    console.log('  + ' + item.code.padEnd(12) + ' $' + String(item.price).padEnd(6) + ' ' + link.url);
  }

  writeJSON(CATALOGUE, data);
  console.log('\n  ' + made + ' created, ' + kept + ' already had links.');
  console.log('  Now run:  node server/sync-page.js\n');
})().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n');
  process.exit(1);
});
