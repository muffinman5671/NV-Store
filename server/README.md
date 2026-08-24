# NV store — admin backend

A small Node server that puts the catalogue behind a password so books and
services can be added, edited, and removed without touching HTML.

No npm install. It uses only Node's standard library.

## Setup

Install Node 18 or newer, then from the `nv-store` folder:

```bash
node server/set-password.js
```

Choose a password of at least 10 characters. Input is hidden as you type. The
password itself is never stored — `server/data/admin.json` holds a random salt
and an scrypt hash.

For scripted setup, `NV_ADMIN_PASSWORD=... node server/set-password.js` skips
the prompt.

```bash
node server/server.js
```

- Site: <http://localhost:8080>
- Admin: <http://localhost:8080/admin.html>

Use `PORT=3000 node server/server.js` to change the port.

## How the front end uses it

`index.html` renders its catalogue from data, not hard-coded markup. On load it
draws the copy baked into the page, then asks `/api/catalogue`. If the server
answers, that data replaces it.

This means the page still works with no backend at all — opened as a file, or
published as a static artifact. It simply shows the built-in catalogue and the
admin has nothing to talk to.

## Keeping the static copy in sync

The running site reads `/api/catalogue`, so admin edits show up there at once.
`index.html` also carries a copy of the catalogue for when there is no server —
opening the file directly, or a published static build. That copy does not
update itself:

```bash
node server/sync-page.js
```

Run it after editing, then rebuild or republish the static copy.

## API

| Method | Path              | Access | Purpose                  |
|--------|-------------------|--------|--------------------------|
| GET    | `/api/catalogue`  | public | All items                |
| GET    | `/api/session`    | public | Am I signed in?          |
| POST   | `/api/login`      | public | Start a session          |
| POST   | `/api/logout`     | public | End it                   |
| POST   | `/api/items`      | admin  | Create an item           |
| PUT    | `/api/items/:id`  | admin  | Replace an item          |
| DELETE | `/api/items/:id`  | admin  | Remove an item           |

## What protects the admin routes

- **Password**: scrypt with a per-install random salt; compared in constant
  time so the comparison cannot be used to guess the hash byte by byte.
- **Session**: a 32-byte random token in an `HttpOnly`, `SameSite=Strict`
  cookie, expiring after 8 hours. `HttpOnly` keeps it out of reach of any
  script on the page.
- **Rate limiting**: 8 failed logins per IP per 15 minutes.
- **Input validation**: every field is type-checked, length-capped, and
  rebuilt server-side, so the API cannot be used to store arbitrary shapes.
- **Path traversal**: static paths must resolve inside the project, and
  `server/data/` is never served over HTTP.
- **Writes**: the catalogue is written to a temp file and renamed, so an
  interrupted write cannot truncate it.

## Before putting this on the internet

This is a sound local setup, but it is not yet a public deployment:

1. **Serve over HTTPS.** The session cookie is only marked `Secure` when
   `NODE_ENV=production` — set it, and terminate TLS in front of the server.
   Over plain HTTP the cookie can be read in transit.
2. **Sessions live in memory.** Restarting the server signs everyone out, and
   this will not work across multiple processes.
3. **One shared password, no user accounts.** There is no audit trail of who
   changed what.
4. **No backups.** `server/data/catalogue.json` is the only copy.

## Payments (Stripe)

Stripe-hosted Checkout Sessions. Card details never touch this server, which
keeps the integration in PCI SAQ A.

### Setup

1. Copy `.env.example` to `.env` and fill in your keys. `.env` is gitignored.
   Prefer a **restricted key** (`rk_test_…`) over a secret key, scoped to:
   Checkout Sessions **write**, Products/Prices read, Webhook Endpoints read,
   plus — for receipts — Charges read, Invoices read, and PaymentIntents
   **write**. The last one is what lets the server ask Stripe to email its own
   receipt; without it receipts still render on the site, but no email is sent.
2. Start the server: `npm start`
3. For webhooks in development, run the Stripe CLI in a second terminal:

   ```bash
   stripe listen --forward-to localhost:8080/api/stripe-webhook
   ```

   It prints a `whsec_…` signing secret — put that in `.env` as
   `STRIPE_WEBHOOK_SECRET` and restart the server.

4. Pay with test card `4242 4242 4242 4242`, any future expiry and CVC.

### Endpoints

| Method | Path                   | Access   | Purpose                        |
|--------|------------------------|----------|--------------------------------|
| POST   | `/api/checkout`        | public   | Create a Checkout Session      |
| POST   | `/api/stripe-webhook`  | Stripe   | Signature-verified fulfilment  |
| GET    | `/api/receipt`         | buyer    | One receipt, by `session_id`   |
| GET    | `/api/orders`          | admin    | Fulfilled orders               |
| POST   | `/api/orders/sync`     | admin    | Reconcile against Stripe       |

### Design decisions

- **The client never sends prices.** The browser posts `{code, qty}` only;
  every amount is looked up from `catalogue.json` server-side. Without this,
  anyone can edit their cart in devtools and buy a $7,500 engagement for $1.
- **Fulfilment happens in the webhook**, not on the success page. Customers
  are not guaranteed to arrive there — an order that only completes on
  redirect is an order silently dropped. Both `checkout.session.completed`
  and `checkout.session.async_payment_succeeded` are handled, and only when
  `payment_status` is not `unpaid`.
- **Replayed events do not double-fulfil.** Orders are keyed by session id.
- **`payment_method_types` is never passed**, which enables dynamic payment
  methods — Stripe picks what converts best per customer, configurable from
  the Dashboard with no code change.
- **Idempotency keys** on session creation, so a double-clicked button
  reuses the session instead of creating a second one.
- **Mixed carts are refused.** A Checkout Session is `payment` or
  `subscription`, never both, so a cart holding a monthly item plus one-off
  items is rejected with a message telling the customer to buy it separately.
  Recurring items are listed in `RECURRING_CODES` in `stripe-checkout.js`.
- **Shipping is collected only when the cart contains a book**, since print
  editions ship and services do not.

### Receipts

Every paid order gets a receipt number — `NV-2026-0001`, sequential within the
calendar year — and a page at `/receipt.html?session_id=…` that renders it in
the shop's own type and colours, and prints to PDF.

- **Line detail is stored, not joined.** The catalogue is editable from the
  admin panel, so a receipt that looked its prices up live would silently
  rewrite what a past customer was charged. Titles, codes, unit amounts and
  quantities are copied onto the order at the moment of sale and never touched
  again.
- **The session id is the credential.** It is unguessable and Stripe hands it
  only to whoever paid, arriving in the return URL. `index.html` scrubs it from
  the address bar immediately so it does not survive in history or a shared
  link. The endpoint validates the id's shape before spending a call on it and
  is rate-limited per address, so unknown ids cannot be used to hammer Stripe
  through us.
- **A receipt can be built without a webhook.** If the order is not on file,
  `/api/receipt` retrieves the session from Stripe and records it then. The id
  in the URL only selects *which* session to ask about — Stripe's answer is
  what decides whether it was paid. This is what makes receipts work on
  localhost, where no webhook can ever arrive.
- **Stripe emails its own receipt too.** Checkout does not set `receipt_email`
  for us, so fulfilment sets it on the succeeded PaymentIntent, which sends
  one. Payment-mode sessions also enable `invoice_creation`, giving a hosted
  invoice and a PDF; both URLs are captured and linked from our page.
  Sending is best effort — a receipt that fails to send never fails an order.
  **In test mode Stripe only delivers these to your own account address**, and
  delivery also needs Dashboard → Settings → Emails → "Successful payments"
  switched on. Setting `receipt_email` is all this code can do; dispatch is a
  Dashboard setting.
- **Old orders are backfilled.** Re-seeing a session fills in detail an earlier
  thin record missed, so orders written before receipts existed gain a number
  and line prices without being counted as new sales.

Run `npm test` for the receipt suite — 25 cases covering numbering, line
capture, shipping, idempotent fulfilment, backfill, and the id guard. It uses
a scratch orders file and never touches `server/data/orders.json`.

### Not done yet

- **Tax is deliberately off.** Enabling `automatic_tax` without an active
  registration in the customer's jurisdiction collects nothing while looking
  like it works. Register first, then turn it on.
- **Orders are a JSON file.** Fine for low volume; move to a database before
  it matters.
- **The receipt email is Stripe's, not ours.** It carries Stripe's template and
  whatever branding is set in the Dashboard, not the shop's. An NV-designed
  email needs a sending domain and a provider; the receipt *page* is already
  ours, so the email only has to carry a link to it.
- **No refund or cancellation flow.** A refund issued in the Dashboard does not
  change what the receipt page shows.
- **Live mode** needs HTTPS, a Dashboard webhook endpoint (the CLI is for
  development only), and a fresh review of the Go Live checklist.

### Static copies: Payment Links

The published artifact and the standalone HTML have no server to call, so a
Checkout Session cannot be created there. Each item instead carries a Stripe
[Payment Link](https://docs.stripe.com/payment-links.md) — a hosted URL that
needs no backend.

```bash
node --env-file=.env server/create-payment-links.js
node server/sync-page.js
```

Re-running is safe; items that already have a link are skipped. `--force`
rebuilds them.

Every item has a Buy now button. With the server running it posts to
`/api/checkout`, which prices the item from the catalogue and returns a
Checkout Session. With no server it opens that item's Payment Link instead,
and it also falls back to the link if the request fails.

These links are created in **test mode** and take no real money. The script
refuses to run against a live key, because the URLs get embedded in a public
page. Regenerate with `--force` against live keys only when you actually
intend to sell.

Editing an item in the admin panel preserves its `paymentLink`, `stripeProduct`
and `stripePrice`. Changing an item's **price** does not update its Payment
Link — regenerate with `--force` after a price change.

### Reconciling missed webhooks

Webhooks are the primary fulfilment path, but events can fail to arrive — a
webhook outage, or local development where Stripe cannot reach your machine
at all. `POST /api/orders/sync` (admin only) pulls recent Checkout Sessions
from Stripe and records any that are paid but missing locally.

It skips sessions already recorded, so running it repeatedly is safe. It is a
safety net, not a replacement: it does not run on the success redirect, and
fulfilment still belongs in the webhook.

Order records live in `server/data/orders.json`, which is **not** in version
control — it holds customer email addresses.
