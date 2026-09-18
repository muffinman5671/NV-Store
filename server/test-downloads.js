'use strict';
/**
 * Download / entitlement tests.
 *
 *   node server/test-downloads.js
 *
 * These run against a real HTTP server on a scratch port, with a scratch
 * NV_DATA_DIR, so nothing touches the real catalogue, orders or files. No
 * Stripe key and no network: every order is written straight into the scratch
 * orders.json, which is the same thing a paid webhook would have produced.
 *
 * The case that matters most here is entitlement — buying the cheap book must
 * not unlock the expensive engagement's files.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-downloads-'));
process.env.NV_DATA_DIR = SCRATCH;
process.env.NV_ORDERS_FILE = path.join(SCRATCH, 'orders.json');
process.env.PORT = '8123';

const BASE = 'http://127.0.0.1:' + process.env.PORT;

/* ------------------------------------------------------------ fixtures */

const BOOK = {
  id: 'itm-book01', kind: 'book', code: 'NV / 013', title: 'Example 2',
  sub: 'x', desc: 'x', price: 32, c1: '#1E2A23', c2: '#0C120E',
  cat: 'General', pages: '216', assets: []
};
const SERVICE = {
  id: 'itm-svc01', kind: 'service', code: 'NV / S-02', title: 'GRC Program Build',
  sub: 'x', desc: 'x', price: 7500, c1: '#1E2A23', c2: '#0C120E',
  format: 'Engagement', timeline: '6-10 weeks', includes: '', motif: 'm-grid',
  assets: []
};

function writeCatalogue(items) {
  fs.writeFileSync(path.join(SCRATCH, 'catalogue.json'), JSON.stringify({ items: items }, null, 2));
}

function writeOrders(orders) {
  fs.writeFileSync(process.env.NV_ORDERS_FILE, JSON.stringify({ orders: orders }, null, 2));
}

// A paid order, shaped exactly as fulfilment writes one.
function order(sessionId, lines, over) {
  return Object.assign({
    sessionId: sessionId,
    receiptNo: 'NV-2026-0001',
    mode: 'payment',
    amountTotal: 3200,
    currency: 'usd',
    paymentStatus: 'paid',
    email: 'buyer@example.com',
    codes: lines.map(function (l) { return l.code; }).join(','),
    lines: lines,
    created: new Date().toISOString()
  }, over || {});
}

function line(code, description) {
  return { description: description, code: code, kind: 'book', quantity: 1,
           unitAmount: 3200, amountTotal: 3200, recurring: false };
}

// Put a real file on disk and return the asset record the catalogue holds.
function plantAsset(id, filename, label, body) {
  const filesDir = path.join(SCRATCH, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const stored = id.replace('ast-', '').padEnd(32, '0') + path.extname(filename);
  fs.writeFileSync(path.join(filesDir, stored), body);
  return { id: id, stored: stored, filename: filename, label: label,
           bytes: Buffer.byteLength(body), added: new Date().toISOString() };
}

/* ------------------------------------------------------------ harness */

let passed = 0;
const failures = [];

async function test(name, fn) {
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
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || 'value') + ': expected ' + b + ', got ' + a);
}
function ok(v, what) { if (!v) throw new Error(what || 'expected truthy'); }

function get(pathname, headers) {
  return new Promise(function (resolve, reject) {
    const req = http.get(BASE + pathname, { headers: headers || {} }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
  });
}

async function json(pathname) {
  const r = await get(pathname);
  let parsed = null;
  try { parsed = JSON.parse(r.body.toString('utf8')); } catch (e) { /* not json */ }
  return { status: r.status, json: parsed, headers: r.headers, body: r.body };
}

/* --------------------------------------------------------------- cases */

async function run() {
  console.log('\n  downloads\n');

  const EBOOK = plantAsset('ast-aaaaaaaaaaaa', 'example-2.epub', 'Ebook (EPUB)', 'EPUB-BYTES-HERE');
  const AUDIO = plantAsset('ast-bbbbbbbbbbbb', 'example-2.mp3', 'Audiobook', 'MP3-BYTES-HERE');
  const BRIEF = plantAsset('ast-cccccccccccc', 'grc-brief.pdf', 'Engagement brief', 'PDF-BYTES');

  const book = Object.assign({}, BOOK, { assets: [EBOOK, AUDIO] });
  const service = Object.assign({}, SERVICE, { assets: [BRIEF] });
  writeCatalogue([book, service]);

  const BOOK_ORDER = 'cs_test_bookbuyer000000000000';
  const SVC_ORDER = 'cs_test_svcbuyer0000000000000';
  const UNPAID = 'cs_test_unpaid00000000000000';

  writeOrders([
    order(BOOK_ORDER, [line('NV / 013', 'Example 2')]),
    order(SVC_ORDER, [Object.assign(line('NV / S-02', 'GRC Program Build'), { kind: 'service' })],
      { receiptNo: 'NV-2026-0002', amountTotal: 750000 }),
    order(UNPAID, [line('NV / 013', 'Example 2')],
      { receiptNo: 'NV-2026-0003', paymentStatus: 'unpaid' })
  ]);

  require('./server.js');
  await new Promise(function (r) { setTimeout(r, 400); });   // let listen() settle

  /* ---- the receipt advertises the right files ---- */

  await test('a book order lists exactly its own files', async function () {
    const r = await json('/api/receipt?session_id=' + BOOK_ORDER);
    eq(r.status, 200, 'status');
    const labels = r.json.receipt.downloads.map(function (d) { return d.label; }).sort();
    eq(labels, ['Audiobook', 'Ebook (EPUB)'], 'labels');
  });

  await test('download entries carry what the page needs to render', async function () {
    const r = await json('/api/receipt?session_id=' + BOOK_ORDER);
    const d = r.json.receipt.downloads.find(function (x) { return x.label === 'Ebook (EPUB)'; });
    eq(d.assetId, 'ast-aaaaaaaaaaaa', 'assetId');
    eq(d.filename, 'example-2.epub', 'filename');
    eq(d.code, 'NV / 013', 'code');
    eq(d.title, 'Example 2', 'title');
    ok(d.bytes > 0, 'bytes present');
  });

  await test('a service order lists only the service file', async function () {
    const r = await json('/api/receipt?session_id=' + SVC_ORDER);
    const labels = r.json.receipt.downloads.map(function (d) { return d.label; });
    eq(labels, ['Engagement brief'], 'labels');
  });

  /* ---- entitlement: the case that actually matters ---- */

  await test('the book buyer CAN download the book files', async function () {
    const r = await get('/api/download?session_id=' + BOOK_ORDER + '&asset=ast-aaaaaaaaaaaa');
    eq(r.status, 200, 'status');
    eq(r.body.toString('utf8'), 'EPUB-BYTES-HERE', 'body');
  });

  await test('the book buyer CANNOT download the service file', async function () {
    // $32 must not unlock the $7,500 engagement's material.
    const r = await json('/api/download?session_id=' + BOOK_ORDER + '&asset=ast-cccccccccccc');
    eq(r.status, 404, 'status');
    ok(!r.body.toString('utf8').includes('PDF-BYTES'), 'must not leak the file body');
  });

  await test('the service buyer CANNOT download the book files', async function () {
    const r = await json('/api/download?session_id=' + SVC_ORDER + '&asset=ast-aaaaaaaaaaaa');
    eq(r.status, 404, 'status');
    ok(!r.body.toString('utf8').includes('EPUB-BYTES'), 'must not leak the file body');
  });

  await test('an unpaid order downloads nothing', async function () {
    const r = await json('/api/download?session_id=' + UNPAID + '&asset=ast-aaaaaaaaaaaa');
    ok(r.status === 409 || r.status === 404, 'expected 409/404, got ' + r.status);
    ok(!r.body.toString('utf8').includes('EPUB-BYTES'), 'must not leak the file body');
  });

  /* ---- shape of the request itself ---- */

  await test('a malformed asset id is refused before any lookup', async function () {
    for (const bad of ['', 'nope', '../../etc/passwd', 'ast-XXXX', 'ast-aaaaaaaaaaaaa']) {
      const r = await json('/api/download?session_id=' + BOOK_ORDER + '&asset=' + encodeURIComponent(bad));
      eq(r.status, 400, 'status for ' + JSON.stringify(bad));
    }
  });

  await test('an unknown session id downloads nothing', async function () {
    const r = await json('/api/download?session_id=cs_test_nosuchsession0000000&asset=ast-aaaaaaaaaaaa');
    ok(r.status >= 400, 'expected an error, got ' + r.status);
    ok(!r.body.toString('utf8').includes('EPUB-BYTES'), 'must not leak the file body');
  });

  /* ---- delivery details ---- */

  await test('the file is sent as a named attachment, not inline', async function () {
    const r = await get('/api/download?session_id=' + BOOK_ORDER + '&asset=ast-aaaaaaaaaaaa');
    const cd = r.headers['content-disposition'] || '';
    ok(/^attachment/.test(cd), 'should be an attachment: ' + cd);
    ok(cd.indexOf('example-2.epub') >= 0, 'should carry the buyer-facing filename: ' + cd);
    eq(r.headers['content-type'], 'application/epub+zip', 'content-type');
  });

  await test('downloads are never cached by a shared cache', async function () {
    const r = await get('/api/download?session_id=' + BOOK_ORDER + '&asset=ast-aaaaaaaaaaaa');
    ok(/private/.test(r.headers['cache-control'] || ''), 'cache-control: ' + r.headers['cache-control']);
  });

  await test('range requests work, so audio can seek and resume', async function () {
    const r = await get('/api/download?session_id=' + BOOK_ORDER + '&asset=ast-bbbbbbbbbbbb',
                        { Range: 'bytes=0-2' });
    eq(r.status, 206, 'status');
    eq(r.body.toString('utf8'), 'MP3', 'first three bytes');
  });

  await test('a file missing from disk is not advertised on the receipt', async function () {
    // Catalogue says it exists, disk says otherwise — the receipt must not
    // offer a download that would 404 in the buyer's face.
    const ghost = { id: 'ast-dddddddddddd', stored: 'deadbeef'.padEnd(32, '0') + '.epub',
                    filename: 'gone.epub', label: 'Missing', bytes: 10,
                    added: new Date().toISOString() };
    writeCatalogue([Object.assign({}, book, { assets: [EBOOK, ghost] }), service]);
    const r = await json('/api/receipt?session_id=' + BOOK_ORDER);
    const labels = r.json.receipt.downloads.map(function (d) { return d.label; });
    eq(labels, ['Ebook (EPUB)'], 'only the file that really exists');
    writeCatalogue([book, service]);
  });

  await test('an item with no files yields no downloads', async function () {
    writeCatalogue([Object.assign({}, book, { assets: [] }), service]);
    const r = await json('/api/receipt?session_id=' + BOOK_ORDER);
    eq(r.json.receipt.downloads, [], 'downloads');
    writeCatalogue([book, service]);
  });

  /* ---- admin surface is still closed ---- */

  await test('uploading requires an admin session', async function () {
    const r = await new Promise(function (resolve, reject) {
      const req = http.request(BASE + '/api/items/itm-book01/assets?filename=x.epub&label=X',
        { method: 'PUT' }, function (res) {
          const c = []; res.on('data', function (d) { c.push(d); });
          res.on('end', function () { resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }); });
        });
      req.on('error', reject);
      req.end('some bytes');
    });
    eq(r.status, 401, 'status');
  });

  await test('deleting a file requires an admin session', async function () {
    const r = await new Promise(function (resolve, reject) {
      const req = http.request(BASE + '/api/items/itm-book01/assets/ast-aaaaaaaaaaaa',
        { method: 'DELETE' }, function (res) {
          const c = []; res.on('data', function (d) { c.push(d); });
          res.on('end', function () { resolve({ status: res.statusCode }); });
        });
      req.on('error', reject);
      req.end();
    });
    eq(r.status, 401, 'status');
  });

  /* --------------------------------------------------------- summary */

  console.log('\n  ' + passed + '/' + (passed + failures.length) + ' passed\n');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exitCode = failures.length ? 1 : 0;
  setTimeout(function () { process.exit(process.exitCode); }, 50);
}

run().catch(function (err) {
  console.error('\n  harness crashed: ' + err.stack + '\n');
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
});
