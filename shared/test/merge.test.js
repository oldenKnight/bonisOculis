'use strict';
var test = require('node:test');
var assert = require('node:assert');
var S = require('../skipfile.js');
var F = require('./fixtures.js');

var NOW = F.manifest.now;

test('merge matches merge/expected.bonis.json', function () {
  F.manifest.merge.forEach(function (m) {
    var oldDoc = F.json(m.old), newDoc = F.json(m['new']), a = JSON.stringify(oldDoc), b = JSON.stringify(newDoc);
    var out = S.merge(oldDoc, newDoc, { now: NOW });
    assert.deepStrictEqual(out, F.json(m.expected));
    assert.strictEqual(S.toKodiEdl(out), F.text(m.kodi));
    assert.strictEqual(JSON.stringify(oldDoc), a, 'old untouched');
    assert.strictEqual(JSON.stringify(newDoc), b, 'new untouched');
    assert.ok(S.validate(out).ok);
  });
});

test('merge keeps reviewed and parent ranges and replaces auto pending ones (hand-checked)', function () {
  var out = S.merge(F.json('merge/old.bonis.json'), F.json('merge/new.bonis.json'), { now: NOW });
  var ids = out.ranges.map(function (r) { return r.id; });
  assert.deepStrictEqual(ids, ['rn0001', 'ro0002', 'rn0004', 'rn0003', 'ro0003', 'ro0004', 'rn0006', 'ro0005',
    'ro00051', 'ro0006', 'ro0007', 'rn0009', 'ro0009', 'rn0010']);
  // replaced: ro0001 (auto pending nudity), ro0008 (auto pending implied)
  assert.strictEqual(ids.indexOf('ro0001'), -1);
  assert.strictEqual(ids.indexOf('ro0008'), -1);
  // dropped: rn0002 (82% inside the rejected gore range), rn0005 (inside approved kissing),
  // rn0007 (inside nudity the parent chose to show: approved + action none)
  ['rn0002', 'rn0005', 'rn0007'].forEach(function (id) { assert.strictEqual(ids.indexOf(id), -1, id); });
  var byId = {};
  out.ranges.forEach(function (r) { byId[r.id] = r; });
  assert.deepStrictEqual([byId.rn0003.start, byId.rn0003.end], [209, 230]);  // only 20% on the rejected range: kept
  assert.deepStrictEqual([byId.rn0006.start, byId.rn0006.end], [420, 430]);  // trimmed around the locked range
  assert.deepStrictEqual([byId.ro0004.start, byId.ro0004.end, byId.ro0004.locked], [400, 420, true]);
  assert.strictEqual(byId.ro00051.category, 'gore');                         // id collision re-derived
  assert.strictEqual(byId.rn0010.end, 1000.5);                               // clamped to the new duration
  assert.strictEqual(out.id, '6b0c1f2e-3d4a-4b5c-8d6e-000000000006');
  assert.strictEqual(out.created, '2026-10-01T09:00:00.000Z');
  assert.strictEqual(out.media.title, 'Reviewed (rejected and locked)');
  assert.strictEqual(out.media.filename, 'reviewed.mkv');
  assert.strictEqual(out.generator.appVersion, '0.2.0');
  assert.deepStrictEqual(out.history[out.history.length - 1],
    { at: NOW, event: 'scanned', detail: 'kept 7, replaced 2, added 7, dropped 3' });
  assert.strictEqual(out.history.length, 6);
});

test('a new range of another category inside a rejected range is kept', function () {
  var out = S.merge(F.json('merge/old.bonis.json'), F.json('merge/new.bonis.json'), { now: NOW });
  var rn4 = out.ranges.filter(function (r) { return r.id === 'rn0004'; })[0];
  assert.deepStrictEqual([rn4.category, rn4.start, rn4.end], ['nudity', 205, 209]);
});

test('merging a scan into itself keeps reviewed state and stays valid', function () {
  var old = F.json('valid/movie-3h.bonis.json');
  var out = S.merge(old, old, { now: NOW });
  assert.ok(S.validate(out).ok);
  var rejected = old.ranges.filter(function (r) { return r.review === 'rejected'; }).length;
  assert.strictEqual(out.ranges.filter(function (r) { return r.review === 'rejected'; }).length, rejected);
});
