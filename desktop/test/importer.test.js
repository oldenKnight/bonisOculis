'use strict';
// importers/json.js: validation, matching by fingerprint (oshash+size, then headSha256), asking
// the parent to pick, and importing with offset 0 and a warning.

var test = require('node:test');
var assert = require('node:assert');
var h = require('./helpers.js');
var BO = require('../../shared/skipfile.js');
var importJson = require('../main/importers/json.js').importJson;

var A = { id: 'aaaaaaaaaaaaaaa1', path: '/m/a.mkv', title: 'Alpha', size: 1000, oshash: 'aaaaaaaaaaaaaaa1', headSha256: 'a'.repeat(64), status: 'notScanned', duration: 600 };
var B = { id: 'bbbbbbbbbbbbbbb2', path: '/m/b.mkv', title: 'Beta', size: 2000, oshash: 'bbbbbbbbbbbbbbb2', headSha256: 'b'.repeat(64), status: 'notScanned', duration: 600 };

function setup(name) {
  var s = h.stack(name);
  s.store.writeEnvelope('library.json', { version: 1, items: [JSON.parse(JSON.stringify(A)), JSON.parse(JSON.stringify(B))] });
  s.library.load();
  return s;
}

function file(fp, extra) {
  var d = BO.newDoc({
    media: { title: 'Shared review', duration: 600, offset: 3.5, fingerprint: fp },
    ranges: [BO.newRange({ id: 'rimp00001', start: 10, end: 20, category: 'nudity', source: 'auto', review: 'approved', confidence: 0.9 }),
      BO.newRange({ id: 'rimp00002', start: 30, end: 40, category: 'gore', source: 'auto', review: 'pending', confidence: 0.7 })],
    scan: { status: 'complete' }
  });
  var k;
  for (k in (extra || {})) { d[k] = extra[k]; }
  return JSON.stringify(d);
}

test('refuses files that are not valid skip files', function () {
  var s = setup('imp-invalid');
  assert.deepStrictEqual(importJson({ text: '{"format":"other"}', library: s.library, skips: s.skips }), { ok: false, error: 'invalidSkip' });
  assert.deepStrictEqual(importJson({ text: 'not json', library: s.library, skips: s.skips }), { ok: false, error: 'invalidSkip' });
});

test('an exact fingerprint match imports into that movie, offset kept', function () {
  var s = setup('imp-exact');
  var r = importJson({ text: file({ size: 2000, oshash: 'bbbbbbbbbbbbbbb2' }), library: s.library, skips: s.skips });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.id, B.id);
  assert.strictEqual(r.data.match, 'exact');
  assert.strictEqual(r.data.warning, null);
  var d = s.skips.load(B.id).doc;
  assert.strictEqual(d.media.offset, 3.5);
  assert.strictEqual(d.ranges.length, 2);
  assert.ok(d.history.some(function (e) { return e.event === 'imported'; }));
  assert.strictEqual(s.library.get(B.id).status, 'needsReview', 'one range still pending');
});

test('a head-only match imports with a warning', function () {
  var s = setup('imp-head');
  var r = importJson({ text: file({ size: 999, oshash: '0123456789abcdef', headSha256: 'a'.repeat(64) }), library: s.library, skips: s.skips });
  assert.strictEqual(r.data.id, A.id);
  assert.strictEqual(r.data.warning, 'headOnly');
  assert.strictEqual(s.skips.load(A.id).doc.media.fingerprint.oshash, A.oshash, 'fingerprint now names the library file');
});

test('no match: the parent picks, the file applies with offset 0 and a warning', function () {
  var s = setup('imp-pick');
  var text = file({ size: 5, oshash: 'ffffffffffffffff' });
  var r = importJson({ text: text, library: s.library, skips: s.skips });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.data.needsPick, true);
  assert.deepStrictEqual(r.data.candidates.map(function (c) { return c.id; }), [A.id, B.id]);
  assert.strictEqual(s.skips.load(A.id).doc, null, 'nothing written yet');
  var r2 = importJson({ text: text, library: s.library, skips: s.skips, targetId: A.id });
  assert.strictEqual(r2.data.match, 'manual');
  assert.strictEqual(r2.data.warning, 'offsetUnknown');
  assert.strictEqual(s.skips.load(A.id).doc.media.offset, 0);
});

test('importing over a reviewed movie keeps the parent\'s decisions', function () {
  var s = setup('imp-merge');
  importJson({ text: file({ size: 2000, oshash: 'bbbbbbbbbbbbbbb2' }), library: s.library, skips: s.skips });
  s.skips.reject(B.id, ['rimp00002']);
  var again = JSON.parse(file({ size: 2000, oshash: 'bbbbbbbbbbbbbbb2' }));
  again.ranges[1].id = 'rimp00099';
  var r = importJson({ text: JSON.stringify(again), library: s.library, skips: s.skips });
  assert.strictEqual(r.ok, true);
  var d = s.skips.load(B.id).doc;
  var rej = d.ranges.filter(function (x) { return x.id === 'rimp00002'; })[0];
  assert.strictEqual(rej.review, 'rejected', 'kept');
  assert.ok(!d.ranges.some(function (x) { return x.id === 'rimp00099'; }), 'the same scene is not re-added over a rejected one');
});
