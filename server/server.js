'use strict';
/**
 * NV store - minimal admin backend.
 *
 * Zero dependencies: everything here is Node's standard library, so there is
 * no npm install step and nothing to keep patched but Node itself.
 *
 *   node server/server.js            # serves the site on http://localhost:8080
 *   PORT=3000 node server/server.js  # or pick your own port
 *
 * Public:  GET /api/catalogue
 * Admin:   POST /api/login, POST /api/logout, GET /api/session,
 *          POST /api/items, PUT /api/items/:id, DELETE /api/items/:id
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const checkout = require('./stripe-checkout');

const ROOT = path.resolve(__dirname, '..');

// Data that changes at runtime. NV_DATA_DIR moves it onto a mounted volume:
// hosted platforms give you an ephemeral filesystem, so anything written
// inside the repo directory is erased on every deploy and every restart —
// which for this app means the orders taken since the last push.
const BUNDLED_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.NV_DATA_DIR || BUNDLED_DATA_DIR;
const CATALOGUE = path.join(DATA_DIR, 'catalogue.json');
const ADMIN = path.join(DATA_DIR, 'admin.json');
const PORT = Number(process.env.PORT) || 8080;

const SESSION_TTL_MS = 1000 * 60 * 60 * 8;   // 8 hours
const MAX_BODY = 64 * 1024;                   // reject oversized payloads
const LOGIN_WINDOW_MS = 1000 * 60 * 15;
const LOGIN_MAX_ATTEMPTS = 8;

/* ------------------------------------------------------------------ store */

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read ' + file + ':', err.message);
    return fallback;
  }
}

// Written to a temp file first, then renamed, so a crash mid-write cannot
// leave a truncated catalogue behind.
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadCatalogue() {
  const data = readJSON(CATALOGUE, { items: [] });
  return Array.isArray(data.items) ? data : { items: [] };
}

/**
 * A deployment points NV_DATA_DIR at a volume, which starts out empty. The
 * catalogue is source data that ships in the repo, so copy it across on first
 * boot — without this the store comes up with nothing in it and every Buy
 * button 404s on its code.
 *
 * Only the catalogue is seeded. Orders are the customer's and cannot be
 * invented, and the admin hash belongs in NV_ADMIN_HASH, not in the image.
 */
function seedDataDir() {
  if (DATA_DIR === BUNDLED_DATA_DIR) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CATALOGUE)) return;                 // already seeded; leave edits alone
  const bundled = path.join(BUNDLED_DATA_DIR, 'catalogue.json');
  if (!fs.existsSync(bundled)) return;
  fs.copyFileSync(bundled, CATALOGUE);
  console.log('  Seeded catalogue.json into ' + DATA_DIR);
}

/**
 * The admin credential, from the environment first and the data file second.
 *
 * server/data/admin.json is gitignored and a hosted deploy has nowhere
 * durable to run set-password.js before first boot, so a fresh deployment
 * would otherwise come up with no password and lock you out of the admin
 * panel entirely. NV_ADMIN_HASH carries exactly what the file carries — a
 * salt and an scrypt hash, as "<saltHex>:<hashHex>". The password itself is
 * still never stored anywhere.
 */
function loadAdmin() {
  const fromEnv = process.env.NV_ADMIN_HASH;
  if (!fromEnv) return readJSON(ADMIN, null);

  const parts = fromEnv.trim().split(':');
  const hex = /^[0-9a-fA-F]+$/;
  if (parts.length !== 2 || !hex.test(parts[0]) || !hex.test(parts[1])) {
    // Loud, because the alternative is a silent fallback to a file that is
    // not there and a login that can never succeed.
    console.error('  NV_ADMIN_HASH is set but malformed - expected "<saltHex>:<hashHex>".');
    console.error('  Generate one with:  node server/set-password.js --print');
    return null;
  }
  return { salt: parts[0], hash: parts[1] };
}

/* ------------------------------------------------------------- passwords */

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  let candidate;
  try {
    candidate = hashPassword(password, record.salt).hash;
  } catch (err) {
    return false;
  }
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(record.hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);   // constant time, no early exit
}

/* -------------------------------------------------------------- sessions */

const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expires: Date.now() + SESSION_TTL_MS });
  return token;
}

function validSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expires < Date.now()) { sessions.delete(token); return false; }
  return true;
}

setInterval(function sweep() {
  const now = Date.now();
  for (const [token, s] of sessions) if (s.expires < now) sessions.delete(token);
  // The rate-limit maps are keyed by address and would otherwise only ever
  // grow; expired windows are dead weight.
  for (const [ip, rec] of attempts) if (now - rec.first > LOGIN_WINDOW_MS) attempts.delete(ip);
  for (const [ip, rec] of lookups) if (now - rec.first > RECEIPT_WINDOW_MS) lookups.delete(ip);
}, 1000 * 60 * 30).unref();

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function isAdmin(req) {
  return validSession(parseCookies(req.headers.cookie).nv_session);
}

/* --------------------------------------------------------- login limiter */

const attempts = new Map();

function loginBlocked(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) { attempts.delete(ip); return false; }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}

function noteFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) {
    attempts.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

/* -------------------------------------------------- receipt lookup limit */

// A receipt is fetched by Checkout Session id — unguessable, and handed only
// to whoever paid. But an id we have not seen costs a call to Stripe, so the
// endpoint is capped per address to keep it from being used as an amplifier.
const RECEIPT_WINDOW_MS = 1000 * 60 * 5;
const RECEIPT_MAX_LOOKUPS = 30;
const lookups = new Map();

function receiptBlocked(ip) {
  const rec = lookups.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > RECEIPT_WINDOW_MS) { lookups.delete(ip); return false; }
  return rec.count >= RECEIPT_MAX_LOOKUPS;
}

function noteLookup(ip) {
  const rec = lookups.get(ip);
  if (!rec || Date.now() - rec.first > RECEIPT_WINDOW_MS) {
    lookups.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

/**
 * What a buyer is allowed to see. An explicit allowlist rather than the whole
 * order record, so a field added to fulfilment later has to be opted in here
 * instead of leaking from a public endpoint by default.
 */
function publicReceipt(o) {
  return {
    receiptNo: o.receiptNo || null,
    created: o.created,
    mode: o.mode,
    paymentStatus: o.paymentStatus,
    currency: o.currency,
    amountSubtotal: o.amountSubtotal == null ? null : o.amountSubtotal,
    amountTotal: o.amountTotal,
    email: o.email || null,
    name: o.name || null,
    codes: o.codes || '',
    lines: Array.isArray(o.lines) ? o.lines : null,
    shipping: o.shipping || null,
    stripeReceiptUrl: o.stripeReceiptUrl || null,
    invoiceUrl: o.invoiceUrl || null,
    invoicePdf: o.invoicePdf || null
  };
}

/* ----------------------------------------------------------- validation */

const KINDS = ['book', 'service'];
const MOTIFS = ['m-grid', 'm-layers', 'm-scan', 'm-pulse'];
const HEX = /^#[0-9a-fA-F]{6}$/;

function str(v, max) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || t.length > max) return null;
  return t;
}

// Returns { item } or { error }. Everything that reaches the catalogue file
// goes through here, so the admin UI cannot post arbitrary shapes.
function cleanItem(input, existingId) {
  if (!input || typeof input !== 'object') return { error: 'Body must be an object.' };

  const kind = KINDS.indexOf(input.kind) >= 0 ? input.kind : null;
  if (!kind) return { error: 'kind must be "book" or "service".' };

  const code = str(input.code, 40);
  const title = str(input.title, 120);
  const sub = str(input.sub, 200);
  const desc = str(input.desc, 2000);
  if (!code) return { error: 'code is required.' };
  if (!title) return { error: 'title is required.' };
  if (!sub) return { error: 'sub is required.' };
  if (!desc) return { error: 'desc is required.' };

  const price = Number(input.price);
  if (!isFinite(price) || price < 0 || price > 1000000) {
    return { error: 'price must be a number between 0 and 1000000.' };
  }

  const c1 = HEX.test(input.c1) ? input.c1 : '#1E2A23';
  const c2 = HEX.test(input.c2) ? input.c2 : '#0C120E';

  const item = {
    id: existingId || 'itm-' + crypto.randomBytes(6).toString('hex'),
    kind, code, title, sub, desc,
    price: Math.round(price * 100) / 100,
    c1, c2
  };

  if (kind === 'book') {
    item.cat = str(input.cat, 60) || 'General';
    item.pages = String(Math.max(0, Math.min(9999, Number(input.pages) || 0)));
  } else {
    item.format = str(input.format, 60) || 'Engagement';
    item.timeline = str(input.timeline, 60) || 'To be scoped';
    item.includes = str(input.includes, 200) || '';
    item.motif = MOTIFS.indexOf(input.motif) >= 0 ? input.motif : 'm-grid';
  }
  return { item };
}

/* ------------------------------------------------------------- responses */

function send(res, status, body, headers) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, headers || {}));
  res.end(payload);
}

function readRaw(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Payload too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (err) { reject(new Error('Body is not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

/* ---------------------------------------------------------- static files */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.ico': 'image/x-icon',
  // Without these two the fallback is application/octet-stream, which makes a
  // crawler fetching /robots.txt download it instead of read it.
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);

  // path traversal guard: the resolved path must stay inside ROOT, and the
  // server's own data directory is never web-readable
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, { error: 'Forbidden' });
  if (file.startsWith(path.join(__dirname, 'data'))) return send(res, 403, { error: 'Forbidden' });

  fs.stat(file, function (err, stat) {
    if (err || !stat.isFile()) return send(res, 404, { error: 'Not found' });
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    // Range support keeps video scrubbing working
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace('bytes=', '').split('-');
      const start = s ? parseInt(s, 10) : 0;
      const end = e ? parseInt(e, 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': type, 'Content-Length': end - start + 1,
        'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
        'Accept-Ranges': 'bytes'
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* -------------------------------------------------------------- routing */

const server = http.createServer(function (req, res) {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = parsed.pathname;
  const ip = req.socket.remoteAddress || 'unknown';

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  // Stripe posts a signed payload; its authenticity comes from the signature,
  // not from the CSRF-shaped content-type check below.
  const isWebhook = pathname === '/api/stripe-webhook';

  // Browsers send no custom headers on a cross-site form post, so requiring
  // JSON here blocks the simple-request CSRF shape. SameSite does the rest.
  const needsJSON = ['POST', 'PUT', 'DELETE'].indexOf(req.method) >= 0;
  const ct = (req.headers['content-type'] || '').split(';')[0].trim();
  if (needsJSON && !isWebhook && req.method !== 'DELETE' && ct !== 'application/json') {
    return send(res, 415, { error: 'Content-Type must be application/json.' });
  }

  (async function route() {
    // ---- public read
    if (pathname === '/api/catalogue' && req.method === 'GET') {
      return send(res, 200, loadCatalogue());
    }

    // ---- create a Checkout Session (public: anyone may buy)
    if (pathname === '/api/checkout' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const session = await checkout.createSession(body.cart, 'http://' + (req.headers.host || 'localhost:8080'));
        return send(res, 200, { url: session.url, id: session.id });
      } catch (err) {
        // Surface our own validation text; keep Stripe's internals to the log.
        const status = err.statusCode || 500;
        if (status >= 500) console.error('  [stripe] ' + err.message);
        return send(res, status, {
          error: status >= 500 ? 'Checkout is unavailable right now.' : err.message
        });
      }
    }

    // ---- Stripe webhook: signature-verified, raw body
    if (pathname === '/api/stripe-webhook' && req.method === 'POST') {
      const raw = await readRaw(req);
      let event;
      try {
        event = checkout.verifyEvent(raw, req.headers['stripe-signature']);
      } catch (err) {
        console.error('  [stripe] rejected webhook: ' + err.message);
        return send(res, err.statusCode === 503 ? 503 : 400, { error: 'Invalid signature.' });
      }
      try {
        const result = await checkout.handleEvent(event);
        return send(res, 200, { received: true, fulfilled: Boolean(result.fulfilled) });
      } catch (err) {
        console.error('  [stripe] handler failed: ' + err.message);
        return send(res, 500, { error: 'Handler error.' });   // Stripe will retry
      }
    }

    // ---- a customer's receipt. The session id from the return URL is the
    // whole credential: unguessable, and issued only to whoever paid. If the
    // order is not on file yet this reads it back from Stripe and records it,
    // which is what makes receipts work on localhost, where no webhook lands.
    if (pathname === '/api/receipt' && req.method === 'GET') {
      if (receiptBlocked(ip)) {
        return send(res, 429, { error: 'Too many lookups. Try again shortly.' });
      }
      noteLookup(ip);
      try {
        const receipt = await checkout.receiptFor(parsed.searchParams.get('session_id'));
        if (!receipt) return send(res, 404, { error: 'No receipt for that order.' });
        return send(res, 200, { receipt: publicReceipt(receipt) });
      } catch (err) {
        const status = err.statusCode || 502;
        // Stripe's own 404 text names the object it could not find; ours says
        // nothing an id-guessing caller could learn from.
        if (status === 404) return send(res, 404, { error: 'No receipt for that order.' });
        if (status >= 500) console.error('  [stripe] receipt lookup failed: ' + err.message);
        return send(res, status, {
          error: status >= 500 ? 'Could not load that receipt right now.' : err.message
        });
      }
    }

    // ---- reconcile with Stripe (admin only)
    if (pathname === "/api/orders/sync" && req.method === "POST") {
      if (!isAdmin(req)) return send(res, 401, { error: "Not signed in." });
      const body = await readBody(req);
      try {
        const result = await checkout.syncOrders(body.limit);
        return send(res, 200, result);
      } catch (err) {
        console.error("  [stripe] sync failed: " + err.message);
        return send(res, err.statusCode || 500, { error: "Could not reach Stripe." });
      }
    }

    // ---- orders (admin only, checked further down as well)
    if (pathname === '/api/orders' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Not signed in.' });
      return send(res, 200, checkout.readJSON(checkout.ORDERS, { orders: [] }));
    }

    // ---- who am I
    if (pathname === '/api/session' && req.method === 'GET') {
      return send(res, 200, { admin: isAdmin(req) });
    }

    // ---- login
    if (pathname === '/api/login' && req.method === 'POST') {
      if (loginBlocked(ip)) {
        return send(res, 429, { error: 'Too many attempts. Try again later.' });
      }
      const body = await readBody(req);
      const admin = loadAdmin();
      if (!admin) {
        return send(res, 500, { error: 'No admin password set. Run: node server/set-password.js' });
      }
      if (typeof body.password !== 'string' || !verifyPassword(body.password, admin)) {
        noteFailure(ip);
        return send(res, 401, { error: 'Incorrect password.' });   // never says which part failed
      }
      attempts.delete(ip);
      const token = createSession();
      const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
      return send(res, 200, { admin: true }, {
        'Set-Cookie': 'nv_session=' + token + '; HttpOnly; SameSite=Strict; Path=/;' +
                      secure + ' Max-Age=' + Math.floor(SESSION_TTL_MS / 1000)
      });
    }

    // ---- logout
    if (pathname === '/api/logout' && req.method === 'POST') {
      const token = parseCookies(req.headers.cookie).nv_session;
      if (token) sessions.delete(token);
      return send(res, 200, { admin: false }, {
        'Set-Cookie': 'nv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
      });
    }

    // ---- everything below is admin only
    if (!isAdmin(req)) return send(res, 401, { error: 'Not signed in.' });

    if (pathname === '/api/items' && req.method === 'POST') {
      const body = await readBody(req);
      const { item, error } = cleanItem(body);
      if (error) return send(res, 400, { error });
      const data = loadCatalogue();
      if (data.items.some(function (i) { return i.code === item.code; })) {
        return send(res, 409, { error: 'An item with that code already exists.' });
      }
      data.items.push(item);
      writeJSON(CATALOGUE, data);
      return send(res, 201, { item });
    }

    const match = pathname.match(/^\/api\/items\/([A-Za-z0-9_-]{1,64})$/);
    if (match) {
      const id = match[1];
      const data = loadCatalogue();
      const idx = data.items.findIndex(function (i) { return i.id === id; });
      if (idx < 0) return send(res, 404, { error: 'No item with that id.' });

      if (req.method === 'PUT') {
        const body = await readBody(req);
        const { item, error } = cleanItem(body, id);
        if (error) return send(res, 400, { error });
        // cleanItem rebuilds the record from scratch, so Stripe references
        // that the admin form does not carry have to be preserved here.
        ['paymentLink', 'stripeProduct', 'stripePrice'].forEach(function (k) {
          if (data.items[idx][k]) item[k] = data.items[idx][k];
        });
        const clash = data.items.some(function (i, n) { return n !== idx && i.code === item.code; });
        if (clash) return send(res, 409, { error: 'An item with that code already exists.' });
        data.items[idx] = item;
        writeJSON(CATALOGUE, data);
        return send(res, 200, { item });
      }

      if (req.method === 'DELETE') {
        const [removed] = data.items.splice(idx, 1);
        writeJSON(CATALOGUE, data);
        return send(res, 200, { removed });
      }
    }

    return send(res, 404, { error: 'No such endpoint.' });
  })().catch(function (err) {
    send(res, 400, { error: err.message || 'Bad request.' });
  });
});

seedDataDir();

server.listen(PORT, function () {
  if (!loadAdmin()) {
    console.log('\n  No admin password set yet.');
    console.log('  Local:    node server/set-password.js');
    console.log('  Deployed: node server/set-password.js --print, then set NV_ADMIN_HASH\n');
  }
  if (DATA_DIR !== BUNDLED_DATA_DIR) {
    console.log('  Data directory:     ' + DATA_DIR);
  }
  // Only the genuinely wrong combination: served over https, but NODE_ENV is
  // not production, so the session cookie goes out without Secure. A local
  // PUBLIC_URL of http://localhost is correct and must not warn, or the
  // warning becomes noise and stops being read.
  if (/^https:/i.test(process.env.PUBLIC_URL || '') && process.env.NODE_ENV !== 'production') {
    console.log('  WARNING: PUBLIC_URL is https but NODE_ENV is not "production" —');
    console.log('           the admin session cookie will be sent without Secure.');
  }
  console.log('  NV store running at http://localhost:' + PORT);
  console.log('  Admin panel:        http://localhost:' + PORT + '/admin.html\n');
});
