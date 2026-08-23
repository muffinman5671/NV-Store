# Continuing work on NV Store

Paste everything below into a new chat.

---

I'm continuing work on a project you helped me build. Here's the state of it.

## What it is

**NV** — a one-page store for books and cybersecurity services, with a Node
backend, a password-protected admin panel, and Stripe payments.

- Local project: `C:\Users\aiden\nv-store`
- Repo: https://github.com/muffinman5671/NV-Store (**public**)
- Published artifact: https://claude.ai/code/artifact/332eef38-7593-4ddb-973f-9fa346bb043e

Founder is **Nathaniel Varney**, Chicago — cybersecurity and GRC (PCI DSS,
NIST RMF SP-800, HIPAA, ISO, Active Directory). The services in the catalogue
are drawn from that background.

## Running it

Node 24 is installed. **Use `npm.cmd` / `stripe.cmd`, not `npm` / `stripe`** —
PowerShell's execution policy is Restricted and blocks the `.ps1` shims.

```
cd C:\Users\aiden\nv-store
npm.cmd start
```

Site on http://localhost:8080, admin at `/admin.html`.

## Layout

| Path | What it is |
|------|------------|
| `index.html` | The entire site — markup, CSS and JS in one file |
| `admin.html` | Sign-in, catalogue editor, receipts list |
| `receipt.html` | The customer's receipt, printable to PDF |
| `server/server.js` | HTTP server, auth, catalogue + Stripe routes |
| `server/stripe-checkout.js` | Checkout Sessions, webhooks, receipts, reconciliation |
| `server/test-receipts.js` | Receipt suite — `npm.cmd test`, no network |
| `server/set-password.js` | Sets the admin password (scrypt hash) |
| `server/sync-page.js` | Bakes the live catalogue into `index.html` |
| `server/create-payment-links.js` | Payment Links for static copies |
| `server/data/catalogue.json` | The catalogue |
| `assets/` | Hero video, founder photographs |

## How it's built

**Hero** — a 520vh pinned section where scroll scrubs a video frame by frame
(`video.currentTime` driven by an inertial lerp). The video is all-intra
encoded so seeking is frame-exact. Two typographic beats, then the film
de-scales into a rounded slab.

**Founder section** — a second pinned reel using the same progress model.

**Design system** — Bodoni Moda display, Archivo body, JetBrains Mono labels.
Warm near-black ground, ember accent pulled from the video's lamp glow. Both
light and dark themes; all text meets WCAG AA.

**Catalogue is data-driven.** `index.html` renders from a `CATALOGUE` constant,
then hydrates from `/api/catalogue` if a server answers. That's what lets the
static copies work.

**Payments** — Stripe-hosted Checkout Sessions. Every item has a **Buy now**
button (no cart). With the server up it posts `{code, qty}` to `/api/checkout`
and the server prices it from the catalogue; without a server it opens that
item's Stripe Payment Link.

**Receipts** — every paid order gets a number (`NV-2026-0001`, sequential per
calendar year) and a page at `/receipt.html?session_id=…` in the shop's own
type and colours, printable to PDF. Line detail is *copied onto the order at
the moment of sale*, never looked up live, so re-pricing an item in the admin
panel cannot rewrite what a past customer was charged. Stripe also emails its
own receipt, and payment-mode sessions raise a hosted invoice + PDF whose URLs
the page links. Admin has a **Receipts** list with a *Reconcile with Stripe*
button.

## Things to be careful about

1. **Prices are never taken from the client.** The browser sends codes and
   quantities only. Verified: a cart claiming `$0.01` was charged `$68.00`.
   Don't undo this.
2. **The repo is public.** `.env`, `server/data/admin.json` and
   `server/data/orders.json` are gitignored — the last holds customer emails.
   A pre-commit hook blocks Stripe keys; don't bypass it.
3. **Two catalogues.** The server reads `catalogue.json`; `index.html` carries
   a copy for static use. After admin edits run `node server/sync-page.js`,
   then rebuild the standalone/artifact, or they'll show stale data.
4. **Changing a price does not update its Payment Link.** Re-run
   `create-payment-links.js --force` and re-sync, or static copies sell at the
   old price.
5. **Tax is deliberately off.** `automatic_tax` without an active registration
   collects nothing while appearing to work.
6. **Fulfilment lives in the webhook**, not the success page. `/api/receipt` is
   a second, safe path into it: it retrieves the session from Stripe and
   records it if no webhook arrived. Stripe's answer decides whether it was
   paid — the id in the URL only picks which session to ask about.
7. **A receipt's line prices are frozen.** They're stored on the order, not
   joined from the catalogue. Don't "simplify" that into a lookup.
8. **Restricted keys need more scopes now**: Charges read, Invoices read and
   PaymentIntents **write**, on top of the old set. Without the last one
   receipts still render, but Stripe sends no email.

## Where it stands

Working and verified: the site, admin CRUD, Stripe Checkout, webhook handling
(9/9 signature and fulfilment tests), Payment Links, and a real test purchase
(`$32.00`, recorded as paid).

Receipts are working and verified end to end: `npm.cmd test` is 25/25, and the
real `$32.00` order was backfilled from its old thin record into a full receipt
— number, line detail, shipping address and Stripe's hosted receipt URL — then
rendered at `/receipt.html`. Its `invoiceUrl` is empty because that sale
predates `invoice_creation`; new payment-mode orders get one.

**Placeholder content that needs replacing before launch:**
- Book titles are "Example 1/2/3" with invented subtitles, page counts, prices
- Service names, scopes, timelines and prices are drafts from the founder bio
- Three testimonials use invented names
- The "Contact" panel uses `hello@example.com`
- "Terms & privacy" is explicitly placeholder — it needs real terms and a real
  privacy policy, not generated text

**Known gaps:**
- `STRIPE_WEBHOOK_SECRET` in `.env` is a locally generated value, not a real
  `whsec_` from Stripe. Real events will fail signature checks until it's
  replaced. `stripe listen` is blocked by Smart App Control on this machine —
  the CLI binary is unsigned and in `AppData`.
- Sessions are in-memory: restarting the server signs the admin out.
- Orders are a JSON file.
- No HTTPS, so the session cookie isn't `Secure`.
- Not deployed anywhere.
- **The receipt email is Stripe's, not NV's** — Stripe's template and Dashboard
  branding, and *in test mode it only reaches your own account address*. An
  NV-designed email needs a sending domain and a provider; the receipt page is
  already ours, so that email only has to carry a link to it.
- **Refunds don't reach the receipt.** A refund issued in the Dashboard leaves
  the page still reading "Paid".
- `nv-editions-standalone.html` is now stale against `index.html` (it predates
  the receipt link on the success toast). Receipts need a server, so the
  standalone loses nothing — but rebuild it before republishing the artifact.

## Environment quirks that wasted time before

- **New terminals need reopening** after installs; PATH is stale otherwise.
- **`.ps1` shims are blocked** — use `npm.cmd`, or full paths.
- **A server started in your terminal cannot be killed by the assistant**
  ("Access is denied"). If a restart is needed, you have to do it.
- Editing files with Perl that reads raw bytes but writes through an encoding
  layer **double-encodes UTF-8**. This bit twice (`â` instead of `—`).

## What I want to do next

<!-- Replace this line with what you actually want. -->
