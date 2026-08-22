'use strict';
/**
 * Bakes the live catalogue into index.html.
 *
 *   node server/sync-page.js
 *
 * The running site reads /api/catalogue, so admin edits appear there straight
 * away. But index.html also carries a copy of the catalogue for when there is
 * no server — opening the file directly, or a published static copy. That copy
 * does not update itself. This copies the current data into it.
 *
 * Run it after editing in the admin panel, whenever you want the standalone
 * or published version to match.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PAGE = path.join(ROOT, 'index.html');
const CATALOGUE = path.join(__dirname, 'data', 'catalogue.json');

const OPEN = '  var CATALOGUE = {';
const CLOSE = '};';

function main() {
  const data = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  if (!Array.isArray(data.items)) throw new Error('catalogue.json has no items array.');

  const lines = fs.readFileSync(PAGE, 'utf8').split('\n');
  const start = lines.findIndex(function (l) { return l === OPEN; });
  if (start < 0) throw new Error('Could not find the inline catalogue in index.html.');

  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === CLOSE) { end = i; break; }
  }
  if (end < 0) throw new Error('Could not find the end of the inline catalogue.');

  const before = lines.slice(0, start);
  const after = lines.slice(end + 1);
  const json = JSON.stringify(data, null, 2).split('\n');
  const block = ['  var CATALOGUE = ' + json[0]]
    .concat(json.slice(1, -1))
    .concat([json[json.length - 1] + ';']);

  fs.writeFileSync(PAGE, before.concat(block, after).join('\n'));

  const books = data.items.filter(function (i) { return i.kind === 'book'; }).length;
  const services = data.items.length - books;
  console.log('  index.html updated: ' + data.items.length +
              ' items (' + books + ' books, ' + services + ' services)');
}

try { main(); }
catch (err) { console.error('  ' + err.message); process.exit(1); }
