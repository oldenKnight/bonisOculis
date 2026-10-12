/*
 * bonis oculis extension - copy shared sources into the extension folder.
 *
 *   node extension/tools/sync-shared.js           copy
 *   node extension/tools/sync-shared.js --check   exit 1 when a copy differs
 *
 * Chrome loads only files inside the extension folder, so these are verbatim
 * COPIES (no transformation, no build step). Edit the originals, then run
 * this script. extension/test/unit/static.test.js fails when they drift.
 * ES5, no dependencies.
 */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..');
var EXT = path.join(ROOT, 'extension');

var COPIES = [
  ['shared/skipfile.js', 'extension/shared/skipfile.js'],
  ['shared/subscan.js', 'extension/shared/subscan.js'],
  ['spec/lexicon/en.json', 'extension/lexicon/en.json'],
  ['spec/lexicon/es.json', 'extension/lexicon/es.json'],
  ['desktop/renderer/css/tokens.css', 'extension/css/tokens.css'],
  ['desktop/renderer/assets/logo-mark.svg', 'extension/icons/logo-mark.svg'],
  ['desktop/renderer/assets/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2', 'extension/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2'],
  ['desktop/renderer/assets/fonts/fraunces-latin-wght-normal.woff2', 'extension/fonts/fraunces-latin-wght-normal.woff2'],
  ['desktop/renderer/assets/fonts/OFL-AtkinsonHyperlegibleNext.txt', 'extension/fonts/OFL-AtkinsonHyperlegibleNext.txt'],
  ['desktop/renderer/assets/fonts/OFL-Fraunces.txt', 'extension/fonts/OFL-Fraunces.txt']
];

function same(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) { return false; }
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

function check() {
  var bad = [];
  COPIES.forEach(function (c) {
    if (!same(path.join(ROOT, c[0]), path.join(ROOT, c[1]))) { bad.push(c[1] + ' differs from ' + c[0]); }
  });
  return bad;
}

function sync() {
  COPIES.forEach(function (c) {
    var dst = path.join(ROOT, c[1]);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ROOT, c[0]), dst);
  });
}

module.exports = { COPIES: COPIES, check: check, sync: sync, EXT: EXT };

if (require.main === module) {
  if (process.argv.indexOf('--check') >= 0) {
    var bad = check();
    bad.forEach(function (b) { console.log(b); });
    process.exit(bad.length ? 1 : 0);
  } else {
    sync();
    console.log('copied ' + COPIES.length + ' files into extension/');
  }
}
