'use strict';
/**
 * Downloadable assets — the ebook and audio files a customer gets the moment
 * their payment clears.
 *
 * Files live on the same persistent volume as orders.json, under
 * NV_DATA_DIR/files. That matters for the same reason orders do: a hosted
 * platform wipes its filesystem on every deploy, and a customer who bought a
 * book last week still expects to download it today.
 *
 * On disk a file is named by an opaque id plus its extension, never by
 * anything a human typed. The original filename is metadata, used only for
 * the Content-Disposition header. That removes path traversal as a category
 * rather than trying to sanitise it: there is no code path where admin input
 * reaches a filesystem path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.NV_DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');

// Deliberately narrow. Every entry is something a reader actually receives —
// a book, its audio, or a document attached to an engagement.
const TYPES = {
  '.epub': 'application/epub+zip',
  '.pdf': 'application/pdf',
  '.mobi': 'application/x-mobipocket-ebook',
  '.azw3': 'application/vnd.amazon.ebook',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.flac': 'audio/flac',
  '.zip': 'application/zip'
};

// 500 MB. An unabridged audiobook is the big one here; a cap still has to
// exist so a stuck or hostile upload cannot fill the volume.
const MAX_BYTES = 500 * 1024 * 1024;

function extensionOf(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return Object.prototype.hasOwnProperty.call(TYPES, ext) ? ext : null;
}

function contentType(ext) {
  return TYPES[ext] || 'application/octet-stream';
}

function allowedExtensions() {
  return Object.keys(TYPES);
}

function storedPath(asset) {
  // asset.stored is generated here and is always <32 hex chars><known ext>.
  return path.join(FILES_DIR, asset.stored);
}

/**
 * Stream a request body straight to disk, capped. Written to a temp name and
 * renamed only on success, so an aborted upload cannot leave a half file that
 * looks real to the catalogue.
 */
function receive(req, ext) {
  return new Promise(function (resolve, reject) {
    fs.mkdirSync(FILES_DIR, { recursive: true });

    const stored = crypto.randomBytes(16).toString('hex') + ext;
    const finalPath = path.join(FILES_DIR, stored);
    const tmpPath = finalPath + '.' + process.pid + '.part';
    const out = fs.createWriteStream(tmpPath);

    let bytes = 0;
    let failed = false;

    function abort(err) {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.unlink(tmpPath, function () {});
      reject(err);
    }

    req.on('data', function (chunk) {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        const err = new Error('That file is larger than the ' +
          Math.round(MAX_BYTES / (1024 * 1024)) + ' MB limit.');
        err.statusCode = 413;
        req.destroy();
        abort(err);
      }
    });

    req.on('error', abort);
    out.on('error', abort);

    req.pipe(out);

    out.on('close', function () {
      if (failed) return;
      if (!bytes) {
        return abort(Object.assign(new Error('That upload was empty.'), { statusCode: 400 }));
      }
      try {
        fs.renameSync(tmpPath, finalPath);
      } catch (err) {
        return abort(err);
      }
      resolve({ stored: stored, bytes: bytes });
    });
  });
}

function remove(asset) {
  if (!asset || !asset.stored) return;
  try { fs.unlinkSync(storedPath(asset)); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
}

function exists(asset) {
  try { return fs.statSync(storedPath(asset)).isFile(); }
  catch (err) { return false; }
}

function sizeOnDisk(asset) {
  try { return fs.statSync(storedPath(asset)).size; }
  catch (err) { return null; }
}

/**
 * Send a file to a buyer. Range support is what lets an audio player seek
 * without pulling the whole file first, and what lets an interrupted download
 * resume rather than restart.
 */
function serve(req, res, asset) {
  const file = storedPath(asset);
  let stat;
  try { stat = fs.statSync(file); }
  catch (err) { return false; }
  if (!stat.isFile()) return false;

  const type = contentType(path.extname(asset.stored).toLowerCase());
  // The name the customer sees, not the name on disk. Quotes escaped, and a
  // UTF-8 form alongside it so non-ASCII titles survive.
  const safeName = String(asset.filename || 'download').replace(/["\\\r\n]/g, '');
  const disposition = 'attachment; filename="' + safeName + '"; ' +
    "filename*=UTF-8''" + encodeURIComponent(asset.filename || 'download');

  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    const [s, e] = range.replace('bytes=', '').split('-');
    const start = s ? parseInt(s, 10) : 0;
    const end = e ? parseInt(e, 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + stat.size });
      res.end();
      return true;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + stat.size,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(file, { start: start, end: end }).pipe(res);
    return true;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': disposition,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

/**
 * Build the asset record that goes in the catalogue. Everything here is
 * either generated or validated — `label` and `filename` are the only text
 * from the admin, and neither ever reaches a path.
 */
function describe(stored, bytes, filename, label) {
  return {
    id: 'ast-' + crypto.randomBytes(6).toString('hex'),
    stored: stored,
    filename: String(filename).slice(0, 160),
    label: String(label || filename).slice(0, 80),
    bytes: bytes,
    added: new Date().toISOString()
  };
}

module.exports = {
  FILES_DIR, MAX_BYTES,
  extensionOf, contentType, allowedExtensions,
  receive, remove, exists, sizeOnDisk, serve, describe
};
