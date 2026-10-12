'use strict';
// Shared fixture access for the shared/test suite (not a test file itself).
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', '..', 'spec', 'fixtures');

function text(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function json(rel) { return JSON.parse(text(rel)); }
function list(dir) {
  return fs.readdirSync(path.join(ROOT, dir)).filter(function (f) { return /\.json$/.test(f); }).sort()
    .map(function (f) { return dir + '/' + f; });
}

var manifest = json('expected/manifest.json');

/* Minimal deterministic generator (Park-Miller), same as tools/make-fixtures.js. */
function Rng(seed) { this.x = seed; }
Rng.prototype.next = function () { this.x = (this.x * 48271) % 2147483647; return this.x; };
Rng.prototype.int = function (n) { return this.next() % n; };

module.exports = { ROOT: ROOT, text: text, json: json, list: list, manifest: manifest, Rng: Rng };
