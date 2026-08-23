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
   Checkout Sessions write, Products/Prices read, Webhook Endpoints read.
2. Start the server: `npm start`
3. For webhooks in development, run the Stripe CLI in a second terminal:

   ```bash
   stripe listen --forward-to localhost:8080/api/stripe-webhook
   ```

   It prints a `whsec_…` signing secret — put that in `.env` as
   `STRIPE_WEBHOOK_SECRET` and restart the server.

4. Pay with test card `4242 4242 4242 4242`, any future expiry and CVC.

### Endpoints

| Method | Path                   | Access | Purpose                        |
|--------|------------------------|--------|--------------------------------|
| POST   | `/api/checkout`        | public | Create a Checkout Session      |
| POST   | `/api/stripe-webhook`  | Stripe | Signature-verified fulfilment  |
| GET    | `/api/orders`          | admin  | Fulfilled orders               |

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

### Not done yet

- **Tax is deliberately off.** Enabling `automatic_tax` without an active
  registration in the customer's jurisdiction collects nothing while looking
  like it works. Register first, then turn it on.
- **Orders are a JSON file.** Fine for low volume; move to a database before
  it matters.
- **No receipt email** beyond Stripe's own. No refund or cancellation flow.
- **Live mode** needs HTTPS, a Dashboard webhook endpoint (the CLI is for
  development only), and a fresh review of the Go Live checklist.

### Static copies: Payment Links

The published artifact and the standalone HTML have no server to call, so the
cart cannot be priced or checked out there. Each item instead carries a Stripe
[Payment Link](https://docs.stripe.com/payment-links.md) — a hosted URL that
needs no backend.

```bash
node --env-file=.env server/create-payment-links.js
node server/sync-page.js
```

Re-running is safe; items that already have a link are skipped. `--force`
rebuilds them.

With no backend the cart drawer relabels its button to "Buy items
individually" and shows a Buy link on each line. The full multi-item checkout
is unaffected and still runs on the real server.

These links are created in **test mode** and take no real money. The script
refuses to run against a live key, because the URLs get embedded in a public
page. Regenerate with `--force` against live keys only when you actually
intend to sell.

Editing an item in the admin panel preserves its `paymentLink`, `stripeProduct`
and `stripePrice`. Changing an item's **price** does not update its Payment
Link — regenerate with `--force` after a price change.
